import type { Pool } from '@hotelpms/db'

export interface Fixture {
  accountId: number
  propertyId: number
}

/**
 * Legt Account und Property an. Laeuft unter der Eigentuemerrolle, ohne RLS.
 *
 * Anschrift und Steuernummer gehoeren zur Grundausstattung, nicht zur Kuer:
 * ohne sie darf nach § 14 UStG keine Rechnung ausgestellt werden, und ein
 * Testhaus ohne sie wuerde eine Luecke verdecken, die jedes echte Haus hat.
 */
export async function makeProperty(
  owner: Pool,
  opts: { name?: string; code?: string; taxNumber?: string | null } = {}
): Promise<Fixture> {
  const a = await owner.query<{ id: number }>(
    `INSERT INTO account (name) VALUES ($1) RETURNING id`,
    [opts.name ?? 'Testaccount']
  )
  const accountId = a.rows[0]!.id
  const p = await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code,
                           city, country, tax_number)
     VALUES ($1,$2,$3,'Hafenstr. 1','25813','Husum','DE',$4) RETURNING id`,
    [accountId, opts.code ?? 'TEST', opts.name ?? 'Testhotel',
     opts.taxNumber === undefined ? '21/815/00123' : opts.taxNumber]
  )
  return { accountId, propertyId: p.rows[0]!.id }
}

/** Ein Gast mit vollstaendiger Anschrift, wie ihn eine Rechnung braucht. */
export async function makeGuest(
  owner: Pool, accountId: number,
  opts: { lastName?: string; firstName?: string; country?: string } = {}
): Promise<{ id: number; publicRef: string }> {
  const r = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO guest (account_id, last_name, first_name, address_line1,
                        postal_code, city, country)
     VALUES ($1,$2,$3,'Deichweg 4','24937','Flensburg',$4)
     RETURNING id, public_ref`,
    [accountId, opts.lastName ?? 'Petersen', opts.firstName ?? 'Jan',
     opts.country ?? 'DE'])
  return { id: r.rows[0]!.id, publicRef: r.rows[0]!.public_ref }
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

/** Legt einen Nutzer mit einer Systemrolle auf einer Property an. */
export async function makeUser(
  owner: Pool,
  opts: {
    email: string
    propertyId?: number
    accountId?: number
    roleKey?: string
    platformRoleKey?: string
    isPlatformStaff?: boolean
  }
): Promise<{ userId: number; sessionId: string }> {
  const u = await owner.query<{ id: number }>(
    `INSERT INTO app_user (email, display_name, status, is_platform_staff)
     VALUES ($1, $2, 'active', $3) RETURNING id`,
    [opts.email, opts.email, opts.isPlatformStaff ?? false])
  const userId = u.rows[0]!.id

  if (opts.roleKey && opts.propertyId !== undefined) {
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = $3 AND account_id IS NULL`,
      [userId, opts.propertyId, opts.roleKey])
  }
  if (opts.roleKey && opts.accountId !== undefined && opts.propertyId === undefined) {
    await owner.query(
      `INSERT INTO user_account_role (user_id, account_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = $3 AND account_id IS NULL`,
      [userId, opts.accountId, opts.roleKey])
  }
  if (opts.platformRoleKey) {
    await owner.query(
      `INSERT INTO user_platform_role (user_id, role_id)
       SELECT $1, id FROM role WHERE key = $2 AND account_id IS NULL`,
      [userId, opts.platformRoleKey])
  }

  const sessionId = `sess_${Math.random().toString(36).slice(2)}${Date.now()}`
  await owner.query(
    `INSERT INTO user_session (id, user_id, expires_at, absolute_expires_at)
     VALUES ($1, $2, now() + interval '1 hour', now() + interval '8 hours')`,
    [sessionId, userId])
  return { userId, sessionId }
}

export async function makePaymentMethod(
  owner: Pool, propertyId: number, code = 'TRANSFER'
): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO payment_method (property_id, code, name) VALUES ($1,$2,$3) RETURNING id`,
    [propertyId, code, 'Ueberweisung'])
  return r.rows[0]!.id
}

export async function openBusinessDay(
  owner: Pool, propertyId: number, date = '2026-10-01'
): Promise<void> {
  await owner.query(
    `INSERT INTO business_day (property_id, date) VALUES ($1, $2::date)
     ON CONFLICT DO NOTHING`, [propertyId, date])
}

export interface ReservationFixture {
  bookingId: number
  reservationId: number
  folioId: number
}

/**
 * Legt Buchung, Reservierung, Naechte und Folio in einem Zug an und belegt
 * das Kontingent. Umgeht die Fachlogik der API bewusst: hier wird der
 * Nachtlauf getestet, nicht der Buchungsweg.
 */
export async function makeReservation(
  owner: Pool,
  opts: {
    propertyId: number
    categoryId: number
    arrival: string
    departure: string
    status?: 'Optional' | 'Confirmed' | 'InHouse'
    resourceId?: number
    priceCent?: number
    optionExpiresAt?: string | null
    reserveInventory?: boolean
    withFolio?: boolean
  }
): Promise<ReservationFixture> {
  const status = opts.status ?? 'Confirmed'
  const price = opts.priceCent ?? 11_000

  const b = await owner.query<{ id: number }>(
    `INSERT INTO booking (property_id, source) VALUES ($1, 'direct') RETURNING id`,
    [opts.propertyId])
  const bookingId = b.rows[0]!.id

  const r = await owner.query<{ id: number }>(
    `INSERT INTO reservation (property_id, booking_id, category_id, resource_id,
                              arrival, departure, status, option_expires_at, checked_in_at)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,$7::reservation_status,$8::timestamptz,
             CASE WHEN $7::text = 'InHouse' THEN now() END)
     RETURNING id`,
    [opts.propertyId, bookingId, opts.categoryId, opts.resourceId ?? null,
     opts.arrival, opts.departure, status, opts.optionExpiresAt ?? null])
  const reservationId = r.rows[0]!.id

  await owner.query(
    `INSERT INTO reservation_night (reservation_id, property_id, date, price_cent)
     SELECT $1, $2, d::date, $5
       FROM generate_series($3::date, $4::date - 1, interval '1 day') d`,
    [reservationId, opts.propertyId, opts.arrival, opts.departure, price])

  let folioId = 0
  if (opts.withFolio !== false) {
    const f = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, reservation_id) VALUES ($1,$2) RETURNING id`,
      [opts.propertyId, reservationId])
    folioId = f.rows[0]!.id
  }

  if (opts.reserveInventory !== false) {
    const res = await owner.query<{ inventory_reserve: string | null }>(
      `SELECT inventory_reserve($1,$2,$3::date,$4::date,1)`,
      [opts.propertyId, opts.categoryId, opts.arrival, opts.departure])
    const fehler = res.rows[0]!.inventory_reserve
    if (fehler !== null) throw new Error(`inventory_reserve: ${fehler}`)
  }

  return { bookingId, reservationId, folioId }
}
