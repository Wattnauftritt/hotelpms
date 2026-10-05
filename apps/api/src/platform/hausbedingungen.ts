import type { PoolClient } from '@hotelpms/db'
import { Errors } from './errors.js'

/**
 * Hausbedingungen eines Aufenthalts -- die Regeln an einer Stelle.
 *
 * Bis zum Gaesteterminal standen sie in `routes/terms.ts`. Jetzt stimmt ein
 * Gast an zwei Orten zu: am Tresen und am Touchscreen (Dokument 31). Zwei
 * Fassungen derselben Regel liefen auseinander -- dieselbe Lehre wie beim
 * Meldeschein (`platform/meldeschein.ts`). Was eine Hausbedingung ist und
 * warum sie nicht auf den Meldeschein gehoert, steht in `routes/terms.ts`.
 */

export interface GeltendeBedingung {
  termsRef: string
  code: string
  version: number
  title: string
  body: string
  requiresSignature: boolean
  agreed: boolean
  agreedAt: string | null
  signed: boolean
}

/**
 * Je `code` die Fassung, die am Anreisetag gilt -- nicht die neueste. Wer
 * heute bucht und in drei Monaten anreist, unterschreibt den Text, der dann
 * haengt.
 *
 * Ein Aufruf mit einem Verbund, nicht einer je Bedingung.
 */
export async function geltendeBedingungen(
  client: PoolClient, r: { id: number; propertyId: number; arrival: string }
): Promise<GeltendeBedingung[]> {
  const { rows } = await client.query<GeltendeBedingung>(
    `SELECT DISTINCT ON (t.code)
            t.public_ref AS "termsRef", t.code, t.version, t.title, t.body,
            t.requires_signature AS "requiresSignature",
            a.agreed_at IS NOT NULL AS "agreed",
            a.agreed_at::text AS "agreedAt",
            a.signature_svg IS NOT NULL AS "signed"
       FROM property_terms t
       LEFT JOIN guest_agreement a
              ON a.terms_id = t.id AND a.reservation_id = $2
      WHERE t.property_id = $1
        AND t.active_from <= $3::date
        AND (t.active_to IS NULL OR t.active_to > $3::date)
      ORDER BY t.code, t.version DESC`,
    [r.propertyId, r.id, r.arrival])
  return rows
}

/**
 * Einer Hausbedingung fuer diesen Aufenthalt zustimmen.
 *
 * Verlangt die Fassung eine Unterschrift, ohne sie nicht; verlangt sie
 * keine, wird eine mitgeschickte verworfen -- eine Unterschrift ohne Anlass
 * waere eine Erhebung ohne Rechtsgrund. Zweimal zugestimmt ist ein zweiter
 * Klick, keine zweite Zustimmung: die erste bleibt, sie ist der Nachweis.
 *
 * Die Fassung muss zum Haus der Reservierung gehoeren: die Zeilenrichtlinie
 * laesst jedes Haus des Aufrufers durch, nicht nur dieses.
 *
 * `agreedAt` und `vorhanden: 'behalten'` braucht die Uebernahme aus einem
 * Umsystem (`routes/registrationImport.ts`): dort hat der Gast frueher
 * unterschrieben, als StayGrid davon erfaehrt, und ein Wiederholungslauf
 * ist kein Fehler, sondern derselbe Nachweis noch einmal.
 */
export async function stimmeBedingungZu(
  client: PoolClient,
  e: { reservationId: number; propertyId: number; primaryGuestId: number | null
       termsId: number; signatureSvg: unknown; createdBy: number | null
       agreedAt?: string | null; vorhanden?: 'konflikt' | 'behalten' }
): Promise<{ signed: boolean; agreedAt: string; neu: boolean }> {
  const t = await client.query<{ property_id: string; requires_signature: boolean }>(
    `SELECT property_id, requires_signature FROM property_terms WHERE id = $1`, [e.termsId])
  if (t.rowCount === 0 || Number(t.rows[0]!.property_id) !== e.propertyId) {
    throw Errors.notFound('res.terms')
  }
  const svg = typeof e.signatureSvg === 'string' && e.signatureSvg !== ''
    ? e.signatureSvg : null
  if (t.rows[0]!.requires_signature && svg === null) {
    throw Errors.unprocessable('terms.signatureRequired')
  }
  const unterschrift = t.rows[0]!.requires_signature ? svg : null

  const a = await client.query<{ agreed_at: string }>(
    `INSERT INTO guest_agreement
       (property_id, reservation_id, terms_id, guest_id, signature_svg, created_by,
        agreed_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (reservation_id, terms_id) DO NOTHING
     RETURNING agreed_at::text`,
    [e.propertyId, e.reservationId, e.termsId, e.primaryGuestId, unterschrift, e.createdBy,
     e.agreedAt ?? null])
  if (a.rowCount === 0) {
    if (e.vorhanden !== 'behalten') throw Errors.conflict('terms.alreadyAgreed')
    // Die erste Zustimmung bleibt, auch wenn die zweite anders aussieht.
    const alt = await client.query<{ agreed_at: string; signed: boolean }>(
      `SELECT agreed_at::text, signature_svg IS NOT NULL AS signed FROM guest_agreement
        WHERE reservation_id = $1 AND terms_id = $2`, [e.reservationId, e.termsId])
    return { signed: alt.rows[0]!.signed, agreedAt: alt.rows[0]!.agreed_at, neu: false }
  }
  return { signed: unterschrift !== null, agreedAt: a.rows[0]!.agreed_at, neu: true }
}
