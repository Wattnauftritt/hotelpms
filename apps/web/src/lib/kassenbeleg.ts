import type { NeuerBeleg } from './queries/kassenbuch.js'

/**
 * Belege fuers Kassenbuch vorbereiten, bevor sie hochgehen.
 *
 * **Fotos werden verkleinert.** Ein Handyfoto hat vier bis zwoelf Megabyte
 * und zwoelf Megapixel; ein Kassenbon ist auch mit 1600 Pixeln an der
 * langen Kante lesbar und dann einige hundert Kilobyte gross. Das
 * Adminpanel tut dasselbe (1400 px, JPEG 0,78); hier etwas groesser, weil
 * auch eine Rechnung im A4-Format noch lesbar bleiben soll.
 *
 * **Ein PDF geht unveraendert.** Es ist oft das Original vom Lieferanten,
 * und ein umgerechnetes waere nicht mehr der Beleg.
 *
 * Die Kamera ist das Dateifeld mit `capture`: das Telefon oeffnet die
 * Rueckkamera, der Rechner die Dateiauswahl. Ein eigener Kamerabildschirm
 * wie im Adminpanel waere mehr Code fuer dasselbe Ergebnis, und das
 * Telefon wandelt HEIC dabei selbst in JPEG.
 */

export const BELEG_KANTE = 1600
export const BELEG_QUALITAET = 0.8
/** Wie in `platform/kassenbuch.ts`. */
export const BELEG_MAX_BYTES = 10 * 1024 * 1024

/** Zielmass bei gleichem Seitenverhaeltnis; ein kleines Bild bleibt, wie es ist. */
export function zielmass(breite: number, hoehe: number, kante = BELEG_KANTE
): { breite: number; hoehe: number } {
  const lang = Math.max(breite, hoehe)
  if (lang <= kante) return { breite, hoehe }
  const f = kante / lang
  return { breite: Math.round(breite * f), hoehe: Math.round(hoehe * f) }
}

function alsDatenadresse(datei: Blob): Promise<string> {
  return new Promise((ok, fehler) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fehler(r.error)
    r.readAsDataURL(datei)
  })
}

export class BelegZuGross extends Error {}
export class BelegArtFalsch extends Error {}

export async function belegVorbereiten(datei: File): Promise<NeuerBeleg> {
  if (datei.type === 'application/pdf') {
    if (datei.size > BELEG_MAX_BYTES) throw new BelegZuGross()
    return { data: await alsDatenadresse(datei), name: datei.name }
  }
  if (!datei.type.startsWith('image/')) throw new BelegArtFalsch()
  const bild = await createImageBitmap(datei)
  const { breite, hoehe } = zielmass(bild.width, bild.height)
  const leinwand = document.createElement('canvas')
  leinwand.width = breite
  leinwand.height = hoehe
  leinwand.getContext('2d')!.drawImage(bild, 0, 0, breite, hoehe)
  bild.close()
  const name = datei.name.replace(/\.[^.]*$/, '') + '.jpg'
  return { data: leinwand.toDataURL('image/jpeg', BELEG_QUALITAET), name }
}
