import { createHash } from 'node:crypto'
import type { FastifyReply } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { Errors } from './errors.js'

/**
 * Was die Routen des Kassenbuchs teilen (Migration 0095): Einstellung,
 * Geschaeftstag, Belege. Liegt hier und nicht in der Route, weil die
 * Uebernahme aus dem Adminpanel dieselben Belege und dieselben Regeln
 * braucht; eine zweite Fassung der Dateipruefung waere die, durch die beim
 * naechsten Befund doch ein SVG schluepft.
 */

export const BELEG_MAX_BYTES = 10 * 1024 * 1024
export const BELEGE_JE_BUCHUNG = 10
/** Base64 traegt ein Drittel mehr, dazu JSON-Huelle und Dateiname. */
export const BELEG_RUMPF_MAX = Math.ceil(BELEG_MAX_BYTES * 4 / 3) + 64 * 1024

export type BelegArt = 'application/pdf' | 'image/jpeg' | 'image/png'

export interface Einstellung {
  enabled: boolean
  opening_balance_cent: number
  opening_date: string | null
  breakfast_price_cent: number
  breakfast_food_share_bp: number
  chart_of_accounts: string
  account_lodging: string
  account_breakfast_food: string
  account_breakfast_drinks: string
  account_city_tax: string
  account_cash_in: string
  account_bank_deposit: string
  account_expense: string
  /** Ab diesem Geschaeftstag exportiert StayGrid an DATEV (Migration 0096). */
  datev_from: string | null
}

/** Die Werte, mit denen ein Haus ohne gespeicherte Einstellung rechnet (wie 0095). */
const VORGABE: Einstellung = {
  enabled: false, opening_balance_cent: 0, opening_date: null,
  breakfast_price_cent: 550, breakfast_food_share_bp: 7000, chart_of_accounts: 'SKR04',
  account_lodging: '4300', account_breakfast_food: '4300', account_breakfast_drinks: '4400',
  account_city_tax: '4300', account_cash_in: '1600', account_bank_deposit: '1200',
  account_expense: '6980', datev_from: null
}

export async function einstellungLesen(client: PoolClient, propertyId: number): Promise<Einstellung> {
  const r = await client.query<Einstellung & { opening_balance_cent: string }>(
    `SELECT enabled, opening_balance_cent, opening_date::text, breakfast_price_cent,
            breakfast_food_share_bp, chart_of_accounts, account_lodging,
            account_breakfast_food, account_breakfast_drinks, account_city_tax,
            account_cash_in, account_bank_deposit, account_expense, datev_from::text
       FROM cashbook_setting WHERE property_id = $1`, [propertyId])
  const z = r.rows[0]
  return z === undefined ? { ...VORGABE }
    : { ...z, opening_balance_cent: Number(z.opening_balance_cent) }
}

/** Die Einstellung, aber nur, wenn das Haus das Kassenbuch eingeschaltet hat. */
export async function eingeschaltet(client: PoolClient, propertyId: number): Promise<Einstellung> {
  const e = await einstellungLesen(client, propertyId)
  if (!e.enabled) throw Errors.conflict('cashbook.disabled')
  return e
}

/**
 * Der Geschaeftstag des Hauses, sonst der Kalendertag. Gegen ihn wird ein
 * Buchungsdatum geprueft, nicht gegen `now()`: nach Mitternacht vor dem
 * Nachtlauf bucht die Rezeption noch auf gestern.
 */
export async function geschaeftstag(client: PoolClient, propertyId: number): Promise<string> {
  const r = await client.query<{ d: string }>(
    `SELECT COALESCE((SELECT max(b.date) FROM business_day b WHERE b.property_id = $1),
                     current_date)::text AS d`, [propertyId])
  return r.rows[0]!.d
}

/** PDF, JPEG oder PNG, an den ersten Bytes erkannt. Alles andere, SVG zuerst, nicht. */
export function belegArt(b: Buffer): BelegArt | null {
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  return null
}

export interface Beleg { art: BelegArt; bytes: Buffer; sha256: string; name: string | null }

/** Ein Beleg aus dem JSON-Rumpf: `data` als Base64 oder data-URL, `name` freiwillig. */
export function belegAusDaten(daten: unknown, name: unknown): Beleg {
  if (typeof daten !== 'string' || daten === '') {
    throw Errors.validation({ receipts: ['field.required'] })
  }
  const roh = daten.replace(/^data:[^,]*,/, '')
  if (!/^[A-Za-z0-9+/=\s]+$/.test(roh)) throw Errors.validation({ receipts: ['field.invalid'] })
  return belegAusBytes(Buffer.from(roh, 'base64'), name)
}

export function belegAusBytes(bytes: Buffer, name: unknown): Beleg {
  if (bytes.length === 0) throw Errors.validation({ receipts: ['field.invalid'] })
  if (bytes.length > BELEG_MAX_BYTES) {
    throw Errors.validation({ receipts: ['cashbook.receiptTooLarge'] },
      { max: BELEG_MAX_BYTES / 1024 / 1024 })
  }
  const art = belegArt(bytes)
  if (art === null) throw Errors.validation({ receipts: ['cashbook.receiptType'] })
  const n = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 255) : null
  return { art, bytes, name: n, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * Einen Beleg an eine Buchung haengen. Hoechstens zehn je Buchung, und
 * dieselbe Datei nicht zweimal: ein doppelter Klick oder ein Wiederholungs-
 * lauf der Uebernahme soll keinen zweiten Beleg erzeugen.
 */
export async function belegAnhaengen(
  client: PoolClient, propertyId: number, entryId: number, beleg: Beleg, userId: number | null
): Promise<{ ref: string; mime: BelegArt; created: boolean }> {
  const vorhanden = await client.query<{ public_ref: string; sha256: string }>(
    `SELECT public_ref, sha256 FROM cashbook_receipt WHERE entry_id = $1`, [entryId])
  const gleich = vorhanden.rows.find(r => r.sha256 === beleg.sha256)
  if (gleich) return { ref: gleich.public_ref, mime: beleg.art, created: false }
  if (vorhanden.rows.length >= BELEGE_JE_BUCHUNG) {
    throw Errors.validation({ receipts: ['cashbook.tooManyReceipts'] }, { max: BELEGE_JE_BUCHUNG })
  }
  const r = await client.query<{ public_ref: string }>(
    `INSERT INTO cashbook_receipt (property_id, entry_id, mime, bytes, byte_count, sha256,
                                   original_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING public_ref`,
    [propertyId, entryId, beleg.art, beleg.bytes, beleg.bytes.length, beleg.sha256,
     beleg.name, userId])
  return { ref: r.rows[0]!.public_ref, mime: beleg.art, created: true }
}

/**
 * Ausliefern, ohne dass der Browser umdeutet (`nosniff`, die Art aus den
 * Bytes). Angezeigt wird im Browser (`inline`), weil die Rezeption den
 * Beleg ansehen und nicht ablegen will. Ein Bild bekommt dazu eine leere
 * Inhaltsrichtlinie mit Sandbox; ein PDF nicht, denn in einer Sandbox
 * verweigert Chrome die PDF-Anzeige ganz.
 */
export function belegSenden(
  reply: FastifyReply, b: { mime: string; bytes: Buffer; name: string }
): FastifyReply {
  reply
    .header('content-type', b.mime)
    .header('content-disposition', `inline; filename="${b.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, max-age=300')
  if (b.mime !== 'application/pdf') {
    reply.header('content-security-policy', "default-src 'none'; sandbox")
  }
  return reply.send(b.bytes)
}
