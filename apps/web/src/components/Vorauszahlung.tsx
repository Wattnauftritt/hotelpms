import { useState } from 'react'
import type { DepositInvoice, PrepaymentSettlement, PrepaymentView } from '@hotelpms/contracts'
import { usePrepayments, useIssueDepositInvoice } from '../lib/queries/billing.js'
import { anzahlungBereit, anzahlungsNutzlast, summeTeile,
         type Steuerart, type Teil } from '../lib/vorauszahlung.js'
import { newIdempotencyKey } from '../lib/api.js'
import { useHausrechte } from '../lib/rechte.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { Anforderungen } from './Anzahlung.tsx'
import { ZahlungslinkErzeugen, ZahlungslinkListe } from './Zahlungslink.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Vorauszahlung am Folio: Anzahlungsrechnung und Zahlungslink.
 *
 * **Warum beides in einem Feld.** Es ist derselbe Vorgang aus zwei Enden:
 * der Link holt das Geld, die Anzahlungsrechnung weist es aus. Getrennt
 * gezeigt, sieht die Rezeption nie, dass zu einem eingegangenen Betrag die
 * Rechnung noch fehlt -- und genau die ist die Pflicht (§ 14 Abs. 5 UStG),
 * nicht der Link.
 *
 * **Warum eingeklappt.** Das Folio ist der taegliche Bildschirm; eine
 * Anzahlung ist es nicht. Zugeklappt kostet sie keinen Aufruf: die Abfrage
 * laeuft erst, wenn jemand aufmacht.
 *
 * **Die Reihenfolge ist nicht beliebig.** Erst wird der Eingang vermerkt,
 * dann fakturiert -- eine Anzahlungsrechnung ohne Zahlungseingang waere
 * eine Vorausrechnung, und die ist etwas anderes. Deshalb bietet die Maske
 * als Grundlage nur Zahlungsvermerke an, und nur solche ohne eigene
 * Anzahlungsrechnung (`deposit_ledger_settlement_once`).
 */
export function Vorauszahlung({ folioRef, saldoCent, stand, geschlossen }: {
  folioRef: string
  /** Offener Saldo, als Vorschlag fuer den Betrag des Links. */
  saldoCent: number
  /** Zahl der fakturierten Positionen: aendert sie sich, ist neu zu fragen. */
  stand: number
  geschlossen: boolean
}): JSX.Element {
  const t = useT()
  const [auf, setAuf] = useState(false)

  return (
    <section className="bg-white border border-neutral-200 rounded">
      <button onClick={() => setAuf(v => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <span className="text-sm font-medium">{t('vz.title')}</span>
        <span className="text-xs text-neutral-500">{t('vz.open')}</span>
        <div className="grow" />
        <span className="text-neutral-400">{auf ? '▾' : '▸'}</span>
      </button>
      {auf && <Inhalt folioRef={folioRef} saldoCent={saldoCent} stand={stand}
                     geschlossen={geschlossen} />}
    </section>
  )
}

function Inhalt({ folioRef, saldoCent, stand, geschlossen }: {
  folioRef: string; saldoCent: number; stand: number; geschlossen: boolean
}): JSX.Element {
  const t = useT()
  const q = usePrepayments(folioRef, stand)
  const rechte = useHausrechte(q.data?.propertyId ?? 0)

  if (q.isError) return <div className="p-3"><Fehler error={q.error} /></div>
  if (q.data === undefined) {
    return <p className="px-3 pb-3 text-sm text-neutral-400">…</p>
  }
  const v = q.data

  return (
    <div className="border-t border-neutral-200 divide-y divide-neutral-200">
      {/* Die Anforderung steht oben: sie ist der Grund, aus dem ein Link
          entsteht und ein Eingang zur Anzahlungsrechnung wird. */}
      <div className="px-3 py-2">
        <h4 className="text-xs font-medium text-neutral-600 mb-1">{t('anz.title')}</h4>
        <Anforderungen folioRef={folioRef} v={v} />
      </div>
      <Anzahlungen deposits={v.deposits} />
      {/* Die Anzahlungsrechnung haengt an invoice:issue, nicht an
          folio:post: wer eine Minibar bucht, stellt noch keine Rechnung aus. */}
      {!v.canIssueDeposit
        ? <p className="px-3 py-2 text-xs text-neutral-500">{t('vz.dep.blocked')}</p>
        : rechte.darf('invoice:issue')
          && <NeueAnzahlung folioRef={folioRef} settlements={v.settlements} />}
      <Zahlungslinks folioRef={folioRef} v={v}
                     saldoCent={saldoCent} geschlossen={geschlossen} />
    </div>
  )
}

// ------------------------------------------------------------ Anzahlungen

function Anzahlungen({ deposits }: { deposits: readonly DepositInvoice[] }): JSX.Element {
  const t = useT()
  const locale = useLocale()

  if (deposits.length === 0) {
    return <p className="px-3 py-2 text-sm text-neutral-400">{t('vz.dep.none')}</p>
  }
  return (
    <div className="px-3 py-2">
      <h4 className="text-xs font-medium text-neutral-600">{t('vz.dep.title')}</h4>
      <ul className="mt-1 space-y-1.5">
        {deposits.map(d => (
          <li key={d.invoiceRef} className="text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-medium tabular-nums">{d.number}</span>
              <span className="text-neutral-500 text-xs tabular-nums">
                {formatDate(d.issuedOn, locale)}
              </span>
              <div className="grow" />
              <span className="tabular-nums">{formatMoney(d.amountGrossCent, locale)}</span>
            </div>
            <div className="text-xs text-neutral-500 tabular-nums">
              {/* Die Satzgruppen stehen da, weil sie auf dem Beleg stehen
                  muessen: eine Anzahlung ist pauschal, ihr Steuerausweis
                  ist es nicht. */}
              {d.groups.map(g => `${g.rateBp / 100} % · ${formatMoney(g.grossCent, locale)}`)
                .join('   ')}
            </div>
            <div className="text-xs">
              {d.appliedInvoiceNumber === null
                ? <span className="text-amber-700">{t('vz.dep.notApplied')}</span>
                : <span className="text-emerald-800">
                    ✓ {t('vz.dep.appliedTo')} {d.appliedInvoiceNumber}
                    {d.appliedOn !== null && ` · ${formatDate(d.appliedOn, locale)}`}
                  </span>}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-neutral-500">{t('vz.dep.applyHint')}</p>
    </div>
  )
}

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm'

function NeueAnzahlung({ folioRef, settlements }: {
  folioRef: string; settlements: readonly PrepaymentSettlement[]
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [gewaehlt, setGewaehlt] = useState<number | null>(null)
  const [art, setArt] = useState<Steuerart>('derive')
  const [satz, setSatz] = useState(700)
  const [teile, setTeile] = useState<Teil[]>(
    [{ betrag: '', satz: 700 }, { betrag: '', satz: 1900 }])
  // Einmal je Absicht, nicht je Versuch: ein zweiter Klick nach einer
  // Zeitueberschreitung darf keine zweite Rechnungsnummer verbrauchen.
  const [schluessel, setSchluessel] = useState(newIdempotencyKey)
  const erstellen = useIssueDepositInvoice(folioRef)

  const moeglich = settlements.filter(
    s => s.depositInvoiceRef === null && s.amountCent > 0)
  if (moeglich.length === 0) {
    return <p className="px-3 py-2 text-xs text-neutral-500">{t('vz.dep.noneOpen')}</p>
  }

  const vermerk = moeglich.find(s => s.id === gewaehlt) ?? null
  const summe = summeTeile(teile)
  const teilePassen = vermerk !== null && summe === vermerk.amountCent
  const bereit = anzahlungBereit(art, teile, vermerk?.amountCent ?? null)

  return (
    <div className="px-3 py-2">
      <h4 className="text-xs font-medium text-neutral-600">{t('vz.dep.new')}</h4>
      <form className="mt-1 space-y-2"
            onSubmit={e => {
              e.preventDefault()
              if (vermerk === null || !bereit) return
              erstellen.mutate(
                { settlementId: vermerk.id, ...anzahlungsNutzlast(art, satz, teile),
                  key: schluessel },
                { onSuccess: () => { setGewaehlt(null); setSchluessel(newIdempotencyKey()) } })
            }}>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('vz.dep.settlement')}</span>
          <select required value={gewaehlt ?? ''} className={eingabe}
                  onChange={e => setGewaehlt(e.target.value === '' ? null
                                                                  : Number(e.target.value))}>
            <option value="">—</option>
            {moeglich.map(s => (
              <option key={s.id} value={s.id}>
                {formatDate(s.businessDate, locale)} · {s.method} ·{' '}
                {formatMoney(s.amountCent, locale)}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap gap-3 text-xs">
          {(['derive', 'single', 'split'] as const).map(a => (
            <label key={a} className="flex items-center gap-1">
              <input type="radio" name="steuerart" checked={art === a}
                     onChange={() => setArt(a)} />
              {t(`vz.dep.tax.${a}`)}
            </label>
          ))}
        </div>

        {art === 'derive' && (
          <p className="text-xs text-neutral-500">{t('vz.dep.tax.deriveHint')}</p>
        )}

        {art === 'single' && (
          <label className="block w-32">
            <span className="block text-xs text-neutral-600">{t('vz.dep.tax')}</span>
            <select value={satz} onChange={e => setSatz(Number(e.target.value))}
                    className={eingabe}>
              <option value={700}>7 %</option>
              <option value={1900}>19 %</option>
              <option value={0}>0 %</option>
            </select>
          </label>
        )}

        {art === 'split' && (
          <div className="space-y-1">
            {teile.map((z, i) => (
              <div key={i} className="flex gap-2">
                <input inputMode="decimal" value={z.betrag} placeholder="0,00"
                       className={`${eingabe} grow`}
                       onChange={e => setTeile(ts => ts.map(
                         (x, j) => j === i ? { ...x, betrag: e.target.value } : x))} />
                <select value={z.satz} className={`${eingabe} w-24`}
                        onChange={e => setTeile(ts => ts.map(
                          (x, j) => j === i ? { ...x, satz: Number(e.target.value) } : x))}>
                  <option value={700}>7 %</option>
                  <option value={1900}>19 %</option>
                  <option value={0}>0 %</option>
                </select>
              </div>
            ))}
            <button type="button" className="text-xs text-neutral-600 underline"
                    onClick={() => setTeile(ts => [...ts, { betrag: '', satz: 1900 }])}>
              {t('vz.dep.tax.add')}
            </button>
            {/* Die Summe steht neben der Eingabe und nicht erst in der
                Fehlermeldung der API: die Abweichung faellt beim Tippen auf,
                nicht nach dem Absenden. */}
            {vermerk !== null && (
              <p className={`text-xs tabular-nums ${teilePassen ? 'text-emerald-800'
                                                                : 'text-amber-700'}`}>
                {t('vz.dep.tax.sum')}: {formatMoney(summe, locale)} /{' '}
                {formatMoney(vermerk.amountCent, locale)}
              </p>
            )}
            <p className="text-xs text-neutral-500">{t('vz.dep.tax.splitHint')}</p>
          </div>
        )}

        <button type="submit" disabled={!bereit || erstellen.isPending}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('vz.dep.issue')}
        </button>
      </form>
      {erstellen.isError && <div className="mt-2"><Fehler error={erstellen.error} /></div>}
      {erstellen.isSuccess && (
        <p className="mt-2 text-sm text-emerald-800">
          ✓ {t('vz.dep.issued')} {erstellen.data.number}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------- Zahlungslinks

/**
 * Alle Links des Folios, und einer ueber einen freien Betrag.
 *
 * Ein Link zu einer Anzahlungsanforderung entsteht an der Anforderung; hier
 * steht der Weg fuer den Rest -- etwa den offenen Saldo vor der Abreise.
 * Liste und Formular sind dieselben wie an der Anforderung
 * (`Zahlungslink.tsx`).
 */
function Zahlungslinks({ folioRef, v, saldoCent, geschlossen }: {
  folioRef: string; v: PrepaymentView; saldoCent: number; geschlossen: boolean
}): JSX.Element {
  const t = useT()
  const rechte = useHausrechte(v.propertyId)
  const darfBuchen = rechte.darf('folio:post')

  return (
    <div className="px-3 py-2 space-y-2">
      <h4 className="text-xs font-medium text-neutral-600">{t('vz.link.title')}</h4>
      <ZahlungslinkListe folioRef={folioRef} links={v.paymentLinks} darfBuchen={darfBuchen} />
      {!geschlossen && darfBuchen && (
        <ZahlungslinkErzeugen folioRef={folioRef} v={v} vorschlagCent={saldoCent}
                              darfPost={rechte.darf('email:send')} />
      )}
      {/* Der Hinweis steht immer da, nicht erst nach dem Erzeugen: er ist
          der Grund, warum der Saldo nach dem Verschicken unveraendert
          bleibt. */}
      <p className="text-xs text-neutral-500">{t('vz.link.hint')}</p>
      <p className="text-xs text-neutral-500">{t('vz.link.noCard')}</p>
    </div>
  )
}
