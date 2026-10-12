import { useEffect, useState } from 'react'
import { LOCALES, SPRACHNAMEN, type Locale } from '../lib/i18n/index.js'

/**
 * Die Sprachwahl fuer Gaeste: ein Knopf mit der gewaehlten Sprache, dahinter
 * ein Raster mit allen.
 *
 * Bis zu vierzehn Sprachen standen als Knopfreihe da. Mit dreiunddreissig
 * fuellt die Reihe am Terminal den halben Bildschirm und schiebt am Telefon
 * das Formular unter den Rand -- und eine aufklappende Liste trifft ein
 * Finger am Touchscreen schlecht. Der Globus davor ist das Zeichen, das ein
 * Gast sucht, der die angezeigte Sprache nicht liest; der Name daneben steht
 * in der eigenen Sprache, nicht als Kuerzel ("UK" laese ein Gast als
 * Vereinigtes Koenigreich).
 *
 * Das Raster haelt nichts fest: die Wahl geht sofort an `onLocale`.
 */
export function Sprachauswahl({ locale, onLocale, label, hell = false, gross = false }: {
  locale: Locale
  onLocale: (l: Locale) => void
  /** Beschriftung fuer Vorleseprogramme, in der aktuellen Sprache. */
  label: string
  /** Auf einem Foto im Ruhezustand des Terminals: helle Schrift auf Glas. */
  hell?: boolean
  /** Am Terminal: groessere Flaechen fuer den Finger. */
  gross?: boolean
}): JSX.Element {
  const [offen, setOffen] = useState(false)

  useEffect(() => {
    if (!offen) return
    const taste = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOffen(false) }
    document.addEventListener('keydown', taste)
    return () => document.removeEventListener('keydown', taste)
  }, [offen])

  return (
    <>
      <button type="button" onClick={() => setOffen(true)} aria-haspopup="dialog"
              aria-label={`${label}: ${SPRACHNAMEN[locale]}`}
              className={`${gross ? 'px-4 py-2 text-lg' : 'px-3 py-1.5 text-sm'} rounded-sm border
                inline-flex items-center gap-2 touch-manipulation ${hell
                ? 'border-white/60 bg-black/25 text-white backdrop-blur-sm'
                : 'border-neutral-300 bg-white text-neutral-800'}`}>
        <span aria-hidden>🌐</span>
        <span>{SPRACHNAMEN[locale]}</span>
      </button>
      {offen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
             onClick={() => setOffen(false)}>
          <div role="dialog" aria-modal="true" aria-label={label}
               onClick={e => e.stopPropagation()}
               className="max-h-full w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-4
                          shadow-xl">
            <div className={`grid gap-2 ${gross ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
              {LOCALES.map(l => (
                // `lang` je Knopf: ein Vorleseprogramm spricht "Ελληνικά"
                // griechisch aus und nicht nach den Regeln der Seite.
                <button key={l} type="button" lang={l} aria-pressed={l === locale}
                        onClick={() => { onLocale(l); setOffen(false) }}
                        className={`${gross ? 'py-4 text-lg' : 'py-2'} rounded-sm border px-3
                          touch-manipulation ${l === locale
                          ? 'border-neutral-900 bg-neutral-900 text-white'
                          : 'border-neutral-300 bg-white text-neutral-800 active:bg-neutral-100'}`}>
                  {SPRACHNAMEN[l]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
