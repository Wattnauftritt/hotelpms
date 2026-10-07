import { describe, it, expect } from 'vitest'
import { legacyChecksum, legacyReplaceDays, legacyTaskState, parseLegacyStaffExport,
         LegacyStaffFormatError } from '../staffLegacy.js'

describe('Altdaten der Personal-App', () => {
  it('rechnet die Pruefsumme wie Python (json.dumps, sort_keys, ensure_ascii=False)', () => {
    // Erwartung aus Python 3 mit genau der Zeile aus Dokument 34, Abschnitt 2.
    const rows = [{ username: 'olga', text: 'Сложила бельё "x"\n', minutes: 25,
                    translationManual: true, language: null, b: [1, { z: 1, a: 'ä' }] }]
    expect(legacyChecksum(rows))
      .toBe('f040a495c41187a9f3d59a97c6f071247296b172db58d7e470e73312dad7a2d4')
  })

  const datei = (o: Record<string, unknown> = {}) => {
    const staff: unknown[] = []
    const schedules = [{ date: '2026-09-30', room: '101', kind: 'departure', username: 'olga',
                         status: 'cleaned', minutes: 30 }]
    const workEntries: unknown[] = []
    return { format: 'zurseerobbe-staygrid', schemaVersion: 1, since: null, until: '2026-10-01',
      manifest: { staff: { rows: 0, sha256: legacyChecksum(staff) },
                  schedules: { rows: 1, sha256: legacyChecksum(schedules) },
                  workEntries: { rows: 0, sha256: legacyChecksum(workEntries) } },
      staff, schedules, workEntries, ...o }
  }

  it('liest eine gueltige Datei und ersetzt ohne since ab dem ersten Tag', () => {
    const e = parseLegacyStaffExport(datei())
    expect(e.schedules).toHaveLength(1)
    expect(legacyReplaceDays(e)).toEqual({ from: '2026-09-30', to: '2026-10-01' })
  })

  it('weist ab, was nicht dem Vertrag entspricht', () => {
    const fehler = (d: unknown): string => {
      try { parseLegacyStaffExport(d); return 'ok' } catch (e) {
        return (e as LegacyStaffFormatError).key
      }
    }
    expect(fehler(null)).toBe('staffImport.notJson')
    expect(fehler(datei({ format: 'x' }))).toBe('staffImport.format')
    expect(fehler(datei({ schemaVersion: 2 }))).toBe('staffImport.schema')
    expect(fehler(datei({ workEntries: undefined }))).toBe('staffImport.missingGroup')
    const abgeschnitten = datei()
    abgeschnitten.manifest.schedules.rows = 2
    expect(fehler(abgeschnitten)).toBe('staffImport.checksum')
    // Ein Tag ausserhalb des Ausschnitts ist ein Fehler, keine stille Luecke.
    expect(fehler(datei({ since: '2026-10-01' }))).toBe('staffImport.badRow')
  })

  it('bildet die Status ab wie in Dokument 34', () => {
    expect(legacyTaskState('cleaned')).toEqual({ status: 'done', outcome: 'cleaned' })
    expect(legacyTaskState('declined')).toEqual({ status: 'skipped', outcome: 'declined' })
    expect(legacyTaskState('problem')).toEqual({ status: 'open', outcome: null })
  })
})
