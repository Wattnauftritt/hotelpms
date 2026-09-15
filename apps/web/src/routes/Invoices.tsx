import { useEffect, useState, type JSX } from 'react'
import type { InvoiceListItem } from '@hotelpms/contracts'
import { useInvoices, useBeleg, useSendInvoice, useOutbox, useCancelMail,
         istBelegInArbeit, zeitraum, MAX_RECHNUNGSTAGE } from '../lib/queries/billing.js'
import { ApiError } from '../lib/api.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Rechnungen: Liste, Beleg, Versand (B5 bis B7 aus Dokument 20).
 *
 * Eine Rechnung liess sich bisher nur über ihr Folio finden. Wer wissen
 * wollte, was im Oktober hinausgegangen ist, musste den GoBD-Export nehmen
 * — der ein Übungshaus hart abweist und an einem Recht hängt, das die
 * Rezeption nicht hat.
 *
 * **Kein „offen"-Merkmal.** Ob eine Rechnung bezahlt ist, weiß das Modell
 * nicht: `settlement.invoice_id` wäre die Stelle dafür und wird nirgends
 * geschrieben. Eine solche Spalte zeigte bei jeder Rechnung den vollen
 * Betrag, auch bei der längst bezahlten. Der Zahlungsstand steht am
 * Gastkonto, und dorthin führt ein Knopf an jeder Zeile.
 */

const ARTEN = ['final', 'interim', 'deposit', 'credit_note'] as const
const ZEITRAEUME = [7, 30, 90, MAX_RECHNUNGSTAGE] as const

const MAIL_LABEL: Record<string, string> = {
  pending: 'inv.mail.pending', sent: 'inv.mail.sent',
  failed: 'inv.mail.failed', canceled: 'inv.mail.canceled'
}

/**
 * Der Beleg im Blatt.
 *
 * Die Adresse des Blobs wird beim Schließen wieder freigegeben; ohne das
 * hält der Browser jedes angesehene PDF bis zum Neuladen im Speicher, und
 * an einem Rezeptionsrechner bleibt dieselbe Sitzung tagelang offen.
 */
function Beleg({ invoiceRef }: { invoiceRef: string }): JSX.Element {
  const t = useT()
  const q = useBeleg(invoiceRef)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (q.data === undefined) return
    const u = URL.createObjectURL(q.data)
    setUrl(u)
    return () => { URL.revokeObjectURL(u); setUrl(null) }
  }, [q.data])

  if (q.isPending) return <Laedt />
  if (q.isError) {
    return istBelegInArbeit(q.error)
      ? <div role="status" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm">
          {t('inv.document.pending')}
        </div>
      : <Fehler error={q.error} />
  }
  if (url === null) return <Laedt />

  return (
    <div className="space-y-2">
      <iframe src={url} title={`${t('inv.document')} ${invoiceRef}`}
              className="w-full h-[70vh] border border-neutral-200 rounded bg-white" />
      <a href={url} download={`Rechnung-${invoiceRef}.pdf`}
         className="inline-block text-sm px-3 py-1.5 rounded border border-neutral-300
                    hover:bg-neutral-50">
        {t('inv.download')}
      </a>
    </div>
  )
}

function Versand(
  { invoiceRef, propertyId }: { invoiceRef: string; propertyId: number }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const senden = useSendInvoice(propertyId)
  const [to, setTo] = useState('')

  // 409 heisst hier nicht "kaputt", sondern "schon heraus". Ein zweiter
  // Versand muss ausdruecklich gewollt sein -- ein zweiter Klick ist
  // haeufiger als ein zweiter Bedarf.
  const schonVerschickt = senden.isError && senden.error instanceof ApiError
    && senden.error.status === 409

  return (
    <div className="space-y-2">
      <label className="text-sm block">
        <div className="text-neutral-600">{t('inv.send.to')}</div>
        <input type="email" value={to} onChange={e => setTo(e.target.value)}
               placeholder="—"
               className="border border-neutral-300 rounded px-2 py-1 w-72" />
        <div className="text-xs text-neutral-500 mt-0.5">{t('inv.send.toHint')}</div>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!online || senden.isPending}
                onClick={() => senden.mutate({ invoiceRef, to })}
                className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('inv.send')}
        </button>
        {schonVerschickt && (
          <button type="button" disabled={!online || senden.isPending}
                  onClick={() => senden.mutate({ invoiceRef, to, resend: true })}
                  className="text-sm px-3 py-1.5 rounded border border-neutral-300
                             hover:bg-neutral-50 disabled:opacity-40">
            {t('inv.send.again')}
          </button>
        )}
        {senden.isSuccess && (
          <span role="status" className="text-sm text-emerald-800">
            {t('inv.send.queued')}
          </span>
        )}
      </div>

      {schonVerschickt
        ? <div role="status"
               className="rounded border border-amber-200 bg-amber-50 p-2 text-sm">
            {t('inv.send.alreadyHint')}
          </div>
        : senden.isError && <Fehler error={senden.error} />}
    </div>
  )
}

function Zeile(
  { r, propertyId, offen, onOffen, darfSenden, onFolio }: {
    r: InvoiceListItem; propertyId: number
    offen: 'beleg' | 'versand' | null
    onOffen: (was: 'beleg' | 'versand' | null) => void
    darfSenden: boolean
    onFolio: (folioRef: string) => void }
): JSX.Element {
  const t = useT()
  const locale = useLocale()

  return (
    <li className="rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-sm">{r.number}</span>
        <span className="text-sm text-neutral-600">{formatDate(r.issuedOn, locale)}</span>
        <span className="text-sm">{r.recipient === '' ? '—' : r.recipient}</span>
        <span className="text-xs px-1.5 py-0.5 rounded border border-neutral-300
                         bg-neutral-50 text-neutral-700">
          {t(`inv.kind.${r.kind}` as 'inv.kind.final')}
        </span>
        <div className="grow" />
        <span className="font-semibold tabular-nums">
          {formatMoney(r.grossCent, locale, r.currency)}
        </span>
      </div>

      {/* Der Zahlungsstand steht in der Zeile, nicht als Ampel: „bezahlt"
          faerbt niemand gruen, und ein offener Rest ist keine Warnung,
          sondern eine Zahl. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs">
        {r.settledCent >= r.payableCent
          ? <span className="text-emerald-800">✓ {t('inv.paid')}</span>
          : <>
              <span className="text-amber-800 tabular-nums">
                {t('inv.open')}: {formatMoney(
                  r.payableCent - r.settledCent, locale, r.currency)}
              </span>
              {r.settledCent > 0 && (
                <span className="text-neutral-500 tabular-nums">
                  {t('inv.settled')}: {formatMoney(r.settledCent, locale, r.currency)}
                </span>
              )}
            </>}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={r.documentReady ? 'text-neutral-600' : 'text-amber-800'}>
          {t('inv.document')}: {r.documentReady
            ? t('inv.document.ready') : t('inv.document.pending')}
        </span>
        {r.documentReady && !r.hasXml && (
          <span className="text-neutral-500" title={t('inv.document.noXmlHint')}>
            {t('inv.document.noXml')}
          </span>
        )}
        {r.mailStatus !== null && (
          <span className="text-neutral-600">
            {t(MAIL_LABEL[r.mailStatus] as 'inv.mail.sent' ?? 'inv.mail.pending')}
          </span>
        )}
        <div className="grow" />
        <button onClick={() => onOffen(offen === 'beleg' ? null : 'beleg')}
                className="px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50">
          {offen === 'beleg' ? t('inv.hide') : t('inv.show')}
        </button>
        {darfSenden && (
          <button onClick={() => onOffen(offen === 'versand' ? null : 'versand')}
                  className="px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50">
            {t('inv.send')}
          </button>
        )}
        <button onClick={() => onFolio(r.folioRef)}
                className="px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50">
          {t('inv.folio')}
        </button>
      </div>

      {offen === 'beleg' && <div className="mt-3"><Beleg invoiceRef={r.invoiceRef} /></div>}
      {offen === 'versand' && (
        <div className="mt-3 border-t border-neutral-200 pt-3">
          <Versand invoiceRef={r.invoiceRef} propertyId={propertyId} />
        </div>
      )}
    </li>
  )
}

function Postausgang({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const [offen, setOffen] = useState(false)
  const q = useOutbox(propertyId, offen)
  const zuruecknehmen = useCancelMail(propertyId)

  return (
    <details open={offen}
             onToggle={e => setOffen((e.currentTarget as HTMLDetailsElement).open)}
             className="rounded border border-neutral-200 bg-white p-3">
      <summary className="text-sm font-medium cursor-pointer">{t('inv.outbox')}</summary>
      {!offen ? null : q.isError ? <Fehler error={q.error} />
        : q.data === undefined ? <Laedt />
        : q.data.emails.length === 0
          ? <div className="mt-2 text-sm text-neutral-500">{t('inv.outbox.empty')}</div>
          : <ul className="mt-2 space-y-1">
              {q.data.emails.map(e => (
                <li key={e.messageRef}
                    className="text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-neutral-500">
                    {formatDate(e.createdAt.slice(0, 10), locale)}
                  </span>
                  <span className="grow">{e.subject}</span>
                  <span className="text-neutral-600">
                    {t(MAIL_LABEL[e.status] as 'inv.mail.sent' ?? 'inv.mail.pending')}
                  </span>
                  {e.attempts > 1 && (
                    <span className="text-xs text-neutral-500">
                      {e.attempts} {t('inv.outbox.attempts')}
                    </span>
                  )}
                  {e.status === 'pending' && (
                    <button onClick={() => zuruecknehmen.mutate(e.messageRef)}
                            disabled={!online || zuruecknehmen.isPending}
                            className="text-xs px-2 py-0.5 rounded border border-neutral-300
                                       hover:bg-neutral-50 disabled:opacity-40">
                      {t('inv.outbox.cancel')}
                    </button>
                  )}
                  {e.lastError !== null && (
                    <span className="text-xs text-red-700 basis-full">{e.lastError}</span>
                  )}
                </li>
              ))}
            </ul>}
    </details>
  )
}

export function Invoices(
  { propertyId, onFolio, permissions }: {
    propertyId: number; onFolio: (folioRef: string) => void
    permissions: readonly string[]
  }
): JSX.Element {
  const t = useT()
  const [laenge, setLaenge] = useState<number>(30)
  const [bis, setBis] = useState(today())
  const [kind, setKind] = useState<string | null>(null)
  const [offen, setOffen] = useState<{ ref: string; was: 'beleg' | 'versand' } | null>(null)

  const { von } = zeitraum(bis, laenge)
  const darfSenden = permissions.includes('email:send')
  const q = useInvoices(propertyId, von, bis, kind)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-lg font-semibold">{t('inv.title')}</h1>
        <div className="grow" />
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.to')}</div>
          <input type="date" value={bis} onChange={e => setBis(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.days')}</div>
          <select value={laenge} onChange={e => setLaenge(Number(e.target.value))}
                  className="border border-neutral-300 rounded px-2 py-1">
            {ZEITRAEUME.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('inv.kind')}</div>
          <select value={kind ?? ''}
                  onChange={e => setKind(e.target.value === '' ? null : e.target.value)}
                  className="border border-neutral-300 rounded px-2 py-1">
            <option value="">{t('inv.kind.all')}</option>
            {ARTEN.map(a => (
              <option key={a} value={a}>{t(`inv.kind.${a}` as 'inv.kind.final')}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="text-xs text-neutral-500">{t('inv.paymentHint')}</div>

      {darfSenden && <Postausgang propertyId={propertyId} />}

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : q.data.invoices.length === 0
            ? <div className="text-sm text-neutral-500">{t('inv.none')}</div>
            : <ul className="space-y-2">
                {q.data.invoices.map(r => (
                  <Zeile key={r.invoiceRef} r={r} propertyId={propertyId}
                         offen={offen?.ref === r.invoiceRef ? offen.was : null}
                         onOffen={was => setOffen(
                           was === null ? null : { ref: r.invoiceRef, was })}
                         darfSenden={darfSenden} onFolio={onFolio} />
                ))}
              </ul>}
    </div>
  )
}
