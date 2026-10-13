import { useState, type JSX } from 'react'
import { useOpenItems, useRemind, type OffenerPosten } from '../lib/queries/billing.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { addDays } from '../lib/dates.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Offene Posten (Pruefung des Rechnungssystems vom 13.10.2026).
 *
 * Die Rechnungsliste zeigt einen Zeitraum; eine Firmenrechnung aus dem
 * Fruehjahr, die noch offen ist, fiel dort heraus. Hier gibt es keinen
 * Zeitraum: offen ist offen. Geladen wird erst beim Aufklappen, wie der
 * Postausgang, damit die Rechnungsliste nicht zwei Anfragen kostet.
 */

/** Hoechste Stufe; danach Inkasso oder Mahnbescheid, nicht das System. */
const MAX_STUFE = 3

function Mahnen({ p, propertyId, today, darfSenden, onFertig }: {
  p: OffenerPosten; propertyId: number; today: string; darfSenden: boolean
  onFertig: () => void
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const [frist, setFrist] = useState(addDays(today, 7))
  const [senden, setSenden] = useState(darfSenden)
  const [an, setAn] = useState('')
  const m = useRemind(propertyId)

  return (
    <form className="mt-2 flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-2"
          onSubmit={e => {
            e.preventDefault()
            m.mutate({ invoiceRef: p.invoiceRef, dueOn: frist, send: senden,
                       ...(senden && an.trim() !== '' ? { to: an.trim() } : {}) },
                     { onSuccess: onFertig })
          }}>
      <label className="text-sm">
        <div className="text-neutral-600">{t('op.newDue')}</div>
        <input type="date" value={frist} min={today} max={addDays(today, 60)} required
               onChange={e => setFrist(e.target.value)}
               className="border border-neutral-300 rounded-sm px-2 py-1" />
      </label>
      {darfSenden && (
        <label className="text-sm flex items-center gap-2">
          <input type="checkbox" checked={senden} onChange={e => setSenden(e.target.checked)} />
          {t('op.send')}
        </label>
      )}
      {senden && (
        <label className="text-sm grow">
          <div className="text-neutral-600">{t('op.to')}</div>
          <input type="email" value={an} onChange={e => setAn(e.target.value)}
                 className="w-full border border-neutral-300 rounded-sm px-2 py-1" />
        </label>
      )}
      <button type="submit" disabled={!online || m.isPending}
              className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('op.record')}
      </button>
      <div className="basis-full text-xs text-neutral-500">{t('op.hint')}</div>
      {m.isError && <div className="basis-full"><Fehler error={m.error} /></div>}
    </form>
  )
}

export function OffenePosten({ propertyId, darfMahnen, darfSenden, onFolio }: {
  propertyId: number; darfMahnen: boolean; darfSenden: boolean
  onFolio: (folioRef: string) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [auf, setAuf] = useState(false)
  const [mahnen, setMahnen] = useState<string | null>(null)
  const q = useOpenItems(propertyId, auf)

  return (
    <details open={auf}
             onToggle={e => setAuf((e.currentTarget as HTMLDetailsElement).open)}
             className="rounded-sm border border-neutral-200 bg-white p-3">
      <summary className="text-sm font-medium cursor-pointer">{t('op.title')}</summary>
      {!auf ? null : q.isError ? <Fehler error={q.error} />
        : q.data === undefined ? <Laedt />
        : q.data.items.length === 0
          ? <div className="mt-2 text-sm text-neutral-500">{t('op.empty')}</div>
          : <div className="mt-2 space-y-2">
              <div className="text-sm">
                {t('op.total', { open: formatMoney(q.data.totalOpenCent, locale),
                                 overdue: formatMoney(q.data.totalOverdueCent, locale) })}
              </div>
              {q.data.truncated && (
                <div className="text-xs text-neutral-500">{t('op.truncated')}</div>
              )}
              <ul className="space-y-1">
                {q.data.items.map(p => (
                  <li key={p.invoiceRef} className="text-sm border-t border-neutral-100 pt-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono">{p.number}</span>
                      <span className="grow">{p.recipient}</span>
                      <span className="tabular-nums">{formatMoney(p.openCent, locale)}</span>
                      <span className={p.daysOverdue > 0 ? 'text-red-700' : 'text-neutral-500'}>
                        {p.daysOverdue > 0
                          ? t('op.overdueDays', { days: p.daysOverdue })
                          : t('op.due', { date: formatDate(p.dueOn, locale) })}
                      </span>
                      <button onClick={() => onFolio(p.folioRef)}
                              className="text-xs px-2 py-0.5 rounded-sm border border-neutral-300
                                         hover:bg-neutral-50">
                        {t('inv.folio')}
                      </button>
                      {darfMahnen && (p.reminderLevel ?? 0) < MAX_STUFE && (
                        <button onClick={() => setMahnen(
                                  mahnen === p.invoiceRef ? null : p.invoiceRef)}
                                className="text-xs px-2 py-0.5 rounded-sm border
                                           border-neutral-300 hover:bg-neutral-50">
                          {t(p.reminderLevel === null ? 'op.remind' : 'op.dun')}
                        </button>
                      )}
                    </div>
                    {p.reminderLevel !== null && (
                      <div className="text-xs text-neutral-500">
                        {t('op.reminded', { level: p.reminderLevel,
                                            date: formatDate(p.remindedOn!, locale),
                                            due: formatDate(p.reminderDueOn!, locale) })}
                      </div>
                    )}
                    {mahnen === p.invoiceRef && (
                      <Mahnen p={p} propertyId={propertyId} today={q.data!.today}
                              darfSenden={darfSenden} onFertig={() => setMahnen(null)} />
                    )}
                  </li>
                ))}
              </ul>
            </div>}
    </details>
  )
}
