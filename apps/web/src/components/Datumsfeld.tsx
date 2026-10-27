import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n/index.js'
import { datumAusIso, datumLesen, datumTippen, heuteIso, type DatumArt } from '../lib/bildschirmtastatur.js'

/**
 * Ein Geburtsdatum am Touchscreen und auf dem Telefon: getippt statt
 * `<input type="date">`.
 *
 * Auf dem Telefon oeffnet das Datumsfeld des Browsers einen Kalender beim
 * heutigen Monat, und Gaeste mit dem Link aus der Vorab-Mail haben sich
 * darueber beschwert, dass sie bis zum Geburtsjahr blaettern muessen (Sven,
 * 11.10.2026). Hier kommt der Ziffernblock, und die Punkte setzt das Feld
 * selbst (`datumTippen`).
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
export function Datumsfeld({ value, onChange, className, autoComplete = 'off', art = 'geburt' }: {
  value: string; onChange: (iso: string) => void; className: string
  /** `anreise` laesst Tage nach heute zu; ein Geburtsdatum nicht. */
  art?: DatumArt
  /** `bday` auf dem eigenen Geraet des Gastes, `off` am Terminal fuer alle. */
  autoComplete?: string
}): JSX.Element {
  const t = useT()
  const [text, setText] = useState(() => datumAusIso(value))
  const [unlesbar, setUnlesbar] = useState(false)
  // Von aussen geaendert (ein Mitreisender entfernt, die Zeilen rutschen
  // nach): neu anzeigen. Ein halb getipptes Datum ist nach aussen `''` und
  // bleibt deshalb stehen.
  useEffect(() => {
    if (value !== datumLesen(text, heuteIso(), art)) {
      setText(datumAusIso(value))
      setUnlesbar(false)
    }
  }, [value])
  return (
    <>
      <input value={text} inputMode="numeric" autoComplete={autoComplete} spellCheck={false}
             placeholder={t('kiosk.date.placeholder')} maxLength={10}
             onChange={e => {
               const neu = datumTippen(e.target.value.replace(/[^0-9./ -]/g, ''))
               setText(neu)
               setUnlesbar(false)
               onChange(datumLesen(neu, heuteIso(), art))
             }}
             onBlur={() => {
               const iso = datumLesen(text, heuteIso(), art)
               if (iso !== '') setText(datumAusIso(iso))
               else setUnlesbar(text.trim() !== '')
             }}
             className={className} />
      {unlesbar && <span className="block text-base text-red-700">{t('kiosk.date.invalid')}</span>}
    </>
  )
}
