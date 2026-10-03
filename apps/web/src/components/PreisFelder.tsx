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
export function PreisFelder({ wert, naechte, onChange, klein = false,
                              fehlt = false }: {
  wert: Preiseingabe
  naechte: number
  onChange: (w: Preiseingabe) => void
  /** Schmale Fassung fuer eine Zimmerzeile in der Gruppenmaske. */
  klein?: boolean
  /**
   * Hier fehlt ein Betrag, den es braucht.
   *
   * Nicht dasselbe wie "leer": leer heisst sonst "es gilt der Ratenplan"
   * und ist in Ordnung. Gemeint ist die halb gefuellte Gruppe -- drei von
   * vier Zimmern mit Betrag --, und dann muss zu sehen sein, **welche**
   * Zeile fehlt. Eine Meldung am Knopf sagt nur, dass etwas fehlt.
   */
  fehlt?: boolean
}): JSX.Element {
  const t = useT()
  const ab = abgeleitet(wert, naechte)
  const breite = klein ? 'w-24' : 'w-28'
  // In einer Zimmerzeile bleibt es eng, sonst so hoch wie jedes andere Feld.
  const polster = klein ? 'px-2 py-1' : 'px-3 py-2'

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
               className={`border rounded-sm text-sm ${polster} ${breite}
                           ${fehlt ? 'border-red-500 bg-red-50' : 'border-neutral-300'}
                           ${aktiv ? '' : 'text-neutral-500 bg-neutral-50'}`} />
      </label>
    )
  }

  /*
   * Der Rest-Cent wird genannt, nicht verschwiegen. Drei Naechte zu 100,00
   * EUR stehen auf der Rechnung als 33,34 / 33,33 / 33,33, und wer das
   * nicht erwartet, sucht den Fehler bei sich.
   */
  const rest = ab.restCent > 0 && (
    <span className="pb-1.5 text-xs text-neutral-500 whitespace-nowrap"
          title={t('booking.remainderHint')}>
      {t('booking.remainder', { n: ab.restCent })}
    </span>
  )

  return (
    /*
     * `flex-wrap` nur in der grossen Fassung: dort steht der Block in einer
     * Spalte des Rasters, und der Rest-Hinweis dahinter passt nicht immer
     * daneben -- ohne Umbruch legt er sich ueber die Nachbarspalte. In der
     * schmalen Fassung darf nichts umbrechen: die Zeile waere dann hoeher
     * als die uebrigen, und der Unterschied stuende wieder da, nur in der
     * anderen Richtung.
     */
    <div className={`flex items-end gap-2 ${klein ? '' : 'flex-wrap'}`}>
      {/*
        * In der schmalen Fassung steht der Hinweis **links** von den
        * Feldern.
        *
        * Die Zimmerzeilen der Gruppenmaske richten ihre Preisfelder rechts
        * aus. Stand der Hinweis dahinter, schob er die beiden Felder genau
        * um seine Breite nach links -- und zwar nur in der einen Zeile, die
        * gerade einen Rest hat. Vier Zimmer untereinander, und eines davon
        * steht aus der Reihe; man sucht dann nach einem Unterschied in den
        * Betraegen, wo nur ein Hinweis breiter war.
        */}
      {klein && rest}
      {feld('nacht', t('booking.pricePerNight'))}
      <span className="pb-1.5 text-xs text-neutral-400">=</span>
      {feld('gesamt', t('booking.priceTotal'))}
      {/* In der grossen Fassung dahinter: dort ist nichts ausgerichtet,
          was er verschieben koennte, und gelesen wird von links nach
          rechts -- erst der Betrag, dann die Fussnote dazu. */}
      {!klein && rest}
    </div>
  )
}
