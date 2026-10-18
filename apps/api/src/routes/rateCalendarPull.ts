import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { emitEvent } from '../platform/events.js'
import { can, type Principal } from '../platform/context.js'

/*
 * Preiskalender aus dem Channel Manager abrufen (Migration 0179).
 *
 * StayGrid fragt, das Umsystem holt und liefert, ein Mensch uebernimmt.
 * Drei Schritte statt eines Aufrufs, weil der Abruf bei RoomCloud fuer ein
 * Jahr in Bloecken laeuft und eine Minute dauern kann -- so lange haelt
 * keine Anfrage am Tresen still --, und weil zwischen Lieferung und
 * Verkauf ein Blick auf die Vorschau gehoert.
 *
 * **Die Zuordnung bleibt beim Umsystem.** Es liefert je StayGrid-Ratenplan
 * (ueber dessen Code), nicht je RoomCloud-Zimmertyp und -Rate. Welche Rate
 * dort welcher Plan hier ist, ist hausbezogen und steht im Adminpanel
 * (Entwurf "API fuers Adminpanel": die API bleibt allgemein).
 *
 * **Verfuegbarkeit wird nicht uebernommen.** Die Zahl freier Zimmer rechnet
 * StayGrid aus Zimmern und Buchungen; ein Wert aus dem Channel Manager ist
 * nur dessen Kopie davon.
 */

/** Wie das Preisraster: ein Jahr und etwas Rand. */
const MAX_DAYS = 400
/** Ein Haus mit dreissig Ratenplaenen pflegt sie nicht mehr von Hand. */
const MAX_PLANS = 30
/** Belegungsstufen je Tag, wie die Kategorie sie hoechstens kennt. */
const MAX_OCCUPANCY = 10
/** 100 000 Euro je Nacht ist kein Preis mehr, sondern ein Tippfehler. */
const MAX_PRICE_CENT = 10_000_000
const MAX_LOS = 365
/** So viele Aenderungen zeigt die Vorschau einzeln; der Rest steht als Zahl da. */
const VORSCHAU_ZEILEN = 200

const RESTRIKTIONEN = ['minLos', 'maxLos', 'closed', 'closedToArrival', 'closedToDeparture'] as const

interface Tag {
  plan: number
  date: string
  price?: number[]
  minLos?: number
  maxLos?: number
  closed?: boolean
  closedToArrival?: boolean
  closedToDeparture?: boolean
}

type PlanErgebnis = 'accepted' | 'unknown_code' | 'derived' | 'inactive'

interface Abruf {
  id: number
  property_id: number
  public_ref: string
  date_from: string
  date_to: string
  status: string
  version: number
  plans: Array<{ ratePlanCode: string; result: PlanErgebnis; days: number }> | null
  message: string | null
  result: { prices: number; restrictions: number } | null
  requested_at: string
  delivered_at: string | null
  applied_at: string | null
}

const SPALTEN = `id, property_id, public_ref, date_from::text, date_to::text, status, version,
                 plans, message, result, requested_at, delivered_at, applied_at`

function zeitraum(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from !== 'string' || !isIsoDate(from)) throw Errors.validation({ from: ['field.isoDate'] })
  if (typeof to !== 'string' || !isIsoDate(to)) throw Errors.validation({ to: ['field.isoDate'] })
  const tage = nightsBetween(from, to) + 1
  if (tage <= 0) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
  if (tage > MAX_DAYS) throw Errors.rangeTooLarge(MAX_DAYS)
  return { from, to }
}

const ganz = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * Die Lieferung pruefen, bevor ein Code nachgeschlagen wird.
 *
 * Ein fehlendes oder `null`-Feld heisst "nicht geliefert": das Umsystem
 * weiss etwa nicht, ob RoomCloud Anreisesperren kennt, und soll dann nicht
 * "keine" behaupten muessen. Gespeichert wird nur, was geliefert wurde.
 */
function lieferungPruefen(
  roh: unknown, from: string, to: string
): Array<{ code: string; tage: Array<Omit<Tag, 'plan'>> }> {
  if (!Array.isArray(roh) || roh.length === 0) throw Errors.validation({ plans: ['field.required'] })
  if (roh.length > MAX_PLANS) {
    throw Errors.validation({ plans: ['field.range'] }, { min: '1', max: String(MAX_PLANS) })
  }
  const fehler: Record<string, Meldung[]> = {}
  const falsch = (feld: string, m: Meldung = 'field.invalid'): void => { fehler[feld] ??= [m] }
  const codes = new Set<string>()

  const aus = roh.map((p: unknown, i) => {
    const plan = (p ?? {}) as { ratePlanCode?: unknown; days?: unknown }
    const code = typeof plan.ratePlanCode === 'string' ? plan.ratePlanCode.trim() : ''
    if (code === '' || code.length > 64) falsch(`plans.${i}.ratePlanCode`, 'field.required')
    else if (codes.has(code)) falsch(`plans.${i}.ratePlanCode`)
    codes.add(code)
    if (!Array.isArray(plan.days) || plan.days.length > MAX_DAYS) {
      falsch(`plans.${i}.days`)
      return { code, tage: [] }
    }
    const daten = new Set<string>()
    const tage = plan.days.map((d: unknown, j) => {
      const t = (d ?? {}) as Record<string, unknown>
      const feld = (n: string): string => `plans.${i}.days.${j}.${n}`
      const date = t.date
      if (typeof date !== 'string' || !isIsoDate(date) || date < from || date > to
          || daten.has(date)) {
        falsch(feld('date'))
      } else {
        daten.add(date)
      }
      const tag: Omit<Tag, 'plan'> = { date: date as string }
      if (t.priceCent != null) {
        const p = t.priceCent
        if (!Array.isArray(p) || p.length === 0 || p.length > MAX_OCCUPANCY
            || !p.every(c => ganz(c, 0, MAX_PRICE_CENT))) {
          falsch(feld('priceCent'), 'field.centAmount')
        } else {
          tag.price = p as number[]
        }
      }
      for (const n of ['minLos', 'maxLos'] as const) {
        if (t[n] == null) continue
        if (!ganz(t[n], 1, MAX_LOS)) falsch(feld(n))
        else tag[n] = t[n]
      }
      if (tag.minLos !== undefined && tag.maxLos !== undefined && tag.minLos > tag.maxLos) {
        falsch(feld('minLos'), 'field.notAboveMaxLos')
      }
      for (const n of ['closed', 'closedToArrival', 'closedToDeparture'] as const) {
        if (t[n] == null) continue
        if (typeof t[n] !== 'boolean') falsch(feld(n))
        else tag[n] = t[n]
      }
      return tag
    })
    return { code, tage }
  })
  if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)
  return aus
}

async function abrufLaden(
  client: PoolClient, where: string, params: unknown[], sperren = false
): Promise<Abruf | null> {
  const { rows } = await client.query<Abruf>(
    `SELECT ${SPALTEN} FROM rate_calendar_pull WHERE ${where}${sperren ? ' FOR UPDATE' : ''}`,
    params)
  return rows[0] ?? null
}

interface Aenderung {
  ratePlanCode: string
  date: string
  oldPriceCent: number[] | null
  newPriceCent: number[] | null
  restrictionChanged: boolean
}

/**
 * Was die Uebernahme aendern wuerde, gegen den Stand von jetzt.
 *
 * Eine Abfrage fuer die ganze Lieferung; je Plan und Tag nachzusehen machte
 * aus einem Jahr mal zehn Plaene viertausend Runden.
 */
async function vorschau(client: PoolClient, id: number) {
  const { rows } = await client.query<{
    code: string; name: string; date: string; old_price: string[] | null
    new_price: string[] | null; price_changed: boolean; restr_changed: boolean }>(
    `WITH l AS (
       SELECT (x->>'plan')::bigint AS plan, (x->>'date')::date AS date, x,
              CASE WHEN x ? 'price'
                   THEN ARRAY(SELECT e::bigint FROM jsonb_array_elements_text(x->'price') e)
              END AS neu
         FROM rate_calendar_pull p, jsonb_array_elements(p.payload) x
        WHERE p.id = $1
     )
     SELECT rp.code, rp.name, l.date::text, rd.price_cent AS old_price, l.neu AS new_price,
            (l.neu IS NOT NULL AND rd.price_cent IS DISTINCT FROM l.neu) AS price_changed,
            (   (l.x ? 'minLos' AND rs.min_los IS DISTINCT FROM (l.x->>'minLos')::smallint)
             OR (l.x ? 'maxLos' AND rs.max_los IS DISTINCT FROM (l.x->>'maxLos')::smallint)
             OR (l.x ? 'closed'
                 AND COALESCE(rs.closed, false) <> (l.x->>'closed')::boolean)
             OR (l.x ? 'closedToArrival'
                 AND COALESCE(rs.closed_to_arrival, false) <> (l.x->>'closedToArrival')::boolean)
             OR (l.x ? 'closedToDeparture'
                 AND COALESCE(rs.closed_to_departure, false) <> (l.x->>'closedToDeparture')::boolean)
            ) AS restr_changed
       FROM l
       JOIN rate_plan rp ON rp.id = l.plan
       LEFT JOIN rate_day rd ON rd.rate_plan_id = l.plan AND rd.date = l.date
       LEFT JOIN restriction_day rs ON rs.rate_plan_id = l.plan AND rs.date = l.date
      ORDER BY rp.code, l.date`, [id])

  const jePlan = new Map<string, { ratePlanCode: string; name: string; days: number
                                   priceChanges: number; restrictionChanges: number }>()
  const changes: Aenderung[] = []
  let priceChanges = 0
  let restrictionChanges = 0
  for (const r of rows) {
    const p = jePlan.get(r.code) ?? { ratePlanCode: r.code, name: r.name, days: 0,
                                      priceChanges: 0, restrictionChanges: 0 }
    p.days++
    if (r.price_changed) { p.priceChanges++; priceChanges++ }
    if (r.restr_changed) { p.restrictionChanges++; restrictionChanges++ }
    jePlan.set(r.code, p)
    if ((r.price_changed || r.restr_changed) && changes.length < VORSCHAU_ZEILEN) {
      changes.push({
        ratePlanCode: r.code, date: r.date,
        oldPriceCent: r.old_price?.map(Number) ?? null,
        newPriceCent: r.price_changed ? r.new_price!.map(Number) : null,
        restrictionChanged: r.restr_changed })
    }
  }
  return { priceChanges, restrictionChanges, plans: [...jePlan.values()], changes }
}

function antwort(a: Abruf) {
  return {
    pullRef: a.public_ref, status: a.status, from: a.date_from, to: a.date_to,
    version: a.version, requestedAt: a.requested_at, deliveredAt: a.delivered_at,
    appliedAt: a.applied_at, message: a.message, delivery: a.plans ?? [],
    result: a.result
  }
}

export function rateCalendarPullRoutes(app: FastifyInstance): void {
  /**
   * Den Abruf anstossen.
   *
   * Nimmt das Ereignis niemand entgegen, wird abgewiesen statt gewartet: ein
   * Knopf, der "warte auf Antwort" zeigt, obwohl keiner fragt, wartet
   * ewig. Ein neuer Abruf ersetzt einen offenen; zwei Vorschauen desselben
   * Hauses nebeneinander liessen offen, welche gilt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-calendar-pulls',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Preiskalender beim Umsystem anfordern',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const body = (req.body ?? {}) as { from?: unknown; to?: unknown }
      const { from, to } = zeitraum(body.from, body.to)
      const principal = req.principal as Principal

      const ergebnis = await tx(req.pool, req, async client => {
        await client.query(
          `UPDATE rate_calendar_pull SET status = 'superseded'
            WHERE property_id = $1 AND status IN ('requested','delivered')`, [propertyId])
        const neu = await client.query<Abruf>(
          `INSERT INTO rate_calendar_pull (property_id, date_from, date_to, requested_by)
           VALUES ($1, $2, $3, $4) RETURNING ${SPALTEN}`,
          [propertyId, from, to, principal.userId])
        const a = neu.rows[0]!
        const empfaenger = await emitEvent(client, propertyId, 'rate.calendar_pull_requested',
          { pullRef: a.public_ref, propertyId, from, to })
        if (empfaenger === 0) throw Errors.conflict('rateCalendar.noReceiver')
        return antwort(a)
      })
      reply.code(201)
      return ergebnis
    }
  })

  /**
   * Der neueste Abruf des Hauses und, wenn geliefert, die Vorschau.
   *
   * Die Oberflaeche fragt das waehrend des Wartens wiederholt; eine
   * Anfrage, eine Abfrage fuer den Abruf und eine fuer die Vorschau.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-calendar-pulls/current',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Stand des letzten Preiskalender-Abrufs mit Vorschau',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const a = await abrufLaden(client,
          `property_id = $1 ORDER BY requested_at DESC, id DESC LIMIT 1`, [propertyId])
        if (a === null) return { pull: null, preview: null }
        return { pull: antwort(a),
                 preview: a.status === 'delivered' ? await vorschau(client, a.id) : null }
      })
    }
  })

  /**
   * Die Lieferung des Umsystems.
   *
   * Wiederholbar, solange niemand uebernommen hat: eine zweite Lieferung
   * ersetzt die erste und zaehlt `version` hoch. Ein Plan, der abgeleitet
   * ist, wird uebergangen -- er folgt seiner Basis, und ein eigener Preis
   * darin ginge beim naechsten Schreiben der Basis ohnehin verloren.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/rate-calendar-pulls/:pullRef',
    permission: 'rate:calendar_import',
    summary: 'Preiskalender aus einem Umsystem liefern',
    bodyLimit: 4 * 1024 * 1024,
    handler: async (req) => {
      const { pullRef } = req.params as { pullRef: string }
      const body = (req.body ?? {}) as { status?: unknown; plans?: unknown; message?: unknown }
      const principal = req.principal as Principal
      if (body.status !== 'delivered' && body.status !== 'failed') {
        throw Errors.validation({ status: ['field.invalid'] })
      }

      return tx(req.pool, req, async client => {
        const a = await abrufLaden(client, `public_ref = $1`, [pullRef], true)
        if (a === null) throw Errors.notFound('res.rateCalendarPull')
        // Das Recht im Haus des Abrufs: die Route nimmt keine Property.
        if (!can(principal, 'rate:calendar_import', Number(a.property_id))) {
          throw Errors.forbidden('access.missingPermission', { permission: 'rate:calendar_import' })
        }
        if (!['requested', 'delivered', 'failed'].includes(a.status)) {
          throw Errors.conflict('rateCalendar.closed')
        }

        if (body.status === 'failed') {
          const m = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : ''
          const r = await client.query<Abruf>(
            `UPDATE rate_calendar_pull
                SET status = 'failed', message = $2, payload = NULL, plans = NULL,
                    delivered_at = now(), version = version + 1
              WHERE id = $1 RETURNING ${SPALTEN}`, [a.id, m === '' ? null : m])
          return antwort(r.rows[0]!)
        }

        const geliefert = lieferungPruefen(body.plans, a.date_from, a.date_to)
        // Die Codes in einer Abfrage nachschlagen, und nur im Haus des
        // Abrufs: die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus.
        const { rows: plaene } = await client.query<{
          id: number; code: string; active: boolean; derived: boolean }>(
          `SELECT id, code, active, base_rate_plan_id IS NOT NULL AS derived
             FROM rate_plan WHERE property_id = $1 AND code = ANY($2::text[])`,
          [a.property_id, geliefert.map(g => g.code)])
        const nachCode = new Map(plaene.map(p => [p.code, p]))

        const payload: Tag[] = []
        const ergebnis = geliefert.map(g => {
          const p = nachCode.get(g.code)
          const result: PlanErgebnis = p === undefined ? 'unknown_code'
            : p.derived ? 'derived' : !p.active ? 'inactive' : 'accepted'
          if (result === 'accepted') {
            for (const t of g.tage) payload.push({ plan: Number(p!.id), ...t })
          }
          return { ratePlanCode: g.code, result, days: g.tage.length }
        })

        const r = await client.query<Abruf>(
          `UPDATE rate_calendar_pull
              SET status = 'delivered', payload = $2::jsonb, plans = $3::jsonb, message = NULL,
                  delivered_at = now(), version = version + 1
            WHERE id = $1 RETURNING ${SPALTEN}`,
          [a.id, JSON.stringify(payload), JSON.stringify(ergebnis)])
        return antwort(r.rows[0]!)
      })
    }
  })

  /**
   * Die Vorschau uebernehmen.
   *
   * Preise ueber `rate_prices_write`, denselben Weg wie die Preispflege:
   * abgeleitete Raten folgen, die Aenderungsmeldung sieht jeden geaenderten
   * Tag, und `rate.changed` geht mit der Herkunft `channel_import` hinaus.
   * Ein Umsystem, das Preise spaeter zurueck an RoomCloud schiebt, erkennt
   * daran, was es selbst geholt hat. Auf einem von den Regeln gesteuerten
   * Plan wird der gelieferte Preis der neue Grundpreis (Dokument 32,
   * Abschnitt 3), wie bei einer Pflege von Hand.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-calendar-pulls/:pullRef/apply',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Gelieferten Preiskalender uebernehmen',
    handler: async (req) => {
      const { propertyId, pullRef } = req.params as { propertyId: string; pullRef: string }
      const body = (req.body ?? {}) as { version?: unknown }
      if (!ganz(body.version, 1, Number.MAX_SAFE_INTEGER)) {
        throw Errors.validation({ version: ['field.invalid'] })
      }
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const a = await abrufLaden(client, `public_ref = $1 AND property_id = $2`,
          [pullRef, Number(propertyId)], true)
        if (a === null) throw Errors.notFound('res.rateCalendarPull')
        if (a.status === 'applied' || a.status === 'superseded') {
          throw Errors.conflict('rateCalendar.closed')
        }
        // Eine neuere Lieferung seit der Vorschau wird nicht still
        // geschrieben: uebernommen wird, was jemand gesehen hat.
        if (a.status !== 'delivered' || a.version !== body.version) {
          throw Errors.conflict('rateCalendar.notReady')
        }

        const preise = await client.query<{ n: number | null }>(
          `SELECT rate_prices_write($1, array_agg(plan), array_agg(date), array_agg(price),
                                    'channel_import') AS n
             FROM (SELECT (x->>'plan')::bigint AS plan, (x->>'date')::date AS date,
                          '{' || (SELECT string_agg(e, ',')
                                    FROM jsonb_array_elements_text(x->'price') e) || '}' AS price
                     FROM rate_calendar_pull p, jsonb_array_elements(p.payload) x
                    WHERE p.id = $2 AND x ? 'price') s`,
          [a.property_id, a.id])

        // Nur Felder, die geliefert wurden; die anderen behalten ihren Wert.
        // Geschrieben wird nur, wo sich etwas aendert -- sonst meldete jede
        // Uebernahme das ganze Jahr als geaendert an den Channel Manager.
        const restriktionen = await client.query<{ n: number }>(
          `WITH l AS (
             SELECT (x->>'plan')::bigint AS plan, (x->>'date')::date AS date, x
               FROM rate_calendar_pull p, jsonb_array_elements(p.payload) x
              WHERE p.id = $2 AND x ?| $3::text[]
           ), geschrieben AS (
             INSERT INTO restriction_day (property_id, rate_plan_id, date, min_los, max_los,
                                          closed, closed_to_arrival, closed_to_departure)
             SELECT $1, l.plan, l.date,
                    CASE WHEN l.x ? 'minLos' THEN (l.x->>'minLos')::smallint ELSE rs.min_los END,
                    CASE WHEN l.x ? 'maxLos' THEN (l.x->>'maxLos')::smallint ELSE rs.max_los END,
                    COALESCE((l.x->>'closed')::boolean, rs.closed, false),
                    COALESCE((l.x->>'closedToArrival')::boolean, rs.closed_to_arrival, false),
                    COALESCE((l.x->>'closedToDeparture')::boolean, rs.closed_to_departure, false)
               FROM l
               LEFT JOIN restriction_day rs ON rs.rate_plan_id = l.plan AND rs.date = l.date
             ON CONFLICT (rate_plan_id, date) DO UPDATE SET
               min_los = EXCLUDED.min_los, max_los = EXCLUDED.max_los,
               closed = EXCLUDED.closed,
               closed_to_arrival = EXCLUDED.closed_to_arrival,
               closed_to_departure = EXCLUDED.closed_to_departure,
               updated_at = now()
             WHERE (restriction_day.min_los, restriction_day.max_los, restriction_day.closed,
                    restriction_day.closed_to_arrival, restriction_day.closed_to_departure)
                   IS DISTINCT FROM
                   (EXCLUDED.min_los, EXCLUDED.max_los, EXCLUDED.closed,
                    EXCLUDED.closed_to_arrival, EXCLUDED.closed_to_departure)
             RETURNING 1
           )
           SELECT count(*)::int AS n FROM geschrieben`,
          [a.property_id, a.id, RESTRIKTIONEN])

        const result = { prices: preise.rows[0]!.n ?? 0, restrictions: restriktionen.rows[0]!.n }
        const r = await client.query<Abruf>(
          `UPDATE rate_calendar_pull
              SET status = 'applied', applied_at = now(), applied_by = $2, result = $3::jsonb
            WHERE id = $1 RETURNING ${SPALTEN}`,
          [a.id, principal.userId, JSON.stringify(result)])
        return antwort(r.rows[0]!)
      })
    }
  })
}
