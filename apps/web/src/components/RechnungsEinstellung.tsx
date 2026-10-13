import { useEffect, useState, type JSX } from 'react'
import { useInvoiceSettings, useSaveInvoiceSettings } from '../lib/queries/settings.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Rechnungskuerzel des Hauses (Migration 0157).
 *
 * Die Nummer muss beim Unternehmer eindeutig sein, nicht beim Haus; zwei
 * Haeuser eines Accounts zaehlten sonst beide ab 2026-00001. Die Vorschau
 * zeigt die naechste Nummer so, wie sie auf dem Beleg stehen wird -- wer
 * das Kuerzel tippt, sieht, was der Gast bekommt.
 */
export function RechnungsEinstellung({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useInvoiceSettings(propertyId)
  const speichern = useSaveInvoiceSettings(propertyId)
  const [kuerzel, setKuerzel] = useState('')
  const [ziel, setZiel] = useState('')

  useEffect(() => {
    setKuerzel(q.data?.prefix ?? '')
    setZiel(q.data === undefined ? '' : String(q.data.paymentTermsDays))
  }, [q.data])

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const wert = kuerzel.trim().toUpperCase()
  const gueltig = /^[A-Z0-9]{1,6}$/.test(wert)
  // Die Vorschau ersetzt nur das Kuerzel; Jahr und laufende Nummer kommen
  // vom Server, der den Zaehler kennt.
  const ohneKuerzel = q.data.prefix === null
    ? q.data.nextNumber : q.data.nextNumber.replace(`${q.data.prefix}-`, '')
  const vorschau = gueltig
    ? ohneKuerzel.replace(/(\d{4}-\d{5})$/, `${wert}-$1`) : q.data.nextNumber

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('invoiceSettings.hint')}</p>
      {q.data.missing && (
        <p className="text-sm text-amber-800">{t('invoiceSettings.missing')}</p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">
            {t('invoiceSettings.prefix')}
          </span>
          <input value={kuerzel} maxLength={6} disabled={q.data.locked}
                 onChange={e => setKuerzel(e.target.value.toUpperCase())}
                 className="w-32 border border-neutral-300 rounded-sm px-2 py-1 text-sm font-mono
                            disabled:bg-neutral-100" />
        </label>
        <div className="text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('invoiceSettings.next')}</span>
          <span className="font-mono tabular-nums">{vorschau}</span>
        </div>
      </div>
      {q.data.locked && (
        <p className="text-xs text-neutral-500">{t('invoiceSettings.locked')}</p>
      )}
      {speichern.isError && <Fehler error={speichern.error} />}
      <ZielFeld wert={ziel} setWert={setZiel} gespeichert={q.data.paymentTermsDays}
                speichern={tage => speichern.mutate({ paymentTermsDays: tage })}
                gesperrt={!online || speichern.isPending} />
      {!q.data.locked && (
        <button type="button"
                disabled={!online || !gueltig || wert === q.data.prefix || speichern.isPending}
                onClick={() => speichern.mutate({ prefix: wert })}
                className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('common.save')}
        </button>
      )}
    </div>
  )
}

/**
 * Zahlungsziel fuer Gaeste ohne Firma (Migration 0159). Eine Firma bringt
 * ihr eigenes mit; im Rechnungsdialog laesst sich beides je Rechnung aendern.
 */
function ZielFeld({ wert, setWert, gespeichert, speichern, gesperrt }: {
  wert: string; setWert: (s: string) => void; gespeichert: number
  speichern: (tage: number) => void; gesperrt: boolean
}): JSX.Element {
  const t = useT()
  const tage = Number(wert)
  const gueltig = wert.trim() !== '' && Number.isInteger(tage) && tage >= 0 && tage <= 365
  return (
    <div className="space-y-1 border-t border-neutral-200 pt-3">
      <label className="block text-sm">
        <span className="block text-xs text-neutral-600 mb-1">
          {t('invoiceSettings.paymentTerms')}
        </span>
        <input value={wert} onChange={e => setWert(e.target.value)} inputMode="numeric"
               className="w-24 border border-neutral-300 rounded-sm px-2 py-1 text-sm
                          text-end tabular-nums" />
      </label>
      <p className="text-xs text-neutral-500">{t('invoiceSettings.paymentTermsHint')}</p>
      <button type="button" disabled={gesperrt || !gueltig || tage === gespeichert}
              onClick={() => speichern(tage)}
              className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('common.save')}
      </button>
    </div>
  )
}
