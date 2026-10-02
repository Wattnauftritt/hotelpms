import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'
import { emitEvent } from '../platform/events.js'
import type { Principal } from '../platform/context.js'

/** Ein Jahr je Anfrage. Mehr braucht niemand, und es begrenzt die Sperrzeit. */
const MAX_DAYS = 400
/** Sieben Bits, Montag = 0. */
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

interface BulkWindow {
  propertyId: number
  ratePlanId: number
  from: string
  to: string
  /** Wochentage, Montag = 0. Ohne Angabe alle. */
  weekdays?: number[]
}

function checkWindow(w: BulkWindow): void {
  if (!isIsoDate(w.from) || !isIsoDate(w.to)) {
    throw Errors.validation({ from: ['field.isoDate'] })
  }
  const days = nightsBetween(w.from, w.to) + 1
  if (days <= 0) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
  if (days > MAX_DAYS) throw Errors.rangeTooLarge(MAX_DAYS)
  for (const d of w.weekdays ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw Errors.validation({ weekdays: ['field.weekday'] })
    }
  }
}

/**
 * Prueft, dass der Ratenplan zur Property gehoert.
 *
 * Die Zeilenrichtlinie faengt einen fremden Plan bereits ab, aber nur, weil
 * sie nach property_id filtert. Ein Plan einer **anderen Property desselben
 * Accounts** liegt im Kontext und kaeme durch. Die Pflege schreibt sonst
 * Preise ins falsche Haus.
 */
async function assertPlan(
  client: PoolClient, propertyId: number, ratePlanId: number
): Promise<{ categoryId: number; source: string }> {
  const { rows, rowCount } = await client.query<{ category_id: number; source: string }>(
    `SELECT rp.category_id, coalesce(s.source, 'manual') AS source
       FROM rate_plan rp LEFT JOIN rate_plan_steering s ON s.rate_plan_id = rp.id
      WHERE rp.id = $1 AND rp.property_id = $2`,
    [ratePlanId, propertyId])
  if (rowCount === 0) throw Errors.notFound('res.ratePlan')
  return { categoryId: rows[0]!.category_id, source: rows[0]!.source }
}

/**
 * Wer schreibt: ein Mensch oder eine Schnittstelle.
 *
 * Ein Maschinentoken hat keinen Benutzer (`loadPrincipalFromToken`). Die
 * Unterscheidung braucht die Preissteuerung: ein externes RMS soll einen von
 * den Regeln gesteuerten Plan nicht beschreiben, ein Mensch schon -- er setzt
 * damit den Grundpreis (Dokument 32).
 */
function writeOrigin(principal: Principal): 'manual' | 'external' {
  return principal.userId === null && principal.clientKey.startsWith('client:')
    ? 'external' : 'manual'
}

export function rateRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-plans',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Ratenplaene der Property',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT rp.id, rp.public_ref AS "ratePlanRef", rp.code, rp.name,
                  rp.category_id AS "categoryId", c.code AS "categoryCode",
                  rp.base_rate_plan_id AS "baseRatePlanId",
                  rp.derive_kind AS "deriveKind", rp.derive_value AS "deriveValue",
                  rp.active
             FROM rate_plan rp JOIN resource_category c ON c.id = rp.category_id
            WHERE rp.property_id = $1 ORDER BY c.code, rp.code`, [Number(propertyId)])
        return { ratePlans: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-plans',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Ratenplan anlegen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const body = req.body as {
        code: string; name: string; categoryId: number
        baseRatePlanId?: number; deriveKind?: 'amount' | 'percent'; deriveValue?: number
        cancellationPolicyId?: number }
      if (!body.code || !body.name) {
        throw Errors.validation({ code: ['field.required'], name: ['field.required'] })
      }
      const abgeleitet = body.baseRatePlanId !== undefined
      if (abgeleitet && (body.deriveKind === undefined || body.deriveValue === undefined)) {
        throw Errors.validation({
          deriveKind: ['field.requiredForDerived'],
          deriveValue: ['field.requiredForDerived'] })
      }
      return tx(req.pool, req, async client => {
        if (abgeleitet) await assertPlan(client, Number(propertyId), body.baseRatePlanId!)
        const { rows } = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO rate_plan (property_id, category_id, code, name,
                                  cancellation_policy_id, base_rate_plan_id,
                                  derive_kind, derive_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, public_ref`,
          [Number(propertyId), body.categoryId, body.code, body.name,
           body.cancellationPolicyId ?? null, body.baseRatePlanId ?? null,
           body.deriveKind ?? null, body.deriveValue ?? null])
        reply.status(201)
        return { ratePlanId: rows[0]!.id, ratePlanRef: rows[0]!.public_ref }
      })
    }
  })

  /**
   * Preispflege ueber einen Zeitraum.
   *
   * **Eine Anfrage, eine Abfrage.** Ein Jahr Preise sind 365 Zeilen; einzeln
   * geschrieben waeren das 365 Runden zu je 0,1 bis 50 Millisekunden. Die
   * Tage werden in der Datenbank erzeugt und in einem Zug eingefuegt
   * (P-Gesetz, Dokument 04).
   *
   * **Ueber `rate_prices_write`** (Migration 0066), denselben Weg, den die
   * Preissteuerung nimmt: abgeleitete Raten folgen sofort, die
   * Aenderungsmeldung an den Channel Manager sieht auch eine Aenderung an
   * einem schon gepflegten Tag, und `rate.changed` geht hinaus. Vorher tat
   * die Route nichts davon.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/rates/bulk',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Preise fuer einen Zeitraum setzen',
    handler: async (req) => {
      const body = req.body as BulkWindow & { priceCent: number[] }
      checkWindow(body)
      if (!Array.isArray(body.priceCent) || body.priceCent.length === 0) {
        throw Errors.validation({ priceCent: ['field.occupancyPrices'] })
      }
      if (body.priceCent.some(p => !Number.isInteger(p) || p < 0)) {
        throw Errors.validation({ priceCent: ['field.centAmount'] })
      }
      const weekdays = body.weekdays ?? ALL_WEEKDAYS

      const origin = writeOrigin(req.principal as Principal)

      return tx(req.pool, req, async client => {
        const plan = await assertPlan(client, body.propertyId, body.ratePlanId)
        // Interne Regeln und ein externes RMS ueberschreiben sich sonst
        // gegenseitig, jedes mit gutem Gewissen und im Wechsel.
        if (origin === 'external' && plan.source === 'rules') {
          throw Errors.conflict('rateSteer.sourceRules')
        }
        // `days` sind die angesprochenen Tage, nicht die geaenderten: so hat
        // die Route es immer gemeldet, und die Oberflaeche zeigt es so an.
        const { rows } = await client.query<{ days: number }>(
          `SELECT count(*)::int AS days,
                  rate_prices_write($1, array_agg($2::bigint), array_agg(d::date),
                                    array_agg($5::text), $7) AS changed
             FROM generate_series($3::date, $4::date, interval '1 day') d
            WHERE (EXTRACT(isodow FROM d)::int - 1) = ANY($6::int[])`,
          [body.propertyId, body.ratePlanId, body.from, body.to,
           `{${body.priceCent.join(',')}}`, weekdays, origin])
        return { ratePlanId: body.ratePlanId, days: rows[0]!.days }
      })
    }
  })

  /**
   * Abgeleitete Raten neu rechnen.
   *
   * Die Ableitung liegt nicht als Formel in der Abfrage, sondern wird
   * einmal materialisiert. Sonst kostet jede Verfuegbarkeitsanfrage eine
   * rekursive Aufloesung ueber die Ableitungskette, und die Kette kann
   * mehrere Stufen tief sein.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/rates/rebuild-derived',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Abgeleitete Raten neu berechnen',
    handler: async (req) => {
      const body = req.body as { propertyId: number; from: string; to: string }
      checkWindow({ ...body, ratePlanId: 0 })

      return tx(req.pool, req, async client => {
        // Ebene fuer Ebene in der Datenbank (Migration 0066): eine Anweisung
        // je Ableitungsstufe statt einer je Plan, und derselbe Weg, den die
        // Preispflege und die Steuerung nach jedem Schreiben gehen.
        const { rows } = await client.query<{ plans: number; days: number; cycle: boolean }>(
          `SELECT plans, days, cycle FROM rate_derived_rebuild($1, $2::date, $3::date)`,
          [body.propertyId, body.from, body.to])
        const r = rows[0]!
        if (r.cycle) throw Errors.conflict('rate.derivationCycle')
        if (r.days > 0) {
          await emitEvent(client, body.propertyId, 'rate.changed', {
            origin: 'derived', from: body.from, to: body.to, days: 0, derivedDays: r.days })
        }
        return { plans: r.plans, days: r.days }
      })
    }
  })

  /**
   * Restriktionen ueber einen Zeitraum. Dieselbe Mechanik wie bei den
   * Preisen: ein Aufruf, eine Abfrage, feste Obergrenze.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/restrictions/bulk',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Restriktionen fuer einen Zeitraum setzen',
    handler: async (req) => {
      const body = req.body as BulkWindow & {
        minLos?: number | null; maxLos?: number | null
        closed?: boolean; closedToArrival?: boolean; closedToDeparture?: boolean }
      checkWindow(body)
      if (body.minLos != null && body.maxLos != null && body.minLos > body.maxLos) {
        throw Errors.validation({ minLos: ['field.notAboveMaxLos'] })
      }
      const weekdays = body.weekdays ?? ALL_WEEKDAYS

      return tx(req.pool, req, async client => {
        await assertPlan(client, body.propertyId, body.ratePlanId)
        const { rowCount } = await client.query(
          `INSERT INTO restriction_day (property_id, rate_plan_id, date, min_los, max_los,
                                        closed, closed_to_arrival, closed_to_departure)
           SELECT $1, $2, d::date, $5, $6, COALESCE($7,false),
                  COALESCE($8,false), COALESCE($9,false)
             FROM generate_series($3::date, $4::date, interval '1 day') d
            WHERE (EXTRACT(isodow FROM d)::int - 1) = ANY($10::int[])
           ON CONFLICT (rate_plan_id, date) DO UPDATE SET
             min_los = EXCLUDED.min_los, max_los = EXCLUDED.max_los,
             closed = EXCLUDED.closed,
             closed_to_arrival = EXCLUDED.closed_to_arrival,
             closed_to_departure = EXCLUDED.closed_to_departure,
             -- Ohne den Zeitstempel sah die Aenderungsmeldung eine Sperre an
             -- einem schon gepflegten Tag nie (Migration 0066, Befund 2).
             updated_at = now()`,
          [body.propertyId, body.ratePlanId, body.from, body.to,
           body.minLos ?? null, body.maxLos ?? null, body.closed ?? null,
           body.closedToArrival ?? null, body.closedToDeparture ?? null, weekdays])
        return { ratePlanId: body.ratePlanId, days: rowCount ?? 0 }
      })
    }
  })

  /**
   * Preis- und Restriktionsraster fuer die Pflegeansicht.
   * Eine Abfrage fuer den ganzen Zeitraum und alle Plaene einer Kategorie;
   * die Oberflaeche baut daraus ihr Gitter (P-Gesetz, Dokument 04).
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-grid',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Preise und Restriktionen als Raster',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string; categoryId?: string }
      if (!isIsoDate(q.from) || !isIsoDate(q.to)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      const days = nightsBetween(q.from, q.to) + 1
      if (days <= 0 || days > MAX_DAYS) throw Errors.rangeTooLarge(MAX_DAYS)

      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT rp.id AS "ratePlanId", rp.code AS "ratePlanCode",
                  d.day::date::text AS date,
                  rd.price_cent AS "priceCent",
                  rs.min_los AS "minLos", rs.max_los AS "maxLos",
                  COALESCE(rs.closed, false) AS closed,
                  COALESCE(rs.closed_to_arrival, false) AS "closedToArrival",
                  COALESCE(rs.closed_to_departure, false) AS "closedToDeparture"
             FROM rate_plan rp
             CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d(day)
             LEFT JOIN rate_day rd ON rd.rate_plan_id = rp.id AND rd.date = d.day::date
             LEFT JOIN restriction_day rs ON rs.rate_plan_id = rp.id AND rs.date = d.day::date
            WHERE rp.property_id = $1 AND rp.active
              AND ($4::bigint IS NULL OR rp.category_id = $4)
            ORDER BY rp.code, d.day`,
          [Number(propertyId), q.from, q.to,
           q.categoryId === undefined ? null : Number(q.categoryId)])
        return { from: q.from, to: q.to, cells: rows }
      })
    }
  })
}
