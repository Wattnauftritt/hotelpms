import { useEffect, useState, type JSX } from 'react'
import { useInvoiceSettings, useSaveInvoiceSettings, useInvoiceLogo, type RechnungsKontakt,
         type Rechnungseinstellung } from '../lib/queries/settings.js'
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
      <LogoFeld propertyId={propertyId} logo={q.data.logo} />
      <KontaktFelder daten={q.data} gesperrt={!online || speichern.isPending}
                     speichern={contact => speichern.mutate({ contact })} />
    </div>
  )
}

/**
 * Logo auf der Rechnung (Migration 0170), oben rechts auf dem Beleg. Nur
 * PNG und JPEG; die Schnittstelle prueft die Art an den Bytes. Wirkt auf
 * jede Rechnung, die danach gezeichnet wird -- ein ausgestellter Beleg
 * behaelt sein Logo.
 */
function LogoFeld({ propertyId, logo }: {
  propertyId: number; logo: Rechnungseinstellung['logo']
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const setzen = useInvoiceLogo(propertyId)
  return (
    <section className="space-y-2 border-t border-neutral-200 pt-4">
      <h3 className="text-sm font-medium">{t('invoiceSettings.logo')}</h3>
      <p className="text-xs text-neutral-600">{t('invoiceSettings.logoHint')}</p>
      {logo !== null && (
        <img src={`/v1/properties/${propertyId}/invoice-logo?v=${encodeURIComponent(logo.updatedAt)}`}
             alt={t('invoiceSettings.logo')}
             className="max-h-12 max-w-40 border border-neutral-200 rounded-sm bg-white p-1" />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input type="file" accept="image/png,image/jpeg" disabled={!online || setzen.isPending}
               aria-label={t('invoiceSettings.logo')}
               onChange={e => {
                 const datei = e.target.files?.[0]
                 e.target.value = ''
                 if (datei === undefined) return
                 const r = new FileReader()
                 r.onload = () => setzen.mutate(String(r.result))
                 r.readAsDataURL(datei)
               }}
               className="text-sm" />
        {logo !== null && (
          <button type="button" disabled={!online || setzen.isPending}
                  onClick={() => setzen.mutate(null)}
                  className="text-xs px-2 py-1 rounded-sm border border-neutral-300
                             hover:bg-neutral-50 disabled:opacity-40">
            {t('invoiceSettings.logoRemove')}
          </button>
        )}
      </div>
      {setzen.isError && <Fehler error={setzen.error} />}
    </section>
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

const KONTAKT: Array<{ feld: keyof RechnungsKontakt
                       label: Parameters<ReturnType<typeof useT>>[0]; mono?: boolean }> = [
  { feld: 'contactName', label: 'invoiceSettings.contactName' },
  { feld: 'phone', label: 'invoiceSettings.phone' },
  { feld: 'email', label: 'invoiceSettings.email' },
  { feld: 'iban', label: 'invoiceSettings.iban', mono: true },
  { feld: 'bic', label: 'invoiceSettings.bic', mono: true },
  { feld: 'bankName', label: 'invoiceSettings.bankName' },
  { feld: 'commercialRegister', label: 'invoiceSettings.register' }
]

/**
 * Kontakt, Bankverbindung und Handelsregister (Migration 0164). Bisher
 * stand auf keiner Rechnung eine IBAN, und was der E-Rechnung fehlte, fiel
 * erst als Hinweis auf einem Beleg auf. Hier steht beides vorher.
 */
function KontaktFelder({ daten, speichern, gesperrt }: {
  daten: Rechnungseinstellung; speichern: (k: Partial<RechnungsKontakt>) => void
  gesperrt: boolean
}): JSX.Element {
  const t = useT()
  const [werte, setWerte] = useState<Record<keyof RechnungsKontakt, string>>(
    () => Object.fromEntries(KONTAKT.map(k => [k.feld, daten.contact[k.feld] ?? ''])) as
      Record<keyof RechnungsKontakt, string>)
  useEffect(() => {
    setWerte(Object.fromEntries(KONTAKT.map(k => [k.feld, daten.contact[k.feld] ?? ''])) as
      Record<keyof RechnungsKontakt, string>)
  }, [daten.contact])

  const geaendert = KONTAKT.filter(k => werte[k.feld].trim() !== (daten.contact[k.feld] ?? ''))
  const fehlt = (liste: string[]): string =>
    liste.map(m => t(`invoiceSettings.missing.${m}` as 'invoiceSettings.missing.iban')).join(', ')

  return (
    <div className="space-y-2 border-t border-neutral-200 pt-3">
      <h3 className="text-sm font-medium">{t('invoiceSettings.contactTitle')}</h3>
      <p className="text-xs text-neutral-500">{t('invoiceSettings.contactHint')}</p>
      {daten.eInvoiceMissing.xml.length > 0 && (
        <p className="text-sm text-amber-800">
          {t('invoiceSettings.xmlMissing', { fehlt: fehlt(daten.eInvoiceMissing.xml) })}
        </p>
      )}
      {daten.eInvoiceMissing.xrechnung.length > 0 && (
        <p className="text-xs text-neutral-600">
          {t('invoiceSettings.xrechnungMissing', { fehlt: fehlt(daten.eInvoiceMissing.xrechnung) })}
        </p>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        {KONTAKT.map(k => (
          <label key={k.feld} className={`block text-sm ${k.feld === 'commercialRegister'
                                                          ? 'sm:col-span-2' : ''}`}>
            <span className="block text-xs text-neutral-600 mb-1">{t(k.label)}</span>
            <input value={werte[k.feld]} maxLength={100}
                   type={k.feld === 'email' ? 'email' : k.feld === 'phone' ? 'tel' : 'text'}
                   onChange={e => setWerte({ ...werte, [k.feld]: e.target.value })}
                   className={`w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm
                               ${k.mono ? 'font-mono' : ''}`} />
          </label>
        ))}
      </div>
      <button type="button" disabled={gesperrt || geaendert.length === 0}
              onClick={() => speichern(Object.fromEntries(
                geaendert.map(k => [k.feld, werte[k.feld].trim()])))}
              className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('common.save')}
      </button>
    </div>
  )
}
