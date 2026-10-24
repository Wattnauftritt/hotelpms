import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { tsImport } from 'tsx/esm/api'

/**
 * Die Sprachpakete: jeder Katalog der Oberflaeche je Sprache als eigene
 * Datei (Dokument 19).
 *
 * **Warum ein Bauschritt und nicht eine andere Bibliothek.** Die Quellen
 * tragen die Sprachen je Schluessel nebeneinander, und
 * `satisfies Record<string, LocalizedText>` macht aus einer vergessenen
 * Sprache einen Typfehler an genau dem Schluessel. Das bleibt so. Nur
 * ausgeliefert wurde es bisher ebenso: jede Seite lud jeden Satz in
 * dreiunddreissig Sprachen, die Anmeldung allein 5,6 MB, davon gut 5 MB
 * Uebersetzungen. Ein Objekt `{ de, en, ... }` kann Rollup nicht nach
 * Eigenschaften zerlegen; die Sprache steht erst zur Laufzeit fest.
 *
 * Deshalb liest dieser Schritt die Kataloge beim Bau aus und legt je
 * Katalog und Sprache ein Modul `virtual:sprachpaket/<katalog>/<sprache>`
 * an: ein flaches `{ schluessel: satz }`. Der Browser holt genau die
 * Sprache, die gerade gilt (`lib/sprachpaket.ts`). Paraglide und
 * Verwandte tun im Kern dasselbe, verlangten aber ein eigenes Quellformat
 * -- und mit ihm ginge die Pruefung am Schluessel verloren.
 *
 * Im Entwicklungsbetrieb und in den Tests laeuft derselbe Schritt, damit
 * dort dieselben Module gelten wie im Betrieb.
 */

type Eintraege = Readonly<Record<string, Readonly<Record<string, string>>>>

interface Katalog {
  /** Die Quelldatei, relativ zu dieser. */
  quelle: string
  /** Aus dem geladenen Modul den Katalog `{ schluessel: { sprache: satz } }`. */
  lesen: (modul: Record<string, unknown>) => Eintraege
}

const KATALOGE: Readonly<Record<string, Katalog>> = {
  // Die Beschriftungen der Rezeption, des Terminals und des Check-ins.
  oberflaeche: { quelle: './i18n/katalog.ts', lesen: m => m.texts as Eintraege },
  // Die Meldungen der Schnittstelle. Sie stehen in `@hotelpms/contracts`,
  // weil die API sie ebenso braucht; dort bleibt der Katalog ganz.
  meldungen: { quelle: '../../../../packages/contracts/src/messages.ts',
               lesen: m => m.MESSAGE_TEXTE as Eintraege },
  // Die Titel der Schnellaktionen am App-Symbol, fuer beide Apps.
  kurzbefehle: { quelle: './i18n/kurzbefehle.ts', lesen: m => m.kurzbefehle as Eintraege },
  personal: { quelle: '../personal/katalog.ts', lesen: m => m.texte as Eintraege },
  mappe: { quelle: '../gast/mappeKatalog.ts', lesen: m => m.texte as Eintraege }
}

/** Die Sprachen, in die ein Katalog geteilt wird: die seines ersten Schluessels. */
function sprachenVon(eintraege: Eintraege): string[] {
  const erster = Object.values(eintraege)[0]
  return erster === undefined ? [] : Object.keys(erster)
}

const PRAEFIX = 'virtual:sprachpaket/'
// `\0` vor dem Namen: so behandelt Rollup ein Modul als erzeugt und sucht
// es nicht auf der Platte.
const AUFGELOEST = '\0sprachpaket/'

export function sprachpakete(): Plugin {
  // Ein ausgelesener Katalog, bis sich eine seiner Dateien aendert.
  const gelesen = new Map<string, Promise<{ eintraege: Eintraege; dateien: string[] }>>()

  const lesen = (name: string): Promise<{ eintraege: Eintraege; dateien: string[] }> => {
    let p = gelesen.get(name)
    if (p === undefined) {
      const k = KATALOGE[name]
      if (k === undefined) throw new Error(`Unbekannter Katalog ${name}`)
      const dateien: string[] = []
      p = tsImport(new URL(k.quelle, import.meta.url).href, {
        parentURL: import.meta.url,
        onImport: url => { if (url.startsWith('file:')) dateien.push(fileURLToPath(url)) }
      }).then((m: Record<string, unknown>) => ({ eintraege: k.lesen(m), dateien }))
      gelesen.set(name, p)
      // Ein Fehler bleibt nicht im Speicher stehen: nach der Korrektur der
      // Quelle soll der naechste Aufruf neu lesen.
      p.catch(() => gelesen.delete(name))
    }
    return p
  }

  return {
    name: 'staygrid-sprachpakete',
    resolveId(id) {
      return id.startsWith(PRAEFIX) ? AUFGELOEST + id.slice(PRAEFIX.length) : null
    },
    async load(id) {
      if (!id.startsWith(AUFGELOEST)) return null
      const [name, sprache] = id.slice(AUFGELOEST.length).split('/')
      const { eintraege, dateien } = await lesen(name!)
      for (const d of dateien) this.addWatchFile(d)
      if (sprache === undefined) {
        // Der Lader: je Sprache ein `import()`, damit Rollup jede zu einer
        // eigenen Datei macht und keine in die andere zieht.
        const zeilen = sprachenVon(eintraege).map(l =>
          `  ${JSON.stringify(l)}: () => import(${JSON.stringify(`${PRAEFIX}${name}/${l}`)})`)
        return `export default {\n${zeilen.join(',\n')}\n}\n`
      }
      const paket: Record<string, string> = {}
      for (const [schluessel, saetze] of Object.entries(eintraege)) {
        const satz = saetze[sprache]
        if (satz === undefined) throw new Error(`${name}: ${schluessel} fehlt in ${sprache}`)
        paket[schluessel] = satz
      }
      // Als JSON-Zeichenkette: `JSON.parse` liest das schneller als der
      // Browser dasselbe als Objektliteral uebersetzt.
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(paket))})\n`
    },
    handleHotUpdate({ file, server }) {
      // Eine geaenderte Quelldatei: Katalog neu lesen und die Seite neu
      // laden. Ein Austausch im laufenden Fenster lohnt hier nicht.
      let betroffen = false
      for (const [name, p] of gelesen) {
        void p.then(({ dateien }) => {
          if (!dateien.includes(file)) return
          gelesen.delete(name)
          for (const m of server.moduleGraph.idToModuleMap.values()) {
            if (m.id?.startsWith(AUFGELOEST + name) === true) server.moduleGraph.invalidateModule(m)
          }
          if (!betroffen) { betroffen = true; server.ws.send({ type: 'full-reload' }) }
        })
      }
    }
  }
}

/** Ob eine Datei des Baus ein Sprachpaket ist (fuer den Service Worker). */
export function istSprachpaket(moduleIds: readonly string[]): boolean {
  return moduleIds.length > 0 && moduleIds.every(m => m.startsWith(AUFGELOEST))
}

/**
 * Der Dateiname eines Pakets: `texte-oberflaeche-de-<hash>.js`. Rollup
 * naehme sonst nur das letzte Stueck, und vier Kataloge hiessen `de`.
 */
export function sprachpaketDatei(moduleIds: readonly string[]): string | null {
  if (!istSprachpaket(moduleIds)) return null
  return `assets/texte-${moduleIds[0]!.slice(AUFGELOEST.length).replace('/', '-')}-[hash].js`
}
