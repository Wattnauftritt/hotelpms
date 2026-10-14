import { useState } from 'react'
import type { Company } from '@hotelpms/contracts'
import { useCreateCompany, usePatchCompany } from '../lib/queries/guests.js'
import { useT } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'

function orUndef(s: string): string | undefined {
  const w = s.trim()
  return w === '' ? undefined : w
}

/**
 * Firma anlegen oder aendern.
 *
 * **Warum eine Komponente und nicht Teil des Gaestebildschirms.** Gebraucht
 * wird sie an zwei Stellen: im Reiter Firmen und im Rechnungsempfaenger des
 * Folios. Dort fehlt die Firma meist genau in dem Moment, in dem die
 * Rechnung an sie gehen soll; wer dafuer den Bildschirm wechseln muss,
 * verliert das Folio und schreibt die Rechnung im Zweifel an den Gast.
 * Eine zweite, kuerzere Maske im Folio liefe mit der ersten auseinander.
 */
export function FirmaFormular({ initial, vorschlag, darfSchreiben, onSaved }: {
  initial?: Company
  /** Name aus einer Suche ohne Treffer, damit er nicht zweimal getippt wird. */
  vorschlag?: string
  darfSchreiben: boolean
  onSaved: (f: { companyRef: string; name: string }) => void
}): JSX.Element {
  const t = useT()
  const [name, setName] = useState(initial?.name ?? vorschlag ?? '')
  const [contactName, setContactName] = useState(initial?.contactName ?? '')
  const [vatId, setVatId] = useState(initial?.vatId ?? '')
  const [addressLine1, setAddressLine1] = useState(initial?.addressLine1 ?? '')
  const [postalCode, setPostalCode] = useState(initial?.postalCode ?? '')
  const [city, setCity] = useState(initial?.city ?? '')
  const [country, setCountry] = useState(initial?.country ?? 'DE')
  const [paymentTermsDays, setPaymentTermsDays] = useState(initial?.paymentTermsDays ?? 14)
  const [invoiceEmail, setInvoiceEmail] = useState(initial?.invoiceEmail ?? '')
  const [leitweg, setLeitweg] = useState(initial?.buyerReference ?? '')
  const [active, setActive] = useState(initial?.active ?? true)

  const anlegen = useCreateCompany()
  const aendern = usePatchCompany(initial?.companyRef ?? '')
  const speichern = initial ? aendern : anlegen

  const absenden = (): void => {
    const body = {
      name: name.trim(),
      // Wie die Leitweg-ID: leer beim Aendern entfernt den Ansprechpartner.
      contactName: initial ? contactName.trim() : orUndef(contactName),
      vatId: orUndef(vatId), addressLine1: orUndef(addressLine1),
      postalCode: orUndef(postalCode), city: orUndef(city), country: orUndef(country) ?? 'DE',
      paymentTermsDays, invoiceEmail: orUndef(invoiceEmail),
      // Leer schickt einen leeren Text: so laesst sich eine Leitweg-ID
      // wieder entfernen, wenn die Firma doch keine Behoerde ist.
      buyerReference: initial ? leitweg.trim() : orUndef(leitweg)
    }
    if (initial) {
      aendern.mutate({ ...body, active }, { onSuccess: onSaved })
    } else {
      anlegen.mutate(body, { onSuccess: onSaved })
    }
  }

  return (
    <div className="space-y-2 border border-neutral-200 rounded-sm p-3">
      <h2 className="text-sm font-medium">{t('companies.title')}</h2>
      <input value={name} onChange={e => setName(e.target.value)} disabled={!darfSchreiben}
             placeholder={t('companies.name')}
             className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      <input value={contactName} onChange={e => setContactName(e.target.value)}
             disabled={!darfSchreiben} placeholder={t('companies.contactName')}
             maxLength={200}
             className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      <input value={vatId} onChange={e => setVatId(e.target.value)} disabled={!darfSchreiben}
             placeholder={t('companies.vatId')}
             className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      <input value={addressLine1} onChange={e => setAddressLine1(e.target.value)}
             disabled={!darfSchreiben} placeholder={t('companies.address')}
             className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <input value={postalCode} onChange={e => setPostalCode(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('companies.postalCode')}
               className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        <input value={city} onChange={e => setCity(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('companies.city')}
               className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input value={country} onChange={e => setCountry(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('companies.country')}
               className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        <input type="number" min={0} value={paymentTermsDays}
               onChange={e => setPaymentTermsDays(Number(e.target.value))}
               disabled={!darfSchreiben} placeholder={t('companies.paymentTerms')}
               className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      </div>
      <input value={invoiceEmail} onChange={e => setInvoiceEmail(e.target.value)} type="email"
             disabled={!darfSchreiben} placeholder={t('companies.invoiceEmail')}
             className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      <input value={leitweg} onChange={e => setLeitweg(e.target.value)}
             disabled={!darfSchreiben} placeholder={t('companies.buyerReference')}
             className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm font-mono" />
      {leitweg.trim() !== '' && (
        <p className="text-xs text-neutral-500">{t('companies.buyerReferenceHint')}</p>
      )}
      {initial !== undefined && darfSchreiben && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          {active ? t('companies.active') : t('companies.inactive')}
        </label>
      )}

      {speichern.isError && <Fehler error={speichern.error} />}
      {darfSchreiben && (
        <div className="flex items-center gap-3">
          <button type="button" disabled={name.trim() === '' || speichern.isPending}
                  onClick={absenden}
                  className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('companies.save')}
          </button>
          {speichern.isSuccess && (
            <span className="text-xs text-emerald-700">✓ {t('companies.saved')}</span>
          )}
        </div>
      )}
    </div>
  )
}
