import { useState } from 'react'
import type { JSX } from 'react'
import type { MaintenanceTicket } from '@hotelpms/contracts'
import { useMaintenanceTickets, useCreateMaintenanceTicket,
         useUpdateMaintenanceTicket } from '../lib/queries/settings.js'
import { useRooms } from '../lib/queries.js'
import { useHausrechte } from '../lib/rechte.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today, addDays } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Wartungsmeldungen.
 *
 * **Out of Order und Out of Service sind hier zu unterscheiden**, und das
 * ist keine Formsache: Out of Order senkt die Kapazität, das Zimmer ist
 * nicht mehr verkäuflich; Out of Service bleibt im Verkauf. Wer das
 * verwechselt, sperrt entweder ein Zimmer, das verkauft werden könnte, oder
 * verkauft eines, das nicht bezogen werden kann.
 *
 * **Es gibt keinen Löschknopf.** Eine Meldung ist die Aufzeichnung eines
 * Befundes; wer sie löscht, löscht die Frage, ob das Zimmer je in Ordnung
 * gebracht wurde. Erledigt ist ein Zustand, kein Verschwinden.
 *
 * **Die Sperrung bleibt, wenn die Meldung erledigt wird.** Das wäre bequem
 * und wäre falsch: ob ein Zimmer wieder verkäuflich ist, entscheidet, wer
 * hineingesehen hat.
 */

const DRINGLICHKEIT = ['high', 'normal', 'low'] as const
const STAND = ['open', 'in_progress', 'done'] as const

function Zeile(
  { ticket, propertyId, darfSchreiben }:
  { ticket: MaintenanceTicket; propertyId: number; darfSchreiben: boolean }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const aendern = useUpdateMaintenanceTicket(propertyId)

  const farbe = ticket.priority === 'high'
    ? 'border-red-300 bg-red-50 text-red-900'
    : ticket.priority === 'normal'
      ? 'border-neutral-300 bg-neutral-100 text-neutral-700'
      : 'border-neutral-200 text-neutral-500'

  return (
    <li className={`rounded border border-neutral-200 bg-white p-3
                    ${ticket.status === 'done' ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="grow">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{ticket.title}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${farbe}`}>
              {t(`maint.priority.${ticket.priority}`)}
            </span>
            <span className="text-xs text-neutral-500">
              {t(`maint.status.${ticket.status}`)}
            </span>
          </div>
          <div className="mt-0.5 text-sm text-neutral-600">
            {ticket.roomCode === null
              ? t('maint.noRoom')
              : `${t('maint.room')} ${ticket.roomCode}`}
            {' · '}{formatDate(ticket.createdAt.slice(0, 10), locale)}
          </div>
          {ticket.description !== null && ticket.description !== '' && (
            <div className="mt-1 text-sm text-neutral-700">{ticket.description}</div>
          )}
          {/* Die Sperrung steht an der Meldung: sonst ist nicht zu sehen,
              ob das Zimmer gerade Kapazität kostet. */}
          {ticket.blocks.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {ticket.blocks.map((b, i) => (
                <span key={i}
                      className={`text-xs px-1.5 py-0.5 rounded border ${
                        b.kind === 'out_of_order'
                          ? 'border-amber-300 bg-amber-50 text-amber-900'
                          : 'border-neutral-300 bg-neutral-50 text-neutral-600'}`}>
                  {t(`maint.block.${b.kind}`)}: {formatDate(b.from, locale)} –{' '}
                  {formatDate(b.to, locale)}
                </span>
              ))}
            </div>
          )}
        </div>

        {darfSchreiben && (
          <div className="flex flex-wrap gap-1.5">
            {ticket.status === 'open' && (
              <button onClick={() => aendern.mutate({ id: ticket.id,
                                                      status: 'in_progress' })}
                      disabled={!online || aendern.isPending}
                      className="text-sm px-3 py-1.5 rounded border border-neutral-300
                                 hover:bg-neutral-50 disabled:opacity-40">
                {t('maint.take')}
              </button>
            )}
            {ticket.status !== 'done'
              ? <button onClick={() => aendern.mutate({ id: ticket.id, status: 'done' })}
                        disabled={!online || aendern.isPending}
                        className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                                   disabled:opacity-40">
                  {t('maint.done')}
                </button>
              : <button onClick={() => aendern.mutate({ id: ticket.id, status: 'open' })}
                        disabled={!online || aendern.isPending}
                        className="text-sm px-3 py-1.5 rounded border border-neutral-300
                                   hover:bg-neutral-50 disabled:opacity-40">
                  {t('maint.reopen')}
                </button>}
          </div>
        )}
      </div>
      {aendern.isError && <div className="mt-2"><Fehler error={aendern.error} /></div>}
    </li>
  )
}

function Formular({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const zimmer = useRooms(propertyId)
  const anlegen = useCreateMaintenanceTicket(propertyId)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [resourceId, setResourceId] = useState(0)
  const [sperre, setSperre] = useState<'none' | 'out_of_order' | 'out_of_service'>('none')
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(addDays(today(), 1))

  const bereit = title.trim() !== ''
    && (sperre === 'none' || (resourceId !== 0 && to > from))

  const absenden = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!bereit) return
    anlegen.mutate({
      propertyId, title: title.trim(), priority,
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      ...(resourceId === 0 ? {} : { resourceId }),
      ...(sperre === 'none' ? {} : { block: { from, to, kind: sperre } })
    }, { onSuccess: () => { setTitle(''); setDescription(''); setSperre('none') } })
  }

  return (
    <form onSubmit={absenden}
          className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <div className="font-medium">{t('maint.new')}</div>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm grow">
          <div className="text-neutral-600">{t('maint.subject')}</div>
          <input value={title} onChange={e => setTitle(e.target.value)} required
                 className="border border-neutral-300 rounded px-2 py-1 w-full" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('maint.priority')}</div>
          <select value={priority}
                  onChange={e => setPriority(e.target.value as typeof priority)}
                  className="border border-neutral-300 rounded px-2 py-1">
            {DRINGLICHKEIT.map(p => (
              <option key={p} value={p}>{t(`maint.priority.${p}`)}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('maint.room')}</div>
          <select value={resourceId} onChange={e => setResourceId(Number(e.target.value))}
                  className="border border-neutral-300 rounded px-2 py-1">
            <option value={0}>{t('maint.noRoom')}</option>
            {(zimmer.data?.rooms ?? []).map(r => (
              <option key={r.id} value={r.id}>{r.code}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="text-sm block">
        <div className="text-neutral-600">{t('maint.description')}</div>
        <textarea value={description} onChange={e => setDescription(e.target.value)}
                  rows={2}
                  className="border border-neutral-300 rounded px-2 py-1 w-full" />
      </label>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('maint.block')}</div>
          <select value={sperre}
                  onChange={e => setSperre(e.target.value as typeof sperre)}
                  className="border border-neutral-300 rounded px-2 py-1">
            <option value="none">{t('maint.block.none')}</option>
            <option value="out_of_order">{t('maint.block.out_of_order')}</option>
            <option value="out_of_service">{t('maint.block.out_of_service')}</option>
          </select>
        </label>
        {sperre !== 'none' && <>
          <label className="text-sm">
            <div className="text-neutral-600">{t('common.from')}</div>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                   className="border border-neutral-300 rounded px-2 py-1" />
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('common.to')}</div>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
                   className="border border-neutral-300 rounded px-2 py-1" />
          </label>
        </>}
      </div>

      {/* Der Hinweis steht am Formular, nicht in einer Fußnote: wer hier
          wählt, trifft gerade die Entscheidung, die er betrifft. */}
      <div className="text-xs text-neutral-500">
        {t('maint.blockHint')}
        {sperre !== 'none' && resourceId === 0 && (
          <span className="block text-amber-800">{t('maint.blockNeedsRoom')}</span>
        )}
      </div>

      {anlegen.isError && <Fehler error={anlegen.error} />}

      <button type="submit" disabled={!online || !bereit || anlegen.isPending}
              className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('common.save')}
      </button>
    </form>
  )
}

export function Maintenance({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const { darf } = useHausrechte(propertyId)
  const [auchErledigte, setAuchErledigte] = useState(false)
  const q = useMaintenanceTickets(propertyId)
  const darfSchreiben = darf('maintenance:write')

  const tickets = (q.data?.tickets ?? [])
    .filter(x => auchErledigte || x.status !== 'done')
    // Offen vor In Arbeit vor Erledigt; innerhalb dessen bleibt die
    // Reihenfolge der API (Dringlichkeit, dann Alter).
    .sort((a, b) => STAND.indexOf(a.status) - STAND.indexOf(b.status))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t('maint.title')}</h1>
        <div className="grow" />
        <label className="text-sm flex items-center gap-1.5 text-neutral-600">
          <input type="checkbox" checked={auchErledigte}
                 onChange={e => setAuchErledigte(e.target.checked)} />
          {t('maint.showDone')}
        </label>
      </div>

      {darfSchreiben && <Formular propertyId={propertyId} />}

      <div className="text-xs text-neutral-500">
        {t('maint.noDelete')} {t('maint.blockStays')}
      </div>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : tickets.length === 0
            ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
            : <ul className="space-y-2">
                {tickets.map(x => (
                  <Zeile key={x.id} ticket={x} propertyId={propertyId}
                         darfSchreiben={darfSchreiben} />
                ))}
              </ul>}
    </div>
  )
}
