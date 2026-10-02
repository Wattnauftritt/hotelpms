import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { registeredRoutes } from '../platform/routes.js'
import { limiters } from '../platform/rateLimit.js'
import { codeNormalisieren } from '../routes/terminal.js'

/**
 * Das Gaesteterminal (Dokument 31).
 *
 * Geprueft wird, was still schiefginge: ein Geraet, das mehr erreicht als
 * seinen Auftrag; ein Kopplungscode, der zweimal oder nach Ablauf traegt;
 * ein Widerruf, der erst bei der naechsten Anmeldung wirkt; ein zweiter
 * Auftrag, der die Daten des ersten Gastes ueberlagert; und eine
 * Unterschrift, die am Terminal eine andere Regel befolgt als am Tresen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let zimmer: number[]
let chef: Record<string, string>
let chefSitzung: string

const VON = '2026-10-01'
const BIS = '2026-10-04'
const UNTERSCHRIFT = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  fx = await makeProperty(owner)
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  zimmer = await makeResources(owner, fx.propertyId, catId, 4)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  chefSitzung = u.sessionId
  chef = { cookie: `hp_session=${u.sessionId}` }
})

const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, never>
const geraet = (secret: string) => ({ cookie: `hp_terminal=${secret}` })

let schluessel = 0

async function gast(nachname: string, country = 'NL', propertyAccount = fx.accountId
): Promise<string> {
  const g = await owner.query<{ public_ref: string }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, phone, country,
                        nationality, city)
     VALUES ($1,$2,'Anna','anna@example.org','+31 6 1234',$3,$3,'Utrecht')
     RETURNING public_ref`, [propertyAccount, nachname, country])
  return g.rows[0]!.public_ref
}

async function reservierung(guestRef: string, headers = chef,
                            propertyId = fx.propertyId, kategorie = catId,
                            raum?: number): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...headers, 'idempotency-key': `t-${++schluessel}` },
    payload: { propertyId, categoryId: kategorie, arrival: VON, departure: BIS,
               resourceId: raum ?? zimmer[schluessel % zimmer.length], guestRef } })
  expect(r.statusCode, r.body).toBe(201)
  return json(r).reservationRef as string
}

/** Meldeschein anlegen, Unterschrift folgt am Terminal. */
async function melden(ref: string, headers = chef, propertyId = fx.propertyId
): Promise<number> {
  const r = await app.inject({ method: 'POST', url: '/v1/registrations', headers,
    payload: { propertyId, reservationRef: ref, signatureLater: true } })
  expect(r.statusCode, r.body).toBe(201)
  return json(r).registrationId as number
}

async function anlegen(name = 'Touchscreen Rezeption', headers = chef,
                       propertyId = fx.propertyId
): Promise<{ deviceRef: string; pairingCode: string }> {
  const r = await app.inject({ method: 'POST',
    url: `/v1/properties/${propertyId}/terminals`, headers, payload: { name } })
  expect(r.statusCode, r.body).toBe(201)
  return json(r) as unknown as { deviceRef: string; pairingCode: string }
}

async function koppeln(code: string, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/v1/terminal/pair',
    headers: extra, payload: { code } })
}

/** Ein gekoppeltes Terminal: Kennung und Geheimnis aus dem Cookie. */
async function terminal(name?: string, headers = chef, propertyId = fx.propertyId
): Promise<{ deviceRef: string; secret: string }> {
  const t = await anlegen(name, headers, propertyId)
  const r = await koppeln(t.pairingCode)
  expect(r.statusCode, r.body).toBe(200)
  const c = r.cookies.find(k => k.name === 'hp_terminal')!
  return { deviceRef: t.deviceRef, secret: c.value }
}

async function auftrag(deviceRef: string, reservationRef: string,
                       kind = 'registration_sign', headers = chef) {
  return app.inject({ method: 'POST', url: '/v1/terminal-jobs', headers,
    payload: { deviceRef, reservationRef, kind } })
}

const abfragen = (secret: string) =>
  app.inject({ method: 'GET', url: '/v1/terminal/job', headers: geraet(secret) })

describe('Kopplung', () => {
  it('nimmt einen Code genau einmal an und legt nur den Hash ab', async () => {
    const t = await anlegen()
    expect(t.pairingCode).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/)

    const r = await koppeln(t.pairingCode.toLowerCase())
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r).name).toBe('Touchscreen Rezeption')
    const c = r.cookies.find(k => k.name === 'hp_terminal')!
    // httpOnly: kein Skript am Touchscreen kommt an das Geheimnis. Nur an
    // die Routen des Terminals.
    expect(c.httpOnly).toBe(true)
    expect(c.path).toBe('/v1/terminal')
    expect(String(c.sameSite).toLowerCase()).toBe('strict')

    const zweites = await koppeln(t.pairingCode)
    expect(zweites.statusCode).toBe(422)

    const d = await owner.query<{ secret_hash: Buffer; pairing_code_hash: Buffer | null }>(
      `SELECT secret_hash, pairing_code_hash FROM terminal_device`)
    expect(d.rows[0]!.pairing_code_hash).toBeNull()
    expect(d.rows[0]!.secret_hash.toString('utf8')).not.toContain(c.value)

    // Das Protokoll kennt die Kopplung, aber keinen der beiden Hashes.
    const prot = await owner.query<{ changed: unknown; action: string }>(
      `SELECT changed, action FROM audit_log WHERE table_name = 'terminal_device'`)
    expect(prot.rows.length).toBeGreaterThan(0)
    const kopplung = prot.rows.find(z => z.action === 'UPDATE')
      ?.changed as Record<string, unknown> | undefined
    expect(kopplung?.secret_hash).toEqual({ von: '[redigiert]', nach: '[redigiert]' })
    expect(kopplung?.pairing_code_hash).toEqual({ von: '[redigiert]', nach: '[redigiert]' })
    for (const z of prot.rows) {
      // Kein Bytea-Wert irgendwo im Protokoll dieser Tabelle.
      expect(JSON.stringify(z.changed)).not.toMatch(/x[0-9a-f]{32}/)
    }
  })

  it('weist einen abgelaufenen Code ab', async () => {
    const t = await anlegen()
    await owner.query(
      `UPDATE terminal_device SET pairing_expires_at = now() - interval '1 minute'`)
    expect((await koppeln(t.pairingCode)).statusCode).toBe(422)
  })

  it('liest Bindestrich, Leerzeichen und Kleinschreibung als Lesehilfe', () => {
    expect(codeNormalisieren(' abcd-ef 23 ')).toBe('ABCDEF23')
  })

  /**
   * Die Lehre aus `workstation-switch`: eine angemeldete Anfrage erreicht
   * die allgemeine Grenze nicht. Gezaehlt wird deshalb an der Route --
   * hier ausdruecklich **mit** gueltiger Sitzung, und danach traegt auch
   * der richtige Code nicht mehr.
   */
  it('zaehlt Fehlversuche selbst, auch bei angemeldeter Anfrage', async () => {
    const t = await anlegen()
    for (let i = 0; i < 10; i++) {
      const r = await koppeln('ZZZZ-ZZZZ', chef)
      expect(r.statusCode).toBe(422)
    }
    const gesperrt = await koppeln(t.pairingCode)
    expect(gesperrt.statusCode).toBe(429)
    limiters.reset()
    expect((await koppeln(t.pairingCode)).statusCode).toBe(200)
  })

  it('beendet eine Mitarbeitersitzung im selben Browser', async () => {
    const t = await anlegen()
    const r = await koppeln(t.pairingCode, chef)
    expect(r.statusCode).toBe(200)
    const geloescht = r.cookies.find(k => k.name === 'hp_session')
    expect(geloescht?.value ?? '').toBe('')
    const s = await owner.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM user_session WHERE id = $1`, [chefSitzung])
    expect(s.rows[0]!.revoked_at).not.toBeNull()
  })

  it('koppelt ein Terminal im Uebungshaus', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    const t = await terminal()
    const r = await abfragen(t.secret)
    expect(r.statusCode).toBe(200)
    expect(json(r).isTraining).toBe(true)
  })

  it('macht beim Neukoppeln das alte Geheimnis wertlos', async () => {
    const t = await terminal()
    const neu = await app.inject({ method: 'POST',
      url: `/v1/properties/${fx.propertyId}/terminals/${t.deviceRef}/pairing-code`,
      headers: chef })
    expect(neu.statusCode, neu.body).toBe(200)
    expect((await abfragen(t.secret)).statusCode).toBe(401)
    expect((await koppeln(json(neu).pairingCode)).statusCode).toBe(200)
  })
})

describe('Ein Geraet erreicht nur seine eigenen Routen', () => {
  /**
   * Die Abnahme: dieselbe Pruefung wie beim Maschinentoken, ueber **alle**
   * registrierten Routen, damit eine neue Route nicht versehentlich fuer
   * jedes Terminal offen steht. Die Platzhalter werden zu 1 -- und das ist
   * genau das Haus des Terminals, weil `truncateAll` die Zaehler
   * zuruecksetzt. Abgewiesen wird also nicht am fremden Haus, sondern am
   * Recht.
   */
  it('laeuft ueber die gesamte Routenliste', async () => {
    const t = await terminal()
    expect(fx.propertyId).toBe(1)
    for (const r of registeredRoutes()) {
      if (r.permission === 'terminal:device') continue
      // Oeffentliche Routen sind fuer jeden offen, auch fuer ein Terminal;
      // die mit Principal pruefen den Benutzer selbst -- `me` steht unten.
      if (r.permission === null) continue
      const url = r.url.replace(/:(\w+)/g, '1')
      const antwort = await app.inject({
        method: r.method, url, headers: geraet(t.secret), payload: {} })
      expect([401, 403], `${r.method} ${url} liess ein Terminal durch`)
        .toContain(antwort.statusCode)
    }
  })

  it('ist kein Benutzer', async () => {
    const t = await terminal()
    const r = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: geraet(t.secret) })
    expect(r.statusCode).toBe(401)
  })

  it('laesst die Geraeterouten keinem Menschen offen', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/terminal/job', headers: chef })
    expect(r.statusCode).toBe(403)
  })

  it('ist als Zugriffsbereich eines Maschinenzugangs nicht zu haben', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/oauth-clients', headers: chef,
      payload: { name: 'Kasse', scopes: ['terminal:device'] } })
    expect(r.statusCode).toBe(422)
  })

  it('steht in keiner Rolle', async () => {
    const r = await owner.query(
      `SELECT 1 FROM role_permission WHERE permission_key = 'terminal:device'`)
    expect(r.rowCount).toBe(0)
  })
})

describe('Widerruf', () => {
  it('wirkt mit der naechsten Anfrage und nimmt den offenen Auftrag mit', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    await melden(ref)
    expect((await auftrag(t.deviceRef, ref)).statusCode).toBe(201)
    expect((await abfragen(t.secret)).statusCode).toBe(200)

    const w = await app.inject({ method: 'DELETE',
      url: `/v1/properties/${fx.propertyId}/terminals/${t.deviceRef}`, headers: chef })
    expect(w.statusCode, w.body).toBe(200)

    expect((await abfragen(t.secret)).statusCode).toBe(401)
    const j = await owner.query<{ state: string; canceled_by: string }>(
      `SELECT state, canceled_by FROM terminal_job`)
    expect(j.rows[0]).toEqual({ state: 'canceled', canceled_by: 'revoked' })
    const d = await owner.query<{ secret_hash: Buffer | null }>(
      `SELECT secret_hash FROM terminal_device`)
    expect(d.rows[0]!.secret_hash).toBeNull()
  })
})

describe('Auftraege', () => {
  it('laesst je Geraet hoechstens einen offenen Auftrag zu', async () => {
    const t = await terminal()
    const a = await reservierung(await gast('Jansen'))
    const b = await reservierung(await gast('de Vries'))
    await melden(a)
    await melden(b)

    const erster = await auftrag(t.deviceRef, a)
    expect(erster.statusCode, erster.body).toBe(201)
    const zweiter = await auftrag(t.deviceRef, b)
    expect(zweiter.statusCode).toBe(409)
    expect(json(zweiter).code).toBe('terminal.deviceBusy')

    const ab = await app.inject({ method: 'POST',
      url: `/v1/terminal-jobs/${json(erster).jobRef}/cancel`,
      headers: chef })
    expect(ab.statusCode).toBe(200)
    expect((await auftrag(t.deviceRef, b)).statusCode).toBe(201)
  })

  it('laeuft ab, wenn niemand ihn oeffnet, und steht dann nicht im Weg', async () => {
    const t = await terminal()
    const a = await reservierung(await gast('Jansen'))
    const b = await reservierung(await gast('de Vries'))
    await melden(a)
    await melden(b)
    expect((await auftrag(t.deviceRef, a)).statusCode).toBe(201)
    await owner.query(`UPDATE terminal_job SET expires_at = now() - interval '1 second'`)

    expect(json(await abfragen(t.secret)).job).toBeNull()
    const stand = await app.inject({ method: 'GET',
      url: `/v1/reservations/${a}/terminal`, headers: chef })
    expect((json(stand).job as { state: string }).state).toBe('expired')

    expect((await auftrag(t.deviceRef, b)).statusCode).toBe(201)
    const alt = await owner.query<{ state: string }>(
      `SELECT state FROM terminal_job ORDER BY id LIMIT 1`)
    expect(alt.rows[0]!.state).toBe('expired')
  })

  it('bietet einem inlaendischen Gast keine Unterschrift an und weist sie ab', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Petersen', 'DE'))
    await melden(ref)

    const stand = await app.inject({ method: 'GET',
      url: `/v1/reservations/${ref}/terminal`, headers: chef })
    expect(stand.statusCode).toBe(200)
    expect(json(stand).offers).toEqual([])

    const r = await auftrag(t.deviceRef, ref)
    expect(r.statusCode).toBe(422)
    expect(json(r).code).toBe('registration.signatureNotForeseen')
  })

  it('verlangt einen angelegten Meldeschein', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    const r = await auftrag(t.deviceRef, ref)
    expect(r.statusCode).toBe(422)
    expect(json(r).code).toBe('terminal.noRegistration')
  })

  it('haelt das Meldeformular zurueck, bis es angebunden ist', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    const r = await auftrag(t.deviceRef, ref, 'registration_fill')
    expect(r.statusCode).toBe(422)
    expect(json(r).code).toBe('terminal.kindUnavailable')
  })
})

describe('Unterschrift am Terminal', () => {
  it('landet ueber denselben Weg wie am Tresen, mit dem Geraet im Protokoll', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    const regId = await melden(ref)

    const stand0 = await app.inject({ method: 'GET',
      url: `/v1/reservations/${ref}/terminal`, headers: chef })
    expect(json(stand0).offers).toEqual(['registration_sign'])
    expect((json(stand0).terminals as unknown[]).length).toBe(1)

    const a = await auftrag(t.deviceRef, ref)
    const jobRef = json(a).jobRef as string

    const frage = json(await abfragen(t.secret))
    expect(frage.job).toEqual({ jobRef, kind: 'registration_sign', state: 'pending' })
    // Die Frage traegt keine Gastdaten, nur Art und Kennung.
    expect(JSON.stringify(frage)).not.toContain('Jansen')

    // Ohne Oeffnen keine Unterschrift.
    const zuFrueh = await app.inject({ method: 'POST',
      url: `/v1/terminal/job/${jobRef}/complete`, headers: geraet(t.secret),
      payload: { signatureSvg: UNTERSCHRIFT } })
    expect(zuFrueh.statusCode).toBe(409)

    const auf = await app.inject({ method: 'POST', url: `/v1/terminal/job/${jobRef}/open`,
      headers: geraet(t.secret) })
    expect(auf.statusCode, auf.body).toBe(200)
    const daten = JSON.stringify(json(auf).data)
    expect(daten).toContain('Jansen')
    // Datenminimierung: weder Mailadresse noch Telefon.
    expect(daten).not.toContain('anna@example.org')
    expect(daten).not.toContain('1234')

    const stand1 = await app.inject({ method: 'GET',
      url: `/v1/reservations/${ref}/terminal`, headers: chef })
    expect((json(stand1).job as { state: string }).state).toBe('opened')

    const fertig = await app.inject({ method: 'POST',
      url: `/v1/terminal/job/${jobRef}/complete`, headers: geraet(t.secret),
      payload: { signatureSvg: UNTERSCHRIFT } })
    expect(fertig.statusCode, fertig.body).toBe(200)

    const reg = await owner.query<{ signature_svg: string; signed_at: string | null }>(
      `SELECT signature_svg, signed_at FROM registration WHERE id = $1`, [regId])
    expect(reg.rows[0]!.signature_svg).toBe(UNTERSCHRIFT)
    expect(reg.rows[0]!.signed_at).not.toBeNull()

    const stand2 = await app.inject({ method: 'GET',
      url: `/v1/reservations/${ref}/terminal`, headers: chef })
    expect((json(stand2).job as { state: string }).state).toBe('done')
    expect(json(stand2).offers).toEqual([])
    expect(json(await abfragen(t.secret)).job).toBeNull()

    // Im Protokoll steht das Geraet als Handelnder, kein Benutzer -- und
    // die Unterschrift selbst nicht.
    const geraetId = (await owner.query<{ id: string }>(
      `SELECT id FROM terminal_device`)).rows[0]!.id
    const prot = await owner.query<{ user_id: string | null; terminal_device_id: string | null
                                     changed: Record<string, unknown> }>(
      `SELECT user_id, terminal_device_id, changed FROM audit_log
        WHERE table_name = 'registration' AND action = 'UPDATE'`)
    expect(prot.rowCount).toBe(1)
    expect(prot.rows[0]!.user_id).toBeNull()
    expect(prot.rows[0]!.terminal_device_id).toBe(geraetId)
    expect(JSON.stringify(prot.rows[0]!.changed)).not.toContain('M0 0L10 10')
  })

  it('weist eine zweite Unterschrift ab, am Terminal wie am Tresen', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    const regId = await melden(ref)
    const am = await app.inject({ method: 'POST', url: `/v1/registrations/${regId}/sign`,
      headers: chef, payload: { signatureSvg: UNTERSCHRIFT } })
    expect(am.statusCode, am.body).toBe(200)
    const r = await auftrag(t.deviceRef, ref)
    expect(r.statusCode).toBe(409)
    expect(json(r).code).toBe('registration.alreadySigned')
  })

  it('zeichnet einen Abbruch am Terminal unterscheidbar auf', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    await melden(ref)
    const jobRef = json(await auftrag(t.deviceRef, ref)).jobRef as string
    await app.inject({ method: 'POST', url: `/v1/terminal/job/${jobRef}/open`,
      headers: geraet(t.secret) })
    const r = await app.inject({ method: 'POST', url: `/v1/terminal/job/${jobRef}/abort`,
      headers: geraet(t.secret), payload: { reason: 'timeout' } })
    expect(r.statusCode).toBe(200)
    const j = await owner.query<{ state: string; canceled_by: string }>(
      `SELECT state, canceled_by FROM terminal_job`)
    expect(j.rows[0]).toEqual({ state: 'canceled', canceled_by: 'timeout' })
  })
})

describe('Vernichtung des Meldescheins', () => {
  /**
   * § 30 Abs. 4 BMG: ein Jahr nach Abreise wird der Schein vernichtet,
   * und zwar von der Anwendungsrolle im Pflegejob. Ein Auftrag, der auf
   * ihn zeigt, darf das nicht aufhalten -- der Verweis faellt auf NULL.
   */
  it('haelt die Loeschung nicht auf', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    const regId = await melden(ref)
    expect((await auftrag(t.deviceRef, ref)).statusCode).toBe(201)

    const { withTransaction } = await import('@hotelpms/db')
    await withTransaction(pool, { accountIds: [fx.accountId], propertyIds: [fx.propertyId],
                                  userId: null },
      client => client.query(`DELETE FROM registration WHERE id = $1`, [regId]))

    const j = await owner.query<{ registration_id: string | null }>(
      `SELECT registration_id FROM terminal_job`)
    expect(j.rows[0]!.registration_id).toBeNull()
  })
})

describe('Fremdes Geraet, fremdes Haus, fremder Mandant', () => {
  it('sieht und oeffnet den Auftrag eines anderen Terminals nicht', async () => {
    const eins = await terminal('Links')
    const zwei = await terminal('Rechts')
    const ref = await reservierung(await gast('Jansen'))
    await melden(ref)
    const jobRef = json(await auftrag(eins.deviceRef, ref)).jobRef as string

    expect(json(await abfragen(zwei.secret)).job).toBeNull()
    const r = await app.inject({ method: 'POST', url: `/v1/terminal/job/${jobRef}/open`,
      headers: geraet(zwei.secret) })
    expect(r.statusCode).toBe(404)
  })

  /**
   * Zwei Haeuser im selben Account: die Zeilenrichtlinie filtert nach
   * Mandant, nicht nach Haus -- das Terminal aus Haus A darf fuer Haus B
   * nicht angesprochen werden, auch von jemandem, der beide sieht.
   */
  it('nimmt kein Terminal eines anderen Hauses im selben Account', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Zweites')
       RETURNING id`, [fx.accountId])
    const b = zweites.rows[0]!.id
    const catB = await makeCategory(owner, b, { code: 'EZ' })
    const zimmerB = await makeResources(owner, b, catB, 2)
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
      [b])
    const beide = await makeUser(owner,
      { email: 'beide@test.de', accountId: fx.accountId, roleKey: 'account_admin' })
    const h = { cookie: `hp_session=${beide.sessionId}` }

    const t = await terminal('Haus A', h, fx.propertyId)
    const ref = await reservierung(await gast('Jansen'), h, b, catB, zimmerB[0])
    await melden(ref, h, b)

    const r = await auftrag(t.deviceRef, ref, 'registration_sign', h)
    expect(r.statusCode).toBe(404)
    expect(json(r).params).toEqual({ what: 'Gaesteterminal' })
  })

  /**
   * Die Routen der Rezeption nehmen eine Reservierung, keine Property.
   * Geprueft wird deshalb das Recht im Haus der Reservierung -- sonst
   * genuegte die Rezeptionsrolle in Haus A fuer einen Auftrag in Haus B.
   */
  it('verlangt das Recht im Haus der Reservierung', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Zweites')
       RETURNING id`, [fx.accountId])
    const b = zweites.rows[0]!.id
    const catB = await makeCategory(owner, b, { code: 'EZ' })
    const zimmerB = await makeResources(owner, b, catB, 2)
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
      [b])
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT u.id, $1, r.id FROM app_user u, role r
        WHERE u.email = 'chef@test.de' AND r.key = 'hotel_director' AND r.account_id IS NULL`,
      [b])
    const t = await terminal('Haus B', chef, b)
    const ref = await reservierung(await gast('Jansen'), chef, b, catB, zimmerB[0])
    await melden(ref, chef, b)

    // Rezeption in Haus A, in Haus B nur Housekeeping.
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: b, roleKey: 'housekeeping' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
      [hk.userId, fx.propertyId])
    const h = { cookie: `hp_session=${hk.sessionId}` }

    const stand = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}/terminal`,
      headers: h })
    expect(stand.statusCode).toBe(403)
    expect((await auftrag(t.deviceRef, ref, 'registration_sign', h)).statusCode).toBe(403)

    const jobRef = json(await auftrag(t.deviceRef, ref)).jobRef as string
    const ab = await app.inject({ method: 'POST', url: `/v1/terminal-jobs/${jobRef}/cancel`,
      headers: h })
    expect(ab.statusCode).toBe(403)
  })

  it('erreicht keinen anderen Mandanten', async () => {
    const t = await terminal()
    const fremd = await makeProperty(owner, { code: 'FREMD', name: 'Fremd' })
    const catF = await makeCategory(owner, fremd.propertyId, { code: 'DZ' })
    const zimmerF = await makeResources(owner, fremd.propertyId, catF, 2)
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
      [fremd.propertyId])
    const fremdChef = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'hotel_director' })
    const fh = { cookie: `hp_session=${fremdChef.sessionId}` }
    const ft = await terminal('Fremd', fh, fremd.propertyId)
    const fg = await gast('Jansen', 'NL', fremd.accountId)
    const fref = await reservierung(fg, fh, fremd.propertyId, catF, zimmerF[0])
    await melden(fref, fh, fremd.propertyId)
    const fjob = json(await auftrag(ft.deviceRef, fref, 'registration_sign', fh))
      .jobRef as string

    // Das eigene Terminal kommt nicht an den fremden Auftrag ...
    const r = await app.inject({ method: 'POST', url: `/v1/terminal/job/${fjob}/open`,
      headers: geraet(t.secret) })
    expect(r.statusCode).toBe(404)
    // ... und die eigene Rezeption nicht an das fremde Terminal.
    const ref = await reservierung(await gast('de Vries'))
    await melden(ref)
    expect((await auftrag(ft.deviceRef, ref)).statusCode).toBe(404)
  })
})

describe('Die Frage des Terminals', () => {
  it('zaehlt nicht als anonym', async () => {
    const t = await terminal()
    limiters.reset()
    for (let i = 0; i < 5; i++) expect((await abfragen(t.secret)).statusCode).toBe(200)
    expect(limiters.allgemein.size).toBe(0)

    // Ein Cookie, das nicht traegt, zaehlt dagegen sehr wohl.
    expect((await abfragen('erfunden')).statusCode).toBe(401)
    expect(limiters.allgemein.size).toBe(1)
  })

  /**
   * Einmal gezaehlt, ueber beide Fragen: der Zaehler haengt sich an die
   * Verbindungen des Pools und laesst sich je Pool nur einmal einsetzen.
   * Der Auftrag dazwischen entsteht deshalb ueber die Eigentuemerrolle,
   * deren Anweisungen er nicht sieht.
   */
  it('kostet gleich viele Anweisungen, ob ein Auftrag ansteht oder nicht', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Jansen'))
    const regId = await melden(ref)

    const { result, report } = await countQueries(pool, async () => {
      const ohne = await abfragen(t.secret)
      expect(json(ohne).job).toBeNull()
      await owner.query(
        `INSERT INTO terminal_job (property_id, device_id, kind, reservation_id,
                                   registration_id, expires_at)
         SELECT d.property_id, d.id, 'registration_sign', r.id, $2, now() + interval '3 minutes'
           FROM terminal_device d, reservation r
          WHERE r.public_ref = $1`, [ref, regId])
      return abfragen(t.secret)
    })
    expect(json(result).job).not.toBeNull()

    // Geraet aufloesen, Auftrag lesen. Nicht mehr -- und mit Auftrag
    // dieselben Anweisungen wie ohne.
    const haelfte = report.count / 2
    expect(report.count % 2).toBe(0)
    expect(haelfte).toBeLessThanOrEqual(2)
    expect(report.statements.slice(haelfte)).toEqual(report.statements.slice(0, haelfte))
  })
})

describe('Meldeschein mit Unterschrift danach', () => {
  it('legt den Schein eines auslaendischen Gastes an und vermerkt die offene Unterschrift',
    async () => {
      const ref = await reservierung(await gast('Jansen'))
      const r = await app.inject({ method: 'POST', url: '/v1/registrations', headers: chef,
        payload: { propertyId: fx.propertyId, reservationRef: ref, signatureLater: true } })
      expect(r.statusCode, r.body).toBe(201)
      expect(json(r).signaturePending).toBe(true)
      const f = await app.inject({ method: 'GET',
        url: `/v1/reservations/${ref}/registration-form`, headers: chef })
      expect(json(f).registrationId).toBe(json(r).registrationId)
      expect(json(f).signedAt).toBeNull()
    })

  /**
   * Mitbehoben: `/sign` nimmt keine Property entgegen, und `registerRoute`
   * prueft das Recht dann nur "in irgendeinem Haus". Wer in Haus A
   * einchecken darf und Haus B nur sieht, kam an Meldescheine in B.
   */
  it('unterschreibt nicht in einem Haus, in dem das Recht fehlt', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Zweites')
       RETURNING id`, [fx.accountId])
    const b = zweites.rows[0]!.id
    const catB = await makeCategory(owner, b, { code: 'EZ' })
    const zimmerB = await makeResources(owner, b, catB, 2)
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
      [b])
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT u.id, $1, r.id FROM app_user u, role r
        WHERE u.email = 'chef@test.de' AND r.key = 'hotel_director' AND r.account_id IS NULL`,
      [b])
    const ref = await reservierung(await gast('Jansen'), chef, b, catB, zimmerB[0])
    const regId = await melden(ref, chef, b)

    // Jetzt nimmt jemand das Recht in Haus B weg und laesst nur Housekeeping.
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: b, roleKey: 'housekeeping' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
      [hk.userId, fx.propertyId])
    const r = await app.inject({ method: 'POST', url: `/v1/registrations/${regId}/sign`,
      headers: { cookie: `hp_session=${hk.sessionId}` },
      payload: { signatureSvg: UNTERSCHRIFT } })
    expect(r.statusCode).toBe(404)
  })
})
