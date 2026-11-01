import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, ownerPool, makeProperty, makeUser, makeCategory,
         makeReservation, makeGuest, mcpDatabaseUrl, type Fixture } from '@hotelpms/testing'
import type { Pool as AppPool } from '@hotelpms/db'
import { buildMcp } from '../app.js'
import { poolAnlegen, type Pool } from '../db.js'
import type { JournalLeser } from '../journal.js'
import { sqlPruefen, fuersProtokoll } from '../sql.js'
import { WERKZEUGE } from '../werkzeuge.js'

/*
 * Der Claude-Zugang von der Seite des Dienstes (0222, Dokument 38).
 *
 * Gegen die echte Rolle `hotelpms_mcp`: was hier festgehalten wird, ist die
 * Grenze -- Anmeldung, Schwaerzung, Klartext nur mit Freigabe, nur lesen,
 * jeder Aufruf im Protokoll --, und die liegt in der Datenbank, nicht im
 * Dienst. Dazu laeuft jedes Werkzeug einmal: ihre Abfragen sind lang und
 * gegen ein Schema geschrieben, das sich weiterbewegt.
 */

let owner: AppPool
let pool: Pool
let app: FastifyInstance
let fx: Fixture
let admin: { userId: number }
let gastId: number
let reservierung: string

const TOKEN = `sgmcp_${'a'.repeat(43)}`
const BASIS = 'https://app.staygrid.test'

const journal: JournalLeser = async a => {
  // Ein paar Zeilen, wie die API sie schreibt: eine Anfrage, eine Antwort,
  // eine Warnung zu vielen Anweisungen, und eine Zeile ohne JSON.
  if (!a.einheiten.includes('hotelpms-api')) return []
  const t = new Date().toISOString()
  return [
    { zeit: t, einheit: 'hotelpms-api', text: JSON.stringify({ level: 30, reqId: 'r1',
      req: { method: 'GET', url: '/v1/reservations/123?q=x' }, msg: 'incoming request' }) },
    { zeit: t, einheit: 'hotelpms-api', text: JSON.stringify({ level: 30, reqId: 'r1',
      res: { statusCode: 200 }, responseTime: 312.5, msg: 'request completed' }) },
    { zeit: t, einheit: 'hotelpms-api', text: JSON.stringify({ level: 40, reqId: 'r1',
      anweisungen: 61, dbMs: 80, msg: 'viele Anweisungen' }) },
    { zeit: t, einheit: 'hotelpms-api', text: 'Server listening at 10.1.2.3' }
  ]
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  pool = poolAnlegen(mcpDatabaseUrl(), 4)
  app = buildMcp({ pool, oeffentlicheAdresse: BASIS, journal, protokollStufe: false })
  await app.ready()
})
afterAll(async () => { await app.close(); await pool.end(); await owner.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  // Wie bei uns: Plattform-Admin und zugleich Inhaber des eigenen Betriebs.
  // Klartext gibt es nur fuer Haeuser, die er selbst sehen darf.
  admin = await makeUser(owner, { email: 'sven@wir.de', platformRoleKey: 'platform_admin',
                                  isPlatformStaff: true })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'owner' AND account_id IS NULL`,
    [admin.userId, fx.accountId])
  await owner.query(
    `INSERT INTO mcp_connection (user_id, client_id, token_hash, expires_at)
     VALUES ($1, 'staygrid-claude', $2, now() + interval '8 hours')`,
    [admin.userId, createHash('sha256').update(TOKEN).digest()])
  gastId = (await makeGuest(owner, fx.accountId, { lastName: 'Petersen' })).id
  const k = await makeCategory(owner, fx.propertyId)
  const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: k,
    arrival: '2026-11-02', departure: '2026-11-04', reserveInventory: false })
  reservierung = (await owner.query<{ public_ref: string }>(
    'SELECT public_ref FROM reservation WHERE id = $1', [r.reservationId])).rows[0]!.public_ref
})

const rpc = (method: string, params: unknown = {}, token = TOKEN, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
    payload: { jsonrpc: '2.0', id: 1, method, params } })

const werkzeug = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<{ result: { isError: boolean; content: Array<{ text: string }>
                            structuredContent?: { ergebnis: unknown; klartext: boolean } } }>()
    .result
}

describe('Anmeldung', () => {
  it('weist ohne Token mit dem Verweis auf die Metadaten ab', async () => {
    const r = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1,
      method: 'initialize' } })
    expect(r.statusCode).toBe(401)
    expect(r.headers['www-authenticate'])
      .toBe(`Bearer resource_metadata="${BASIS}/.well-known/oauth-protected-resource/mcp"`)
  })

  it('weist ein fremdes, ein widerrufenes und ein abgelaufenes Token ab', async () => {
    expect((await rpc('ping', {}, `sgmcp_${'b'.repeat(43)}`)).statusCode).toBe(401)
    await owner.query(`UPDATE mcp_connection SET revoked_at = now(), revoked_reason = 'manual'`)
    expect((await rpc('ping')).statusCode).toBe(401)
    await owner.query(`UPDATE mcp_connection SET revoked_at = NULL, revoked_reason = NULL,
                              expires_at = now() - interval '1 second',
                              created_at = now() - interval '9 hours'`)
    expect((await rpc('ping')).statusCode).toBe(401)
  })

  it('weist ab, wenn der Zugang gesperrt ist oder das Recht fehlt', async () => {
    await owner.query(`INSERT INTO mcp_setting (id, locked) VALUES (true, true)
                       ON CONFLICT (id) DO UPDATE SET locked = true`)
    expect((await rpc('ping')).statusCode).toBe(401)
    await owner.query(`UPDATE mcp_setting SET locked = false`)
    expect((await rpc('ping')).statusCode).toBe(200)
    await owner.query(`DELETE FROM user_platform_role WHERE user_id = $1`, [admin.userId])
    expect((await rpc('ping')).statusCode).toBe(401)
  })

  it('weist eine fremde Herkunft ab (DNS-Rebinding)', async () => {
    const r = await rpc('ping', {}, TOKEN, { origin: 'https://boese.example' })
    expect(r.statusCode).toBe(403)
  })

  it('beschreibt Ressource und Autorisierung', async () => {
    const r = await app.inject({ url: '/.well-known/oauth-protected-resource/mcp' })
    expect(r.json()).toMatchObject({ resource: `${BASIS}/mcp`, authorization_servers: [BASIS] })
    const a = await app.inject({ url: '/.well-known/oauth-authorization-server' })
    expect(a.json()).toMatchObject({
      authorization_endpoint: `${BASIS}/mcp-verbinden`,
      token_endpoint: `${BASIS}/v1/mcp/oauth/token`,
      code_challenge_methods_supported: ['S256'] })
  })
})

describe('Protokoll', () => {
  it('handelt initialize und tools/list nach MCP ab', async () => {
    const i = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
                                        clientInfo: { name: 't', version: '1' } })
    expect(i.json()).toMatchObject({ result: { protocolVersion: '2025-06-18',
                                               capabilities: { tools: {} } } })
    const l = await rpc('tools/list')
    const namen = l.json<{ result: { tools: Array<{ name: string }> } }>().result.tools
      .map(t => t.name)
    expect(namen).toEqual(WERKZEUGE.map(w => w.name))
    // Eine Benachrichtigung bekommt keine Antwort.
    const n = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    expect(n.statusCode).toBe(202)
  })
})

describe('Schwaerzung und Freigabe', () => {
  it('sieht Fachtabellen nur ueber die Sichten, Personenwerte geschwaerzt', async () => {
    const e = await werkzeug('sql_lesen', { sql: 'SELECT id, last_name, email FROM guest' })
    expect(e.isError, e.content[0]!.text).toBe(false)
    expect(e.structuredContent!.ergebnis).toMatchObject({
      zeilen: [{ id: gastId, last_name: '[geschwaerzt]' }] })

    const direkt = await werkzeug('sql_lesen', { sql: 'SELECT last_name FROM public.guest' })
    expect(direkt.isError).toBe(true)
    expect(direkt.content[0]!.text).toMatch(/permission denied|42501/)
  })

  it('hat keine Spalte fuer Kennwort, Token oder Unterschrift', async () => {
    const e = await werkzeug('sql_lesen', { sql: `SELECT table_name, column_name
      FROM information_schema.columns WHERE table_schema = 'mcp'
       AND (column_name ~ '(password|token_hash|secret|signature)' AND data_type <> 'boolean')` })
    expect(e.isError, e.content[0]!.text).toBe(false)
    expect(e.structuredContent!.ergebnis).toMatchObject({ zeilen: [] })
  })

  it('zeigt Klartext erst nach der Freigabe, und nur fuer das Haus', async () => {
    const anderes = await makeProperty(owner, { name: 'Anderes Haus', code: 'ANDR' })
    const fremd = await makeGuest(owner, anderes.accountId)

    const a = await werkzeug('klartext_anfragen', { haus: fx.propertyId,
                                                   grund: 'Doppelte Anreise pruefen' })
    expect(a.isError, a.content[0]!.text).toBe(false)
    const push = await owner.query(`SELECT kind, params FROM staff_push`)
    expect(push.rows).toMatchObject([{ kind: 'mcp_release' }])

    // Gewaehrt wie nach der Pruefung des Passkeys; die Route selbst prueft
    // der Test der API (claudeZugang.test.ts).
    await owner.query(`UPDATE mcp_release SET granted_at = now(), granted_by = $1,
                              expires_at = now() + interval '1 hour'`, [admin.userId])

    const e = await werkzeug('sql_lesen',
      { sql: 'SELECT id, last_name FROM guest ORDER BY id' })
    expect(e.structuredContent!.klartext).toBe(true)
    const zeilen = (e.structuredContent!.ergebnis as { zeilen: Array<Record<string, unknown>> })
      .zeilen
    expect(zeilen.find(z => z.id === gastId)!.last_name).not.toBe('[geschwaerzt]')
    expect(zeilen.find(z => z.id === fremd.id)!.last_name).toBe('[geschwaerzt]')

    // Die gelesenen Zeilen zaehlen gegen die Freigabe.
    const f = await owner.query<{ rows_used: number }>(`SELECT rows_used FROM mcp_release`)
    expect(f.rows[0]!.rows_used).toBeGreaterThan(0)
  })

  it('schreibt nicht, auch nicht ueber eine Funktion', async () => {
    const e = await werkzeug('sql_lesen',
      { sql: `SELECT mcp_dienst.protokollieren(1, 'x', NULL, 0, false, 0, true, NULL)` })
    expect(e.isError).toBe(true)
    expect(e.content[0]!.text).toMatch(/read-only|25006|permission denied|42501/)
  })

  it('weist set_config und mehrere Anweisungen ab', async () => {
    expect((await werkzeug('sql_lesen',
      { sql: `SELECT set_config('mcp.verbindung', '999', true)` })).isError).toBe(true)
    expect((await werkzeug('sql_lesen', { sql: 'SELECT 1; SELECT 2' })).isError).toBe(true)
    expect(() => sqlPruefen('DELETE FROM guest')).toThrow()
    expect(fuersProtokoll(`SELECT * FROM guest WHERE last_name = 'Petersen'`))
      .toBe(`SELECT * FROM guest WHERE last_name = '…'`)
  })
})

describe('Protokoll jedes Aufrufs', () => {
  it('haelt erfolgreiche und gescheiterte Aufrufe fest, ohne Zeichenketten', async () => {
    await werkzeug('sql_lesen', { sql: `SELECT id FROM guest WHERE last_name = 'Petersen'` })
    await werkzeug('sql_lesen', { sql: 'SELECT gibt_es_nicht FROM guest' })
    await werkzeug('gibt_es_nicht')
    const p = await owner.query<{ tool: string; ok: boolean; detail: string | null }>(
      `SELECT tool, ok, detail FROM mcp_call ORDER BY id`)
    expect(p.rows.map(r => [r.tool, r.ok])).toEqual(
      [['sql_lesen', true], ['sql_lesen', false], ['gibt_es_nicht', false]])
    expect(p.rows[0]!.detail).toContain(`'…'`)
    expect(p.rows[0]!.detail).not.toContain('Petersen')
  })

  it('laesst das Protokoll nicht aendern', async () => {
    await werkzeug('ueberblick')
    await expect(owner.query(`UPDATE mcp_call SET ok = false`)).rejects.toThrow()
    await expect(owner.query(`DELETE FROM mcp_call`)).rejects.toThrow()
  })
})

describe('Jedes Werkzeug laeuft', () => {
  const faelle: Array<[string, () => Record<string, unknown>, string]> = [
    ['ueberblick', () => ({}), ''],
    ['tabellen', () => ({}), ''],
    ['tabellen', () => ({ tabelle: 'guest' }), 'eine Tabelle'],
    ['sicherheit', () => ({}), ''],
    ['protokoll', () => ({ einheiten: ['hotelpms-api'] }), ''],
    ['konfiguration', () => ({}), ''],
    ['buchung_lebenslauf', () => ({ referenz: reservierung }), ''],
    ['konsistenz', () => ({}), 'alle Haeuser'],
    ['konsistenz', () => ({ haus: fx.propertyId }), 'ein Haus'],
    ['leistung', () => ({}), ''],
    ['datenbank_zustand', () => ({}), ''],
    ['schnittstellen', () => ({}), ''],
    ['ausrollen_vergleich', () => ({}), ''],
    ['klartext_status', () => ({}), '']
  ]
  beforeEach(async () => {
    await owner.query(`INSERT INTO release (commit, subject, is_current, seen_at)
                       VALUES ('abcdef1234567', 'Test', true, now() - interval '10 minutes')`)
  })
  for (const [name, args, fall] of faelle) {
    it(`${name} ${fall}`, async () => {
      const e = await werkzeug(name, args())
      expect(e.isError, e.content[0]!.text).toBe(false)
    })
  }

  it('kuerzt IP-Adressen im Protokoll', async () => {
    const e = await werkzeug('protokoll', { einheiten: ['hotelpms-api'] })
    expect(e.content[0]!.text).not.toContain('10.1.2.3')
  })
})
