import { createHash } from 'node:crypto'
import { BITS, HASHES, FILTER } from './kennwortliste.daten.js'

/**
 * Steht ein Kennwort in einer Liste geleakter Kennwoerter (Bedrohungsanalyse
 * 23.10.2026, A2)?
 *
 * Zwoelf Zeichen genuegen der Laengenregel, `sommerurlaub` auch. Wer
 * Zugangsdaten durchprobiert -- von Hand oder mit einer KI, die aus einem
 * Leak die naechsten Kandidaten ableitet --, beginnt mit genau diesen
 * Listen. NIST SP 800-63B verlangt deshalb den Abgleich beim Setzen.
 *
 * **Lokal, nicht bei einem Dienst.** Have I Been Pwned waere vollstaendiger,
 * aber dann ginge bei jedem Kennwortwechsel ein Hashanfang an einen Dritten,
 * und die Produktivmaschine braeuchte dafuer einen Weg nach draussen, den
 * sie sonst nicht hat. Die Liste liegt als Bloom-Filter im Code (rund 73 000
 * Kennwoerter ab zwoelf Zeichen, 128 KB, `scripts/kennwortliste-bauen.py`).
 * Ein Filter irrt nur in eine Richtung: jedes tausendste unbekannte
 * Kennwort gilt als bekannt. Der Benutzer waehlt dann ein anderes; ein
 * bekanntes kommt nie durch.
 */

const filter = Buffer.from(FILTER, 'base64')

function normal(kennwort: string): string {
  return kennwort.normalize('NFKC').toLowerCase()
}

export function kennwortBekannt(kennwort: string): boolean {
  const h = createHash('sha256').update(normal(kennwort), 'utf8').digest()
  const h1 = h.readUInt32BE(0)
  const h2 = h.readUInt32BE(4) | 1
  for (let i = 0; i < HASHES; i++) {
    // BigInt nicht noetig: h1 + i * h2 bleibt unter 2^53.
    const j = (h1 + i * (h2 >>> 0)) % BITS
    if ((filter[j >> 3]! & (1 << (j & 7))) === 0) return false
  }
  return true
}

/**
 * Was ausser der Liste noch zu leicht ist: der Name des Produkts und der
 * eigene Anmeldename im Kennwort. Beides steht auf jeder nachgebauten
 * Anmeldeseite schon da und ist das Erste, was ein Angreifer einsetzt.
 */
export function kennwortZuNah(kennwort: string, anmeldung: string | null): boolean {
  const k = normal(kennwort)
  if (k.includes('staygrid')) return true
  const name = normal(anmeldung ?? '').split('@')[0] ?? ''
  return name.length >= 4 && k.includes(name)
}
