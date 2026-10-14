import { useState } from 'react'
import { useFolio, usePaymentMethods, usePostCharge,
         usePostSettlement } from '../lib/queries.js'
import { useSplitFolio, useTransferCharge,
         useAccommodationRouting } from '../lib/queries/billing.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { apiText } from '../lib/meldungen.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Vorauszahlung } from '../components/Vorauszahlung.tsx'
import { Rechnungsempfaenger } from '../components/Rechnungsempfaenger.tsx'
import { Rechnungsdialog } from '../components/Rechnungsdialog.tsx'
import { centAusEingabeMitVorzeichen } from '../lib/preisraster.js'
import type { FolioView } from '@hotelpms/contracts'

/**
 * Das Folio: Positionen, Zahlungsvermerke, Saldo.
 *
 * Drei Dinge sind hier bewusst so und nicht anders:
 *
 * 1. **Es gibt keinen Löschknopf.** Positionen sind Härtegrad 1 und
 *    unveränderlich. Eine Korrektur ist eine Gegenbuchung mit negativem
 *    Betrag, und sie steht sichtbar darunter. Wer das versteckt, versteckt
 *    genau das, was eine Betriebsprüfung sehen will.
 * 2. **Ein Zahlungsvermerk wickelt nichts ab.** Dieses System führt keinen
 *    Kassenbestand und erzeugt keinen Bon. Es hält fest, wo abgerechnet
 *    wurde; die Zahlung selbst läuft über Kasse, Portal oder Bank des
 *    Betriebs (Entscheidung 9).
 * 3. **Fakturierte Positionen sind erkennbar.** Was auf einer Rechnung
 *    steht, ist festgeschrieben. Die Oberfläche zeigt das, statt es beim
 *    Versuch einer Änderung mit einer Fehlermeldung zu beantworten.
 */
export function Folio({ folioRef, propertyId, permissions, onFolio, onClose }: {
  folioRef: string; propertyId: number; permissions: readonly string[]
  onFolio: (folioRef: string) => void; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const q = useFolio(folioRef)
  const zahlarten = usePaymentMethods(propertyId)
  const [dialog, setDialog] = useState(false)
  const umbuchen = useTransferCharge(folioRef)
  const darfUmbuchen = permissions.includes('folio:route')

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const f = q.data

  // Die Kurtaxe steht auf keiner Rechnung (Beleg ist die Kurkarte). Zaehlte
  // sie als offen, boete die Maske ein Abrechnen an, das nichts abrechnet.
  const offen = f.charges.filter(c => c.invoice_id === null && !c.city_tax)
  const gegengebucht = new Set(f.charges.map(c => c.reverses_id).filter(x => x !== null))
  const andere = f.stay.filter(x => x.folioRef !== folioRef)
  const umbuchbar = darfUmbuchen && online && f.folio.status === 'open' && andere.length > 0

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-3">
        <button onClick={onClose}
                className="text-sm px-2 py-1 border border-neutral-300 rounded-sm">
          ← {t('common.back')}
        </button>
        <h2 className="text-sm font-medium">
          {t('folio.title')} {f.folio.public_ref}
          {f.folio.label !== null && <span className="text-neutral-500"> · {f.folio.label}</span>}
        </h2>
        {f.folio.status === 'closed' && (
          <span className="text-xs px-2 py-0.5 rounded-sm bg-neutral-200">{t('folio.closed')}</span>
        )}
        <div className="grow" />
        <span className={`text-lg tabular-nums font-medium
                          ${f.balanceCent > 0 ? 'text-red-700'
                            : f.balanceCent < 0 ? 'text-emerald-700' : ''}`}>
          {formatMoney(f.balanceCent, locale)}
        </span>
      </div>

      {f.stay.length > 0 && (
        <Aufenthalt folioRef={folioRef} folio={f} onFolio={onFolio}
                    darf={darfUmbuchen && online && f.folio.status === 'open'} />
      )}

      <section className="bg-white border border-neutral-200 rounded-sm overflow-hidden">
        <h3 className="px-3 py-2 text-sm font-medium border-b border-neutral-200">
          {t('folio.charges')}
        </h3>
        {umbuchen.isError && <div className="p-2"><Fehler error={umbuchen.error} /></div>}
        <table className="w-full text-sm">
          <tbody className="divide-y divide-neutral-100">
            {f.charges.map(c => (
              <tr key={c.id} className={c.gross_cent < 0 ? 'text-emerald-800' : ''}>
                <td className="px-3 py-1.5 w-24 text-neutral-500 tabular-nums">
                  {formatDate(c.business_date, locale)}
                </td>
                <td className="px-3 py-1.5">
                  {c.description}
                  {c.reverses_id !== null && (
                    <span className="ml-1 text-xs text-neutral-500">({t('folio.reversal')})</span>
                  )}
                  {c.city_tax && (
                    <span className="ms-1 text-xs text-neutral-500">
                      ({t('folio.cityTaxNotInvoiced')})
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 w-14 text-end tabular-nums text-neutral-500">
                  {c.quantity}
                </td>
                <td className="px-3 py-1.5 w-16 text-end tabular-nums text-neutral-500">
                  {c.tax_rate_bp / 100} %
                </td>
                <td className="px-3 py-1.5 w-24 text-end tabular-nums">
                  {formatMoney(c.gross_cent, locale)}
                </td>
                <td className="px-3 py-1.5 w-8 text-center">
                  {c.invoice_id !== null && (
                    <span title={t('folio.invoiced')} className="text-neutral-400">🔒</span>
                  )}
                </td>
                {umbuchbar && (
                  <td className="px-2 py-1 w-36">
                    {c.invoice_id === null && c.reverses_id === null
                     && !gegengebucht.has(c.id) && (
                      <select value="" disabled={umbuchen.isPending}
                              aria-label={t('folio.transferTo')}
                              onChange={e => {
                                if (e.target.value !== '') {
                                  umbuchen.mutate({ chargeId: c.id,
                                                    targetFolioRef: e.target.value })
                                }
                              }}
                              className="w-full border border-neutral-300 rounded-sm px-1 py-0.5
                                         text-xs bg-white">
                        <option value="">{t('folio.transferTo')}</option>
                        {andere.map(x => (
                          <option key={x.folioRef} value={x.folioRef}>
                            {kontoName(x, t)}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {f.charges.length === 0 && (
              <tr><td className="px-3 py-3 text-neutral-400">{t('common.none')}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {f.invoices.length > 0 && (
        <section className="bg-white border border-neutral-200 rounded-sm overflow-hidden">
          <h3 className="px-3 py-2 text-sm font-medium border-b border-neutral-200">
            {t('inv.title')}
          </h3>
          <ul className="divide-y divide-neutral-100 text-sm">
            {f.invoices.map(i => (
              <li key={i.invoiceRef} className="px-3 py-1.5 flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono">{i.number}</span>
                <span className="text-neutral-500">{formatDate(i.issuedOn, locale)}</span>
                <span className="text-xs text-neutral-600">
                  {t(`inv.kind.${i.kind}` as 'inv.kind.final')}
                </span>
                {i.cancelledBy !== null && (
                  <span className="text-xs text-neutral-500">
                    {t('inv.cancelledBy', { number: i.cancelledBy })}
                  </span>
                )}
                <span className="grow" />
                <span className="tabular-nums">{formatMoney(i.grossCent, locale)}</span>
                {/* Ein Link statt eines eingebetteten Blatts: iOS zeigt ein
                    PDF im iframe oft gar nicht an, ein geoeffneter Beleg
                    geht ueberall. */}
                {i.documentReady
                  ? <a href={`/v1/invoices/${i.invoiceRef}/pdf?inline=1`} target="_blank" rel="noreferrer"
                       className="text-xs px-2 py-0.5 rounded-sm border border-neutral-300
                                  hover:bg-neutral-50">
                      {t('inv.openDocument')}
                    </a>
                  : <span className="text-xs text-amber-800">{t('inv.document.pending')}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bg-white border border-neutral-200 rounded-sm overflow-hidden">
        <h3 className="px-3 py-2 text-sm font-medium border-b border-neutral-200">
          {t('folio.settlements')}
        </h3>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-neutral-100">
            {f.settlements.map(s => (
              <tr key={s.id}>
                <td className="px-3 py-1.5 w-24 text-neutral-500 tabular-nums">
                  {formatDate(s.business_date, locale)}
                </td>
                <td className="px-3 py-1.5">{s.method}</td>
                <td className="px-3 py-1.5 text-neutral-500 text-xs">
                  {s.external_reference}
                </td>
                <td className="px-3 py-1.5 w-24 text-end tabular-nums">
                  {formatMoney(s.amount_cent, locale)}
                </td>
              </tr>
            ))}
            {f.settlements.length === 0 && (
              <tr><td className="px-3 py-3 text-neutral-400">{t('common.none')}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Der Empfaenger steht ueber den Eingabefeldern, weil er vor dem
          Fakturieren stimmen muss: auf einem festgeschriebenen Beleg ist er
          eine Momentaufnahme und nicht mehr zu aendern. */}
      <Rechnungsempfaenger folioRef={folioRef} recipient={f.recipient}
                           geschlossen={f.folio.status === 'closed'} />

      {/* Anzahlung und Zahlungslink stehen zwischen dem Bestand und den
          Eingabefeldern: sie setzen einen Zahlungsvermerk voraus und gehen
          dem Fakturieren voraus. Zugeklappt kosten sie keinen Aufruf. */}
      {online && (
        <Vorauszahlung folioRef={folioRef} saldoCent={f.balanceCent}
                       stand={f.charges.length - offen.length}
                       geschlossen={f.folio.status === 'closed'} />
      )}

      {f.folio.status === 'open' && online && (
        <div className="grid gap-4 lg:grid-cols-2">
          <NeuePosition folioRef={folioRef} />
          <NeueZahlung folioRef={folioRef} offenCent={f.balanceCent}
                       methoden={zahlarten.data?.paymentMethods ?? []}
                       hinweis={apiText(zahlarten.data?.hinweisKey,
                                        zahlarten.data?.hinweis ?? '', locale)} />
        </div>
      )}

      {/* Der Dialog statt eines Knopfs (Sven, 13.10.2026): vorbefuellt, aber
          vor dem Festschreiben anpassbar. Ein festgeschriebener Beleg ist
          Haertegrad 1; was danach nicht stimmt, braucht eine Stornorechnung. */}
      {offen.length > 0 && online && (dialog
        ? <Rechnungsdialog folioRef={folioRef} propertyId={propertyId} offen={offen}
                           empfaenger={f.recipient} onClose={() => setDialog(false)} />
        : (
          <section className="bg-white border border-neutral-200 rounded-sm p-3">
            <div className="flex items-center gap-3">
              <button onClick={() => setDialog(true)}
                      className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white">
                {t('folio.issueInvoice')} ({offen.length})
              </button>
              <span className="text-xs text-neutral-500">{t('folio.issueHint')}</span>
            </div>
          </section>
        ))}
    </div>
  )
}

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'

type Konto = FolioView['stay'][number]

function kontoName(k: Konto, t: ReturnType<typeof useT>): string {
  const name = k.label ?? (k.main ? t('folio.main') : t('folio.split'))
  // Ein anderes Zimmer der Gruppe (Sammelrechnung) heisst nach dem Zimmer.
  return k.ownStay ? name : `${t('common.room')} ${k.room ?? '–'} · ${name}`
}

/**
 * Die Folios der Buchung (Split, bei Gruppen auch die der anderen Zimmer):
 * Wechsel zwischen ihnen, ein weiteres anlegen, die Uebernachtungen
 * umleiten.
 *
 * "Firma zahlt Logis, Gast zahlt Extras" ging bisher nur ueber eine
 * Rechnung mit abgewaehlten Positionen, und der Rest stand unbemerkt
 * offen (Pruefung 13.10.2026). Getrennte Folios zeigen jeden Saldo fuer
 * sich, und jedes bekommt seinen eigenen Empfaenger.
 */
function Aufenthalt({ folioRef, folio, onFolio, darf }: {
  folioRef: string; folio: FolioView; onFolio: (folioRef: string) => void; darf: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const anlegen = useSplitFolio(folioRef)
  const umleiten = useAccommodationRouting(folioRef)
  const [neu, setNeu] = useState<string | null>(null)
  const hier = folio.stay.find(x => x.folioRef === folioRef)

  // Ein einzelnes Gastfolio braucht keine Leiste, nur den Weg zu einem zweiten.
  if (folio.stay.length < 2 && !darf) return <></>

  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-500">{t('folio.stay')}</span>
        {folio.stay.map(x => (
          <button key={x.folioRef} onClick={() => { onFolio(x.folioRef) }}
                  aria-current={x.folioRef === folioRef ? 'page' : undefined}
                  className={`px-2 py-0.5 rounded-sm border
                              ${x.folioRef === folioRef
                                ? 'border-neutral-900 bg-neutral-900 text-white'
                                : 'border-neutral-300 hover:bg-neutral-50'}`}>
            {kontoName(x, t)}
            <span className="ms-2 tabular-nums">{formatMoney(x.balanceCent, locale)}</span>
          </button>
        ))}
        {darf && neu === null && (
          <button onClick={() => { setNeu('') }}
                  className="px-2 py-0.5 rounded-sm border border-dashed border-neutral-400
                             text-neutral-700 hover:bg-neutral-50">
            + {t('folio.split')}
          </button>
        )}
      </div>

      {darf && neu !== null && (
        <form className="flex flex-wrap items-center gap-2"
              onSubmit={e => {
                e.preventDefault()
                anlegen.mutate(neu, {
                  onSuccess: r => { setNeu(null); onFolio(r.folioRef) }
                })
              }}>
          <input value={neu} maxLength={60} autoFocus
                 placeholder={t('folio.splitLabel')} aria-label={t('folio.splitLabel')}
                 onChange={e => { setNeu(e.target.value) }}
                 className="border border-neutral-300 rounded-sm px-2 py-1 text-sm w-64" />
          <button type="submit" disabled={anlegen.isPending}
                  className="px-3 py-1 text-sm rounded-sm bg-neutral-900 text-white">
            {t('folio.create')}
          </button>
          <button type="button" onClick={() => { setNeu(null) }}
                  className="px-3 py-1 text-sm rounded-sm border border-neutral-300">
            {t('common.cancel')}
          </button>
        </form>
      )}
      {anlegen.isError && <Fehler error={anlegen.error} />}

      {/* Nur an einem weiteren Folio: aufs Gastfolio bucht der Nachtlauf
          ohnehin. Schon gebuchte Naechte bucht man einzeln um. */}
      {hier !== undefined && !hier.main && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hier.accommodationHere}
                 disabled={!darf || umleiten.isPending}
                 onChange={e => { umleiten.mutate(e.target.checked) }} />
          {t('folio.routeHere')}
        </label>
      )}
      {umleiten.isError && <Fehler error={umleiten.error} />}
    </section>
  )
}

function NeuePosition({ folioRef }: { folioRef: string }): JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [betrag, setBetrag] = useState('')
  const [satz, setSatz] = useState(1900)
  const [unlesbar, setUnlesbar] = useState(false)
  const buchen = usePostCharge(folioRef)

  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3">
      <h3 className="text-sm font-medium">{t('folio.newCharge')}</h3>
      <form className="mt-2 space-y-2"
            onSubmit={e => {
              e.preventDefault()
              // Brutto, wie es auf dem Papier steht, und mit derselben
              // geprueften Lesart wie ueberall: "1.200" war hier still
              // 12,00 Euro, "1.234,50" wortlos nichts (Pruefung 13.10.2026).
              // Ein Minus ist ein Nachlass.
              const cent = centAusEingabeMitVorzeichen(betrag)
              setUnlesbar(cent === null || cent === 0)
              if (cent === null || cent === 0) return
              buchen.mutate({ description: text, grossCent: cent, taxRateBp: satz },
                { onSuccess: () => { setText(''); setBetrag('') } })
            }}>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('folio.description')}</span>
          <input required value={text} onChange={e => setText(e.target.value)}
                 className={eingabe} />
        </label>
        <div className="flex gap-2">
          <label className="block grow">
            <span className="block text-xs text-neutral-600">{t('rdlg.gross')}</span>
            <input required inputMode="decimal" value={betrag}
                   onChange={e => { setBetrag(e.target.value); setUnlesbar(false) }}
                   aria-invalid={unlesbar}
                   className={eingabe} placeholder="8,40" />
          </label>
          <label className="block w-28">
            <span className="block text-xs text-neutral-600">{t('folio.taxRate')}</span>
            <select value={satz} onChange={e => setSatz(Number(e.target.value))}
                    className={eingabe}>
              <option value={700}>7 %</option>
              <option value={1900}>19 %</option>
              <option value={0}>0 %</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={buchen.isPending}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('folio.post')}
        </button>
      </form>
      {unlesbar && <div role="alert" className="mt-2 text-sm text-red-700">
        {t('folio.amountInvalid')}</div>}
      {buchen.isError && <div className="mt-2"><Fehler error={buchen.error} /></div>}
    </section>
  )
}

function NeueZahlung({ folioRef, offenCent, methoden, hinweis }: {
  folioRef: string; offenCent: number
  methoden: Array<{ code: string; name: string }>; hinweis: string
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [betrag, setBetrag] = useState('')
  const [art, setArt] = useState('')
  const [beleg, setBeleg] = useState('')
  const [unlesbar, setUnlesbar] = useState(false)
  const vermerken = usePostSettlement(folioRef)

  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3">
      <h3 className="text-sm font-medium">{t('folio.newSettlement')}</h3>
      <form className="mt-2 space-y-2"
            onSubmit={e => {
              e.preventDefault()
              // Ein Minus ist eine Erstattung.
              const cent = centAusEingabeMitVorzeichen(betrag)
              setUnlesbar(cent === null || cent === 0)
              if (cent === null || cent === 0 || art === '') return
              vermerken.mutate(
                { amountCent: cent, paymentMethodCode: art,
                  externalReference: beleg === '' ? undefined : beleg },
                { onSuccess: () => { setBetrag(''); setBeleg('') } })
            }}>
        <div className="flex gap-2">
          <label className="block grow">
            <span className="block text-xs text-neutral-600">{t('folio.amount')}</span>
            <input required inputMode="decimal" value={betrag}
                   onChange={e => { setBetrag(e.target.value); setUnlesbar(false) }}
                   aria-invalid={unlesbar} className={eingabe} />
          </label>
          <button type="button"
                  onClick={() => setBetrag((offenCent / 100).toFixed(2).replace('.', ','))}
                  className="self-end px-2 py-1 text-xs border border-neutral-300 rounded-sm
                             whitespace-nowrap">
            {t('folio.fullBalance')} {formatMoney(offenCent, locale)}
          </button>
        </div>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('folio.method')}</span>
          <select required value={art} onChange={e => setArt(e.target.value)}
                  className={eingabe}>
            <option value="">—</option>
            {methoden.map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
          </select>
          {/* Ein neues Haus hat keine Zahlungsarten (Migration 0166); eine leere
              Auswahl ohne Wort dazu sah aus wie ein Fehler. */}
          {methoden.length === 0 && (
            <span role="note" className="block mt-1 text-xs text-amber-800">
              {t('folio.noMethods')}
            </span>
          )}
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('folio.reference')}</span>
          <input value={beleg} onChange={e => setBeleg(e.target.value)}
                 className={eingabe} placeholder="Bon 4711" />
        </label>
        <button type="submit" disabled={vermerken.isPending}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('folio.note')}
        </button>
      </form>
      {/* Der Hinweis steht am Formular, nicht in einer Fussnote: wer hier
          tippt, soll wissen, dass er zuordnet und nicht abwickelt. */}
      <p className="mt-2 text-xs text-neutral-500">{hinweis}</p>
      {unlesbar && <div role="alert" className="mt-2 text-sm text-red-700">
        {t('folio.amountInvalid')}</div>}
      {vermerken.isError && <div className="mt-2"><Fehler error={vermerken.error} /></div>}
    </section>
  )
}
