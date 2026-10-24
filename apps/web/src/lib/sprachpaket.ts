import { useEffect, useRef, useState } from 'react'

/**
 * Die Sprachpakete zur Laufzeit: eine Sprache je Katalog, geholt, wenn sie
 * gebraucht wird (Bauschritt in `sprachpaketBau.ts`).
 *
 * **Was geladen wird.** Ohne Wahl Deutsch, mit Wahl -- am Benutzer, am
 * Telefon, im Browser -- genau diese eine. Eine andere kommt erst dazu,
 * wenn jemand umstellt (Sven, 24.10.2026). Bis sie da ist, bleibt die
 * bisherige stehen; ein Bildschirm, der waehrend des Umstellens leer wird,
 * sieht aus wie ein Absturz.
 *
 * Geladene Pakete bleiben im Speicher. Ein Paket ist ein flaches
 * `{ schluessel: satz }` und unveraenderlich, und wer zwischen zwei
 * Sprachen hin- und herschaltet, soll nicht jedes Mal warten.
 */
export type Paket = Readonly<Record<string, string>>
type Lader = () => Promise<{ default: Paket }>

export class Sprachpakete<L extends string> {
  private readonly geladen = new Map<L, Paket>()
  private readonly laufend = new Map<L, Promise<Paket>>()

  /**
   * Die Lader kommen aus dem Bau, je Sprache des Katalogs einer. Als
   * `Record<string, ...>`, weil das erzeugte Modul seine Sprachen erst beim
   * Bau kennt; dass jede da ist, prueft der Typ in der Quelle des Katalogs.
   */
  constructor(private readonly lader: Readonly<Record<string, Lader>>) {}

  /** Das Paket einer Sprache, wenn es schon da ist. */
  paket(locale: L): Paket | undefined {
    return this.geladen.get(locale)
  }

  laden(locale: L): Promise<Paket> {
    const da = this.geladen.get(locale)
    if (da !== undefined) return Promise.resolve(da)
    let p = this.laufend.get(locale)
    if (p === undefined) {
      const holen = this.lader[locale]
      if (holen === undefined) return Promise.reject(new Error(`Kein Sprachpaket ${locale}`))
      p = holen().then(m => {
        this.geladen.set(locale, m.default)
        return m.default
      }).finally(() => this.laufend.delete(locale))
      this.laufend.set(locale, p)
    }
    return p
  }
}

/** Werte in einen Satz einsetzen: `{name}`. Ein Platzhalter ohne Wert bleibt stehen. */
export function einsetzen(text: string, params?: Record<string, string | number>): string {
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ganz)
}

/**
 * Die Sprache, in der gerade gezeichnet werden kann: die gewuenschte, sobald
 * alle Pakete fuer sie da sind, bis dahin die zuletzt geladene. `null` nur,
 * solange noch gar keine da ist -- beim allerersten Aufbau.
 *
 * Laesst sich das Paket nicht holen (kein Netz, und der Service Worker hat
 * es noch nicht), bleibt die bisherige Sprache stehen; beim ersten Aufbau
 * versucht es Deutsch, falls nur die gewuenschte Sprache fehlt.
 */
export function useSprachpakete<L extends string>(
  pakete: ReadonlyArray<Sprachpakete<L>>, gewuenscht: L, rueckfall: L
): L | null {
  const da = (l: L): boolean => pakete.every(p => p.paket(l) !== undefined)
  const [aktiv, setAktiv] = useState<L | null>(() => da(gewuenscht) ? gewuenscht : null)
  const bisher = useRef(aktiv)
  bisher.current = aktiv
  useEffect(() => {
    if (da(gewuenscht)) { setAktiv(gewuenscht); return }
    let gilt = true
    const holen = (l: L): Promise<void> =>
      Promise.all(pakete.map(p => p.laden(l))).then(() => { if (gilt) setAktiv(l) })
    holen(gewuenscht).catch(() => {
      if (gilt && bisher.current === null && gewuenscht !== rueckfall) {
        // Ohne Netz und ohne Huelle gibt es dann nichts zu zeigen.
        holen(rueckfall).catch(() => undefined)
      }
    })
    return () => { gilt = false }
    // `pakete` und `rueckfall` sind je Aufrufer fest.
  }, [gewuenscht])
  return aktiv
}
