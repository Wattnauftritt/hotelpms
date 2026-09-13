import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual }
  from 'node:crypto'

/**
 * Verschluesselung der Ausweisnummer.
 *
 * § 30 BMG erlaubt es, die Nummer des Ausweises zu **notieren**, verbietet
 * aber die Kopie. Die Nummer ist damit das einzige Ausweismerkmal im System,
 * und sie liegt verschluesselt. Es gibt bewusst keinen Datei-Upload.
 *
 * AES-256-GCM: verschluesselt und authentifiziert in einem Schritt. Ein
 * veraenderter Geheimtext faellt beim Entschluesseln auf, statt still
 * Unsinn zu liefern.
 *
 * Jeder Datensatz haelt die **Schluesselversion**. Ohne sie ist eine
 * Schluesselrotation nur mit einem Stillstand des Betriebs moeglich: alte
 * Datensaetze bleiben mit der alten Version lesbar, neue werden mit der
 * aktuellen geschrieben (C4, Dokument 13).
 */
export const CURRENT_KEY_VERSION = 1

const IV_LENGTH = 12
const TAG_LENGTH = 16
/** Fester Salt je Version: der Schluessel muss reproduzierbar sein. */
const SALT = 'hotelpms-id-document-v'

const cache = new Map<number, Buffer>()

function keyFor(version: number, secret: string): Buffer {
  const cached = cache.get(version)
  if (cached) return cached
  const key = scryptSync(secret, `${SALT}${version}`, 32)
  cache.set(version, key)
  return key
}

/** Ergibt IV ‖ Geheimtext ‖ Tag. Ein Feld, kein Zerlegen in der Datenbank. */
export function encryptIdDocument(
  plaintext: string, secret: string, version = CURRENT_KEY_VERSION
): { ciphertext: Buffer; keyVersion: number } {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', keyFor(version, secret), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext: Buffer.concat([iv, enc, cipher.getAuthTag()]), keyVersion: version }
}

export function decryptIdDocument(
  ciphertext: Buffer, secret: string, version: number
): string {
  if (ciphertext.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Geheimtext zu kurz')
  }
  const iv = ciphertext.subarray(0, IV_LENGTH)
  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH)
  const body = ciphertext.subarray(IV_LENGTH, ciphertext.length - TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', keyFor(version, secret), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/**
 * Die letzten vier Zeichen fuer die Anzeige an der Rezeption. Der Regelfall
 * ist, dass die Nummer nur verglichen, nicht gelesen werden muss.
 */
export function maskIdDocument(plaintext: string): string {
  if (plaintext.length <= 4) return '*'.repeat(plaintext.length)
  return '*'.repeat(plaintext.length - 4) + plaintext.slice(-4)
}

/** Vergleich ohne Laufzeitunterschied, fuer Tokens und Nummern. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
