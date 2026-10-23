import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { addDays, isClockTime, isIsoDate, isMonth, minutesBetween, monthRange }
  from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { exportMelden } from '../platform/bestaetigung.js'
import { can, propertyIds, type Principal } from '../platform/context.js'
import { tagOderOffen } from './cleaningPlan.js'
import { writeCsv as csv } from '../platform/csv.js'
import { reiheUebersetzungEin, zielDeutsch } from '../platform/uebersetzung.js'

/**
 * Arbeitszeit (Aufgabe 18, Baustein 6; Migration 0111).
 *
 * Die Zeit eines Tages = Minuten der gereinigten Zimmer + Zusatzarbeiten +
 * Kueche + Korrekturen der Leitung. Keine Stempeluhr: das Personal wird
 * vertraglich nach diesen Pauschalminuten abgerechnet (Sven, 07.10.2026).
 *
 * **Wer was sieht.** Die Kraft sieht nur sich (`/my-time`, Recht
 * `staff:app`, gesucht wird nach `user_id = ich`). Die Leitung
 * (`worktime:manage`) sieht alle, korrigiert, schliesst ab und gibt aus.
 * Die Hausdame hat keines von beiden fuer fremde Zeiten -- sie sieht
 * Zimmer, nicht Arbeitszeit.
 *
 * **Was die Kraft selbst eintragen darf:** heute und gestern, gemessen am
 * Geschaeftstag. So war es in der alten App gemeint (dort prueft es nur die
 * Oberflaeche); was aelter ist, korrigiert die Leitung mit Grund.
 */

const BESCHREIBUNG_MAX = 500

type Art = 'extra' | 'kitchen' | 'correction'

interface Eintrag {
  id: number
  /** Das Haus des Eintrags -- in der Ansicht ueber alle Haeuser steht es dabei. */
  propertyId: number
  date: string
  kind: Art
  description: string | null
  minutes: number
  start: string | null
  end: string | null
  source: 'staygrid' | 'legacy'
  createdBy: string | null
  createdAt: string
  withdrawn: boolean
  /**
   * Der Text deutsch (0112), sobald der Worker ihn uebersetzt hat -- und nur,
   * solange er zum aktuellen Text gehoert. `null`, wenn der Text schon
   * deutsch war oder noch nichts da ist.
   */
  translationDe: string | null
  /** Von Hand berichtigt; DeepL ueberschreibt das nicht. */
  translationManual: boolean
  /**
   * Von der Leitung angepasst (0118): was die Kraft selbst eingetragen
   * hatte, und wer anpasste. Beides `null`, solange niemand angepasst hat.
   */
  originalMinutes: number | null
  adjustedBy: string | null
  /** Wer zurueckgezogen hat, wenn es nicht die Kraft selbst war. */
  withdrawnBy: string | null
}

interface Tag {
  date: string
  /** Minuten der gereinigten Zimmer und ihre Zahl. */
  roomMinutes: number
  rooms: number
  entries: Eintrag[]
  total: number
  /** Die Summe des Tages je Haus, Schluessel ist die Property-ID. */
  byHouse: Record<number, number>
}

interface Haelfte { from: string; to: string; total: number }

/** Ein Haus der Ansicht mit seiner Monatssumme. */
interface HausSumme { propertyId: number; name: string; total: number; closed: boolean }

interface Monat {
  month: string
  from: string
  to: string
  /** Bei mehreren Haeusern erst, wenn alle abgeschlossen sind. */
  closed: boolean
  /** Die Haeuser, ueber die gerechnet wurde; eines, solange nicht `scope=all`. */
  houses: HausSumme[]
  days: Tag[]
  totals: { rooms: number; extra: number; kitchen: number; correction: number; total: number }
  /**
   * 1. bis 15. und 16. bis Monatsende: die Zeitarbeitsfirma wird alle zwei
   * Wochen bezahlt (Sven, 10.10.2026), und die Summe soll nicht von Hand
   * aus der Tagesliste zusammengezaehlt werden.
   */
  halves: [Haelfte, Haelfte]
}

function personVon(req: FastifyRequest): number {
  const p = req.principal as Principal
  if (p.userId === null || p.terminalDeviceId !== null) {
    throw Errors.forbidden('staff.personOnly')
  }
  return p.userId
}

async function monatOderOffen(
  client: PoolClient, propertyId: number, month: unknown
): Promise<string> {
  if (month === undefined) return (await tagOderOffen(client, propertyId, undefined)).slice(0, 7)
  if (!isMonth(month)) throw Errors.validation({ month: ['field.isoMonth'] })
  return month
}

async function istAbgeschlossen(
  client: PoolClient, propertyId: number, date: string
): Promise<boolean> {
  const { rows } = await client.query<{ zu: boolean }>(
    `SELECT staff_month_is_closed($1, $2::date) AS zu`, [propertyId, date])
  return rows[0]!.zu
}

/**
 * Die Haeuser einer Ansicht, das eigene zuerst, mit Namen und Abschluss.
 * Eine Abfrage fuer alle.
 */
async function liesHaeuser(
  client: PoolClient, haeuser: number[], from: string
): Promise<Array<{ propertyId: number; name: string; closed: boolean }>> {
  const { rows } = await client.query<{ propertyId: number; name: string; closed: boolean }>(
    `SELECT p.id::int AS "propertyId", p.name, staff_month_is_closed(p.id, $2::date) AS closed
       FROM property p
      WHERE p.id = ANY($1::bigint[])
      ORDER BY p.id <> $3, p.name, p.id`, [haeuser, from, haeuser[0]])
  return rows
}

/**
 * Ueber welche Haeuser eine Ansicht der Leitung rechnet (Sven, 16.10.2026:
 * wer fuer mehrere Haeuser reinigt, wird je Mensch abgerechnet, und zwei
 * Monatsplaene von Hand zusammenzuzaehlen ist genau die Arbeit, die das
 * System abnehmen soll). `scope=all` nimmt jedes Haus desselben Betriebs, in
 * dem der Aufrufer selbst `worktime:manage` hat -- nie eines, in dem er die
 * Zeiten nicht sehen darf, und nie eines eines fremden Betriebs, das die
 * Zeilenrichtlinie ohnehin ausblendete.
 */
function haeuserFuer(p: Principal, propertyId: number, scope: unknown): number[] {
  if (scope === undefined || scope === 'house') return [propertyId]
  if (scope !== 'all') {
    throw Errors.validation({ scope: ['field.allowedValues'] }, { values: 'house, all' })
  }
  return mitSchwestern(p, propertyId, 'worktime:manage')
}

/** Das Haus und jedes Haus desselben Betriebs, in dem der Aufrufer das Recht hat. */
function mitSchwestern(
  p: Principal, propertyId: number, recht: 'staff:app' | 'worktime:manage'
): number[] {
  const betrieb = p.propertyAccounts.get(propertyId)
  return [propertyId, ...andereMit(p, propertyId, recht)
    .filter(id => p.propertyAccounts.get(id) === betrieb)]
}

/**
 * Der Monat der Kraft ueber alle ihre Haeuser (Sven, 16.10.2026: das
 * Personal soll seine Stunden gesammelt sehen, nicht je Haus). Jeder Tag
 * traegt die Minuten je Haus, jeder Eintrag sein Haus -- zurueckgezogen
 * wird am Haus des Eintrags.
 */
async function meinMonat(
  client: PoolClient, p: Principal, propertyId: number, ich: number, month: string
): Promise<Monat & { today: string }> {
  const heute = await tagOderOffen(client, propertyId, undefined)
  return { ...(await liesMonat(client, mitSchwestern(p, propertyId, 'staff:app'), ich, month)),
           today: heute }
}

async function monatOffen(client: PoolClient, propertyId: number, date: string): Promise<void> {
  if (await istAbgeschlossen(client, propertyId, date)) {
    throw Errors.conflict('worktime.monthClosed', { month: date.slice(0, 7) })
  }
}

/**
 * Der Monat einer Person, Tag fuer Tag, in drei Abfragen: Haeuser, Zimmer
 * und Eintraege -- gleich, ueber wie viele Haeuser. Jeder Tag des Monats
 * steht da, auch der leere -- die Kraft soll sehen, dass ein Tag fehlt, und
 * nicht raten, ob er geladen ist.
 */
async function liesMonat(
  client: PoolClient, haeuser: number[], userId: number, month: string
): Promise<Monat> {
  const { from, to } = monthRange(month)
  const zimmer = await client.query<{ date: string; propertyId: number; minutes: number
                                      rooms: number }>(
    `SELECT business_date::text AS date, property_id::int AS "propertyId",
            COALESCE(sum(minutes), 0)::int AS minutes, count(*)::int AS rooms
       FROM housekeeping_task
      WHERE property_id = ANY($1::bigint[]) AND assigned_to = $2 AND outcome = 'cleaned'
        AND business_date BETWEEN $3::date AND $4::date
      GROUP BY 1, 2`, [haeuser, userId, from, to])
  const eintraege = await liesEintraege(client, haeuser, from, to, userId)
  const haus = await liesHaeuser(client, haeuser, from)

  const days: Tag[] = []
  const totals = { rooms: 0, extra: 0, kitchen: 0, correction: 0, total: 0 }
  const jeHaus = new Map(haus.map(h => [h.propertyId, 0]))
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const byHouse: Record<number, number> = {}
    const dazu = (propertyId: number, min: number): void => {
      byHouse[propertyId] = (byHouse[propertyId] ?? 0) + min
      jeHaus.set(propertyId, (jeHaus.get(propertyId) ?? 0) + min)
    }
    let roomMinutes = 0
    let rooms = 0
    for (const z of zimmer.rows) {
      if (z.date !== d) continue
      roomMinutes += z.minutes
      rooms += z.rooms
      dazu(z.propertyId, z.minutes)
    }
    const entries = eintraege.rows.filter(e => e.date === d).map(({ userId: _, ...e }) => e)
    let total = roomMinutes
    totals.rooms += roomMinutes
    for (const e of entries) {
      if (e.withdrawn) continue
      totals[e.kind] += e.minutes
      total += e.minutes
      dazu(e.propertyId, e.minutes)
    }
    totals.total += total
    days.push({ date: d, roomMinutes, rooms, entries, total, byHouse })
  }
  const mitte = `${month}-15`
  const summe = (bis: boolean): number =>
    days.filter(d => (d.date <= mitte) === bis).reduce((s, d) => s + d.total, 0)
  const halves: [Haelfte, Haelfte] = [
    { from, to: mitte, total: summe(true) },
    { from: addDays(mitte, 1), to, total: summe(false) }]
  return { month, from, to, closed: haus.every(h => h.closed),
           houses: haus.map(h => ({ ...h, total: jeHaus.get(h.propertyId) ?? 0 })),
           days, totals, halves }
}

/**
 * Die Eintraege eines Zeitraums, einer Person oder aller (`userId` null).
 * Monat und Tagesansicht lesen hier, damit beide dieselbe Zeile zeigen.
 */
async function liesEintraege(
  client: PoolClient, haeuser: number[], from: string, to: string, userId: number | null
): Promise<{ rows: Array<Eintrag & { userId: number }> }> {
  return client.query<Eintrag & { userId: number }>(
    `SELECT e.id::int, e.property_id::int AS "propertyId", e.user_id::int AS "userId",
            e.business_date::text AS date, e.kind,
            e.description, e.minutes,
            to_char(e.start_time, 'HH24:MI') AS start, to_char(e.end_time, 'HH24:MI') AS "end",
            e.source, u.display_name AS "createdBy", e.created_at AS "createdAt",
            (e.withdrawn_at IS NOT NULL) AS withdrawn,
            tr.text AS "translationDe", COALESCE(tr.origin = 'manual', false) AS "translationManual",
            e.original_minutes AS "originalMinutes", ad.display_name AS "adjustedBy",
            CASE WHEN e.withdrawn_at IS NOT NULL AND e.updated_by <> e.user_id
                 THEN wd.display_name END AS "withdrawnBy"
       FROM staff_work_entry e
       LEFT JOIN app_user u ON u.id = e.created_by
       LEFT JOIN app_user ad ON ad.id = e.adjusted_by
       LEFT JOIN app_user wd ON wd.id = e.updated_by
       LEFT JOIN staff_text_translation tr
              ON tr.source_kind = 'work_entry' AND tr.source_id = e.id AND tr.lang = 'de'
             AND tr.source_hash = digest(e.description, 'sha256')
      WHERE e.property_id = ANY($1::bigint[]) AND ($2::bigint IS NULL OR e.user_id = $2)
        AND e.business_date BETWEEN $3::date AND $4::date
      ORDER BY e.business_date, e.id`, [haeuser, userId, from, to])
}

interface ZimmerDesTags {
  taskId: number
  /** Das Haus des Zimmers -- in der Ansicht ueber alle Haeuser steht es dabei. */
  propertyId: number
  code: string
  kind: 'departure' | 'stayover' | 'deep_clean' | 'inspection'
  /** Geplante Minuten; gezaehlt werden sie nur bei `outcome = 'cleaned'`. */
  minutes: number
  status: 'open' | 'done' | 'skipped'
  outcome: 'cleaned' | 'declined' | 'was_clean' | null
}

interface KraftDesTags {
  userId: number
  name: string
  username: string | null
  rooms: ZimmerDesTags[]
  entries: Eintrag[]
  totals: { departure: number; stayover: number; otherRooms: number; extra: number
            kitchen: number; correction: number; total: number }
}

/**
 * Ein Tag aller Kraefte, wie die alte App ihn zeigte: je Kraft die
 * zugeteilten Zimmer nach Abreise und Bleiber, die Zusatzarbeiten und die
 * Summen. Vier Abfragen fuer alle Haeuser der Ansicht -- mit `scope=all`
 * steht eine Kraft, die in Hotel und Gaestehaus reinigt, auf einer Karte
 * (Sven, 16.10.2026). Es stehen nur Kraefte da, die an diesem Tag etwas
 * haben -- eine leere Karte je Kraft im Haus waere Rauschen.
 */
async function liesTag(
  client: PoolClient, haeuser: number[], date: string
): Promise<{ date: string; closed: boolean
            houses: Array<{ propertyId: number; name: string; closed: boolean }>
            staff: Array<KraftDesTags & { byHouse: Record<number, number> }> }> {
  const zimmer = await client.query<ZimmerDesTags & { userId: number }>(
    `SELECT * FROM (
       SELECT t.id::int AS "taskId", t.assigned_to::int AS "userId",
              t.property_id::int AS "propertyId", COALESCE(r.code, a.code) AS code, t.kind, COALESCE(t.minutes, 0) AS minutes,
              t.status, t.outcome
         FROM housekeeping_task t
         LEFT JOIN resource r ON r.id = t.resource_id
         LEFT JOIN cleaning_area a ON a.id = t.area_id
        WHERE t.property_id = ANY($1::bigint[]) AND t.business_date = $2::date
          AND t.assigned_to IS NOT NULL) z
      ORDER BY array_position($1::bigint[], z."propertyId"::bigint),
               NULLIF(substring(z.code from '^[0-9]+'), '')::numeric NULLS LAST, z.code`,
    [haeuser, date])
  const eintraege = await liesEintraege(client, haeuser, date, date, null)
  const haus = await liesHaeuser(client, haeuser, date)
  const ids = [...new Set([...zimmer.rows.map(z => z.userId),
                           ...eintraege.rows.map(e => e.userId)])]
  const namen = ids.length === 0 ? [] : (await client.query<{ userId: number; name: string
                                                               username: string | null }>(
    `SELECT id::int AS "userId", display_name AS name, username FROM app_user
      WHERE id = ANY($1::bigint[]) ORDER BY display_name`, [ids])).rows
  const staff = namen.map(n => {
    const rooms = zimmer.rows.filter(z => z.userId === n.userId)
      .map(({ userId: _, ...z }) => z)
    const entries = eintraege.rows.filter(e => e.userId === n.userId)
      .map(({ userId: _, ...e }) => e)
    const totals = { departure: 0, stayover: 0, otherRooms: 0, extra: 0, kitchen: 0,
                     correction: 0, total: 0 }
    const byHouse: Record<number, number> = {}
    const dazu = (h: number, min: number): void => {
      totals.total += min
      byHouse[h] = (byHouse[h] ?? 0) + min
    }
    for (const z of rooms) {
      if (z.outcome !== 'cleaned') continue
      const art = z.kind === 'departure' ? 'departure'
        : z.kind === 'stayover' ? 'stayover' : 'otherRooms'
      totals[art] += z.minutes
      dazu(z.propertyId, z.minutes)
    }
    for (const e of entries) {
      if (e.withdrawn) continue
      totals[e.kind] += e.minutes
      dazu(e.propertyId, e.minutes)
    }
    return { ...n, rooms, entries, totals, byHouse }
  })
  return { date, closed: haus.every(h => h.closed), houses: haus, staff }
}

interface EintragsEingabe {
  date?: unknown; kind?: unknown; description?: unknown
  minutes?: unknown; start?: unknown; end?: unknown
}

/** Eine Zusatzarbeit oder ein Kuechendienst, geprueft und gerechnet. */
function pruefeEintrag(b: EintragsEingabe, darfKueche: boolean): {
  kind: 'extra' | 'kitchen'; description: string | null; minutes: number
  start: string | null; end: string | null
} {
  if (b.kind !== 'extra' && b.kind !== 'kitchen') {
    throw Errors.validation({ kind: ['field.allowedValues'] }, { values: 'extra, kitchen' })
  }
  // Kuechenzeiten traegt die Kueche ein; wer dort nicht arbeitet, hat
  // keine, und ein versehentlicher Eintrag zaehlte trotzdem.
  if (b.kind === 'kitchen' && !darfKueche) throw Errors.forbidden('worktime.kitchenOnly')
  const text = typeof b.description === 'string' ? b.description.trim() : ''
  if (text.length > BESCHREIBUNG_MAX) {
    throw Errors.validation({ description: ['field.maxLength'] }, { max: BESCHREIBUNG_MAX })
  }
  if (b.kind === 'extra') {
    if (text === '') throw Errors.validation({ description: ['field.required'] })
    if (!Number.isInteger(b.minutes) || (b.minutes as number) < 1
        || (b.minutes as number) > 1440) {
      throw Errors.validation({ minutes: ['field.range'] }, { min: 1, max: 1440 })
    }
    return { kind: 'extra', description: text, minutes: b.minutes as number,
             start: null, end: null }
  }
  if (!isClockTime(b.start)) throw Errors.validation({ start: ['field.clockTime'] })
  if (!isClockTime(b.end)) throw Errors.validation({ end: ['field.clockTime'] })
  const minuten = minutesBetween(b.start, b.end)
  if (minuten === null) throw Errors.validation({ end: ['worktime.sameTime'] })
  return { kind: 'kitchen', description: text === '' ? null : text, minutes: minuten,
           start: b.start, end: b.end }
}

/** Heute oder gestern, am Geschaeftstag gemessen; sonst die Leitung. */
async function eigenerTag(
  client: PoolClient, propertyId: number, date: unknown
): Promise<string> {
  const heute = await tagOderOffen(client, propertyId, undefined)
  if (date === undefined || date === null) return heute
  if (typeof date !== 'string' || !isIsoDate(date)) {
    throw Errors.validation({ date: ['field.isoDate'] })
  }
  if (date !== heute && date !== addDays(heute, -1)) {
    throw Errors.validation({ date: ['worktime.ownDays'] })
  }
  return date
}

/** Ein eigener, nicht zurueckgezogener Eintrag von heute oder gestern. */
async function eigenerEintrag(
  client: PoolClient, propertyId: number, userId: number, id: number
): Promise<{ date: string; kind: Art; description: string | null }> {
  const { rows } = await client.query<{ date: string; kind: Art; description: string | null
                                        adjusted: boolean }>(
    `SELECT business_date::text AS date, kind, description,
            (adjusted_at IS NOT NULL) AS adjusted
       FROM staff_work_entry
      WHERE id = $1 AND property_id = $2 AND user_id = $3 AND withdrawn_at IS NULL
        AND kind <> 'correction'
      FOR UPDATE`, [id, propertyId, userId])
  const e = rows[0]
  if (e === undefined) throw Errors.notFound('res.workEntry')
  // Angepasst hat die Leitung (0118); ein Tipp der Kraft kippte sonst ihre
  // Anpassung, ohne dass es jemand merkt.
  if (e.adjusted) throw Errors.conflict('worktime.adjustedByLead')
  await eigenerTag(client, propertyId, e.date)
  return { date: e.date, kind: e.kind, description: e.description }
}

/** Ein Eintrag der Kraefte fuer die Leitung: Zusatzarbeit oder Kueche, gesperrt. */
async function eintragDerLeitung(
  client: PoolClient, propertyId: number, id: number
): Promise<{ date: string; kind: Art; minutes: number; originalMinutes: number | null
             withdrawn: boolean }> {
  const { rows } = await client.query<{ date: string; kind: Art; minutes: number
                                        originalMinutes: number | null; withdrawn: boolean }>(
    `SELECT business_date::text AS date, kind, minutes, original_minutes AS "originalMinutes",
            (withdrawn_at IS NOT NULL) AS withdrawn
       FROM staff_work_entry
      WHERE id = $1 AND property_id = $2 AND kind <> 'correction'
      FOR UPDATE`, [id, propertyId])
  const e = rows[0]
  if (e === undefined) throw Errors.notFound('res.workEntry')
  return e
}

function idAusPfad(req: FastifyRequest, name: string): number {
  const v = Number((req.params as Record<string, string>)[name])
  if (!Number.isInteger(v) || v <= 0) throw Errors.notFound('res.workEntry')
  return v
}

/**
 * Wer in diesen Haeusern Arbeitszeit haben kann: Reinigung und Kueche --
 * bei gemeinsamem Personal (0116) die des ganzen Betriebs --, dazu jeder,
 * der im Monat Minuten hat. Ein Name aus einem fremden Haus kommt so
 * nicht in die Liste -- die Benutzertabelle hat keine Zeilenrichtlinie.
 */
async function liesKraefte(
  client: PoolClient, haeuser: number[], from: string, to: string
): Promise<Array<{ userId: number; name: string; username: string | null }>> {
  const { rows } = await client.query<{ userId: number; name: string; username: string | null }>(
    `SELECT u.id::int AS "userId", u.display_name AS name, u.username
       FROM app_user u
      WHERE u.id IN (
              SELECT upr.user_id FROM user_property_role upr
                JOIN role ro ON ro.id = upr.role_id
               WHERE upr.property_id IN (SELECT unnest(staff_houses(h))
                                           FROM unnest($1::bigint[]) h)
                 AND ro.key IN ('housekeeping_staff','kitchen')
              UNION
              SELECT assigned_to FROM housekeeping_task
               WHERE property_id = ANY($1::bigint[]) AND outcome = 'cleaned'
                 AND assigned_to IS NOT NULL
                 AND business_date BETWEEN $2::date AND $3::date
              UNION
              SELECT user_id FROM staff_work_entry
               WHERE property_id = ANY($1::bigint[])
                 AND business_date BETWEEN $2::date AND $3::date)
      ORDER BY u.display_name`, [haeuser, from, to])
  return rows
}

interface TagesSumme {
  rooms: number; roomMinutes: number; extra: number; kitchen: number
  correction: number; total: number
  /** Die Summe je Haus, Schluessel ist die Property-ID. */
  byHouse: Record<number, number>
}

/**
 * Alle Kraefte eines Monats mit ihren Tagessummen nach Art -- fuenf
 * Abfragen fuer alle Haeuser der Ansicht, nicht fuenf je Kraft oder je
 * Haus. Die Uebersicht und die Ausgabe lesen beide hier.
 */
async function sammle(client: PoolClient, haeuser: number[], month: string) {
  const { from, to } = monthRange(month)
  const kraefte = await liesKraefte(client, haeuser, from, to)
  const zimmer = await client.query<{ userId: number; date: string; propertyId: number
                                      minutes: number; rooms: number }>(
    `SELECT assigned_to::int AS "userId", business_date::text AS date,
            property_id::int AS "propertyId",
            COALESCE(sum(minutes), 0)::int AS minutes, count(*)::int AS rooms
       FROM housekeeping_task
      WHERE property_id = ANY($1::bigint[]) AND outcome = 'cleaned' AND assigned_to IS NOT NULL
        AND business_date BETWEEN $2::date AND $3::date
      GROUP BY 1, 2, 3`, [haeuser, from, to])
  const eintraege = await client.query<{ userId: number; date: string; propertyId: number
                                         kind: Art; minutes: number }>(
    `SELECT user_id::int AS "userId", business_date::text AS date,
            property_id::int AS "propertyId", kind, sum(minutes)::int AS minutes
       FROM staff_work_entry
      WHERE property_id = ANY($1::bigint[]) AND withdrawn_at IS NULL
        AND business_date BETWEEN $2::date AND $3::date
      GROUP BY 1, 2, 3, 4`, [haeuser, from, to])
  const abschluss = await client.query<{ propertyId: number; closedAt: string
                                         closedBy: string | null }>(
    `SELECT c.property_id::int AS "propertyId", c.closed_at AS "closedAt",
            u.display_name AS "closedBy"
       FROM staff_month_close c LEFT JOIN app_user u ON u.id = c.closed_by
      WHERE c.property_id = ANY($1::bigint[]) AND c.month = $2::date AND c.reopened_at IS NULL
      ORDER BY c.closed_at DESC`, [haeuser, from])
  const haus = await liesHaeuser(client, haeuser, from)

  const leer = (): TagesSumme =>
    ({ rooms: 0, roomMinutes: 0, extra: 0, kitchen: 0, correction: 0, total: 0, byHouse: {} })
  const jeKraft = new Map<number, Map<string, TagesSumme>>(kraefte.map(k => [k.userId, new Map()]))
  const tag = (userId: number, date: string): TagesSumme | undefined => {
    const m = jeKraft.get(userId)
    if (m === undefined) return undefined
    let t = m.get(date)
    if (t === undefined) { t = leer(); m.set(date, t) }
    return t
  }
  const dazu = (t: TagesSumme, propertyId: number, min: number): void => {
    t.total += min
    t.byHouse[propertyId] = (t.byHouse[propertyId] ?? 0) + min
  }
  for (const z of zimmer.rows) {
    const t = tag(z.userId, z.date)
    if (t === undefined) continue
    t.rooms += z.rooms; t.roomMinutes += z.minutes; dazu(t, z.propertyId, z.minutes)
  }
  for (const e of eintraege.rows) {
    const t = tag(e.userId, e.date)
    if (t === undefined) continue
    t[e.kind] += e.minutes; dazu(t, e.propertyId, e.minutes)
  }
  // Ueber mehrere Haeuser ist der Monat erst zu, wenn jedes Haus zu ist --
  // eine Abrechnung, in der ein Haus sich noch aendern kann, ist keine.
  const zu = abschluss.rows.length === haeuser.length ? abschluss.rows[0]! : null
  return {
    month, from, to,
    closed: zu === null ? null : { closedAt: zu.closedAt, closedBy: zu.closedBy },
    houses: haus,
    staff: kraefte.map(k => {
      const tage = [...jeKraft.get(k.userId)!.entries()].sort(([a], [b]) => a.localeCompare(b))
      const totals = { rooms: 0, extra: 0, kitchen: 0, correction: 0, total: 0 }
      const byHouse: Record<number, number> = {}
      for (const [, t] of tage) {
        totals.rooms += t.roomMinutes; totals.extra += t.extra; totals.kitchen += t.kitchen
        totals.correction += t.correction; totals.total += t.total
        for (const [h, min] of Object.entries(t.byHouse)) {
          byHouse[Number(h)] = (byHouse[Number(h)] ?? 0) + min
        }
      }
      return { ...k, tage, totals, byHouse }
    })
  }
}

/**
 * Die Uebersicht: je Kraft die Summe je Tag, die Summen nach Art und je
 * Haus der Ansicht, dazu die Monatssumme in Haeusern ausserhalb der
 * Ansicht (`elsewhere`), die die Leitung ebenfalls fuehrt.
 * `combinable` sagt der Oberflaeche, ob es eine Ansicht ueber alle Haeuser
 * gibt -- auch, solange sie gerade nur ein Haus zeigt.
 */
async function liesUebersicht(
  client: PoolClient, p: Principal, propertyId: number, haeuser: number[], month: string
) {
  const andere = andereMit(p, propertyId, 'worktime:manage')
  const combinable = haeuserFuer(p, propertyId, 'all').length > 1
  const s = await sammle(client, haeuser, month)
  const ausserhalb = andere.filter(h => !haeuser.includes(h))
  const anderswo = await summeAnderswo(client, ausserhalb, s.staff.map(k => k.userId),
    s.from, s.to)
  return {
    month: s.month, from: s.from, to: s.to, closed: s.closed, houses: s.houses, combinable,
    staff: s.staff.map(({ tage, ...k }) => ({
      ...k, days: Object.fromEntries(tage.map(([d, t]) => [d, t.total])),
      elsewhere: anderswo.get(k.userId) ?? []
    }))
  }
}

interface Anderswo { propertyId: number; name: string; total: number }

/**
 * Die Monatssumme derselben Personen in anderen Haeusern (Sven, 07.10.2026:
 * dieselben Kraefte reinigen Hotel und Gaestehaus, und die
 * Zeitarbeitsfirma rechnet je Mensch ab, nicht je Haus). Gerechnet wie
 * `sammle`: gereinigte Zimmer plus nicht zurueckgezogene Eintraege.
 *
 * Welche Haeuser, entscheidet der Aufrufer -- die Leitung sieht nur
 * Haeuser, in denen sie selbst `worktime:manage` hat. Zwei Abfragen fuer alle Personen, nicht zwei je Person.
 */
async function summeAnderswo(
  client: PoolClient, haeuser: number[], userIds: number[], from: string, to: string
): Promise<Map<number, Anderswo[]>> {
  const ergebnis = new Map<number, Anderswo[]>()
  if (haeuser.length === 0 || userIds.length === 0) return ergebnis
  const { rows } = await client.query<{ userId: number } & Anderswo>(
    `SELECT x.user_id::int AS "userId", x.property_id::int AS "propertyId", p.name,
            sum(x.minutes)::int AS total
       FROM (SELECT assigned_to AS user_id, property_id, minutes FROM housekeeping_task
              WHERE property_id = ANY($1::bigint[]) AND assigned_to = ANY($2::bigint[])
                AND outcome = 'cleaned' AND business_date BETWEEN $3::date AND $4::date
             UNION ALL
             SELECT user_id, property_id, minutes FROM staff_work_entry
              WHERE property_id = ANY($1::bigint[]) AND user_id = ANY($2::bigint[])
                AND withdrawn_at IS NULL AND business_date BETWEEN $3::date AND $4::date) x
       JOIN property p ON p.id = x.property_id
      GROUP BY 1, 2, 3
      ORDER BY 3`, [haeuser, userIds, from, to])
  for (const { userId, ...a } of rows) {
    ergebnis.set(userId, [...(ergebnis.get(userId) ?? []), a])
  }
  return ergebnis
}

/** Die anderen Haeuser, in denen der Aufrufer das Recht hat. */
function andereMit(p: Principal, propertyId: number, recht: 'staff:app' | 'worktime:manage'): number[] {
  return propertyIds(p).filter(id => id !== propertyId && can(p, recht, id))
}

/** Gehoert die Person zu einem dieser Haeuser? Sonst ist sie fuer die Leitung 404. */
async function kraftImHaus(
  client: PoolClient, haeuser: number[], userId: number, month: string
): Promise<void> {
  const { from, to } = monthRange(month)
  const { rows } = await client.query<{ ja: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM user_property_role
                     WHERE property_id IN (SELECT unnest(staff_houses(h))
                                             FROM unnest($1::bigint[]) h)
                       AND user_id = $2)
         OR EXISTS (SELECT 1 FROM housekeeping_task
                     WHERE property_id = ANY($1::bigint[]) AND assigned_to = $2
                       AND business_date BETWEEN $3::date AND $4::date)
         OR EXISTS (SELECT 1 FROM staff_work_entry
                     WHERE property_id = ANY($1::bigint[]) AND user_id = $2) AS ja`,
    [haeuser, userId, from, to])
  if (!rows[0]!.ja) throw Errors.notFound('res.user')
}

const stunden = (min: number): string => (min / 60).toFixed(2).replace('.', ',')

export function worktimeRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------ die Kraft

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/my-time',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Meine Arbeitszeit eines Monats (Personal-App)',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const ich = personVon(req)
      const q = req.query as { month?: string }
      return tx(req.pool, req, async client =>
        meinMonat(client, req.principal as Principal, propertyId, ich,
          await monatOderOffen(client, propertyId, q.month)))
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/my-time',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Zusatzarbeit oder Kuechendienst eintragen (Personal-App)',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const ich = personVon(req)
      const b = (req.body ?? {}) as EintragsEingabe
      const e = pruefeEintrag(b, can(req.principal as Principal, 'kitchen:breakfast', propertyId))
      return tx(req.pool, req, async client => {
        const tag = await eigenerTag(client, propertyId, b.date)
        await monatOffen(client, propertyId, tag)
        const neu = await client.query<{ id: number }>(
          `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind,
                                         description, minutes, start_time, end_time, created_by)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7::time, $8::time, $2) RETURNING id::int`,
          [propertyId, ich, tag, e.kind, e.description, e.minutes, e.start, e.end])
        if (e.description !== null) {
          await reiheUebersetzungEin(client, propertyId, 'work_entry', neu.rows[0]!.id,
            await zielDeutsch(client, ich))
        }
        reply.code(201)
        return meinMonat(client, req.principal as Principal, propertyId, ich, tag.slice(0, 7))
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/my-time/:entryId',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Eigenen Eintrag von heute oder gestern aendern (Personal-App)',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const id = idAusPfad(req, 'entryId')
      const ich = personVon(req)
      const b = (req.body ?? {}) as EintragsEingabe
      const e = pruefeEintrag(b, can(req.principal as Principal, 'kitchen:breakfast', propertyId))
      return tx(req.pool, req, async client => {
        const alt = await eigenerEintrag(client, propertyId, ich, id)
        await monatOffen(client, propertyId, alt.date)
        await client.query(
          `UPDATE staff_work_entry
              SET kind = $2, description = $3, minutes = $4, start_time = $5::time,
                  end_time = $6::time, updated_by = $7, updated_at = now()
            WHERE id = $1`, [id, e.kind, e.description, e.minutes, e.start, e.end, ich])
        // Nur ein geaenderter Text geht noch einmal an DeepL; geaenderte
        // Minuten aendern an der Uebersetzung nichts.
        if (e.description !== null && e.description !== alt.description) {
          await reiheUebersetzungEin(client, propertyId, 'work_entry', id,
            await zielDeutsch(client, ich))
        }
        return meinMonat(client, req.principal as Principal, propertyId, ich,
          alt.date.slice(0, 7))
      })
    }
  })

  /**
   * Zurueckziehen statt Loeschen: der Eintrag zaehlt nicht mehr, bleibt aber
   * stehen. Ein Fehltipp ist schnell korrigiert, und niemand kann spaeter
   * behaupten, eine Stunde habe nie dagestanden.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/my-time/:entryId/withdraw',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Eigenen Eintrag von heute oder gestern zurueckziehen (Personal-App)',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const id = idAusPfad(req, 'entryId')
      const ich = personVon(req)
      return tx(req.pool, req, async client => {
        const alt = await eigenerEintrag(client, propertyId, ich, id)
        await monatOffen(client, propertyId, alt.date)
        await client.query(
          `UPDATE staff_work_entry SET withdrawn_at = now(), updated_by = $2, updated_at = now()
            WHERE id = $1`, [id, ich])
        return meinMonat(client, req.principal as Principal, propertyId, ich,
          alt.date.slice(0, 7))
      })
    }
  })

  // ------------------------------------------------------------ die Leitung

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit aller Kraefte eines Monats, mit scope=all ueber alle Haeuser',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { month?: string; scope?: string }
      const principal = req.principal as Principal
      const haeuser = haeuserFuer(principal, propertyId, q.scope)
      return tx(req.pool, req, async client =>
        liesUebersicht(client, principal, propertyId, haeuser,
          await monatOderOffen(client, propertyId, q.month)))
    }
  })

  /**
   * Die Abrechnung fuer die Zeitarbeitsfirma: eine Zeile je Kraft und Tag
   * mit Minuten, dazu eine Summe je Kraft. Nur fuer einen abgeschlossenen
   * Monat -- eine Abrechnung, die sich danach noch aendern kann, ist keine.
   * Mit `scope=all` eine Zeile je Kraft und Tag ueber alle Haeuser, die
   * Minuten je Haus hinten angehaengt: die Spalten davor bleiben, wo die
   * Lohnbuchhaltung sie kennt.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime/export',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit eines abgeschlossenen Monats als CSV, mit scope=all ueber alle Haeuser',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { month?: string; scope?: string }
      if (!isMonth(q.month)) throw Errors.validation({ month: ['field.isoMonth'] })
      const month = q.month
      const haeuser = haeuserFuer(req.principal as Principal, propertyId, q.scope)
      await exportMelden(req, propertyId, 'worktime',
        { bestaetigen: false, detail: { month, houses: haeuser.length } })
      return tx(req.pool, req, async client => {
        const u = await sammle(client, haeuser, month)
        if (u.closed === null) throw Errors.conflict('worktime.notClosed', { month })
        const jeHaus = u.houses.length > 1 ? u.houses : []
        // Deutsche Ueberschriften, Semikolon, Komma: der Empfaenger ist die
        // Lohnbuchhaltung der Zeitarbeitsfirma mit einer Tabellenkalkulation.
        const kopf = ['Mitarbeiter', 'Benutzername', 'Datum', 'Zimmer', 'Zimmer Minuten',
                      'Zusatzarbeit Minuten', 'Kueche Minuten', 'Korrektur Minuten',
                      'Summe Minuten', 'Summe Stunden',
                      ...jeHaus.map(h => `${h.name} Minuten`)]
        const zeilen: Array<Array<string | number | null>> = []
        for (const k of u.staff) {
          if (k.tage.length === 0) continue
          // Gegen Formeln entschaerft `csv()` selbst (Befund M10); die
          // negative Korrektur bleibt dabei eine Zahl.
          const name = k.name
          const login = k.username
          for (const [d, t] of k.tage) {
            zeilen.push([name, login, d, t.rooms, t.roomMinutes, t.extra, t.kitchen,
                         t.correction, t.total, stunden(t.total),
                         ...jeHaus.map(h => t.byHouse[h.propertyId] ?? 0)])
          }
          zeilen.push([name, login, 'Summe', null, k.totals.rooms, k.totals.extra,
                       k.totals.kitchen, k.totals.correction, k.totals.total,
                       stunden(k.totals.total),
                       ...jeHaus.map(h => k.byHouse[h.propertyId] ?? 0)])
        }
        reply.header('content-type', 'text/csv; charset=utf-8')
        const datei = jeHaus.length > 0 ? `arbeitszeit-${month}-alle-haeuser.csv`
                                        : `arbeitszeit-${month}.csv`
        reply.header('content-disposition', `attachment; filename="${datei}"`)
        // Mit Byte-Order-Mark: sonst liest Excel die Umlaute der Namen falsch.
        return '﻿' + csv([kopf, ...zeilen])
      })
    }
  })

  /**
   * Die Haeuser, zwischen denen die Leitung auf diesem Bildschirm waehlt:
   * dieses und jedes andere des Betriebs, in dem sie die Arbeitszeit
   * fuehrt. Die Reiter stehen ueber Tag und Monat, bevor einer geladen ist.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime/houses',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Haeuser, deren Arbeitszeit die Leitung fuehrt',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const haeuser = haeuserFuer(req.principal as Principal, propertyId, 'all')
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ propertyId: number; name: string }>(
          `SELECT id::int AS "propertyId", name FROM property
            WHERE id = ANY($1::bigint[])
            ORDER BY id <> $2, name, id`, [haeuser, propertyId])
        return { houses: rows }
      })
    }
  })

  /**
   * Ein Tag aller Kraefte mit Zimmern und Zusatzarbeiten (Sven, 10.10.2026:
   * so sah die Stundenuebersicht der alten App aus). Ein Tag ist die
   * Obergrenze des Zeitraums.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime/day',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit aller Kraefte an einem Tag, mit scope=all ueber alle Haeuser',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { date?: string; scope?: string }
      if (q.date !== undefined && !isIsoDate(q.date)) {
        throw Errors.validation({ date: ['field.isoDate'] })
      }
      const haeuser = haeuserFuer(req.principal as Principal, propertyId, q.scope)
      return tx(req.pool, req, async client =>
        liesTag(client, haeuser, q.date ?? await tagOderOffen(client, propertyId, undefined)))
    }
  })

  /**
   * Die Minuten einer Zusatzarbeit anpassen, wenn die Kraft sich vertippt
   * hat (0118). Kein Ueberschreiben ohne Spur: der Wert der Kraft bleibt in
   * `original_minutes`, und sie sieht an ihrem Eintrag, dass und von wem
   * angepasst wurde. Kuechendienste haben Beginn und Ende; dort bleibt die
   * Korrektur mit Grund.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/worktime/entries/:entryId',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Minuten einer Zusatzarbeit anpassen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const id = idAusPfad(req, 'entryId')
      const principal = req.principal as Principal
      const minuten = (req.body as { minutes?: unknown } | null)?.minutes
      if (!Number.isInteger(minuten) || (minuten as number) < 1 || (minuten as number) > 1440) {
        throw Errors.validation({ minutes: ['field.range'] }, { min: 1, max: 1440 })
      }
      return tx(req.pool, req, async client => {
        const e = await eintragDerLeitung(client, propertyId, id)
        if (e.kind !== 'extra') throw Errors.conflict('worktime.extraOnly')
        if (e.withdrawn) throw Errors.notFound('res.workEntry')
        await monatOffen(client, propertyId, e.date)
        if (minuten !== e.minutes) {
          // Die erste Anpassung haelt fest, was die Kraft eingetragen hatte;
          // jede weitere laesst das stehen.
          await client.query(
            `UPDATE staff_work_entry
                SET minutes = $2, original_minutes = COALESCE(original_minutes, minutes),
                    adjusted_by = $3, adjusted_at = now(), updated_by = $3, updated_at = now()
              WHERE id = $1`, [id, minuten, principal.userId])
        }
        return liesTag(client, [propertyId], e.date)
      })
    }
  })

  /**
   * Eine Zusatzarbeit oder einen Kuechendienst herausnehmen ("×" der alten
   * App). Zurueckziehen wie bei der Kraft, nicht loeschen: die Zeile bleibt
   * stehen, durchgestrichen, mit dem Namen dessen, der sie herausnahm.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/worktime/entries/:entryId/withdraw',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Eintrag einer Kraft zurueckziehen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const id = idAusPfad(req, 'entryId')
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const e = await eintragDerLeitung(client, propertyId, id)
        await monatOffen(client, propertyId, e.date)
        if (!e.withdrawn) {
          await client.query(
            `UPDATE staff_work_entry SET withdrawn_at = now(), updated_by = $2, updated_at = now()
              WHERE id = $1`, [id, principal.userId])
        }
        return liesTag(client, [propertyId], e.date)
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime/:userId',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit einer Kraft eines Monats, Tag fuer Tag, mit scope=all ueber alle Haeuser',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const userId = Number((req.params as { userId: string }).userId)
      if (!Number.isInteger(userId) || userId <= 0) throw Errors.notFound('res.user')
      const q = req.query as { month?: string; scope?: string }
      const haeuser = haeuserFuer(req.principal as Principal, propertyId, q.scope)
      return tx(req.pool, req, async client => {
        const month = await monatOderOffen(client, propertyId, q.month)
        await kraftImHaus(client, haeuser, userId, month)
        return liesMonat(client, haeuser, userId, month)
      })
    }
  })

  /**
   * Eine Korrektur mit Vorzeichen und Grund, an einem Tag. Die Leitung
   * aendert nie eine Zeile der Kraft; die Korrektur steht daneben, und die
   * Kraft sieht sie mit dem Grund.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/worktime/corrections',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit einer Kraft mit Grund korrigieren',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const b = (req.body ?? {}) as { userId?: unknown; date?: unknown; minutes?: unknown
                                      reason?: unknown }
      if (!Number.isInteger(b.userId)) throw Errors.validation({ userId: ['field.integer'] })
      if (typeof b.date !== 'string' || !isIsoDate(b.date)) {
        throw Errors.validation({ date: ['field.isoDate'] })
      }
      if (!Number.isInteger(b.minutes) || b.minutes === 0
          || Math.abs(b.minutes as number) > 1440) {
        throw Errors.validation({ minutes: ['worktime.correctionRange'] })
      }
      const grund = typeof b.reason === 'string' ? b.reason.trim() : ''
      if (grund === '') throw Errors.validation({ reason: ['worktime.reasonRequired'] })
      if (grund.length > BESCHREIBUNG_MAX) {
        throw Errors.validation({ reason: ['field.maxLength'] }, { max: BESCHREIBUNG_MAX })
      }
      const userId = b.userId as number
      const date = b.date
      return tx(req.pool, req, async client => {
        await kraftImHaus(client, [propertyId], userId, date.slice(0, 7))
        await monatOffen(client, propertyId, date)
        await client.query(
          `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind,
                                         description, minutes, created_by)
           VALUES ($1, $2, $3::date, 'correction', $4, $5, $6)`,
          [propertyId, userId, date, grund, b.minutes, principal.userId])
        reply.code(201)
        return liesMonat(client, [propertyId], userId, date.slice(0, 7))
      })
    }
  })

  /**
   * Uebersetzung eines Eintrags von Hand berichtigen (0112). DeepL trifft
   * Fachwoerter des Hauses nicht immer ("Waescheraum" ist kein
   * "laundry room", wenn dort nur Bettwaesche liegt). Die Berichtigung gilt
   * dem Text, wie er jetzt dasteht: aendert die Kraft ihn spaeter, wird neu
   * uebersetzt. `text: null` gibt die Zeile wieder an DeepL.
   *
   * Auch im abgeschlossenen Monat: die Uebersetzung ist keine Abrechnung.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/worktime/entries/:entryId/translation',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Deutsche Uebersetzung eines Eintrags berichtigen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const id = idAusPfad(req, 'entryId')
      const principal = req.principal as Principal
      const roh = (req.body as { text?: unknown } | null)?.text
      if (roh !== null && typeof roh !== 'string') {
        throw Errors.validation({ text: ['field.required'] })
      }
      const text = typeof roh === 'string' ? roh.trim() : null
      if (text === '') throw Errors.validation({ text: ['field.required'] })
      if (text !== null && text.length > BESCHREIBUNG_MAX) {
        throw Errors.validation({ text: ['field.maxLength'] }, { max: BESCHREIBUNG_MAX })
      }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ user_id: number; date: string
                                              description: string | null }>(
          `SELECT user_id::int, business_date::text AS date, description
             FROM staff_work_entry
            WHERE id = $1 AND property_id = $2 AND kind <> 'correction'`, [id, propertyId])
        const e = rows[0]
        if (e === undefined || e.description === null) throw Errors.notFound('res.workEntry')
        if (text === null) {
          await client.query(
            `DELETE FROM staff_text_translation
              WHERE source_kind = 'work_entry' AND source_id = $1 AND lang = 'de'`, [id])
          await reiheUebersetzungEin(client, propertyId, 'work_entry', id, ['de'])
        } else {
          await client.query(
            `INSERT INTO staff_text_translation (property_id, source_kind, source_id,
                                                 source_hash, lang, text, origin, updated_by)
             VALUES ($1, 'work_entry', $2, digest($3::text, 'sha256'), 'de', $4, 'manual', $5)
             ON CONFLICT (source_kind, source_id, lang) DO UPDATE
               SET source_hash = EXCLUDED.source_hash, text = EXCLUDED.text,
                   origin = 'manual', updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [propertyId, id, e.description, text, principal.userId])
        }
        return liesMonat(client, [propertyId], e.user_id, e.date.slice(0, 7))
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/worktime/close',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Monat der Arbeitszeit abschliessen, mit scope=all in allen Haeusern',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const b = (req.body ?? {}) as { month?: unknown; scope?: unknown }
      const month = b.month
      if (!isMonth(month)) throw Errors.validation({ month: ['field.isoMonth'] })
      const haeuser = haeuserFuer(principal, propertyId, b.scope)
      return tx(req.pool, req, async client => {
        // Ein Monat, der noch laeuft, ist nicht abzuschliessen: morgen kaeme
        // eine Reinigung dazu, die nirgends mehr hin darf. Jedes Haus hat
        // seinen eigenen Geschaeftstag.
        for (const h of haeuser) {
          const heute = await tagOderOffen(client, h, undefined)
          if (monthRange(month).to >= heute) {
            throw Errors.conflict('worktime.monthRunning', { month })
          }
        }
        await client.query(
          `INSERT INTO staff_month_close (property_id, month, closed_by)
           SELECT h, $2::date, $3 FROM unnest($1::bigint[]) h
           ON CONFLICT (property_id, month) WHERE reopened_at IS NULL DO NOTHING`,
          [haeuser, `${month}-01`, principal.userId])
        return liesUebersicht(client, principal, propertyId, haeuser, month)
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/worktime/reopen',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Abgeschlossenen Monat mit Grund wieder oeffnen, mit scope=all in allen Haeusern',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const b = (req.body ?? {}) as { month?: unknown; reason?: unknown; scope?: unknown }
      if (!isMonth(b.month)) throw Errors.validation({ month: ['field.isoMonth'] })
      const grund = typeof b.reason === 'string' ? b.reason.trim() : ''
      if (grund === '') throw Errors.validation({ reason: ['worktime.reasonRequired'] })
      if (grund.length > BESCHREIBUNG_MAX) {
        throw Errors.validation({ reason: ['field.maxLength'] }, { max: BESCHREIBUNG_MAX })
      }
      const month = b.month
      const haeuser = haeuserFuer(principal, propertyId, b.scope)
      return tx(req.pool, req, async client => {
        const { rowCount } = await client.query(
          `UPDATE staff_month_close
              SET reopened_by = $3, reopened_at = now(), reopen_reason = $4
            WHERE property_id = ANY($1::bigint[]) AND month = $2::date AND reopened_at IS NULL`,
          [haeuser, `${month}-01`, principal.userId, grund])
        if (rowCount === 0) throw Errors.conflict('worktime.notClosed', { month })
        return liesUebersicht(client, principal, propertyId, haeuser, month)
      })
    }
  })
}
