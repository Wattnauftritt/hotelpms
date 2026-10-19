/**
 * Bildmasse aus dem Dateikopf (Audit 19.10.2026, M6).
 *
 * **Warum die Masse und nicht nur die Groesse zaehlen.** Ein PNG aus einer
 * einzigen Farbe komprimiert auf wenige hundert Kilobyte, auch wenn es
 * 12 000 x 12 000 Bildpunkte misst. Wer es dekodiert, braucht dafuer aber
 * Breite x Hoehe x 4 Bytes -- ueber ein halbes Gigabyte -- und `embedPng`
 * tut das synchron, also mit stehender Ereignisschleife fuer jeden Kunden
 * im selben Prozess. Die Obergrenze von einem Megabyte haelt das nicht auf.
 *
 * Gelesen wird nur der Kopf, nichts dekodiert, und ohne neue Abhaengigkeit:
 * die drei Formate legen ihre Masse an festen oder leicht auffindbaren
 * Stellen ab. Laesst sich der Kopf nicht lesen, gibt es `null` -- der
 * Aufrufer weist das ab, denn ein Bild, dessen Masse wir nicht kennen,
 * koennte jedes Mass haben.
 */

/** Laengste Seite in Bildpunkten. Ein Logo oder eine Terminalseite braucht
 *  keine 4000; 4000 x 4000 x 4 sind 64 MB beim Dekodieren, das ist tragbar. */
export const IMAGE_MAX_SIDE = 4000

export interface ImageDimensions { width: number; height: number }

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const u32be = (b: Uint8Array, i: number): number =>
  ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const ascii = (b: Uint8Array, i: number, n: number): string =>
  String.fromCharCode(...b.subarray(i, i + n))

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function png(b: Uint8Array): ImageDimensions | null {
  // Der erste Block steht nach der Spezifikation fest: IHDR, Breite und
  // Hoehe als 32-Bit-Zahlen gleich danach.
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

function jpeg(b: Uint8Array): ImageDimensions | null {
  // Die Masse stehen im ersten SOFn-Segment; davor koennen beliebig viele
  // Segmente (EXIF, ICC) liegen, also von Segment zu Segment springen.
  let i = 2
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]!
    // Fuellbytes und Marker ohne Laenge ueberspringen.
    if (m === 0xff) { i += 1; continue }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue }
    if (m === 0xd9 || m === 0xda) return null // Bildende oder Bilddaten vor einem SOF
    if (i + 3 >= b.length) return null
    const len = u16be(b, i + 2)
    if (len < 2) return null
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
    if (sof) {
      if (i + 8 >= b.length) return null
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    i += 2 + len
  }
  return null
}

function webp(b: Uint8Array): ImageDimensions | null {
  if (b.length < 30) return null
  const art = ascii(b, 12, 4)
  if (art === 'VP8 ') {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (art === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (art === 'VP8X') {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  }
  return null
}

/** Masse eines PNG, JPEG oder WebP aus dem Kopf; `null`, wenn er sich nicht lesen laesst. */
export function imageDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length >= 8 && PNG_SIG.every((x, i) => b[i] === x)) return png(b)
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b)
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b)
  return null
}

/** Ob das Bild gefahrlos dekodiert werden kann: Kopf lesbar, keine Seite ueber der Grenze. */
export function imageWithinLimits(b: Uint8Array): boolean {
  const d = imageDimensions(b)
  return d !== null && d.width > 0 && d.height > 0
    && d.width <= IMAGE_MAX_SIDE && d.height <= IMAGE_MAX_SIDE
}
