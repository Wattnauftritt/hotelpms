import { useMemo, useState } from 'react'
import type { Charge, InvoiceRecipient } from '@hotelpms/contracts'
import { usePaymentMethods } from '../lib/queries.js'
import { useInvoicePreview, useIssueInvoiceWith, useCorrectCharge, useAddGrossCharge,
         useSendInvoice, type RechnungsAuftrag,
         type Empfaengerdaten } from '../lib/queries/billing.js'
import { usePatchCompany } from '../lib/queries/guests.js'
import { centAusEingabeMitVorzeichen, eingabeAusCent } from '../lib/preisraster.js'
import { newIdempotencyKey } from '../lib/api.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler } from './Shell.tsx'
import { ZahlwegWahl, type Zahlweg } from './ZahlwegWahl.tsx'

/**
 * Der Rechnungsdialog (Sven, 13.10.2026).
 *
 * Vorbefüllt aus Folio und Empfänger, aber vor dem Festschreiben anpassbar:
 * welche Positionen, an welche Anschrift, bis wann zahlbar oder schon
 * bezahlt, und auf Wunsch gleich per Mail hinaus.
 *
 * **Was hier nicht geht, mit Absicht.** Eine Position lässt sich nicht
 * umschreiben. Korrigiert wird durch Gegenbuchung und Neubuchung, beides
 * bleibt am Folio sichtbar (GoBD). Ein Nachlass ist eine eigene Position mit
 * negativem Betrag, kein stilles Herabsetzen. So sagen Folio und Rechnung
 * immer dasselbe.
 *
 * **Eine Rechnung, ein Rechenweg.** Die Summen kommen aus der Vorschau des
 * Servers, nicht aus dem Browser: derselbe Code schreibt danach fest. Zwei
 * Rechenwege liefen auseinander, und die Vorschau zeigte eine andere Summe
 * als das Papier.
 */

const FELDER = ['name', 'contactName', 'addressLine1', 'postalCode', 'city', 'country',
                'vatId'] as const
type Feld = typeof FELDER[number]
const FELD_TEXT = {
  name: 'companies.name', contactName: 'companies.contactName',
  addressLine1: 'companies.address',
  postalCode: 'companies.postalCode', city: 'companies.city',
  country: 'companies.country', vatId: 'companies.vatId'
} as const

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'

export function Rechnungsdialog({ folioRef, propertyId, offen, empfaenger, onClose }: {
  folioRef: string
  propertyId: number
  /** Offene Positionen ohne Kurtaxe, wie das Folio sie zeigt. */
  offen: Charge[]
  empfaenger: InvoiceRecipient
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const zahlarten = usePaymentMethods(propertyId)

  const [abgewaehlt, setAbgewaehlt] = useState<ReadonlySet<number>>(new Set())
  const [anschrift, setAnschrift] = useState<Partial<Record<Feld, string>> | null>(null)
  const [inFirma, setInFirma] = useState(false)
  const [faellig, setFaellig] = useState<string | null>(null)
  const [bezahlt, setBezahlt] = useState(false)
  const [zwischen, setZwischen] = useState(false)
  const [zahlart, setZahlart] = useState('')
  const [mail, setMail] = useState<string | null>(null)
  const [mailAn, setMailAn] = useState(false)
  const [zahlweg, setZahlweg] = useState<Zahlweg>({ transfer: false, paymentLink: false })
  // Ein Schluessel je Dialog: ein zweiter Klick verbraucht keine zweite Nummer.
  const [schluessel] = useState(newIdempotencyKey)

  const ausgewaehlt = offen.filter(c => !abgewaehlt.has(c.id)).map(c => c.id)
  const auftrag: RechnungsAuftrag = useMemo(() => ({
    // Nur bei einer Auswahl: alle offenen sind die Schlussrechnung, und nur
    // sie verrechnet eine Anzahlung.
    ...(abgewaehlt.size > 0 ? { chargeIds: ausgewaehlt } : {}),
    // Waehrend eines langen Aufenthalts: die Leistungen bis heute, die
    // Anzahlung bleibt fuer die Schlussrechnung (Pruefung 13.10.2026).
    ...(zwischen ? { kind: 'interim' as const } : {}),
    ...(anschrift !== null ? { recipient: anschrift } : {}),
    ...(faellig !== null && !bezahlt ? { dueOn: faellig } : {}),
    ...(bezahlt && zahlart !== '' ? { paid: { paymentMethodCode: zahlart } } : {})
  }), [abgewaehlt, anschrift, faellig, bezahlt, zahlart, zwischen, offen])

  const vorschau = useInvoicePreview(folioRef, auftrag, online && ausgewaehlt.length > 0)
  const festschreiben = useIssueInvoiceWith(folioRef, propertyId)
  const senden = useSendInvoice(propertyId)
  const firma = usePatchCompany(empfaenger.companyRef ?? '')

  const v = vorschau.data
  const geaendert = anschrift !== null
  const bereit = online && v !== undefined && !vorschau.isFetching && v.findings.length === 0
    && !v.prefixMissing && ausgewaehlt.length > 0 && (!bezahlt || zahlart !== '')
    && !festschreiben.isPending && !festschreiben.isSuccess

  const ausstellen = async (): Promise<void> => {
    if (!bereit || v === undefined) return
    // Erst die Firma, dann die Rechnung: schlaegt das Speichern fehl, steht
    // noch keine Rechnung, und niemand muss raten, was davon gegolten hat.
    if (inFirma && geaendert && empfaenger.companyRef !== null) {
      const r = v.recipient
      await firma.mutateAsync({
        name: r.name ?? undefined, contactName: r.contactName ?? '',
        addressLine1: r.addressLine1 ?? undefined,
        postalCode: r.postalCode ?? undefined, city: r.city ?? undefined,
        country: r.country ?? undefined, vatId: r.vatId ?? undefined })
    }
    const inv = await festschreiben.mutateAsync({ auftrag, key: schluessel })
    if (mailAn) {
      const an = (mail ?? v.recipientEmail ?? '').trim()
      senden.mutate({ invoiceRef: inv.invoiceRef, to: an,
                      ...(bezahlt ? {} : zahlweg) })
    }
  }

  if (festschreiben.isSuccess) {
    return (
      <section className="bg-white border border-neutral-200 rounded-sm p-3 space-y-2">
        <p role="status" className="text-sm text-emerald-800">
          ✓ {t('rdlg.done', { number: festschreiben.data.number })}
        </p>
        {senden.isSuccess && (
          <p role="status" className="text-sm text-emerald-800">{t('inv.send.queued')}</p>
        )}
        {senden.isError && <Fehler error={senden.error} />}
        <button onClick={onClose}
                className="text-sm px-3 py-1.5 border border-neutral-300 rounded-sm">
          {t('common.close')}
        </button>
      </section>
    )
  }

  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3 space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-medium">{t('rdlg.title')}</h3>
        <div className="grow" />
        <button onClick={onClose}
                className="text-xs px-2 py-1 border border-neutral-300 rounded-sm">
          {t('common.cancel')}
        </button>
      </div>

      <Positionen folioRef={folioRef} offen={offen} abgewaehlt={abgewaehlt}
                  setAbgewaehlt={setAbgewaehlt} />

      <label className="flex flex-wrap items-center gap-2 text-sm">
        <input type="checkbox" checked={zwischen} onChange={e => setZwischen(e.target.checked)} />
        {t('rdlg.interim')}
        <span className="text-xs text-neutral-500">{t('rdlg.interimHint')}</span>
      </label>

      <Anschrift vorgabe={v?.defaultRecipient} wert={v?.recipient} geaendert={geaendert}
                 setAnschrift={setAnschrift}
                 firma={empfaenger.kind === 'company' && empfaenger.companyRef !== null}
                 inFirma={inFirma} setInFirma={setInFirma} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('rdlg.payment')}</legend>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <input type="radio" checked={!bezahlt} onChange={() => setBezahlt(false)} />
          {t('rdlg.due')}
          <input type="date" disabled={bezahlt}
                 value={faellig ?? v?.dueOn ?? ''}
                 onChange={e => setFaellig(e.target.value === '' ? null : e.target.value)}
                 className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        </label>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <input type="radio" checked={bezahlt} onChange={() => setBezahlt(true)} />
          {t('rdlg.paidNow')}
          <select value={zahlart} disabled={!bezahlt}
                  onChange={e => setZahlart(e.target.value)}
                  aria-label={t('folio.method')}
                  className="border border-neutral-300 rounded-sm px-2 py-1 text-sm">
            <option value="">{t('folio.method')}</option>
            {(zahlarten.data?.paymentMethods ?? []).map(m =>
              <option key={m.code} value={m.code}>{m.name}</option>)}
          </select>
        </label>
      </fieldset>

      {vorschau.isError && <Fehler error={vorschau.error} />}
      {v !== undefined && (
        <div className="space-y-1 text-sm">
          {v.totals.groups.map(g => (
            <div key={g.rateBp} className="flex justify-between text-neutral-600">
              <span>{g.rateBp / 100} %</span>
              <span className="tabular-nums">{formatMoney(g.grossCent, locale)}</span>
            </div>
          ))}
          <div className="flex justify-between font-semibold">
            <span>{t('rdlg.total')}</span>
            <span className="tabular-nums">{formatMoney(v.totals.payableCent, locale)}</span>
          </div>
          {v.totals.prepaidCent > 0 && (
            <div className="flex justify-between text-neutral-600">
              <span>{t('rdlg.prepaid')}</span>
              <span className="tabular-nums">{formatMoney(-v.totals.prepaidCent, locale)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>{t('rdlg.openAmount')}</span>
            <span className="tabular-nums">{formatMoney(v.openCent, locale)}</span>
          </div>
          {v.dueOn !== null && !bezahlt && (
            <div className="text-xs text-neutral-500">
              {t('rdlg.due')} {formatDate(v.dueOn, locale)}
            </div>
          )}
        </div>
      )}

      {v !== undefined && (v.findings.length > 0 || v.prefixMissing) && (
        <div role="alert" className="rounded-sm border border-amber-200 bg-amber-50 p-2 text-sm">
          <div className="font-medium">{t('rdlg.findings')}</div>
          <ul className="list-disc ps-5">
            {v.prefixMissing && <li>{t('rdlg.prefixMissing')}</li>}
            {/* Die Pflichtangaben kommen aus der Domain, deutsch und
                englisch; sie nennen Paragraphen und bleiben deshalb nah am
                Gesetzestext. */}
            {v.findings.map(f => (
              <li key={f.key}>{locale === 'de' ? f.de : f.en} ({f.reference})</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mailAn} onChange={e => setMailAn(e.target.checked)} />
          {t('rdlg.sendMail')}
        </label>
        {mailAn && (
          <input type="email" value={mail ?? v?.recipientEmail ?? ''}
                 onChange={e => setMail(e.target.value)}
                 aria-label={t('inv.send.to')}
                 className="border border-neutral-300 rounded-sm px-2 py-1 text-sm w-72" />
        )}
        {mailAn && !bezahlt && <ZahlwegWahl wert={zahlweg} setWert={setZahlweg} />}
      </div>

      {festschreiben.isError && <Fehler error={festschreiben.error} />}
      {firma.isError && <Fehler error={firma.error} />}
      <button onClick={() => { void ausstellen() }} disabled={!bereit}
              className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                         disabled:bg-neutral-300">
        {t('rdlg.issue', { number: v?.nextNumber ?? '' })}
      </button>
    </section>
  )
}

function Positionen({ folioRef, offen, abgewaehlt, setAbgewaehlt }: {
  folioRef: string
  offen: Charge[]
  abgewaehlt: ReadonlySet<number>
  setAbgewaehlt: (s: ReadonlySet<number>) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [korrektur, setKorrektur] = useState<number | null>(null)

  const umschalten = (id: number): void => {
    const neu = new Set(abgewaehlt)
    if (neu.has(id)) neu.delete(id); else neu.add(id)
    setAbgewaehlt(neu)
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{t('rdlg.positions')}</div>
      <ul className="divide-y divide-neutral-100 text-sm">
        {offen.map(c => (
          <li key={c.id} className="py-1">
            <div className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={!abgewaehlt.has(c.id)}
                     onChange={() => umschalten(c.id)} aria-label={c.description} />
              <span className="w-24 text-neutral-500">{formatDate(c.business_date, locale)}</span>
              <span className="grow">{c.description}</span>
              <span className="text-xs text-neutral-500">{c.tax_rate_bp / 100} %</span>
              <span className="w-24 text-end tabular-nums">
                {formatMoney(c.gross_cent, locale)}
              </span>
              {/* Eine Gegenbuchung laesst sich nicht noch einmal korrigieren. */}
              {c.reverses_id === null && (
                <button onClick={() => setKorrektur(korrektur === c.id ? null : c.id)}
                        className="text-xs px-2 py-0.5 border border-neutral-300 rounded-sm">
                  {t('rdlg.correct')}
                </button>
              )}
            </div>
            {korrektur === c.id && (
              <Korrektur folioRef={folioRef} position={c} onFertig={() => setKorrektur(null)} />
            )}
          </li>
        ))}
      </ul>
      <div className="text-xs text-neutral-500">{t('rdlg.positionsHint')}</div>
      <NeueZeile folioRef={folioRef} />
    </div>
  )
}

function Korrektur({ folioRef, position, onFertig }: {
  folioRef: string; position: Charge; onFertig: () => void
}): JSX.Element {
  const t = useT()
  const korrigieren = useCorrectCharge(folioRef)
  const [text, setText] = useState(position.description)
  const [betrag, setBetrag] = useState(eingabeAusCent(position.gross_cent))
  const cent = centAusEingabeMitVorzeichen(betrag)

  return (
    <form className="mt-1 ms-6 space-y-1 rounded-sm bg-neutral-50 p-2"
          onSubmit={e => {
            e.preventDefault()
            if (cent === null || text.trim() === '') return
            korrigieren.mutate({ chargeId: position.id, description: text.trim(),
                                 grossCent: cent, taxRateBp: position.tax_rate_bp },
                               { onSuccess: onFertig })
          }}>
      <div className="flex flex-wrap gap-2">
        <label className="text-xs grow">{t('folio.description')}
          <input value={text} onChange={e => setText(e.target.value)} className={eingabe} />
        </label>
        <label className="text-xs w-32">{t('rdlg.newAmount')}
          <input value={betrag} onChange={e => setBetrag(e.target.value)} inputMode="decimal"
                 aria-invalid={cent === null} className={`${eingabe} text-end`} />
        </label>
      </div>
      <div className="text-xs text-neutral-500">{t('rdlg.correctHint')}</div>
      {korrigieren.isError && <Fehler error={korrigieren.error} />}
      <button type="submit" disabled={cent === null || korrigieren.isPending}
              className="text-xs px-2 py-1 rounded-sm bg-neutral-900 text-white
                         disabled:bg-neutral-300">
        {t('rdlg.correct')}
      </button>
    </form>
  )
}

function NeueZeile({ folioRef }: { folioRef: string }): JSX.Element {
  const t = useT()
  const buchen = useAddGrossCharge(folioRef)
  const [text, setText] = useState('')
  const [betrag, setBetrag] = useState('')
  const [satz, setSatz] = useState(1900)
  const cent = centAusEingabeMitVorzeichen(betrag)

  return (
    <form className="space-y-1"
          onSubmit={e => {
            e.preventDefault()
            if (cent === null || cent === 0 || text.trim() === '') return
            buchen.mutate({ description: text.trim(), grossCent: cent, taxRateBp: satz },
              { onSuccess: () => { setText(''); setBetrag('') } })
          }}>
      <div className="text-xs text-neutral-600">{t('rdlg.addLine')}</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs grow">{t('folio.description')}
          <input value={text} onChange={e => setText(e.target.value)} className={eingabe} />
        </label>
        <label className="text-xs w-32">{t('rdlg.gross')}
          <input value={betrag} onChange={e => setBetrag(e.target.value)} inputMode="decimal"
                 placeholder="-10,00" className={`${eingabe} text-end`} />
        </label>
        <label className="text-xs">{t('folio.taxRate')}
          <select value={satz} onChange={e => setSatz(Number(e.target.value))}
                  className={eingabe}>
            <option value={700}>7 %</option>
            <option value={1900}>19 %</option>
          </select>
        </label>
        <button type="submit"
                disabled={cent === null || cent === 0 || text.trim() === '' || buchen.isPending}
                className="text-xs px-2 py-1.5 border border-neutral-300 rounded-sm
                           disabled:opacity-40">
          {t('folio.post')}
        </button>
      </div>
      <div className="text-xs text-neutral-500">{t('rdlg.addHint')}</div>
      {buchen.isError && <Fehler error={buchen.error} />}
    </form>
  )
}

function Anschrift({ vorgabe, wert, geaendert, setAnschrift, firma, inFirma, setInFirma }: {
  vorgabe: Empfaengerdaten | undefined
  wert: Empfaengerdaten | undefined
  geaendert: boolean
  setAnschrift: (a: Partial<Record<Feld, string>> | null) => void
  firma: boolean
  inFirma: boolean
  setInFirma: (b: boolean) => void
}): JSX.Element {
  const t = useT()
  // Getippt wird lokal; an die Vorschau geht es erst beim Verlassen des
  // Feldes, sonst kostete jeder Buchstabe eine Anfrage.
  const [entwurf, setEntwurf] = useState<Partial<Record<Feld, string>>>({})
  const anzeigen = (f: Feld): string => entwurf[f] ?? wert?.[f] ?? ''

  const uebernehmen = (): void => {
    if (Object.keys(entwurf).length === 0) return
    const neu: Partial<Record<Feld, string>> = {}
    for (const f of FELDER) {
      const x = entwurf[f] ?? wert?.[f] ?? ''
      if (x !== (vorgabe?.[f] ?? '')) neu[f] = x
    }
    setAnschrift(Object.keys(neu).length === 0 ? null : neu)
    setEntwurf({})
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('rdlg.recipient')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {FELDER.map(f => (
          <label key={f} className={`text-xs ${f === 'name' || f === 'contactName'
                                                || f === 'addressLine1'
                                                ? 'sm:col-span-2' : ''}`}>
            {t(FELD_TEXT[f])}
            <input value={anzeigen(f)} onBlur={uebernehmen}
                   onChange={e => setEntwurf({ ...entwurf, [f]: f === 'country'
                     ? e.target.value.toUpperCase() : e.target.value })}
                   maxLength={f === 'country' ? 2 : 200} className={eingabe} />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
        <span>{t('rdlg.recipientHint')}</span>
        {geaendert && (
          <button type="button" onClick={() => { setAnschrift(null); setEntwurf({}) }}
                  className="px-2 py-0.5 border border-neutral-300 rounded-sm">
            {t('rdlg.reset')}
          </button>
        )}
        {geaendert && firma && (
          <label className="flex items-center gap-1 text-neutral-700">
            <input type="checkbox" checked={inFirma}
                   onChange={e => setInFirma(e.target.checked)} />
            {t('rdlg.saveToCompany')}
          </label>
        )}
      </div>
    </fieldset>
  )
}

