import type { JSX } from 'react'
import type { Block } from '@hotelpms/contracts'
import { useBlocks } from '../lib/queries.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'

/**
 * Aus einem Kontingent abrufen statt frei zu buchen.
 *
 * **Warum es das geben muss.** Ein Kontingent hielt bisher Kapazitaet
 * zurueck, und am Freigabedatum fiel sie vollstaendig wieder frei --
 * `picked_up` stand immer auf null, weil **kein einziger Weg durch die
 * Oberflaeche** `blockRef` gesetzt hat. Es wirkte damit als Sperre, nicht
 * als Kontingent: rief der Reiseveranstalter an und die Rezeption buchte
 * frei, war das Zimmer doppelt weg -- einmal als Buchung, einmal als
 * weiterhin gehaltener Platz. Das Haus verkaufte zu wenig, und nichts wies
 * darauf hin.
 *
 * **Angeboten wird nur, was wirklich abrufbar ist.** Ein Kontingent passt,
 * wenn es aktiv ist, zur Zimmergruppe gehoert und noch Rest hat. Eines
 * anzubieten, das die Schnittstelle gleich darauf abweist, waere eine
 * Auswahl, die eine Fehlermeldung erzeugt -- und die Rezeption sucht den
 * Fehler dann bei sich.
 *
 * **Der Zeitraum wird mitgeliefert, nicht vorgeschlagen.** Ein Abruf
 * verbraucht den ganzen Zeitraum des Kontingents; ein abweichender waere
 * ein Platz, der an den uebrigen Tagen dauerhaft gebunden bliebe, ohne
 * jemandem zu gehoeren. Deshalb setzt die Wahl die Tage und sperrt sie,
 * statt sie zur Diskussion zu stellen.
 */

/** Passt dieses Kontingent zu dieser Zimmergruppe? */
export function abrufbar(b: Block, categoryId: number | undefined): boolean {
  return b.status === 'active' && b.remaining > 0
    && (categoryId === undefined || b.categoryId === categoryId)
}

export function KontingentWahl({ propertyId, categoryId, gewaehlt, benoetigt, onChange }: {
  propertyId: number
  /** Die Zimmergruppe der Buchung. Ohne sie passt jedes Kontingent. */
  categoryId?: number
  gewaehlt: Block | null
  /** Wie viele Zimmer abgerufen werden sollen. Weniger Rest heisst: passt nicht. */
  benoetigt: number
  onChange: (b: Block | null) => void
}): JSX.Element | null {
  const t = useT()
  const locale = useLocale()
  const q = useBlocks(propertyId, 'active')

  const passende = (q.data?.blocks ?? [])
    .filter(b => abrufbar(b, categoryId) && b.remaining >= benoetigt)

  /*
   * Gar nichts anzeigen, wenn es nichts abzurufen gibt.
   *
   * Ein leeres Auswahlfeld in jeder Buchungsmaske waere eine Frage, die in
   * den allermeisten Faellen keine ist -- die weitaus meisten Buchungen
   * kommen aus dem freien Verkauf. Steht nichts da, ist die Maske so kurz
   * wie vorher.
   */
  if (passende.length === 0 && gewaehlt === null) return null

  return (
    <label className="block text-sm">
      <span className="block text-xs text-neutral-600 mb-1">{t('pickup.label')}</span>
      <select value={gewaehlt?.blockRef ?? ''}
              onChange={e => onChange(
                passende.find(b => b.blockRef === e.target.value) ?? null)}
              className="w-full border border-neutral-300 rounded px-2 py-1 text-sm">
        <option value="">{t('pickup.freeSale')}</option>
        {passende.map(b => (
          <option key={b.blockRef} value={b.blockRef}>
            {b.name} · {formatDate(b.fromDate, locale)}–{formatDate(b.toDate, locale)}
            {' · '}{t('pickup.remaining', { n: b.remaining })}
          </option>
        ))}
      </select>
      {gewaehlt !== null && (
        <span className="block text-xs text-amber-800 mt-1">
          {t('pickup.periodFixed', {
            from: formatDate(gewaehlt.fromDate, locale),
            to: formatDate(gewaehlt.toDate, locale) })}
        </span>
      )}
    </label>
  )
}
