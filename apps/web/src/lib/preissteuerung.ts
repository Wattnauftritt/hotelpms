import type { SteerRule, SteerRuleKind, SteerPreviewCell } from '@hotelpms/contracts'
import { centAusEingabe, wochentagKuerzel } from './preisraster.js'
import { intlTag, formatDate, formatMoney, type Locale, type TextKey } from './i18n/index.js'

/**
 * Die Rechenarbeit hinter der Preissteuerung, ohne React und ohne Netz.
 *
 * Hier liegt, was falsch sein kann, ohne dass man es sieht: die Umrechnung
 * eines Prozentsatzes in Basispunkte, der Satz, den eine Regel in der
 * Oberflaeche bildet, und die Nutzlast, die zur API geht. **Gerechnet wird
 * nicht hier**, sondern in der Datenbank (Migration 0066): die Oberflaeche
 * zeigt, was die Vorschau sagt, und rechnet es nicht nach.
 */

/**
 * Ein Prozentsatz als Basispunkte: "20" ist 2000, "12,5" ist 1250.
 *
 * Dieselbe Ziffernrechnung wie bei Cent -- ein Prozent hat hundert
 * Basispunkte, wie ein Euro hundert Cent --, also nie ueber Fliesskomma:
 * `parseFloat('12.35') * 100` ist 1234.9999.
 */
export function bpAusEingabe(text: string): number | null {
  return centAusEingabe(text.replace('%', ''))
}

/** Basispunkte als Prozentzahl in der Sprache des Betrachters, ohne Zeichen. */
export function prozentText(bp: number, locale: Locale): string {
  return new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: 2 })
    .format(Math.abs(bp) / 100)
}

/** Basispunkte als Eingabetext, fuer das Vorbelegen eines Feldes. */
export function eingabeAusBp(bp: number | null): string {
  if (bp === null) return ''
  const v = Math.abs(bp)
  const rest = v % 100
  return rest === 0 ? String(v / 100)
    : `${Math.floor(v / 100)},${String(rest).padStart(2, '0').replace(/0$/, '')}`
}

type Uebersetzer = (key: TextKey, params?: Record<string, string | number>) => string

/** Die Bedingungen einer Regel als Satzteile, der Ausloeser zuerst. */
export function bedingungen(r: SteerRule, t: Uebersetzer, locale: Locale): string[] {
  const teile: Record<SteerRuleKind, string[]> = {
    occupancy: [], lead_time: [], weekday: [], period: []
  }
  const haus = r.occupancyScope === 'house'
  if (r.occupancyMinBp !== null) {
    teile.occupancy.push(t(haus ? 'steer.cond.occMin.house' : 'steer.cond.occMin.category',
      { pct: prozentText(r.occupancyMinBp, locale) }))
  }
  if (r.occupancyBelowBp !== null) {
    teile.occupancy.push(t(haus ? 'steer.cond.occBelow.house' : 'steer.cond.occBelow.category',
      { pct: prozentText(r.occupancyBelowBp, locale) }))
  }
  if (r.leadMinDays !== null) {
    teile.lead_time.push(t('steer.cond.leadMin', { n: r.leadMinDays }))
  }
  if (r.leadBelowDays !== null) {
    teile.lead_time.push(t('steer.cond.leadBelow', { n: r.leadBelowDays }))
  }
  if (r.weekdays !== null) {
    teile.weekday.push(t('steer.cond.weekdays',
      { tage: r.weekdays.map(w => wochentagKuerzel(w, locale)).join(', ') }))
  }
  if (r.periodFrom !== null && r.periodTo !== null) {
    teile.period.push(t('steer.cond.period',
      { von: formatDate(r.periodFrom, locale), bis: formatDate(r.periodTo, locale) }))
  }
  const reihenfolge: SteerRuleKind[] = [r.kind,
    ...(['occupancy', 'lead_time', 'weekday', 'period'] as const).filter(k => k !== r.kind)]
  return reihenfolge.flatMap(k => teile[k])
}

/** Die Wirkung als Satzteil: "Preis +20 %", "Preis −15,00 €". */
export function wirkung(r: Pick<SteerRule, 'effectKind' | 'effectValue'>, t: Uebersetzer,
                        locale: Locale): string {
  const hoch = r.effectValue > 0
  return r.effectKind === 'percent'
    ? t(hoch ? 'steer.effect.percentUp' : 'steer.effect.percentDown',
        { v: prozentText(r.effectValue, locale) })
    : t(hoch ? 'steer.effect.amountUp' : 'steer.effect.amountDown',
        { v: formatMoney(Math.abs(r.effectValue), locale) })
}

/**
 * Eine Regel als Satz: "Wenn die Belegung der Kategorie mindestens 85 %
 * betraegt, Preis +20 %".
 *
 * Aus Satzteilen mit Platzhaltern, nie aus zusammengesetzten Woertern: in
 * jeder Sprache mit anderer Wortstellung ergaebe das sonst Unsinn.
 */
export function regelSatz(r: SteerRule, t: Uebersetzer, locale: Locale): string {
  return t('steer.sentence', {
    bedingungen: bedingungen(r, t, locale).join(t('steer.and')),
    wirkung: wirkung(r, t, locale)
  })
}

/** Was eine Regel in der Maske ist: Texte, wie getippt. */
export interface RegelEingabe {
  name: string
  kind: SteerRuleKind
  ziel: 'alle' | `plan:${number}` | `kategorie:${number}`
  occupancyScope: 'category' | 'house'
  occMin: string
  occBelow: string
  leadMin: string
  leadBelow: string
  weekdays: number[]
  periodFrom: string
  periodTo: string
  richtung: 'hoch' | 'runter'
  effectKind: 'percent' | 'amount'
  wert: string
  active: boolean
}

export const LEERE_REGEL: RegelEingabe = {
  name: '', kind: 'occupancy', ziel: 'alle', occupancyScope: 'category',
  occMin: '', occBelow: '', leadMin: '', leadBelow: '', weekdays: [],
  periodFrom: '', periodTo: '', richtung: 'hoch', effectKind: 'percent', wert: '',
  active: true
}

/** Eine gespeicherte Regel zurueck in die Maske. */
export function eingabeAusRegel(r: SteerRule): RegelEingabe {
  const wert = Math.abs(r.effectValue)
  return {
    name: r.name ?? '',
    kind: r.kind,
    ziel: r.ratePlanId !== null ? `plan:${r.ratePlanId}`
      : r.categoryId !== null ? `kategorie:${r.categoryId}` : 'alle',
    occupancyScope: r.occupancyScope,
    occMin: eingabeAusBp(r.occupancyMinBp),
    occBelow: eingabeAusBp(r.occupancyBelowBp),
    leadMin: r.leadMinDays === null ? '' : String(r.leadMinDays),
    leadBelow: r.leadBelowDays === null ? '' : String(r.leadBelowDays),
    weekdays: r.weekdays ?? [],
    periodFrom: r.periodFrom ?? '',
    periodTo: r.periodTo ?? '',
    richtung: r.effectValue < 0 ? 'runter' : 'hoch',
    effectKind: r.effectKind,
    wert: r.effectKind === 'percent' ? eingabeAusBp(wert)
      : `${Math.floor(wert / 100)},${String(wert % 100).padStart(2, '0')}`,
    active: r.active
  }
}

function tageAus(text: string): number | null | 'ungueltig' {
  if (text.trim() === '') return null
  const n = Number(text.trim())
  return Number.isInteger(n) && n >= 0 ? n : 'ungueltig'
}

/**
 * Die Maske als Nutzlast. `null`, solange sie nicht vollstaendig ist -- die
 * genaue Pruefung macht die API und nennt das Feld; hier geht es nur darum,
 * keinen Knopf anzubieten, der sicher mit 422 antwortet.
 */
export function regelNutzlast(e: RegelEingabe): SteerRule | null {
  const occMin = e.occMin.trim() === '' ? null : bpAusEingabe(e.occMin)
  const occBelow = e.occBelow.trim() === '' ? null : bpAusEingabe(e.occBelow)
  if ((e.occMin.trim() !== '' && occMin === null)
      || (e.occBelow.trim() !== '' && occBelow === null)) return null
  const leadMin = tageAus(e.leadMin)
  const leadBelow = tageAus(e.leadBelow)
  if (leadMin === 'ungueltig' || leadBelow === 'ungueltig') return null
  const zeitraum = e.periodFrom !== '' && e.periodTo !== ''
  if ((e.periodFrom !== '') !== (e.periodTo !== '')) return null

  const betrag = e.effectKind === 'percent' ? bpAusEingabe(e.wert) : centAusEingabe(e.wert)
  if (betrag === null || betrag === 0) return null

  const bedingung = e.kind === 'occupancy' ? occMin !== null || occBelow !== null
    : e.kind === 'lead_time' ? leadMin !== null || leadBelow !== null
    : e.kind === 'weekday' ? e.weekdays.length > 0
    : zeitraum
  if (!bedingung) return null

  const [art, id] = e.ziel.split(':')
  return {
    name: e.name.trim() === '' ? null : e.name.trim(),
    ratePlanId: art === 'plan' ? Number(id) : null,
    categoryId: art === 'kategorie' ? Number(id) : null,
    kind: e.kind,
    occupancyScope: e.occupancyScope,
    occupancyMinBp: occMin,
    occupancyBelowBp: occBelow,
    leadMinDays: leadMin,
    leadBelowDays: leadBelow,
    weekdays: e.weekdays.length > 0 ? [...e.weekdays].sort((a, b) => a - b) : null,
    periodFrom: zeitraum ? e.periodFrom : null,
    periodTo: zeitraum ? e.periodTo : null,
    effectKind: e.effectKind,
    effectValue: e.richtung === 'runter' ? -betrag : betrag,
    active: e.active
  }
}

/** Schluessel einer Zelle der Vorschau, fuer die Auswahl. */
export const zellSchluessel = (ratePlanId: number, date: string): string =>
  `${ratePlanId}|${date}`

/** Die Auswahl als Nutzlast, in der Reihenfolge der Vorschau. */
export function auswahlNutzlast(
  zellen: readonly SteerPreviewCell[], gewaehlt: ReadonlySet<string>
): Array<{ ratePlanId: number; date: string }> {
  return zellen
    .filter(z => z.changed && gewaehlt.has(zellSchluessel(z.ratePlanId, z.date)))
    .map(z => ({ ratePlanId: z.ratePlanId, date: z.date }))
}

/**
 * Der Preis einer Belegungsstufe. Fehlt die Stufe (ein Einzelzimmer hat
 * keinen Preis fuer zwei), zeigt die Vorschau die hoechste vorhandene statt
 * einer leeren Zelle, die wie "kein Preis" aussaehe.
 */
export function stufenpreis(preise: readonly number[], belegung: number): number | null {
  if (preise.length === 0) return null
  return preise[Math.min(belegung, preise.length) - 1] ?? null
}
