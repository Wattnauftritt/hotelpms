import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool,
         makeProperty, makeCategory, makeResources, type Fixture } from '@hotelpms/testing'
import { withTransaction, type Pool } from '@hotelpms/db'

let owner: Pool
let app: Pool
let fx: Fixture
let catId: number

const FROM = '2026-10-01'
const TO   = '2026-10-04'   // drei Naechte

async function materialize(propertyId: number): Promise<void> {
  await owner.query(`SELECT inventory_materialize($1, $2::date, $3::date)`,
    [propertyId, '2026-09-01', '2027-03-01'])
}

async function availability(propertyId: number, categoryId: number, date: string) {
  const r = await owner.query<{ available: number; capacity: number; sold: number }>(
    `SELECT capacity - sold - blocked + overbooking AS available, capacity, sold
       FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
    [propertyId, categoryId, date])
  return r.rows[0]!
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(30)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  catId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, catId, 3)
  await materialize(fx.propertyId)
})

describe('Verfuegbarkeit', () => {
  it('leitet Kapazitaet aus aktiven Zimmern ab', async () => {
    const a = await availability(fx.propertyId, catId, FROM)
    expect(a.capacity).toBe(3)
    expect(a.available).toBe(3)
  })

  it('fuehrt die Haussumme parallel zur Kategorie', async () => {
    const haus = await availability(fx.propertyId, 0, FROM)
    expect(haus.capacity).toBe(3)
  })

  it('senkt die Kapazitaet bei Out of Order', async () => {
    const [resId] = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id=$1 LIMIT 1`, [fx.propertyId]
    ).then(r => r.rows.map(x => x.id))
    await owner.query(
      `INSERT INTO maintenance_block (property_id, resource_id, from_date, to_date, kind, reason)
       VALUES ($1,$2,$3::date,$4::date,'out_of_order','Wasserschaden')`,
      [fx.propertyId, resId, FROM, TO])
    expect((await availability(fx.propertyId, catId, FROM)).capacity).toBe(2)
    // ausserhalb des Zeitraums unveraendert
    expect((await availability(fx.propertyId, catId, '2026-10-05')).capacity).toBe(3)
  })

  it('unterscheidet ausgebucht von nicht materialisiert', async () => {
    const weit = await owner.query<{ inventory_reserve: string | null }>(
      `SELECT inventory_reserve($1,$2,'2030-01-01'::date,'2030-01-02'::date,1)`,
      [fx.propertyId, catId])
    expect(weit.rows[0]!.inventory_reserve).toBe('not_materialized')
  })

  it('belegt und gibt frei', async () => {
    const r = await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
      [fx.propertyId, catId, FROM, TO])
    expect(r.rows[0].e).toBeNull()
    expect((await availability(fx.propertyId, catId, FROM)).sold).toBe(1)
    expect((await availability(fx.propertyId, 0, FROM)).sold).toBe(1)

    await owner.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
      [fx.propertyId, catId, FROM, TO])
    expect((await availability(fx.propertyId, catId, FROM)).sold).toBe(0)
  })

  it('weist Belegung ueber die Kapazitaet hinaus ab', async () => {
    await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,3)`,
      [fx.propertyId, catId, FROM, TO])
    const r = await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
      [fx.propertyId, catId, FROM, TO])
    expect(r.rows[0].e).toBe('sold_out')
    expect((await availability(fx.propertyId, catId, FROM)).sold).toBe(3)
  })

  it('laesst eine Teilueberschneidung nicht halb durchgehen', async () => {
    // Zwei Naechte voll, dritte frei: die ganze Buchung muss scheitern
    await owner.query(`SELECT inventory_reserve($1,$2,'2026-10-01'::date,'2026-10-03'::date,3)`,
      [fx.propertyId, catId])
    const r = await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
      [fx.propertyId, catId, FROM, TO])
    expect(r.rows[0].e).toBe('sold_out')
    // Die freie dritte Nacht darf nicht angefasst worden sein
    expect((await availability(fx.propertyId, catId, '2026-10-03')).sold).toBe(0)
  })

  it('verhindert Hausueberbuchung trotz Kategorien-Overbooking', async () => {
    // Zweite Kategorie mit Overbooking, aber ohne eigene Zimmer
    const cat2 = await makeCategory(owner, fx.propertyId,
      { code: 'EZ', name: 'Einzelzimmer', overbooking: 2 })
    await makeResources(owner, fx.propertyId, cat2, 1, 'E')
    await materialize(fx.propertyId)

    const haus = await availability(fx.propertyId, 0, FROM)
    expect(haus.capacity).toBe(4)           // 3 + 1

    // Kategorie EZ erlaubt 1 + 2 Overbooking = 3. Das Haus erlaubt nur 4.
    await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,3)`,
      [fx.propertyId, catId, FROM, TO])     // 3 von 3 in DZ, Haus bei 3 von 4
    const erste = await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
      [fx.propertyId, cat2, FROM, TO])
    expect(erste.rows[0].e).toBeNull()      // Haus bei 4 von 4

    // EZ haette noch 2 Overbooking frei, das Haus nicht mehr.
    const zweite = await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
      [fx.propertyId, cat2, FROM, TO])
    expect(zweite.rows[0].e).toBe('sold_out')
  })
})

describe('Nebenlaeufigkeit', () => {
  it('verkauft das letzte Zimmer genau einmal bei 50 gleichzeitigen Buchungen', async () => {
    // Zwei der drei Zimmer sind weg, eines bleibt.
    await owner.query(`SELECT inventory_reserve($1,$2,$3::date,$4::date,2)`,
      [fx.propertyId, catId, FROM, TO])

    const versuche = Array.from({ length: 50 }, () =>
      withTransaction(app, { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
        async client => {
          const r = await client.query<{ e: string | null }>(
            `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
            [fx.propertyId, catId, FROM, TO])
          const fehler = r.rows[0]!.e
          if (fehler) throw new Error(fehler)   // Rollback
          return 'gewonnen'
        }).catch((e: Error) => e.message))

    const ergebnisse = await Promise.all(versuche)
    const gewinner = ergebnisse.filter(r => r === 'gewonnen')
    const ausgebucht = ergebnisse.filter(r => r === 'sold_out')

    expect(gewinner).toHaveLength(1)
    expect(ausgebucht).toHaveLength(49)

    // Der Zaehler stimmt: 3 von 3 verkauft, keine Ueberbuchung.
    const a = await availability(fx.propertyId, catId, FROM)
    expect(a.sold).toBe(3)
    expect(a.available).toBe(0)
    expect((await availability(fx.propertyId, 0, FROM)).sold).toBe(3)
  })
})

describe('Abfragezaehler', () => {
  it('liefert die Jahresverfuegbarkeit in einer Abfrage', async () => {
    const { countQueries } = await import('@hotelpms/testing')
    const { report } = await countQueries(app, async () => {
      await withTransaction(app,
        { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
        client => client.query(
          `SELECT category_id, date, capacity - sold - blocked + overbooking AS available
             FROM inventory_day
            WHERE property_id = $1 AND date >= $2::date AND date < $3::date`,
          [fx.propertyId, '2026-10-01', '2027-10-01']))
    })
    expect(report.count).toBe(1)
  })
})
