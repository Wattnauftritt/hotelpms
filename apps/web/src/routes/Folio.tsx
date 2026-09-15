import { useState } from 'react'
import { useFolio, usePaymentMethods, usePostCharge, usePostSettlement,
         useIssueInvoice } from '../lib/queries.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { apiText } from '../lib/meldungen.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Vorauszahlung } from '../components/Vorauszahlung.tsx'
import { Rechnungsempfaenger } from '../components/Rechnungsempfaenger.tsx'

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
export function Folio({ folioRef, propertyId, onClose }: {
  folioRef: string; propertyId: number; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const q = useFolio(folioRef)
  const zahlarten = usePaymentMethods(propertyId)
  const fakturieren = useIssueInvoice(folioRef)

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const f = q.data

  const offen = f.charges.filter(c => c.invoice_id === null)

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-3">
        <button onClick={onClose}
                className="text-sm px-2 py-1 border border-neutral-300 rounded">
          ← {t('common.back')}
        </button>
        <h2 className="text-sm font-medium">
          {t('folio.title')} {f.folio.public_ref}
          {f.folio.label !== null && <span className="text-neutral-500"> · {f.folio.label}</span>}
        </h2>
        {f.folio.status === 'closed' && (
          <span className="text-xs px-2 py-0.5 rounded bg-neutral-200">{t('folio.closed')}</span>
        )}
        <div className="grow" />
        <span className={`text-lg tabular-nums font-medium
                          ${f.balanceCent > 0 ? 'text-red-700'
                            : f.balanceCent < 0 ? 'text-emerald-700' : ''}`}>
          {formatMoney(f.balanceCent, locale)}
        </span>
      </div>

      <section className="bg-white border border-neutral-200 rounded overflow-hidden">
        <h3 className="px-3 py-2 text-sm font-medium border-b border-neutral-200">
          {t('folio.charges')}
        </h3>
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
                </td>
                <td className="px-3 py-1.5 w-14 text-right tabular-nums text-neutral-500">
                  {c.quantity}
                </td>
                <td className="px-3 py-1.5 w-16 text-right tabular-nums text-neutral-500">
                  {c.tax_rate_bp / 100} %
                </td>
                <td className="px-3 py-1.5 w-24 text-right tabular-nums">
                  {formatMoney(c.gross_cent, locale)}
                </td>
                <td className="px-3 py-1.5 w-8 text-center">
                  {c.invoice_id !== null && (
                    <span title={t('folio.invoiced')} className="text-neutral-400">🔒</span>
                  )}
                </td>
              </tr>
            ))}
            {f.charges.length === 0 && (
              <tr><td className="px-3 py-3 text-neutral-400">{t('common.none')}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="bg-white border border-neutral-200 rounded overflow-hidden">
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
                <td className="px-3 py-1.5 w-24 text-right tabular-nums">
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

      {offen.length > 0 && online && (
        <section className="bg-white border border-neutral-200 rounded p-3">
          <div className="flex items-center gap-3">
            <button onClick={() => fakturieren.mutate()}
                    disabled={fakturieren.isPending}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('folio.issueInvoice')} ({offen.length})
            </button>
            <span className="text-xs text-neutral-500">{t('folio.issueHint')}</span>
          </div>
          {fakturieren.isError && <div className="mt-2"><Fehler error={fakturieren.error} /></div>}
          {fakturieren.isSuccess && (
            <p className="mt-2 text-sm text-emerald-800">
              ✓ {t('folio.invoiceNumber')} {fakturieren.data.number}
            </p>
          )}
        </section>
      )}
    </div>
  )
}

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm'

function NeuePosition({ folioRef }: { folioRef: string }): JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [betrag, setBetrag] = useState('')
  const [satz, setSatz] = useState(1900)
  const buchen = usePostCharge(folioRef)

  return (
    <section className="bg-white border border-neutral-200 rounded p-3">
      <h3 className="text-sm font-medium">{t('folio.newCharge')}</h3>
      <form className="mt-2 space-y-2"
            onSubmit={e => {
              e.preventDefault()
              // Eingabe in Euro, Speicherung in Cent. Geld ist nie Fliesskomma.
              const cent = Math.round(Number(betrag.replace(',', '.')) * 100)
              if (!Number.isFinite(cent)) return
              buchen.mutate({ description: text, netCent: cent, taxRateBp: satz },
                { onSuccess: () => { setText(''); setBetrag('') } })
            }}>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('folio.description')}</span>
          <input required value={text} onChange={e => setText(e.target.value)}
                 className={eingabe} />
        </label>
        <div className="flex gap-2">
          <label className="block grow">
            <span className="block text-xs text-neutral-600">{t('folio.netAmount')}</span>
            <input required inputMode="decimal" value={betrag}
                   onChange={e => setBetrag(e.target.value)}
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
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('folio.post')}
        </button>
      </form>
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
  const vermerken = usePostSettlement(folioRef)

  return (
    <section className="bg-white border border-neutral-200 rounded p-3">
      <h3 className="text-sm font-medium">{t('folio.newSettlement')}</h3>
      <form className="mt-2 space-y-2"
            onSubmit={e => {
              e.preventDefault()
              const cent = Math.round(Number(betrag.replace(',', '.')) * 100)
              if (!Number.isFinite(cent) || art === '') return
              vermerken.mutate(
                { amountCent: cent, paymentMethodCode: art,
                  externalReference: beleg === '' ? undefined : beleg },
                { onSuccess: () => { setBetrag(''); setBeleg('') } })
            }}>
        <div className="flex gap-2">
          <label className="block grow">
            <span className="block text-xs text-neutral-600">{t('folio.amount')}</span>
            <input required inputMode="decimal" value={betrag}
                   onChange={e => setBetrag(e.target.value)} className={eingabe} />
          </label>
          <button type="button"
                  onClick={() => setBetrag((offenCent / 100).toFixed(2).replace('.', ','))}
                  className="self-end px-2 py-1 text-xs border border-neutral-300 rounded
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
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('folio.reference')}</span>
          <input value={beleg} onChange={e => setBeleg(e.target.value)}
                 className={eingabe} placeholder="Bon 4711" />
        </label>
        <button type="submit" disabled={vermerken.isPending}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('folio.note')}
        </button>
      </form>
      {/* Der Hinweis steht am Formular, nicht in einer Fussnote: wer hier
          tippt, soll wissen, dass er zuordnet und nicht abwickelt. */}
      <p className="mt-2 text-xs text-neutral-500">{hinweis}</p>
      {vermerken.isError && <div className="mt-2"><Fehler error={vermerken.error} /></div>}
    </section>
  )
}
