import { useT } from '../lib/i18n/index.js'

/**
 * Eigener Betreff der Rechnungsmail. Portale wie HRS ordnen die Rechnung
 * nur ueber ihre Buchungsnummer im Betreff zu (Sven, 15.10.2026). Leer
 * bleibt der uebliche; die API verlangt die Rechnungsnummer darin.
 */
export function BetreffFeld({ wert, setWert }: {
  wert: string; setWert: (s: string) => void
}): JSX.Element {
  const t = useT()
  return (
    <label className="text-sm block">
      <div className="text-neutral-600">{t('inv.send.subject')}</div>
      <input value={wert} onChange={e => setWert(e.target.value)} maxLength={200}
             placeholder="—"
             className="border border-neutral-300 rounded-sm px-2 py-1 w-full max-w-md" />
      <div className="text-xs text-neutral-500 mt-0.5">{t('inv.send.subjectHint')}</div>
    </label>
  )
}
