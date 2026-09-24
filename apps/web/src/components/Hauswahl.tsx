import { useEffect, useRef, useState, type JSX } from 'react'
import { useT } from '../lib/i18n/index.js'

/**
 * Das Haus, in dem gerade gearbeitet wird -- und der Weg in ein anderes.
 *
 * **Warum es oben steht und immer sichtbar ist.** Wer drei Haeuser betreut,
 * wechselt am Tag ein Dutzend Mal, und jede Handlung -- eine Buchung, ein
 * Check-in, eine Rechnung -- landet in dem Haus, das gerade gewaehlt ist.
 * Im falschen Haus zu buchen faellt niemandem auf, bis der Gast vor einem
 * anderen Tresen steht. Deshalb steht der Name des Hauses durchgehend in
 * der Kopfleiste, auch bei nur einem Haus: dann als Beschriftung, ohne
 * Menue. Eine Auswahl, die sich erst ab zwei Haeusern zeigt, lernt niemand
 * kennen -- und wer das zweite Haus bekommt, sucht sie.
 *
 * **Ein Menue und kein `select`.** Vorher stand hier ein nacktes
 * Auswahlfeld zwischen Bildschirmleiste und Sprachwahl. Es trug keine
 * Beschriftung, sah aus wie die Sprachwahl daneben und konnte nicht zeigen,
 * was an einem Haus wichtig ist: dass es ein Uebungshaus ist. Ein
 * Auswahlfeld des Browsers stellt Zeichen dar, sonst nichts.
 *
 * **Gesucht wird erst, wenn es sich lohnt.** Bei drei Haeusern ist ein
 * Suchfeld ein Feld, das man wegklicken muss. Bei dreissig ist eine Liste
 * ohne Suche eine Rolle.
 */

export interface Haus {
  id: number
  code: string
  name: string
  isTraining: boolean
}

/** Ab so vielen Haeusern steht ein Suchfeld im Menue. */
const AB_HIER_SUCHEN = 8

/** Das Kuerzel als Plakette -- an ihm erkennt man das Haus schneller als am Namen. */
function Kuerzel({ haus }: { haus: Haus }): JSX.Element {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums
                      ${haus.isTraining
                        ? 'bg-violet-100 text-violet-900'
                        : 'bg-neutral-100 text-neutral-700'}`}>
      {haus.code}
    </span>
  )
}

export function Hauswahl({ haeuser, haus, onHaus }: {
  haeuser: readonly Haus[]
  haus: Haus | undefined
  onHaus: (id: number) => void
}): JSX.Element | null {
  const t = useT()
  const [offen, setOffen] = useState(false)
  const [begriff, setBegriff] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  /*
   * Zu geht es ueber Esc und ueber einen Druck daneben -- und der Horcher
   * laeuft in der Fangphase, aus demselben Grund wie im Kontextmenue: sonst
   * beginnt der Druck auf dem, was darunter liegt. Geprueft wird deshalb
   * hier, ob er **im** Menue liegt; ein `stopPropagation` am Panel liefe in
   * der Blasenphase und damit zu spaet.
   */
  useEffect(() => {
    if (!offen) return
    const zu = (e: Event): void => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      setOffen(false)
    }
    const aufTaste = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOffen(false) }
    window.addEventListener('pointerdown', zu, true)
    window.addEventListener('keydown', aufTaste)
    return () => {
      window.removeEventListener('pointerdown', zu, true)
      window.removeEventListener('keydown', aufTaste)
    }
  }, [offen])

  // Der Suchbegriff haelt nicht ueber das Schliessen hinaus: beim naechsten
  // Oeffnen stuende sonst eine gefilterte Liste da, und dass sie gefiltert
  // ist, sieht man einem Feld mit drei Zeichen darin nicht an.
  useEffect(() => { if (!offen) setBegriff('') }, [offen])

  if (haus === undefined) return null

  /*
   * Ein Haus: nur die Beschriftung. Ein Menue mit einem Eintrag ist ein
   * Klick, der nichts tut, und ein Pfeil, der etwas verspricht.
   */
  if (haeuser.length < 2) {
    return (
      <div className="flex items-center gap-2 text-sm" title={t('haus.label')}>
        <Kuerzel haus={haus} />
        <span className="max-w-48 truncate text-neutral-700">{haus.name}</span>
      </div>
    )
  }

  const suchen = haeuser.length >= AB_HIER_SUCHEN
  const gesucht = begriff.trim().toLowerCase()
  const passende = gesucht === ''
    ? haeuser
    : haeuser.filter(h => `${h.code} ${h.name}`.toLowerCase().includes(gesucht))

  const waehlen = (id: number): void => {
    setOffen(false)
    // Dasselbe Haus noch einmal ist kein Wechsel: ein Klick auf den
    // aktuellen Eintrag soll das Menue schliessen, nicht den Bildschirm
    // zuruecksetzen.
    if (id !== haus.id) onHaus(id)
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOffen(o => !o)}
              aria-label={t('haus.label')} aria-haspopup="menu" aria-expanded={offen}
              className={`flex items-center gap-2 rounded border px-2 py-1 text-sm
                          ${offen
                            ? 'border-neutral-400 bg-neutral-50'
                            : 'border-neutral-300 hover:bg-neutral-50'}`}>
        <Kuerzel haus={haus} />
        <span className="max-w-40 truncate">{haus.name}</span>
        <span aria-hidden className="text-xs text-neutral-400">▾</span>
      </button>

      {offen && (
        <div role="menu"
             className="absolute right-0 z-40 mt-1 w-80 rounded border border-neutral-200
                        bg-white py-1 shadow-xl">
          {suchen && (
            <div className="px-2 pb-1">
              <input autoFocus value={begriff} onChange={e => setBegriff(e.target.value)}
                     placeholder={t('haus.search')} aria-label={t('haus.search')}
                     className="w-full rounded border border-neutral-300 px-2 py-1 text-sm" />
            </div>
          )}
          <div className="max-h-80 overflow-y-auto">
            {passende.map(h => (
              <button key={h.id} type="button" role="menuitem"
                      onClick={() => waehlen(h.id)}
                      aria-current={h.id === haus.id ? 'true' : undefined}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left
                                  text-sm hover:bg-neutral-100
                                  ${h.id === haus.id ? 'bg-neutral-50 font-medium' : ''}`}>
                {/* Der Haken steht in einer festen Spalte, nicht hinter dem
                    Namen: sonst springt die Liste beim Wechsel. */}
                <span aria-hidden className="w-3 text-neutral-900">
                  {h.id === haus.id ? '✓' : ''}
                </span>
                <Kuerzel haus={h} />
                <span className="grow truncate">{h.name}</span>
                {/* Das Uebungshaus wird **vor** dem Wechsel benannt. Danach
                    steht der violette Streifen da, aber dann ist man schon
                    drin (Dokument 13, C11). */}
                {h.isTraining && (
                  <span className="shrink-0 text-xs text-violet-700">
                    {t('haus.training')}
                  </span>
                )}
              </button>
            ))}
            {passende.length === 0 && (
              <div className="px-3 py-2 text-sm text-neutral-500">{t('common.none')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
