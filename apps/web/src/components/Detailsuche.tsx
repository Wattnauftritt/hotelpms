import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { SearchCustomerHit, SearchReservationHit, SearchScope }
  from '@hotelpms/contracts'
import { useSuche, SUCHE_MIN_ZEICHEN } from '../lib/queries/suche.js'
import { useHausrechte } from '../lib/rechte.js'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { istTextEingabe, useEscape } from '../lib/tasten.js'
import { useEntprellt, useSprung, istDetailsucheTaste, befehlZurTaste, istMac, BEFEHLE,
         type Befehl, type Sprungziel } from '../lib/suche.js'
import { ReservierungsTreffer, KundenTreffer } from './Suchtreffer.tsx'

/**
 * Die Detailsuche: Strg+K von ueberall, ein Feld, drei Gruppen.
 *
 * Gebaut nach der Suche in Mews, auf ausdruecklichen Wunsch aus dem Betrieb
 * ("das STRG+K dann gern als Detailsuche"): ein Fenster ueber allem, oben das
 * Feld, darunter Filter und Treffer, unten die Tasten. Sie sitzt in der
 * `Shell` und nicht in einem Bildschirm, weil die Frage "wo ist Frau X"
 * nicht davon abhaengt, wo man gerade steht.
 *
 * **Die Hand bleibt auf der Tastatur.** Pfeile waehlen, Enter oeffnet,
 * Escape schliesst, Tab wechselt den Filter. Tab und nicht ein eigener
 * Knopf: im Fenster gibt es nur das Feld, und ein Tab, der den Fokus aus
 * dem Fenster heraus auf die Seite dahinter schoebe, waere ein Ausgang, den
 * niemand meint.
 *
 * **Was eine Auswahl tut**, entscheidet der Rahmen (`useSprung`): eine
 * Reservierung oeffnet ihr Seitenfenster ueber dem aktuellen Bildschirm,
 * ein Gast oder eine Firma das Profil, ein Befehl die vorhandene Maske.
 * Neue Masken gibt es dafuer nicht.
 */

type Eintrag =
  | { art: 'reservierung'; hit: SearchReservationHit }
  | { art: 'kunde'; hit: SearchCustomerHit }
  | { art: 'befehl'; befehl: Befehl; text: TextKey; taste: string }

const FILTER: ReadonlyArray<{ scope: SearchScope; text: TextKey }> = [
  { scope: 'all', text: 'suche.filter.all' },
  { scope: 'reservation', text: 'suche.filter.reservation' },
  { scope: 'customer', text: 'suche.filter.customer' }
]

/** Treffer je Gruppe. Mehr passt nicht ohne Rollen, und wer mehr braucht, tippt weiter. */
const TREFFER = 8

/**
 * Der Einstieg in der Kopfleiste: ein Knopf, der das Kuerzel nennt, und das
 * Horchen auf Strg+K und die Alt-Befehle.
 *
 * Der Knopf ist nicht Zierde. Ein Kuerzel, das nirgends steht, kennt nur,
 * wer es erklaert bekommen hat -- und an der Rezeption arbeitet jede Saison
 * jemand Neues.
 */
export function Detailsuche({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const [offen, setOffen] = useState(false)
  const { darf } = useHausrechte(propertyId)
  const { springen } = useSprung()
  const feldRef = useRef<HTMLInputElement | null>(null)

  /*
   * Die Suche lebt am Belegungsplan und verlangt dasselbe Recht wie er. Wer
   * es nicht hat -- Housekeeping --, bekaeme auf jeden Tastendruck 403 und
   * sieht deshalb weder Knopf noch Fenster.
   */
  const sichtbar = darf('reservation:read')
  const erlaubt = (befehl: Befehl): boolean =>
    darf(BEFEHLE.find(b => b.befehl === befehl)!.recht)
  const erlaubtRef = useRef(erlaubt)
  erlaubtRef.current = erlaubt
  const springenRef = useRef(springen)
  springenRef.current = springen

  useEffect(() => {
    if (!sichtbar) return
    const aufTaste = (e: KeyboardEvent): void => {
      if (istDetailsucheTaste(e)) {
        /*
         * Offen: zurueck ins Feld und den Begriff markieren, damit der
         * naechste Anschlag eine neue Suche beginnt -- wie in der
         * Adressleiste des Browsers.
         */
        if (offen) {
          e.preventDefault()
          feldRef.current?.focus()
          feldRef.current?.select()
          return
        }
        /*
         * Nicht ueber einer Maske. Dort steht eine halb ausgefuellte
         * Buchung, und die Suche fuehrt von ihr weg -- auf einen anderen
         * Bildschirm oder in ein Seitenfenster dahinter. Die Taste geht dann
         * an den Browser wie sonst auch.
         */
        if (document.querySelector('[role="dialog"]') !== null) return
        e.preventDefault()
        setOffen(true)
        return
      }
      /*
       * Die Alt-Befehle nicht im Textfeld: auf dem Mac schreibt Alt+N dort
       * eine Tilde und Alt+C ein "ç". Im Feld der Detailsuche selbst gelten
       * sie trotzdem -- dort faengt sie das Fenster ab.
       */
      const befehl = befehlZurTaste(e)
      if (befehl === null || offen) return
      if (istTextEingabe(e.target)) return
      if (document.querySelector('[role="dialog"]') !== null) return
      if (!erlaubtRef.current(befehl)) return
      e.preventDefault()
      springenRef.current({ art: 'befehl', befehl })
    }
    window.addEventListener('keydown', aufTaste)
    return () => { window.removeEventListener('keydown', aufTaste) }
  }, [offen, sichtbar])

  if (!sichtbar) return <></>
  return (
    <>
      <button type="button" onClick={() => setOffen(true)}
              aria-label={t('suche.button')} title={t('suche.button')}
              className="flex items-center gap-1.5 text-sm px-2 py-1 border border-neutral-300
                         rounded-sm text-neutral-500 hover:bg-neutral-50 shrink-0">
        <span aria-hidden>⌕</span>
        <kbd className="text-[10px] px-1 rounded-sm border border-neutral-300 bg-neutral-50
                        font-sans">
          {istMac() ? '⌘K' : t('suche.shortcut')}
        </kbd>
      </button>
      {offen && createPortal(
        <Fenster propertyId={propertyId} feldRef={feldRef} erlaubt={erlaubt}
                 darfKunden={darf('guest:read')}
                 onClose={() => setOffen(false)}
                 onWahl={ziel => { setOffen(false); springen(ziel) }} />,
        document.body)}
    </>
  )
}

function Fenster({ propertyId, feldRef, erlaubt, darfKunden, onClose, onWahl }: {
  propertyId: number
  feldRef: React.MutableRefObject<HTMLInputElement | null>
  erlaubt: (b: Befehl) => boolean
  darfKunden: boolean
  onClose: () => void
  onWahl: (ziel: Sprungziel) => void
}): JSX.Element {
  const t = useT()
  const listId = useId()
  const [begriff, setBegriff] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [aktiv, setAktiv] = useState(0)
  const listeRef = useRef<HTMLUListElement>(null)
  const entprellt = useEntprellt(begriff.trim())

  // Ohne Gastrecht gibt es keinen Kundenfilter; die Schnittstelle antwortete
  // darauf mit 403, und ein Filter, der nur Fehler zeigt, ist keiner.
  const filter = FILTER.filter(f => f.scope !== 'customer' || darfKunden)
  const q = useSuche(propertyId, entprellt, scope, TREFFER)
  const gesucht = entprellt.length >= SUCHE_MIN_ZEICHEN

  useEscape(onClose)
  useEffect(() => { feldRef.current?.focus() }, [feldRef])
  useEffect(() => { setAktiv(0) }, [entprellt, scope])

  /*
   * Die Befehle stehen immer da, solange nichts getippt ist -- sie sind der
   * zweite Grund, das Fenster zu oeffnen. Mit einem Begriff nur die, deren
   * Name ihn enthaelt: "neu" findet alle drei, "gast" den einen.
   */
  const befehle: Eintrag[] = scope === 'all'
    ? BEFEHLE
        .filter(b => erlaubt(b.befehl))
        .filter(b => entprellt === ''
          || t(b.text).toLowerCase().includes(entprellt.toLowerCase()))
        .map(b => ({ art: 'befehl' as const, befehl: b.befehl, text: b.text, taste: b.taste }))
    : []
  const reservierungen: Eintrag[] = gesucht && q.data !== undefined
    ? q.data.reservations.map(hit => ({ art: 'reservierung' as const, hit })) : []
  const kunden: Eintrag[] = gesucht && q.data !== undefined
    ? q.data.customers.map(hit => ({ art: 'kunde' as const, hit })) : []
  const eintraege = [...reservierungen, ...kunden, ...befehle]

  // Die markierte Zeile bleibt im Blick, wenn die Pfeile sie aus dem
  // sichtbaren Teil der Liste schieben.
  useEffect(() => {
    listeRef.current?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [aktiv])

  const waehlen = (e: Eintrag): void => {
    if (e.art === 'befehl') onWahl({ art: 'befehl', befehl: e.befehl })
    else if (e.art === 'reservierung') onWahl({ art: 'reservierung', ref: e.hit.reservationRef })
    else onWahl({ art: e.hit.kind === 'guest' ? 'gast' : 'firma', ref: e.hit.ref })
  }

  const aufTaste = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Die Alt-Befehle gelten auch hier im Feld (das globale Horchen
    // laesst Textfelder aus).
    const befehl = befehlZurTaste(e.nativeEvent)
    if (befehl !== null) {
      e.preventDefault()
      if (erlaubt(befehl)) onWahl({ art: 'befehl', befehl })
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (eintraege.length === 0) return
      const schritt = e.key === 'ArrowDown' ? 1 : -1
      setAktiv(a => (a + schritt + eintraege.length) % eintraege.length)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const i = filter.findIndex(f => f.scope === scope)
      const schritt = e.shiftKey ? -1 : 1
      setScope(filter[(i + schritt + filter.length) % filter.length]!.scope)
      return
    }
    if (e.key === 'Enter') {
      const eintrag = eintraege[aktiv]
      if (eintrag === undefined) return
      e.preventDefault()
      waehlen(eintrag)
    }
  }

  let index = -1
  const zeile = (e: Eintrag): JSX.Element => {
    index += 1
    const i = index
    const schluessel = e.art === 'reservierung' ? `r-${e.hit.reservationRef}`
      : e.art === 'kunde' ? `k-${e.hit.kind}-${e.hit.ref}` : `b-${e.befehl}`
    return (
      <li key={schluessel} id={`${listId}-${i}`} role="option" aria-selected={i === aktiv}
          onMouseDown={ev => ev.preventDefault()}
          onMouseMove={() => { if (i !== aktiv) setAktiv(i) }}
          onClick={() => waehlen(e)}
          className={`flex items-center gap-3 px-4 py-2 text-sm cursor-pointer
                      ${i === aktiv ? 'bg-neutral-100' : ''}`}>
        {e.art === 'reservierung' && <ReservierungsTreffer hit={e.hit} />}
        {e.art === 'kunde' && <KundenTreffer hit={e.hit} />}
        {e.art === 'befehl' && (
          <>
            <span className="grow">{t(e.text)}</span>
            <kbd className="text-[11px] px-1.5 rounded-sm border border-neutral-300
                            bg-neutral-50 text-neutral-500 font-sans">
              {istMac() ? '⌥' : 'Alt+'}{e.taste}
            </kbd>
          </>
        )}
      </li>
    )
  }

  const gruppe = (titel: TextKey, liste: Eintrag[]): JSX.Element | null =>
    liste.length === 0 ? null : (
      <li role="presentation">
        <div className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide
                        text-neutral-500">
          {t(titel)}
        </div>
        <ul role="group" aria-label={t(titel)}>{liste.map(zeile)}</ul>
      </li>
    )

  const nichts = gesucht && q.data !== undefined && !q.isPlaceholderData
    && reservierungen.length === 0 && kunden.length === 0

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4
                    pt-[10vh]"
         onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t('suche.title')}
           data-detailsuche
           onClick={e => e.stopPropagation()}
           className="w-full max-w-2xl flex flex-col max-h-[75vh] bg-white rounded-lg
                      shadow-xl">
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
          <span aria-hidden className="text-neutral-400">⌕</span>
          <input ref={feldRef} value={begriff} onChange={e => setBegriff(e.target.value)}
                 onKeyDown={aufTaste}
                 placeholder={t('suche.placeholder')} aria-label={t('suche.placeholder')}
                 role="combobox" aria-expanded aria-controls={listId}
                 aria-autocomplete="list"
                 aria-activedescendant={eintraege[aktiv] !== undefined
                   ? `${listId}-${aktiv}` : undefined}
                 className="grow text-base outline-hidden" />
          <kbd className="text-[11px] px-1.5 rounded-sm border border-neutral-300 bg-neutral-50
                          text-neutral-500 font-sans">Esc</kbd>
        </div>

        <div className="flex gap-1.5 px-4 py-2 border-b border-neutral-100">
          {filter.map(f => (
            <button key={f.scope} type="button" tabIndex={-1}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setScope(f.scope)}
                    aria-pressed={scope === f.scope}
                    className={`text-xs px-2.5 py-1 rounded-full border
                                ${scope === f.scope
                                  ? 'bg-neutral-900 text-white border-neutral-900'
                                  : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'}`}>
              {t(f.text)}
            </button>
          ))}
        </div>

        <ul ref={listeRef} id={listId} role="listbox" aria-label={t('suche.title')}
            className="grow overflow-y-auto pb-2">
          {gruppe('suche.group.reservation', reservierungen)}
          {gruppe('suche.group.customer', kunden)}
          {gruppe('suche.group.command', befehle)}
        </ul>

        {!gesucht && begriff.trim().length > 0 && (
          <div className="px-4 pb-2 text-xs text-neutral-500">{t('suche.minChars')}</div>
        )}
        {nichts && (
          <div className="px-4 pb-2 text-xs text-neutral-500">{t('suche.noResults')}</div>
        )}
        {q.data !== undefined && gesucht
          && (q.data.moreReservations || q.data.moreCustomers) && (
          <div className="px-4 pb-2 text-xs text-neutral-500">{t('suche.more')}</div>
        )}

        <footer className="flex flex-wrap gap-4 border-t border-neutral-200 bg-neutral-50
                           px-4 py-2 text-xs text-neutral-500 rounded-b-lg">
          <span><Taste>↑</Taste><Taste>↓</Taste> {t('suche.footer.navigate')}</span>
          <span><Taste>↵</Taste> {t('suche.footer.select')}</span>
          <span><Taste>Tab</Taste> {t('suche.footer.filter')}</span>
          <span><Taste>Esc</Taste> {t('suche.footer.close')}</span>
        </footer>
      </div>
    </div>
  )
}

function Taste({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <kbd className="mr-0.5 text-[11px] px-1 rounded-sm border border-neutral-300 bg-white
                    font-sans">
      {children}
    </kbd>
  )
}
