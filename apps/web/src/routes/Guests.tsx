import { useState } from 'react'
import type { Guest, GuestCreated, Company } from '@hotelpms/contracts'
import { useSearchGuests, useGuest, useCreateGuest, usePatchGuest, useIdDocument,
         useSearchCompanies, useCompany, useCreateCompany, usePatchCompany }
  from '../lib/queries/guests.js'
import { useHausrechte } from '../lib/rechte.js'
import { useReiter } from '../lib/reiter.js'
import { useT } from '../lib/i18n/index.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

const BEREICHE = ['guests', 'companies'] as const
type Bereich = (typeof BEREICHE)[number]

function orUndef(s: string): string | undefined {
  const w = s.trim()
  return w === '' ? undefined : w
}

/**
 * Gästesuche und -profil (A6), mit Firmen (A10) als zweitem Reiter -- beide
 * teilen sich Suche, Anlegen und Profilansicht, und im Entwurf war fuer
 * Firmen kein eigener Bildschirm vorgesehen.
 *
 * Keine Ausweiskopie, kein Feld dafuer (§ 30 BMG). Die Nummer selbst steht
 * maskiert und erst nach einem ausdruecklichen Klick im Klartext, hinter
 * `guest:read_identity` -- jeder Abruf im Klartext wird protokolliert, ein
 * automatischer Aufruf beim Oeffnen des Profils waere ein Protokolleintrag
 * ohne dass die Rezeption ihn wollte.
 */
export function Guests({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const { darf, geladen } = useHausrechte(propertyId)
  const [reiter, setReiter] = useReiter<Bereich>('gaestereiter', BEREICHE, 'guests')

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t('guests.title')}</h1>

      <div className="flex flex-wrap gap-1 border-b border-neutral-200">
        {BEREICHE.map(b => (
          <button key={b} onClick={() => setReiter(b)}
                  aria-current={b === reiter ? 'page' : undefined}
                  className={`text-sm px-3 py-1.5 -mb-px border-b-2 ${
                    b === reiter
                      ? 'border-neutral-900 font-medium'
                      : 'border-transparent text-neutral-600 hover:text-neutral-900'}`}>
            {t(b === 'guests' ? 'guests.title' : 'companies.title')}
          </button>
        ))}
      </div>

      {!geladen ? <Laedt />
        : reiter === 'guests'
          ? <GaesteReiter darfSchreiben={darf('guest:write')}
                          darfIdentitaet={darf('guest:read_identity')} />
          : <FirmenReiter darfSchreiben={darf('guest:write')} />}
    </div>
  )
}

function GaesteReiter({ darfSchreiben, darfIdentitaet }: {
  darfSchreiben: boolean; darfIdentitaet: boolean
}): JSX.Element {
  const t = useT()
  const [begriff, setBegriff] = useState('')
  const [ausgewaehlt, setAusgewaehlt] = useState<string | 'new' | null>(null)
  const suche = useSearchGuests(begriff)

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="space-y-2">
        <input value={begriff} onChange={e => setBegriff(e.target.value)}
               placeholder={t('guests.searchPlaceholder')}
               className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm" />
        {begriff.trim().length > 0 && begriff.trim().length < 2 && (
          <div className="text-xs text-neutral-500">{t('guests.searchHint')}</div>
        )}
        {suche.isError && <Fehler error={suche.error} />}
        {suche.data !== undefined && (
          suche.data.guests.length === 0
            ? <div className="text-xs text-neutral-500">{t('guests.noResults')}</div>
            : <ul className="border border-neutral-200 rounded divide-y divide-neutral-100">
                {suche.data.guests.map(g => (
                  <li key={g.guestRef}>
                    <button type="button" onClick={() => setAusgewaehlt(g.guestRef)}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-neutral-50
                                        ${ausgewaehlt === g.guestRef ? 'bg-neutral-50' : ''}`}>
                      {g.lastName}{g.firstName ? `, ${g.firstName}` : ''}
                      {g.email && <span className="text-neutral-400"> · {g.email}</span>}
                    </button>
                  </li>
                ))}
              </ul>
        )}
        {darfSchreiben && (
          <button type="button" onClick={() => setAusgewaehlt('new')}
                  className="text-sm text-neutral-600 underline">
            + {t('guests.new')}
          </button>
        )}
      </div>

      <div>
        {ausgewaehlt === null && <div className="text-sm text-neutral-400">—</div>}
        {ausgewaehlt === 'new' && (
          <GastFormular darfSchreiben={darfSchreiben}
                        onSaved={g => setAusgewaehlt(g.guestRef)} />
        )}
        {ausgewaehlt !== null && ausgewaehlt !== 'new' && (
          <GastProfil guestRef={ausgewaehlt} darfSchreiben={darfSchreiben}
                      darfIdentitaet={darfIdentitaet} />
        )}
      </div>
    </div>
  )
}

function GastProfil({ guestRef, darfSchreiben, darfIdentitaet }: {
  guestRef: string; darfSchreiben: boolean; darfIdentitaet: boolean
}): JSX.Element {
  const t = useT()
  const q = useGuest(guestRef)

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  // Ein anonymisiertes Profil (Art. 17 DSGVO) wird nicht wiederbelebt -- die
  // API lehnt eine Aenderung ab, das Formular zeigt es deshalb gar nicht erst.
  if (q.data.status === 'anonymized') {
    return (
      <div className="border border-neutral-200 rounded p-3 space-y-1">
        <h2 className="text-sm font-medium">{q.data.lastName}</h2>
        <p className="text-sm text-neutral-500">{t('guests.anonymized')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <GastFormular initial={q.data} darfSchreiben={darfSchreiben} onSaved={() => {}} />
      <AusweisFeld guestRef={guestRef} hasIdDocumentNumber={q.data.hasIdDocumentNumber}
                    idDocumentType={q.data.idDocumentType} darfLesen={darfIdentitaet} />
    </div>
  )
}

function GastFormular({ initial, darfSchreiben, onSaved }: {
  initial?: Guest; darfSchreiben: boolean; onSaved: (g: Guest) => void
}): JSX.Element {
  const t = useT()
  const [lastName, setLastName] = useState(initial?.lastName ?? '')
  const [firstName, setFirstName] = useState(initial?.firstName ?? '')
  const [email, setEmail] = useState(initial?.email ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [birthDate, setBirthDate] = useState(initial?.birthDate ?? '')
  const [nationality, setNationality] = useState(initial?.nationality ?? '')
  const [addressLine1, setAddressLine1] = useState(initial?.address.line1 ?? '')
  const [postalCode, setPostalCode] = useState(initial?.address.postalCode ?? '')
  const [city, setCity] = useState(initial?.address.city ?? '')
  const [country, setCountry] = useState(initial?.address.country ?? '')
  const [duplikate, setDuplikate] = useState<GuestCreated['possibleDuplicates']>([])

  const anlegen = useCreateGuest()
  const aendern = usePatchGuest(initial?.guestRef ?? '')
  const speichern = initial ? aendern : anlegen

  const absenden = (): void => {
    const body = {
      lastName: lastName.trim(), firstName: orUndef(firstName), email: orUndef(email),
      phone: orUndef(phone), birthDate: orUndef(birthDate), nationality: orUndef(nationality),
      addressLine1: orUndef(addressLine1), postalCode: orUndef(postalCode),
      city: orUndef(city), country: orUndef(country)
    }
    if (initial) {
      aendern.mutate(body, { onSuccess: onSaved })
    } else {
      anlegen.mutate(body, { onSuccess: g => { setDuplikate(g.possibleDuplicates); onSaved(g) } })
    }
  }

  return (
    <div className="space-y-2 border border-neutral-200 rounded p-3">
      <h2 className="text-sm font-medium">{t('guests.profile')}</h2>
      <div className="grid grid-cols-2 gap-2">
        <input value={lastName} onChange={e => setLastName(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('guests.lastName')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
        <input value={firstName} onChange={e => setFirstName(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('guests.firstName')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
      </div>
      <input value={email} onChange={e => setEmail(e.target.value)} type="email"
             disabled={!darfSchreiben} placeholder={t('guests.email')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <input value={phone} onChange={e => setPhone(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('guests.phone')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
        <input value={birthDate} onChange={e => setBirthDate(e.target.value)} type="date"
               disabled={!darfSchreiben}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
      </div>
      <input value={nationality} onChange={e => setNationality(e.target.value)}
             disabled={!darfSchreiben} placeholder={t('guests.nationality')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      <input value={addressLine1} onChange={e => setAddressLine1(e.target.value)}
             disabled={!darfSchreiben} placeholder={t('guests.address')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <input value={postalCode} onChange={e => setPostalCode(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('guests.postalCode')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
        <input value={city} onChange={e => setCity(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('guests.city')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
      </div>
      <input value={country} onChange={e => setCountry(e.target.value)}
             disabled={!darfSchreiben} placeholder={t('guests.country')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />

      {duplikate.length > 0 && (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
          <div className="font-medium">{t('guests.duplicateWarning')}</div>
          {duplikate.map(d => <div key={d.guestRef}>{d.reason} ({d.guestRef})</div>)}
        </div>
      )}

      {speichern.isError && <Fehler error={speichern.error} />}
      {darfSchreiben && (
        <div className="flex items-center gap-3">
          <button type="button" disabled={lastName.trim() === '' || speichern.isPending}
                  onClick={absenden}
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('guests.save')}
          </button>
          {speichern.isSuccess && (
            <span className="text-xs text-emerald-700">✓ {t('guests.saved')}</span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Ausweisnummer, maskiert bis zu einem ausdruecklichen Klick (A6). § 30 BMG
 * erlaubt die Nummer, nicht die Kopie -- es gibt kein Feld fuer einen Upload.
 */
function AusweisFeld({ guestRef, hasIdDocumentNumber, idDocumentType, darfLesen }: {
  guestRef: string; hasIdDocumentNumber: boolean
  idDocumentType: string | null; darfLesen: boolean
}): JSX.Element {
  const t = useT()
  const [zeigen, setZeigen] = useState(false)
  const dok = useIdDocument(zeigen ? guestRef : null, true)

  return (
    <div className="border border-neutral-200 rounded p-3">
      <div className="text-xs text-neutral-500">{t('guests.idDocument')}</div>
      {!hasIdDocumentNumber
        ? <div className="text-sm text-neutral-400">{t('guests.idDocumentNone')}</div>
        : zeigen
          ? <div className="text-sm tabular-nums">
              {dok.data?.number ?? '…'}{idDocumentType ? ` (${idDocumentType})` : ''}
            </div>
          : <div className="text-sm flex items-center gap-2">
              <span className="text-neutral-400">••••••••</span>
              {darfLesen && (
                <button type="button" onClick={() => setZeigen(true)}
                        className="text-xs underline text-neutral-600">
                  {t('guests.idDocumentReveal')}
                </button>
              )}
            </div>}
      <p className="mt-1 text-xs text-neutral-500">{t('guests.idDocumentHint')}</p>
    </div>
  )
}

function FirmenReiter({ darfSchreiben }: { darfSchreiben: boolean }): JSX.Element {
  const t = useT()
  const [begriff, setBegriff] = useState('')
  const [ausgewaehlt, setAusgewaehlt] = useState<string | 'new' | null>(null)
  const suche = useSearchCompanies(begriff)

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="space-y-2">
        <input value={begriff} onChange={e => setBegriff(e.target.value)}
               placeholder={t('companies.searchPlaceholder')}
               className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm" />
        {begriff.trim().length > 0 && begriff.trim().length < 2 && (
          <div className="text-xs text-neutral-500">{t('guests.searchHint')}</div>
        )}
        {suche.isError && <Fehler error={suche.error} />}
        {suche.data !== undefined && (
          suche.data.companies.length === 0
            ? <div className="text-xs text-neutral-500">{t('guests.noResults')}</div>
            : <ul className="border border-neutral-200 rounded divide-y divide-neutral-100">
                {suche.data.companies.map(f => (
                  <li key={f.companyRef}>
                    <button type="button" onClick={() => setAusgewaehlt(f.companyRef)}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-neutral-50
                                        ${ausgewaehlt === f.companyRef ? 'bg-neutral-50' : ''}`}>
                      {f.name}
                      {f.city && <span className="text-neutral-400"> · {f.city}</span>}
                    </button>
                  </li>
                ))}
              </ul>
        )}
        {darfSchreiben && (
          <button type="button" onClick={() => setAusgewaehlt('new')}
                  className="text-sm text-neutral-600 underline">
            + {t('companies.new')}
          </button>
        )}
      </div>

      <div>
        {ausgewaehlt === null && <div className="text-sm text-neutral-400">—</div>}
        {ausgewaehlt === 'new' && (
          <FirmaFormular darfSchreiben={darfSchreiben}
                        onSaved={f => setAusgewaehlt(f.companyRef)} />
        )}
        {ausgewaehlt !== null && ausgewaehlt !== 'new' && (
          <FirmaProfil companyRef={ausgewaehlt} darfSchreiben={darfSchreiben} />
        )}
      </div>
    </div>
  )
}

function FirmaProfil({ companyRef, darfSchreiben }: {
  companyRef: string; darfSchreiben: boolean
}): JSX.Element {
  const q = useCompany(companyRef)
  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  return <FirmaFormular initial={q.data} darfSchreiben={darfSchreiben} onSaved={() => {}} />
}

function FirmaFormular({ initial, darfSchreiben, onSaved }: {
  initial?: Company; darfSchreiben: boolean
  onSaved: (f: { companyRef: string; name: string }) => void
}): JSX.Element {
  const t = useT()
  const [name, setName] = useState(initial?.name ?? '')
  const [vatId, setVatId] = useState(initial?.vatId ?? '')
  const [addressLine1, setAddressLine1] = useState(initial?.addressLine1 ?? '')
  const [postalCode, setPostalCode] = useState(initial?.postalCode ?? '')
  const [city, setCity] = useState(initial?.city ?? '')
  const [country, setCountry] = useState(initial?.country ?? 'DE')
  const [paymentTermsDays, setPaymentTermsDays] = useState(initial?.paymentTermsDays ?? 14)
  const [invoiceEmail, setInvoiceEmail] = useState(initial?.invoiceEmail ?? '')
  const [active, setActive] = useState(initial?.active ?? true)

  const anlegen = useCreateCompany()
  const aendern = usePatchCompany(initial?.companyRef ?? '')
  const speichern = initial ? aendern : anlegen

  const absenden = (): void => {
    const body = {
      name: name.trim(), vatId: orUndef(vatId), addressLine1: orUndef(addressLine1),
      postalCode: orUndef(postalCode), city: orUndef(city), country: orUndef(country) ?? 'DE',
      paymentTermsDays, invoiceEmail: orUndef(invoiceEmail)
    }
    if (initial) {
      aendern.mutate({ ...body, active }, { onSuccess: onSaved })
    } else {
      anlegen.mutate(body, { onSuccess: onSaved })
    }
  }

  return (
    <div className="space-y-2 border border-neutral-200 rounded p-3">
      <h2 className="text-sm font-medium">{t('companies.title')}</h2>
      <input value={name} onChange={e => setName(e.target.value)} disabled={!darfSchreiben}
             placeholder={t('companies.name')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      <input value={vatId} onChange={e => setVatId(e.target.value)} disabled={!darfSchreiben}
             placeholder={t('companies.vatId')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      <input value={addressLine1} onChange={e => setAddressLine1(e.target.value)}
             disabled={!darfSchreiben} placeholder={t('companies.address')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <input value={postalCode} onChange={e => setPostalCode(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('companies.postalCode')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
        <input value={city} onChange={e => setCity(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('companies.city')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input value={country} onChange={e => setCountry(e.target.value)}
               disabled={!darfSchreiben} placeholder={t('companies.country')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
        <input type="number" min={0} value={paymentTermsDays}
               onChange={e => setPaymentTermsDays(Number(e.target.value))}
               disabled={!darfSchreiben} placeholder={t('companies.paymentTerms')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm" />
      </div>
      <input value={invoiceEmail} onChange={e => setInvoiceEmail(e.target.value)} type="email"
             disabled={!darfSchreiben} placeholder={t('companies.invoiceEmail')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
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
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
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
