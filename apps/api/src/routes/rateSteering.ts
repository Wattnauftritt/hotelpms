import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import { STEER_MODES, PRICE_SOURCES, STEER_ROUNDINGS, STEER_RULE_KINDS,
         OCCUPANCY_SCOPES, STEER_MAX_HORIZON_DAYS,
         type SteerRule, type SteerPlanSettings } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'

/**
 * Preissteuerung (Dokument 32).
 *
 * Regeln, Leitplanken und Modus pflegen, die Vorschlaege eines Zeitraums
 * ansehen und uebernehmen. Gerechnet wird ausschliesslich in der Datenbank
 * (`rate_steer_preview`, `rate_steer_apply`, Migration 0066): dieselbe
 * Rechnung braucht der Worker, und der darf von hier nichts importieren.
 *
 * **Drei Rechte, drei Fragen.** Sehen ist `rate:read` -- wer Preise sehen
 * darf, darf sehen, was die Regeln daraus machen wuerden. Uebernehmen ist
 * `rate:write`, weil es genau das ist, was die Preispflege tut: einen
 * Verkaufspreis setzen, auf demselben Weg. Regeln, Leitplanken und den
 * automatischen Modus setzen ist `rate:steer`: das bewegt Preise ohne
 * weiteres Zutun, und ein Fehler darin verkauft ein Jahr lang falsch.
 */

/** Wie das Preisraster: ein Jahr und etwas Rand je Anfrage. */
const MAX_PREVIEW_DAYS = 400
/** Eine Uebernahme nennt hoechstens so viele Zellen einzeln. */
const MAX_APPLY_CELLS = 20_000
/** So viele Laeufe zeigt der Verlauf. Aelteres steht in der Tabelle. */
const RUN_HISTORY = 20

type Fehler = Record<string, Meldung[]>
/**
 * Die Werte zu den Platzhaltern der Meldungen. Eine Antwort hat **einen**
 * Satz davon fuer alle Felder; deshalb tragen nur die Meldungen Werte, bei
 * denen es auf sie ankommt (erlaubte Werte, Spanne der Wirkung), und die
 * uebrigen Felder heissen schlicht ungueltig.
 */
type Werte = Record<string, string | number>

const istGanzzahl = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
/** Ein Kalenderdatum als Zeichenkette -- nie durch `new Date` geschickt. */
const istDatum = (v: unknown): v is string => typeof v === 'string' && isIsoDate(v)

function optionalInt(
  body: Record<string, unknown>, feld: string, min: number, max: number, fehler: Fehler
): number | null {
  const v = body[feld]
  if (v === undefined || v === null) return null
  if (!istGanzzahl(v) || v < min || v > max) {
    fehler[feld] = ['field.invalid']
    return null
  }
  return v
}

function auswahl<T extends string>(
  v: unknown, erlaubt: readonly T[], feld: string, fehler: Fehler, werte: Werte, standard?: T
): T {
  if ((v === undefined || v === null) && standard !== undefined) return standard
  if (typeof v === 'string' && (erlaubt as readonly string[]).includes(v)) return v as T
  fehler[feld] = ['field.allowedValues']
  werte.values = erlaubt.join(', ')
  return erlaubt[0]!
}

/**
 * Eine Regel aus dem Rumpf. Die Datenbank prueft dasselbe noch einmal
 * (Migration 0065); hier steht es, damit die Antwort das Feld nennt und
 * nicht den Namen einer Bedingung.
 */
function parseRule(raw: unknown): SteerRule {
  const body = (raw ?? {}) as Record<string, unknown>
  const fehler: Fehler = {}
  const werte: Werte = {}

  const name = typeof body.name === 'string' && body.name.trim() !== ''
    ? body.name.trim() : null
  if (name !== null && name.length > 80) fehler.name = ['field.invalid']

  const ratePlanId = optionalInt(body, 'ratePlanId', 1, Number.MAX_SAFE_INTEGER, fehler)
  const categoryId = optionalInt(body, 'categoryId', 1, Number.MAX_SAFE_INTEGER, fehler)
  if (ratePlanId !== null && categoryId !== null) {
    fehler.categoryId = ['field.eitherPlanOrCategory']
  }

  const kind = auswahl(body.kind, STEER_RULE_KINDS, 'kind', fehler, werte)
  const occupancyScope = auswahl(body.occupancyScope, OCCUPANCY_SCOPES, 'occupancyScope',
    fehler, werte, 'category')
  const occupancyMinBp = optionalInt(body, 'occupancyMinBp', 0, 20_000, fehler)
  const occupancyBelowBp = optionalInt(body, 'occupancyBelowBp', 1, 20_000, fehler)
  if (occupancyMinBp !== null && occupancyBelowBp !== null && occupancyMinBp >= occupancyBelowBp) {
    fehler.occupancyBelowBp = ['field.minNotAboveMax']
  }
  const leadMinDays = optionalInt(body, 'leadMinDays', 0, 365, fehler)
  const leadBelowDays = optionalInt(body, 'leadBelowDays', 1, 366, fehler)
  if (leadMinDays !== null && leadBelowDays !== null && leadMinDays >= leadBelowDays) {
    fehler.leadBelowDays = ['field.minNotAboveMax']
  }

  let weekdays: number[] | null = null
  if (body.weekdays !== undefined && body.weekdays !== null) {
    const w = body.weekdays
    if (!Array.isArray(w) || w.length === 0 || w.length > 7
        || w.some(d => !istGanzzahl(d) || d < 0 || d > 6)
        || new Set(w).size !== w.length) {
      fehler.weekdays = ['field.weekday']
    } else {
      weekdays = [...(w as number[])].sort((a, b) => a - b)
    }
  }

  let periodFrom: string | null = null
  let periodTo: string | null = null
  if (body.periodFrom != null || body.periodTo != null) {
    if (!istDatum(body.periodFrom) || !istDatum(body.periodTo)) {
      fehler.periodFrom = ['field.isoDate']
    } else if (body.periodTo < body.periodFrom) {
      fehler.periodTo = ['field.onOrAfterFrom']
    } else {
      periodFrom = body.periodFrom
      periodTo = body.periodTo
    }
  }

  // Der Ausloeser braucht seine Bedingung. Zusaetzliche Bedingungen anderer
  // Art sind erlaubt: "Anreise in weniger als drei Tagen und Belegung unter
  // 40 %" ist eine Vorlaufregel mit Belegungsbedingung.
  const bedingung =
    kind === 'occupancy' ? occupancyMinBp !== null || occupancyBelowBp !== null
    : kind === 'lead_time' ? leadMinDays !== null || leadBelowDays !== null
    : kind === 'weekday' ? weekdays !== null
    : periodFrom !== null
  if (!bedingung && fehler.kind === undefined) fehler.kind = ['field.conditionForKind']

  const effectKind = auswahl(body.effectKind, ['percent', 'amount'] as const, 'effectKind',
    fehler, werte)
  const effectValue = body.effectValue
  // Prozent in Basispunkten, Betrag in Cent (Migration 0065).
  const [min, max] = effectKind === 'percent' ? [-9000, 20_000] : [-100_000, 100_000]
  if (!istGanzzahl(effectValue) || effectValue === 0 || effectValue < min || effectValue > max) {
    fehler.effectValue = ['field.range']
    werte.min = min
    werte.max = max
  }

  if (Object.keys(fehler).length > 0) throw Errors.validation(fehler, werte)
  return {
    name, ratePlanId, categoryId, kind, occupancyScope, occupancyMinBp, occupancyBelowBp,
    leadMinDays, leadBelowDays, weekdays, periodFrom, periodTo,
    effectKind, effectValue: effectValue as number,
    active: body.active === undefined ? true : body.active === true
  }
}

/**
 * Ratenplan und Kategorie gehoeren zu diesem Haus.
 *
 * Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus: ein Plan eines
 * anderen Hauses desselben Accounts laege im Kontext und kaeme durch
 * (CLAUDE.md, Mandantentrennung). Die zusammengesetzten Fremdschluessel
 * (0065) fingen es ebenfalls ab, aber als Fehler 500.
 */
async function assertTarget(
  client: PoolClient, propertyId: number, rule: SteerRule
): Promise<void> {
  if (rule.ratePlanId !== null) {
    const r = await client.query(
      `SELECT 1 FROM rate_plan WHERE id = $1 AND property_id = $2`, [rule.ratePlanId, propertyId])
    if (r.rowCount === 0) throw Errors.notFound('res.ratePlan')
  }
  if (rule.categoryId !== null) {
    const r = await client.query(
      `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2`,
      [rule.categoryId, propertyId])
    if (r.rowCount === 0) throw Errors.notFound('res.category')
  }
}

const RULE_COLUMNS = `
  id, name, rate_plan_id AS "ratePlanId", category_id AS "categoryId", kind,
  occupancy_scope AS "occupancyScope", occupancy_min_bp AS "occupancyMinBp",
  occupancy_below_bp AS "occupancyBelowBp", lead_min_days AS "leadMinDays",
  lead_below_days AS "leadBelowDays", weekdays,
  period_from::text AS "periodFrom", period_to::text AS "periodTo",
  effect_kind AS "effectKind", effect_value AS "effectValue", active`

function ruleParams(propertyId: number, r: SteerRule): unknown[] {
  return [propertyId, r.ratePlanId, r.categoryId, r.name, r.kind, r.occupancyScope,
          r.occupancyMinBp, r.occupancyBelowBp, r.leadMinDays, r.leadBelowDays,
          r.weekdays, r.periodFrom, r.periodTo, r.effectKind, r.effectValue, r.active]
}

export function rateSteeringRoutes(app: FastifyInstance): void {
  /**
   * Der ganze Bildschirm in einem Aufruf: Modus, Plaene mit Quelle und
   * Leitplanken, Regeln, die letzten Laeufe. Vier Abfragen, keine je Zeile.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-steering',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Einstellung, Plaene, Regeln, letzte Laeufe',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const kopf = await client.query<{
          mode: string; horizon_days: number; business_date: string | null }>(
          `SELECT coalesce(s.mode, 'suggest') AS mode,
                  coalesce(s.horizon_days, 365) AS horizon_days,
                  (SELECT bd.date::text FROM business_day bd
                    WHERE bd.property_id = $1 AND bd.status = 'open'
                    ORDER BY bd.date LIMIT 1) AS business_date
             FROM (SELECT $1::bigint AS property_id) p
             LEFT JOIN rate_steer_setting s ON s.property_id = p.property_id`, [propertyId])
        const plans = await client.query(
          `SELECT rp.id AS "ratePlanId", rp.code, rp.name, rp.category_id AS "categoryId",
                  c.code AS "categoryCode", rp.base_rate_plan_id IS NOT NULL AS derived,
                  coalesce(s.source, 'manual') AS source, s.min_cent AS "minCent",
                  s.max_cent AS "maxCent", coalesce(s.rounding, 'euro') AS rounding,
                  s.max_step_bp AS "maxStepBp"
             FROM rate_plan rp
             JOIN resource_category c ON c.id = rp.category_id
             LEFT JOIN rate_plan_steering s ON s.rate_plan_id = rp.id
            WHERE rp.property_id = $1 AND rp.active
            ORDER BY c.code, rp.code`, [propertyId])
        const rules = await client.query(
          `SELECT ${RULE_COLUMNS} FROM rate_steer_rule
            WHERE property_id = $1 AND archived_at IS NULL
            ORDER BY kind, id`, [propertyId])
        const runs = await client.query(
          `SELECT r.id AS "runId", r.kind, r.mode, r.business_date::text AS "businessDate",
                  r.date_from::text AS "from", r.date_to::text AS "to",
                  r.changed_days AS "changedDays",
                  to_char(r.created_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
                  u.display_name AS "userName"
             FROM rate_steer_run r LEFT JOIN app_user u ON u.id = r.user_id
            WHERE r.property_id = $1
            ORDER BY r.created_at DESC, r.id DESC LIMIT ${RUN_HISTORY}`, [propertyId])
        const k = kopf.rows[0]!
        return {
          mode: k.mode, horizonDays: k.horizon_days, businessDate: k.business_date,
          plans: plans.rows, rules: rules.rows, runs: runs.rows
        }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/rate-steering',
    permission: 'rate:steer',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Modus und Horizont setzen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const body = (req.body ?? {}) as Record<string, unknown>
      const fehler: Fehler = {}
      const werte: Werte = {}
      const mode = auswahl(body.mode, STEER_MODES, 'mode', fehler, werte)
      const horizonDays = optionalInt(body, 'horizonDays', 1, STEER_MAX_HORIZON_DAYS, fehler)
        ?? STEER_MAX_HORIZON_DAYS
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler, werte)
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO rate_steer_setting (property_id, mode, horizon_days)
           VALUES ($1, $2, $3)
           ON CONFLICT (property_id) DO UPDATE
              SET mode = EXCLUDED.mode, horizon_days = EXCLUDED.horizon_days,
                  updated_at = now()`, [propertyId, mode, horizonDays])
        return { mode, horizonDays }
      })
    }
  })

  /**
   * Quelle und Leitplanken eines Ratenplans. Ganz ersetzt, nicht teilweise:
   * eine Leitplanke, die man leert, soll danach fehlen und nicht stehen
   * bleiben, weil das Feld im Rumpf nicht vorkam.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/rate-steering/plans/:ratePlanId',
    permission: 'rate:steer',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Quelle und Leitplanken eines Ratenplans',
    handler: async (req) => {
      const { propertyId: p, ratePlanId: rp } =
        req.params as { propertyId: string; ratePlanId: string }
      const propertyId = Number(p)
      const ratePlanId = Number(rp)
      const body = (req.body ?? {}) as Record<string, unknown>
      const fehler: Fehler = {}
      const werte: Werte = {}
      const s: SteerPlanSettings = {
        source: auswahl(body.source, PRICE_SOURCES, 'source', fehler, werte),
        minCent: optionalInt(body, 'minCent', 0, 10_000_000, fehler),
        maxCent: optionalInt(body, 'maxCent', 0, 10_000_000, fehler),
        rounding: auswahl(body.rounding, STEER_ROUNDINGS, 'rounding', fehler, werte, 'euro'),
        // Mindestens ein Prozent: darunter bewegte sich ein gerundeter Preis nie.
        maxStepBp: optionalInt(body, 'maxStepBp', 100, 10_000, fehler)
      }
      if (s.minCent !== null && s.maxCent !== null && s.minCent > s.maxCent) {
        fehler.maxCent = ['field.minNotAboveMax']
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler, werte)
      return tx(req.pool, req, async client => {
        const plan = await client.query<{ derived: boolean }>(
          `SELECT base_rate_plan_id IS NOT NULL AS derived FROM rate_plan
            WHERE id = $1 AND property_id = $2`, [ratePlanId, propertyId])
        if (plan.rowCount === 0) throw Errors.notFound('res.ratePlan')
        if (plan.rows[0]!.derived && s.source !== 'manual') {
          throw Errors.validation({ source: ['field.notForDerivedPlan'] })
        }
        await client.query(
          `INSERT INTO rate_plan_steering
             (rate_plan_id, property_id, source, min_cent, max_cent, rounding, max_step_bp)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (rate_plan_id) DO UPDATE
              SET source = EXCLUDED.source, min_cent = EXCLUDED.min_cent,
                  max_cent = EXCLUDED.max_cent, rounding = EXCLUDED.rounding,
                  max_step_bp = EXCLUDED.max_step_bp, updated_at = now()`,
          [ratePlanId, propertyId, s.source, s.minCent, s.maxCent, s.rounding, s.maxStepBp])
        return { ratePlanId, ...s }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-steering/rules',
    permission: 'rate:steer',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Regel anlegen',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const rule = parseRule(req.body)
      return tx(req.pool, req, async client => {
        await assertTarget(client, propertyId, rule)
        const r = await client.query<{ id: number }>(
          `INSERT INTO rate_steer_rule
             (property_id, rate_plan_id, category_id, name, kind, occupancy_scope,
              occupancy_min_bp, occupancy_below_bp, lead_min_days, lead_below_days,
              weekdays, period_from, period_to, effect_kind, effect_value, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::smallint[],$12::date,$13::date,
                   $14,$15,$16)
           RETURNING id`, ruleParams(propertyId, rule))
        reply.status(201)
        return { ruleId: r.rows[0]!.id }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/rate-steering/rules/:ruleId',
    permission: 'rate:steer',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Regel aendern',
    handler: async (req) => {
      const { propertyId: p, ruleId: id } = req.params as { propertyId: string; ruleId: string }
      const propertyId = Number(p)
      const rule = parseRule(req.body)
      return tx(req.pool, req, async client => {
        await assertTarget(client, propertyId, rule)
        const r = await client.query(
          `UPDATE rate_steer_rule SET
              rate_plan_id = $2, category_id = $3, name = $4, kind = $5,
              occupancy_scope = $6, occupancy_min_bp = $7, occupancy_below_bp = $8,
              lead_min_days = $9, lead_below_days = $10, weekdays = $11::smallint[],
              period_from = $12::date, period_to = $13::date, effect_kind = $14,
              effect_value = $15, active = $16, updated_at = now()
            WHERE id = $17 AND property_id = $1 AND archived_at IS NULL`,
          [...ruleParams(propertyId, rule), Number(id)])
        if (r.rowCount === 0) throw Errors.notFound('res.steerRule')
        return { ruleId: Number(id) }
      })
    }
  })

  /**
   * Entfernen heisst stilllegen und ausblenden. Der Verlauf nennt die Regel
   * weiter, die einen Preis bewegt hat -- geloescht hiesse er "Regel 12",
   * und niemand wuesste mehr, was sie tat.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/rate-steering/rules/:ruleId',
    permission: 'rate:steer',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Regel entfernen',
    handler: async (req) => {
      const { propertyId, ruleId } = req.params as { propertyId: string; ruleId: string }
      return tx(req.pool, req, async client => {
        const r = await client.query(
          `UPDATE rate_steer_rule SET archived_at = now(), active = false, updated_at = now()
            WHERE id = $1 AND property_id = $2 AND archived_at IS NULL`,
          [Number(ruleId), Number(propertyId)])
        if (r.rowCount === 0) throw Errors.notFound('res.steerRule')
        return { ok: true }
      })
    }
  })

  /**
   * Die Vorschau eines Zeitraums. Eine Anweisung fuer alle Tage und Plaene;
   * die Oberflaeche baut daraus ihr Kalenderraster.
   *
   * Beschnitten auf Geschaeftstag und Horizont: die Vergangenheit steuert
   * niemand, und weiter als der Horizont reicht auch der Worker nicht.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-steering/preview',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Vorschlaege fuer einen Zeitraum',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { from?: string; to?: string }
      if (!istDatum(q.from) || !istDatum(q.to)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      const tage = nightsBetween(q.from, q.to) + 1
      if (tage <= 0) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
      if (tage > MAX_PREVIEW_DAYS) throw Errors.rangeTooLarge(MAX_PREVIEW_DAYS)

      return tx(req.pool, req, async client => {
        const k = await client.query<{ bd: string | null; from: string; to: string }>(
          `SELECT bd.date::text AS bd,
                  greatest($2::date, bd.date)::text AS "from",
                  least($3::date, bd.date + coalesce(s.horizon_days, 365) - 1)::text AS "to"
             FROM (SELECT $1::bigint AS property_id) p
             LEFT JOIN LATERAL (SELECT date FROM business_day
                                 WHERE property_id = p.property_id AND status = 'open'
                                 ORDER BY date LIMIT 1) bd ON true
             LEFT JOIN rate_steer_setting s ON s.property_id = p.property_id`,
          [propertyId, q.from, q.to])
        const kopf = k.rows[0]!
        if (kopf.bd === null) throw Errors.unprocessable('report.noOpenBusinessDay')

        const r = await client.query<{
          ratePlanId: number; date: string; leadDays: number
          occupancyBp: number | null; houseOccupancyBp: number | null
          currentCent: number[]; baseCent: number[]; suggestedCent: number[]
          ruleIds: number[]; changed: boolean; token: string }>(
          `SELECT rate_plan_id AS "ratePlanId", date::text, lead_days AS "leadDays",
                  occupancy_bp AS "occupancyBp", house_occupancy_bp AS "houseOccupancyBp",
                  current_cent AS "currentCent", base_cent AS "baseCent",
                  new_cent AS "suggestedCent", rule_ids AS "ruleIds", changed, token
             FROM rate_steer_preview($1, $2::date, $3::date, $4::date)`,
          [propertyId, kopf.from, kopf.to, kopf.bd])
        // Ohne vorgeschlagene Aenderung ist der Fingerabdruck der der leeren
        // Menge -- dieselbe Festlegung wie in rate_steer_apply.
        const token = r.rows[0]?.token ?? LEERER_FINGERABDRUCK
        return {
          from: kopf.from, to: kopf.to, businessDate: kopf.bd, token,
          cells: r.rows.map(({ token: _t, ...zelle }) => zelle)
        }
      })
    }
  })

  /**
   * Vorschlaege uebernehmen, alle oder ausgewaehlte.
   *
   * Mit dem Fingerabdruck der Vorschau: hat sich seither eine Belegung oder
   * ein Preis bewegt, wird nichts uebernommen (409) -- sonst setzte der Knopf
   * Preise, die niemand gesehen hat. Pruefung und Uebernahme sind **eine**
   * Anweisung in der Datenbank, damit dazwischen nichts passieren kann.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/rate-steering/apply',
    permission: 'rate:write',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Vorschlaege uebernehmen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const body = (req.body ?? {}) as {
        from?: string; to?: string; token?: string
        cells?: Array<{ ratePlanId: number; date: string }> }
      if (!istDatum(body.from) || !istDatum(body.to)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      const tage = nightsBetween(body.from, body.to) + 1
      if (tage <= 0) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
      if (tage > MAX_PREVIEW_DAYS) throw Errors.rangeTooLarge(MAX_PREVIEW_DAYS)
      if (typeof body.token !== 'string' || body.token === '') {
        throw Errors.validation({ token: ['field.required'] })
      }
      let plans: number[] | null = null
      let dates: string[] | null = null
      if (body.cells !== undefined) {
        if (!Array.isArray(body.cells) || body.cells.length > MAX_APPLY_CELLS
            || body.cells.some(c => !istGanzzahl(c?.ratePlanId) || !istDatum(c?.date))) {
          throw Errors.validation({ cells: ['field.invalid'] })
        }
        plans = body.cells.map(c => c.ratePlanId)
        dates = body.cells.map(c => c.date)
      }

      return tx(req.pool, req, async client => {
        const r = await client.query<{
          run_id: number | null; changed: number; token: string | null
          business_date: string | null }>(
          `SELECT run_id, changed, token, business_date::text
             FROM rate_steer_apply($1, 'apply', $2::date, $3::date, $4,
                                   $5::bigint[], $6::date[])`,
          [propertyId, body.from, body.to, body.token, plans, dates])
        const e = r.rows[0]!
        if (e.business_date === null) throw Errors.unprocessable('report.noOpenBusinessDay')
        if (e.token !== body.token) throw Errors.conflict('rateSteer.previewStale')
        return { runId: e.run_id, changed: e.changed }
      })
    }
  })

  /** Was ein Lauf geaendert hat: Plan, Tag, alt -> neu, Grundpreis, Regeln. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rate-steering/runs/:runId',
    permission: 'rate:read',
    propertyParam: 'propertyId',
    summary: 'Preissteuerung: Aenderungen eines Laufs',
    handler: async (req) => {
      const { propertyId, runId } = req.params as { propertyId: string; runId: string }
      return tx(req.pool, req, async client => {
        const run = await client.query(
          `SELECT 1 FROM rate_steer_run WHERE id = $1 AND property_id = $2`,
          [Number(runId), Number(propertyId)])
        if (run.rowCount === 0) throw Errors.notFound('res.steerRun')
        const { rows } = await client.query(
          `SELECT rate_plan_id AS "ratePlanId", date::text, old_cent AS "oldCent",
                  new_cent AS "newCent", base_cent AS "baseCent", rule_ids AS "ruleIds",
                  occupancy_bp AS "occupancyBp"
             FROM rate_steer_change WHERE run_id = $1 AND property_id = $2
            ORDER BY rate_plan_id, date`, [Number(runId), Number(propertyId)])
        // Auch archivierte Regeln: der Verlauf nennt, was damals gewirkt hat.
        const rules = await client.query(
          `SELECT ${RULE_COLUMNS} FROM rate_steer_rule
            WHERE property_id = $1
              AND id IN (SELECT DISTINCT unnest(rule_ids) FROM rate_steer_change
                          WHERE run_id = $2 AND property_id = $1)`,
          [Number(propertyId), Number(runId)])
        return { runId: Number(runId), changes: rows, rules: rules.rows }
      })
    }
  })
}

/** md5 der leeren Zeichenkette, wie `md5('')` in rate_steer_apply. */
const LEERER_FINGERABDRUCK = 'd41d8cd98f00b204e9800998ecf8427e'
