import { describe, it, expect } from 'vitest'
import { imageDimensions, imageWithinLimits } from '../imageSize.js'

/**
 * Masse aus dem Bildkopf (Audit 19.10.2026, M6). Gelesen wird nur der
 * Kopf; ein Fehler hier laesst entweder ein Riesenbild durch oder weist ein
 * gewoehnliches Logo ab.
 */

function pngKopf(w: number, h: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

function jpegKopf(w: number, h: number): Buffer {
  // SOI, ein APP0 davor (wie in jeder echten Datei), dann SOF2 (progressiv).
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3,
                           1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xff]), sof])
}

function webpKopf(art: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Buffer {
  const b = Buffer.alloc(32)
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write(art, 12, 'latin1')
  if (art === 'VP8 ') {
    b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28)
  } else if (art === 'VP8L') {
    b[20] = 0x2f
    b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21)
  } else {
    b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3)
  }
  return b
}

describe('Bildmasse aus dem Kopf', () => {
  it('liest PNG, JPEG und alle drei WebP-Arten', () => {
    expect(imageDimensions(pngKopf(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageDimensions(jpegKopf(1200, 800))).toEqual({ width: 1200, height: 800 })
    expect(imageDimensions(webpKopf('VP8 ', 300, 200))).toEqual({ width: 300, height: 200 })
    expect(imageDimensions(webpKopf('VP8L', 1024, 768))).toEqual({ width: 1024, height: 768 })
    expect(imageDimensions(webpKopf('VP8X', 16000, 9))).toEqual({ width: 16000, height: 9 })
  })

  it('haelt Riesenbilder auf, gleich in welchem Format', () => {
    expect(imageWithinLimits(pngKopf(4000, 4000))).toBe(true)
    expect(imageWithinLimits(pngKopf(12000, 12000))).toBe(false)
    expect(imageWithinLimits(pngKopf(4001, 10))).toBe(false)
    expect(imageWithinLimits(jpegKopf(60000, 60000))).toBe(false)
    expect(imageWithinLimits(webpKopf('VP8X', 16000, 16000))).toBe(false)
    // Mehr als 2^31 darf nicht als negative Zahl durchrutschen.
    expect(imageWithinLimits(pngKopf(0x80000000, 1))).toBe(false)
  })

  it('weist einen Kopf ab, der sich nicht lesen laesst', () => {
    expect(imageDimensions(pngKopf(10, 10).subarray(0, 20))).toBeNull()
    expect(imageWithinLimits(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))).toBe(false)
    // JPEG, das vor jedem SOF schon Bilddaten beginnt.
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull()
    expect(imageDimensions(Buffer.from('kein Bild'))).toBeNull()
    expect(imageWithinLimits(pngKopf(0, 10))).toBe(false)
  })
})
