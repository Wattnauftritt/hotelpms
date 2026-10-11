import { useT, useLocale } from '../lib/i18n/index.js'
import { fehlerMeldung } from '../lib/meldungen.js'

/**
 * Ein Fehler der Schnittstelle, in der Sprache des Personals.
 *
 * Die Meldungen an einzelnen Feldern stehen mit da. Sie nur zu verschlucken
 * waere bequem und liesse den Benutzer raten, welches der acht Felder die
 * Maske nicht annimmt.
 *
 * Eine eigene Datei und nicht in `Shell.tsx`: das Gaesteterminal zeigt
 * denselben Fehler, und ein Import aus der Shell zog Hauswahl, Detailsuche
 * und die Mobilleiste in die Seite am Touchscreen (Performance-Audit
 * 11.10.2026, Befund 10).
 */
export function Fehler({ error }: { error: unknown }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const { text, felder } = fehlerMeldung(error, locale)
  return (
    <div role="alert" className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm">
      <div className="font-medium text-red-900">{t('error.title')}</div>
      <div className="text-red-800">{text}</div>
      {felder.length > 0 && (
        <ul className="mt-1 text-red-800">
          {felder.map(([feld, meldung], i) => (
            <li key={`${feld}-${i}`}>
              <span className="font-mono text-xs">{feld}</span>: {meldung}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
