import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n/index.js'
import { datumAusIso, datumLesen, heuteIso } from '../lib/bildschirmtastatur.js'

/**
 * Ein Geburtsdatum am Touchscreen: getippt statt `<input type="date">`.
 *
 * Warum, und welche Schreibweisen gelten, steht an `datumLesen`. Nach aussen
 * verhaelt es sich wie das Datumsfeld: hinein und heraus geht ISO, ein
 * unlesbares Datum ist `''`. Nach dem Verlassen steht es einheitlich als
 * `TT.MM.JJJJ` da -- der Gast sieht, wie es verstanden wurde, `85` also als
 * 1985. Was sich nicht lesen laesst, sagt das Feld selbst, auf Deutsch und
 * in der Sprache des Gastes; die Meldung der Schnittstelle ("Datum im
 * Format YYYY-MM-DD erwartet") ist fuer Programme geschrieben, nicht fuer
 * jemanden am Tresen.
 */
export function Datumsfeld({ value, onChange, className }: {
  value: string; onChange: (iso: string) => void; className: string
}): JSX.Element {
  const t = useT()
  const [text, setText] = useState(() => datumAusIso(value))
  const [unlesbar, setUnlesbar] = useState(false)
  // Von aussen geaendert (ein Mitreisender entfernt, die Zeilen rutschen
  // nach): neu anzeigen. Ein halb getipptes Datum ist nach aussen `''` und
  // bleibt deshalb stehen.
  useEffect(() => {
    if (value !== datumLesen(text, heuteIso())) {
      setText(datumAusIso(value))
      setUnlesbar(false)
    }
  }, [value])
  return (
    <>
      <input value={text} inputMode="numeric" autoComplete="off" spellCheck={false}
             placeholder={t('kiosk.date.placeholder')} maxLength={10}
             onChange={e => {
               const neu = e.target.value.replace(/[^0-9./ -]/g, '')
               setText(neu)
               setUnlesbar(false)
               onChange(datumLesen(neu, heuteIso()))
             }}
             onBlur={() => {
               const iso = datumLesen(text, heuteIso())
               if (iso !== '') setText(datumAusIso(iso))
               else setUnlesbar(text.trim() !== '')
             }}
             className={className} />
      {unlesbar && <span className="block text-base text-red-700">{t('kiosk.date.invalid')}</span>}
    </>
  )
}
