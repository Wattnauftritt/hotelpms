import { createWorker, type Worker } from 'tesseract.js'
// Alles von der eigenen Herkunft, nichts vom CDN: tesseract.js holt seine
// Teile sonst von jsdelivr, und die Content-Security-Policy laesst nur
// 'self' zu. Vite legt die Dateien gehasht unter /assets/ ab, wo der
// Service Worker sie nach dem ersten Scan auch ohne Netz bereithaelt.
import workerUrl from 'tesseract.js/dist/worker.min.js?url'
import kernSimdUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url'
import kernUrl from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url'
import deuUrl from '@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz?url'
import { zeilenAusBoxen } from './visitenkarte.js'
import type { Fortschritt, Leser } from './leser.js'

/**
 * Texterkennung im Browser, fuer die Visitenkarte im Firmenformular.
 *
 * **Warum im Geraet und nicht auf dem Server oder bei einem KI-Dienst.** Auf
 * der Karte steht ein Mensch: Name, Durchwahl, Mobilnummer. Im Geraet
 * gelesen verlaesst das Foto das Telefon nie, es wird nirgends gespeichert,
 * und es braucht keinen Auftragsverarbeiter in einem Drittland (Dokument 26).
 * Ein Sprachmodell laese eine schief fotografierte Karte besser; dafuer
 * ginge jedes Foto an einen Anbieter ausserhalb unserer Server, und das ist
 * eine Entscheidung, keine Voreinstellung. Was die Erkennung hier verfehlt,
 * korrigiert die Rezeption im Vorschlag, bevor etwas gespeichert wird.
 *
 * **Nachgeladen.** Diese Datei wird erst beim ersten Scan geholt
 * (`import()` in `leser.ts`), in der App gar nicht. Erkennung und
 * Sprachdaten sind zusammen rund fuenf Megabyte und gehoeren nicht in den
 * Start der Rezeption.
 *
 * Nur die deutschen Sprachdaten: sie kennen das lateinische Alphabet mit
 * Umlauten und lesen damit auch englische und niederlaendische Karten.
 * Englisch dazu verdreifachte den Download (2,9 MB) fuer wenig mehr. Die
 * "best_int"-Daten sind die kleinen, fuer reine LSTM-Erkennung.
 */

/** Nach dieser Kantenlaenge wird verkleinert: ein 12-MP-Foto braucht sonst das Vierfache an Zeit, ohne mehr zu lesen. */
const MAX_KANTE = 2000

/** Zeilen mit weniger Zuversicht sind meist ein Logo oder Muster, kein Text. */
const MIN_ZUVERSICHT = 45

/**
 * Ob der Browser WebAssembly-SIMD kann. Das winzige Modul ist die Pruefung
 * aus `wasm-feature-detect`: ein `v128`-Befehl, den nur ein SIMD-faehiger
 * Browser als gueltig annimmt. Mit SIMD liest die Erkennung etwa doppelt so
 * schnell.
 */
function kannSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
      65, 0, 253, 15, 253, 98, 11]))
  } catch {
    return false
  }
}

const absolut = (pfad: string): string => new URL(pfad, location.href).href

/**
 * Der Leser im Browser. Er haelt die Erkennung fuer Vorder- und Rueckseite
 * bereit und wird danach beendet; die Rechnerei laeuft in einem eigenen
 * Worker, damit die Seite waehrenddessen bedienbar bleibt. Ausgewaehlt wird
 * er in `leser.ts`, nur wenn das Geraet keine eigene Erkennung anbietet.
 */
export function tesseractLeser(): Leser {
  let melden: (f: Fortschritt) => void = () => {}
  let worker: Promise<Worker> | null = null
  // Nach `beenden` nimmt der Leser nichts mehr an: tesseract.js schickte
  // einen Auftrag an den beendeten Worker und wartete dann ewig.
  let beendet = false

  const holen = (): Promise<Worker> => {
    worker ??= (async () => {
      melden({ schritt: 'laden' })
      // Laesst die Content-Security-Policy kein WebAssembly zu
      // ('wasm-unsafe-eval', ops/caddy/Caddyfile), bliebe die Erkennung
      // still haengen. Ein leeres Modul vorab prueft das und scheitert sofort.
      await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
      return createWorker('deu', 1, {
        workerPath: absolut(workerUrl),
        // Das Verzeichnis, nicht die Datei: tesseract.js haengt
        // `deu.traineddata.gz` selbst an. Deshalb legt `vite.config.ts` die
        // Datei unter ihrem eigenen Namen in ein gehashtes Verzeichnis.
        langPath: absolut(deuUrl.slice(0, deuUrl.lastIndexOf('/'))),
        corePath: absolut(kannSimd() ? kernSimdUrl : kernUrl),
        // Ein Worker aus einer blob:-Adresse waere der CSP fremd.
        workerBlobURL: false,
        // Nicht zusaetzlich in IndexedDB: der Service Worker haelt die Datei schon.
        cacheMethod: 'none',
        logger: m => {
          if (m.status === 'recognizing text') melden({ schritt: 'lesen', anteil: m.progress })
        }
      })
    })()
    // Scheitert das Laden, soll der naechste Versuch neu anfangen.
    worker.catch(() => { worker = null })
    return worker
  }

  return {
    async lesen(bild, fortschritt) {
      if (beendet) throw new Error('Leser beendet')
      melden = fortschritt
      const [w, leinwand] = await Promise.all([holen(), verkleinern(bild)])
      if (beendet) throw new Error('Leser beendet')
      melden({ schritt: 'lesen', anteil: 0 })
      const { data } = await w.recognize(leinwand, {}, { text: true, blocks: true })
      const roh = (data.blocks ?? [])
        .flatMap(b => b.paragraphs.flatMap(p => p.lines))
        .filter(l => l.confidence >= MIN_ZUVERSICHT && l.text.trim() !== '')
      const zeilen = zeilenAusBoxen(roh.map(l => ({
        text: l.text, oben: l.bbox.y0, unten: l.bbox.y1, links: l.bbox.x0
      })), { sortieren: false })
      return { zeilen, text: zeilen.map(z => z.text).join('\n') }
    },
    async beenden() {
      beendet = true
      const w = worker
      worker = null
      if (w !== null) await (await w.catch(() => null))?.terminate()
    }
  }
}

/**
 * Das Foto auf hoechstens `MAX_KANTE` verkleinern. `createImageBitmap` dreht
 * es dabei nach seiner EXIF-Ausrichtung; ein hochkant gehaltenes Telefon
 * liefert sonst eine liegende Karte, und die liest keine Erkennung.
 */
async function verkleinern(bild: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(bild, { imageOrientation: 'from-image' })
  try {
    const faktor = Math.min(1, MAX_KANTE / Math.max(bitmap.width, bitmap.height))
    const leinwand = document.createElement('canvas')
    leinwand.width = Math.round(bitmap.width * faktor)
    leinwand.height = Math.round(bitmap.height * faktor)
    leinwand.getContext('2d')!.drawImage(bitmap, 0, 0, leinwand.width, leinwand.height)
    return leinwand
  } finally {
    bitmap.close()
  }
}
