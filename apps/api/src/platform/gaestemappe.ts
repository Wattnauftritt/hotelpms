import type { FastifyRequest } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT, type PoolClient } from '@hotelpms/db'
import { FOLDER_ROOM_HEADER, type FolderWifi } from '@hotelpms/contracts'
import { Errors } from './errors.js'

/**
 * Digitale Gaestemappe: wie eine Anfrage ohne Anmeldung an genau ein Zimmer
 * kommt (Migration 0143). Dasselbe Muster wie `checkin.ts`, nur dass der
 * Ausweis hier die Karte im Zimmer ist und nicht ein Link an einem Gast.
 */

export interface MappeKontext {
  propertyId: number
  accountId: number
  resourceId: number
  /** Der offene Geschaeftstag des Hauses. */
  businessDate: string
}

function refAusAnfrage(req: FastifyRequest): string {
  const roh = req.headers[FOLDER_ROOM_HEADER]
  const ref = Array.isArray(roh) ? roh[0] : roh
  if (ref === undefined || !/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(ref)) {
    throw Errors.notFound('res.guestFolder')
  }
  return ref
}

/**
 * Eine Transaktion im Kontext des Zimmers auf der Karte.
 *
 * Nicht `tx(req.pool, req, ...)`: der Kontext kommt aus der Referenz, und
 * zwar in der Datenbank (`guest_folder_room_open`), die mit leerem Kontext
 * beginnt und ihn auf genau dieses Haus setzt. Alles danach laeuft unter
 * der Zeilenrichtlinie.
 *
 * **Ohne eigenen Zaehler fuer Fehlversuche.** Die Referenz hat zwoelf
 * Zeichen aus dreissig, rund 10^17 Moeglichkeiten; die allgemeine Grenze
 * fuer anonyme Anfragen genuegt, Durchprobieren lohnt sich nie. Den
 * Zaehler braucht erst die Freischaltung mit Nachname oder PLZ.
 */
export function mappeTx<T>(
  req: FastifyRequest,
  fn: (client: PoolClient, k: MappeKontext) => Promise<T>
): Promise<T> {
  const ref = refAusAnfrage(req)
  return withTransaction(req.pool, SYSTEM_CONTEXT, async client => {
    const r = await client.query<{
      out_property_id: number; out_account_id: number; out_resource_id: number
      out_business_date: string; out_state: string }>(
      `SELECT out_property_id::int, out_account_id::int, out_resource_id::int,
              out_business_date::text, out_state
         FROM guest_folder_room_open($1)`, [ref])
    const z = r.rows[0]
    if (z === undefined) throw Errors.notFound('res.guestFolder')
    if (z.out_state === 'off') throw Errors.gone('folder.off')
    if (z.out_state !== 'valid') throw Errors.gone('folder.closed')
    return fn(client, {
      propertyId: z.out_property_id, accountId: z.out_account_id,
      resourceId: z.out_resource_id, businessDate: z.out_business_date
    })
  }, b => {
    req.dbKosten.anweisungen += b.anweisungen
    req.dbKosten.dauerMs += b.dauerMs
  })
}

interface WlanZeile {
  wifi_ssid: string | null; wifi_password: string | null
  wifi_security: FolderWifi['security']; wifi_hidden: boolean
}

/** Die Spalten aus `guest_folder_setting`, wie sie Gast, Einstellung und Karte brauchen. */
export function wlan(z: WlanZeile | undefined): FolderWifi | null {
  if (z === undefined || z.wifi_ssid === null) return null
  return { ssid: z.wifi_ssid, password: z.wifi_password,
           security: z.wifi_security, hidden: z.wifi_hidden }
}

/**
 * WLAN aus dem Rumpf. Dieselben Grenzen wie die CHECK-Regel in 0143, hier
 * mit einer Meldung, die sagt, was nicht passt; die Regel in der Datenbank
 * haelt, wenn jemand diese Pruefung beim naechsten Umbau vergisst.
 */
export function wlanAusRumpf(v: unknown): FolderWifi | null {
  if (v === null) return null
  if (v === undefined || typeof v !== 'object' || Array.isArray(v)) {
    throw Errors.validation({ wifi: ['field.invalid'] })
  }
  const w = v as Record<string, unknown>
  const ssid = typeof w.ssid === 'string' ? w.ssid.trim() : ''
  if (ssid === '') throw Errors.validation({ 'wifi.ssid': ['field.required'] })
  if (Buffer.byteLength(ssid, 'utf8') > 32) {
    throw Errors.validation({ 'wifi.ssid': ['folder.wifiSsid'] })
  }
  const security = w.security
  if (security !== 'WPA' && security !== 'WEP' && security !== 'nopass') {
    throw Errors.validation({ 'wifi.security': ['field.invalid'] })
  }
  if (typeof w.hidden !== 'boolean') throw Errors.validation({ 'wifi.hidden': ['field.invalid'] })
  // Ein Kennwort wird nicht getrimmt: ein Leerzeichen am Ende kann dazugehoeren.
  const password = security === 'nopass' ? null
    : typeof w.password === 'string' ? w.password : ''
  const passt = password === null
    || (security === 'WPA' && password.length >= 8 && password.length <= 63)
    || (security === 'WEP' && password.length >= 5 && password.length <= 26)
  if (!passt) throw Errors.validation({ 'wifi.password': ['folder.wifiPassword'] })
  return { ssid, password, security, hidden: w.hidden }
}
