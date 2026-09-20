import type { JSX } from 'react'
import { useT } from '../lib/i18n/index.js'
import { abgeleitet, type Preiseingabe } from '../lib/preisEingabe.js'

/**
 * Preis je Nacht und Gesamtpreis nebeneinander.
 *
 * Getippt wird in eines der beiden; das andere rechnet mit und ist grau.
 * Welches getippt wurde, ist die Vereinbarung -- und nur die geht an die
 * Schnittstelle (`preisFelder`). Die Begruendung steht in
 * `lib/preisEingabe.ts`.
 *
 * Eine Komponente und nicht zweimal derselbe Block, weil es die Maske fuer
 * eine Buchung, die fuer eine Gruppe und darin jede Zimmerzeile gibt. Drei
 * Fassungen derselben Umrechnung waeren drei Gelegenheiten, sie
 * auseinanderlaufen zu lassen.
 */
export function PreisFelder({ wert, naechte, onChange, klein = false }: {
  wert: Preiseingabe
  naechte: number
  onChange: (w: Preiseingabe) => void
  /** Schmale Fassung fuer eine Zimmerzeile in der Gruppenmaske. */
  klein?: boolean
}): JSX.Element {
  const t = useT()
  const ab = abgeleitet(wert, naechte)
  const breite = klein ? 'w-24' : 'w-28'

  const feld = (modus: Preiseingabe['modus'], beschriftung: string): JSX.Element => {
    const aktiv = wert.modus === modus
    return (
      <label className="block text-sm">
        {!klein && (
          <span className="block text-xs text-neutral-600 mb-1">{beschriftung}</span>
        )}
        <input value={aktiv ? wert.text : ab.text}
               onChange={e => onChange({ modus, text: e.target.value })}
               inputMode="decimal" placeholder={klein ? beschriftung : '—'}
               title={klein ? beschriftung : undefined}
               /*
                * Das abgeleitete Feld ist blass, aber nicht gesperrt: ein
                * Klick hinein ist der Weg, die Seite zu wechseln -- wer
                * doch den Gesamtpreis meint, tippt ihn einfach dort. Waere
                * es `readOnly`, muesste dafuer ein Schalter daneben, und
                * den findet niemand.
                */
               className={`border border-neutral-300 rounded px-2 py-1 text-sm ${breite}
                           ${aktiv ? '' : 'text-neutral-500 bg-neutral-50'}`} />
      </label>
    )
  }

  return (
    <div className="flex items-end gap-2">
      {feld('nacht', t('booking.pricePerNight'))}
      <span className="pb-1.5 text-xs text-neutral-400">=</span>
      {feld('gesamt', t('booking.priceTotal'))}
      {/*
        * Der Rest-Cent wird genannt, nicht verschwiegen. Drei Naechte zu
        * 100,00 EUR stehen auf der Rechnung als 33,34 / 33,33 / 33,33, und
        * wer das nicht erwartet, sucht den Fehler bei sich.
        */}
      {ab.restCent > 0 && (
        <span className="pb-1.5 text-xs text-neutral-500"
              title={t('booking.remainderHint')}>
          {t('booking.remainder', { n: ab.restCent })}
        </span>
      )}
    </div>
  )
}
