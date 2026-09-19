import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import type { DomainStand, DomainVerwaltung } from '../platform/brevoDomains.js'
import { DomainApiError } from '../platform/brevoDomains.js'

/**
 * Der Weg einer Absenderdomain: beantragen, freigeben, eintragen, nachsehen.
 *
 * **Was hier wirklich geprueft wird.** Nicht, ob ein Formular antwortet,
 * sondern ob die Kette dicht ist: dass ohne freigeschaltete Domain nichts
 * hinausgeht, und zwar auch dann nicht, wenn jemand an der Route vorbei
 * einreiht. Eine ungedeckte Absenderdomain geht **still** schief -- der
 * Anbieter nimmt die Nachricht an, die Pruefung beim Empfaenger schlaegt
 * fehl, die Post landet im Werbeordner, und der Versand meldet Erfolg.
 * Genau deshalb sitzt der Zaun in `email_enqueue` und nicht nur in der
 * Route.
 *
 * **Und die Mandantentrennung.** Der Antrag eines Hauses gehoert seinem
 * Mandanten; ein fremder sieht ihn nicht. Die Plattform sieht ihn dagegen
 * ohne Mandantenkontext -- ueber eine SECURITY-DEFINER-Funktion, weil eine
 * gewoehnliche Abfrage hier **still leer** zurueckkaeme (0014, 0018, 0032).
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

/*
 * Ein Anbieter, der nicht ins Netz greift, aber wie der echte antwortet.
 * Keine Attrappe der Fassade dahinter: geprueft wird der Weg durch die
 * Routen, nicht Brevos HTTP-Format -- das prueft der Client fuer sich.
 */
function fakeAnbieter(): DomainVerwaltung & {
  angemeldet: string[]; eintraegeStehen: boolean
} {
  const zustand = {
    angemeldet: [] as string[],
    eintraegeStehen: false,
    async anmelden(domain: string): Promise<DomainStand> {
      zustand.angemeldet.push(domain)
      return {
        domain, providerId: '4711', verified: false, authenticated: false,
        records: [
          { host: '@', type: 'TXT', value: 'brevo-code=abc', ok: false },
          { host: 'mail._domainkey', type: 'TXT', value: 'v=DKIM1; p=xy', ok: false }
        ]
      }
    },
    async nachsehen(domain: string): Promise<DomainStand> {
      // Wie der echte: unbekannte Domain ist 404, und die Freigabe meldet
      // sie daraufhin an.
      if (!zustand.angemeldet.includes(domain)) {
        throw new DomainApiError(404, 'unbekannt')
      }
      const ok = zustand.eintraegeStehen
      return {
        domain, providerId: '4711', verified: ok, authenticated: ok,
        records: [
          { host: '@', type: 'TXT', value: 'brevo-code=abc', ok },
          { host: 'mail._domainkey', type: 'TXT', value: 'v=DKIM1; p=xy', ok }
        ]
      }
    },
    async pruefenLassen(domain: string): Promise<DomainStand> {
      return zustand.nachsehen(domain)
    },
    async entfernen(): Promise<void> { /* im Test nichts zu tun */ }
  }
  return zustand
}

let anbieter: ReturnType<typeof fakeAnbieter>

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  anbieter = fakeAnbieter()
  registerAllRoutes(app, { domains: anbieter })
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  anbieter.angemeldet.length = 0
  anbieter.eintraegeStehen = false
  fx = await makeProperty(owner, { name: 'Wattenblick' })
  chef = await makeUser(owner,
    { email: 'chef@wattenblick.de', propertyId: fx.propertyId,
      roleKey: 'hotel_director' })
  admin = await makeUser(owner,
    { email: 'admin@wir.de', platformRoleKey: 'platform_admin',
      isPlatformStaff: true })
})

const beantragen = (body: unknown, session = chef.sessionId) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/email-domain`,
               headers: auth(session), payload: body })
const stand = (session = chef.sessionId) =>
  app.inject({ method: 'GET', url: `/v1/properties/${fx.propertyId}/email-domain`,
               headers: auth(session) })
const nachsehen = (session = chef.sessionId) =>
  app.inject({ method: 'POST',
               url: `/v1/properties/${fx.propertyId}/email-domain/check`,
               headers: auth(session), payload: {} })
const zuruecknehmen = (session = chef.sessionId) =>
  app.inject({ method: 'DELETE', url: `/v1/properties/${fx.propertyId}/email-domain`,
               headers: auth(session) })
const antraege = (session = admin.sessionId) =>
  app.inject({ method: 'GET', url: '/v1/platform/email-domains',
               headers: auth(session) })
const freigeben = (session = admin.sessionId) =>
  app.inject({ method: 'POST',
               url: `/v1/platform/email-domains/${fx.propertyId}/approve`,
               headers: auth(session), payload: {} })
const ablehnen = (note: string, session = admin.sessionId) =>
  app.inject({ method: 'POST',
               url: `/v1/platform/email-domains/${fx.propertyId}/reject`,
               headers: auth(session), payload: { note } })

const absender = (enabled: boolean, fromEmail = 'post@wattenblick.de') =>
  app.inject({ method: 'PUT',
               url: `/v1/properties/${fx.propertyId}/email-settings`,
               headers: auth(chef.sessionId),
               payload: { fromName: 'Hotel Wattenblick', fromEmail, enabled } })

describe('Antrag', () => {
  it('nimmt eine eigene Domain an und weist sie dem Adminpanel zu', async () => {
    const r = await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    expect(r.statusCode, r.body).toBe(202)

    const s = JSON.parse((await stand()).body)
    expect(s.status).toBe('requested')
    expect(s.domain).toBe('wattenblick.de')

    const a = JSON.parse((await antraege()).body)
    expect(a.requests).toHaveLength(1)
    expect(a.requests[0]).toMatchObject({
      domain: 'wattenblick.de', propertyName: 'Wattenblick',
      status: 'requested', requestedByName: expect.any(String)
    })
  })

  it('nimmt eine ganze Adresse und behaelt nur die Domain', async () => {
    // Wer eine Adresse eintippt, meint ihre Domain. Das abzuweisen waere
    // formal richtig und praktisch aergerlich.
    await beantragen({ mode: 'own', domain: 'Info@Wattenblick.DE' })
    expect(JSON.parse((await stand()).body).domain).toBe('wattenblick.de')
  })

  it('weist eine Freemail-Adresse ab, bevor jemand sie bearbeitet', async () => {
    /*
     * Der Anbieter wuerde sie ohnehin abweisen. Die Meldung muss aber
     * ankommen, **bevor** ein Mensch bei uns drei Tage lang nichts
     * entscheidet -- sonst hat das Haus drei Tage verloren.
     */
    const r = await beantragen({ mode: 'own', domain: 'wattenblick@gmx.de' })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('domain.freemail')
    expect(JSON.parse((await antraege()).body).requests).toHaveLength(0)
  })

  it('laesst keinen zweiten Antrag neben einen offenen', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    const r = await beantragen({ mode: 'own', domain: 'anders.de' })
    expect(r.statusCode).toBe(409)
  })

  it('haelt hoechstens einen Hinweis an uns offen', async () => {
    /*
     * Zehn Antraege an einem Vormittag sollen zehn Zeilen im Adminpanel
     * ergeben und **eine** Mail. Eine je Antrag waere ein Postfach, das
     * niemand mehr liest -- und damit genau so nutzlos wie gar keine.
     */
    const fx2 = await makeProperty(owner, { name: 'Zweites' })
    const chef2 = await makeUser(owner,
      { email: 'chef@zweites.de', propertyId: fx2.propertyId,
        roleKey: 'hotel_director' })
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    await app.inject({ method: 'POST',
      url: `/v1/properties/${fx2.propertyId}/email-domain`,
      headers: auth(chef2.sessionId), payload: { mode: 'own', domain: 'zweites.de' } })

    const post = await owner.query<{ n: string; subject: string }>(
      `SELECT count(*) AS n, min(subject) AS subject FROM platform_email
        WHERE kind = 'domain_request'`)
    expect(Number(post.rows[0]!.n)).toBe(1)
    // Kein Name eines Menschen in einer Nachricht, die ihn nicht braucht.
    expect(post.rows[0]!.subject).not.toContain('@')
  })

  it('nimmt einem Uebungshaus den Antrag ab, statt jemanden zu beschaeftigen', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`,
      [fx.propertyId])
    const r = await beantragen({ mode: 'own', domain: 'uebung.de' })
    expect(r.statusCode).toBe(422)
  })
})

describe('Freigabe durch die Plattform', () => {
  it('meldet die Domain an und zeigt dem Haus die Eintraege', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    const r = await freigeben()
    expect(r.statusCode, r.body).toBe(200)
    expect(anbieter.angemeldet).toEqual(['wattenblick.de'])

    const s = JSON.parse((await stand()).body)
    expect(s.status).toBe('dns_pending')
    // Genau die drei Zeilen zum Abtippen, mit ihrem Stand daneben.
    expect(s.dnsRecords).toHaveLength(2)
    expect(s.dnsRecords[0]).toMatchObject({ host: '@', type: 'TXT', ok: false })
  })

  it('schaltet den zweiten Weg sofort frei, weil dort nichts einzutragen ist', async () => {
    // relay laeuft unter unserer eigenen Unterdomain; die ist beim Anbieter
    // einmal hinterlegt, und das Haus bekommt darunter nur einen Namensteil.
    await beantragen({ mode: 'relay', localPart: 'wattenblick' })
    await freigeben()
    const s = JSON.parse((await stand()).body)
    expect(s.status).toBe('active')
    expect(s.mode).toBe('relay')
    expect(anbieter.angemeldet).toHaveLength(0)
  })

  it('laesst eine Ablehnung nicht ohne Grund zu und gibt ihn dem Kunden', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    expect((await ablehnen('  ')).statusCode).toBe(422)

    const r = await ablehnen('Die Domain gehoert laut Register jemand anderem.')
    expect(r.statusCode, r.body).toBe(200)
    const s = JSON.parse((await stand()).body)
    expect(s.status).toBe('rejected')
    expect(s.decisionNote).toContain('jemand anderem')
  })

  it('entscheidet nicht zweimal', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    await freigeben()
    expect((await freigeben()).statusCode).toBe(409)
  })

  it('bleibt einem Hotelbenutzer verschlossen', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    expect((await antraege(chef.sessionId)).statusCode).toBe(403)
    expect((await freigeben(chef.sessionId)).statusCode).toBe(403)
  })

  it('laesst den Antrag offen, wenn der Anbieter nicht mitspielt', async () => {
    /*
     * Ein halb freigegebener Antrag waere schlimmer als ein offener: das
     * Haus saehe DNS-Eintraege, die es nie gab, und truege sie ein.
     */
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    const kaputt = { ...anbieter,
      nachsehen: () => Promise.reject(new DomainApiError(500, 'kaputt')),
      anmelden: () => Promise.reject(new DomainApiError(500, 'kaputt')) }
    const eigene = await buildServer({ pool: appPool(4) })
    registerAllRoutes(eigene.app, { domains: kaputt as unknown as DomainVerwaltung })
    await eigene.app.ready()
    try {
      const r = await eigene.app.inject({ method: 'POST',
        url: `/v1/platform/email-domains/${fx.propertyId}/approve`,
        headers: auth(admin.sessionId), payload: {} })
      expect(r.statusCode).toBe(502)
    } finally {
      await eigene.app.close(); await eigene.pool.end()
    }
    expect(JSON.parse((await stand()).body).status).toBe('requested')
  })
})

describe('Nachsehen beim Anbieter', () => {
  it('schaltet frei, sobald beide Eintraege stehen', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    await freigeben()

    // Noch nichts eingetragen: der Stand bleibt, aber er ist jetzt datiert.
    const r1 = await nachsehen()
    expect(r1.statusCode, r1.body).toBe(200)
    expect(JSON.parse(r1.body).status).toBe('dns_pending')
    expect(JSON.parse(r1.body).checkedAt).not.toBeNull()

    anbieter.eintraegeStehen = true
    const r2 = await nachsehen()
    expect(JSON.parse(r2.body)).toMatchObject({
      status: 'active', verified: true, authenticated: true })
  })

  it('laesst sich vor der Freigabe nicht aufrufen', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    expect((await nachsehen()).statusCode).toBe(409)
  })
})

describe('Versand erst mit freigeschalteter Domain', () => {
  async function freigeschaltet(): Promise<void> {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    await freigeben()
    anbieter.eintraegeStehen = true
    await nachsehen()
  }

  it('laesst sich ohne Domain nicht einschalten', async () => {
    const r = await absender(true)
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('domain.notActive')
  })

  it('laesst sich waehrend der Wartezeit nicht einschalten', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    await freigeben()
    expect((await absender(true)).statusCode).toBe(422)
  })

  it('laesst die Angaben ohne Domain speichern, nur nicht eingeschaltet', async () => {
    // Ein Haus soll Absendername und Adresse eintragen koennen, waehrend es
    // auf die Freigabe wartet. Sonst muesste es zweimal kommen.
    expect((await absender(false)).statusCode).toBe(200)
  })

  it('laesst sich nach der Freischaltung einschalten', async () => {
    await freigeschaltet()
    const r = await absender(true)
    expect(r.statusCode, r.body).toBe(200)
  })

  it('weist eine Absenderadresse auf einer fremden Domain ab', async () => {
    /*
     * Gleichheit auf der Domain, nicht Endung: wer auf `wattenblick.de`
     * endet, ist auch `nicht-wattenblick.de`.
     */
    await freigeschaltet()
    const r = await absender(true, 'post@nicht-wattenblick.de')
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('domain.senderMismatch')
  })

  it('schaltet den Versand mit der Ruecknahme aus', async () => {
    /*
     * Zurueckzunehmen und den Versand eingeschaltet zu lassen hiesse: ab
     * jetzt scheitert jede Rechnung beim Einreihen, mit einer Meldung ueber
     * eine Domain, die niemand mehr sucht.
     */
    await freigeschaltet()
    await absender(true)
    expect((await zuruecknehmen()).statusCode).toBe(200)
    const e = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/email-settings`,
      headers: auth(chef.sessionId) })
    expect(JSON.parse(e.body).enabled).toBe(false)
  })
})

describe('Der Zaun in der Datenbank', () => {
  /*
   * Eine Reservierung, weil `outbound_email` einen Bezug verlangt: eine
   * Bestaetigung ohne Buchung waere eine Nachricht ueber nichts.
   */
  async function reservierung(): Promise<number> {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, catId, 2)
    await owner.query(
      `SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
      [fx.propertyId])
    const r = await makeReservation(owner, { propertyId: fx.propertyId,
      categoryId: catId, arrival: '2026-10-01', departure: '2026-10-03' })
    return r.reservationId
  }

  it('reiht nichts ein, wenn die Domain nicht freigeschaltet ist', async () => {
    const resId = await reservierung()
    /*
     * Der eigentliche Punkt dieser Migration. Die Route ist die Antwort an
     * einen Menschen; das hier ist der Zaun. Wer die Einstellung an der
     * Route vorbei setzt -- ein Skript, ein Import, ein spaeterer
     * Endpunkt --, kommt trotzdem nicht durch.
     */
    await owner.query(
      `INSERT INTO property_email_setting
         (property_id, from_name, from_email, enabled)
       VALUES ($1,'Hotel','post@wattenblick.de',true)`, [fx.propertyId])

    await expect(owner.query(
      `SELECT set_config('app.account_id', $1::text, false),
              set_config('app.property_ids', $2::text, false)`,
      [String(fx.accountId), String(fx.propertyId)])).resolves.toBeDefined()
    await expect(owner.query(
      `SELECT email_enqueue($1,'reservation_confirmation','gast@test.de','Gast',
                            'Betreff','Text',NULL,NULL,$2,NULL)`,
      [fx.propertyId, resId])).rejects.toThrow(/nicht freigeschaltet/)
  })

  it('laesst denselben Aufruf mit freigeschalteter Domain durch', async () => {
    const resId = await reservierung()
    await owner.query(
      `INSERT INTO property_email_domain
         (property_id, mode, domain, status, verified, authenticated)
       VALUES ($1,'own','wattenblick.de','active',true,true)`, [fx.propertyId])
    await owner.query(
      `INSERT INTO property_email_setting
         (property_id, from_name, from_email, enabled)
       VALUES ($1,'Hotel','post@wattenblick.de',true)`, [fx.propertyId])
    await owner.query(
      `SELECT set_config('app.account_id', $1::text, false),
              set_config('app.property_ids', $2::text, false)`,
      [String(fx.accountId), String(fx.propertyId)])
    const r = await owner.query<{ ref: string }>(
      `SELECT email_enqueue($1,'reservation_confirmation','gast@test.de','Gast',
                            'Betreff','Text',NULL,NULL,$2,NULL) AS ref`,
      [fx.propertyId, resId])
    expect(r.rows[0]!.ref).toMatch(/\w/)
  })
})

describe('Trennung der Mandanten', () => {
  it('zeigt einem fremden Haus den Antrag nicht', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })

    const fremd = await makeProperty(owner, { name: 'Fremd' })
    const fremdChef = await makeUser(owner,
      { email: 'chef@fremd.de', propertyId: fremd.propertyId,
        roleKey: 'hotel_director' })
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fremd.propertyId}/email-domain`,
      headers: auth(fremdChef.sessionId) })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).status).toBeNull()

    // Und die fremde Property-ID im Pfad hilft auch nicht weiter: der
    // Kontext kommt aus dem Token, nie aus dem Pfad.
    const q = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/email-domain`,
      headers: auth(fremdChef.sessionId) })
    expect(q.statusCode).toBe(403)
  })

  it('belegt eine Domain nicht zweimal', async () => {
    await beantragen({ mode: 'own', domain: 'wattenblick.de' })
    const fremd = await makeProperty(owner, { name: 'Fremd' })
    const fremdChef = await makeUser(owner,
      { email: 'chef@fremd.de', propertyId: fremd.propertyId,
        roleKey: 'hotel_director' })
    const r = await app.inject({ method: 'POST',
      url: `/v1/properties/${fremd.propertyId}/email-domain`,
      headers: auth(fremdChef.sessionId),
      payload: { mode: 'own', domain: 'wattenblick.de' } })
    expect(r.statusCode).toBe(409)
  })

  it('laesst denselben Namensteil unter der Unterdomain nur einmal zu', async () => {
    // Zwei "rezeption@" waeren zwei Haeuser in einem Postfach.
    await beantragen({ mode: 'relay', localPart: 'rezeption' })
    const fremd = await makeProperty(owner, { name: 'Fremd' })
    const fremdChef = await makeUser(owner,
      { email: 'chef@fremd.de', propertyId: fremd.propertyId,
        roleKey: 'hotel_director' })
    const r = await app.inject({ method: 'POST',
      url: `/v1/properties/${fremd.propertyId}/email-domain`,
      headers: auth(fremdChef.sessionId),
      payload: { mode: 'relay', localPart: 'rezeption' } })
    expect(r.statusCode).toBe(409)
  })
})
