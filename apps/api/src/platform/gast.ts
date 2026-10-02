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
