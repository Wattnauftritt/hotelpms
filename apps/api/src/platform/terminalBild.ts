import type { FastifyReply } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { Errors } from './errors.js'

/**
 * Bilder fuer die Seiten des Gaesteterminals (Migration 0062).
 *
 * **Die Art entscheiden die Bytes, nicht die Angabe.** Wer hochlaedt, sagt
 * vielleicht "image/png" und schickt ein SVG -- und ein SVG ist ein
 * Dokument mit Skript, das ein Browser ausfuehrt, wenn er es als solches
 * erkennt. Angenommen wird deshalb nur, was an den ersten Bytes als PNG,
 * JPEG oder WebP zu erkennen ist; alles andere, SVG zuerst, wird
 * abgewiesen. Gespeichert und ausgeliefert wird die erkannte Art.
 */

export const BILD_MAX_BYTES = 1_048_576

export type BildArt = 'image/png' | 'image/jpeg' | 'image/webp'

export function bildArt(b: Buffer): BildArt | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF'
      && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * Ein hochgeladenes Bild pruefen: Base64 im JSON-Rumpf, hoechstens ein
 * Megabyte, eine der drei Arten. Base64 und nicht ein Formular mit Datei,
 * weil die Schnittstelle sonst einen zweiten Rumpfparser braeuchte -- fuer
 * ein Bild je Seite lohnt das nicht.
 */
export function bildAusRumpf(body: unknown): { art: BildArt; bytes: Buffer } {
  const daten = (body as { data?: unknown } | undefined)?.data
  if (typeof daten !== 'string' || daten === '') {
    throw Errors.validation({ data: ['field.required'] })
  }
  // Eine data-URL ist bequem fuer die Oberflaeche; der Kopf sagt nichts,
  // was hier zaehlt, und faellt deshalb weg.
  const roh = daten.replace(/^data:[^,]*,/, '')
  if (!/^[A-Za-z0-9+/=\s]+$/.test(roh)) throw Errors.validation({ data: ['field.invalid'] })
  const bytes = Buffer.from(roh, 'base64')
  if (bytes.length === 0) throw Errors.validation({ data: ['field.invalid'] })
  if (bytes.length > BILD_MAX_BYTES) {
    throw Errors.validation({ data: ['terminal.imageTooLarge'] },
      { max: Math.round(BILD_MAX_BYTES / 1024) })
  }
  const art = bildArt(bytes)
  if (art === null) throw Errors.validation({ data: ['terminal.imageType'] })
  return { art, bytes }
}

export async function bildLesen(
  client: PoolClient, imageRef: string, propertyId: number
): Promise<{ mime: string; bytes: Buffer }> {
  const r = await client.query<{ mime: string; bytes: Buffer }>(
    `SELECT mime, bytes FROM terminal_content_image
      WHERE public_ref = $1 AND property_id = $2`, [imageRef, propertyId])
  if (r.rowCount === 0) throw Errors.notFound('res.terminalContent')
  return r.rows[0]!
}

/**
 * Ausliefern, ohne dass ein Browser es umdeutet: `nosniff` gegen das
 * Raten der Art, und eine eigene, leere Inhaltsrichtlinie, falls die Datei
 * doch einmal direkt aufgerufen wird.
 */
export function bildSenden(reply: FastifyReply, b: { mime: string; bytes: Buffer }): FastifyReply {
  return reply
    .header('content-type', b.mime)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'private, max-age=300')
    .send(b.bytes)
}
