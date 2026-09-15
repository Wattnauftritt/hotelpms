import type { FastifyInstance } from 'fastify'
import { businessDateFor } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'
import { einmalTokenUndPost } from './auth.js'

/**
 * Einen Kunden anlegen (Aufgabe 13b).
 *
 * **Kein Selbstbedienungsweg, und das ist eine Produktentscheidung.** Wer hier
 * hereinkommt, hat einen Vertrag; ein offenes Anmeldeformular fuer ein System,
 * das Meldescheine und Umsatzsteuer fuehrt, schafft Karteileichen mit echten
 * Gastdaten darin. Wir legen den Kunden an, er bekommt eine Einladung.
 *
 * Deshalb `platform:accounts`. Das ist die eigentliche Tuer; die zweite steckt
 * in `account_provision` selbst, die ohne Mandantenkontext laufen will
 * (Migration 0031).
 */

/** Pflichtangaben nach § 14 UStG. Ohne sie ist das Haus nicht rechnungsfaehig. */
interface Eingabe {
  accountName?: string
  code?: string
  name?: string
  addressLine1?: string
  postalCode?: string
  city?: string
  country?: string
  taxNumber?: string
  vatId?: string
  timezone?: string
  currency?: string
  isTraining?: boolean
  userEmail?: string
  userName?: string
}

interface Angelegt {
  account_id: number
  property_id: number
  user_id: number
}

const PFLICHT = ['accountName', 'code', 'name', 'userEmail', 'userName'] as const

export function onboardingRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts',
    permission: 'platform:accounts',
    summary: 'Account, erstes Haus und ersten Benutzer anlegen',
    handler: async (req, reply) => {
      const b = (req.body ?? {}) as Eingabe
      const fehler: Record<string, string[]> = {}
      for (const feld of PFLICHT) {
        if (!String(b[feld] ?? '').trim()) fehler[feld] = ['field.required']
      }

      /*
       * Anschrift und Steuernummer zusammen, nicht einzeln: es sind keine
       * vier unabhaengigen Felder, sondern eine Bedingung. Wer nur
       * "Steuernummer fehlt" liest, traegt sie nach und stolpert danach ueber
       * die Postleitzahl.
       */
      const rechnungsfaehig = [b.addressLine1, b.postalCode, b.city, b.taxNumber]
        .every(w => String(w ?? '').trim() !== '')
      if (!rechnungsfaehig) {
        for (const feld of ['addressLine1', 'postalCode', 'city', 'taxNumber']) {
          fehler[feld] = ['onboarding.invoiceDataRequired']
        }
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      const timezone = String(b.timezone ?? 'Europe/Berlin')
      const currency = String(b.currency ?? 'EUR').toUpperCase()
      const country = String(b.country ?? 'DE').toUpperCase()

      /*
       * Der Geschaeftstag wird hier gerechnet, nicht in SQL: die Regel haengt
       * an Zeitzone und rollover_time, und sie steht schon in
       * businessDateFor(). Zwei Fassungen liefen frueher oder spaeter um
       * einen Tag auseinander. Das Haus ist neu, also gilt die Vorgabe 04:00.
       */
      const geschaeftstag = businessDateFor(new Date(), timezone, '04:00')

      const angelegt = await tx(req.pool, req, async client => {
        /*
         * Die Adresse vorher pruefen, statt den eindeutigen Index sprechen zu
         * lassen. Nicht aus Hoeflichkeit: der Verstoss bricht die
         * Transaktion, und dann steht ein halb angelegter Account im Nichts.
         * Ein Wettlauf bleibt moeglich -- dagegen steht der Index, und dann
         * ist der Abbruch richtig.
         */
        const vorhanden = await client.query(
          `SELECT 1 FROM app_user WHERE lower(email) = lower($1)`, [b.userEmail])
        if (vorhanden.rowCount !== 0) {
          throw Errors.conflict('onboarding.emailTaken')
        }

        const r = await client.query<Angelegt>(
          `SELECT * FROM account_provision(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15)`,
          [b.accountName, b.code, b.name, b.addressLine1, b.postalCode, b.city,
           country, b.taxNumber, b.vatId ?? null, timezone, currency,
           b.isTraining ?? false, geschaeftstag, b.userEmail, b.userName])
        const neu = r.rows[0]!

        /*
         * Einladung in derselben Transaktion. Ein Account ohne Einladung ist
         * ein Account, in den niemand hineinkommt -- und wer das spaeter
         * nachholen will, braucht dafuer wieder einen Weg, den es nicht gibt.
         */
        await einmalTokenUndPost(client, {
          userId: neu.user_id,
          name: String(b.userName),
          email: String(b.userEmail),
          kind: 'invite',
          createdBy: (req.principal as Principal).userId
        })
        return neu
      })

      reply.status(201)
      /*
       * Ids, aber kein Token: der Einladungslink geht per Mail und steht
       * nirgends in einer Antwort, die jemand mitlesen oder protokollieren
       * koennte.
       */
      return {
        accountId: angelegt.account_id,
        propertyId: angelegt.property_id,
        userId: angelegt.user_id
      }
    }
  })
}
