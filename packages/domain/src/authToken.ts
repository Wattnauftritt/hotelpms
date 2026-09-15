import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Einmaltoken fuer Einladung und Kennwortruecksetzung.
 *
 * **Ein Mechanismus, zwei Anlaesse.** Eine Einladung und eine Ruecksetzung
 * tun dasselbe: sie erlauben genau einmal, ein Kennwort zu setzen, ohne das
 * alte zu kennen. Sie unterscheiden sich in der Frist und im Text der
 * Nachricht. Zwei getrennte Mechanismen zu bauen hiesse, dieselbe
 * Sicherheitsfrage zweimal zu beantworten -- und die zweite Antwort faellt
 * erfahrungsgemaess schlechter aus.
 */

export type AuthTokenKind = 'invite' | 'password_reset'

/**
 * Wie lange ein Token gilt.
 *
 * Die Einladung laenger, weil sie einen Menschen erreicht, der nicht darauf
 * wartet: sie kommt an einem Freitagnachmittag an und wird am Montag
 * bearbeitet. Die Ruecksetzung kurz, weil der Benutzer sie gerade selbst
 * angefordert hat und daneben sitzt -- und weil ein Token, das lange gilt,
 * lange in einem Postfach liegt.
 */
export const TOKEN_GUELTIGKEIT: Record<AuthTokenKind, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000
}

/**
 * Erzeugt ein Token und seinen Hash.
 *
 * 32 Byte aus `randomBytes`, nicht aus `Math.random`: das eine ist ein
 * Zufallsgenerator fuer Kryptographie, das andere einer fuer Wuerfelspiele.
 * Base64url, damit das Token ohne Kodierung in eine URL passt -- ein
 * `+` oder `/` in einem Link bricht je nach Mailprogramm.
 */
export function neuesToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

/**
 * SHA-256 ueber das Token.
 *
 * Bewusst **kein** Argon2, obwohl daneben Kennwoerter damit gehasht werden.
 * Der Unterschied ist die Entropie: ein Kennwort hat oft zwanzig Bit und
 * muss deshalb teuer zu pruefen sein, damit Durchprobieren sich nicht lohnt.
 * Dieses Token hat 256 Bit -- Durchprobieren lohnt sich nie, und ein teurer
 * Hash machte nur jede Anfrage langsam.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Vergleicht zwei Hashes ohne Zeitunterschied.
 *
 * Auch wenn hier ueber einen eindeutigen Index gesucht wird und der
 * Vergleich damit in der Datenbank stattfindet: wo im Code zwei Geheimnisse
 * verglichen werden, gehoert der zeitkonstante Vergleich hin. Ein `===` an
 * dieser Stelle waere heute richtig und beim naechsten Umbau falsch.
 */
export function gleicherHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/*
 * Die Kennwortregel steht in @hotelpms/contracts, nicht hier.
 *
 * Sie ist keine Fachlogik dieses Pakets, sondern eine Zusage an beide Enden:
 * die Schnittstelle weist ein zu kurzes Kennwort ab, die Oberflaeche nennt
 * die Laenge vorher. Stuende die Zahl an zwei Stellen, liefe sie
 * auseinander. Siehe packages/contracts/src/kennwort.ts.
 */
