import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { addDays, isIsoDate, nightsBetween } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { emitEvent } from '../platform/events.js'
import { can, type Principal } from '../platform/context.js'
import { isTrainingProperty } from '../platform/training.js'

/*
 * Preise an den Channel Manager senden, auf Knopfdruck (Migration 0179).
 *
 * **Nie automatisch.** Sven, 18.10.2026: "damit nichts ausversehen gepusht
 * wird". Ein Preis, der einmal bei Booking.com steht, wird gebucht, bevor
 * jemand den Tippfehler sieht. Deshalb gibt es kein Ereignis, das bei jeder
 * Preisaenderung zum Senden fuehrt, sondern nur den Knopf -- drei davon,
 * wie in RoomCloud: nur Aenderungen, der gewaehlte Zeitraum, der ganze
 * Kalender.
 *
 * **StayGrid sagt, was hinausgeht; das Umsystem uebersetzt.** Das Adminpanel
 * holt die Werte je Plancode an `GET /v1/rate-calendar-pushes/:pushRef`
 * und bildet sie auf RoomCloud-Zimmertyp und -Rate ab. Was eine Aenderung
 * ist, entscheidet StayGrid am Vergleich mit dem zuletzt gesendeten Stand
 * (`rate_calendar_sent`, Migration 0180), nicht an Zeitstempeln: ein Preis,
 * der hin und wieder zurueck geaendert wurde, ist keine Aenderung -- beim
 * Channel Manager steht er schon so.
 */

/** Wie das Preisraster und ARI: ein Jahr und etwas Rand. */
const MAX_DAYS = 400
const MODI = ['changes', 'range', 'all'] as const
type Modus = (typeof MODI)[number]

interface Senden {
  id: number
  property_id: number
  public_ref: string
  mode: Modus
  date_from: string
  date_to: string
  changed_since: string | null
  status: string
  days: number | null
  message: string | null
  requested_at: string
  served_at: string | null
  finished_at: string | null
}

const SPALTEN = `id, property_id, public_ref, mode, date_from::text, date_to::text, changed_since,
                 status, days, message, requested_at, served_at, finished_at`

function antwort(s: Senden) {
  return {
    pushRef: s.public_ref, mode: s.mode, status: s.status, from: s.date_from, to: s.date_to,
    changedSince: s.changed_since, days: s.days, message: s.message,
    requestedAt: s.requested_at, servedAt: s.served_at, finishedAt: s.finished_at
  }
}

/** Der Tag, an dem das Haus gerade ist; die Vergangenheit verkauft niemand mehr. */
async function heute(client: PoolClient, propertyId: number): Promise<string> {
  const { rows } = await client.query<{ d: string }>(
    `SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM property WHERE id = $1`,
    [propertyId])
  return rows[0]!.d
}

/** Abholzeitpunkt des letzten erfolgreichen Sendens, die Grenze fuer "nur Aenderungen". */
async function letzteGrenze(client: PoolClient, propertyId: number): Promise<string | null> {
  const { rows } = await client.query<{ served_at: string }>(
    `SELECT served_at FROM rate_calendar_push
      WHERE property_id = $1 AND status = 'done' AND served_at IS NOT NULL
      ORDER BY served_at DESC LIMIT 1`, [propertyId])
  return rows[0]?.served_at ?? null
}

/**
 * Weicht der Tag vom gesendeten Stand ab? Preis und Restriktionen getrennt,
 * weil das Raster sie in getrennten Zeilen markiert. Ein Tag ohne gesendeten
 * Stand weicht ab: dort steht beim Channel Manager etwas, das nicht von hier
 * kam. Erwartet `rd`, `rs` und `s` wie in `TAGE_SQL`.
 */
export const PREIS_OFFEN = `(s.rate_plan_id IS NULL OR rd.price_cent IS DISTINCT FROM s.price_cent)`
export const RESTRIKTION_OFFEN = `(s.rate_plan_id IS NULL
  OR (rs.min_los, rs.max_los, COALESCE(rs.closed, false), COALESCE(rs.closed_to_arrival, false),
      COALESCE(rs.closed_to_departure, false))
     IS DISTINCT FROM
     (s.min_los, s.max_los, s.closed, s.closed_to_arrival, s.closed_to_departure))`

/**
 * Die Tage, die hinausgehen: je aktivem Plan und Tag, bei "nur Aenderungen"
 * nur, wo Preis oder Restriktion vom gesendeten Stand abweicht.
 * Abgeleitete Plaene gehen mit -- drueben sind sie eine Rate wie jede.
 */
const TAGE_SQL = `
  SELECT rp.id AS "ratePlanId", rp.code AS "ratePlanCode", rc.code AS "categoryCode",
         d.day::date::text AS date,
         rd.price_cent AS "priceCent",
         rs.min_los AS "minLos", rs.max_los AS "maxLos",
         COALESCE(rs.closed, false) AS closed,
         COALESCE(rs.closed_to_arrival, false) AS "closedToArrival",
         COALESCE(rs.closed_to_departure, false) AS "closedToDeparture"
    FROM rate_plan rp
    JOIN resource_category rc ON rc.id = rp.category_id
   CROSS JOIN generate_series($2::date, $3::date, interval '1 day') AS d(day)
    LEFT JOIN rate_day rd ON rd.rate_plan_id = rp.id AND rd.date = d.day::date
    LEFT JOIN restriction_day rs ON rs.rate_plan_id = rp.id AND rs.date = d.day::date
    LEFT JOIN rate_calendar_sent s ON s.rate_plan_id = rp.id AND s.date = d.day::date
   WHERE rp.property_id = $1 AND rp.active
     AND (NOT $4::boolean OR ${PREIS_OFFEN} OR ${RESTRIKTION_OFFEN})`

/** Eine abgeholte Zeile, wie sie in `served` bis zur Rueckmeldung liegt. */
interface Tag {
  ratePlanId: number; ratePlanCode: string; categoryCode: string; date: string
  priceCent: number[] | null; minLos: number | null; maxLos: number | null; closed: boolean
  closedToArrival: boolean; closedToDeparture: boolean
}

export function rateCalendarPushRoutes(app: FastifyInstance): void {
  /**
   * Stand fuer den Bildschirm: das letzte Senden und wie viele Tage seit dem
   * letzten erfolgreichen geaendert sind. Eine Anfrage, zwei Abfragen.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-calendar-pushes/current',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Stand des Sendens an den Channel Manager',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<Senden>(
          `SELECT ${SPALTEN} FROM rate_calendar_push WHERE property_id = $1
            ORDER BY requested_at DESC, id DESC LIMIT 1`, [propertyId])
        const grenze = await letzteGrenze(client, propertyId)
        let offen: number | null = null
        if (grenze !== null) {
          const von = await heute(client, propertyId)
          const z = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM (${TAGE_SQL}) t`,
            [propertyId, von, addDays(von, MAX_DAYS - 1), true])
          offen = z.rows[0]!.n
        }
        return { push: rows[0] === undefined ? null : antwort(rows[0]),
                 lastSentAt: grenze, pendingChanges: offen }
      })
    }
  })

  /**
   * Der Knopf. Ein Uebungshaus sendet nicht: ein Uebungspreis bei Booking.com
   * wird gebucht.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-calendar-pushes',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Preise an den Channel Manager senden',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const body = (req.body ?? {}) as { mode?: unknown; from?: unknown; to?: unknown }
      if (!MODI.includes(body.mode as Modus)) throw Errors.validation({ mode: ['field.invalid'] })
      const mode = body.mode as Modus
      const principal = req.principal as Principal

      const ergebnis = await tx(req.pool, req, async client => {
        if (await isTrainingProperty(client, propertyId)) {
          throw Errors.unprocessable('training.noChannel')
        }
        let from: string
        let to: string
        let seit: string | null = null
        if (mode === 'range') {
          if (typeof body.from !== 'string' || !isIsoDate(body.from)) {
            throw Errors.validation({ from: ['field.isoDate'] })
          }
          if (typeof body.to !== 'string' || !isIsoDate(body.to)) {
            throw Errors.validation({ to: ['field.isoDate'] })
          }
          const tage = nightsBetween(body.from, body.to) + 1
          if (tage <= 0) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
          if (tage > MAX_DAYS) throw Errors.rangeTooLarge(MAX_DAYS)
          from = body.from
          to = body.to
        } else {
          from = await heute(client, propertyId)
          to = addDays(from, MAX_DAYS - 1)
          if (mode === 'changes') {
            seit = await letzteGrenze(client, propertyId)
            // Ohne ein Senden davor gibt es keine Aenderungen, nur einen
            // Kalender. Still ein ganzes Jahr zu schicken waere genau das
            // Versehen, gegen das der Knopf steht.
            if (seit === null) throw Errors.conflict('rateCalendar.noBaseline')
          }
        }

        await client.query(
          `UPDATE rate_calendar_push SET status = 'superseded'
            WHERE property_id = $1 AND status = 'requested'`, [propertyId])
        const neu = await client.query<Senden>(
          `INSERT INTO rate_calendar_push (property_id, mode, date_from, date_to, changed_since,
                                           requested_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SPALTEN}`,
          [propertyId, mode, from, to, seit, principal.userId])
        const s = neu.rows[0]!
        const empfaenger = await emitEvent(client, propertyId, 'rate.calendar_push_requested',
          { pushRef: s.public_ref, propertyId, mode, from, to })
        if (empfaenger === 0) {
          throw Errors.conflict('rateCalendar.noReceiver', { event: 'rate.calendar_push_requested' })
        }
        return antwort(s)
      })
      reply.code(201)
      return ergebnis
    }
  })

  /**
   * Die Werte zum Auftrag, fuer das Umsystem. Wiederholbar, solange keine
   * Rueckmeldung kam; jedes Abholen setzt die Grenze fuer das naechste
   * "nur Aenderungen" neu, denn genau dieser Stand geht hinaus.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/rate-calendar-pushes/:pushRef',
    permission: 'rate:channel_sync',
    summary: 'Werte eines Sendeauftrags abholen',
    handler: async (req) => {
      const { pushRef } = req.params as { pushRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const a = await client.query<Senden>(
          `SELECT ${SPALTEN} FROM rate_calendar_push WHERE public_ref = $1 FOR UPDATE`, [pushRef])
        const s = a.rows[0]
        if (s === undefined) throw Errors.notFound('res.rateCalendarPush')
        if (!can(principal, 'rate:channel_sync', Number(s.property_id))) {
          throw Errors.forbidden('access.missingPermission', { permission: 'rate:channel_sync' })
        }
        if (s.status !== 'requested') throw Errors.conflict('rateCalendar.closed')

        // Erst die Grenze, dann die Werte: eine Aenderung in derselben
        // Millisekunde geht im Zweifel zweimal hinaus, nie keinmal. Die
        // Werte bleiben bis zur Rueckmeldung liegen; erst "gesendet" macht
        // sie zum gesendeten Stand.
        const { rows } = await client.query<Tag>(
          `${TAGE_SQL} ORDER BY rp.code, d.day`,
          [s.property_id, s.date_from, s.date_to, s.mode === 'changes'])
        const z = await client.query<{ t: string }>(
          `UPDATE rate_calendar_push SET served_at = clock_timestamp(), days = $2, served = $3::jsonb
            WHERE id = $1 RETURNING served_at AS t`, [s.id, rows.length, JSON.stringify(rows)])

        const plans = new Map<string, { ratePlanCode: string; categoryCode: string
                                        days: Array<Record<string, unknown>> }>()
        for (const r of rows) {
          let p = plans.get(r.ratePlanCode)
          if (p === undefined) {
            p = { ratePlanCode: r.ratePlanCode, categoryCode: r.categoryCode, days: [] }
            plans.set(r.ratePlanCode, p)
          }
          p.days.push({ date: r.date, priceCent: r.priceCent, minLos: r.minLos,
                        maxLos: r.maxLos, closed: r.closed,
                        closedToArrival: r.closedToArrival,
                        closedToDeparture: r.closedToDeparture })
        }
        return { pushRef: s.public_ref, mode: s.mode, from: s.date_from, to: s.date_to,
                 servedAt: z.rows[0]!.t, plans: [...plans.values()] }
      })
    }
  })

  /** Die Rueckmeldung des Umsystems: gesendet oder gescheitert. */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/rate-calendar-pushes/:pushRef',
    permission: 'rate:channel_sync',
    summary: 'Ergebnis eines Sendeauftrags zurueckmelden',
    handler: async (req) => {
      const { pushRef } = req.params as { pushRef: string }
      const body = (req.body ?? {}) as { status?: unknown; message?: unknown }
      if (body.status !== 'done' && body.status !== 'failed') {
        throw Errors.validation({ status: ['field.invalid'] })
      }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const a = await client.query<Senden>(
          `SELECT ${SPALTEN} FROM rate_calendar_push WHERE public_ref = $1 FOR UPDATE`, [pushRef])
        const s = a.rows[0]
        if (s === undefined) throw Errors.notFound('res.rateCalendarPush')
        if (!can(principal, 'rate:channel_sync', Number(s.property_id))) {
          throw Errors.forbidden('access.missingPermission', { permission: 'rate:channel_sync' })
        }
        if (s.status !== 'requested') throw Errors.conflict('rateCalendar.closed')
        // "Gesendet" ohne Abholen hiesse: drueben steht nichts von hier,
        // und die Grenze fuer "nur Aenderungen" laege im Leeren.
        if (body.status === 'done' && s.served_at === null) {
          throw Errors.conflict('rateCalendar.notServed')
        }
        const m = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : ''
        if (body.status === 'done') {
          // Gesendet ist, was abgeholt wurde -- nicht, was jetzt im Raster
          // steht. Ein Plan, der seitdem geloescht wurde, faellt heraus.
          await client.query(
            `INSERT INTO rate_calendar_sent (property_id, rate_plan_id, date, price_cent, min_los,
                                             max_los, closed, closed_to_arrival,
                                             closed_to_departure, sent_at)
             SELECT p.property_id, t."ratePlanId", t.date, t."priceCent", t."minLos", t."maxLos",
                    t.closed, t."closedToArrival", t."closedToDeparture", p.served_at
               FROM rate_calendar_push p,
                    jsonb_to_recordset(p.served) AS t("ratePlanId" bigint, date date,
                      "priceCent" bigint[], "minLos" smallint, "maxLos" smallint,
                      closed boolean, "closedToArrival" boolean, "closedToDeparture" boolean)
               JOIN rate_plan rp ON rp.id = t."ratePlanId"
              WHERE p.id = $1
             ON CONFLICT (rate_plan_id, date) DO UPDATE SET
               price_cent = EXCLUDED.price_cent, min_los = EXCLUDED.min_los,
               max_los = EXCLUDED.max_los, closed = EXCLUDED.closed,
               closed_to_arrival = EXCLUDED.closed_to_arrival,
               closed_to_departure = EXCLUDED.closed_to_departure, sent_at = EXCLUDED.sent_at`,
            [s.id])
        }
        const r = await client.query<Senden>(
          `UPDATE rate_calendar_push SET status = $2, message = $3, finished_at = now(), served = NULL
            WHERE id = $1 RETURNING ${SPALTEN}`,
          [s.id, body.status, m === '' ? null : m])
        return antwort(r.rows[0]!)
      })
    }
  })
}
