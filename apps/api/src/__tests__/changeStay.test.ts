import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let ez: number
let auth: Record<string, string>

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
  fx = await makeProperty(owner)
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  ez = await makeCategory(owner, fx.propertyId, { code: 'EZ' })
  await makeResources(owner, fx.propertyId, dz, 2)
  await makeResources(owner, fx.propertyId, ez, 2, 'E')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

async function reservierung(
  opts: { categoryId?: number; arrival?: string; departure?: string } = {}
): Promise<string> {
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: opts.categoryId ?? dz,
    arrival: opts.arrival ?? '2026-10-01', departure: opts.departure ?? '2026-10-04',
    priceCent: 9_000 })
  const ref = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])
  return ref.rows[0]!.public_ref
}

const aendern = (ref: string, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: `/v1/reservations/${ref}/change-stay`,
  headers: auth, payload: body })

async function sold(categoryId: number, date: string): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
    [fx.propertyId, categoryId, date])
  return r.rows[0]!.sold
}

describe('Aufenthalt aendern', () => {
  it('verlaengert und bindet nur die neue Nacht', async () => {
    const ref = await reservierung()
    const r = await aendern(ref, { departure: '2026-10-06' })
    expect(r.statusCode, r.body).toBe(200)
    expect((JSON.parse(r.body) as { nights: number }).nights).toBe(5)

    expect(await sold(dz, '2026-10-01')).toBe(1)   // unveraendert
    expect(await sold(dz, '2026-10-04')).toBe(1)   // neu gebunden
    expect(await sold(dz, '2026-10-05')).toBe(1)
    expect(await sold(dz, '2026-10-06')).toBe(0)   // Abreisenacht gibt es nicht
  })

  /**
   * Die Falle, deretwegen `inventory_move` nur die Differenz bindet: wer bei
   * einer Verlängerung erst alles freigibt und neu bindet, konkurriert mit
   * sich selbst und scheitert im vollen Haus an der eigenen Buchung.
   */
  it('verlaengert auch dann, wenn das Haus sonst ausgebucht ist', async () => {
    const ref = await reservierung()
    // Das zweite Doppelzimmer ueber den ganzen Zeitraum belegen.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-01', departure: '2026-10-06' })
    expect(await sold(dz, '2026-10-03')).toBe(2)   // voll

    const r = await aendern(ref, { departure: '2026-10-05' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await sold(dz, '2026-10-04')).toBe(2)
  })

  it('verkuerzt und gibt die entfallenen Naechte frei', async () => {
    const ref = await reservierung()
    const r = await aendern(ref, { departure: '2026-10-02' })
    expect(r.statusCode).toBe(200)

    expect(await sold(dz, '2026-10-01')).toBe(1)
    expect(await sold(dz, '2026-10-02')).toBe(0)
    expect(await sold(dz, '2026-10-03')).toBe(0)

    const n = await owner.query(`SELECT 1 FROM reservation_night
      WHERE property_id = $1 AND date >= '2026-10-02'`, [fx.propertyId])
    expect(n.rowCount).toBe(0)
  })

  /** Der Fall aus E11: laenger bleiben, aber die Kategorie ist ausgebucht. */
  it('verlaengert mit Kategoriewechsel in einem Zug', async () => {
    const ref = await reservierung()
    // Beide Doppelzimmer ab dem 4. belegt.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })
    expect(await sold(dz, '2026-10-04')).toBe(2)

    // Im Doppelzimmer ginge es nicht, im Einzelzimmer schon.
    const abgelehnt = await aendern(ref, { departure: '2026-10-06' })
    expect(abgelehnt.statusCode).toBe(409)

    const r = await aendern(ref, { departure: '2026-10-06', categoryId: ez })
    expect(r.statusCode, r.body).toBe(200)

    // Der ganze neue Zeitraum liegt jetzt im Einzelzimmer, das alte ist frei.
    expect(await sold(ez, '2026-10-01')).toBe(1)
    expect(await sold(ez, '2026-10-05')).toBe(1)
    expect(await sold(dz, '2026-10-01')).toBe(0)
  })

  it('laesst bei fehlgeschlagener Aenderung den alten Stand unberuehrt', async () => {
    const ref = await reservierung()
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })

    const r = await aendern(ref, { departure: '2026-10-06' })
    expect(r.statusCode).toBe(409)

    // Der urspruengliche Aufenthalt steht unveraendert.
    expect(await sold(dz, '2026-10-01')).toBe(1)
    expect(await sold(dz, '2026-10-03')).toBe(1)
    const res = await owner.query<{ departure: string }>(
      `SELECT departure::text FROM reservation WHERE public_ref = $1`, [ref])
    expect(res.rows[0]!.departure).toBe('2026-10-04')
  })

  it('loest die Zimmerzuweisung beim Kategoriewechsel', async () => {
    const ref = await reservierung()
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE category_id = $1 LIMIT 1`, [dz])
    await owner.query(`UPDATE reservation SET resource_id = $2 WHERE public_ref = $1`,
      [ref, zimmer.rows[0]!.id])

    const r = await aendern(ref, { categoryId: ez })
    expect(r.statusCode).toBe(200)
    expect((JSON.parse(r.body) as { roomAssignmentCleared: boolean })
      .roomAssignmentCleared).toBe(true)

    const res = await owner.query<{ resource_id: number | null }>(
      `SELECT resource_id FROM reservation WHERE public_ref = $1`, [ref])
    expect(res.rows[0]!.resource_id).toBeNull()
  })

  it('laesst die Anreise eines Gastes im Haus nicht verlegen', async () => {
    const ref = await reservierung()
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE category_id = $1 LIMIT 1`, [dz])
    await owner.query(
      `UPDATE reservation SET status = 'InHouse', resource_id = $2 WHERE public_ref = $1`,
      [ref, zimmer.rows[0]!.id])

    expect((await aendern(ref, { arrival: '2026-10-02' })).statusCode).toBe(409)
    // Verlaengern geht dagegen, und das ist der haeufigste Fall ueberhaupt.
    expect((await aendern(ref, { departure: '2026-10-06' })).statusCode).toBe(200)
  })

  it('aendert eine stornierte Reservierung nicht', async () => {
    const ref = await reservierung()
    await owner.query(
      `UPDATE reservation SET status = 'Canceled', canceled_at = now() WHERE public_ref = $1`,
      [ref])
    const r = await aendern(ref, { departure: '2026-10-06' })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).detail).toContain('bindet kein Kontingent')
  })

  it('weist eine Zimmergruppe eines fremden Hauses ab', async () => {
    const ref = await reservierung()
    const andere = await makeProperty(owner, { code: 'FREMD' })
    const fremd = await makeCategory(owner, andere.propertyId, { code: 'X' })
    expect((await aendern(ref, { categoryId: fremd })).statusCode).toBe(404)
  })

  /**
   * Schraeg verlegen: anderes Zimmer **und** andere Tage in einem Aufruf.
   *
   * Gemeldet aus dem Plan: "ich kann hoch, runter, links und rechts
   * ziehen, aber nicht schraeg nach rechts unten -- und wenn nur dort eine
   * Luecke ist, komme ich auch nicht in zwei Schritten hin".
   */
  describe('Zimmer und Tage zusammen', () => {
    /** Zwei Doppelzimmer, das erste belegt die Reservierung. */
    async function zimmerIds(): Promise<number[]> {
      const r = await owner.query<{ id: number }>(
        `SELECT id FROM resource WHERE category_id = $1 ORDER BY code`, [dz])
      return r.rows.map(x => x.id)
    }

    it('verlegt Zimmer und Zeitraum in einem Aufruf', async () => {
      const [z1, z2] = await zimmerIds()
      const ref = await reservierung()
      await owner.query(`UPDATE reservation SET resource_id = $2 WHERE public_ref = $1`,
        [ref, z1])

      const r = await aendern(ref, {
        arrival: '2026-10-05', departure: '2026-10-08', resourceId: z2 })
      expect(r.statusCode).toBe(200)

      const nach = await owner.query<{ resource_id: number; arrival: string }>(
        `SELECT resource_id, arrival::text FROM reservation WHERE public_ref = $1`, [ref])
      expect(nach.rows[0]!.resource_id).toBe(z2)
      expect(nach.rows[0]!.arrival).toBe('2026-10-05')
    })

    it('kommt an die Luecke heran, an die zwei Schritte nicht kommen', async () => {
      /*
       * Der gemeldete Fall, als Besetzung: Zimmer 1 hat den Gast vom 1.
       * bis zum 4. und ist ab dem 5. weiterbelegt; Zimmer 2 ist bis zum
       * 5. belegt und danach frei. Die Luecke liegt diagonal.
       *
       * Einzeln geht keiner der beiden Schritte -- und das ist der Grund,
       * warum der Zug beides zugleich koennen muss.
       */
      const [z1, z2] = await zimmerIds()
      const ref = await reservierung()
      await owner.query(`UPDATE reservation SET resource_id = $2 WHERE public_ref = $1`,
        [ref, z1])
      // Zimmer 1 ab dem 5. weiterbelegt -> nur nach rechts geht nicht.
      const sperre1 = await makeReservation(owner, {
        propertyId: fx.propertyId, categoryId: dz,
        arrival: '2026-10-05', departure: '2026-10-09', priceCent: 9_000 })
      await owner.query(`UPDATE reservation SET resource_id = $2 WHERE id = $1`,
        [sperre1.reservationId, z1])
      // Zimmer 2 bis zum 5. belegt -> nur nach unten geht auch nicht.
      const sperre2 = await makeReservation(owner, {
        propertyId: fx.propertyId, categoryId: dz,
        arrival: '2026-09-28', departure: '2026-10-05', priceCent: 9_000 })
      await owner.query(`UPDATE reservation SET resource_id = $2 WHERE id = $1`,
        [sperre2.reservationId, z2])

      // Erst die Tage: das eigene Zimmer ist ab dem 5. belegt.
      expect((await aendern(ref, { arrival: '2026-10-05', departure: '2026-10-08' }))
        .statusCode).toBe(409)
      // Erst das Zimmer: dort liegt an den alten Tagen jemand.
      expect((await app.inject({
        method: 'POST', url: `/v1/reservations/${ref}/assign-unit`,
        headers: auth, payload: { resourceId: z2 } })).statusCode).toBe(409)

      // Zusammen geht es.
      const r = await aendern(ref, {
        arrival: '2026-10-05', departure: '2026-10-08', resourceId: z2 })
      expect(r.statusCode).toBe(200)
      const nach = await owner.query<{ resource_id: number; arrival: string }>(
        `SELECT resource_id, arrival::text FROM reservation WHERE public_ref = $1`, [ref])
      expect(nach.rows[0]!.resource_id).toBe(z2)
      expect(nach.rows[0]!.arrival).toBe('2026-10-05')
    })

    it('weist ein belegtes Zielzimmer ab', async () => {
      const [z1, z2] = await zimmerIds()
      const ref = await reservierung()
      await owner.query(`UPDATE reservation SET resource_id = $2 WHERE public_ref = $1`,
        [ref, z1])
      const fremd = await makeReservation(owner, {
        propertyId: fx.propertyId, categoryId: dz,
        arrival: '2026-10-05', departure: '2026-10-09', priceCent: 9_000 })
      await owner.query(`UPDATE reservation SET resource_id = $2 WHERE id = $1`,
        [fremd.reservationId, z2])

      const r = await aendern(ref, {
        arrival: '2026-10-05', departure: '2026-10-08', resourceId: z2 })
      expect(r.statusCode).toBe(409)
      // Und nichts ist halb geschehen: die Tage stehen noch wie vorher.
      const nach = await owner.query<{ resource_id: number; arrival: string }>(
        `SELECT resource_id, arrival::text FROM reservation WHERE public_ref = $1`, [ref])
      expect(nach.rows[0]!.resource_id).toBe(z1)
      expect(nach.rows[0]!.arrival).toBe('2026-10-01')
    })

    it('nimmt ein Zimmer aus einem fremden Haus nicht an', async () => {
      // Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus
      // (CLAUDE.md). Bei einem Benutzer mit zwei Haeusern faengt sie es
      // nicht ab.
      const andere = await makeProperty(owner)
      const fremdeKat = await makeCategory(owner, andere.propertyId, { code: 'X' })
      await makeResources(owner, andere.propertyId, fremdeKat, 1, 'F')
      const f = await owner.query<{ id: number }>(
        `SELECT id FROM resource WHERE category_id = $1`, [fremdeKat])
      const ref = await reservierung()
      expect((await aendern(ref, {
        arrival: '2026-10-05', departure: '2026-10-08',
        resourceId: f.rows[0]!.id })).statusCode).toBe(404)
    })

    it('behaelt das Zimmer, wenn keines genannt ist', async () => {
      const [z1] = await zimmerIds()
      const ref = await reservierung()
      await owner.query(`UPDATE reservation SET resource_id = $2 WHERE public_ref = $1`,
        [ref, z1])
      await aendern(ref, { arrival: '2026-10-02', departure: '2026-10-05' })
      const nach = await owner.query<{ resource_id: number }>(
        `SELECT resource_id FROM reservation WHERE public_ref = $1`, [ref])
      expect(nach.rows[0]!.resource_id).toBe(z1)
    })

    it('nimmt das Zimmer bei einem angereisten Gast nicht ab', async () => {
      // Er liegt darin. Die Zeile im Plan zu leeren hiesse, Hausliste und
      // Reinigung auf ein leeres Zimmer zu schicken, in dem jemand schlaeft.
      const [z1] = await zimmerIds()
      const ref = await reservierung()
      await owner.query(
        `UPDATE reservation SET status = 'InHouse', resource_id = $2 WHERE public_ref = $1`,
        [ref, z1])
      expect((await aendern(ref, { departure: '2026-10-06', resourceId: null }))
        .statusCode).toBe(409)
    })
  })

  it('behaelt bereits gebuchte Naechte beim Verkuerzen', async () => {
    const ref = await reservierung()
    await owner.query(
      `UPDATE reservation_night SET posted = true
        WHERE date = '2026-10-01' AND reservation_id =
              (SELECT id FROM reservation WHERE public_ref = $1)`, [ref])

    await aendern(ref, { arrival: '2026-10-02', departure: '2026-10-04' })
    // Die gebuchte Nacht bleibt: an ihr haengt ein Beleg auf dem Folio.
    const n = await owner.query<{ date: string; posted: boolean }>(
      `SELECT date::text, posted FROM reservation_night
        WHERE property_id = $1 ORDER BY date`, [fx.propertyId])
    expect(n.rows[0]!.date).toBe('2026-10-01')
    expect(n.rows[0]!.posted).toBe(true)
  })
})

/**
 * Preis beim Aendern (Sven, 05.10.2026): eine Verlaengerung aendert den
 * Preis, und die Maske zeigt ihn, bevor gespeichert wird.
 */
describe('Preis beim Aendern des Aufenthalts', () => {
  const preise = async (ref: string): Promise<number[]> => {
    const r = await owner.query<{ price_cent: string }>(
      `SELECT n.price_cent FROM reservation_night n
         JOIN reservation r ON r.id = n.reservation_id
        WHERE r.public_ref = $1 ORDER BY n.date`, [ref])
    return r.rows.map(x => Number(x.price_cent))
  }
  const vorschau = (ref: string, body: Record<string, unknown>) => app.inject({
    method: 'POST', url: `/v1/reservations/${ref}/change-stay/preview`,
    headers: auth, payload: body })

  it('rechnet neue Naechte ohne Ratenplan zum bisherigen Preis, nicht zu null', async () => {
    // Wie eine Buchung aus dem Altsystem: kein Plan, nur Preise je Nacht.
    const ref = await reservierung()
    const r = await aendern(ref, { departure: '2026-10-06' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await preise(ref)).toEqual([9_000, 9_000, 9_000, 9_000, 9_000])
    expect((JSON.parse(r.body) as { totalCent: number }).totalCent).toBe(45_000)
  })

  it('verteilt einen vereinbarten Gesamtpreis auf die Naechte', async () => {
    const ref = await reservierung()
    const r = await aendern(ref, { departure: '2026-10-05', totalCent: 40_001 })
    expect(r.statusCode, r.body).toBe(200)
    expect(await preise(ref)).toEqual([10_001, 10_000, 10_000, 10_000])
  })

  it('aendert nur den Preis, ohne Bestand zu bewegen', async () => {
    const ref = await reservierung()
    const r = await aendern(ref, { priceCent: 7_500 })
    expect(r.statusCode, r.body).toBe(200)
    expect(await preise(ref)).toEqual([7_500, 7_500, 7_500])
    // Kein Bestand bewegt: dieselben Tage bleiben einmal gebunden.
    expect(await sold(dz, '2026-10-01')).toBe(1)
  })

  it('laesst gebuchte Naechte stehen und verteilt nur den Rest', async () => {
    const ref = await reservierung()
    await owner.query(
      `UPDATE reservation_night SET posted = true
        WHERE date = '2026-10-01' AND reservation_id =
              (SELECT id FROM reservation WHERE public_ref = $1)`, [ref])
    const r = await aendern(ref, { totalCent: 25_000 })
    expect(r.statusCode, r.body).toBe(200)
    expect(await preise(ref)).toEqual([9_000, 8_000, 8_000])

    // Weniger als gebucht geht nicht, ohne einen Beleg zu aendern.
    const z = await aendern(ref, { totalCent: 5_000 })
    expect(z.statusCode).toBe(422)
    expect(await preise(ref)).toEqual([9_000, 8_000, 8_000])
  })

  it('weist Preis je Nacht und Gesamtpreis zugleich ab', async () => {
    const ref = await reservierung()
    expect((await aendern(ref, { priceCent: 1, totalCent: 3 })).statusCode).toBe(422)
  })

  it('zeigt in der Vorschau den neuen Preis und speichert nichts', async () => {
    const ref = await reservierung()
    const r = await vorschau(ref, { departure: '2026-10-06' })
    expect(r.statusCode, r.body).toBe(200)
    const body = JSON.parse(r.body) as {
      previousTotalCent: number; totalCent: number; nights: Array<{ date: string }> }
    expect(body.previousTotalCent).toBe(27_000)
    expect(body.totalCent).toBe(45_000)
    expect(body.nights.map(n => n.date)).toEqual(
      ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])

    // Nichts davon ist geblieben: Naechte, Abreise, Bestand.
    expect(await preise(ref)).toEqual([9_000, 9_000, 9_000])
    const res = await owner.query<{ departure: string }>(
      `SELECT departure::text FROM reservation WHERE public_ref = $1`, [ref])
    expect(res.rows[0]!.departure).toBe('2026-10-04')
    expect(await sold(dz, '2026-10-04')).toBe(0)
  })

  it('scheitert in der Vorschau, woran auch das Speichern scheitert', async () => {
    const [z1] = await zimmerIdsPreis()
    const ref = await reservierung()
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      resourceId: z1, arrival: '2026-10-04', departure: '2026-10-06', priceCent: 9_000 })
    const r = await vorschau(ref, { resourceId: z1, departure: '2026-10-06' })
    expect(r.statusCode).toBe(409)
  })

  async function zimmerIdsPreis(): Promise<number[]> {
    const r = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id = $1 AND category_id = $2 ORDER BY code`,
      [fx.propertyId, dz])
    return r.rows.map(x => Number(x.id))
  }
})
