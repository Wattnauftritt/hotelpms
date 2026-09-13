import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, openBusinessDay, type Fixture }
  from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { runNightAudit } from '../jobs/nightAudit.js'

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let catId: number
let rooms: number[]

const TAG = '2026-10-01'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(10)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  rooms = await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, TAG)
})

/** Kurtaxe: 2,50 Euro je Person und Nacht, Kinder unter 16 frei. */
async function kurtaxe(extra: Record<string, unknown> = {}): Promise<number> {
  const spalten = Object.keys(extra)
  const r = await owner.query<{ id: number }>(
    `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent,
                           exempt_below_age${spalten.map(c => `, ${c}`).join('')})
     VALUES ($1,'KURTAXE','Kurtaxe','city_tax','per_person_night',250,16
             ${spalten.map((_, i) => `, $${i + 2}`).join('')})
     RETURNING id`,
    [fx.propertyId, ...Object.values(extra)])
  return r.rows[0]!.id
}

async function gaeste(reservationId: number, alter: Array<number | null>): Promise<void> {
  for (const a of alter) {
    await owner.query(
      `INSERT INTO reservation_occupant (property_id, reservation_id, age_at_arrival)
       VALUES ($1,$2,$3)`, [fx.propertyId, reservationId, a])
  }
}

async function aufenthalt(
  opts: { alter: Array<number | null>; arrival?: string; departure?: string
          business?: boolean } = { alter: [40] }
): Promise<number> {
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId,
    arrival: opts.arrival ?? TAG, departure: opts.departure ?? '2026-10-04',
    status: 'InHouse', resourceId: rooms[0]!, priceCent: 11_000 })
  await gaeste(r.reservationId, opts.alter)
  if (opts.business === true) {
    await owner.query(`UPDATE reservation SET business_trip = true WHERE id = $1`,
      [r.reservationId])
  }
  return r.reservationId
}

const lauf = () => withTransaction(app, ctx, async () => undefined)
  .then(() => runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG }))

async function abgaben(): Promise<Array<{ description: string; gross_cent: number
                                          quantity: number }>> {
  const r = await owner.query<{ description: string; gross_cent: number
                                quantity: number }>(
    `SELECT description, gross_cent, quantity FROM charge
      WHERE property_id = $1 AND tax_rule_id IS NOT NULL ORDER BY id`, [fx.propertyId])
  return r.rows
}

describe('Kurtaxe', () => {
  it('bucht je zahlender Person und Nacht', async () => {
    await kurtaxe()
    await aufenthalt({ alter: [42, 39] })
    await lauf()

    const a = await abgaben()
    expect(a).toHaveLength(1)
    expect(a[0]!.quantity).toBe(2)
    expect(a[0]!.gross_cent).toBe(500)
    expect(a[0]!.description).toContain('01.10.2026')
  })

  /**
   * Der Grund, warum `reservation_occupant` das Alter führt und nicht nur
   * eine Anzahl Kinder: aus einer Anzahl lässt sich keine Altersgrenze
   * rechnen (B7, Dokument 13).
   */
  it('nimmt Kinder unter der Altersgrenze aus', async () => {
    await kurtaxe()
    await aufenthalt({ alter: [42, 39, 8, 15, 16] })
    await lauf()

    const a = await abgaben()
    // Zahlend: 42, 39 und der Sechzehnjaehrige. Frei: 8 und 15.
    expect(a[0]!.quantity).toBe(3)
    expect(a[0]!.gross_cent).toBe(750)
  })

  it('behandelt einen Gast ohne Altersangabe als erwachsen', async () => {
    await kurtaxe()
    await aufenthalt({ alter: [null, null] })
    await lauf()
    expect((await abgaben())[0]!.gross_cent).toBe(500)
  })

  it('erlaesst die Abgabe bei erklaerter Geschaeftsreise', async () => {
    await kurtaxe({ exempt_business: true })
    await aufenthalt({ alter: [42], business: true })
    await lauf()
    expect(await abgaben()).toHaveLength(0)
  })

  it('erhebt trotz Geschaeftsreise, wenn die Satzung sie nicht ausnimmt', async () => {
    await kurtaxe({ exempt_business: false })
    await aufenthalt({ alter: [42], business: true })
    await lauf()
    expect((await abgaben())[0]!.gross_cent).toBe(250)
  })

  it('endet nach der Hoechstzahl an Naechten', async () => {
    await kurtaxe({ max_nights: 3 })
    // Anreise am 28.9., der 1.10. ist damit die vierte Nacht.
    await aufenthalt({ alter: [42], arrival: '2026-09-28', departure: '2026-10-10' })
    await lauf()
    expect(await abgaben()).toHaveLength(0)
  })

  it('erhebt an der letzten erlaubten Nacht noch', async () => {
    await kurtaxe({ max_nights: 4 })
    await aufenthalt({ alter: [42], arrival: '2026-09-28', departure: '2026-10-10' })
    await lauf()
    expect((await abgaben())[0]!.gross_cent).toBe(250)
  })

  /**
   * Sätze ändern sich zum Jahreswechsel. Eine Nacht muss den Satz behalten,
   * der an ihr galt, auch wenn sie später nachgebucht wird.
   */
  it('nimmt den Satz, der an dieser Nacht galt', async () => {
    await owner.query(
      `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent,
                             valid_from, valid_to)
       VALUES ($1,'KURTAXE','Kurtaxe alt','city_tax','per_person_night',200,
               '2026-01-01','2026-10-01'),
              ($1,'KURTAXE','Kurtaxe neu','city_tax','per_person_night',300,
               '2026-10-01',NULL)`, [fx.propertyId])
    await aufenthalt({ alter: [42] })
    await lauf()

    const a = await abgaben()
    expect(a).toHaveLength(1)
    expect(a[0]!.gross_cent).toBe(300)
    expect(a[0]!.description).toContain('Kurtaxe neu')
  })

  it('bucht auch bei einem zweiten Lauf nicht doppelt', async () => {
    await kurtaxe()
    await aufenthalt({ alter: [42, 39] })
    await lauf()
    // Schrittmarke entfernen: der Nachtlauf wuerde den Schritt wiederholen.
    await owner.query(
      `DELETE FROM night_audit_step WHERE property_id = $1 AND step = 'post_city_tax'`,
      [fx.propertyId])
    await lauf()

    const a = await abgaben()
    expect(a).toHaveLength(1)
  })

  it('rechnet eine prozentuale Bettensteuer auf den Logiserloes', async () => {
    await owner.query(
      `INSERT INTO tax_rule (property_id, code, name, kind, basis, rate_bp)
       VALUES ($1,'BETT','Bettensteuer','bed_tax','percent',500)`, [fx.propertyId])
    await aufenthalt({ alter: [42] })
    await lauf()
    // 5 Prozent auf 110,00 Euro Logis.
    expect((await abgaben())[0]!.gross_cent).toBe(550)
  })

  it('bucht ohne hinterlegte Regel nichts', async () => {
    await aufenthalt({ alter: [42, 39] })
    const r = await lauf()
    expect(r!.steps.post_city_tax).toBe(0)
    expect(await abgaben()).toHaveLength(0)
  })
})
