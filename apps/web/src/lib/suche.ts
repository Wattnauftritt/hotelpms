import { createContext, useContext, useEffect, useState } from 'react'
import type { SearchReservationHit } from '@hotelpms/contracts'
import type { TextKey } from './i18n/index.js'
import { istTextEingabe } from './tasten.js'

/**
 * Was die Suche ueber Bildschirmgrenzen hinweg braucht: die Tasten, die
 * Marken und den Weg von einem Treffer zu dem Bildschirm, der ihn zeigt.
 */

/**
 * Wartet, bis eine Weile nichts mehr getippt wurde.
 *
 * Ohne das ginge bei "Petersen" fuer jeden der acht Buchstaben eine Anfrage
 * hinaus, und sieben Antworten waeren schon beim Eintreffen veraltet. 200 ms
 * liegen unter dem, was ein Mensch als Warten bemerkt, und ueber dem Abstand
 * zwischen zwei Anschlaegen beim fluessigen Tippen.
 */
export function useEntprellt<T>(wert: T, ms = 200): T {
  const [stand, setStand] = useState(wert)
  useEffect(() => {
    const t = setTimeout(() => setStand(wert), ms)
    return () => { clearTimeout(t) }
  }, [wert, ms])
  return stand
}

/**
 * Was der Belegungsplan zeigt. Dieselbe Liste wie in der Abfrage des Plans
 * (`routes/availability.ts`): ein abgereister oder stornierter Aufenthalt
 * hat dort keinen Balken, zu dem man springen koennte -- er wird statt
 * dessen im Seitenfenster geoeffnet.
 */
export const IM_PLAN: ReadonlySet<string> = new Set(['Optional', 'Confirmed', 'InHouse'])

export type Marke = 'inquired' | 'optional' | 'confirmed' | 'inHouse' | 'checkedOut'
  | 'past' | 'canceled' | 'noShow'

/**
 * Die Marke an einer Trefferzeile.
 *
 * **"Vergangenheit" ist kein Zustand, sondern ein Befund.** Eine
 * Reservierung, die noch "bestaetigt" heisst, deren Abreise aber hinter dem
 * Geschaeftstag liegt, ist nie angereist und nie als No-Show verbucht
 * worden. "Bestaetigt" daran waere die Wahrheit der Datenbank und eine
 * Irrefuehrung am Tresen.
 */
export function marke(r: Pick<SearchReservationHit, 'status' | 'past'>): Marke {
  switch (r.status) {
    case 'InHouse': return 'inHouse'
    case 'CheckedOut': return 'checkedOut'
    case 'Canceled': return 'canceled'
    case 'NoShow': return 'noShow'
    default:
      if (r.past) return 'past'
      return r.status === 'Optional' ? 'optional'
        : r.status === 'Inquired' ? 'inquired' : 'confirmed'
  }
}

/** Beschriftung und Farbe je Marke. Die Farben sind die des Plans. */
export const MARKEN: Record<Marke, { text: TextKey; farbe: string }> = {
  inquired: { text: 'suche.mark.inquired', farbe: 'bg-neutral-100 text-neutral-700' },
  optional: { text: 'suche.mark.optional', farbe: 'bg-violet-100 text-violet-900' },
  confirmed: { text: 'suche.mark.confirmed', farbe: 'bg-blue-100 text-blue-900' },
  inHouse: { text: 'suche.mark.inHouse', farbe: 'bg-emerald-100 text-emerald-900' },
  checkedOut: { text: 'suche.mark.checkedOut', farbe: 'bg-neutral-100 text-neutral-600' },
  past: { text: 'suche.mark.past', farbe: 'bg-neutral-100 text-neutral-600' },
  canceled: { text: 'suche.mark.canceled', farbe: 'bg-red-50 text-red-800 line-through' },
  noShow: { text: 'suche.mark.noShow', farbe: 'bg-red-100 text-red-900' }
}

/** Der Rechner ist ein Mac -- dort heisst die Taste Cmd, nicht Strg. */
export function istMac(): boolean {
  return typeof navigator !== 'undefined'
    && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/**
 * Oeffnet dieser Druck die Detailsuche?
 *
 * **Auch aus einem Textfeld heraus.** Die Suche ist der Weg aus jeder Lage
 * zu jedem Gast, und die Lage ist an der Rezeption fast immer ein Feld, in
 * dem gerade jemand tippt -- die Gastsuche, eine Notiz, das Suchfeld im
 * Plan. Muesste man erst hinausklicken, waere das Kuerzel dort tot, wo man
 * es braucht. Strg+K hat in einem Textfeld unter Windows und Linux keine
 * Bedeutung; ohne `preventDefault` sprang der Browser in seine eigene
 * Adressleiste.
 *
 * **Ausser Strg+K auf dem Mac.** Dort ist Strg+K in jedem Textfeld
 * "loeschen bis zum Zeilenende" (die Emacs-Belegung von macOS), und wer
 * sie benutzt, benutzt sie blind. Die Suche liegt auf dem Mac auf Cmd+K;
 * Strg+K bleibt dem Feld.
 *
 * Mit Umschalt oder Alt ist es nicht dieselbe Taste: Strg+Umschalt+K ist in
 * Firefox die Konsole, und wer die will, soll sie bekommen.
 */
export function istDetailsucheTaste(e: KeyboardEvent, mac = istMac()): boolean {
  if (e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return false
  if (mac) {
    if (e.metaKey) return true
    return e.ctrlKey && !istTextEingabe(e.target)
  }
  return e.ctrlKey && !e.metaKey
}

export type Befehl = 'neueReservierung' | 'neuerGast' | 'neueFirma'

/**
 * Die Befehle der Detailsuche mit ihren Kuerzeln.
 *
 * **`code` und nicht `key`.** Auf dem Mac schreibt Alt+N eine Tilde und
 * Alt+C ein "ç" -- `key` ist dort das Zeichen, nicht der Buchstabe.
 * `code` ist die Taste, unabhaengig von Belegung und Zusatztaste.
 *
 * Das Recht steht am Befehl aus demselben Grund wie am Bildschirm: ein
 * Befehl, der mit 403 endet, ist schlechter als keiner.
 */
export const BEFEHLE: ReadonlyArray<{
  befehl: Befehl; code: string; taste: string; text: TextKey; recht: string
}> = [
  { befehl: 'neueReservierung', code: 'KeyN', taste: 'N',
    text: 'suche.command.newReservation', recht: 'reservation:write' },
  { befehl: 'neuerGast', code: 'KeyG', taste: 'G',
    text: 'suche.command.newGuest', recht: 'guest:write' },
  { befehl: 'neueFirma', code: 'KeyC', taste: 'C',
    text: 'suche.command.newCompany', recht: 'guest:write' }
]

/**
 * Welcher Befehl liegt auf diesem Druck? Nur Alt allein: Strg+Alt ist auf
 * einer deutschen Tastatur AltGr, und AltGr+Q ist das @ in einer
 * Mailadresse.
 */
export function befehlZurTaste(e: KeyboardEvent): Befehl | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  return BEFEHLE.find(b => b.code === e.code)?.befehl ?? null
}

/**
 * Wohin ein Treffer oder Befehl fuehrt.
 *
 * Die Suche weiss, **was** gewaehlt wurde; **wie** es gezeigt wird, weiss
 * der Rahmen in `main.tsx`: er haelt das Seitenfenster der Reservierung, den
 * Bildschirm in der Adresse und das Folio. Ein Kontext statt eines
 * weiteren Feldes in `ScreenContext`, weil ihn auch die Kopfleiste braucht,
 * die gar kein Bildschirm ist.
 */
export type Sprungziel =
  | { art: 'reservierung'; ref: string }
  | { art: 'gast'; ref: string }
  | { art: 'firma'; ref: string }
  | { art: 'befehl'; befehl: Befehl }

export interface Sprung {
  springen: (ziel: Sprungziel) => void
  /**
   * Der letzte Sprung, den ein Bildschirm beim Aufbau abholen soll -- die
   * Gaesteliste etwa, welches Profil sie oeffnet. Null heisst: keiner.
   */
  auftrag: Sprungziel | null
}

export const SprungContext = createContext<Sprung>({
  springen: () => { /* ohne Rahmen: nichts zu tun */ },
  auftrag: null
})

export function useSprung(): Sprung {
  return useContext(SprungContext)
}
