import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n/index.js'
import { datumAnzeige, datumAusIso, datumIso } from '../lib/bildschirmtastatur.js'

/**
 * Ein Kalenderdatum am Touchscreen: Ziffern statt `<input type="date">`.
 *
 * Warum, steht an `datumAnzeige`. Nach aussen verhaelt es sich wie das
 * Datumsfeld: hinein und heraus geht ISO, ein unvollstaendiges oder
 * unmoegliches Datum ist `''` -- die Schnittstelle meldet dann das fehlende
 * Geburtsdatum an der Stelle, wie sonst auch.
 */
export function Datumsfeld({ value, onChange, className }: {
  value: string; onChange: (iso: string) => void; className: string
}): JSX.Element {
  const t = useT()
  const [text, setText] = useState(() => datumAusIso(value))
  // Von aussen geaendert (ein Mitreisender entfernt, die Zeilen rutschen
  // nach): neu anzeigen. Ein halb getipptes Datum ist nach aussen `''` und
  // bleibt deshalb stehen.
  useEffect(() => {
    if (value !== datumIso(text)) setText(datumAusIso(value))
  }, [value])
  return (
    <input value={text} inputMode="numeric" autoComplete="off" spellCheck={false}
           placeholder={t('kiosk.date.placeholder')} maxLength={10}
           onChange={e => {
             const neu = datumAnzeige(e.target.value)
             setText(neu)
             onChange(datumIso(neu))
           }}
           className={className} />
  )
}
