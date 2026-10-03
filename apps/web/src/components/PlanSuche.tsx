import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { SearchCustomerHit, SearchReservationHit } from '@hotelpms/contracts'
import { useSuche, SUCHE_MIN_ZEICHEN } from '../lib/queries/suche.js'
import { useHausrechte } from '../lib/rechte.js'
import { useT } from '../lib/i18n/index.js'
import { addDays } from '../lib/dates.js'
import { useEscape } from '../lib/tasten.js'
import { useEntprellt, useSprung, IM_PLAN } from '../lib/suche.js'
import { ReservierungsTreffer, KundenTreffer } from './Suchtreffer.tsx'

/**
 * Die Schnellsuche im Belegungsplan: tippen, waehlen, der Plan springt hin.
 *
 * **Warum im Plan und nicht nur hinter Strg+K.** Am Plan ist die Frage
 * selten "wer ist Herr Petersen", sondern "wo liegt er" -- und die Antwort
 * ist ein Balken, kein Profil. Die Detailsuche oeffnet die Reservierung;
 * diese hier zeigt sie dort, wo man sie anfassen kann: verschieben,
 * verlaengern, ein Zimmer zuweisen.
 *
 * **Waehlen springt, und erst der zweite Schritt oeffnet.** Der Plan
 * blaettert zur Anreise, rollt zur Zimmerzeile (oder ins Band der Buchungen
 * ohne Zimmer) und hebt den Balken kurz hervor; der Fokus steht danach auf
 * ihm. Enter oeffnet ihn wie ein Klick. Ein sofort geoeffnetes
 * Seitenfenster verdeckte genau das Drittel des Plans, in dem man nach dem
 * Sprung nachsehen will, was daneben liegt.
 *
 * Stornierte, abgereiste und No-Show-Aufenthalte haben im Plan keinen
 * Balken (`IM_PLAN`). Sie werden statt eines Sprungs gleich geoeffnet --
 * ein Sprung ins Leere waere eine Suche, die "gefunden" sagt und nichts
 * zeigt.
 *
 * Eine eigene Komponente und nicht Teil von `Tape.tsx`: der Plan ist die
 * meistbearbeitete Datei der Oberflaeche, und was hier steht, braucht von
 * ihm nur den Zeitraum.
 */

/** So viele Treffer je Gruppe passen unter das Feld, ohne den Plan zu verdecken. */
const TREFFER = 6
/** Wie lange der Balken nach dem Sprung leuchtet. Lang genug, um ihn zu finden. */
const LEUCHTEN_MS = 2500
/**
 * Wie lange auf den Balken gewartet wird. Nach einem Sprung in einen anderen
 * Zeitraum laedt der Plan neu; bei langsamer Leitung dauert das.
 */
const WARTEN_MS = 6000
/**
 * Die Hervorhebung als feste Klassen. `!`, weil der Balken selbst einen Ring
 * beim Ueberfahren traegt und sonst die Reihenfolge im Stylesheet entschiede,
 * welcher gewinnt.
 */
const HERVORHEBUNG = ['ring-4!', 'ring-amber-400!', 'ring-offset-2', 'z-30', 'animate-pulse']

type Eintrag =
  | { art: 'reservierung'; hit: SearchReservationHit }
  | { art: 'kunde'; hit: SearchCustomerHit }

export function PlanSuche({ propertyId, von, bis, onVon, onOeffnen }: {
  propertyId: number
  /** Der sichtbare Zeitraum des Plans, `bis` ausschliesslich. */
  von: string; bis: string
  onVon: (von: string) => void
  /** Oeffnet die Reservierung im Seitenfenster des Plans. */
  onOeffnen: (reservationRef: string) => void
}): JSX.Element {
  const t = useT()
  const listId = useId()
  const { darf } = useHausrechte(propertyId)
  const { springen } = useSprung()
  const feld = useRef<HTMLInputElement>(null)
  const [begriff, setBegriff] = useState('')
  const [offen, setOffen] = useState(false)
  const [aktiv, setAktiv] = useState(0)
  /** Wohin zuletzt gesprungen wurde; `nr`, damit derselbe Treffer erneut springt. */
  const [ziel, setZiel] = useState<{ ref: string; nr: number } | null>(null)

  const entprellt = useEntprellt(begriff.trim())
  const q = useSuche(propertyId, entprellt,
                     darf('guest:read') ? 'all' : 'reservation', TREFFER, offen)

  /*
   * Gaeste ja, Firmen nein. Im Plan sucht man Menschen, die ein Zimmer
   * belegen; die Firma dahinter ist eine Frage fuer die Detailsuche.
   */
  const eintraege: Eintrag[] = offen && q.data !== undefined
    ? [...q.data.reservations.map(hit => ({ art: 'reservierung' as const, hit })),
       ...q.data.customers.filter(c => c.kind === 'guest')
         .map(hit => ({ art: 'kunde' as const, hit }))]
    : []
  const zeigen = offen && entprellt.length >= SUCHE_MIN_ZEICHEN

  // Neue Treffer, neue Liste: die Markierung steht wieder oben.
  useEffect(() => { setAktiv(0) }, [entprellt])

  /*
   * Escape leert zuerst das Feld und schliesst die Liste. Angemeldet nur,
   * solange es etwas zu leeren gibt -- sonst schluckte ein leeres Suchfeld
   * das Escape, das dem Seitenfenster oder der Markierung im Plan gilt.
   */
  useEscape(() => {
    setBegriff('')
    setOffen(false)
    feld.current?.blur()
  }, begriff !== '' || offen)

  const oeffnenRef = useRef(onOeffnen)
  oeffnenRef.current = onOeffnen

  /*
   * Nach dem Sprung den Balken suchen, hinrollen, hervorheben, fokussieren.
   *
   * Gesucht wird im Dokument und nicht ueber eine Eigenschaft des Plans:
   * der Balken traegt `data-reservation-ref`, und mehr braucht es nicht.
   * Den Plan dafuer um eine Hervorhebung zu erweitern hiesse, jede
   * gemerkte Zimmerzeile bei jedem Sprung neu zu zeichnen.
   *
   * Gewartet wird Bild fuer Bild, weil der Plan nach einem Zeitraumwechsel
   * erst laedt. Kommt der Balken nicht -- das Zimmer ist inzwischen
   * stillgelegt, die Reservierung gerade storniert --, oeffnet sich das
   * Seitenfenster: wer gewaehlt hat, bekommt die Reservierung so oder so.
   */
  useEffect(() => {
    if (ziel === null) return
    let vorbei = false
    let rahmen = 0
    let leuchten: ReturnType<typeof setTimeout> | undefined
    const beginn = performance.now()
    const suchen = (): void => {
      if (vorbei) return
      const el = document.querySelector<HTMLElement>(
        `[data-reservation-ref="${CSS.escape(ziel.ref)}"]`)
      if (el === null) {
        if (performance.now() - beginn < WARTEN_MS) {
          rahmen = requestAnimationFrame(suchen)
        } else {
          oeffnenRef.current(ziel.ref)
        }
        return
      }
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
      el.focus({ preventScroll: true })
      el.classList.add(...HERVORHEBUNG)
      leuchten = setTimeout(() => { el.classList.remove(...HERVORHEBUNG) }, LEUCHTEN_MS)
      /*
       * Enter auf dem hervorgehobenen Balken oeffnet ihn. Der Balken ist
       * ein Knopf, aber er oeffnet ueber die Zeigergeste (ein Klick ohne
       * Zug) und kennt `click` nicht. `stopPropagation`, weil Enter am
       * Fenster sonst eine Markierung im Plan buchen koennte.
       */
      const aufTaste = (e: KeyboardEvent): void => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        oeffnenRef.current(ziel.ref)
      }
      el.addEventListener('keydown', aufTaste)
      el.addEventListener('blur', () => { el.removeEventListener('keydown', aufTaste) },
                          { once: true })
    }
    rahmen = requestAnimationFrame(suchen)
    return () => {
      vorbei = true
      cancelAnimationFrame(rahmen)
      if (leuchten !== undefined) clearTimeout(leuchten)
    }
  }, [ziel])

  const waehlen = (e: Eintrag): void => {
    setOffen(false)
    if (e.art === 'kunde') {
      springen({ art: 'gast', ref: e.hit.ref })
      return
    }
    const r = e.hit
    if (!IM_PLAN.has(r.status)) {
      onOeffnen(r.reservationRef)
      return
    }
    // Die Anreise soll sichtbar sein, mit zwei Tagen davor als Umfeld --
    // sonst klebt der Balken am linken Rand, und was davor liegt, fehlt.
    if (r.arrival < von || r.arrival >= bis) onVon(addDays(r.arrival, -2))
    setZiel({ ref: r.reservationRef, nr: Date.now() })
  }

  const aufTaste = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOffen(true)
      if (eintraege.length === 0) return
      const schritt = e.key === 'ArrowDown' ? 1 : -1
      setAktiv(a => (a + schritt + eintraege.length) % eintraege.length)
      return
    }
    if (e.key === 'Enter') {
      const eintrag = eintraege[aktiv]
      if (eintrag === undefined) return
      e.preventDefault()
      waehlen(eintrag)
    }
  }

  const optionId = (i: number): string => `${listId}-${i}`

  return (
    <div className="relative">
      <input ref={feld} type="search" value={begriff}
             onChange={e => { setBegriff(e.target.value); setOffen(true) }}
             onFocus={() => setOffen(true)}
             // Ein Klick in die Liste nimmt dem Feld den Fokus; ohne die
             // Verzoegerung schloesse sich die Liste, bevor der Klick ankommt.
             onBlur={() => { setTimeout(() => setOffen(false), 150) }}
             onKeyDown={aufTaste}
             placeholder={t('suche.planPlaceholder')}
             aria-label={t('suche.planPlaceholder')}
             role="combobox" aria-expanded={zeigen} aria-controls={listId}
             aria-autocomplete="list"
             aria-activedescendant={zeigen && eintraege[aktiv] !== undefined
               ? optionId(aktiv) : undefined}
             data-plansuche
             className="w-56 border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      {zeigen && (
        <div className="absolute left-0 top-full mt-1 z-40 w-md max-w-[90vw]
                        bg-white border border-neutral-200 rounded-sm shadow-lg">
          {q.isError && (
            <div className="px-3 py-2 text-xs text-red-800">{t('error.title')}</div>
          )}
          {q.data !== undefined && eintraege.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">{t('suche.noResults')}</div>
          )}
          <ul id={listId} role="listbox" aria-label={t('suche.title')}
              className="max-h-80 overflow-y-auto divide-y divide-neutral-100">
            {eintraege.map((e, i) => (
              <li key={e.art === 'reservierung' ? e.hit.reservationRef : e.hit.ref}
                  id={optionId(i)} role="option" aria-selected={i === aktiv}
                  onMouseDown={ev => ev.preventDefault()}
                  onMouseEnter={() => setAktiv(i)}
                  onClick={() => waehlen(e)}
                  className={`flex px-3 py-1.5 text-sm cursor-pointer
                              ${i === aktiv ? 'bg-neutral-100' : ''}`}>
                {e.art === 'reservierung'
                  ? <ReservierungsTreffer hit={e.hit} knapp />
                  : <KundenTreffer hit={e.hit} />}
              </li>
            ))}
          </ul>
          {q.data !== undefined && (q.data.moreReservations || q.data.moreCustomers) && (
            <div className="px-3 py-1 text-[11px] text-neutral-500 border-t
                            border-neutral-100">
              {t('suche.more')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
