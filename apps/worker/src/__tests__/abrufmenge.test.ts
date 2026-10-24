import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { pruefeAbrufmengen } from '../jobs/abrufmenge.js'

/**
 * Mengenalarm (Migration 0210, Bedrohungsanalyse 23.10.2026, E2): eine
 * Stunde gegen die vierzehn Tage davor, und was auffaellt, wird ein
 * Sicherheitsereignis mit Hinweis an die Leitung.
 */

let owner: Pool
let app: Pool
let fx: Fixture

beforeAll(async () => { await ensureSchema(); owner = ownerPool(); app = appPool(4) })
afterAll(async () => { await owner.end(); await app.end() })
beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner, { name: 'Wattenblick' })
  await makeUser(owner, { email: 'direktion@kunde.de', propertyId: fx.propertyId,
                          roleKey: 'hotel_director' })
})

// Mittags Berliner Zeit, damit die Nachtregel nicht mitspielt.
const STUNDE = new Date('2026-10-20T10:00:00Z')

async function zaehler(key: string, wann: Date, zeilen: number): Promise<void> {
  await owner.query(
    `INSERT INTO access_volume (principal_key, account_id, hour, requests, rows_returned, origin)
     VALUES ($1, $2, date_trunc('hour', $3::timestamptz), 1, $4, '203.0.113.9')`,
    [key, fx.accountId, wann.toISOString(), zeilen])
}
const vorher = (tage: number): Date => new Date(STUNDE.getTime() - tage * 86_400_000)

describe('Mengenalarm', () => {
  it('meldet einen Zugang, der ein Vielfaches seiner gewohnten Menge zieht', async () => {
    await zaehler('client:adminpanel', vorher(1), 1000)
    await zaehler('client:adminpanel', STUNDE, 20_000)
    expect(await pruefeAbrufmengen(app, 'sicherheit@staygrid.test', STUNDE)).toBe(1)

    const e = await owner.query<{ kind: string; actor_kind: string; actor_ref: string
                                  origin: string; detail: Record<string, unknown> }>(
      `SELECT kind, actor_kind, actor_ref, host(origin) AS origin, detail FROM security_event`)
    expect(e.rows).toHaveLength(1)
    expect(e.rows[0]).toMatchObject({ kind: 'access_volume', actor_kind: 'client',
                                      actor_ref: 'adminpanel', origin: '203.0.113.9' })
    expect(e.rows[0]!.detail).toMatchObject({ grund: 'volume', datensaetze: 20_000,
                                              bisherHoechstens: 1000 })
    const post = await owner.query<{ kind: string; to_email: string }>(
      `SELECT kind, to_email FROM platform_email ORDER BY kind`)
    expect(post.rows).toEqual([
      { kind: 'security_alert', to_email: 'sicherheit@staygrid.test' },
      { kind: 'security_notice', to_email: 'direktion@kunde.de' }])
  })

  it('schweigt beim gewohnten naechtlichen Abgleich und unter der Mindestmenge', async () => {
    await zaehler('client:adminpanel', vorher(1), 1000)
    await zaehler('client:adminpanel', STUNDE, 1200)
    await zaehler('user:7', STUNDE, 300)
    expect(await pruefeAbrufmengen(app, 'sicherheit@staygrid.test', STUNDE)).toBe(0)
  })

  it('meldet einen neuen Zugang, der sofort Hunderte Gaeste zieht', async () => {
    await zaehler('client:neu', STUNDE, 600)
    expect(await pruefeAbrufmengen(app, 'sicherheit@staygrid.test', STUNDE)).toBe(1)
  })

  it('meldet einen Menschen, der nachts liest und das sonst nie tut', async () => {
    const nacht = new Date('2026-10-20T01:00:00Z') // 3 Uhr in Berlin
    await zaehler('user:7', vorher(2), 50)          // tagsueber, nicht nachts
    await zaehler('user:7', nacht, 150)
    expect(await pruefeAbrufmengen(app, 'sicherheit@staygrid.test', nacht)).toBe(1)
    const e = await owner.query<{ detail: { grund: string } }>('SELECT detail FROM security_event')
    expect(e.rows[0]!.detail.grund).toBe('night')
  })
})

describe('ALARM-Zeilen', () => {
  it('gehen als eine Mail je Stunde an uns, ohne Fehlertext', async () => {
    const { alarmEinreihen } = await import('../jobs/alarm.js')
    const zeile = [{ property: 3, err: new Error('Zeile mit Petersen'), name: 'Jan Petersen, Deichweg 4, Flensburg, sehr lang' },
                   'ALARM: Nachtlauf ist im Rueckstand']
    expect(await alarmEinreihen(app, 'sicherheit@staygrid.test', zeile, 50)).toBe(true)
    expect(await alarmEinreihen(app, 'sicherheit@staygrid.test', zeile, 50)).toBe(false)
    expect(await alarmEinreihen(app, 'sicherheit@staygrid.test',
      [{ n: 1 }, 'Nur ein Hinweis'], 50)).toBe(false)
    expect(await alarmEinreihen(app, 'sicherheit@staygrid.test',
      [{ n: 1 }, 'ALARM: nur eine Warnung'], 40)).toBe(false)
    const post = await owner.query<{ subject: string; body_text: string }>(
      `SELECT subject, body_text FROM platform_email WHERE kind = 'security_alert'`)
    expect(post.rows).toHaveLength(1)
    expect(post.rows[0]!.subject).toContain('Nachtlauf ist im Rueckstand')
    expect(post.rows[0]!.body_text).toContain('property: 3')
    expect(post.rows[0]!.body_text).not.toContain('Petersen')
  })
})
