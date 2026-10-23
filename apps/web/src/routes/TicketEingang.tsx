import { useState } from 'react'
import type { JSX } from 'react'
import { useT, useLocale } from '../lib/i18n/index.js'
import { usePlatformTickets, usePlatformTicket, usePlatformReply, usePlatformSetTicket,
         useRequestSessionFromTicket, type PlattformTicket,
         type TicketFilter } from '../lib/queries/tickets.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { ART, DringendMarke, Faden, ZustandMarke, zeitpunkt } from '../components/TicketTeile.tsx'

/**
 * Der Eingang der Tickets im Adminpanel (Migration 0208).
 *
 * **Was hier steht und was nicht.** Betreff und Faden einer Anfrage sind
 * Text, den der Kunde uns geschickt hat -- dafuer ist das Panel da. Ein
 * Blick in Buchungen oder Gaeste ist es nicht: dafuer fragt man aus dem
 * Ticket eine Support-Sitzung an, und der Kunde gibt sie im selben Faden
 * frei. Der Weg bleibt derselbe wie ueberall im Panel, er ist nur kuerzer.
 *
 * Zuweisen nur an sich selbst ("Uebernehmen"): eine Liste der Kollegen
 * braucht `platform:staff`, und am Eingang ist "ich nehme das" der
 * Handgriff, der gebraucht wird.
 */

function ausAdresse(): number | null {
  const roh = new URLSearchParams(window.location.search).get('ticket')
  const id = roh === null ? NaN : Number(roh)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function TicketEingang({ eigeneId }: { eigeneId: number | null }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [filter, setFilter] = useState<TicketFilter>('active')
  const [offen, setOffen] = useState<number | null>(ausAdresse)
  const q = usePlatformTickets(filter)

  if (offen !== null) {
    return <Detail id={offen} eigeneId={eigeneId} onZurueck={() => setOffen(null)} />
  }

  const filter3: Array<[TicketFilter, 'ticket.filter.active' | 'ticket.filter.closed'
                       | 'ticket.filter.all']> = [
    ['active', 'ticket.filter.active'], ['closed', 'ticket.filter.closed'],
    ['all', 'ticket.filter.all']]

  return (
    <section className="space-y-2">
      <div className="flex gap-1">
        {filter3.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k}
                  className={`text-sm px-2 py-1 rounded-sm border
                              ${filter === k ? 'border-neutral-900 bg-neutral-900 text-white'
                                : 'border-neutral-300'}`}>
            {t(label)}
          </button>
        ))}
      </div>
      {q.isPending && <Laedt />}
      {q.isError && <Fehler error={q.error} />}
      {q.data !== undefined && (q.data.tickets.length === 0
        ? <p className="text-sm text-neutral-500">{t('ticket.empty')}</p>
        : <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-sm bg-white">
            {q.data.tickets.map((x: PlattformTicket) => (
              <li key={x.id}>
                <button type="button" onClick={() => setOffen(x.id)}
                        className="w-full text-left px-3 py-2 hover:bg-neutral-50 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-500">#{x.id}</span>
                    <span className="font-medium text-sm truncate">{x.subject}</span>
                    <span className="flex-1" />
                    {x.urgency === 'down' && x.status !== 'closed' && <DringendMarke />}
                    <ZustandMarke status={x.status} kunde={false} />
                  </div>
                  <div className="text-xs text-neutral-500">
                    {x.accountName}{x.propertyName !== null && <> · {x.propertyName}</>}
                    {' · '}{t(ART[x.category])}
                    {' · '}{zeitpunkt(x.lastCustomerAt, locale)}
                    {' · '}{x.assignedName !== null
                      ? t('ticket.admin.assigned', { name: x.assignedName })
                      : t('ticket.admin.unassigned')}
                  </div>
                </button>
              </li>
            ))}
          </ul>)}
    </section>
  )
}

function Detail({ id, eigeneId, onZurueck }: {
  id: number; eigeneId: number | null; onZurueck: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = usePlatformTicket(id)
  const antworten = usePlatformReply(id)
  const setzen = usePlatformSetTicket(id)
  const sitzung = useRequestSessionFromTicket(id)
  const [text, setText] = useState('')
  const [intern, setIntern] = useState(false)
  const [stufe, setStufe] = useState<'read' | 'write'>('read')

  if (q.isPending) return <Laedt />
  if (q.isError) return <Fehler error={q.error} />
  const x = q.data
  const meins = x.assignedTo !== null && x.assignedTo === eigeneId

  return (
    <div className="space-y-3">
      <button type="button" onClick={onZurueck}
              className="text-sm underline underline-offset-2 text-neutral-600">
        ← {t('common.back')}
      </button>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">{x.subject}</h2>
          {x.urgency === 'down' && x.status !== 'closed' && <DringendMarke />}
          <ZustandMarke status={x.status} kunde={false} />
        </div>
        <p className="text-xs text-neutral-500">
          {t('ticket.number', { id: x.id })} · {x.accountName}
          {x.propertyName !== null && <> · {x.propertyName}</>}
          {' · '}{t(ART[x.category])} · {t('ticket.from', { name: x.createdByName })}
          {x.createdAt !== null && <> · {zeitpunkt(x.createdAt, locale)}</>}
          {x.screen !== null && <> · {t('ticket.admin.where', { screen: x.screen })}</>}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-600">
            {x.assignedName !== null
              ? t('ticket.admin.assigned', { name: x.assignedName })
              : t('ticket.admin.unassigned')}
          </span>
          <button type="button" disabled={setzen.isPending}
                  onClick={() => setzen.mutate({ assign: meins ? 'none' : 'me' })}
                  className="px-2 py-1 border border-neutral-300 rounded-sm">
            {t(meins ? 'ticket.admin.release' : 'ticket.admin.take')}
          </button>
          <button type="button" disabled={setzen.isPending}
                  onClick={() => setzen.mutate({ status: x.status === 'closed' ? 'open' : 'closed' })}
                  className="px-2 py-1 border border-neutral-300 rounded-sm">
            {t(x.status === 'closed' ? 'ticket.admin.reopen' : 'ticket.close')}
          </button>
        </div>
        {setzen.isError && <Fehler error={setzen.error} />}
      </div>

      {x.sessions.length > 0 && (
        <ul className="text-xs text-neutral-600 space-y-0.5">
          {x.sessions.map(s => (
            <li key={s.id}>
              {s.staffName} · {t(s.level === 'write' ? 'support.level.write' : 'support.level.read')}
              {' · '}{t(`support.state.${s.state}`)}
              {' · '}{t('support.until')}: {zeitpunkt(s.expiresAt, locale)}
            </li>
          ))}
        </ul>
      )}

      <Faden nachrichten={x.messages}
             anhangPfad={a => `/v1/platform/tickets/${id}/attachments/${a}`} />

      <form className={`space-y-2 border rounded-sm p-3
                        ${intern ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-white'}`}
            onSubmit={e => {
              e.preventDefault()
              if (text.trim() === '') return
              antworten.mutate({ body: text.trim(), internal: intern },
                { onSuccess: () => setText('') })
            }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={4} maxLength={10000}
                  aria-label={t('ticket.reply')}
                  className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        <label className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={intern} onChange={e => setIntern(e.target.checked)} />
          {t('ticket.admin.internal')}
        </label>
        {antworten.isError && <Fehler error={antworten.error} />}
        <button type="submit" disabled={text.trim() === '' || antworten.isPending}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('ticket.send')}
        </button>
      </form>

      {/*
        * Zugriff aus dem Ticket anfragen. Der Anlass ist die Anfrage selbst --
        * der Kunde sieht die Bitte in ihrem Faden und weiss, wozu sie dient.
        * Dauer und alles Weitere wie im Reiter "Support".
        */}
      <div className="flex flex-wrap items-center gap-2 text-sm border-t border-neutral-200 pt-3">
        <span className="text-neutral-700">{t('support.level')}</span>
        <select value={stufe} onChange={e => setStufe(e.target.value as 'read' | 'write')}
                className="border border-neutral-300 rounded-sm px-2 py-1">
          <option value="read">{t('support.level.read')}</option>
          <option value="write">{t('support.level.write')}</option>
        </select>
        <button type="button" disabled={sitzung.isPending}
                onClick={() => sitzung.mutate({ accountId: x.accountId, level: stufe,
                  reason: t('ticket.number', { id: x.id }) })}
                className="px-2 py-1 border border-neutral-300 rounded-sm">
          {t('ticket.admin.requestSession')}
        </button>
      </div>
      {sitzung.isError && <Fehler error={sitzung.error} />}
    </div>
  )
}
