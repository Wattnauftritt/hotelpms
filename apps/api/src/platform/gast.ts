import type { PoolClient } from '@hotelpms/db'
import { loadConfig } from './config.js'
import { encryptIdDocument } from './crypto.js'

/**
 * Gastprofil anlegen und aendern -- an einer Stelle.
 *
 * Bis zum Online-Check-in standen die beiden Anweisungen in `routes/guests.ts`
 * und nur dort. Jetzt schreibt auch die Gastseite ins Profil, und eine
 * zweite Fassung derselben Anweisung waere genau die Bauart, bei der die
 * Ausweisnummer an einer Stelle verschluesselt wird und an der anderen
 * nicht. Deshalb beide hier, und beide Routen rufen sie.
 */

export interface GastFelder {
  lastName?: string
  firstName?: string
  email?: string
  phone?: string
  birthDate?: string
  nationality?: string
  language?: string
  addressLine1?: string
  postalCode?: string
  city?: string
  country?: string
  idDocumentType?: 'passport' | 'id_card' | 'other'
  idDocumentNumber?: string
  preferences?: Record<string, unknown>
}

export const GAST_SPALTEN = `id, public_ref, last_name, first_name, email, phone,
                birth_date::text AS birth_date, nationality, language,
                address_line1, postal_code, city, country,
                id_document_type, id_document_key_version, preferences, status`

export interface GastZeile {
  id: number; public_ref: string; last_name: string; first_name: string | null
  email: string | null; phone: string | null; birth_date: string | null
  nationality: string | null; language: string; address_line1: string | null
  postal_code: string | null; city: string | null; country: string | null
  id_document_type: string | null; id_document_key_version: number | null
  preferences: Record<string, unknown>; status: string
}

/** Die Ausweisnummer verschluesselt, nie im Klartext in einer Anweisung. */
function ausweis(nummer: string | undefined): { ciphertext: Buffer; keyVersion: number } | null {
  return nummer ? encryptIdDocument(nummer, loadConfig().idDocumentKey) : null
}

export async function gastAnlegen(
  client: PoolClient, accountId: number, g: GastFelder & { lastName: string }
): Promise<GastZeile> {
  const enc = ausweis(g.idDocumentNumber)
  const { rows } = await client.query<GastZeile>(
    `INSERT INTO guest (account_id, last_name, first_name, email, phone, birth_date,
                        nationality, language, address_line1, postal_code, city, country,
                        id_document_type, id_document_number_enc, id_document_key_version,
                        preferences)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${GAST_SPALTEN}`,
    [accountId, g.lastName.trim(), g.firstName ?? null, g.email ?? null,
     g.phone ?? null, g.birthDate ?? null, g.nationality ?? null,
     g.language ?? 'de', g.addressLine1 ?? null, g.postalCode ?? null,
     g.city ?? null, g.country ?? null, g.idDocumentType ?? null,
     enc?.ciphertext ?? null, enc?.keyVersion ?? null,
     JSON.stringify(g.preferences ?? {})])
  return rows[0]!
}

/**
 * Felder setzen, die angegeben sind; die anderen bleiben.
 *
 * Der Aufrufer prueft vorher, dass der Gast nicht anonymisiert ist -- ein
 * geloeschtes Profil darf nicht durch eine Aenderung wiederbelebt werden.
 */
export async function gastAendern(
  client: PoolClient, guestId: number, g: GastFelder
): Promise<GastZeile> {
  const enc = ausweis(g.idDocumentNumber)
  const { rows } = await client.query<GastZeile>(
    `UPDATE guest SET
       last_name     = COALESCE($2, last_name),
       first_name    = COALESCE($3, first_name),
       email         = COALESCE($4, email),
       phone         = COALESCE($5, phone),
       birth_date    = COALESCE($6::date, birth_date),
       nationality   = COALESCE($7, nationality),
       language      = COALESCE($8, language),
       address_line1 = COALESCE($9, address_line1),
       postal_code   = COALESCE($10, postal_code),
       city          = COALESCE($11, city),
       country       = COALESCE($12, country),
       id_document_type = COALESCE($13, id_document_type),
       id_document_number_enc  = COALESCE($14, id_document_number_enc),
       id_document_key_version = COALESCE($15, id_document_key_version),
       preferences   = COALESCE($16::jsonb, preferences),
       updated_at    = now()
     WHERE id = $1 RETURNING ${GAST_SPALTEN}`,
    [guestId, g.lastName ?? null, g.firstName ?? null, g.email ?? null,
     g.phone ?? null, g.birthDate ?? null, g.nationality ?? null,
     g.language ?? null, g.addressLine1 ?? null, g.postalCode ?? null,
     g.city ?? null, g.country ?? null, g.idDocumentType ?? null,
     enc?.ciphertext ?? null, enc?.keyVersion ?? null,
     g.preferences ? JSON.stringify(g.preferences) : null])
  return rows[0]!
}

/** Haengt das Profil noch an einer anderen Reservierung, in irgendeinem Haus? */
export async function profilGeteilt(
  client: PoolClient, guestId: number, reservationId: number
): Promise<boolean> {
  const r = await client.query<{ geteilt: boolean }>(
    `SELECT guest_is_shared($1, $2) AS geteilt`, [guestId, reservationId])
  return r.rows[0]!.geteilt
}

/**
 * Das Profil, in das ein Umsystem fuer diese Reservierung schreiben darf.
 *
 * Haengt der Hauptgast noch an einer anderen Reservierung, bekommt diese
 * hier ein eigenes Profil (Migration 0106), und der Aufrufer schreibt
 * dorthin. Ein Umsystem kennt den Aufenthalt, nicht den Menschen: ob zwei
 * Aufenthalte unter einem KWHotel-Gastsatz derselbe Mensch sind, weiss es
 * nicht, und ein Name, den es fuer den einen schickt, stand sonst bei allen.
 * So kamen fremde Vornamen in die Anreiseliste.
 *
 * Die Rezeption und der Gast selbst trennen nicht: sie haengen einen
 * Stammgast bewusst an ein vorhandenes Profil.
 */
export async function eigenesProfil(
  client: PoolClient, reservationId: number, guestId: number
): Promise<{ id: number; publicRef: string; getrennt: boolean }> {
  if (!(await profilGeteilt(client, guestId, reservationId))) {
    const g = await client.query<{ public_ref: string }>(
      `SELECT public_ref FROM guest WHERE id = $1`, [guestId])
    return { id: guestId, publicRef: g.rows[0]!.public_ref, getrennt: false }
  }
  // Erst trennen, dann lesen: das neue Profil entsteht waehrend der
  // Anweisung und ist in ihrem eigenen Schnappschuss noch nicht zu sehen.
  const s = await client.query<{ out_new_guest: string }>(
    `SELECT out_new_guest FROM guest_split_reservations(ARRAY[$1::bigint])`, [reservationId])
  const id = Number(s.rows[0]!.out_new_guest)
  const z = (await client.query<{ public_ref: string }>(
    `SELECT public_ref FROM guest WHERE id = $1`, [id])).rows[0]!
  return { id, publicRef: z.public_ref, getrennt: true }
}
