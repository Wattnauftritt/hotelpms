import { useEffect, useState } from 'react'

/**
 * Ein QR-Code als SVG-Pfad.
 *
 * Als Pfad und nicht als HTML-Zeichenkette: die Content-Security-Policy
 * erlaubt kein eingeschleustes Markup, und ein Pfad aus Rechtecken braucht
 * keins. Der Erzeuger kommt erst, wenn ein Code gebraucht wird -- er stand
 * frueher im ersten Laden jeder Rezeption (Performance-Audit 11.10.2026,
 * Befund 10).
 *
 * Gebraucht beim Einladen von Personal (`ZugangsLink`) und auf den
 * Zimmerkarten der Gaestemappe (WLAN und Adresse der Mappe).
 */
export interface QrBild { text: string; pfad: string; groesse: number }

export async function qrBild(text: string): Promise<QrBild> {
  const { default: qrcode } = await import('qrcode-generator')
  // UTF-8 statt der Vorgabe des Erzeugers (ein Byte je Zeichen): ein
  // Netzname "Gästehaus" ergaebe sonst einen Code, den das Telefon als
  // anderes Netz liest.
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']!
  // Fehlerkorrektur M: ein Handybildschirm spiegelt, ein Ausdruck knickt.
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`
    }
  }
  // Vier Module Ruhezone ringsum, sonst lesen manche Kameras nicht.
  return { text, pfad: d, groesse: n + 8 }
}

/**
 * Der Code zu einem Text, als Hook. Bis er da ist, ein leeres Feld in
 * Normgroesse; nie der Code eines vorigen Textes zu einem neuen.
 */
export function useQr(text: string): { pfad: string; groesse: number } {
  const [bild, setBild] = useState<QrBild | null>(null)
  useEffect(() => {
    let aktuell = true
    void qrBild(text).then(b => { if (aktuell) setBild(b) })
    return () => { aktuell = false }
  }, [text])
  return bild !== null && bild.text === text ? bild : { pfad: '', groesse: 33 }
}
