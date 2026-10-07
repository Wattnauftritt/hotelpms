import type { FastifyInstance } from 'fastify'
import { addDays, isIsoDate } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { geschaeftstag } from '../platform/kassenbuch.js'

/**
 * Geteilte Gastprofile aus dem KWHotel-Import trennen (Migration 0106).
 *
 * **Was passiert ist.** Der Import legte ein Profil je KWHotel-Gastsatz an,
 * und unter einem Gastsatz stehen dort oft verschiedene Menschen. Seit dem
 * 04.10. schreiben Meldeschein und Gastkontakt aus dem Adminpanel Namen ins
 * Profil -- und damit in jede Reservierung daran. Die Anreiseliste zeigte
 * Vornamen aus fremden Buchungen. Seit 0106 trennen beide Routen selbst;
 * hier wird der Bestand bereinigt.
 *
 * **Was die Bereinigung tut.** Je geteiltem Profil behaelt es genau eine
 * Reservierung, jede andere bekommt ein eigenes mit Nachname und Land, wie
 * vor dem 04.10. Welche behaelt:
 *
 * 1. die mit dem juengsten Meldeschein am Profil -- dessen Angaben stehen
 *    darin, sie gehoeren zu ihr;
 * 2. sonst der laufende Aufenthalt, dann der naechste, dann der letzte. An
 *    ihm hat die Rezeption am ehesten etwas eingetragen.
 *
 * Behaelt eine Reservierung das Profil ohne eigenen Meldeschein, verliert
 * sie einen Vornamen, den das Adminpanel gesetzt hat; einen der Rezeption
 * behaelt sie. Hatte eine abgetrennte Reservierung einen eigenen Schein,
 * waren dessen Angaben von einem spaeteren ueberschrieben; das Adminpanel
 * schickt ihn erneut, und die Uebernahme traegt sie nach
 * (`registrationImport.ts`).
 *
 * **Probelauf zuerst.** GET rechnet und schreibt nichts. POST schreibt nur
 * mit der Zahl neuer Profile, die der Probelauf genannt hat: hat sich der
 * Bestand dazwischen geaendert, sieht der Freigebende erst die neue Zahl.
 *
 * Nur Profile, an denen mindestens eine Reservierung aus dem KWHotel-Import
 * haengt. Einen Stammgast, den die Rezeption bewusst an ein vorhandenes
 * Profil gehaengt hat, trennt das nicht.
 */

/** Wie viele Tage die Beispielliste hoechstens umfasst. */
const MAX_TAGE = 31

const STORNIERT = new Set(['Canceled', 'NoShow'])

interface Zeile {
  id: string
  reservation_ref: string
  legacy_reference: string | null
  arrival: string
  departure: string
  status: string
  guest_id: string
  first_name: string | null
  last_name: string
  loeschantrag: boolean
  vorname_umsystem: boolean
  schein_seit: string | null
  schein_system: string | null
  schein_referenz: string | null
}

type Grund = 'own_registration' | 'current_stay' | 'next_stay' | 'latest_stay'

interface Gruppe {
  behaelt: Zeile
  grund: Grund
  vornameLeeren: boolean
  abtrennen: Zeile[]
}

interface Plan {
  businessDate: string
  gruppen: Gruppe[]
  loeschantrag: number
}

/**
 * Welche Reservierung das Profil behaelt. Reine Rechnung ueber die Zeilen
 * einer Gruppe, damit sie sich ohne Datenbank nachpruefen laesst.
 */
function behaelt(zeilen: Zeile[], heute: string): { zeile: Zeile; grund: Grund } {
  const mitSchein = zeilen.filter(z => z.schein_seit !== null)
  if (mitSchein.length > 0) {
    const z = mitSchein.reduce((a, b) => (b.schein_seit! > a.schein_seit! ? b : a))
    return { zeile: z, grund: 'own_registration' }
  }
  const aktiv = zeilen.filter(z => !STORNIERT.has(z.status))
  const laufend = aktiv.find(z => z.arrival <= heute && z.departure > heute)
  if (laufend) return { zeile: laufend, grund: 'current_stay' }
  const naechste = aktiv.filter(z => z.arrival >= heute)
    .sort((a, b) => a.arrival.localeCompare(b.arrival))[0]
  if (naechste) return { zeile: naechste, grund: 'next_stay' }
  const letzte = [...zeilen].sort((a, b) => b.departure.localeCompare(a.departure))[0]!
  return { zeile: letzte, grund: 'latest_stay' }
}

async function planen(client: PoolClient, propertyId: number, ab: string | null): Promise<Plan> {
  const heute = await geschaeftstag(client, propertyId)
  /*
   * Ein Verbund ueber die Reservierungen des Hauses, keine Abfrage je
   * Profil. Der Meldeschein zaehlt nur, wenn er am geteilten Profil haengt:
   * einer an einem eigenen Profil hat mit diesem nichts zu tun.
   */
  const { rows } = await client.query<Zeile>(
    `WITH geteilt AS (
       SELECT primary_guest_id AS guest_id
         FROM reservation
        WHERE property_id = $1 AND primary_guest_id IS NOT NULL
        GROUP BY primary_guest_id
       HAVING count(*) > 1 AND bool_or(legacy_reference IS NOT NULL)
     ), schein AS (
       SELECT DISTINCT ON (reservation_id, guest_id)
              reservation_id, guest_id, created_at, external_system, external_reference
         FROM registration
        WHERE property_id = $1 AND group_registration_id IS NULL
        ORDER BY reservation_id, guest_id, created_at DESC
     )
     SELECT r.id, r.public_ref AS reservation_ref, r.legacy_reference,
            r.arrival::text, r.departure::text, r.status::text,
            g.id AS guest_id, g.first_name, g.last_name,
            g.erasure_requested_at IS NOT NULL AS loeschantrag,
            g.contact_origin ? 'firstName' AS vorname_umsystem,
            s.created_at::text AS schein_seit,
            s.external_system AS schein_system, s.external_reference AS schein_referenz
       FROM geteilt t
       JOIN reservation r ON r.primary_guest_id = t.guest_id AND r.property_id = $1
       JOIN guest g ON g.id = t.guest_id
       LEFT JOIN schein s ON s.reservation_id = r.id AND s.guest_id = g.id
      WHERE g.status <> 'anonymized'
      ORDER BY g.id, r.arrival, r.id`, [propertyId])

  const nachGast = new Map<string, Zeile[]>()
  for (const z of rows) {
    const liste = nachGast.get(z.guest_id)
    if (liste) liste.push(z)
    else nachGast.set(z.guest_id, [z])
  }

  const gruppen: Gruppe[] = []
  let loeschantrag = 0
  for (const zeilen of nachGast.values()) {
    // Nach einem Loeschantrag wird nichts mehr vervielfaeltigt; die
    // Loeschung nimmt das Profil ohnehin.
    if (zeilen[0]!.loeschantrag) { loeschantrag += zeilen.length; continue }
    const { zeile, grund } = behaelt(zeilen, heute)
    const abtrennen = zeilen.filter(z => z !== zeile && (ab === null || z.departure >= ab))
    const vornameLeeren = grund !== 'own_registration' && zeile.vorname_umsystem
    if (abtrennen.length === 0 && !vornameLeeren) continue
    gruppen.push({ behaelt: zeile, grund, vornameLeeren, abtrennen })
  }
  return { businessDate: heute, gruppen, loeschantrag }
}

const name = (vor: string | null, nach: string) =>
  [vor?.trim(), nach.trim()].filter(Boolean).join(' ')

function bericht(plan: Plan, von: string | null, bis: string | null) {
  const neu = plan.gruppen.reduce((n, g) => n + g.abtrennen.length, 0)
  const nachsenden = plan.gruppen.flatMap(g => g.abtrennen.filter(z => z.schein_seit !== null))

  const zeilen: Array<Record<string, unknown>> = []
  if (von !== null && bis !== null) {
    for (const g of plan.gruppen) {
      const alle = [g.behaelt, ...g.abtrennen]
      for (const z of alle) {
        if (z.arrival < von || z.arrival > bis) continue
        const bleibt = z === g.behaelt
        zeilen.push({
          reservationRef: z.reservation_ref,
          legacyReference: z.legacy_reference,
          arrival: z.arrival, departure: z.departure, status: z.status,
          sharedWith: alle.length - 1,
          nameNow: name(z.first_name, z.last_name),
          nameAfter: bleibt && !g.vornameLeeren
            ? name(z.first_name, z.last_name) : z.last_name.trim(),
          action: bleibt ? 'keeps_profile' : 'own_profile',
          ...(bleibt ? { reason: g.grund } : {}),
          registrationNeedsResend: !bleibt && z.schein_seit !== null
        })
      }
    }
    zeilen.sort((a, b) => String(a.arrival).localeCompare(String(b.arrival)))
  }

  return {
    businessDate: plan.businessDate,
    summary: {
      sharedProfiles: plan.gruppen.filter(g => g.abtrennen.length > 0).length,
      newProfiles: neu,
      firstNamesCleared: plan.gruppen.filter(g => g.vornameLeeren).length,
      registrationsToResend: nachsenden.length,
      skippedErasureRequested: plan.loeschantrag
    },
    registrationsToResend: nachsenden.map(z => ({
      reservationRef: z.reservation_ref, legacyReference: z.legacy_reference,
      system: z.schein_system, reference: z.schein_referenz })),
    ...(von !== null ? { arrivals: { from: von, to: bis, reservations: zeilen } } : {})
  }
}

function abDatum(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !isIsoDate(v)) throw Errors.validation({ from: ['field.isoDate'] })
  return v
}

export function sharedGuestProfileRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/guest-profiles/shared',
    permission: 'guest:write',
    propertyParam: 'propertyId',
    summary: 'Probelauf: geteilte Gastprofile aus dem KWHotel-Import trennen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { from?: string; arrivalFrom?: string; arrivalTo?: string }
      const ab = abDatum(q.from)
      const von = q.arrivalFrom === undefined ? null : q.arrivalFrom
      const bis = q.arrivalTo === undefined ? von : q.arrivalTo
      if (von !== null || bis !== null) {
        if (von === null || !isIsoDate(von)) {
          throw Errors.validation({ arrivalFrom: ['field.isoDate'] })
        }
        if (bis === null || !isIsoDate(bis) || bis < von) {
          throw Errors.validation({ arrivalTo: ['field.isoDate'] })
        }
        if (bis > addDays(von, MAX_TAGE - 1)) throw Errors.rangeTooLarge(MAX_TAGE)
      }
      return tx(req.pool, req, async client => ({
        dryRun: true, from: ab, ...bericht(await planen(client, propertyId, ab), von, bis)
      }))
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/guest-profiles/shared/split',
    permission: 'guest:write',
    propertyParam: 'propertyId',
    summary: 'Geteilte Gastprofile aus dem KWHotel-Import trennen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { expectedNewProfiles?: unknown; from?: unknown }
      const erwartet = b.expectedNewProfiles
      if (typeof erwartet !== 'number' || !Number.isInteger(erwartet) || erwartet < 0) {
        throw Errors.validation({ expectedNewProfiles: ['field.invalid'] })
      }
      const ab = abDatum(b.from)
      return tx(req.pool, req, async client => {
        const plan = await planen(client, propertyId, ab)
        const neu = plan.gruppen.reduce((n, g) => n + g.abtrennen.length, 0)
        if (neu !== erwartet) {
          throw Errors.conflict('guestSplit.planChanged', { expected: erwartet, actual: neu })
        }
        const ids = plan.gruppen.flatMap(g => g.abtrennen.map(z => Number(z.id)))
        if (ids.length > 0) {
          await client.query(`SELECT count(*) FROM guest_split_reservations($1::bigint[])`, [ids])
        }
        /*
         * Erst nach dem Trennen: der Vorname, den das Adminpanel gesetzt
         * hat, gehoert zu irgendeinem der Aufenthalte, und welchem, weiss
         * niemand. Der Trigger aus 0083 nimmt den Herkunftseintrag mit.
         */
        const leeren = plan.gruppen.filter(g => g.vornameLeeren).map(g => Number(g.behaelt.guest_id))
        if (leeren.length > 0) {
          await client.query(
            `UPDATE guest SET first_name = NULL, updated_at = now() WHERE id = ANY ($1::bigint[])`,
            [leeren])
        }
        return { dryRun: false, from: ab, ...bericht(plan, null, null) }
      })
    }
  })
}
