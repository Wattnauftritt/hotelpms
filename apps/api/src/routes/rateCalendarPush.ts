import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { addDays, isIsoDate, nightsBetween } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
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
  checked_at: string | null
  conflicts: Konflikt[] | null
  resolved_at: string | null
}

const SPALTEN = `id, property_id, public_ref, mode, date_from::text, date_to::text, changed_since,
                 status, days, message, requested_at, served_at, finished_at,
                 checked_at, conflicts, resolved_at`

/** Preis und Restriktionen eines Tages, wie sie hinausgehen. */
interface Werte {
  priceCent: number[] | null; minLos: number | null; maxLos: number | null
  closed: boolean; closedToArrival: boolean; closedToDeparture: boolean
}

/**
 * Ein Tag, an dem der Channel Manager vom zuletzt abgeglichenen Stand
 * abweicht (Migration 0218). Drei Staende, weil die Entscheidung genau
 * zwischen ihnen faellt: was war, was hier steht, was drueben steht.
 * `channel` traegt nur, was das Umsystem geliefert hat.
 */
interface Konflikt {
  ratePlanId: number; ratePlanCode: string; date: string
  sent: Werte | null; local: Werte; channel: Partial<Werte>
}

const WERT_FELDER = ['priceCent', 'minLos', 'maxLos', 'closed', 'closedToArrival',
                     'closedToDeparture'] as const

function antwort(s: Senden) {
  return {
    pushRef: s.public_ref, mode: s.mode, status: s.status, from: s.date_from, to: s.date_to,
    changedSince: s.changed_since, days: s.days, message: s.message,
    requestedAt: s.requested_at, servedAt: s.served_at, finishedAt: s.finished_at,
    checkedAt: s.checked_at, resolvedAt: s.resolved_at,
    conflicts: s.status === 'conflict' && s.resolved_at === null ? s.conflicts ?? [] : null
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
 * weil das Raster sie in getrennten Zeilen markiert. Erwartet `rd`, `rs`
 * und `s` wie in `TAGE_SQL`.
 *
 * Ein Tag ohne gesendeten Stand weicht nur ab, wenn hier etwas steht: dort
 * steht beim Channel Manager etwas, das nicht von hier kam. Steht hier
 * nichts, gibt es nichts zu senden. Bis zum 22.10.2026 zaehlte auch der
 * leere Tag: das Fenster reicht 400 Tage ab heute, und jeden Morgen rueckte
 * je Plan ein leerer Tag hinten nach -- bei sieben Plaenen nach drei Tagen
 * "21 Aenderungen", die niemand gemacht hatte und keiner verwerfen konnte.
 */
export const PREIS_OFFEN = `(CASE WHEN s.rate_plan_id IS NULL THEN rd.price_cent IS NOT NULL
  ELSE rd.price_cent IS DISTINCT FROM s.price_cent END)`
export const RESTRIKTION_OFFEN = `(CASE WHEN s.rate_plan_id IS NULL
  THEN rs.min_los IS NOT NULL OR rs.max_los IS NOT NULL OR COALESCE(rs.closed, false)
       OR COALESCE(rs.closed_to_arrival, false) OR COALESCE(rs.closed_to_departure, false)
  ELSE (rs.min_los, rs.max_los, COALESCE(rs.closed, false), COALESCE(rs.closed_to_arrival, false),
        COALESCE(rs.closed_to_departure, false))
       IS DISTINCT FROM
       (s.min_los, s.max_los, s.closed, s.closed_to_arrival, s.closed_to_departure) END)`

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
         COALESCE(rs.closed_to_departure, false) AS "closedToDeparture",
         CASE WHEN s.rate_plan_id IS NOT NULL THEN jsonb_build_object(
           'priceCent', s.price_cent, 'minLos', s.min_los, 'maxLos', s.max_los,
           'closed', s.closed, 'closedToArrival', s.closed_to_arrival,
           'closedToDeparture', s.closed_to_departure) END AS sent
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
  /** Zuletzt beim Channel Manager, oder `null`: nie abgeglichen. */
  sent: Werte | null
}

/**
 * Einen Sendeauftrag anlegen und das Ereignis einreihen. Fuer den Knopf und
 * fuer "Entscheidung uebernehmen und senden" nach einer Gegenpruefung.
 */
async function anlegen(
  client: PoolClient, propertyId: number, mode: Modus, from: string, to: string,
  seit: string | null, userId: number | null
): Promise<Senden> {
  await client.query(
    `UPDATE rate_calendar_push SET status = 'superseded'
      WHERE property_id = $1 AND status = 'requested'`, [propertyId])
  const neu = await client.query<Senden>(
    `INSERT INTO rate_calendar_push (property_id, mode, date_from, date_to, changed_since,
                                     requested_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SPALTEN}`,
    [propertyId, mode, from, to, seit, userId])
  const s = neu.rows[0]!
  const empfaenger = await emitEvent(client, propertyId, 'rate.calendar_push_requested',
    { pushRef: s.public_ref, propertyId, mode, from, to })
  if (empfaenger === 0) {
    throw Errors.conflict('rateCalendar.noReceiver', { event: 'rate.calendar_push_requested' })
  }
  return s
}

const ganz = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * Die gemeldeten Abweichungen pruefen. Jeder Tag muss zu den abgeholten
 * gehoeren: eine Abweichung an einem Tag, der nicht hinausgehen sollte,
 * gibt es fuer dieses Senden nicht. Felder wie beim Abruf: fehlend oder
 * `null` heisst "nicht geliefert".
 */
function abweichungenPruefen(roh: unknown, served: Tag[]): Konflikt[] {
  if (!Array.isArray(roh) || roh.length > served.length) {
    throw Errors.validation({ conflicts: ['field.invalid'] })
  }
  const nachTag = new Map(served.map(t => [`${t.ratePlanCode}|${t.date}`, t]))
  const gesehen = new Set<string>()
  const fehler: Record<string, Meldung[]> = {}
  const aus: Konflikt[] = []
  roh.forEach((r: unknown, i) => {
    const k = (r ?? {}) as Record<string, unknown>
    const feld = (n: string): string => `conflicts.${i}.${n}`
    const schluessel = `${String(k.ratePlanCode)}|${String(k.date)}`
    const t = nachTag.get(schluessel)
    if (t === undefined || gesehen.has(schluessel)) {
      fehler[feld('date')] = ['field.invalid']
      return
    }
    gesehen.add(schluessel)
    const channel: Partial<Werte> = {}
    if (k.priceCent != null) {
      const p = k.priceCent
      if (!Array.isArray(p) || p.length === 0 || p.length > 10
          || !p.every(c => ganz(c, 0, 10_000_000))) {
        fehler[feld('priceCent')] = ['field.centAmount']
      } else {
        channel.priceCent = p as number[]
      }
    }
    for (const n of ['minLos', 'maxLos'] as const) {
      if (k[n] == null) continue
      if (!ganz(k[n], 1, 365)) fehler[feld(n)] = ['field.invalid']
      else channel[n] = k[n]
    }
    for (const n of ['closed', 'closedToArrival', 'closedToDeparture'] as const) {
      if (k[n] == null) continue
      if (typeof k[n] !== 'boolean') fehler[feld(n)] = ['field.invalid']
      else channel[n] = k[n]
    }
    const { ratePlanId, ratePlanCode, date, sent, ...local } = t
    aus.push({ ratePlanId: Number(ratePlanId), ratePlanCode, date, sent, local, channel })
  })
  if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)
  return aus
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
   * Welche Tage offen sind, je Plan und Tag. Die Zahl am Knopf allein sagt
   * nicht, woher sie kommt; hier steht es. Hoechstens tausend Zeilen -- wer
   * mehr offen hat, hat den ganzen Kalender geaendert und will ihn senden.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-calendar-pushes/pending',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Offene Aenderungen gegenueber dem gesendeten Stand',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        if (await letzteGrenze(client, propertyId) === null) return { total: 0, days: [] }
        const von = await heute(client, propertyId)
        const { rows } = await client.query<{
          ratePlanCode: string; ratePlanName: string; date: string; price: boolean
          restriction: boolean; neverSent: boolean; priceCent: number[] | null
          sentPriceCent: number[] | null; total: number }>(
          `SELECT rp.code AS "ratePlanCode", rp.name AS "ratePlanName",
                  d.day::date::text AS date,
                  ${PREIS_OFFEN} AS price, ${RESTRIKTION_OFFEN} AS restriction,
                  s.rate_plan_id IS NULL AS "neverSent",
                  rd.price_cent AS "priceCent", s.price_cent AS "sentPriceCent",
                  (count(*) OVER ())::int AS total
             FROM rate_plan rp
            CROSS JOIN generate_series($2::date, $3::date, interval '1 day') AS d(day)
             LEFT JOIN rate_day rd ON rd.rate_plan_id = rp.id AND rd.date = d.day::date
             LEFT JOIN restriction_day rs ON rs.rate_plan_id = rp.id AND rs.date = d.day::date
             LEFT JOIN rate_calendar_sent s ON s.rate_plan_id = rp.id AND s.date = d.day::date
            WHERE rp.property_id = $1 AND rp.active AND (${PREIS_OFFEN} OR ${RESTRIKTION_OFFEN})
            ORDER BY d.day, rp.code
            LIMIT 1000`,
          [propertyId, von, addDays(von, MAX_DAYS - 1)])
        return { total: rows[0]?.total ?? 0,
                 days: rows.map(({ total: _, ...r }) => r) }
      })
    }
  })

  /**
   * Offene Aenderungen verwerfen: Preise und Restriktionen gehen auf den
   * zuletzt gesendeten Stand zurueck. Hinaus geht dabei **nichts** -- der
   * Knopf ist fuer den Fall, dass im Channel Manager inzwischen andere
   * Preise stehen und das hier Getippte nicht mehr gelten soll.
   *
   * Zurueck geht nur, wofuer es einen gesendeten Wert gibt. Ein Tag, der nie
   * gesendet wurde, behaelt seinen Preis: welcher dort drueben steht, weiss
   * StayGrid nicht, und ihn zu loeschen hiesse, eine Buchung an dem Tag ohne
   * Preis zu lassen. Den fuellt ein Abruf. Abgeleitete Plaene rechnen sich
   * aus ihrer Basis neu; sie direkt zu setzen, ueberschriebe die naechste
   * Aenderung der Basis ohnehin.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-calendar-pushes/discard',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Offene Aenderungen auf den gesendeten Stand zuruecksetzen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        if (await letzteGrenze(client, propertyId) === null) {
          return { prices: 0, restrictions: 0, remaining: 0 }
        }
        const von = await heute(client, propertyId)
        const bis = addDays(von, MAX_DAYS - 1)

        const preise = await client.query<{ n: number | null }>(
          `SELECT rate_prices_write($1, array_agg(s.rate_plan_id), array_agg(s.date),
                                    array_agg(s.price_cent::text), 'manual') AS n
             FROM rate_calendar_sent s
             JOIN rate_plan rp ON rp.id = s.rate_plan_id AND rp.property_id = $1
                              AND rp.active AND rp.base_rate_plan_id IS NULL
             LEFT JOIN rate_day rd ON rd.rate_plan_id = s.rate_plan_id AND rd.date = s.date
            WHERE s.date BETWEEN $2::date AND $3::date
              AND s.price_cent IS NOT NULL
              AND rd.price_cent IS DISTINCT FROM s.price_cent`,
          [propertyId, von, bis])

        const restriktionen = await client.query(
          `INSERT INTO restriction_day (property_id, rate_plan_id, date, min_los, max_los,
                                        closed, closed_to_arrival, closed_to_departure)
           SELECT $1, s.rate_plan_id, s.date, s.min_los, s.max_los,
                  s.closed, s.closed_to_arrival, s.closed_to_departure
             FROM rate_calendar_sent s
             JOIN rate_plan rp ON rp.id = s.rate_plan_id AND rp.property_id = $1 AND rp.active
             LEFT JOIN restriction_day rs ON rs.rate_plan_id = s.rate_plan_id AND rs.date = s.date
            WHERE s.date BETWEEN $2::date AND $3::date
              AND (rs.min_los, rs.max_los, COALESCE(rs.closed, false),
                   COALESCE(rs.closed_to_arrival, false), COALESCE(rs.closed_to_departure, false))
                  IS DISTINCT FROM
                  (s.min_los, s.max_los, s.closed, s.closed_to_arrival, s.closed_to_departure)
           ON CONFLICT (rate_plan_id, date) DO UPDATE SET
             min_los = EXCLUDED.min_los, max_los = EXCLUDED.max_los,
             closed = EXCLUDED.closed,
             closed_to_arrival = EXCLUDED.closed_to_arrival,
             closed_to_departure = EXCLUDED.closed_to_departure,
             updated_at = now()`,
          [propertyId, von, bis])

        const rest = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (${TAGE_SQL}) t`, [propertyId, von, bis, true])
        return { prices: preise.rows[0]!.n ?? 0, restrictions: restriktionen.rowCount ?? 0,
                 remaining: rest.rows[0]!.n }
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

        const s = await anlegen(client, propertyId, mode, from, to, seit, principal.userId)
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
                        closedToDeparture: r.closedToDeparture, sent: r.sent })
        }
        return { pushRef: s.public_ref, mode: s.mode, from: s.date_from, to: s.date_to,
                 servedAt: z.rows[0]!.t, plans: [...plans.values()] }
      })
    }
  })

  /**
   * Die Rueckmeldung des Umsystems: gesendet oder gescheitert, und vorher
   * wahlweise das Ergebnis der Gegenpruefung (Migration 0218).
   *
   * `checked` ohne Abweichung laesst den Auftrag offen, das Umsystem sendet
   * und meldet danach `done`. Mit Abweichungen wird **nicht** gesendet: der
   * Auftrag steht auf `conflict`, und die Antwort sagt es (`proceed: false`).
   * Ein Umsystem, das nicht prueft, meldet wie bisher nur `done`.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/rate-calendar-pushes/:pushRef',
    permission: 'rate:channel_sync',
    summary: 'Ergebnis eines Sendeauftrags zurueckmelden',
    handler: async (req) => {
      const { pushRef } = req.params as { pushRef: string }
      const body = (req.body ?? {}) as { status?: unknown; message?: unknown; conflicts?: unknown }
      if (body.status !== 'done' && body.status !== 'failed' && body.status !== 'checked') {
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
        if ((body.status === 'done' || body.status === 'checked') && s.served_at === null) {
          throw Errors.conflict('rateCalendar.notServed')
        }
        if (body.status === 'checked') {
          const { rows: [roh] } = await client.query<{ served: Tag[] }>(
            `SELECT served FROM rate_calendar_push WHERE id = $1`, [s.id])
          const konflikte = abweichungenPruefen(body.conflicts, roh?.served ?? [])
          const r = konflikte.length === 0
            ? await client.query<Senden>(
              `UPDATE rate_calendar_push SET checked_at = now() WHERE id = $1
               RETURNING ${SPALTEN}`, [s.id])
            // Nichts ist hinausgegangen: der gesendete Stand bleibt, wie er
            // war, und die abgeholten Werte werden nicht mehr gebraucht.
            : await client.query<Senden>(
              `UPDATE rate_calendar_push
                  SET status = 'conflict', checked_at = now(), finished_at = now(),
                      conflicts = $2::jsonb, served = NULL
                WHERE id = $1 RETURNING ${SPALTEN}`, [s.id, JSON.stringify(konflikte)])
          return { ...antwort(r.rows[0]!), proceed: konflikte.length === 0 }
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

  /**
   * Die Entscheidung je abweichendem Tag, und dann senden.
   *
   * Beide Wahlen setzen den zuletzt abgeglichenen Stand auf das, was drueben
   * jetzt steht: StayGrid weiss es ja nun. "Uebernehmen" schreibt es
   * ausserdem hier, der Tag ist danach keine Aenderung mehr und geht nicht
   * hinaus. "Meinen senden" laesst den eigenen Wert stehen; er weicht vom
   * neuen Stand ab und geht mit dem neuen Auftrag hinaus, der hier gleich
   * mit angelegt wird -- der Klick ist der Knopfdruck. Dessen Gegenpruefung
   * findet an diesen Tagen nichts mehr, es sei denn, drueben aendert sich
   * schon wieder etwas.
   *
   * Felder, die das Umsystem nicht geliefert hat, behalten den vorigen
   * abgeglichenen Wert, ohne einen den eigenen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-calendar-pushes/:pushRef/resolve',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Abweichungen zum Channel Manager entscheiden und senden',
    handler: async (req, reply) => {
      const { propertyId: pid, pushRef } = req.params as { propertyId: string; pushRef: string }
      const propertyId = Number(pid)
      const body = (req.body ?? {}) as { decisions?: unknown }
      const principal = req.principal as Principal

      const ergebnis = await tx(req.pool, req, async client => {
        const a = await client.query<Senden>(
          `SELECT ${SPALTEN} FROM rate_calendar_push
            WHERE public_ref = $1 AND property_id = $2 FOR UPDATE`, [pushRef, propertyId])
        const s = a.rows[0]
        if (s === undefined) throw Errors.notFound('res.rateCalendarPush')
        if (s.status !== 'conflict' || s.resolved_at !== null) {
          throw Errors.conflict('rateCalendar.closed')
        }
        const konflikte = s.conflicts ?? []

        // Jeder Tag genau einmal, keiner zu viel: eine halbe Entscheidung
        // liesse offen, was mit dem Rest geschieht.
        const roh = body.decisions
        if (!Array.isArray(roh) || roh.length !== konflikte.length) {
          throw Errors.validation({ decisions: ['field.invalid'] })
        }
        const wahl = new Map<string, 'mine' | 'channel'>()
        roh.forEach((d: unknown, i) => {
          const e = (d ?? {}) as Record<string, unknown>
          const k = `${String(e.ratePlanCode)}|${String(e.date)}`
          if ((e.take !== 'mine' && e.take !== 'channel') || wahl.has(k)) {
            throw Errors.validation({ [`decisions.${i}`]: ['field.invalid'] })
          }
          wahl.set(k, e.take)
        })
        const zeilen = konflikte.map(k => {
          const take = wahl.get(`${k.ratePlanCode}|${k.date}`)
          if (take === undefined) throw Errors.validation({ decisions: ['field.invalid'] })
          // Der neue abgeglichene Stand: geliefert vor zuletzt abgeglichen vor hier.
          const neu = Object.fromEntries(WERT_FELDER.map(f =>
            [f, k.channel[f] !== undefined ? k.channel[f]
              : k.sent !== null ? k.sent[f] : k.local[f]])) as unknown as Werte
          return { plan: k.ratePlanId, date: k.date, take, ...neu }
        })
        const json = JSON.stringify(zeilen)
        const ZEILEN = `jsonb_to_recordset($2::jsonb) AS z(plan bigint, date date, take text,
          "priceCent" bigint[], "minLos" smallint, "maxLos" smallint, closed boolean,
          "closedToArrival" boolean, "closedToDeparture" boolean)`

        // Hier uebernehmen: Preise auf dem Weg der Preispflege, abgeleitete
        // Plaene folgen ihrer Basis und bekommen keinen eigenen.
        await client.query(
          `SELECT rate_prices_write($1, array_agg(z.plan), array_agg(z.date),
                                    array_agg(z."priceCent"::text), 'channel_import')
             FROM ${ZEILEN}
             JOIN rate_plan rp ON rp.id = z.plan AND rp.property_id = $1
                              AND rp.base_rate_plan_id IS NULL
             LEFT JOIN rate_day rd ON rd.rate_plan_id = z.plan AND rd.date = z.date
            WHERE z.take = 'channel' AND z."priceCent" IS NOT NULL
              AND rd.price_cent IS DISTINCT FROM z."priceCent"
           HAVING count(*) > 0`, [propertyId, json])
        await client.query(
          `INSERT INTO restriction_day (property_id, rate_plan_id, date, min_los, max_los,
                                        closed, closed_to_arrival, closed_to_departure)
           SELECT $1, z.plan, z.date, z."minLos", z."maxLos", z.closed, z."closedToArrival",
                  z."closedToDeparture"
             FROM ${ZEILEN}
             JOIN rate_plan rp ON rp.id = z.plan AND rp.property_id = $1
            WHERE z.take = 'channel'
           ON CONFLICT (rate_plan_id, date) DO UPDATE SET
             min_los = EXCLUDED.min_los, max_los = EXCLUDED.max_los, closed = EXCLUDED.closed,
             closed_to_arrival = EXCLUDED.closed_to_arrival,
             closed_to_departure = EXCLUDED.closed_to_departure, updated_at = now()
           WHERE (restriction_day.min_los, restriction_day.max_los, restriction_day.closed,
                  restriction_day.closed_to_arrival, restriction_day.closed_to_departure)
                 IS DISTINCT FROM
                 (EXCLUDED.min_los, EXCLUDED.max_los, EXCLUDED.closed,
                  EXCLUDED.closed_to_arrival, EXCLUDED.closed_to_departure)`,
          [propertyId, json])
        await client.query(
          `INSERT INTO rate_calendar_sent (property_id, rate_plan_id, date, price_cent, min_los,
                                           max_los, closed, closed_to_arrival,
                                           closed_to_departure, sent_at)
           SELECT $1, z.plan, z.date, z."priceCent", z."minLos", z."maxLos", z.closed,
                  z."closedToArrival", z."closedToDeparture", now()
             FROM ${ZEILEN}
             JOIN rate_plan rp ON rp.id = z.plan AND rp.property_id = $1
           ON CONFLICT (rate_plan_id, date) DO UPDATE SET
             price_cent = EXCLUDED.price_cent, min_los = EXCLUDED.min_los,
             max_los = EXCLUDED.max_los, closed = EXCLUDED.closed,
             closed_to_arrival = EXCLUDED.closed_to_arrival,
             closed_to_departure = EXCLUDED.closed_to_departure, sent_at = EXCLUDED.sent_at`,
          [propertyId, json])
        await client.query(
          `UPDATE rate_calendar_push SET resolved_at = now() WHERE id = $1`, [s.id])

        // Derselbe Auftrag noch einmal. "Nur Aenderungen" rechnet ab dem
        // letzten erfolgreichen Senden; ein Konflikt ist keines.
        const seit = s.mode === 'changes' ? await letzteGrenze(client, propertyId) : null
        if (s.mode === 'changes' && seit === null) throw Errors.conflict('rateCalendar.noBaseline')
        const von = s.mode === 'range' ? s.date_from : await heute(client, propertyId)
        const bis = s.mode === 'range' ? s.date_to : addDays(von, MAX_DAYS - 1)
        return antwort(await anlegen(client, propertyId, s.mode, von, bis, seit,
                                     principal.userId))
      })
      reply.code(201)
      return ergebnis
    }
  })
}
