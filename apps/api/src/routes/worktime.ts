import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { addDays, isClockTime, isIsoDate, isMonth, minutesBetween, monthRange }
  from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import { tagOderOffen } from './cleaningPlan.js'
import { csv } from './reports.js'

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
}

interface Tag {
  date: string
  /** Minuten der gereinigten Zimmer und ihre Zahl. */
  roomMinutes: number
  rooms: number
  entries: Eintrag[]
  total: number
}

interface Monat {
  month: string
  from: string
  to: string
  closed: boolean
  days: Tag[]
  totals: { rooms: number; extra: number; kitchen: number; correction: number; total: number }
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
  const eintraege = await client.query<Eintrag>(
    `SELECT e.id::int, e.business_date::text AS date, e.kind, e.description, e.minutes,
            to_char(e.start_time, 'HH24:MI') AS start, to_char(e.end_time, 'HH24:MI') AS "end",
            e.source, u.display_name AS "createdBy", e.created_at AS "createdAt",
            (e.withdrawn_at IS NOT NULL) AS withdrawn
       FROM staff_work_entry e
       LEFT JOIN app_user u ON u.id = e.created_by
      WHERE e.property_id = $1 AND e.user_id = $2
        AND e.business_date BETWEEN $3::date AND $4::date
      ORDER BY e.business_date, e.id`, [propertyId, userId, from, to])
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
  return { month, from, to, closed: zu, days, totals }
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
): Promise<{ date: string; kind: Art }> {
  const { rows } = await client.query<{ date: string; kind: Art }>(
    `SELECT business_date::text AS date, kind FROM staff_work_entry
      WHERE id = $1 AND property_id = $2 AND user_id = $3 AND withdrawn_at IS NULL
        AND kind <> 'correction'
      FOR UPDATE`, [id, propertyId, userId])
  const e = rows[0]
  if (e === undefined) throw Errors.notFound('res.workEntry')
  await eigenerTag(client, propertyId, e.date)
  return e
}

function idAusPfad(req: FastifyRequest, name: string): number {
  const v = Number((req.params as Record<string, string>)[name])
  if (!Number.isInteger(v) || v <= 0) throw Errors.notFound('res.workEntry')
  return v
}

/**
 * Wer in diesem Haus Arbeitszeit haben kann: Reinigung und Kueche, dazu
 * jeder, der im Monat Minuten hat. Ein Name aus einem fremden Haus kommt so
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
               WHERE upr.property_id = $1 AND ro.key IN ('housekeeping_staff','kitchen')
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

/** Die Uebersicht: je Kraft die Summe je Tag und die Summen nach Art. */
async function liesUebersicht(client: PoolClient, propertyId: number, month: string) {
  const s = await sammle(client, propertyId, month)
  return {
    month: s.month, from: s.from, to: s.to, closed: s.closed,
    staff: s.staff.map(({ tage, ...k }) => ({
      ...k, days: Object.fromEntries(tage.map(([d, t]) => [d, t.total]))
    }))
  }
}

/** Gehoert die Person zu diesem Haus? Sonst ist sie fuer die Leitung 404. */
async function kraftImHaus(
  client: PoolClient, propertyId: number, userId: number, month: string
): Promise<void> {
  const { from, to } = monthRange(month)
  const { rows } = await client.query<{ ja: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM user_property_role
                     WHERE property_id = $1 AND user_id = $2)
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
      return tx(req.pool, req, async client => {
        const month = await monatOderOffen(client, propertyId, q.month)
        const heute = await tagOderOffen(client, propertyId, undefined)
        return { ...(await liesMonat(client, propertyId, ich, month)), today: heute }
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
        await client.query(
          `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind,
                                         description, minutes, start_time, end_time, created_by)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7::time, $8::time, $2)`,
          [propertyId, ich, tag, e.kind, e.description, e.minutes, e.start, e.end])
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
      return tx(req.pool, req, async client =>
        liesUebersicht(client, propertyId, await monatOderOffen(client, propertyId, q.month)))
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
        return liesUebersicht(client, propertyId, month)
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
        return liesUebersicht(client, propertyId, month)
      })
    }
  })
}
