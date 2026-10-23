import { useState } from 'react'
import type { JSX } from 'react'
import { useT, useLocale } from '../lib/i18n/index.js'
import { useTickets, useTicket, useCreateTicket, useReplyTicket, useCloseTicket,
         type NeuerAnhang, type Ticket, type TicketArt, type TicketFilter,
         type TicketSitzung } from '../lib/queries/tickets.js'
import { useGrantSupportSession, useRevokeSupportSession } from '../lib/queries/support.js'
import { useQueryClient } from '@tanstack/react-query'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { ART, AnhangWahl, DringendMarke, Faden, ZustandMarke,
         zeitpunkt } from '../components/TicketTeile.tsx'
import { herkunft } from '../lib/hilfe.js'

/**
 * Hilfe & Support (Migration 0208): Anfragen des Hotels an uns.
 *
 * **Warum im Produkt und nicht per Mail.** Wer hier fragt, ist angemeldet;
 * wir wissen Betrieb, Haus und Bildschirm, ohne zu raten, und eine
 * Support-Freigabe steht im Faden der Frage, zu der sie gehoert, statt als
 * Mail mit einer Nummer darin.
 *
 * **Keine Gastdaten.** Das Formular sagt es vor dem Absenden, nicht danach.
 * Was dennoch darin steht, bleibt in der Datenbank mit Zeilenrichtlinie und
 * Frist -- die Mail an uns traegt nur Nummer und Link.
 */

type Ansicht = { art: 'liste' } | { art: 'neu' } | { art: 'ticket'; id: number }

/** `?ticket=12` aus dem Link in der Mail. */
function ausAdresse(): Ansicht {
  const roh = new URLSearchParams(window.location.search).get('ticket')
  const id = roh === null ? NaN : Number(roh)
  return Number.isInteger(id) && id > 0 ? { art: 'ticket', id } : { art: 'liste' }
}

export function Hilfe({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const [ansicht, setAnsicht] = useState<Ansicht>(ausAdresse)
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t('nav.support')}</h1>
        {ansicht.art === 'liste' && (
          <button type="button" onClick={() => setAnsicht({ art: 'neu' })}
                  className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white">
            {t('ticket.new')}
          </button>
        )}
      </div>
      {ansicht.art === 'liste' && (
        <>
          <p className="text-sm text-neutral-600">{t('ticket.intro')}</p>
          <Liste onOpen={id => setAnsicht({ art: 'ticket', id })} />
        </>
      )}
      {ansicht.art === 'neu' && (
        <NeueAnfrage propertyId={propertyId}
                     onFertig={id => setAnsicht(id === null ? { art: 'liste' }
                       : { art: 'ticket', id })} />
      )}
      {ansicht.art === 'ticket' && (
        <Anfrage id={ansicht.id} onZurueck={() => setAnsicht({ art: 'liste' })} />
      )}
    </div>
  )
}

function Liste({ onOpen }: { onOpen: (id: number) => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [filter, setFilter] = useState<TicketFilter>('active')
  const q = useTickets(filter)
  const filter3: Array<[TicketFilter, 'ticket.filter.active' | 'ticket.filter.closed'
                       | 'ticket.filter.all']> = [
    ['active', 'ticket.filter.active'], ['closed', 'ticket.filter.closed'],
    ['all', 'ticket.filter.all']]
  return (
    <section className="space-y-2">
      <div className="flex gap-1">
        {filter3.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)}
                  aria-pressed={filter === k}
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
            {q.data.tickets.map((x: Ticket) => (
              <li key={x.id}>
                <button type="button" onClick={() => onOpen(x.id)}
                        className="w-full text-left px-3 py-2 hover:bg-neutral-50 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-500">#{x.id}</span>
                    <span className="font-medium text-sm truncate">{x.subject}</span>
                    <span className="flex-1" />
                    {x.urgency === 'down' && x.status !== 'closed' && <DringendMarke />}
                    <ZustandMarke status={x.status} kunde />
                  </div>
                  <div className="text-xs text-neutral-500">
                    {t(ART[x.category])} · {zeitpunkt(x.updatedAt, locale)}
                    {!x.mine && <> · {t('ticket.from', { name: x.createdByName })}</>}
                  </div>
                </button>
              </li>
            ))}
          </ul>)}
    </section>
  )
}

function NeueAnfrage({ propertyId, onFertig }: {
  propertyId: number; onFertig: (id: number | null) => void
}): JSX.Element {
  const t = useT()
  const anlegen = useCreateTicket()
  const [betreff, setBetreff] = useState('')
  const [art, setArt] = useState<TicketArt>('question')
  const [dringend, setDringend] = useState(false)
  const [text, setText] = useState('')
  const [anhaenge, setAnhaenge] = useState<NeuerAnhang[]>([])
  const bereit = betreff.trim() !== '' && text.trim() !== '' && !anlegen.isPending

  const absenden = (): void => {
    anlegen.mutate({
      propertyId, subject: betreff.trim(), category: art,
      urgency: dringend ? 'down' : 'normal', body: text.trim(),
      // Nur der Schluessel des Bildschirms, aus dem jemand kam -- nie die
      // Adresse: in deren Abfrageteil stuende ein Suchbegriff, also ein Gast.
      screen: herkunft(),
      clientVersion: navigator.userAgent.slice(0, 80),
      attachments: anhaenge
    }, { onSuccess: r => onFertig(r.id) })
  }

  return (
    <form className="space-y-3 bg-white border border-neutral-200 rounded-sm p-4"
          onSubmit={e => { e.preventDefault(); if (bereit) absenden() }}>
      <h2 className="font-medium">{t('ticket.new')}</h2>
      <p className="text-sm rounded-sm bg-amber-50 border border-amber-200 p-2 text-amber-900">
        {t('ticket.noGuestData')}
      </p>
      <label className="block text-sm space-y-1">
        <span className="text-neutral-700">{t('ticket.subject')}</span>
        <input value={betreff} onChange={e => setBetreff(e.target.value)} maxLength={200}
               className="w-full border border-neutral-300 rounded-sm px-2 py-1" />
      </label>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm space-y-1">
          <span className="block text-neutral-700">{t('ticket.category')}</span>
          <select value={art} onChange={e => setArt(e.target.value as TicketArt)}
                  className="border border-neutral-300 rounded-sm px-2 py-1">
            {(Object.keys(ART) as TicketArt[]).map(k => (
              <option key={k} value={k}>{t(ART[k])}</option>
            ))}
          </select>
        </label>
        <label className="text-sm flex items-center gap-1.5 pb-1">
          <input type="checkbox" checked={dringend} onChange={e => setDringend(e.target.checked)} />
          {t('ticket.urgent')}
        </label>
      </div>
      <label className="block text-sm space-y-1">
        <span className="text-neutral-700">{t('ticket.body')}</span>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={7}
                  maxLength={10000} placeholder={t('ticket.bodyHint')}
                  className="w-full border border-neutral-300 rounded-sm px-2 py-1" />
      </label>
      <AnhangWahl anhaenge={anhaenge} onAnhaenge={setAnhaenge} />
      {anlegen.isError && <Fehler error={anlegen.error} />}
      <div className="flex gap-2">
        <button type="submit" disabled={!bereit}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('ticket.send')}
        </button>
        <button type="button" onClick={() => onFertig(null)}
                className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

function Anfrage({ id, onZurueck }: { id: number; onZurueck: () => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = useTicket(id)
  const antworten = useReplyTicket(id)
  const schliessen = useCloseTicket(id)
  const [text, setText] = useState('')
  const [anhaenge, setAnhaenge] = useState<NeuerAnhang[]>([])

  if (q.isPending) return <Laedt />
  if (q.isError) return <Fehler error={q.error} />
  const x = q.data

  const senden = (): void => {
    antworten.mutate({ body: text.trim(), attachments: anhaenge }, {
      onSuccess: () => { setText(''); setAnhaenge([]) }
    })
  }

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
          <ZustandMarke status={x.status} kunde />
        </div>
        <p className="text-xs text-neutral-500">
          {t('ticket.number', { id: x.id })} · {t(ART[x.category])}
          {' · '}{zeitpunkt(x.createdAt, locale)}
          {x.propertyName !== null && <> · {x.propertyName}</>}
        </p>
      </div>

      {x.sessions.filter(s => s.state === 'pending' || s.state === 'active').map(s => (
        <Freigabe key={s.id} ticketId={id} s={s} darf={x.canGrant} />
      ))}

      <Faden nachrichten={x.messages}
             anhangPfad={a => `/v1/support-tickets/${id}/attachments/${a}`} />

      <form className="space-y-2 bg-white border border-neutral-200 rounded-sm p-3"
            onSubmit={e => { e.preventDefault(); if (text.trim() !== '') senden() }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={4}
                  maxLength={10000} aria-label={t('ticket.reply')}
                  className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        <AnhangWahl anhaenge={anhaenge} onAnhaenge={setAnhaenge} />
        {x.status === 'closed' && (
          <p className="text-xs text-neutral-500">{t('ticket.reopenHint')}</p>
        )}
        {antworten.isError && <Fehler error={antworten.error} />}
        {schliessen.isError && <Fehler error={schliessen.error} />}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={text.trim() === '' || antworten.isPending}
                  className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('ticket.reply')}
          </button>
          {x.status !== 'closed' && (
            <button type="button" disabled={schliessen.isPending}
                    onClick={() => schliessen.mutate()}
                    className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300">
              {t('ticket.close')}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

/**
 * Eine Support-Sitzung, die aus dieser Anfrage erbeten wurde.
 *
 * Freigeben und Ablehnen stehen gleichwertig nebeneinander, wie unter
 * Einstellungen (SupportZugriff.tsx). Wer nicht freigeben darf, sieht die
 * Bitte trotzdem -- dann weiss er, wen er fragen muss --, aber keinen
 * Knopf, der nur mit 403 antwortet.
 */
function Freigabe({ ticketId, s, darf }: { ticketId: number; s: TicketSitzung; darf: boolean }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const freigeben = useGrantSupportSession()
  const beenden = useRevokeSupportSession()
  const neu = { onSuccess: () => { void qc.invalidateQueries({ queryKey: ['support-ticket', ticketId] }) } }
  const laeuft = freigeben.isPending || beenden.isPending
  return (
    <div className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm space-y-2">
      <p className="font-medium">{t('ticket.sessionTitle')}</p>
      <p className="text-neutral-700">
        {t('support.level')}: {t(s.level === 'write' ? 'support.level.write' : 'support.level.read')}
        {' · '}{t('support.until')}: {zeitpunkt(s.expiresAt, locale)}
        {' · '}{t(`support.state.${s.state}`)}
      </p>
      {!darf && <p className="text-xs text-neutral-600">{t('ticket.sessionNoGrant')}</p>}
      {darf && (
        <div className="flex gap-2">
          {s.state === 'pending' && (
            <button type="button" disabled={laeuft} onClick={() => freigeben.mutate(s.id, neu)}
                    className="px-3 py-1.5 rounded-sm bg-neutral-900 text-white disabled:bg-neutral-300">
              {t('support.grant')}
            </button>
          )}
          <button type="button" disabled={laeuft} onClick={() => beenden.mutate(s.id, neu)}
                  className="px-3 py-1.5 rounded-sm border border-neutral-300 disabled:text-neutral-400">
            {t(s.state === 'pending' ? 'support.deny' : 'support.revoke')}
          </button>
        </div>
      )}
      {freigeben.isError && <Fehler error={freigeben.error} />}
      {beenden.isError && <Fehler error={beenden.error} />}
    </div>
  )
}
