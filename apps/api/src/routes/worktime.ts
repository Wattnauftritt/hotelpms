import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { addDays, isClockTime, isIsoDate, isMonth, minutesBetween, monthRange }
  from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, propertyIds, type Principal } from '../platform/context.js'
import { tagOderOffen } from './cleaningPlan.js'
import { csv } from './reports.js'
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
}

interface Haelfte { from: string; to: string; total: number }

interface Monat {
  month: string
  from: string
  to: string
  closed: boolean
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

async function monatOffen(client: PoolClient, propertyId: number, date: string): Promise<void> {
  if (await istAbgeschlossen(client, propertyId, date)) {
    throw Errors.conflict('worktime.monthClosed', { month: date.slice(0, 7) })
  }
}

/**
 * Der Monat einer Person, Tag fuer Tag, in zwei Abfragen: Zimmer und
 * Eintraege. Jeder Tag des Monats steht da, auch der leere -- die Kraft
 * soll sehen, dass ein Tag fehlt, und nicht raten, ob er geladen ist.
 */
async function liesMonat(
  client: PoolClient, propertyId: number, userId: number, month: string
): Promise<Monat> {
  const { from, to } = monthRange(month)
  const zimmer = await client.query<{ date: string; minutes: number; rooms: number }>(
    `SELECT business_date::text AS date, COALESCE(sum(minutes), 0)::int AS minutes,
            count(*)::int AS rooms
       FROM housekeeping_task
      WHERE property_id = $1 AND assigned_to = $2 AND outcome = 'cleaned'
        AND business_date BETWEEN $3::date AND $4::date
      GROUP BY business_date`, [propertyId, userId, from, to])
  const eintraege = await liesEintraege(client, propertyId, from, to, userId)
  const zu = await istAbgeschlossen(client, propertyId, from)

  const jeTagZimmer = new Map(zimmer.rows.map(z => [z.date, z]))
  const days: Tag[] = []
  const totals = { rooms: 0, extra: 0, kitchen: 0, correction: 0, total: 0 }
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const z = jeTagZimmer.get(d)
    const entries = eintraege.rows.filter(e => e.date === d)
    const zaehlen = entries.filter(e => !e.withdrawn)
    const roomMinutes = z?.minutes ?? 0
    let total = roomMinutes
    totals.rooms += roomMinutes
    for (const e of zaehlen) {
      totals[e.kind] += e.minutes
      total += e.minutes
    }
    totals.total += total
    days.push({ date: d, roomMinutes, rooms: z?.rooms ?? 0, entries, total })
  }
  const mitte = `${month}-15`
  const summe = (bis: boolean): number =>
    days.filter(d => (d.date <= mitte) === bis).reduce((s, d) => s + d.total, 0)
  const halves: [Haelfte, Haelfte] = [
    { from, to: mitte, total: summe(true) },
    { from: addDays(mitte, 1), to, total: summe(false) }]
  return { month, from, to, closed: zu, days, totals, halves }
}

/**
 * Die Eintraege eines Zeitraums, einer Person oder aller (`userId` null).
 * Monat und Tagesansicht lesen hier, damit beide dieselbe Zeile zeigen.
 */
async function liesEintraege(
  client: PoolClient, propertyId: number, from: string, to: string, userId: number | null
): Promise<{ rows: Array<Eintrag & { userId: number }> }> {
  return client.query<Eintrag & { userId: number }>(
    `SELECT e.id::int, e.user_id::int AS "userId", e.business_date::text AS date, e.kind,
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
      WHERE e.property_id = $1 AND ($2::bigint IS NULL OR e.user_id = $2)
        AND e.business_date BETWEEN $3::date AND $4::date
      ORDER BY e.business_date, e.id`, [propertyId, userId, from, to])
}

interface ZimmerDesTags {
  taskId: number
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
 * Summen. Drei Abfragen fuer das ganze Haus. Es stehen nur Kraefte da, die
 * an diesem Tag etwas haben -- eine leere Karte je Kraft im Haus waere
 * Rauschen.
 */
async function liesTag(
  client: PoolClient, propertyId: number, date: string
): Promise<{ date: string; closed: boolean; staff: KraftDesTags[] }> {
  const zimmer = await client.query<ZimmerDesTags & { userId: number }>(
    `SELECT * FROM (
       SELECT t.id::int AS "taskId", t.assigned_to::int AS "userId",
              COALESCE(r.code, a.code) AS code, t.kind, COALESCE(t.minutes, 0) AS minutes,
              t.status, t.outcome
         FROM housekeeping_task t
         LEFT JOIN resource r ON r.id = t.resource_id
         LEFT JOIN cleaning_area a ON a.id = t.area_id
        WHERE t.property_id = $1 AND t.business_date = $2::date
          AND t.assigned_to IS NOT NULL) z
      ORDER BY NULLIF(substring(z.code from '^[0-9]+'), '')::numeric NULLS LAST, z.code`,
    [propertyId, date])
  const eintraege = await liesEintraege(client, propertyId, date, date, null)
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
    for (const z of rooms) {
      if (z.outcome !== 'cleaned') continue
      const art = z.kind === 'departure' ? 'departure'
        : z.kind === 'stayover' ? 'stayover' : 'otherRooms'
      totals[art] += z.minutes
      totals.total += z.minutes
    }
    for (const e of entries) {
      if (e.withdrawn) continue
      totals[e.kind] += e.minutes
      totals.total += e.minutes
    }
    return { ...n, rooms, entries, totals }
  })
  return { date, closed: await istAbgeschlossen(client, propertyId, date), staff }
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
 * Wer in diesem Haus Arbeitszeit haben kann: Reinigung und Kueche -- bei
 * gemeinsamem Personal (0116) die des ganzen Betriebs --, dazu jeder, der
 * im Monat Minuten hat. Ein Name aus einem fremden Haus kommt so
 * nicht in die Liste -- die Benutzertabelle hat keine Zeilenrichtlinie.
 */
async function liesKraefte(
  client: PoolClient, propertyId: number, from: string, to: string
): Promise<Array<{ userId: number; name: string; username: string | null }>> {
  const { rows } = await client.query<{ userId: number; name: string; username: string | null }>(
    `SELECT u.id::int AS "userId", u.display_name AS name, u.username
       FROM app_user u
      WHERE u.id IN (
              SELECT upr.user_id FROM user_property_role upr
                JOIN role ro ON ro.id = upr.role_id
               WHERE upr.property_id = ANY (staff_houses($1))
                 AND ro.key IN ('housekeeping_staff','kitchen')
              UNION
              SELECT assigned_to FROM housekeeping_task
               WHERE property_id = $1 AND outcome = 'cleaned' AND assigned_to IS NOT NULL
                 AND business_date BETWEEN $2::date AND $3::date
              UNION
              SELECT user_id FROM staff_work_entry
               WHERE property_id = $1 AND business_date BETWEEN $2::date AND $3::date)
      ORDER BY u.display_name`, [propertyId, from, to])
  return rows
}

interface TagesSumme {
  rooms: number; roomMinutes: number; extra: number; kitchen: number
  correction: number; total: number
}

/**
 * Alle Kraefte eines Monats mit ihren Tagessummen nach Art -- vier
 * Abfragen fuer das ganze Haus, nicht vier je Kraft. Die Uebersicht und
 * die Ausgabe lesen beide hier.
 */
async function sammle(client: PoolClient, propertyId: number, month: string) {
  const { from, to } = monthRange(month)
  const kraefte = await liesKraefte(client, propertyId, from, to)
  const zimmer = await client.query<{ userId: number; date: string; minutes: number
                                      rooms: number }>(
    `SELECT assigned_to::int AS "userId", business_date::text AS date,
            COALESCE(sum(minutes), 0)::int AS minutes, count(*)::int AS rooms
       FROM housekeeping_task
      WHERE property_id = $1 AND outcome = 'cleaned' AND assigned_to IS NOT NULL
        AND business_date BETWEEN $2::date AND $3::date
      GROUP BY 1, 2`, [propertyId, from, to])
  const eintraege = await client.query<{ userId: number; date: string; kind: Art; minutes: number }>(
    `SELECT user_id::int AS "userId", business_date::text AS date, kind,
            sum(minutes)::int AS minutes
       FROM staff_work_entry
      WHERE property_id = $1 AND withdrawn_at IS NULL
        AND business_date BETWEEN $2::date AND $3::date
      GROUP BY 1, 2, 3`, [propertyId, from, to])
  const abschluss = await client.query<{ closedAt: string; closedBy: string | null }>(
    `SELECT c.closed_at AS "closedAt", u.display_name AS "closedBy"
       FROM staff_month_close c LEFT JOIN app_user u ON u.id = c.closed_by
      WHERE c.property_id = $1 AND c.month = $2::date AND c.reopened_at IS NULL`,
    [propertyId, from])

  const leer = (): TagesSumme =>
    ({ rooms: 0, roomMinutes: 0, extra: 0, kitchen: 0, correction: 0, total: 0 })
  const jeKraft = new Map<number, Map<string, TagesSumme>>(kraefte.map(k => [k.userId, new Map()]))
  const tag = (userId: number, date: string): TagesSumme | undefined => {
    const m = jeKraft.get(userId)
    if (m === undefined) return undefined
    let t = m.get(date)
    if (t === undefined) { t = leer(); m.set(date, t) }
    return t
  }
  for (const z of zimmer.rows) {
    const t = tag(z.userId, z.date)
    if (t === undefined) continue
    t.rooms += z.rooms; t.roomMinutes += z.minutes; t.total += z.minutes
  }
  for (const e of eintraege.rows) {
    const t = tag(e.userId, e.date)
    if (t === undefined) continue
    t[e.kind] += e.minutes; t.total += e.minutes
  }
  return {
    month, from, to, closed: abschluss.rows[0] ?? null,
    staff: kraefte.map(k => {
      const tage = [...jeKraft.get(k.userId)!.entries()].sort(([a], [b]) => a.localeCompare(b))
      const totals = { rooms: 0, extra: 0, kitchen: 0, correction: 0, total: 0 }
      for (const [, t] of tage) {
        totals.rooms += t.roomMinutes; totals.extra += t.extra; totals.kitchen += t.kitchen
        totals.correction += t.correction; totals.total += t.total
      }
      return { ...k, tage, totals }
    })
  }
}

/**
 * Die Uebersicht: je Kraft die Summe je Tag und die Summen nach Art, dazu
 * die Monatssumme in den anderen Haeusern (`elsewhere`), die die Leitung
 * ebenfalls fuehrt.
 */
async function liesUebersicht(
  client: PoolClient, propertyId: number, month: string, andere: number[]
) {
  const s = await sammle(client, propertyId, month)
  const anderswo = await summeAnderswo(client, andere, s.staff.map(k => k.userId), s.from, s.to)
  return {
    month: s.month, from: s.from, to: s.to, closed: s.closed,
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
 * Haeuser, in denen sie selbst `worktime:manage` hat, die Kraft nur ihre
 * eigenen. Zwei Abfragen fuer alle Personen, nicht zwei je Person.
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

/** Gehoert die Person zu diesem Haus? Sonst ist sie fuer die Leitung 404. */
async function kraftImHaus(
  client: PoolClient, propertyId: number, userId: number, month: string
): Promise<void> {
  const { from, to } = monthRange(month)
  const { rows } = await client.query<{ ja: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM user_property_role
                     WHERE property_id = ANY (staff_houses($1)) AND user_id = $2)
         OR EXISTS (SELECT 1 FROM housekeeping_task
                     WHERE property_id = $1 AND assigned_to = $2
                       AND business_date BETWEEN $3::date AND $4::date)
         OR EXISTS (SELECT 1 FROM staff_work_entry
                     WHERE property_id = $1 AND user_id = $2) AS ja`,
    [propertyId, userId, from, to])
  if (!rows[0]!.ja) throw Errors.notFound('res.user')
}

/** Text, der in einer Tabellenkalkulation nicht als Formel startet. */
const zelle = (s: string): string => /^[=+\-@]/.test(s) ? `'${s}` : s
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
      const andere = andereMit(req.principal as Principal, propertyId, 'staff:app')
      return tx(req.pool, req, async client => {
        const month = await monatOderOffen(client, propertyId, q.month)
        const heute = await tagOderOffen(client, propertyId, undefined)
        const monat = await liesMonat(client, propertyId, ich, month)
        // Was dieselbe Kraft im selben Monat in ihren anderen Haeusern hat --
        // auf dem Telefon soll die Summe stehen, nach der abgerechnet wird.
        const anderswo = await summeAnderswo(client, andere, [ich], monat.from, monat.to)
        return { ...monat, today: heute, otherHouses: anderswo.get(ich) ?? [] }
      })
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
        const heute = await tagOderOffen(client, propertyId, undefined)
        return { ...(await liesMonat(client, propertyId, ich, tag.slice(0, 7))), today: heute }
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
        const heute = await tagOderOffen(client, propertyId, undefined)
        return { ...(await liesMonat(client, propertyId, ich, alt.date.slice(0, 7))), today: heute }
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
        const heute = await tagOderOffen(client, propertyId, undefined)
        return { ...(await liesMonat(client, propertyId, ich, alt.date.slice(0, 7))), today: heute }
      })
    }
  })

  // ------------------------------------------------------------ die Leitung

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit aller Kraefte eines Monats',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { month?: string }
      const andere = andereMit(req.principal as Principal, propertyId, 'worktime:manage')
      return tx(req.pool, req, async client =>
        liesUebersicht(client, propertyId, await monatOderOffen(client, propertyId, q.month),
          andere))
    }
  })

  /**
   * Die Abrechnung fuer die Zeitarbeitsfirma: eine Zeile je Kraft und Tag
   * mit Minuten, dazu eine Summe je Kraft. Nur fuer einen abgeschlossenen
   * Monat -- eine Abrechnung, die sich danach noch aendern kann, ist keine.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime/export',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit eines abgeschlossenen Monats als CSV',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { month?: string }
      if (!isMonth(q.month)) throw Errors.validation({ month: ['field.isoMonth'] })
      const month = q.month
      return tx(req.pool, req, async client => {
        const u = await sammle(client, propertyId, month)
        if (u.closed === null) throw Errors.conflict('worktime.notClosed', { month })
        // Deutsche Ueberschriften, Semikolon, Komma: der Empfaenger ist die
        // Lohnbuchhaltung der Zeitarbeitsfirma mit einer Tabellenkalkulation.
        const kopf = ['Mitarbeiter', 'Benutzername', 'Datum', 'Zimmer', 'Zimmer Minuten',
                      'Zusatzarbeit Minuten', 'Kueche Minuten', 'Korrektur Minuten',
                      'Summe Minuten', 'Summe Stunden']
        const zeilen: Array<Array<string | number | null>> = []
        for (const k of u.staff) {
          if (k.tage.length === 0) continue
          const name = zelle(k.name)
          const login = k.username === null ? null : zelle(k.username)
          for (const [d, t] of k.tage) {
            zeilen.push([name, login, d, t.rooms, t.roomMinutes, t.extra, t.kitchen,
                         t.correction, t.total, stunden(t.total)])
          }
          zeilen.push([name, login, 'Summe', null, k.totals.rooms, k.totals.extra,
                       k.totals.kitchen, k.totals.correction, k.totals.total,
                       stunden(k.totals.total)])
        }
        reply.header('content-type', 'text/csv; charset=utf-8')
        reply.header('content-disposition', `attachment; filename="arbeitszeit-${month}.csv"`)
        // Mit Byte-Order-Mark: sonst liest Excel die Umlaute der Namen falsch.
        return '﻿' + csv([kopf, ...zeilen])
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
    summary: 'Arbeitszeit aller Kraefte an einem Tag, mit Zimmern und Zusatzarbeiten',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { date?: string }
      if (q.date !== undefined && !isIsoDate(q.date)) {
        throw Errors.validation({ date: ['field.isoDate'] })
      }
      return tx(req.pool, req, async client =>
        liesTag(client, propertyId, q.date ?? await tagOderOffen(client, propertyId, undefined)))
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
        return liesTag(client, propertyId, e.date)
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
        return liesTag(client, propertyId, e.date)
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/worktime/:userId',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Arbeitszeit einer Kraft eines Monats, Tag fuer Tag',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const userId = Number((req.params as { userId: string }).userId)
      if (!Number.isInteger(userId) || userId <= 0) throw Errors.notFound('res.user')
      const q = req.query as { month?: string }
      return tx(req.pool, req, async client => {
        const month = await monatOderOffen(client, propertyId, q.month)
        await kraftImHaus(client, propertyId, userId, month)
        return liesMonat(client, propertyId, userId, month)
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
        await kraftImHaus(client, propertyId, userId, date.slice(0, 7))
        await monatOffen(client, propertyId, date)
        await client.query(
          `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind,
                                         description, minutes, created_by)
           VALUES ($1, $2, $3::date, 'correction', $4, $5, $6)`,
          [propertyId, userId, date, grund, b.minutes, principal.userId])
        reply.code(201)
        return liesMonat(client, propertyId, userId, date.slice(0, 7))
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
        return liesMonat(client, propertyId, e.user_id, e.date.slice(0, 7))
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/worktime/close',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Monat der Arbeitszeit abschliessen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const month = (req.body as { month?: unknown } | null)?.month
      if (!isMonth(month)) throw Errors.validation({ month: ['field.isoMonth'] })
      return tx(req.pool, req, async client => {
        // Ein Monat, der noch laeuft, ist nicht abzuschliessen: morgen kaeme
        // eine Reinigung dazu, die nirgends mehr hin darf.
        const heute = await tagOderOffen(client, propertyId, undefined)
        if (monthRange(month).to >= heute) {
          throw Errors.conflict('worktime.monthRunning', { month })
        }
        await client.query(
          `INSERT INTO staff_month_close (property_id, month, closed_by)
           VALUES ($1, $2::date, $3)
           ON CONFLICT (property_id, month) WHERE reopened_at IS NULL DO NOTHING`,
          [propertyId, `${month}-01`, principal.userId])
        return liesUebersicht(client, propertyId, month,
          andereMit(principal, propertyId, 'worktime:manage'))
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/worktime/reopen',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Abgeschlossenen Monat mit Grund wieder oeffnen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const b = (req.body ?? {}) as { month?: unknown; reason?: unknown }
      if (!isMonth(b.month)) throw Errors.validation({ month: ['field.isoMonth'] })
      const grund = typeof b.reason === 'string' ? b.reason.trim() : ''
      if (grund === '') throw Errors.validation({ reason: ['worktime.reasonRequired'] })
      if (grund.length > BESCHREIBUNG_MAX) {
        throw Errors.validation({ reason: ['field.maxLength'] }, { max: BESCHREIBUNG_MAX })
      }
      const month = b.month
      return tx(req.pool, req, async client => {
        const { rowCount } = await client.query(
          `UPDATE staff_month_close
              SET reopened_by = $3, reopened_at = now(), reopen_reason = $4
            WHERE property_id = $1 AND month = $2::date AND reopened_at IS NULL`,
          [propertyId, `${month}-01`, principal.userId, grund])
        if (rowCount === 0) throw Errors.conflict('worktime.notClosed', { month })
        return liesUebersicht(client, propertyId, month,
          andereMit(principal, propertyId, 'worktime:manage'))
      })
    }
  })
}
