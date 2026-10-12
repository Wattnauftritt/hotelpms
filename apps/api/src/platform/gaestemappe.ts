import type { FastifyReply, FastifyRequest } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT, type PoolClient } from '@hotelpms/db'
import { FOLDER_ROOM_HEADER, FOLDER_SESSION_COOKIE, type FolderWifi } from '@hotelpms/contracts'
import { hashToken, neuesToken } from '@hotelpms/domain'
import { Errors } from './errors.js'
import { loadConfig } from './config.js'

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

// ---------------------------------------------------------------------------
// Freischaltung (0147)
// ---------------------------------------------------------------------------

const config = loadConfig()

/**
 * Welche Reservierungen ein Zimmer gerade "haben". Der Sven-Grundsatz vom
 * 05.10.2026 gilt auch hier: was nicht storniert ist, gilt als angereist,
 * auch ohne Check-in. Ausgecheckt zaehlt fuer eine bestehende Freischaltung
 * bis zum Ende des Abreisetags, fuer eine neue nicht mehr.
 */
export const AUFENTHALT_NEU = ['Optional', 'Confirmed', 'InHouse'] as const
const AUFENTHALT_BESTEHEND = [...AUFENTHALT_NEU, 'CheckedOut'] as const

export interface Aufenthalt {
  sessionId: number
  reservationId: number
  departure: string
}

function sitzungsHash(req: FastifyRequest): string | null {
  const wert = req.cookies[FOLDER_SESSION_COOKIE]
  // Die Form pruefen, bevor die Datenbank gefragt wird; ein falsches Cookie
  // ist dasselbe wie keines.
  if (wert === undefined || !/^[A-Za-z0-9_-]{43}$/.test(wert)) return null
  return hashToken(wert)
}

/**
 * Der Aufenthalt, fuer den dieses Telefon freigeschaltet ist -- aber nur,
 * wenn er gerade im Zimmer der Karte steht. Wer das Zimmer gewechselt hat,
 * sieht mit der alten Karte wieder nur die Hausinfos, mit der neuen seinen
 * Aufenthalt.
 */
export async function aufenthaltDerSitzung(
  client: PoolClient, req: FastifyRequest, k: MappeKontext
): Promise<Aufenthalt | null> {
  const hash = sitzungsHash(req)
  if (hash === null) return null
  const r = await client.query<{ id: number; reservation_id: number; departure: string }>(
    `SELECT s.id::int, s.reservation_id::int, r.departure::text
       FROM guest_folder_session s
       JOIN reservation r ON r.id = s.reservation_id
      WHERE s.token_hash = $1 AND s.property_id = $2 AND s.revoked_at IS NULL
        AND s.expires_on >= $3::date AND r.departure >= $3::date
        AND r.resource_id = $4 AND r.status::text = ANY ($5::text[])`,
    [hash, k.propertyId, k.businessDate, k.resourceId, AUFENTHALT_BESTEHEND])
  const z = r.rows[0]
  return z === undefined ? null
    : { sessionId: z.id, reservationId: z.reservation_id, departure: z.departure }
}

/**
 * Eine Freischaltung anlegen und das Cookie setzen. Gueltig bis zum Ende
 * des Abreisetags am Ort des Hauses -- danach braucht das Telefon den
 * Aufenthalt nicht mehr, und der naechste Gast im Zimmer soll ihn nicht
 * erben.
 */
export async function freischalten(
  client: PoolClient, reply: FastifyReply,
  a: { propertyId: number; reservationId: number; channel: 'room' | 'mail' }
): Promise<{ departure: string }> {
  const { token, hash } = neuesToken()
  const r = await client.query<{ departure: string; bis: Date }>(
    `INSERT INTO guest_folder_session (property_id, reservation_id, token_hash, channel, expires_on)
     SELECT r.property_id, r.id, $3, $4, r.departure
       FROM reservation r WHERE r.id = $2 AND r.property_id = $1
     RETURNING expires_on::text AS departure,
               ((expires_on + 1)::timestamp AT TIME ZONE
                 (SELECT timezone FROM property WHERE id = $1)) AS bis`,
    [a.propertyId, a.reservationId, hash, a.channel])
  const z = r.rows[0]
  if (z === undefined) throw Errors.notFound('res.reservation')
  reply.setCookie(FOLDER_SESSION_COOKIE, token, {
    httpOnly: true,
    // `strict` wie die Sitzung: niemand verlinkt von aussen auf die Mappe,
    // und der QR-Code oeffnet die Seite als eigene Navigation.
    sameSite: 'strict',
    secure: config.secureTransport,
    // Nur an die Routen der Mappe, nie an die Anwendung.
    path: '/v1/mappe',
    expires: z.bis
  })
  return { departure: z.departure }
}

export function freischaltungLoeschen(reply: FastifyReply): void {
  reply.clearCookie(FOLDER_SESSION_COOKIE, { path: '/v1/mappe' })
}

/** Fuer `/v1/mappe/lock`: die eigene Freischaltung aufheben. */
export async function eigeneFreischaltungAufheben(
  client: PoolClient, req: FastifyRequest, propertyId: number
): Promise<void> {
  const hash = sitzungsHash(req)
  if (hash === null) return
  await client.query(
    `UPDATE guest_folder_session SET revoked_at = now()
      WHERE token_hash = $1 AND property_id = $2 AND revoked_at IS NULL`, [hash, propertyId])
}

/**
 * Oeffnet der Link zum Online-Check-in die Mappe? Nur der aus der Mail, ab
 * dem Anreisetag, mit zugeteiltem Zimmer und eingeschalteter Mappe. Vorher
 * gibt es keine Karte im Zimmer, zu der die Mappe gehoert, und das Zimmer
 * kann sich bis zur Anreise noch aendern.
 *
 * Mit `anlegen` bekommt das Zimmer seine Referenz, falls es noch keine hat;
 * die Seite des Check-ins fragt nur, ob es ginge, und legt nichts an.
 */
export async function mappeZumLink(
  client: PoolClient,
  k: { reservationId: number; propertyId: number; channel: string; businessDate: string },
  anlegen = true
): Promise<{ ref: string } | null> {
  if (k.channel !== 'mail') return null
  const r = await client.query<{ resource_id: number; ref: string | null }>(
    `SELECT r.resource_id::int, f.public_ref AS ref
       FROM reservation r
       JOIN resource res ON res.id = r.resource_id AND res.active
       JOIN guest_folder_setting s ON s.property_id = r.property_id AND s.enabled
       LEFT JOIN guest_folder_room f ON f.resource_id = r.resource_id
      WHERE r.id = $1 AND r.property_id = $2
        AND r.status::text = ANY ($4::text[])
        AND r.arrival <= $3::date AND r.departure >= $3::date`,
    [k.reservationId, k.propertyId, k.businessDate, AUFENTHALT_NEU])
  const z = r.rows[0]
  if (z === undefined) return null
  if (z.ref !== null) return { ref: z.ref }
  if (!anlegen) return { ref: '' }
  const neu = await client.query<{ ref: string }>(
    `INSERT INTO guest_folder_room (resource_id, property_id) VALUES ($1, $2)
     ON CONFLICT (resource_id) DO UPDATE SET resource_id = EXCLUDED.resource_id
     RETURNING public_ref AS ref`, [z.resource_id, k.propertyId])
  return { ref: neu.rows[0]!.ref }
}
