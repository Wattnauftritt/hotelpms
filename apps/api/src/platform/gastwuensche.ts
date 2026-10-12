import type { PoolClient } from '@hotelpms/db'
import { LOCALES, GUEST_REQUEST_DECLINE_REASONS, type FolderRequests,
         type GuestRequestCatalog, type GuestRequestDeclineReason, type GuestRequestItemAdmin,
         type GuestRequestRow } from '@hotelpms/contracts'
import { isIsoDate, taxFromGross } from '@hotelpms/domain'
import { Errors } from './errors.js'
import { meldePush } from './push.js'
import { can, type Principal } from './context.js'
import type { Permission } from './permissions.js'

/**
 * Wuensche und Extras aus der Gaestemappe (Migration 0149).
 *
 * An einer Stelle fuer alle Tueren: die Mappe im Zimmer heute, der Link
 * aus der Mail und das Terminal spaeter (Plan gaestemappe/plan.md,
 * Abschnitt 10). Welche Tuer, sagt `source`; was ein Wunsch darf, sagt
 * diese Datei. Zwei Fassungen der Regel "welcher Tag geht" liefen
 * auseinander wie einst beim Reinigungsverzicht.
 */

/**
 * Hoechstens so viele offene Wuensche je Aufenthalt. Kein Gast braucht
 * mehr, bevor die Rezeption nachkommt; ohne Grenze fuellt ein Telefon in
 * einer Schleife den Eingang, und der echte Wunsch geht darin unter.
 */
export const OFFENE_WUENSCHE_MAX = 10

/** Ein Eintrag gilt als kostenlos, wenn sein Artikel fehlt oder abgeschaltet ist. */
const PREIS = `CASE WHEN p.active THEN p.price_cent::int END`

/**
 * Was das Gaesteterminal anbietet: freigegeben und kostenlos. Extras mit
 * Preis bleiben der Mappe (Sven, 12.10.2026): am Terminal steht der Gast
 * vor der Rezeption und kann dort fragen. `p` ist der Artikel des Eintrags.
 */
export const AM_TERMINAL = `i.on_terminal AND ${PREIS} IS NULL`

// ---------------------------------------------------------------- Gast

/**
 * Was die Mappe ueber Wuensche zeigt: der Katalog und die eigenen.
 * `null`, wenn es weder das eine noch das andere gibt -- dann zeigt die
 * Mappe keinen Abschnitt, statt eines leeren.
 */
export async function mappeWuensche(
  client: PoolClient, propertyId: number, reservationId: number, businessDate: string,
  tuer: 'folder' | 'terminal' = 'folder'
): Promise<FolderRequests | null> {
  const items = await client.query<FolderRequests['items'][number]>(
    `SELECT i.public_ref AS "itemRef", i.name, i.max_qty AS "maxQty",
            ${PREIS} AS "unitPriceCent"
       FROM guest_request_item i
       LEFT JOIN product p ON p.id = i.product_id
      WHERE i.property_id = $1 AND i.active
        AND ${tuer === 'terminal' ? AM_TERMINAL : 'i.on_folder'}
      ORDER BY i.position, i.id`, [propertyId])
  const mine = await client.query<FolderRequests['mine'][number]>(
    `SELECT q.public_ref AS "requestRef", i.name, q.qty,
            q.unit_price_cent::int AS "unitPriceCent", q.wanted_for::text AS "wantedFor",
            q.status, q.decline_reason AS "declineReason", q.created_at AS "createdAt"
       FROM guest_request q
       JOIN guest_request_item i ON i.id = q.item_id
      WHERE q.reservation_id = $1
      ORDER BY q.created_at DESC, q.id DESC`, [reservationId])
  if (items.rowCount === 0 && mine.rowCount === 0) return null
  const days = await client.query<{ d: string }>(
    `SELECT d::date::text AS d
       FROM reservation r,
            generate_series(greatest(r.arrival, $2::date), r.departure, interval '1 day') d
      WHERE r.id = $1
      ORDER BY d`, [reservationId, businessDate])
  return { items: items.rows, mine: mine.rows, days: days.rows.map(r => r.d) }
}

/** Was ein Rumpf fuer einen neuen Wunsch sein darf. */
export function wunschAusRumpf(body: unknown): {
  itemRef: string; qty: number; wantedFor: string | null
} {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof b.itemRef !== 'string' || !/^[0-9A-Z]{12}$/.test(b.itemRef)) {
    throw Errors.validation({ itemRef: ['field.invalid'] })
  }
  if (typeof b.qty !== 'number' || !Number.isInteger(b.qty)) {
    throw Errors.validation({ qty: ['field.invalid'] })
  }
  const w = b.wantedFor
  if (w !== undefined && w !== null && (typeof w !== 'string' || !isIsoDate(w))) {
    throw Errors.validation({ wantedFor: ['field.isoDate'] })
  }
  return { itemRef: b.itemRef, qty: b.qty, wantedFor: typeof w === 'string' ? w : null }
}

/**
 * Einen Wunsch anlegen. Der Aufrufer hat schon festgestellt, zu welchem
 * Aufenthalt die Anfrage gehoert -- ueber die Freischaltung der Mappe oder
 * den Link zum Online-Check-in; hier zaehlt nur noch, was gewuenscht wird.
 *
 * Der Wunschtag liegt im Aufenthalt und nicht vor dem Geschaeftstag; der
 * Abreisetag gehoert dazu, ein Lunchpaket fuer die Heimfahrt ist genau
 * dort gewuenscht.
 */
export async function wunschAnlegen(
  client: PoolClient,
  a: { propertyId: number; reservationId: number; businessDate: string
       source: 'folder' | 'mail' | 'terminal'
       itemRef: string; qty: number; wantedFor: string | null }
): Promise<void> {
  const tuer = a.source === 'terminal' ? AM_TERMINAL : 'i.on_folder'
  const e = await client.query<{ id: number; max_qty: number; preis: number | null
                                 handler: 'reception' | 'housekeeping' }>(
    `SELECT i.id::int, i.max_qty, ${PREIS} AS preis, i.handler
       FROM guest_request_item i
       LEFT JOIN product p ON p.id = i.product_id
      WHERE i.public_ref = $1 AND i.property_id = $2 AND i.active AND ${tuer}`,
    [a.itemRef, a.propertyId])
  const item = e.rows[0]
  if (item === undefined) throw Errors.unprocessable('guestRequest.itemUnavailable')
  if (a.qty < 1 || a.qty > item.max_qty) {
    throw Errors.validation({ qty: ['guestRequest.qty'] }, { max: item.max_qty })
  }

  // Die Reservierung sperren: zwei schnelle Klicks sollen die Grenze der
  // offenen Wuensche nicht gemeinsam ueberspringen.
  const r = await client.query<{ arrival: string; departure: string; resource_id: number | null }>(
    `SELECT arrival::text, departure::text, resource_id::int
       FROM reservation WHERE id = $1 AND property_id = $2 FOR UPDATE`,
    [a.reservationId, a.propertyId])
  const res = r.rows[0]
  if (res === undefined) throw Errors.notFound('res.reservation')
  if (a.wantedFor !== null
      && (a.wantedFor < a.businessDate || a.wantedFor < res.arrival
          || a.wantedFor > res.departure)) {
    throw Errors.validation({ wantedFor: ['guestRequest.wantedFor'] })
  }
  const offen = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM guest_request
      WHERE reservation_id = $1 AND status = 'open'`, [a.reservationId])
  if (offen.rows[0]!.n >= OFFENE_WUENSCHE_MAX) {
    throw Errors.conflict('guestRequest.tooManyOpen', { max: OFFENE_WUENSCHE_MAX })
  }
  const neu = await client.query<{ id: number }>(
    `INSERT INTO guest_request (property_id, reservation_id, resource_id, item_id, qty,
                                unit_price_cent, wanted_for, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8) RETURNING id::int`,
    [a.propertyId, a.reservationId, res.resource_id, item.id, a.qty, item.preis,
     a.wantedFor, a.source])

  // Kostenlos und Sache des Housekeepings: die Kraft, der das Zimmer heute
  // zugeteilt ist, bekommt eine Meldung (0152) und sieht den Wunsch an der
  // Kachel. Ein Extra mit Preis bleibt bei der Rezeption -- annehmen heisst
  // dort buchen, und das darf die Kraft nicht. Ein Wunsch fuer einen
  // spaeteren Tag meldet sich nicht jetzt; er steht an dem Tag in der App.
  if (item.handler === 'housekeeping' && item.preis === null && res.resource_id !== null
      && (a.wantedFor === null || a.wantedFor <= a.businessDate)) {
    const k = await client.query<{ user_id: number; code: string }>(
      `SELECT t.assigned_to::int AS user_id, r.code
         FROM housekeeping_task t JOIN resource r ON r.id = t.resource_id
        WHERE t.resource_id = $1 AND t.business_date = $2::date
          AND t.kind IN ('departure','stayover') AND t.assigned_to IS NOT NULL`,
      [res.resource_id, a.businessDate])
    for (const z of k.rows) {
      await meldePush(client, a.propertyId, [z.user_id], 'request', { room: z.code },
        String(neu.rows[0]!.id))
    }
  }
}

// ------------------------------------------------------------ Rezeption

/** Wie `rechtImHaus` in den Routen; hier, weil die Plattform keine Route laedt. */
function recht(principal: Principal, permission: Permission, propertyId: number): void {
  if (!can(principal, permission, propertyId)) {
    throw Errors.forbidden('access.missingPermission', { permission })
  }
}

const ZEILE = `
  SELECT q.public_ref AS "requestRef", r.public_ref AS "reservationRef",
         res.code AS "roomCode", g.last_name AS "lastName", g.first_name AS "firstName",
         i.name AS "itemName", q.qty, q.unit_price_cent::int AS "unitPriceCent",
         q.wanted_for::text AS "wantedFor", i.handler, q.source, q.status,
         q.decline_reason AS "declineReason", q.created_at AS "createdAt"
    FROM guest_request q
    JOIN reservation r ON r.id = q.reservation_id
    JOIN guest_request_item i ON i.id = q.item_id
    LEFT JOIN resource res ON res.id = q.resource_id
    LEFT JOIN guest g ON g.id = r.primary_guest_id`

/**
 * Die offenen Wuensche eines Hauses fuer "Heute", aelteste zuerst: wer am
 * laengsten wartet, steht oben.
 */
export async function offeneWuensche(
  client: PoolClient, propertyId: number
): Promise<GuestRequestRow[]> {
  const r = await client.query<GuestRequestRow>(
    `${ZEILE} WHERE q.property_id = $1 AND q.status = 'open'
      ORDER BY q.wanted_for NULLS FIRST, q.created_at, q.id`, [propertyId])
  return r.rows
}

/** Die Wuensche eines Aufenthalts fuer das Seitenfenster, neueste zuerst. */
export async function wuenscheDerReservierung(
  client: PoolClient, reservationId: number
): Promise<GuestRequestRow[]> {
  const r = await client.query<GuestRequestRow>(
    `${ZEILE} WHERE q.reservation_id = $1 ORDER BY q.created_at DESC, q.id DESC`,
    [reservationId])
  return r.rows
}

interface Gesperrt {
  id: number; property_id: number; reservation_id: number; status: string
  qty: number; unit_price_cent: number | null; name_de: string
  product_id: number | null; rate_bp: number | null; revenue_account: string | null
}

async function sperren(
  client: PoolClient, principal: Principal, requestRef: string
): Promise<Gesperrt> {
  const r = await client.query<Gesperrt>(
    `SELECT q.id::int, q.property_id::int, q.reservation_id::int, q.status, q.qty,
            q.unit_price_cent::int, i.name ->> 'de' AS name_de, i.product_id::int,
            tr.rate_bp, p.revenue_account
       FROM guest_request q
       JOIN guest_request_item i ON i.id = q.item_id
       LEFT JOIN product p ON p.id = i.product_id
       LEFT JOIN tax_rule tr ON tr.id = p.tax_rule_id
      WHERE q.public_ref = $1
        FOR UPDATE OF q`, [requestRef])
  const q = r.rows[0]
  if (q === undefined) throw Errors.notFound('res.guestRequest')
  recht(principal, 'reservation:checkin', q.property_id)
  if (q.status !== 'open') throw Errors.conflict('guestRequest.notOpen')
  return q
}

/**
 * Erledigt, oder bei einem Extra mit Preis: angenommen und gebucht. Die
 * Buchung geht auf das offene Gastfolio des Aufenthalts, zum Preis, den
 * der Gast gesehen hat, mit Steuer und Erloeskonto des Artikels. Wer
 * buchen darf, entscheidet `folio:post` -- dieselbe Regel wie am Tresen.
 */
export async function wunschErledigen(
  client: PoolClient, principal: Principal, requestRef: string
): Promise<string> {
  const q = await sperren(client, principal, requestRef)
  let chargeId: number | null = null
  if (q.unit_price_cent !== null) {
    recht(principal, 'folio:post', q.property_id)
    const f = await client.query<{ id: number }>(
      `SELECT id::int FROM folio
        WHERE reservation_id = $1 AND kind = 'guest' AND status = 'open'
        ORDER BY id LIMIT 1`, [q.reservation_id])
    const folio = f.rows[0]
    if (folio === undefined) throw Errors.conflict('guestRequest.noOpenFolio')
    const bd = await client.query<{ date: string }>(
      `SELECT date::text FROM business_day
        WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
      [q.property_id])
    const businessDate = bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10)
    // Steuer aus dem Brutto, wie an der Kasse: der Gast hat einen
    // Bruttopreis gesehen, und der soll auf der Rechnung stehen.
    const rate = q.rate_bp ?? 0
    const brutto = q.unit_price_cent * q.qty
    const steuer = taxFromGross(brutto, rate)
    const c = await client.query<{ id: number }>(
      `INSERT INTO charge (property_id, folio_id, reservation_id, business_date, description,
                           quantity, net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, product_id, created_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id::int`,
      [q.property_id, folio.id, q.reservation_id, businessDate, q.name_de, q.qty,
       brutto - steuer, steuer, brutto, rate, q.revenue_account ?? '8400',
       q.product_id, principal.userId])
    chargeId = c.rows[0]!.id
  }
  await client.query(
    `UPDATE guest_request SET status = 'done', charge_id = $2, handled_by = $3,
            handled_at = now()
      WHERE id = $1`, [q.id, chargeId, principal.userId])
  return requestRef
}

export function ablehnGrund(body: unknown): GuestRequestDeclineReason {
  const g = (typeof body === 'object' && body !== null
    ? (body as { reason?: unknown }).reason : undefined)
  if (typeof g !== 'string'
      || !(GUEST_REQUEST_DECLINE_REASONS as readonly string[]).includes(g)) {
    throw Errors.validation({ reason: ['field.invalid'] })
  }
  return g as GuestRequestDeclineReason
}

export async function wunschAblehnen(
  client: PoolClient, principal: Principal, requestRef: string,
  grund: GuestRequestDeclineReason
): Promise<void> {
  const q = await sperren(client, principal, requestRef)
  await client.query(
    `UPDATE guest_request SET status = 'declined', decline_reason = $2, handled_by = $3,
            handled_at = now()
      WHERE id = $1`, [q.id, grund, principal.userId])
}

/** Eine Zeile fuer die Antwort nach dem Bearbeiten. */
export async function wunschZeile(
  client: PoolClient, requestRef: string
): Promise<GuestRequestRow> {
  const r = await client.query<GuestRequestRow>(`${ZEILE} WHERE q.public_ref = $1`,
    [requestRef])
  return r.rows[0]!
}

// -------------------------------------------------------------- Katalog

export async function katalogAnsicht(
  client: PoolClient, propertyId: number
): Promise<GuestRequestCatalog> {
  const items = await client.query<GuestRequestItemAdmin>(
    `SELECT i.public_ref AS "itemRef", i.name, i.handler, i.max_qty AS "maxQty",
            CASE WHEN p.active THEN json_build_object(
              'grossCent', p.price_cent::int, 'taxRuleId', p.tax_rule_id::int,
              'revenueAccount', p.revenue_account) END AS price,
            i.on_folder AS "onFolder", i.on_terminal AS "onTerminal", i.active, i.position
       FROM guest_request_item i
       LEFT JOIN product p ON p.id = i.product_id
      WHERE i.property_id = $1
      ORDER BY i.position, i.id`, [propertyId])
  const steuer = await umsatzsteuer(client, propertyId)
  return { items: items.rows, taxRules: steuer }
}

async function umsatzsteuer(
  client: PoolClient, propertyId: number
): Promise<GuestRequestCatalog['taxRules']> {
  const r = await client.query<GuestRequestCatalog['taxRules'][number]>(
    `SELECT id::int, name, rate_bp AS "rateBp" FROM tax_rule
      WHERE property_id = $1 AND kind = 'vat' AND basis = 'percent' AND active
        AND rate_bp IS NOT NULL
      ORDER BY rate_bp, id`, [propertyId])
  return r.rows
}

interface Eintrag {
  name: Record<string, string>
  handler: 'reception' | 'housekeeping'
  maxQty: number
  price: { grossCent: number; taxRuleId: number; revenueAccount: string } | null
  onFolder: boolean; onTerminal: boolean; active: boolean; position: number
}

function ganz(v: unknown, min: number, max: number, feld: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw Errors.validation({ [feld]: ['field.invalid'] })
  }
  return v
}

function wahr(v: unknown, feld: string): boolean {
  if (typeof v !== 'boolean') throw Errors.validation({ [feld]: ['field.invalid'] })
  return v
}

/**
 * Ein Eintrag aus dem Rumpf. Namen in Sprachen, die das System nicht
 * kennt, fallen weg; ein leerer Name ebenso -- dann zeigt die Mappe in
 * dieser Sprache den deutschen.
 */
export function eintragAusRumpf(body: unknown): Eintrag {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const roh = b.name
  if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) {
    throw Errors.validation({ 'name.de': ['field.required'] })
  }
  const name: Record<string, string> = {}
  for (const l of LOCALES) {
    const v = (roh as Record<string, unknown>)[l]
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (t === '') continue
    if (t.length > 80) throw Errors.validation({ [`name.${l}`]: ['field.maxLength'] }, { max: 80 })
    name[l] = t
  }
  if (name.de === undefined) throw Errors.validation({ 'name.de': ['field.required'] })
  if (b.handler !== 'reception' && b.handler !== 'housekeeping') {
    throw Errors.validation({ handler: ['field.invalid'] })
  }
  let price: Eintrag['price'] = null
  if (b.price !== null) {
    const p = (typeof b.price === 'object' && b.price !== null ? b.price : {}) as
      Record<string, unknown>
    const konto = p.revenueAccount
    if (typeof konto !== 'string' || !/^[0-9]{4,8}$/.test(konto)) {
      throw Errors.validation({ 'price.revenueAccount': ['field.invalid'] })
    }
    price = {
      grossCent: ganz(p.grossCent, 1, 1_000_000, 'price.grossCent'),
      taxRuleId: ganz(p.taxRuleId, 1, Number.MAX_SAFE_INTEGER, 'price.taxRuleId'),
      revenueAccount: konto
    }
  }
  return {
    name, handler: b.handler, maxQty: ganz(b.maxQty, 1, 20, 'maxQty'), price,
    onFolder: wahr(b.onFolder, 'onFolder'), onTerminal: wahr(b.onTerminal, 'onTerminal'),
    active: wahr(b.active, 'active'), position: ganz(b.position, 0, 1000, 'position')
  }
}

/**
 * Einen Eintrag anlegen (`itemRef` leer) oder aendern. Mit Preis legt das
 * den Artikel dahinter an oder aendert ihn; ohne Preis wird er
 * abgeschaltet, nicht geloescht -- frueher angenommene Extras verweisen
 * mit ihrer Buchung darauf, und kommt der Preis zurueck, ist es derselbe
 * Artikel.
 */
export async function eintragSpeichern(
  client: PoolClient, propertyId: number, itemRef: string | null, e: Eintrag,
  userId: number | null
): Promise<void> {
  if (e.price !== null
      && !(await umsatzsteuer(client, propertyId)).some(t => t.id === e.price!.taxRuleId)) {
    throw Errors.validation({ 'price.taxRuleId': ['guestRequest.taxRule'] })
  }
  const werte = [propertyId, JSON.stringify(e.name), e.handler, e.maxQty, e.onFolder,
                 e.onTerminal, e.active, e.position, userId]
  const r = itemRef === null
    ? await client.query<{ id: number; product_id: number | null }>(
        `INSERT INTO guest_request_item (property_id, name, handler, max_qty, on_folder,
                                         on_terminal, active, position, updated_by)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id::int, product_id::int`, werte)
    : await client.query<{ id: number; product_id: number | null }>(
        `UPDATE guest_request_item SET name = $2::jsonb, handler = $3, max_qty = $4,
                on_folder = $5, on_terminal = $6, active = $7, position = $8,
                updated_by = $9, updated_at = now()
          WHERE property_id = $1 AND public_ref = $10
         RETURNING id::int, product_id::int`, [...werte, itemRef])
  const item = r.rows[0]
  if (item === undefined) throw Errors.notFound('res.guestRequestItem')

  if (e.price === null) {
    if (item.product_id !== null) {
      await client.query(`UPDATE product SET active = false WHERE id = $1`, [item.product_id])
    }
    return
  }
  if (item.product_id === null) {
    const p = await client.query<{ id: number }>(
      `INSERT INTO product (property_id, code, name, price_cent, tax_rule_id, charge_mode,
                            revenue_account, active)
       VALUES ($1, 'MAPPE-' || $2::text, $3, $4, $5, 'once', $6, true)
       RETURNING id::int`,
      [propertyId, item.id, e.name.de, e.price.grossCent, e.price.taxRuleId,
       e.price.revenueAccount])
    await client.query(`UPDATE guest_request_item SET product_id = $2 WHERE id = $1`,
      [item.id, p.rows[0]!.id])
  } else {
    await client.query(
      `UPDATE product SET name = $2, price_cent = $3, tax_rule_id = $4, revenue_account = $5,
              active = true
        WHERE id = $1`,
      [item.product_id, e.name.de, e.price.grossCent, e.price.taxRuleId,
       e.price.revenueAccount])
  }
}
