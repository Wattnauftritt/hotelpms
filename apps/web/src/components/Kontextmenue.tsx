import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'

/**
 * Das eigene Kontextmenue.
 *
 * **Warum es das gibt.** Das Menue des Browsers ist gesperrt (`Shell`), und
 * zwar nicht aus Prinzip: an der Rezeption steht ein Arbeitsprogramm, und
 * "Zurueck", "Neu laden", "Untersuchen" beantworten keine Frage, die hier
 * jemand hat -- zwei davon werfen mitten im Vorgang eine halb ausgefuellte
 * Maske weg. Der rechte Knopf gehoert damit uns, und ein gesperrter Knopf
 * ohne Ersatz waere nur Verlust.
 *
 * **Was hineingehoert.** Was man entscheidet, **waehrend** man auf den Plan
 * sieht, und was heute Navigation kostet. Nicht alles, was es gibt: ein
 * Menue mit zwoelf Eintraegen ist eine Liste, die man liest, statt eine
 * Handlung, die man trifft.
 *
 * **Was fehlt, wird ausgeblendet, nicht ausgegraut.** Ein ausgegrauter
 * Eintrag stellt eine Frage ("warum nicht?"), die das Menue nicht
 * beantworten kann. Was nicht geht, steht nicht da.
 */

export interface MenueEintrag {
  schluessel: string
  text: string
  onClick: () => void
  /** Setzt eine Trennlinie darueber. Fuer alles, was nicht zurueckzunehmen ist. */
  abgesetzt?: boolean
  gefaehrlich?: boolean
}

/** Wo das Menue aufgeht -- die Stelle des Klicks, in Fensterkoordinaten. */
export interface MenuePunkt { x: number; y: number }

export function Kontextmenue({ punkt, eintraege, onClose }: {
  punkt: MenuePunkt
  eintraege: MenueEintrag[]
  onClose: () => void
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(punkt)

  /*
   * Am Rand umklappen, statt aus dem Fenster zu laufen.
   *
   * `useLayoutEffect` und nicht `useEffect`: gemessen wird die tatsaechliche
   * Groesse des Menues, und die steht erst nach dem Einhaengen fest. Mit
   * `useEffect` sieht man das Menue fuer ein Bild an der falschen Stelle und
   * dann springen -- und genau am Rand, wo es ohnehin eng ist.
   */
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      x: punkt.x + width > window.innerWidth ? Math.max(0, punkt.x - width) : punkt.x,
      y: punkt.y + height > window.innerHeight ? Math.max(0, punkt.y - height) : punkt.y
    })
  }, [punkt.x, punkt.y, eintraege.length])

  /*
   * Drei Wege zu, und alle drei sind gewollt: Esc, ein Klick woanders, ein
   * Scrollen des Plans. Das Scrollen deshalb, weil das Menue an
   * Fensterkoordinaten haengt -- bliebe es offen, zeigte es auf eine Zeile,
   * die inzwischen woanders liegt, und der naechste Klick traefe die
   * falsche Buchung.
   */
  useEffect(() => {
    /*
     * **Der eigene Zeigerdruck darf nicht schliessen** -- und genau das
     * hat hier kein einziger Menueeintrag ueberlebt.
     *
     * `capture` laesst den Horcher am Fenster laufen, **bevor** das
     * Ereignis den Eintrag erreicht: das Menue verschwand beim
     * `pointerdown`, und das `click` danach traf nichts mehr. Geklickt,
     * nichts passiert -- bei jedem Eintrag, immer.
     *
     * Ein `stopPropagation` am Menue kann das nicht verhindern: es laeuft
     * in der Blasenphase, also danach. Es sah nur so aus, als taete es
     * etwas, und hat den Fehler dadurch verdeckt.
     *
     * Geprueft wird deshalb hier, ob der Druck **im** Menue liegt. Auf
     * `capture` zu verzichten waere die andere Moeglichkeit und die
     * schlechtere: dann landete der Druck zuerst auf dem Balken darunter
     * und begaenne dort ein Ziehen.
     */
    const zu = (e: Event): void => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      onClose()
    }
    // Beim Scrollen dagegen immer: das Menue haengt an Fensterkoordinaten
    // und zeigte sonst auf eine Zeile, die inzwischen woanders liegt.
    const beimScrollen = (): void => onClose()
    const aufTaste = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', zu, true)
    window.addEventListener('scroll', beimScrollen, true)
    window.addEventListener('keydown', aufTaste)
    return () => {
      window.removeEventListener('pointerdown', zu, true)
      window.removeEventListener('scroll', beimScrollen, true)
      window.removeEventListener('keydown', aufTaste)
    }
  }, [onClose])

  if (eintraege.length === 0) return null

  return (
    <div ref={ref} role="menu"
         style={{ left: pos.x, top: pos.y }}
         /*
          * Hier stand ein `stopPropagation`, das den Schliesser oben
          * abhalten sollte. Es konnte das nie: der Horcht laeuft in der
          * Fangphase am Fenster, dieses Feld in der Blasenphase danach.
          * Weggelassen statt stehengelassen -- abwehrender Code, der
          * nichts abwehrt, verdeckt genau den Fehler, den er zu
          * verhindern scheint.
          */
         className="fixed z-50 min-w-48 py-1 bg-white rounded shadow-xl
                    border border-neutral-200 text-sm">
      {eintraege.map(e => (
        <button key={e.schluessel} type="button" role="menuitem"
                onClick={() => { e.onClick(); onClose() }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-neutral-100
                            ${e.abgesetzt ? 'border-t border-neutral-200 mt-1 pt-2' : ''}
                            ${e.gefaehrlich ? 'text-red-700' : ''}`}>
          {e.text}
        </button>
      ))}
    </div>
  )
}

/** Was unter dem rechten Knopf lag. Der Plan meldet es, der Bildschirm entscheidet. */
export type KontextZiel =
  | { art: 'reservierung'; punkt: MenuePunkt
      reservationRef: string; bookingRef: string; bookingRooms: number
      status: string; resourceId: number | null }
  | { art: 'frei'; punkt: MenuePunkt
      resourceId: number; categoryId: number; roomCode: string
      /** Der Tag unter dem Zeiger. Eine Nacht, nicht der ganze Zeitraum. */
      arrival: string; departure: string }
