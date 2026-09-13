import type { Pool } from '@hotelpms/db'

export interface Fixture {
  accountId: number
  propertyId: number
}

/** Legt Account und Property an. Laeuft unter der Eigentuemerrolle, ohne RLS. */
export async function makeProperty(
  owner: Pool,
  opts: { name?: string; code?: string } = {}
): Promise<Fixture> {
  const a = await owner.query<{ id: number }>(
    `INSERT INTO account (name) VALUES ($1) RETURNING id`,
    [opts.name ?? 'Testaccount']
  )
  const accountId = a.rows[0]!.id
  const p = await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [accountId, opts.code ?? 'TEST', opts.name ?? 'Testhotel']
  )
  return { accountId, propertyId: p.rows[0]!.id }
}

export async function makeCategory(
  owner: Pool,
  propertyId: number,
  opts: { code?: string; name?: string; overbooking?: number } = {}
): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO resource_category (property_id, code, name, overbooking_limit)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [propertyId, opts.code ?? 'DZ', opts.name ?? 'Doppelzimmer', opts.overbooking ?? 0]
  )
  return r.rows[0]!.id
}

export async function makeResources(
  owner: Pool,
  propertyId: number,
  categoryId: number,
  count: number,
  prefix = ''
): Promise<number[]> {
  const ids: number[] = []
  for (let i = 1; i <= count; i++) {
    const r = await owner.query<{ id: number }>(
      `INSERT INTO resource (property_id, category_id, code) VALUES ($1, $2, $3) RETURNING id`,
      [propertyId, categoryId, `${prefix}${100 + i}`]
    )
    ids.push(r.rows[0]!.id)
  }
  return ids
}
