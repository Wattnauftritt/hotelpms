import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'

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
): Promise<{ categoryId: number }> {
  const { rows, rowCount } = await client.query<{ category_id: number }>(
    `SELECT category_id FROM rate_plan WHERE id = $1 AND property_id = $2`,
    [ratePlanId, propertyId])
  if (rowCount === 0) throw Errors.notFound('res.ratePlan')
  return { categoryId: rows[0]!.category_id }
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

      return tx(req.pool, req, async client => {
        await assertPlan(client, body.propertyId, body.ratePlanId)
        const { rowCount } = await client.query(
          `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
           SELECT $1, $2, d::date, $5::bigint[]
             FROM generate_series($3::date, $4::date, interval '1 day') d
            WHERE (EXTRACT(isodow FROM d)::int - 1) = ANY($6::int[])
           ON CONFLICT (rate_plan_id, date) DO UPDATE SET price_cent = EXCLUDED.price_cent`,
          [body.propertyId, body.ratePlanId, body.from, body.to, body.priceCent, weekdays])
        return { ratePlanId: body.ratePlanId, days: rowCount ?? 0 }
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
        const plans = await client.query<{ id: number; base_rate_plan_id: number
                                           derive_kind: 'amount' | 'percent'
                                           derive_value: number }>(
          `SELECT id, base_rate_plan_id, derive_kind, derive_value FROM rate_plan
            WHERE property_id = $1 AND base_rate_plan_id IS NOT NULL AND active
            ORDER BY id`, [body.propertyId])

        let geschrieben = 0
        // Mehrstufige Ketten in Reihenfolge der Basis aufloesen, damit eine
        // Rate, die auf einer abgeleiteten Rate sitzt, deren neuen Wert sieht.
        const offen = [...plans.rows]
        const fertig = new Set<number>()
        let runde = 0
        while (offen.length > 0 && runde++ <= plans.rows.length) {
          for (let i = offen.length - 1; i >= 0; i--) {
            const p = offen[i]!
            const basisAbgeleitet = plans.rows.some(q => q.id === p.base_rate_plan_id)
            if (basisAbgeleitet && !fertig.has(p.base_rate_plan_id)) continue

            // Ein Jahr abgeleitete Preise in einer Anweisung. Die Ableitung
            // wird je Belegungsstufe angewandt; die Rundung entspricht
            // derivePrice aus dem Domaenenkern, ein Test haelt beide zusammen.
            const r = await client.query(
              `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
               SELECT $1, $2, b.date,
                      ARRAY(SELECT greatest(
                              CASE WHEN $5 = 'amount' THEN e + $6
                                   ELSE round(e * (10000 + $6 * 100) / 10000.0)::bigint END,
                              0)
                              FROM unnest(b.price_cent) AS e)
                 FROM rate_day b
                WHERE b.rate_plan_id = $3 AND b.date BETWEEN $4::date AND $7::date
               ON CONFLICT (rate_plan_id, date)
               DO UPDATE SET price_cent = EXCLUDED.price_cent`,
              [body.propertyId, p.id, p.base_rate_plan_id, body.from,
               p.derive_kind, p.derive_value, body.to])
            geschrieben += r.rowCount ?? 0
            fertig.add(p.id)
            offen.splice(i, 1)
          }
        }
        if (offen.length > 0) {
          throw Errors.conflict('rate.derivationCycle')
        }
        return { plans: plans.rowCount, days: geschrieben }
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
             closed_to_departure = EXCLUDED.closed_to_departure`,
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
