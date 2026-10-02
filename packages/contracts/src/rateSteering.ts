import { Type, type Static } from '@sinclair/typebox'
import { IsoDate, Cent } from './schemas.js'

/**
 * Preissteuerung (Dokument 32): was API und Oberflaeche einander schicken.
 *
 * Eine eigene Datei und nicht `schemas.ts`: die ist der Ort, an dem parallele
 * Bearbeiter am sichersten aneinandergeraten, und dieser Bereich ist in sich
 * geschlossen.
 */

export const STEER_MODES = ['suggest', 'auto'] as const
export type SteerMode = (typeof STEER_MODES)[number]

/**
 * Wem der Verkaufspreis eines Ratenplans gehoert. manual: wie bisher, jeder
 * mit `rate:write`. rules: die Steuerung; Menschen setzen den Grundpreis,
 * eine Schnittstelle wird abgewiesen. external: ein RMS ueber die
 * Schnittstelle; die Regeln lassen den Plan in Ruhe.
 */
export const PRICE_SOURCES = ['manual', 'rules', 'external'] as const
export type PriceSource = (typeof PRICE_SOURCES)[number]

/** none: centgenau. euro: volle Euro. ninety: auf ,90. */
export const STEER_ROUNDINGS = ['none', 'euro', 'ninety'] as const
export type SteerRounding = (typeof STEER_ROUNDINGS)[number]

/** Der Ausloeser einer Regel. Je Ausloeser wirkt die staerkste passende Regel. */
export const STEER_RULE_KINDS = ['occupancy', 'lead_time', 'weekday', 'period'] as const
export type SteerRuleKind = (typeof STEER_RULE_KINDS)[number]

export const OCCUPANCY_SCOPES = ['category', 'house'] as const
export type OccupancyScope = (typeof OCCUPANCY_SCOPES)[number]

/** Hoechstens so weit voraus wird gesteuert. */
export const STEER_MAX_HORIZON_DAYS = 365

const Nullable = <T extends ReturnType<typeof Type.Integer>>(t: T) =>
  Type.Union([t, Type.Null()])

/*
 * Eine Auswahl aus einer Liste fester Werte. Ueber `Type.Unsafe`, weil
 * `werte.map(...)` den statischen Typ zu `string` aufweitet -- in der
 * gebauten Fassung (`dist`) stand dann `source: string`, und die
 * Oberflaeche brach erst beim Bauen, nicht bei der Typpruefung der Quellen.
 */
const literals = <T extends readonly string[]>(werte: T) =>
  Type.Unsafe<T[number]>(Type.Union(werte.map(w => Type.Literal(w))))

/**
 * Eine Regel, so wie sie gepflegt und angezeigt wird.
 *
 * Schwellen in Basispunkten (8500 = 85 %), Prozentwirkung ebenso
 * (2000 = +20 %), Betragswirkung in Cent. Ganzzahlig, damit eine Schwelle
 * nicht an der Fliesskommadarstellung von 0,85 haengt.
 */
export const SteerRule = Type.Object({
  name: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  ratePlanId: Nullable(Type.Integer()),
  categoryId: Nullable(Type.Integer()),
  kind: literals(STEER_RULE_KINDS),
  occupancyScope: literals(OCCUPANCY_SCOPES),
  occupancyMinBp: Nullable(Type.Integer()),
  occupancyBelowBp: Nullable(Type.Integer()),
  leadMinDays: Nullable(Type.Integer()),
  leadBelowDays: Nullable(Type.Integer()),
  weekdays: Type.Union([Type.Array(Type.Integer({ minimum: 0, maximum: 6 })), Type.Null()]),
  periodFrom: Type.Union([IsoDate, Type.Null()]),
  periodTo: Type.Union([IsoDate, Type.Null()]),
  effectKind: Type.Union([Type.Literal('percent'), Type.Literal('amount')]),
  effectValue: Type.Integer(),
  active: Type.Boolean()
})
export type SteerRule = Static<typeof SteerRule>

export const SteerRuleRow = Type.Intersect([Type.Object({ id: Type.Integer() }), SteerRule])
export type SteerRuleRow = Static<typeof SteerRuleRow>

/** Quelle und Leitplanken eines Ratenplans. */
export const SteerPlanSettings = Type.Object({
  source: literals(PRICE_SOURCES),
  minCent: Nullable(Cent),
  maxCent: Nullable(Cent),
  rounding: literals(STEER_ROUNDINGS),
  maxStepBp: Nullable(Type.Integer())
})
export type SteerPlanSettings = Static<typeof SteerPlanSettings>

export const SteerPlan = Type.Intersect([
  Type.Object({
    ratePlanId: Type.Integer(),
    code: Type.String(),
    name: Type.String(),
    categoryId: Type.Integer(),
    categoryCode: Type.String(),
    /** Eine abgeleitete Rate folgt ihrer Basis und wird nie selbst gesteuert. */
    derived: Type.Boolean()
  }),
  SteerPlanSettings
])
export type SteerPlan = Static<typeof SteerPlan>

export const SteerRun = Type.Object({
  runId: Type.Integer(),
  kind: Type.Union([Type.Literal('auto'), Type.Literal('apply')]),
  mode: literals(STEER_MODES),
  businessDate: IsoDate,
  from: IsoDate,
  to: IsoDate,
  changedDays: Type.Integer(),
  createdAt: Type.String(),
  userName: Type.Union([Type.String(), Type.Null()])
})
export type SteerRun = Static<typeof SteerRun>

/** Alles, was der Bildschirm der Steuerung braucht, in einem Aufruf. */
export const SteeringOverview = Type.Object({
  mode: literals(STEER_MODES),
  horizonDays: Type.Integer(),
  businessDate: Type.Union([IsoDate, Type.Null()]),
  plans: Type.Array(SteerPlan),
  rules: Type.Array(SteerRuleRow),
  runs: Type.Array(SteerRun)
})
export type SteeringOverview = Static<typeof SteeringOverview>

/**
 * Eine Zelle der Vorschau: ein gesteuerter Plan an einem Tag.
 *
 * Preise je Belegung wie im Preisraster, Index 0 ist eine Person.
 * `baseCent` ist der Grundpreis, auf den gerechnet wird; `currentCent`, was
 * gerade verkauft wird; `suggestedCent`, was die Regeln daraus machen.
 */
export const SteerPreviewCell = Type.Object({
  ratePlanId: Type.Integer(),
  date: IsoDate,
  leadDays: Type.Integer(),
  occupancyBp: Nullable(Type.Integer()),
  houseOccupancyBp: Nullable(Type.Integer()),
  currentCent: Type.Array(Cent),
  baseCent: Type.Array(Cent),
  suggestedCent: Type.Array(Cent),
  ruleIds: Type.Array(Type.Integer()),
  changed: Type.Boolean()
})
export type SteerPreviewCell = Static<typeof SteerPreviewCell>

export const SteerPreview = Type.Object({
  from: IsoDate,
  to: IsoDate,
  businessDate: IsoDate,
  /** Fingerabdruck aller vorgeschlagenen Aenderungen; beim Uebernehmen mitschicken. */
  token: Type.String(),
  cells: Type.Array(SteerPreviewCell)
})
export type SteerPreview = Static<typeof SteerPreview>

export const SteerApply = Type.Object({
  from: IsoDate,
  to: IsoDate,
  token: Type.String(),
  /** Ohne Angabe alle vorgeschlagenen Aenderungen im Zeitraum. */
  cells: Type.Optional(Type.Array(Type.Object({ ratePlanId: Type.Integer(), date: IsoDate })))
})
export type SteerApply = Static<typeof SteerApply>

export const SteerRunChange = Type.Object({
  ratePlanId: Type.Integer(),
  date: IsoDate,
  oldCent: Type.Union([Type.Array(Cent), Type.Null()]),
  newCent: Type.Array(Cent),
  baseCent: Type.Array(Cent),
  ruleIds: Type.Array(Type.Integer()),
  occupancyBp: Nullable(Type.Integer())
})
export type SteerRunChange = Static<typeof SteerRunChange>
