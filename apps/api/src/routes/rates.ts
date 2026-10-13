import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'
import { emitEvent } from '../platform/events.js'
import type { Principal } from '../platform/context.js'

/** Ein Jahr je Anfrage. Mehr braucht niemand, und es begrenzt die Sperrzeit. */
const MAX_DAYS = 400
/** Fruehstueck je Person und Nacht, wie die Bedingung in Migration 0158. */
const BREAKFAST_MIN = 1
const BREAKFAST_MAX = 100_000
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

/** Hoechstens so viele Leistungen je Rate; mehr ist keine Rate, sondern ein Paket. */
const INKLUSIV_MAX = 10
const ABRECHNUNG = ['per_night', 'per_person_night', 'once'] as const

interface Inklusivleistung {
  name: string; grossCent: number; chargeMode: typeof ABRECHNUNG[number]; taxRuleId: number
}

function inklusivPruefen(roh: unknown): Inklusivleistung[] {
  if (!Array.isArray(roh)) throw Errors.validation({ inclusions: ['field.required'] })
  if (roh.length > INKLUSIV_MAX) {
    throw Errors.validation({ inclusions: ['field.range'] }, { min: '0', max: String(INKLUSIV_MAX) })
  }
  const fehler: Record<string, Meldung[]> = {}
  const aus = roh.map((x: unknown, i): Inklusivleistung => {
    const l = (x ?? {}) as Record<string, unknown>
    const name = typeof l.name === 'string' ? l.name.trim() : ''
    if (name === '' || name.length > 60) fehler[`inclusions.${i}.name`] = ['field.required']
    const cent = l.grossCent
    if (!(typeof cent === 'number' && Number.isInteger(cent)
          && cent >= BREAKFAST_MIN && cent <= BREAKFAST_MAX)) {
      fehler[`inclusions.${i}.grossCent`] = ['field.range']
    }
    if (!ABRECHNUNG.includes(l.chargeMode as typeof ABRECHNUNG[number])) {
      fehler[`inclusions.${i}.chargeMode`] = ['field.invalid']
    }
    if (!(typeof l.taxRuleId === 'number' && Number.isSafeInteger(l.taxRuleId))) {
      fehler[`inclusions.${i}.taxRuleId`] = ['field.invalid']
    }
    return { name, grossCent: cent as number,
             chargeMode: l.chargeMode as Inklusivleistung['chargeMode'],
             taxRuleId: l.taxRuleId as number }
  })
  if (Object.keys(fehler).length > 0) {
    throw Errors.validation(fehler, { min: '0,01 €', max: '1.000,00 €' })
  }
  return aus
}

/** Automatikkonto in SKR03 nach Satz, wie Fruehstueck und Positionen am Folio. */
function kontoFuerSatz(rateBp: number): string {
  return rateBp === 1900 ? '8400' : rateBp === 700 ? '8300' : '8200'
}

/** Die Umsatzsteuersaetze des Hauses, aus denen eine Leistung waehlt. */
async function umsatzsteuer(
  client: PoolClient, propertyId: number
): Promise<Array<{ id: number; name: string; rateBp: number }>> {
  const r = await client.query<{ id: number; name: string; rateBp: number }>(
    `SELECT id::int, name, rate_bp AS "rateBp" FROM tax_rule
      WHERE property_id = $1 AND kind = 'vat' AND basis = 'percent' AND active
        AND rate_bp IS NOT NULL
      ORDER BY rate_bp, id`, [propertyId])
  return r.rows
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
                  rp.breakfast_cent AS "breakfastCent",
                  rp.breakfast_child_cent AS "childBreakfastCent", rp.active,
                  COALESCE((SELECT json_agg(json_build_object(
                                     'name', p.name, 'grossCent', p.price_cent,
                                     'chargeMode', p.charge_mode,
                                     'taxRuleId', p.tax_rule_id) ORDER BY p.id)
                              FROM rate_plan_product rpp
                              JOIN product p ON p.id = rpp.product_id AND p.active
                             WHERE rpp.rate_plan_id = rp.id), '[]'::json) AS inclusions
             FROM rate_plan rp JOIN resource_category c ON c.id = rp.category_id
            WHERE rp.property_id = $1 ORDER BY c.code, rp.code`, [Number(propertyId)])
        return { ratePlans: rows, vatRules: await umsatzsteuer(client, Number(propertyId)) }
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
   * Fruehstueck im Ratenpreis setzen oder entfernen (Migration 0158).
   *
   * Das Haus sagt nur, ob und zu welchem Preis je Person und Nacht, dazu
   * wahlweise einen eigenen Preis fuer Kinder (0 = frei); den
   * Getraenkeanteil gibt das BMF vor und steht in der Domain. Wirkt ab der
   * naechsten Nacht, die der Nachtlauf bucht: eine gebuchte Nacht ist
   * Haertegrad 1 und wird nicht nachtraeglich umgeteilt.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/rate-plans/:ratePlanId/breakfast',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Fruehstueck im Ratenpreis setzen',
    handler: async (req) => {
      const { propertyId, ratePlanId } = req.params as { propertyId: string; ratePlanId: string }
      const plan = Number(ratePlanId)
      if (!Number.isSafeInteger(plan) || plan <= 0) {
        throw Errors.validation({ ratePlanId: ['field.positiveInteger'] })
      }
      const body = (req.body ?? {}) as { breakfastCent?: unknown; childBreakfastCent?: unknown }
      const wert = body.breakfastCent ?? null
      if (wert !== null
          && !(typeof wert === 'number' && Number.isInteger(wert)
               && wert >= BREAKFAST_MIN && wert <= BREAKFAST_MAX)) {
        throw Errors.validation({ breakfastCent: ['field.range'] },
          { min: '0,01 €', max: '1.000,00 €' })
      }
      // Ohne Fruehstueck gibt es auch keinen Kinderpreis; 0 heisst frei.
      const kind = wert === null ? null : body.childBreakfastCent ?? null
      if (kind !== null
          && !(typeof kind === 'number' && Number.isInteger(kind)
               && kind >= 0 && kind <= BREAKFAST_MAX)) {
        throw Errors.validation({ childBreakfastCent: ['field.range'] },
          { min: '0,00 €', max: '1.000,00 €' })
      }
      return tx(req.pool, req, async client => {
        await assertPlan(client, Number(propertyId), plan)
        await client.query(
          `UPDATE rate_plan SET breakfast_cent = $3, breakfast_child_cent = $4
            WHERE id = $1 AND property_id = $2`,
          [plan, Number(propertyId), wert, kind])
        return { ratePlanId: plan, breakfastCent: wert, childBreakfastCent: kind }
      })
    }
  })

  /**
   * Weitere Inklusivleistungen der Rate setzen: Parken, Sauna, Sekt zur
   * Anreise (Migration 0165). Die Liste ersetzt die bisherige.
   *
   * Gespeichert wird im Modell, das es seit 0007 gibt -- `product` und
   * `rate_plan_product` --, weil die Anzahlung schon daraus rechnet. Je
   * Platz in der Liste ein Produkt mit festem Kuerzel; eine entfernte
   * Leistung wird stillgelegt, nicht geloescht, denn gebuchte Zeilen und
   * das Protokoll verweisen auf sie. Das Erloeskonto folgt dem Satz, wie
   * beim Fruehstueck: der DATEV-Stapel setzt keinen Steuerschluessel, das
   * Konto traegt den Satz. Wirkt ab der naechsten Nacht.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/rate-plans/:ratePlanId/inclusions',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Inklusivleistungen im Ratenpreis setzen',
    handler: async (req) => {
      const { propertyId, ratePlanId } = req.params as { propertyId: string; ratePlanId: string }
      const haus = Number(propertyId)
      const plan = Number(ratePlanId)
      if (!Number.isSafeInteger(plan) || plan <= 0) {
        throw Errors.validation({ ratePlanId: ['field.positiveInteger'] })
      }
      const liste = inklusivPruefen((req.body as { inclusions?: unknown } | null)?.inclusions)
      return tx(req.pool, req, async client => {
        await assertPlan(client, haus, plan)
        const saetze = new Map((await umsatzsteuer(client, haus)).map(r => [r.id, r.rateBp]))
        const fehler: Record<string, Meldung[]> = {}
        liste.forEach((l, i) => {
          if (!saetze.has(l.taxRuleId)) fehler[`inclusions.${i}.taxRuleId`] = ['field.invalid']
        })
        if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

        const ids: number[] = []
        for (const [i, l] of liste.entries()) {
          const r = await client.query<{ id: number }>(
            `INSERT INTO product (property_id, code, name, price_cent, tax_rule_id, charge_mode,
                                  revenue_account, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true)
             ON CONFLICT (property_id, code) DO UPDATE
               SET name = EXCLUDED.name, price_cent = EXCLUDED.price_cent,
                   tax_rule_id = EXCLUDED.tax_rule_id, charge_mode = EXCLUDED.charge_mode,
                   revenue_account = EXCLUDED.revenue_account, active = true,
                   split_tax_rule_id = NULL, split_share_bp = NULL
             RETURNING id::int`,
            [haus, `INKL-${plan}-${i + 1}`, l.name, l.grossCent, l.taxRuleId, l.chargeMode,
             kontoFuerSatz(saetze.get(l.taxRuleId)!)])
          ids.push(r.rows[0]!.id)
        }
        await client.query(
          `UPDATE product SET active = false
            WHERE property_id = $1 AND code LIKE $2 AND NOT (id = ANY($3::bigint[]))`,
          [haus, `INKL-${plan}-%`, ids])
        await client.query(`DELETE FROM rate_plan_product WHERE rate_plan_id = $1`, [plan])
        if (ids.length > 0) {
          await client.query(
            `INSERT INTO rate_plan_product (rate_plan_id, product_id, property_id)
             SELECT $1, unnest($2::bigint[]), $3`, [plan, ids, haus])
        }
        return { ratePlanId: plan, inclusions: liste }
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
