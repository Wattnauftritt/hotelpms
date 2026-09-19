import { isIPv4, isIPv6 } from 'node:net'

/**
 * Pruefung der Ziele ausgehender Ereignisse (Befund B1 der Sicherheitspruefung).
 *
 * **Warum das noetig ist.** Der Worker laeuft auf derselben Maschine wie API
 * und Datenbank. Ein Abonnement ist damit eine Aufforderung an uns, eine
 * Adresse unserer Wahl -- der Wahl des Abonnenten -- von innen anzusprechen.
 * Wer `https://127.0.0.1:6379/` oder `https://169.254.169.254/latest/meta-data/`
 * eintraegt, laesst uns an Dienste klopfen, die von aussen nicht erreichbar
 * sind, und liest das Ergebnis im Zustellprotokoll nach. Das ist Server-Side
 * Request Forgery, und der Praefix `https://` haelt davon nichts ab.
 *
 * **Warum die Pruefung hier liegt.** Beide Seiten brauchen dieselbe Liste:
 * die API, um ein schlechtes Ziel sofort mit einer brauchbaren Meldung
 * abzuweisen, und der Worker, um kurz vor dem Verbinden noch einmal
 * nachzusehen. Zwei Listen liefen auseinander, und die im Worker ist die,
 * auf die es ankommt.
 *
 * **Warum zweimal geprueft wird.** Ein Name, der beim Anlegen nach draussen
 * zeigt, kann beim Zustellen auf `127.0.0.1` zeigen; wer die Zone besitzt,
 * entscheidet das im Sekundentakt. Eine Pruefung beim Anlegen allein ist
 * deshalb Bequemlichkeit, keine Absicherung -- die Absicherung sitzt im
 * Worker, der die Adresse aufloest, prueft und dann genau diese Adresse
 * ansteuert, damit zwischen Pruefung und Verbindung keine zweite Aufloesung
 * liegt (DNS-Rebinding).
 *
 * Dieses Modul kennt kein Netz: es rechnet auf Zeichenketten und Bytes.
 * Aufgeloest wird im Worker, wo das hingehoert.
 */

/** Warum ein Ziel abgelehnt wurde. Zugleich der Schluessel der Meldung. */
export type WebhookTargetProblem =
  /** Kein lesbarer URL. */
  | 'malformed'
  /** Weder https noch ein ausdruecklich freigegebenes Netz ueber http. */
  | 'scheme'
  /** Benutzername oder Kennwort im URL. */
  | 'credentials'
  /** Das Ziel zeigt in ein Netz, das nicht angesprochen wird. */
  | 'blockedAddress'

/** Ein Netz in Bytes: Adresse und Zahl der bindenden Bits. */
export interface Cidr {
  readonly bytes: Uint8Array
  readonly bits: number
}

// ---------------------------------------------------------------------------
// Adressen lesen
// ---------------------------------------------------------------------------

function parseIPv4(s: string): Uint8Array | null {
  if (!isIPv4(s)) return null
  const teile = s.split('.')
  const b = new Uint8Array(4)
  for (let i = 0; i < 4; i++) b[i] = Number(teile[i])
  return b
}

/**
 * IPv6 in 16 Bytes, mit `::` und angehaengter IPv4-Schreibweise.
 *
 * `isIPv6` hat die Form schon geprueft; hier wird nur noch gerechnet. Die
 * beiden Sonderfaelle sind die Verkuerzung `::` und das Ende `::ffff:1.2.3.4`,
 * und gerade das zweite ist der Punkt: `::ffff:127.0.0.1` ist Loopback und
 * sieht nicht danach aus.
 */
function parseIPv6(s: string): Uint8Array | null {
  if (!isIPv6(s)) return null
  // Ein Bereichsbezeichner (fe80::1%eth0) gehoert nicht zur Adresse.
  const ohneZone = s.split('%')[0]!
  const [vornRoh, hintenRoh] = ohneZone.includes('::')
    ? ohneZone.split('::') as [string, string]
    : [ohneZone, '']
  const zuGruppen = (teil: string): string[] | null => {
    if (teil === '') return []
    const gruppen: string[] = []
    for (const g of teil.split(':')) {
      if (g.includes('.')) {
        // Angehaengte IPv4 belegt zwei Gruppen.
        const v4 = parseIPv4(g)
        if (v4 === null) return null
        gruppen.push(((v4[0]! << 8) | v4[1]!).toString(16),
                     ((v4[2]! << 8) | v4[3]!).toString(16))
      } else gruppen.push(g)
    }
    return gruppen
  }
  const vorn = zuGruppen(vornRoh)
  const hinten = zuGruppen(hintenRoh)
  if (vorn === null || hinten === null) return null
  const fehlend = 8 - vorn.length - hinten.length
  if (fehlend < 0) return null
  const alle = [...vorn, ...Array<string>(fehlend).fill('0'), ...hinten]
  if (alle.length !== 8) return null

  const b = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const wert = parseInt(alle[i]!, 16)
    if (!Number.isFinite(wert) || wert < 0 || wert > 0xffff) return null
    b[i * 2] = wert >> 8
    b[i * 2 + 1] = wert & 0xff
  }
  return b
}

/** Liest eine IPv4 oder IPv6 in ihre Bytes. `null`, wenn es keine ist. */
export function parseIpAddress(s: string): Uint8Array | null {
  return parseIPv4(s) ?? parseIPv6(s)
}

/**
 * Die Formen, in denen dieselbe Adresse noch einmal auftaucht.
 *
 * Eine IPv6 kann eine IPv4 einwickeln, und die Pakete landen am Ende doch
 * dort. Geprueft wird deshalb die Adresse **und** jede IPv4, die in ihr
 * steckt: die abgebildete Form `::ffff:a.b.c.d`, die alte kompatible Form
 * `::a.b.c.d`, NAT64 `64:ff9b::/96` und 6to4 `2002::/16`, wo die IPv4 nicht
 * am Ende, sondern im zweiten bis fuenften Byte steht.
 */
export function embeddedForms(bytes: Uint8Array): Uint8Array[] {
  const formen: Uint8Array[] = [bytes]
  if (bytes.length !== 16) return formen
  const praefix = (...erwartet: number[]): boolean =>
    erwartet.every((v, i) => bytes[i] === v)

  const letzteVier = bytes.slice(12, 16)
  // ::ffff:a.b.c.d -- IPv4 in IPv6 abgebildet.
  if (praefix(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff)) formen.push(letzteVier)
  // ::a.b.c.d -- die alte kompatible Form. `::` und `::1` faengt die
  // IPv6-Sperrliste ab, deshalb hier nur, was darueber hinausgeht.
  else if (praefix(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
           && !letzteVier.every(v => v === 0)) formen.push(letzteVier)
  // 64:ff9b::/96 -- NAT64.
  if (praefix(0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0)) formen.push(letzteVier)
  // 2002::/16 -- 6to4, die IPv4 steht direkt hinter dem Praefix.
  if (praefix(0x20, 0x02)) formen.push(bytes.slice(2, 6))
  return formen
}

// ---------------------------------------------------------------------------
// Netze
// ---------------------------------------------------------------------------

function cidr(adresse: string, bits: number): Cidr {
  const bytes = parseIpAddress(adresse)
  if (bytes === null) throw new Error(`Keine Adresse: ${adresse}`)
  return { bytes, bits }
}

export function addressInCidr(bytes: Uint8Array, netz: Cidr): boolean {
  if (bytes.length !== netz.bytes.length) return false
  const ganze = netz.bits >> 3
  for (let i = 0; i < ganze; i++) if (bytes[i] !== netz.bytes[i]) return false
  const rest = netz.bits & 7
  if (rest === 0) return true
  const maske = 0xff << (8 - rest) & 0xff
  return (bytes[ganze]! & maske) === (netz.bytes[ganze]! & maske)
}

/** Trifft eine der Formen der Adresse eines der Netze? */
export function addressInCidrs(bytes: Uint8Array, netze: readonly Cidr[]): boolean {
  if (netze.length === 0) return false
  return embeddedForms(bytes).some(f => netze.some(n => addressInCidr(f, n)))
}

/**
 * Was nicht angesprochen wird.
 *
 * Nicht nur die drei privaten Bereiche: `169.254.0.0/16` ist die Adresse,
 * unter der jeder Hoster seine Metadaten und damit oft seine Zugangsdaten
 * ausliefert, und die dokumentierten und reservierten Bereiche stehen dabei,
 * weil ein Ziel darin nie eine Absicht ist.
 */
export const BLOCKED_NETWORKS: readonly Cidr[] = [
  // IPv4
  cidr('0.0.0.0', 8),          // dieses Netz
  cidr('10.0.0.0', 8),         // privat
  cidr('100.64.0.0', 10),      // Carrier-Grade NAT
  cidr('127.0.0.0', 8),        // Loopback
  cidr('169.254.0.0', 16),     // Link-Local, Metadaten des Hosters
  cidr('172.16.0.0', 12),      // privat
  cidr('192.0.0.0', 24),       // IETF-Zuweisungen
  cidr('192.0.2.0', 24),       // TEST-NET-1
  cidr('192.88.99.0', 24),     // 6to4-Relay-Anycast
  cidr('192.168.0.0', 16),     // privat
  cidr('198.18.0.0', 15),      // Messbereich
  cidr('198.51.100.0', 24),    // TEST-NET-2
  cidr('203.0.113.0', 24),     // TEST-NET-3
  cidr('224.0.0.0', 4),        // Multicast
  cidr('240.0.0.0', 4),        // reserviert, einschliesslich Broadcast
  // IPv6
  cidr('::', 128),             // unbestimmt
  cidr('::1', 128),            // Loopback
  cidr('64:ff9b:1::', 48),     // lokales NAT64
  cidr('100::', 64),           // Verwurf
  cidr('2001::', 32),          // Teredo
  cidr('2001:db8::', 32),      // Dokumentation
  cidr('fc00::', 7),           // eindeutig lokal
  cidr('fe80::', 10),          // Link-Local
  cidr('ff00::', 8)            // Multicast
]

/**
 * Liest `WEBHOOK_ALLOWED_PRIVATE_CIDRS`: durch Komma getrennte Netze, die
 * trotz Sperrliste angesprochen werden duerfen, etwa `10.0.1.0/24`.
 *
 * Wirft bei einem Tippfehler, statt den Eintrag zu ueberspringen. Ein
 * stillschweigend verworfenes Netz faellt erst auf, wenn eine Zustellung
 * ausbleibt, und dann sucht jemand an der falschen Stelle.
 */
export function parseCidrList(spec: string | null | undefined): Cidr[] {
  if (spec === null || spec === undefined || spec.trim() === '') return []
  return spec.split(',').map(s => s.trim()).filter(s => s !== '').map(eintrag => {
    const [adresse, bitsRoh] = eintrag.split('/')
    const bytes = parseIpAddress(adresse ?? '')
    if (bytes === null) throw new Error(`Keine Adresse: ${eintrag}`)
    const hoechstens = bytes.length * 8
    const bits = bitsRoh === undefined ? hoechstens : Number(bitsRoh)
    if (!Number.isInteger(bits) || bits < 0 || bits > hoechstens) {
      throw new Error(`Keine brauchbare Netzmaske: ${eintrag}`)
    }
    return { bytes, bits }
  })
}

// ---------------------------------------------------------------------------
// Ziele
// ---------------------------------------------------------------------------

/**
 * Ein aufgeloestes Ziel, so wie es angesteuert werden darf.
 *
 * `https` bleibt die Regel. `http` ist nur in ein ausdruecklich
 * freigegebenes Netz erlaubt: wer sein eigenes Haus eintraegt, hat sich
 * entschieden, und ein Kassensystem im eigenen Netz hinter einem eigenen
 * Zertifikat zu verlangen ist der zuverlaessigste Weg, die Pruefung ganz
 * abschalten zu lassen. Ins offene Netz geht nichts ohne TLS.
 */
export function checkResolvedAddress(
  scheme: string, ip: string, allowed: readonly Cidr[]
): WebhookTargetProblem | null {
  const bytes = parseIpAddress(ip)
  if (bytes === null) return 'blockedAddress'
  const freigegeben = addressInCidrs(bytes, allowed)
  if (!freigegeben && addressInCidrs(bytes, BLOCKED_NETWORKS)) return 'blockedAddress'
  if (scheme === 'https:') return null
  if (scheme === 'http:' && freigegeben) return null
  return 'scheme'
}

export interface WebhookTarget {
  readonly url: URL
  /** Steht im URL schon eine Adresse, ist hier ihr Text; sonst `null`. */
  readonly literalAddress: string | null
}

/**
 * Prueft, was sich ohne Netz pruefen laesst: Form, Verfahren, Zugangsdaten
 * und -- wenn im URL statt eines Namens schon eine Adresse steht -- diese.
 *
 * Aufgeloest wird hier bewusst nicht. Ein Name, der im Augenblick des
 * Anlegens nicht aufloest, ist kein Grund, ein Abonnement abzulehnen; der
 * Empfaenger kann morgen im DNS stehen. Und ein Name, der jetzt aufloest,
 * ist kein Versprechen fuer spaeter. Beides entscheidet der Worker.
 */
export function checkWebhookTargetUrl(
  raw: unknown, allowed: readonly Cidr[] = []
): { target: WebhookTarget } | { problem: WebhookTargetProblem } {
  if (typeof raw !== 'string' || raw.trim() === '') return { problem: 'malformed' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { problem: 'malformed' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { problem: 'scheme' }
  // Zugangsdaten im URL landen im Protokoll und in jeder Fehlermeldung, und
  // gegenueber einem Empfaenger, der sie mitgeteilt bekommt, sind sie
  // ohnehin kein Geheimnis mehr. Der gemeinsame Schluessel ist der Weg.
  if (url.username !== '' || url.password !== '') return { problem: 'credentials' }

  // Eckige Klammern gehoeren zum URL, nicht zur Adresse.
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  const literal = parseIpAddress(host) === null ? null : host

  if (literal !== null) {
    const problem = checkResolvedAddress(url.protocol, literal, allowed)
    if (problem !== null) return { problem }
  } else if (url.protocol !== 'https:') {
    // Ein Name laesst sich hier nicht gegen die Freigabe halten -- ohne TLS
    // geht er nicht durch.
    return { problem: 'scheme' }
  }
  return { target: { url, literalAddress: literal } }
}
