import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { withTransaction, SYSTEM_CONTEXT, type Pool } from '@hotelpms/db'
import { ensureSchema, ownerPool } from '@hotelpms/testing'
import { archiveStatus, archivBefund, type ArchivStand } from '../jobs/maintenance.js'

/**
 * Pruefung der WAL-Archivierung (Backupstrategie, 15.10.2026): eine
 * Sicherung, die still aufhoert, soll im Protokoll als ALARM stehen.
 */

let owner: Pool
beforeAll(async () => { await ensureSchema(); owner = ownerPool() })
afterAll(async () => { await owner.end() })

const jetzt = new Date('2026-10-15T12:00:00Z')
const stand = (s: Partial<ArchivStand>): ArchivStand =>
  ({ modus: 'on', zuletztGesichert: null, zuletztFehlgeschlagen: null, fehler: 0, ...s })

describe('WAL-Archivierung', () => {
  it('liest den Stand aus der Datenbank', async () => {
    const s = await withTransaction(owner, SYSTEM_CONTEXT, c => archiveStatus(c))
    expect(['on', 'off', 'always']).toContain(s.modus)
    expect(Number.isInteger(s.fehler)).toBe(true)
  })

  it('meldet eine ausgeschaltete Archivierung nur im Betrieb', () => {
    expect(archivBefund(stand({ modus: 'off' }), jetzt, false)).toBeNull()
    expect(archivBefund(stand({ modus: 'off' }), jetzt, true)).toMatch(/^ALARM: .*aus/)
  })

  it('meldet, wenn der letzte Versuch fehlschlug', () => {
    expect(archivBefund(stand({
      zuletztGesichert: new Date('2026-10-15T11:00:00Z'),
      zuletztFehlgeschlagen: new Date('2026-10-15T11:58:00Z'), fehler: 3 }), jetzt, true))
      .toMatch(/schlaegt fehl/)
    // Ein alter Fehler, danach wieder gesichert: erledigt.
    expect(archivBefund(stand({
      zuletztGesichert: new Date('2026-10-15T11:59:00Z'),
      zuletztFehlgeschlagen: new Date('2026-10-15T08:00:00Z'), fehler: 3 }), jetzt, true))
      .toBeNull()
  })

  it('meldet eine Archivierung, die seit einem Tag still steht', () => {
    expect(archivBefund(stand({ zuletztGesichert: new Date('2026-10-14T11:00:00Z') }),
      jetzt, true)).toMatch(/ueber einem Tag/)
    expect(archivBefund(stand({ zuletztGesichert: new Date('2026-10-15T11:00:00Z') }),
      jetzt, true)).toBeNull()
  })
})
