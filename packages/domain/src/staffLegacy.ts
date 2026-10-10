import { createHash } from 'node:crypto'
import { isIsoDate } from './dates.js'

/**
 * Datei der alten Personal-App lesen (Aufgabe 18, Baustein 9; Dokument 34).
 *
 * Nur Form und Vollstaendigkeit: was eine Zeile in StayGrid wird, entscheidet
 * die Route, weil sie Zimmer, Personen und abgeschlossene Monate kennt. Hier
 * faellt alles durch, was nicht dem Vertrag entspricht -- lieber gar nichts
 * uebernehmen als einen Monat mit weniger Arbeit, weil die Datei
 * abgeschnitten war.
 */

export const LEGACY_STAFF_FORMAT = 'zurseerobbe-staygrid'
export const LEGACY_STAFF_SCHEMA = 1

/** Hoechstens 31 Tage zu 1440 Minuten, wie `staff_work_entry` fuer Altdaten (0119). */
export const LEGACY_WORK_MINUTES_MAX = 44640

export type LegacyTaskStatus = 'open' | 'cleaned' | 'declined' | 'was_clean' | 'problem'
const STATUS: readonly LegacyTaskStatus[] = ['open', 'cleaned', 'declined', 'was_clean', 'problem']
const SPRACHEN = ['de', 'en', 'ru', 'uk'] as const
type Sprache = typeof SPRACHEN[number]

export interface LegacyStaff {
  username: string
  displayName: string | null
  status: 'active' | 'inactive'
  language: Sprache | null
}
export interface LegacySchedule {
  date: string
  room: string
  kind: 'departure' | 'stayover'
  username: string | null
  status: LegacyTaskStatus
  minutes: number
}
export interface LegacyWorkEntry {
  date: string
  username: string
  text: string
  minutes: number
  language: Sprache | null
  translationDe: string | null
  translationManual: boolean
}
export interface LegacyStaffExport {
  exportedAt: string
  since: string | null
  until: string
  staff: LegacyStaff[]
  schedules: LegacySchedule[]
  workEntries: LegacyWorkEntry[]
}

/** Was an der Datei nicht stimmt -- als Schluessel fuer den Katalog. */
export class LegacyStaffFormatError extends Error {
  constructor(readonly key: string, readonly params: Record<string, string | number> = {}) {
    super(key)
    this.name = 'LegacyStaffFormatError'
  }
}

/**
 * Kanonische Form wie `json.dumps(v, ensure_ascii=False, separators=(',', ':'),
 * sort_keys=True)` in Python: Schluessel sortiert, ohne Leerraum. Die
 * Zeichenketten maskieren beide Seiten gleich, solange niemand ASCII
 * erzwingt.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

export function legacyChecksum(rows: unknown[]): string {
  return createHash('sha256').update(canonicalJson(rows), 'utf8').digest('hex')
}

function feld(ok: boolean, gruppe: string, index: number, name: string): void {
  if (!ok) throw new LegacyStaffFormatError('staffImport.badRow', { group: gruppe, row: index + 1, field: name })
}
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max
const sprache = (v: unknown): Sprache | null =>
  (SPRACHEN as readonly unknown[]).includes(v) ? v as Sprache : null

export function parseLegacyStaffExport(raw: unknown): LegacyStaffExport {
  if (typeof raw !== 'object' || raw === null) throw new LegacyStaffFormatError('staffImport.notJson')
  const d = raw as Record<string, unknown>
  if (d.format !== LEGACY_STAFF_FORMAT) throw new LegacyStaffFormatError('staffImport.format')
  if (d.schemaVersion !== LEGACY_STAFF_SCHEMA) {
    throw new LegacyStaffFormatError('staffImport.schema', { version: String(d.schemaVersion) })
  }
  if (typeof d.until !== 'string' || !isIsoDate(d.until)) {
    throw new LegacyStaffFormatError('staffImport.badRow', { group: 'until', row: 0, field: 'until' })
  }
  if (d.since !== null && d.since !== undefined
      && (typeof d.since !== 'string' || !isIsoDate(d.since) || d.since > d.until)) {
    throw new LegacyStaffFormatError('staffImport.badRow', { group: 'since', row: 0, field: 'since' })
  }
  const manifest = (d.manifest ?? {}) as Record<string, { rows?: unknown; sha256?: unknown }>
  const gruppen = ['staff', 'schedules', 'workEntries'] as const
  for (const g of gruppen) {
    const zeilen = d[g]
    if (!Array.isArray(zeilen)) throw new LegacyStaffFormatError('staffImport.missingGroup', { group: g })
    const m = manifest[g]
    // Zeilenzahl und Pruefsumme: eine abgeschnittene Datei sieht sonst aus
    // wie ein Monat mit weniger Arbeit.
    if (m === undefined || m.rows !== zeilen.length || m.sha256 !== legacyChecksum(zeilen)) {
      throw new LegacyStaffFormatError('staffImport.checksum', { group: g })
    }
  }
  const since = typeof d.since === 'string' ? d.since : null
  const until = d.until
  const imAusschnitt = (date: unknown): boolean =>
    typeof date === 'string' && isIsoDate(date) && date <= until && (since === null || date >= since)

  const staff = (d.staff as unknown[]).map((r, i): LegacyStaff => {
    const s = r as Record<string, unknown>
    feld(text(s.username, 100), 'staff', i, 'username')
    feld(s.status === 'active' || s.status === 'inactive', 'staff', i, 'status')
    return {
      username: s.username as string,
      displayName: text(s.displayName, 200) ? s.displayName : null,
      status: s.status as 'active' | 'inactive',
      language: sprache(s.language)
    }
  })
  const schedules = (d.schedules as unknown[]).map((r, i): LegacySchedule => {
    const s = r as Record<string, unknown>
    feld(imAusschnitt(s.date), 'schedules', i, 'date')
    feld(text(s.room, 50), 'schedules', i, 'room')
    feld(s.kind === 'departure' || s.kind === 'stayover', 'schedules', i, 'kind')
    feld(s.username === null || text(s.username, 100), 'schedules', i, 'username')
    feld(STATUS.includes(s.status as LegacyTaskStatus), 'schedules', i, 'status')
    feld(Number.isInteger(s.minutes) && (s.minutes as number) >= 0
         && (s.minutes as number) <= 1440, 'schedules', i, 'minutes')
    return {
      date: s.date as string, room: (s.room as string).trim(),
      kind: s.kind as 'departure' | 'stayover', username: s.username as string | null,
      status: s.status as LegacyTaskStatus, minutes: s.minutes as number
    }
  })
  const workEntries = (d.workEntries as unknown[]).map((r, i): LegacyWorkEntry => {
    const w = r as Record<string, unknown>
    feld(imAusschnitt(w.date), 'workEntries', i, 'date')
    feld(text(w.username, 100), 'workEntries', i, 'username')
    feld(text(w.text, 500), 'workEntries', i, 'text')
    // Bis zu einem Monat: die alte App kannte Sammelbuchungen fuer nicht
    // erfasste Stunden ("Uneingetragenes", 4080 Minuten; Migration 0119).
    feld(Number.isInteger(w.minutes) && (w.minutes as number) >= 1
         && (w.minutes as number) <= LEGACY_WORK_MINUTES_MAX, 'workEntries', i, 'minutes')
    return {
      date: w.date as string, username: w.username as string, text: (w.text as string).trim(),
      minutes: w.minutes as number, language: sprache(w.language),
      translationDe: text(w.translationDe, 4000) ? (w.translationDe as string).trim() : null,
      translationManual: w.translationManual === true
    }
  })
  const doppelt = new Set<string>()
  schedules.forEach((s, i) => {
    const k = `${s.date}|${s.room}|${s.kind}`
    if (doppelt.has(k)) {
      throw new LegacyStaffFormatError('staffImport.duplicate',
        { row: i + 1, date: s.date, room: s.room })
    }
    doppelt.add(k)
  })
  return {
    exportedAt: typeof d.exportedAt === 'string' ? d.exportedAt : '',
    since, until, staff, schedules, workEntries
  }
}

/** Die Tage, die ersetzt werden: jeder Tag des Ausschnitts, auch ein leerer. */
export function legacyReplaceDays(e: LegacyStaffExport): { from: string; to: string } | null {
  const daten = [...e.schedules.map(s => s.date), ...e.workEntries.map(w => w.date)]
  const from = e.since ?? daten.reduce<string | null>((m, d) => m === null || d < m ? d : m, null)
  return from === null ? null : { from, to: e.until }
}

/** Status der Alt-App auf StayGrid (Dokument 34, Abschnitt 3). */
export function legacyTaskState(s: LegacyTaskStatus): {
  status: 'open' | 'done' | 'skipped'; outcome: 'cleaned' | 'declined' | 'was_clean' | null
} {
  switch (s) {
    case 'cleaned': return { status: 'done', outcome: 'cleaned' }
    case 'declined': return { status: 'skipped', outcome: 'declined' }
    case 'was_clean': return { status: 'skipped', outcome: 'was_clean' }
    default: return { status: 'open', outcome: null }
  }
}
