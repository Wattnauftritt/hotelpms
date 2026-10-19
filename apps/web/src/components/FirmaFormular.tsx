import { useState } from 'react'
import type { Company } from '@hotelpms/contracts'
import { useCreateCompany, usePatchCompany } from '../lib/queries/guests.js'
import { useT } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'
import { KarteFotografieren, VisitenkarteScan } from './VisitenkarteScan.tsx'
import type { AnschriftVorschlag } from '../lib/visitenkarte.js'

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
 *
 * **Visitenkarte scannen.** Aus demselben Grund sitzt der Scan hier und
 * nicht an jeder Stelle einzeln: Folio und Firmenliste bekommen ihn beide.
 * Der erkannte Vorschlag fuellt nur die Felder, die er erkannt hat, und erst
 * nachdem die Rezeption ihn bestaetigt hat (`VisitenkarteScan`).
 */
/**
 * Beschriftung ueber dem Feld statt nur als Platzhalter: ein Platzhalter
 * verschwindet, sobald etwas im Feld steht, und bei den vorbelegten Feldern
 * (Land, Zahlungsziel) stand deshalb eine nackte 14 ohne Erklaerung da.
 */
function Feld({ text, children }: { text: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs text-neutral-500 mb-0.5">{text}</span>
      {children}
    </label>
  )
}

export function FirmaFormular({ initial, vorschlag, scanBild, darfSchreiben, onSaved }: {
  initial?: Company
  /** Name aus einer Suche ohne Treffer, damit er nicht zweimal getippt wird. */
  vorschlag?: string
  /** Ein Foto, das schon vor dem Formular aufgenommen wurde; es wird sofort gelesen. */
  scanBild?: File
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
  // Leer heisst: Vorgabe des Hauses aus den Einstellungen (0189). Eine
  // vorbelegte Zahl hier waere eine dritte Vorgabe neben Haus und Datenbank.
  const [paymentTermsDays, setPaymentTermsDays] = useState(
    initial?.paymentTermsDays == null ? '' : String(initial.paymentTermsDays))
  const [invoiceEmail, setInvoiceEmail] = useState(initial?.invoiceEmail ?? '')
  const [leitweg, setLeitweg] = useState(initial?.buyerReference ?? '')
  const [active, setActive] = useState(initial?.active ?? true)
  const [scan, setScan] = useState<File | null>(scanBild ?? null)
  const [uebernommen, setUebernommen] = useState(false)

  const uebernehmen = (v: AnschriftVorschlag): void => {
    // Nur was erkannt ist: ein leeres Feld im Vorschlag loescht nichts.
    const wenn = (w: string, setzen: (x: string) => void): void => {
      if (w.trim() !== '') setzen(w.trim())
    }
    wenn(v.name, setName)
    wenn(v.addressLine1, setAddressLine1)
    wenn(v.postalCode, setPostalCode)
    wenn(v.city, setCity)
    wenn(v.country.toUpperCase(), setCountry)
    wenn(v.vatId, setVatId)
    setScan(null)
    setUebernommen(true)
  }

  const anlegen = useCreateCompany()
  const aendern = usePatchCompany(initial?.companyRef ?? '')
  const speichern = initial ? aendern : anlegen

  const absenden = (): void => {
    setUebernommen(false)
    const ziel = paymentTermsDays.trim() === '' ? null : Number(paymentTermsDays)
    const body = {
      name: name.trim(),
      // Wie die Leitweg-ID: leer beim Aendern entfernt den Ansprechpartner.
      contactName: initial ? contactName.trim() : orUndef(contactName),
      vatId: orUndef(vatId), addressLine1: orUndef(addressLine1),
      postalCode: orUndef(postalCode), city: orUndef(city), country: orUndef(country) ?? 'DE',
      paymentTermsDays: ziel ?? undefined, invoiceEmail: orUndef(invoiceEmail),
      // Leer schickt einen leeren Text: so laesst sich eine Leitweg-ID
      // wieder entfernen, wenn die Firma doch keine Behoerde ist.
      buyerReference: initial ? leitweg.trim() : orUndef(leitweg)
    }
    if (initial) {
      // Leer beim Aendern loescht das eigene Ziel; dann gilt das des Hauses.
      aendern.mutate({ ...body, paymentTermsDays: ziel, active }, { onSuccess: onSaved })
    } else {
      anlegen.mutate(body, { onSuccess: onSaved })
    }
  }

  return (
    <div className="space-y-2 border border-neutral-200 rounded-sm p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium grow">{t('companies.title')}</h2>
        {darfSchreiben && scan === null && (
          <KarteFotografieren onBild={b => { setScan(b); setUebernommen(false) }}
                              className="text-xs px-2 py-1 border border-neutral-300 rounded-sm">
            📷 {t('visitenkarte.scan')}
          </KarteFotografieren>
        )}
      </div>
      {scan !== null && (
        // Der Schluessel baut den Scan je Foto neu auf: ein zweiter Scan
        // nach dem Verwerfen faengt mit leerem Vorschlag an.
        <VisitenkarteScan key={`${scan.name}-${scan.lastModified}`} erstesBild={scan}
                          onUebernehmen={uebernehmen} onSchliessen={() => setScan(null)} />
      )}
      {uebernommen && (
        <p className="text-xs text-sky-800">{t('visitenkarte.uebernommen')}</p>
      )}
      <Feld text={t('companies.name')}>
        <input value={name} onChange={e => setName(e.target.value)} disabled={!darfSchreiben}
               className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      </Feld>
      <Feld text={t('companies.contactName')}>
        <input value={contactName} onChange={e => setContactName(e.target.value)}
               disabled={!darfSchreiben}
               maxLength={200}
               className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      </Feld>
      <Feld text={t('companies.vatId')}>
        <input value={vatId} onChange={e => setVatId(e.target.value)} disabled={!darfSchreiben}
               className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      </Feld>
      <Feld text={t('companies.address')}>
        <input value={addressLine1} onChange={e => setAddressLine1(e.target.value)}
               disabled={!darfSchreiben}
               className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      </Feld>
      <div className="grid grid-cols-2 gap-2">
        <Feld text={t('companies.postalCode')}>
          <input value={postalCode} onChange={e => setPostalCode(e.target.value)}
                 disabled={!darfSchreiben}
                 className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        </Feld>
        <Feld text={t('companies.city')}>
          <input value={city} onChange={e => setCity(e.target.value)}
                 disabled={!darfSchreiben}
                 className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        </Feld>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Feld text={t('companies.country')}>
          <input value={country} onChange={e => setCountry(e.target.value)}
                 disabled={!darfSchreiben}
                 className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        </Feld>
        <Feld text={t('companies.paymentTerms')}>
          <input type="number" min={0} max={365} value={paymentTermsDays}
                 onChange={e => setPaymentTermsDays(e.target.value)}
                 disabled={!darfSchreiben} placeholder={t('companies.paymentTermsHouse')}
                 className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        </Feld>
      </div>
      <Feld text={t('companies.invoiceEmail')}>
        <input value={invoiceEmail} onChange={e => setInvoiceEmail(e.target.value)} type="email"
               disabled={!darfSchreiben}
               className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      </Feld>
      <Feld text={t('companies.buyerReference')}>
        <input value={leitweg} onChange={e => setLeitweg(e.target.value)}
               disabled={!darfSchreiben}
               className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm font-mono" />
      </Feld>
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
