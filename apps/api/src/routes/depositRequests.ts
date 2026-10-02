import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { depositFromPercent, depositRequestState, depositRequestOpenCent,
         isSendableAddress, type DepositRequestState } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { can, type Principal } from '../platform/context.js'
import type { Permission } from '../platform/permissions.js'

/**
 * Anzahlung anfordern (Migration 0060).
 *
 * **Was hier entsteht, ist eine Forderung, keine Buchung.** Die Anforderung
 * sagt: dieser Gast soll bis zu diesem Tag so viel zahlen. Geld bewegt sie
 * nicht, und Steuer schuldet sie nicht -- die entsteht mit dem Zufluss
 * (Paragraph 13 Abs. 1 Nr. 1a UStG), und der Zufluss ist weiterhin ein
 * Zahlungsvermerk, aus dem `POST .../deposit-invoice` die Anzahlungsrechnung
 * macht (Dokument 16, Aufgabe 3). Diese Datei baut an keiner Stelle daran
 * vorbei: sie ordnet zu und zeigt an, sie fakturiert nicht.
 *
 * **Die Rechte haengen am Haus des Folios, nicht an irgendeinem.** Die
 * Pfade tragen keine Property; `registerRoute` prueft deshalb nur, ob der
 * Benutzer das Recht **irgendwo** hat. Bei mehreren Haeusern im Account
 * filtert die Zeilenrichtlinie nach Mandant und nicht nach Haus (CLAUDE.md)
 * -- wer im einen Haus buchen und im anderen nur lesen darf, kaeme sonst im
 * zweiten an die Knoepfe. Jede Route prueft das Recht deshalb noch einmal,
 * sobald das Folio und damit das Haus feststeht.
 */

/** Das Recht im Haus des Datensatzes, nicht in irgendeinem. */
export function rechtImHaus(
  principal: Principal, permission: Permission, propertyId: number
): void {
  if (!can(principal, permission, propertyId)) {
    throw Errors.forbidden('access.missingPermission', { permission })
  }
}

/**
 * Der offene Geschaeftstag eines Hauses.
 *
 * Fristen werden gegen ihn geprueft, nicht gegen `now()` (CLAUDE.md): eine
 * Rezeption, die nach Mitternacht noch abrechnet, steht im alten Tag, und
 * ein Wiederholungslauf soll dieselben Zeilen finden. Ohne offenen Tag --
 * ein Haus vor seinem ersten Nachtlauf -- gilt das Kalenderdatum, wie bei
 * den Buchungsrouten.
 */
export async function geschaeftstag(client: PoolClient, propertyId: number): Promise<string> {
  const bd = await client.query<{ date: string }>(
    `SELECT date::text FROM business_day
      WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
    [propertyId])
  return bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10)
}

/**
 * Ein echter Kalendertag, nicht nur die Form davon.
 *
 * `isIsoDate` laesst den 30. Februar durch, und die Datenbank wiese ihn
 * erst beim Umwandeln ab -- als Fehler 500 statt als Antwort, die sagt, was
 * falsch war.
 */
function istKalendertag(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Aus diesen Zustaenden wird keine Anzahlung mehr verlangt. */
const ABGESCHLOSSEN = new Set(['CheckedOut', 'Canceled', 'NoShow'])

export interface FolioZeile {
  id: number
  property_id: number
  status: string
  reservation_id: number | null
}

interface Aufenthalt {
  arrival: string
  departure: string
  status: string
  stayCent: number
}

/**
 * Preis und Zeitraum des Aufenthalts. Der Preis ist die Summe der Naechte,
 * wie in der Buchungsbestaetigung: dieselbe Zahl, die der Gast schon kennt.
 */
async function aufenthalt(client: PoolClient, reservationId: number): Promise<Aufenthalt> {
  const r = await client.query<{ arrival: string; departure: string; status: string
                                 stay_cent: string }>(
    `SELECT r.arrival::text, r.departure::text, r.status::text,
            COALESCE((SELECT sum(n.price_cent) FROM reservation_night n
                       WHERE n.reservation_id = r.id), 0)::bigint AS stay_cent
       FROM reservation r WHERE r.id = $1`, [reservationId])
  if (r.rowCount === 0) throw Errors.notFound('res.reservation')
  const z = r.rows[0]!
  return { arrival: z.arrival, departure: z.departure, status: z.status,
           stayCent: Number(z.stay_cent) }
}

/** Eine Anforderung samt dem, was schon darauf eingegangen ist. Gesperrt. */
export interface AnforderungZeile {
  id: number
  property_id: number
  folio_id: number
  amount_cent: number
  due_date: string
  canceled: boolean
  received_cent: number
}

export async function anforderungSperren(
  client: PoolClient, requestRef: string
): Promise<AnforderungZeile> {
  // Erst die Zeile sperren, dann zaehlen: ein gleichzeitig eintreffender
  // Webhook ordnet sonst zwischen Lesen und Entscheiden einen Eingang zu.
  const r = await client.query<{ id: number; property_id: number; folio_id: number
                                 amount_cent: string; due_date: string
                                 canceled: boolean }>(
    `SELECT id, property_id, folio_id, amount_cent, due_date::text,
            canceled_at IS NOT NULL AS canceled
       FROM deposit_request WHERE public_ref = $1 FOR UPDATE`, [requestRef])
  if (r.rowCount === 0) throw Errors.notFound('res.depositRequest')
  const z = r.rows[0]!
  const e = await client.query<{ n: string }>(
    `SELECT COALESCE(sum(s.amount_cent), 0)::bigint AS n
       FROM deposit_request_settlement drs JOIN settlement s ON s.id = drs.settlement_id
      WHERE drs.deposit_request_id = $1`, [z.id])
  return { id: z.id, property_id: z.property_id, folio_id: z.folio_id,
           amount_cent: Number(z.amount_cent), due_date: z.due_date,
           canceled: z.canceled, received_cent: Number(e.rows[0]!.n) }
}

// ---------------------------------------------------------------------------
// Die Sicht: was die Vorauszahlungsmaske ueber Anforderungen und Post wissen
// muss. Aufgerufen aus `GET /v1/folios/:folioRef/prepayments`, damit es bei
// einem Aufruf je Bildschirmteil bleibt.
// ---------------------------------------------------------------------------

export interface AnforderungSicht {
  requestRef: string
  amountCent: number
  percentBp: number | null
  basisCent: number | null
  dueDate: string
  createdAt: string
  canceledAt: string | null
  receivedCent: number
  openCent: number
  settlementIds: number[]
  state: DepositRequestState
  depositInvoiceMissing: boolean
}

export interface PostBereitschaft {
  ready: boolean
  reason: 'training' | 'disabled' | 'sender' | null
  guestAddress: boolean
}

export interface Anzahlungssicht {
  businessDate: string
  isTraining: boolean
  canRequestDeposit: boolean
  stayCent: number | null
  arrival: string | null
  departure: string | null
  mail: PostBereitschaft
  requests: AnforderungSicht[]
}

/**
 * Kann von hier Gastpost hinausgehen?
 *
 * Dieselben drei Bedingungen, die `email_enqueue` selbst prueft (0052) --
 * hier **vorher**, damit die Maske den Grund nennt, statt einen Knopf
 * anzubieten, der danach scheitert. Der Zaun bleibt in der Funktion; das
 * hier ist die Auskunft an einen Menschen.
 */
export async function postBereitschaft(
  client: PoolClient, propertyId: number, isTraining: boolean
): Promise<Omit<PostBereitschaft, 'guestAddress'>> {
  if (isTraining) return { ready: false, reason: 'training' }
  const s = await client.query<{ enabled: boolean; allowed: boolean }>(
    `SELECT s.enabled, email_sender_allowed(s.property_id, s.from_email) AS allowed
       FROM property_email_setting s WHERE s.property_id = $1`, [propertyId])
  const z = s.rows[0]
  if (z === undefined || !z.enabled) return { ready: false, reason: 'disabled' }
  if (!z.allowed) return { ready: false, reason: 'sender' }
  return { ready: true, reason: null }
}

export async function anzahlungssicht(
  client: PoolClient, folio: FolioZeile
): Promise<Anzahlungssicht> {
  const businessDate = await geschaeftstag(client, folio.property_id)

  const kopf = await client.query<{ is_training: boolean; email: string | null
                                    anonymized: boolean | null }>(
    `SELECT p.is_training, g.email, g.status = 'anonymized' AS anonymized
       FROM property p
       LEFT JOIN reservation r ON r.id = $2
       LEFT JOIN guest g ON g.id = r.primary_guest_id
      WHERE p.id = $1`, [folio.property_id, folio.reservation_id])
  const k = kopf.rows[0]!
  const post = await postBereitschaft(client, folio.property_id, k.is_training)

  const auf = folio.reservation_id === null ? null
    : await aufenthalt(client, folio.reservation_id)

  /*
   * Je Anforderung eine Zeile, die Eingaenge und offenen Links als
   * gruppierte Unterabfragen daneben -- nicht je Anforderung nachgeladen.
   * `payment_intent` traegt keine Zeilenrichtlinie (0021); die Property
   * wird deshalb dort von Hand mitgefiltert.
   */
  const rows = await client.query<{
    request_ref: string; amount_cent: string; percent_bp: number | null
    basis_cent: string | null; due_date: string; created_at: Date
    canceled_at: Date | null; received_cent: string; settlement_ids: number[]
    ohne_rechnung: boolean; offene_links: string }>(
    `SELECT dr.public_ref AS request_ref, dr.amount_cent, dr.percent_bp, dr.basis_cent,
            dr.due_date::text, dr.created_at, dr.canceled_at,
            COALESCE(e.received_cent, 0)::bigint AS received_cent,
            COALESCE(e.settlement_ids, '{}') AS settlement_ids,
            COALESCE(e.ohne_rechnung, false) AS ohne_rechnung,
            COALESCE(l.offen, 0) AS offene_links
       FROM deposit_request dr
       LEFT JOIN (
         SELECT drs.deposit_request_id,
                sum(s.amount_cent)::bigint AS received_cent,
                array_agg(s.id ORDER BY s.id) AS settlement_ids,
                bool_or(dl.settlement_id IS NULL) AS ohne_rechnung
           FROM deposit_request_settlement drs
           JOIN settlement s ON s.id = drs.settlement_id
           LEFT JOIN (SELECT DISTINCT settlement_id FROM deposit_ledger
                       WHERE folio_id = $1 AND settlement_id IS NOT NULL) dl
                  ON dl.settlement_id = s.id
          WHERE drs.folio_id = $1
          GROUP BY drs.deposit_request_id) e ON e.deposit_request_id = dr.id
       LEFT JOIN (
         SELECT o.deposit_request_id, count(*) AS offen FROM (
           -- Der dauerhafte Link (0059): gilt bis zu einem Kalendertag,
           -- gegen den Geschaeftstag geprueft.
           SELECT deposit_request_id FROM payment_link
            WHERE folio_id = $1 AND deposit_request_id IS NOT NULL
              AND revoked_at IS NULL AND valid_until >= $3::date
           UNION ALL
           -- Checkouts von vor 0059 ohne eigenen Link. Ihr Ablauf ist ein
           -- Zeitpunkt beim Anbieter: hier zaehlt die Uhr.
           SELECT deposit_request_id FROM payment_intent
            WHERE folio_id = $1 AND property_id = $2 AND status = 'pending'
              AND deposit_request_id IS NOT NULL AND payment_link_id IS NULL
              AND (expires_at IS NULL OR expires_at > now())
         ) o GROUP BY o.deposit_request_id) l ON l.deposit_request_id = dr.id
      WHERE dr.folio_id = $1
      ORDER BY dr.due_date, dr.id`,
    [folio.id, folio.property_id, businessDate])

  const requests = rows.rows.map(r => {
    const amountCent = Number(r.amount_cent)
    const receivedCent = Number(r.received_cent)
    return {
      requestRef: r.request_ref,
      amountCent,
      percentBp: r.percent_bp,
      basisCent: r.basis_cent === null ? null : Number(r.basis_cent),
      dueDate: r.due_date,
      createdAt: r.created_at.toISOString(),
      canceledAt: r.canceled_at === null ? null : r.canceled_at.toISOString(),
      receivedCent,
      openCent: r.canceled_at === null ? depositRequestOpenCent(amountCent, receivedCent) : 0,
      settlementIds: r.settlement_ids.map(Number),
      state: depositRequestState({
        amountCent, receivedCent, dueDate: r.due_date, businessDate,
        openLink: Number(r.offene_links) > 0, canceled: r.canceled_at !== null }),
      depositInvoiceMissing: r.ohne_rechnung
    }
  })

  return {
    businessDate,
    isTraining: k.is_training,
    canRequestDeposit: auf !== null && folio.status === 'open'
      && !ABGESCHLOSSEN.has(auf.status),
    stayCent: auf?.stayCent ?? null,
    arrival: auf?.arrival ?? null,
    departure: auf?.departure ?? null,
    mail: { ...post,
            guestAddress: k.anonymized !== true && isSendableAddress(k.email) },
    requests
  }
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------

export function depositRequestRoutes(app: FastifyInstance): void {
  /**
   * Anzahlung anfordern: ein Betrag oder ein Prozentsatz des Aufenthalts,
   * faellig an einem Kalendertag.
   *
   * Der Betrag wird **hier** festgeschrieben, auch bei Prozent. Die
   * Oberflaeche zeigt denselben Wert vorher an, gerechnet mit derselben
   * Funktion (`depositFromPercent`), aber massgeblich ist dieser.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/deposit-requests',
    permission: 'folio:post',
    summary: 'Anzahlung anfordern',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as {
        amountCent?: number; percentBp?: number; dueDate?: string
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      const mitBetrag = body.amountCent !== undefined
      const mitSatz = body.percentBp !== undefined
      if (mitBetrag === mitSatz) {
        throw Errors.validation({ amountCent: ['field.amountOrPercent'] })
      }
      if (mitBetrag && (!Number.isInteger(body.amountCent) || body.amountCent! <= 0)) {
        throw Errors.validation({ amountCent: ['field.positiveCent'] })
      }
      if (mitSatz && (!Number.isInteger(body.percentBp)
                      || body.percentBp! <= 0 || body.percentBp! > 10_000)) {
        throw Errors.validation({ percentBp: ['field.percentBp'] })
      }
      if (!istKalendertag(body.dueDate)) {
        throw Errors.validation({ dueDate: ['field.isoDate'] })
      }
      const dueDate = body.dueDate

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        // Gesperrt: zwei gleichzeitige Anforderungen sollen die Summe
        // gegen den Aufenthalt nicht beide gegen denselben alten Stand
        // pruefen.
        const f = await client.query<FolioZeile>(
          `SELECT id, property_id, status, reservation_id FROM folio
            WHERE public_ref = $1 FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:post', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')
        if (folio.reservation_id === null) {
          throw Errors.unprocessable('deposit.needsReservation')
        }

        const auf = await aufenthalt(client, folio.reservation_id)
        if (ABGESCHLOSSEN.has(auf.status)) {
          throw Errors.unprocessable('deposit.reservationNotOpen')
        }

        const businessDate = await geschaeftstag(client, folio.property_id)
        if (dueDate < businessDate) {
          throw Errors.unprocessable('deposit.dueBeforeBusinessDay', { businessDate })
        }
        if (dueDate > auf.departure) {
          throw Errors.unprocessable('deposit.dueAfterDeparture',
            { departure: auf.departure })
        }

        let amountCent: number
        let basisCent: number | null = null
        if (mitSatz) {
          if (auf.stayCent <= 0) throw Errors.unprocessable('deposit.noStayPrice')
          basisCent = auf.stayCent
          amountCent = depositFromPercent(auf.stayCent, body.percentBp!)
          // Ein Satz so klein, dass abgerundet nichts bleibt, ist keine
          // Forderung. Die Datenbank wiese null Cent ohnehin ab -- als 500.
          if (amountCent <= 0) throw Errors.validation({ percentBp: ['field.percentBp'] })
        } else {
          amountCent = body.amountCent!
        }

        /*
         * Mehr als den Aufenthalt anzufordern ist fast immer ein Tippfehler
         * (25000 statt 250,00). Gezaehlt werden die offenen, nicht
         * zurueckgezogenen Anforderungen dieses Folios mit. Ein Aufenthalt
         * ohne Preis -- etwa ein Kontingentabruf vor der Preisvergabe --
         * laesst nur einen Betrag zu, und dann pruefen wir ihn nicht gegen
         * null.
         */
        if (auf.stayCent > 0) {
          const schon = await client.query<{ n: string }>(
            `SELECT COALESCE(sum(amount_cent), 0)::bigint AS n FROM deposit_request
              WHERE folio_id = $1 AND canceled_at IS NULL`, [folio.id])
          const zusammen = Number(schon.rows[0]!.n) + amountCent
          if (zusammen > auf.stayCent) {
            throw Errors.unprocessable('deposit.requestExceedsStay',
              { requested: zusammen, stay: auf.stayCent })
          }
        }

        const r = await client.query<{ public_ref: string }>(
          `INSERT INTO deposit_request (property_id, folio_id, reservation_id, amount_cent,
                                        percent_bp, basis_cent, due_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8) RETURNING public_ref`,
          [folio.property_id, folio.id, folio.reservation_id, amountCent,
           mitSatz ? body.percentBp : null, basisCent, dueDate, principal.userId])

        const result = {
          requestRef: r.rows[0]!.public_ref, amountCent,
          percentBp: mitSatz ? body.percentBp! : null, basisCent, dueDate
        }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Eine Anforderung zurueckziehen.
   *
   * Nicht, solange ein Link offen ist: der Gast koennte eine Forderung
   * bezahlen, die es nicht mehr gibt, und das Geld laege ohne Grund auf dem
   * Folio. Erst den Link beim Anbieter ungueltig machen, dann zurueckziehen
   * -- zwei Schritte, damit ein Fehler beim Anbieter nicht halb wirkt.
   * Bereits Eingegangenes bleibt, wo es ist; es ist eine Zahlung.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/deposit-requests/:requestRef/cancel',
    permission: 'folio:post',
    summary: 'Anzahlungsanforderung zurueckziehen',
    handler: async (req) => {
      const { requestRef } = req.params as { requestRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const a = await anforderungSperren(client, requestRef)
        rechtImHaus(principal, 'folio:post', a.property_id)
        if (a.canceled) throw Errors.conflict('deposit.requestCanceled')
        if (a.received_cent >= a.amount_cent) throw Errors.conflict('deposit.requestFulfilled')

        /*
         * Offen ist ein gueltiger, nicht widerrufener Link -- und jeder
         * Checkout, der beim Anbieter noch bezahlt werden koennte, auch wenn
         * sein Link inzwischen abgelaufen ist: ein gestern geoeffneter
         * Checkout nimmt bis zu 24 Stunden lang Geld an. Widerrufen schliesst
         * beides.
         */
        const heute = await geschaeftstag(client, a.property_id)
        const offen = await client.query(
          `SELECT 1 FROM payment_link
            WHERE deposit_request_id = $1 AND revoked_at IS NULL AND valid_until >= $3::date
           UNION ALL
           SELECT 1 FROM payment_intent
            WHERE deposit_request_id = $1 AND property_id = $2 AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1`, [a.id, a.property_id, heute])
        if ((offen.rowCount ?? 0) > 0) throw Errors.conflict('deposit.requestHasOpenLink')

        await client.query(
          `UPDATE deposit_request SET canceled_at = now(), canceled_by = $2 WHERE id = $1`,
          [a.id, principal.userId])
        return { requestRef, canceled: true }
      })
    }
  })

  /**
   * Einen Zahlungseingang einer Anforderung zuordnen.
   *
   * Der Weg fuer alles, was nicht ueber den Link kommt: die Ueberweisung,
   * die Barzahlung bei einer Vorabanreise. Ein Eingang ueber den Link wird
   * vom Webhook zugeordnet und braucht diesen Weg nicht.
   *
   * Wiederholbar: dieselbe Zuordnung noch einmal ist kein Fehler, sondern
   * dieselbe Antwort. Ein Doppelklick soll keine rote Meldung erzeugen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/deposit-requests/:requestRef/settlements',
    permission: 'folio:post',
    summary: 'Zahlungseingang einer Anzahlungsanforderung zuordnen',
    handler: async (req, reply) => {
      const { requestRef } = req.params as { requestRef: string }
      const body = (req.body ?? {}) as { settlementId?: number }
      const principal = req.principal as Principal
      if (!Number.isInteger(body.settlementId)) {
        throw Errors.validation({ settlementId: ['field.required'] })
      }

      return tx(req.pool, req, async client => {
        const a = await anforderungSperren(client, requestRef)
        rechtImHaus(principal, 'folio:post', a.property_id)

        const s = await client.query<{ id: number; amount_cent: string
                                       reverses_id: number | null
                                       request_id: number | null }>(
          `SELECT s.id, s.amount_cent, s.reverses_id,
                  drs.deposit_request_id AS request_id
             FROM settlement s
             LEFT JOIN deposit_request_settlement drs ON drs.settlement_id = s.id
            WHERE s.id = $1 AND s.folio_id = $2`, [body.settlementId, a.folio_id])
        if (s.rowCount === 0) throw Errors.notFound('res.settlement')
        const v = s.rows[0]!

        if (v.request_id === a.id) {
          reply.status(200)
          return { requestRef, settlementId: v.id }
        }
        if (v.request_id !== null) throw Errors.conflict('deposit.settlementAlreadyAssigned')
        if (a.canceled) throw Errors.conflict('deposit.requestCanceled')
        // Eine Erstattung oder ein Storno ist kein Eingang auf eine Forderung.
        if (Number(v.amount_cent) <= 0 || v.reverses_id !== null) {
          throw Errors.validation({ settlementId: ['field.notAnIncomingPayment'] })
        }

        // Der eindeutige Index entscheidet, nicht die Pruefung davor: ordnet
        // gleichzeitig jemand denselben Eingang einer anderen Anforderung
        // zu, gewinnt genau einer, und der andere bekommt eine Antwort statt
        // eines Fehlers 500.
        const neu = await client.query(
          `INSERT INTO deposit_request_settlement
             (property_id, folio_id, deposit_request_id, settlement_id, created_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (settlement_id) DO NOTHING RETURNING id`,
          [a.property_id, a.folio_id, a.id, v.id, principal.userId])
        if (neu.rowCount === 0) throw Errors.conflict('deposit.settlementAlreadyAssigned')
        reply.status(201)
        return { requestRef, settlementId: v.id }
      })
    }
  })
}
