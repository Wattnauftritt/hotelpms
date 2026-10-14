import { useT } from '../lib/i18n/index.js'

/** Wie der Gast eine offene Rechnung begleichen soll (Migration 0172). */
export interface Zahlweg { transfer: boolean; paymentLink: boolean }

/**
 * Bankverbindung, Zahlungslink oder beides in der Rechnungsmail (Sven,
 * 14.10.2026). Zwei Haken statt einer Auswahl, weil "beides" der
 * haeufigste Fall ist und "keines" gueltig bleibt: eine Firma mit
 * Zahlungsziel kennt die Bankverbindung, und ein Gast, der schon gezahlt
 * hat, braucht weder noch.
 */
export function ZahlwegWahl({ wert, setWert }: {
  wert: Zahlweg; setWert: (z: Zahlweg) => void
}): JSX.Element {
  const t = useT()
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm text-neutral-600">{t('inv.send.payWay')}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={wert.transfer}
               onChange={e => setWert({ ...wert, transfer: e.target.checked })} />
        {t('inv.send.transfer')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={wert.paymentLink}
               onChange={e => setWert({ ...wert, paymentLink: e.target.checked })} />
        {t('inv.send.paymentLink')}
      </label>
    </fieldset>
  )
}
