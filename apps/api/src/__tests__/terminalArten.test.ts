import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { CHECKIN_TOKEN_HEADER } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Das Gaesteterminal als allgemeiner Anzeige-Client (Dokument 31, §6 bis §8):
 * Meldeformular ausfuellen, Hausbedingung zustimmen, Seiten des Hauses,
 * freigegebene externe Adressen, Diashow, Bedienfeld.
 *
 * Geprueft wird vor allem, was das "allgemein" nicht zum Scheunentor machen
 * darf: keine Adresse ausser denen auf der Freigabeliste, kein SVG als
 * Bild, nichts aus einem fremden Haus, und der Online-Check-in-Link geht
 * nur an das Geraet und faellt mit dem Auftrag.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let zimmer: number[]
let chef: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-04'
const UNTERSCHRIFT = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="240">'
  + '<image href="data:image/png;base64,iVBORw0KGgoAAAA" width="720" height="240"/></svg>'
/** Die ersten Bytes eines PNG, dazu etwas Rumpf. Fuer die Erkennung genuegt das. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                           Buffer.from('rest-des-bildes')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

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
  chef = { cookie: `hp_session=${u.sessionId}` }
})

const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, never>
const geraet = (secret: string) => ({ cookie: `hp_terminal=${secret}` })
let schluessel = 0

async function gast(nachname: string, land = 'DE', konto = fx.accountId): Promise<string> {
  const g = await owner.query<{ public_ref: string }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, country, nationality)
     VALUES ($1,$2,'Anna','anna@example.org',$3,$3) RETURNING public_ref`,
    [konto, nachname, land])
  return g.rows[0]!.public_ref
}

async function reservierung(guestRef: string, headers = chef, propertyId = fx.propertyId,
                            kategorie = catId, raum?: number): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...headers, 'idempotency-key': `a-${++schluessel}` },
    payload: { propertyId, categoryId: kategorie, arrival: VON, departure: BIS,
               resourceId: raum ?? zimmer[schluessel % zimmer.length], guestRef } })
  expect(r.statusCode, r.body).toBe(201)
  return json(r).reservationRef as string
}

async function terminal(headers = chef, propertyId = fx.propertyId
): Promise<{ deviceRef: string; secret: string }> {
  const a = await app.inject({ method: 'POST', url: `/v1/properties/${propertyId}/terminals`,
    headers, payload: { name: 'Touchscreen' } })
  expect(a.statusCode, a.body).toBe(201)
  const k = await app.inject({ method: 'POST', url: '/v1/terminal/pair',
    payload: { code: json(a).pairingCode } })
  expect(k.statusCode, k.body).toBe(200)
  return { deviceRef: json(a).deviceRef, secret: k.cookies.find(c => c.name === 'hp_terminal')!.value }
}

const auftrag = (payload: Record<string, unknown>, headers = chef) =>
  app.inject({ method: 'POST', url: '/v1/terminal-jobs', headers, payload })

const oeffnen = (secret: string, jobRef: string) =>
  app.inject({ method: 'POST', url: `/v1/terminal/job/${jobRef}/open`, headers: geraet(secret) })

const abschliessen = (secret: string, jobRef: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/v1/terminal/job/${jobRef}/complete`,
               headers: geraet(secret), payload })

async function seite(titel: string, headers = chef, propertyId = fx.propertyId): Promise<string> {
  const r = await app.inject({ method: 'POST',
    url: `/v1/properties/${propertyId}/terminal-content`, headers,
    payload: { title: titel, body: 'WLAN: Wattenblick\n\n- Passwort an der Rezeption' } })
  expect(r.statusCode, r.body).toBe(201)
  return json(r).contentRef as string
}

const bild = (contentRef: string, bytes: Buffer, propertyId = fx.propertyId) =>
  app.inject({ method: 'PUT',
    url: `/v1/properties/${propertyId}/terminal-content/${contentRef}/image`,
    headers: chef, payload: { data: bytes.toString('base64') } })

const adresse = (url: string, propertyId = fx.propertyId, headers = chef) =>
  app.inject({ method: 'POST', url: `/v1/properties/${propertyId}/terminal-urls`,
    headers, payload: { label: 'Speisekarte', url } })

/** Ein zweiter Mandant mit eigenem Terminal und eigener Seite. */
async function fremdesHaus(): Promise<{ propertyId: number; chef: Record<string, string>
                                        contentRef: string; secret: string; deviceRef: string }> {
  const f = await makeProperty(owner, { code: 'FREMD', name: 'Fremd' })
  const u = await makeUser(owner,
    { email: 'fremd@test.de', propertyId: f.propertyId, roleKey: 'hotel_director' })
  const h = { cookie: `hp_session=${u.sessionId}` }
  const contentRef = await seite('Fremde Seite', h, f.propertyId)
  const t = await terminal(h, f.propertyId)
  return { propertyId: f.propertyId, chef: h, contentRef, ...t }
}

describe('Meldeformular ausfuellen (Online-Check-in am Terminal)', () => {
  it('gibt den Link nur beim Oeffnen und nur an das Geraet, und zieht ihn danach zurueck',
    async () => {
      const t = await terminal()
      const ref = await reservierung(await gast('Petersen'))

      const stand = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}/terminal`,
        headers: chef })
      expect(json(stand).offers).toContainEqual({ kind: 'registration_fill' })

      const a = await auftrag({ deviceRef: t.deviceRef, kind: 'registration_fill',
                                reservationRef: ref })
      expect(a.statusCode, a.body).toBe(201)
      // Die Antwort an die Rezeption traegt keinen Link.
      expect(a.body).not.toMatch(/token/i)

      const auf = await oeffnen(t.secret, json(a).jobRef)
      expect(auf.statusCode, auf.body).toBe(200)
      expect(auf.headers['cache-control']).toBe('no-store')
      const token = (json(auf).data as { token: string }).token
      expect(token.length).toBeGreaterThan(20)

      // Weder im Klartext in der Datenbank noch im Protokoll.
      const zeilen = await owner.query<{ z: string }>(
        `SELECT row_to_json(t)::text AS z FROM checkin_token t
         UNION ALL SELECT row_to_json(j)::text FROM terminal_job j
         UNION ALL SELECT changed::text FROM audit_log`)
      for (const z of zeilen.rows) expect(z.z).not.toContain(token)
      const kanal = await owner.query<{ channel: string }>(`SELECT channel FROM checkin_token`)
      expect(kanal.rows[0]!.channel).toBe('terminal')

      // Der Gast fuellt aus -- ueber die oeffentliche Route mit dem Link.
      const form = await app.inject({ method: 'GET', url: '/v1/checkin/form',
        headers: { [CHECKIN_TOKEN_HEADER]: token } })
      expect(form.statusCode, form.body).toBe(200)
      const ein = await app.inject({ method: 'POST', url: '/v1/checkin/form',
        headers: { [CHECKIN_TOKEN_HEADER]: token },
        payload: { guest: { lastName: 'Petersen', firstName: 'Anna', birthDate: '1980-05-17',
                            nationality: 'DE',
                            address: { line1: 'Deichweg 4', postalCode: '24937',
                                       city: 'Flensburg', country: 'DE' } },
                   confirmed: true } })
      expect(ein.statusCode, ein.body).toBe(201)

      const fertig = await abschliessen(t.secret, json(a).jobRef)
      expect(fertig.statusCode, fertig.body).toBe(200)
      expect(json(fertig).state).toBe('done')

      // Danach oeffnet der Link nichts mehr -- der naechste am Terminal soll
      // nicht an diesen Meldeschein kommen.
      const nachher = await app.inject({ method: 'GET', url: '/v1/checkin/form',
        headers: { [CHECKIN_TOKEN_HEADER]: token } })
      expect(nachher.statusCode).toBeGreaterThanOrEqual(400)
      const reg = await owner.query(`SELECT source FROM registration`)
      expect(reg.rows[0]).toEqual({ source: 'terminal' })
    })

  it('vermerkt einen Abschluss ohne Eingabe als abgebrochen', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Petersen'))
    const a = await auftrag({ deviceRef: t.deviceRef, kind: 'registration_fill',
                              reservationRef: ref })
    await oeffnen(t.secret, json(a).jobRef)
    const fertig = await abschliessen(t.secret, json(a).jobRef)
    expect(json(fertig).state).toBe('canceled')
    const j = await owner.query(`SELECT state, canceled_by FROM terminal_job`)
    expect(j.rows[0]).toEqual({ state: 'canceled', canceled_by: 'terminal' })
    const l = await owner.query<{ widerrufen: boolean }>(
      `SELECT revoked_at IS NOT NULL AS widerrufen FROM checkin_token`)
    expect(l.rows[0]!.widerrufen).toBe(true)
  })

  it('zieht den Link auch beim Abbruch durch die Rezeption zurueck', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Petersen'))
    const a = await auftrag({ deviceRef: t.deviceRef, kind: 'registration_fill',
                              reservationRef: ref })
    await oeffnen(t.secret, json(a).jobRef)
    const ab = await app.inject({ method: 'POST',
      url: `/v1/terminal-jobs/${json(a).jobRef}/cancel`, headers: chef })
    expect(ab.statusCode).toBe(200)
    const l = await owner.query<{ widerrufen: boolean }>(
      `SELECT revoked_at IS NOT NULL AS widerrufen FROM checkin_token`)
    expect(l.rows[0]!.widerrufen).toBe(true)
  })

  /*
   * Unter dem Dank der Gastseite steht am Terminal weiter "Abbrechen". Wer
   * eingereicht hat und dann darauf tippt -- oder die Rezeption bricht ab,
   * waehrend der Dank noch steht --, hat trotzdem einen Meldeschein
   * abgegeben. "Abgebrochen" an der Reservierung hiesse fuer die Rezeption:
   * nochmal schicken, und das scheiterte dann am vorhandenen Schein.
   */
  it('vermerkt einen Abbruch nach dem Einreichen als erledigt', async () => {
    for (const wer of ['terminal', 'rezeption'] as const) {
      await truncateAll()
      fx = await makeProperty(owner)
      catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
      zimmer = await makeResources(owner, fx.propertyId, catId, 4)
      await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
        [fx.propertyId])
      const u = await makeUser(owner,
        { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
      chef = { cookie: `hp_session=${u.sessionId}` }

      const t = await terminal()
      const ref = await reservierung(await gast('Petersen'))
      const a = await auftrag({ deviceRef: t.deviceRef, kind: 'registration_fill',
                                reservationRef: ref })
      const token = (json(await oeffnen(t.secret, json(a).jobRef)).data as { token: string }).token
      const ein = await app.inject({ method: 'POST', url: '/v1/checkin/form',
        headers: { [CHECKIN_TOKEN_HEADER]: token },
        payload: { guest: { lastName: 'Petersen', firstName: 'Anna', birthDate: '1980-05-17',
                            nationality: 'DE',
                            address: { line1: 'Deichweg 4', postalCode: '24937',
                                       city: 'Flensburg', country: 'DE' } },
                   confirmed: true } })
      expect(ein.statusCode, ein.body).toBe(201)

      const ab = wer === 'terminal'
        ? await app.inject({ method: 'POST', url: `/v1/terminal/job/${json(a).jobRef}/abort`,
            headers: geraet(t.secret), payload: { reason: 'guest' } })
        : await app.inject({ method: 'POST',
            url: `/v1/terminal-jobs/${json(a).jobRef}/cancel`, headers: chef })
      expect(ab.statusCode, ab.body).toBe(200)
      expect(json(ab).state, wer).toBe('done')
      const j = await owner.query(`SELECT state, canceled_by FROM terminal_job`)
      expect(j.rows[0], wer).toEqual({ state: 'done', canceled_by: null })
      const l = await owner.query<{ widerrufen: boolean }>(
        `SELECT revoked_at IS NOT NULL AS widerrufen FROM checkin_token`)
      expect(l.rows[0]!.widerrufen, wer).toBe(true)
    }
  })
})

describe('Hausbedingung am Terminal', () => {
  async function bedingung(requiresSignature: boolean): Promise<string> {
    const r = await app.inject({ method: 'POST',
      url: `/v1/properties/${fx.propertyId}/terms`, headers: chef,
      payload: { propertyId: fx.propertyId, code: 'karte', title: 'Zimmerkarte',
                 body: 'Bei Verlust 50 Euro.', requiresSignature, activeFrom: '2026-01-01' } })
    expect(r.statusCode, r.body).toBe(201)
    return json(r).termsRef as string
  }

  it('laeuft ueber denselben Weg wie am Tresen, mit dem Geraet im Protokoll', async () => {
    const t = await terminal()
    const termsRef = await bedingung(true)
    // Auch ein inlaendischer Gast: eine Hausbedingung ist kein Meldeschein.
    const ref = await reservierung(await gast('Petersen', 'DE'))

    const stand = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}/terminal`,
      headers: chef })
    expect(json(stand).offers).toContainEqual(
      { kind: 'terms_sign', ref: termsRef, label: 'Zimmerkarte' })

    const a = await auftrag({ deviceRef: t.deviceRef, kind: 'terms_sign',
                              reservationRef: ref, termsRef })
    expect(a.statusCode, a.body).toBe(201)
    const auf = await oeffnen(t.secret, json(a).jobRef)
    expect(json(auf).data).toEqual(
      { title: 'Zimmerkarte', body: 'Bei Verlust 50 Euro.', requiresSignature: true })

    // Eine Unterschrift fehlt, oder sie hat nicht die Form des Zeichenfelds.
    expect((await abschliessen(t.secret, json(a).jobRef)).statusCode).toBe(422)
    expect((await abschliessen(t.secret, json(a).jobRef,
      { signatureSvg: '<svg><script>alert(1)</script></svg>' })).statusCode).toBe(422)

    const ok = await abschliessen(t.secret, json(a).jobRef, { signatureSvg: UNTERSCHRIFT })
    expect(ok.statusCode, ok.body).toBe(200)
    const z = await owner.query<{ signed: boolean; created_by: string | null }>(
      `SELECT signature_svg IS NOT NULL AS signed, created_by FROM guest_agreement`)
    expect(z.rows[0]).toEqual({ signed: true, created_by: null })
    const prot = await owner.query<{ terminal_device_id: string | null }>(
      `SELECT terminal_device_id FROM audit_log
        WHERE table_name = 'guest_agreement' AND action = 'INSERT'`)
    expect(prot.rows[0]!.terminal_device_id).not.toBeNull()

    // Am Tresen ist sie danach erledigt -- dieselbe Zeile.
    const tresen = await app.inject({ method: 'POST',
      url: `/v1/reservations/${ref}/terms/${termsRef}/agree`, headers: chef,
      payload: { signatureSvg: UNTERSCHRIFT } })
    expect(tresen.statusCode).toBe(409)
  })

  it('verlangt eine Bedingung des Hauses, die noch offen ist', async () => {
    const t = await terminal()
    const ref = await reservierung(await gast('Petersen'))
    const r = await auftrag({ deviceRef: t.deviceRef, kind: 'terms_sign',
                              reservationRef: ref, termsRef: 'GIBTESNICHT' })
    expect(r.statusCode).toBe(404)
  })
})

describe('Seiten des Hauses', () => {
  it('zeigt eine Seite ohne Reservierung, mit Bild, und nur aus dem eigenen Haus', async () => {
    const t = await terminal()
    const contentRef = await seite('WLAN')
    const b = await bild(contentRef, PNG)
    expect(b.statusCode, b.body).toBe(200)
    expect(json(b).mime).toBe('image/png')

    const a = await auftrag({ deviceRef: t.deviceRef, kind: 'content', contentRef,
                              propertyId: fx.propertyId })
    expect(a.statusCode, a.body).toBe(201)
    const auf = await oeffnen(t.secret, json(a).jobRef)
    const d = json(auf).data as { title: string; body: string; imageRef: string }
    expect(d.title).toBe('WLAN')
    expect(d.imageRef).toBe(json(b).imageRef)

    const img = await app.inject({ method: 'GET', url: `/v1/terminal/images/${d.imageRef}`,
      headers: geraet(t.secret) })
    expect(img.statusCode).toBe(200)
    expect(img.headers['content-type']).toBe('image/png')
    expect(img.headers['x-content-type-options']).toBe('nosniff')
    expect(img.rawPayload.equals(PNG)).toBe(true)

    expect(json(await abschliessen(t.secret, json(a).jobRef)).state).toBe('done')

    // Ein fremdes Haus: weder sein Bild noch seine Seite.
    const f = await fremdesHaus()
    const fb = await app.inject({ method: 'PUT',
      url: `/v1/properties/${f.propertyId}/terminal-content/${f.contentRef}/image`,
      headers: f.chef, payload: { data: PNG.toString('base64') } })
    expect(fb.statusCode).toBe(200)
    const fremdesBild = await app.inject({ method: 'GET',
      url: `/v1/terminal/images/${json(fb).imageRef}`, headers: geraet(t.secret) })
    expect(fremdesBild.statusCode).toBe(404)
    const fremdeSeite = await auftrag({ deviceRef: t.deviceRef, kind: 'content',
      contentRef: f.contentRef, propertyId: fx.propertyId })
    expect(fremdeSeite.statusCode).toBe(404)
    // Und die eigene Rezeption schickt nichts an das fremde Haus.
    const fremdesTerminal = await auftrag({ deviceRef: f.deviceRef, kind: 'content',
      contentRef: f.contentRef, propertyId: f.propertyId })
    expect(fremdesTerminal.statusCode).toBe(403)
  })

  it('weist ein SVG ab, auch wenn es sich als PNG ausgibt', async () => {
    const contentRef = await seite('Werbung')
    const a = await bild(contentRef, SVG)
    expect(a.statusCode).toBe(422)
    const getarnt = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/terminal-content/${contentRef}/image`,
      headers: chef,
      payload: { data: `data:image/png;base64,${SVG.toString('base64')}` } })
    expect(getarnt.statusCode).toBe(422)
    const n = await owner.query(`SELECT 1 FROM terminal_content_image`)
    expect(n.rowCount).toBe(0)
  })

  it('weist ein zu grosses Bild ab', async () => {
    const contentRef = await seite('Gross')
    const r = await bild(contentRef, Buffer.concat([PNG, Buffer.alloc(1_048_576)]))
    expect(r.statusCode).toBe(422)
  })

  it('legt Bilddaten nicht ins Protokoll', async () => {
    const contentRef = await seite('Bild')
    await bild(contentRef, PNG)
    const p = await owner.query<{ changed: Record<string, unknown> }>(
      `SELECT changed FROM audit_log WHERE table_name = 'terminal_content_image'`)
    expect(p.rows[0]!.changed.bytes).toBe('[redigiert]')
  })
})

describe('Freigegebene Adressen', () => {
  it('nimmt nur https ohne Zugangsdaten und ohne innere Adresse', async () => {
    expect((await adresse('http://restaurant.example')).statusCode).toBe(422)
    expect((await adresse('https://nutzer:geheim@restaurant.example')).statusCode).toBe(422)
    expect((await adresse('https://192.168.0.1/')).statusCode).toBe(422)
    expect((await adresse('https://127.0.0.1/')).statusCode).toBe(422)
    expect((await adresse('javascript:alert(1)')).statusCode).toBe(422)
    const ok = await adresse('https://restaurant.example/karte')
    expect(ok.statusCode, ok.body).toBe(201)
  })

  it('zeigt nur, was auf der Liste steht -- nie eine Adresse aus dem Auftrag', async () => {
    const t = await terminal()
    // Eine Adresse im Auftrag selbst: es gibt keinen Weg, sie zu schicken.
    const roh = await auftrag({ deviceRef: t.deviceRef, kind: 'url',
      url: 'https://phishing.example', propertyId: fx.propertyId })
    expect(roh.statusCode).toBe(422)

    const frei = await adresse('https://restaurant.example/karte')
    const a = await auftrag({ deviceRef: t.deviceRef, kind: 'url', urlRef: json(frei).urlRef,
      url: 'https://phishing.example', propertyId: fx.propertyId })
    expect(a.statusCode, a.body).toBe(201)
    const auf = await oeffnen(t.secret, json(a).jobRef)
    expect(json(auf).data).toEqual(
      { label: 'Speisekarte', url: 'https://restaurant.example/karte' })

    // Zurueckgezogen ist zurueckgezogen.
    await abschliessen(t.secret, json(a).jobRef)
    await app.inject({ method: 'DELETE',
      url: `/v1/properties/${fx.propertyId}/terminal-urls/${json(frei).urlRef}`, headers: chef })
    const weg = await auftrag({ deviceRef: t.deviceRef, kind: 'url', urlRef: json(frei).urlRef,
      propertyId: fx.propertyId })
    expect(weg.statusCode).toBe(404)
  })

  it('nimmt keine Adresse eines fremden Hauses', async () => {
    const t = await terminal()
    const f = await fremdesHaus()
    const fremd = await adresse('https://fremd.example', f.propertyId, f.chef)
    const r = await auftrag({ deviceRef: t.deviceRef, kind: 'url',
      urlRef: json(fremd).urlRef, propertyId: fx.propertyId })
    expect(r.statusCode).toBe(404)
  })
})

describe('Diashow und Bedienfeld', () => {
  it('zeigt im Ruhezustand die Seiten in der festgelegten Reihenfolge', async () => {
    const t = await terminal()
    const eins = await seite('Fruehstueck')
    const zwei = await seite('Sauna')
    const r = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/terminal-slideshow`, headers: chef,
      payload: { slides: [{ contentRef: zwei, seconds: 8 }, { contentRef: eins, seconds: 12 }] } })
    expect(r.statusCode, r.body).toBe(200)

    const idle = await app.inject({ method: 'GET', url: '/v1/terminal/idle',
      headers: geraet(t.secret) })
    expect(idle.statusCode).toBe(200)
    const slides = json(idle).slides as Array<{ title: string; seconds: number }>
    expect(slides.map(s => [s.title, s.seconds])).toEqual([['Sauna', 8], ['Fruehstueck', 12]])

    // Eine fremde Seite gehoert nicht in die eigene Diashow.
    const f = await fremdesHaus()
    const fremd = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/terminal-slideshow`, headers: chef,
      payload: { slides: [{ contentRef: f.contentRef, seconds: 8 }] } })
    expect(fremd.statusCode).toBe(404)
    // Das fremde Terminal sieht die eigene Diashow nicht.
    const andere = await app.inject({ method: 'GET', url: '/v1/terminal/idle',
      headers: geraet(f.secret) })
    expect(json(andere).slides).toEqual([])
  })

  it('zeigt Terminals, ihren Auftrag und die Inhalte in einem Aufruf', async () => {
    const t = await terminal()
    const contentRef = await seite('WLAN')
    await adresse('https://restaurant.example/karte')
    await auftrag({ deviceRef: t.deviceRef, kind: 'content', contentRef,
                    propertyId: fx.propertyId })
    const pult = () => app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/terminal-desk`, headers: chef })
    /*
     * Zweimal gezaehlt, mit einem weiteren Terminal dazwischen -- angelegt
     * ueber die Eigentuemerrolle, deren Anweisungen der Zaehler nicht sieht.
     * Mehr Terminals duerfen nicht mehr Anweisungen kosten.
     */
    const { result, report } = await countQueries(pool, async () => {
      expect((await pult()).statusCode).toBe(200)
      await owner.query(
        `INSERT INTO terminal_device (property_id, name, secret_hash, paired_at)
         VALUES ($1, 'Zweites', '\\x01'::bytea, now())`, [fx.propertyId])
      return pult()
    })
    expect(result.statusCode, result.body).toBe(200)
    const d = json(result) as unknown as {
      terminals: Array<{ name: string; job: { kind: string; state: string; label: string } | null }>
      offers: Array<{ kind: string; label: string }> }
    expect(d.terminals).toHaveLength(2)
    expect(d.terminals.find(x => x.name === 'Touchscreen')!.job)
      .toMatchObject({ kind: 'content', state: 'pending', label: 'WLAN' })
    expect(d.offers.map(o => o.kind)).toEqual(['content', 'url'])
    const haelfte = report.count / 2
    expect(report.statements.slice(haelfte)).toEqual(report.statements.slice(0, haelfte))
  })

  it('verlangt fuer eine Seite ohne Reservierung das Recht im genannten Haus', async () => {
    const t = await terminal()
    const contentRef = await seite('WLAN')
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping' })
    const r = await auftrag({ deviceRef: t.deviceRef, kind: 'content', contentRef,
      propertyId: fx.propertyId }, { cookie: `hp_session=${hk.sessionId}` })
    expect(r.statusCode).toBe(403)
  })
})
