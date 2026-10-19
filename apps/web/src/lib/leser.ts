import { zeilenAusBoxen, type ErkannteZeile, type KartenZeile } from './visitenkarte.js'

/**
 * Wer die Visitenkarte liest: das Telefon selbst oder der Browser.
 *
 * **Vorbereitet fuer die eigene App** (Sven, 19.10.2026). iOS (Vision) und
 * Android (ML Kit) lesen Fotos deutlich besser als Tesseract, eine
 * Webseite kommt an beide aber nicht heran. Laeuft StayGrid in der App,
 * stellt die App ihre Erkennung unter `window.staygridNative.texterkennung`
 * bereit, und der Scan nimmt sie; im Browser fehlt das Objekt, und es bleibt
 * bei Tesseract (`texterkennung.ts`). Solange keine App es setzt, aendert
 * diese Datei am Verhalten nichts.
 *
 * **Was die App zusagt.** Gelesen wird im Geraet, nicht bei einem Dienst:
 * der Scan sagt dem Benutzer, dass das Foto das Telefon nicht verlaesst,
 * und eine Bruecke, die das Bild hochlaedt, machte den Satz falsch. Bei
 * ML Kit heisst das die gebuendelte Texterkennung, nicht die Cloud-API.
 * Geliefert werden nur Zeilen mit Lage; was davon Firma und Anschrift ist,
 * entscheidet weiter `visitenkarte.ts`, damit Browser und App dasselbe
 * vorschlagen und eine Regel an einer Stelle steht.
 */
export interface NativeTexterkennung {
  /**
   * Das Foto lesen. Die Lage in einer beliebigen, aber fuer alle Zeilen
   * gleichen Einheit, `oben` nach unten wachsend (Vision rechnet von unten:
   * die App dreht das um). Die Reihenfolge ist egal, sortiert wird hier.
   */
  erkennen(bild: Blob): Promise<{ zeilen: ErkannteZeile[] }>
}

declare global {
  interface Window {
    /** Gesetzt von der StayGrid-App, im Browser nie. */
    staygridNative?: { texterkennung?: NativeTexterkennung }
  }
}

export type Fortschritt = { schritt: 'laden' } | { schritt: 'lesen'; anteil: number }

export interface Leser {
  lesen(bild: Blob, fortschritt: (f: Fortschritt) => void): Promise<{
    zeilen: KartenZeile[]
    text: string
  }>
  beenden(): Promise<void>
}

function nativeErkennung(): NativeTexterkennung | undefined {
  return typeof window === 'undefined' ? undefined : window.staygridNative?.texterkennung
}

export function nativerLeser(erkennung: NativeTexterkennung): Leser {
  let beendet = false
  return {
    async lesen(bild, fortschritt) {
      if (beendet) throw new Error('Leser beendet')
      fortschritt({ schritt: 'lesen', anteil: 0 })
      const { zeilen: roh } = await erkennung.erkennen(bild)
      const zeilen = zeilenAusBoxen(roh, { sortieren: true })
      return { zeilen, text: zeilen.map(z => z.text).join('\n') }
    },
    async beenden() {
      beendet = true
    }
  }
}

/**
 * Den passenden Leser anlegen. Tesseract wird nur im Browser nachgeladen;
 * in der App kommen seine fuenf Megabyte gar nicht erst aufs Telefon.
 */
export async function leserAnlegen(): Promise<Leser> {
  const nativ = nativeErkennung()
  if (nativ !== undefined) return nativerLeser(nativ)
  const { tesseractLeser } = await import('./texterkennung.js')
  return tesseractLeser()
}
