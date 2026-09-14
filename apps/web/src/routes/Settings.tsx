import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PaymentMethod } from '@hotelpms/contracts'
import { useEmailSettings, useSaveEmailSettings, usePaymentMethodsAll,
         useCreatePaymentMethod, useUpdatePaymentMethod }
  from '../lib/queries/settings.js'
import { useHausrechte } from '../lib/rechte.js'
import { useReiter } from '../lib/reiter.js'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Einstellungen des Hauses, die nicht Einrichtung sind.
 *
 * Die Trennung ist nicht willkürlich: `Setup` beantwortet „kann dieses Haus
 * überhaupt buchen", hier steht, wie es nach außen auftritt und womit
 * abgerechnet wird. Beides braucht ein anderes Recht und einen anderen
 * Moment im Leben eines Hauses.
 */

const REITER = ['mail', 'pay'] as const
type Reiter = (typeof REITER)[number]

interface Bereich { key: Reiter; label: TextKey }

export function einstellungsBereiche(darf: (p: string) => boolean): Bereich[] {
  const bereiche: Bereich[] = []
  if (darf('integration:manage')) bereiche.push({ key: 'mail', label: 'mail.title' })
  if (darf('settings:property')) bereiche.push({ key: 'pay', label: 'pay.title' })
  return bereiche
}

// ---------------------------------------------------------------- Gastpost

function Gastpost(
  { propertyId, isTraining }: { propertyId: number; isTraining: boolean }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useEmailSettings(propertyId)
  const speichern = useSaveEmailSettings(propertyId)

  const [fromName, setFromName] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const [bccEmail, setBccEmail] = useState('')
  const [enabled, setEnabled] = useState(false)

  // Die Maske füllt sich, sobald der Stand da ist. Ein Formular, das den
  // gespeicherten Wert nicht zeigt, verleitet dazu, ihn zu überschreiben.
  useEffect(() => {
    if (q.data === undefined) return
    setFromName(q.data.fromName ?? '')
    setFromEmail(q.data.fromEmail ?? '')
    setReplyTo(q.data.replyTo ?? '')
    setBccEmail(q.data.bccEmail ?? '')
    setEnabled(q.data.enabled)
  }, [q.data])

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const bereit = fromName.trim() !== '' && fromEmail.trim() !== ''

  return (
    <form className="rounded border border-neutral-200 bg-white p-3 space-y-3 max-w-2xl"
          onSubmit={e => {
            e.preventDefault()
            if (!bereit) return
            speichern.mutate({
              fromName: fromName.trim(), fromEmail: fromEmail.trim(),
              replyTo: replyTo.trim() === '' ? null : replyTo.trim(),
              bccEmail: bccEmail.trim() === '' ? null : bccEmail.trim(),
              enabled
            })
          }}>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('mail.fromName')}</div>
          <input value={fromName} onChange={e => setFromName(e.target.value)} required
                 className="border border-neutral-300 rounded px-2 py-1 w-64" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('mail.fromEmail')}</div>
          <input type="email" value={fromEmail} onChange={e => setFromEmail(e.target.value)}
                 required className="border border-neutral-300 rounded px-2 py-1 w-64" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('mail.replyTo')}</div>
          <input type="email" value={replyTo} onChange={e => setReplyTo(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1 w-64" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('mail.bcc')}</div>
          <input type="email" value={bccEmail} onChange={e => setBccEmail(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1 w-64" />
        </label>
      </div>

      <label className="text-sm flex items-center gap-1.5 text-neutral-700">
        <input type="checkbox" checked={enabled} disabled={isTraining}
               onChange={e => setEnabled(e.target.checked)} />
        {t('mail.enabled')}
      </label>
      {/* Der Grund steht an der gesperrten Stelle, nicht irgendwo: sonst
          sucht jemand den Fehler bei sich. */}
      <div className="text-xs text-neutral-500">
        {isTraining ? t('mail.training') : t('mail.enabledHint')}
      </div>

      <div className="text-xs text-neutral-500">
        {t('mail.updatedAt')}: {q.data.updatedAt === null
          ? t('mail.never')
          : new Date(q.data.updatedAt).toLocaleString()}
      </div>

      {speichern.isError && <Fehler error={speichern.error} />}

      <button type="submit" disabled={!online || !bereit || speichern.isPending}
              className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('common.save')}
      </button>
    </form>
  )
}

// ----------------------------------------------------------- Zahlungsarten

function Zahlart(
  { art, propertyId }: { art: PaymentMethod; propertyId: number }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const aendern = useUpdatePaymentMethod(propertyId)
  const [offen, setOffen] = useState(false)
  const [name, setName] = useState(art.name)
  const [sortOrder, setSortOrder] = useState(art.sortOrder)
  const [isExternal, setIsExternal] = useState(art.isExternal)

  return (
    <li className={`rounded border border-neutral-200 bg-white p-3
                    ${art.active ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs text-neutral-500 w-24">{art.code}</span>
        <span className="grow">{art.name}</span>
        {art.isExternal && (
          <span className="text-xs text-neutral-500">{t('pay.external')}</span>
        )}
        {!art.active && (
          <span className="text-xs px-1.5 py-0.5 rounded border border-neutral-300
                           bg-neutral-100 text-neutral-600">
            {t('master.inactive')}
          </span>
        )}
        <button onClick={() => setOffen(o => !o)}
                className="text-sm px-3 py-1.5 rounded border border-neutral-300
                           hover:bg-neutral-50">
          {t(offen ? 'master.close' : 'master.edit')}
        </button>
        <button
          onClick={() => aendern.mutate({ id: art.id, active: !art.active })}
          disabled={!online || aendern.isPending}
          className="text-sm px-3 py-1.5 rounded border border-neutral-300
                     hover:bg-neutral-50 disabled:opacity-40">
          {t(art.active ? 'pay.deactivate' : 'pay.activate')}
        </button>
      </div>

      {offen && (
        <form className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={e => {
                e.preventDefault()
                aendern.mutate({ id: art.id, name: name.trim(), sortOrder, isExternal },
                  { onSuccess: () => setOffen(false) })
              }}>
          <label className="text-sm">
            <div className="text-neutral-600">{t('pay.name')}</div>
            <input value={name} onChange={e => setName(e.target.value)} required
                   className="border border-neutral-300 rounded px-2 py-1 w-64" />
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('pay.sortOrder')}</div>
            <input type="number" value={sortOrder}
                   onChange={e => setSortOrder(Number(e.target.value))}
                   className="border border-neutral-300 rounded px-2 py-1 w-24" />
          </label>
          <label className="text-sm flex items-center gap-1.5 text-neutral-700">
            <input type="checkbox" checked={isExternal}
                   onChange={e => setIsExternal(e.target.checked)} />
            {t('pay.external')}
          </label>
          <button type="submit" disabled={!online || aendern.isPending}
                  className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('common.save')}
          </button>
        </form>
      )}
      {aendern.isError && <div className="mt-2"><Fehler error={aendern.error} /></div>}
    </li>
  )
}

function Zahlungsarten({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = usePaymentMethodsAll(propertyId)
  const anlegen = useCreatePaymentMethod(propertyId)
  const [zeigeStillgelegte, setZeigeStillgelegte] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [isExternal, setIsExternal] = useState(true)

  const arten = (q.data?.paymentMethods ?? [])
    .filter(a => zeigeStillgelegte || a.active)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grow" />
        <label className="text-sm flex items-center gap-1.5 text-neutral-600">
          <input type="checkbox" checked={zeigeStillgelegte}
                 onChange={e => setZeigeStillgelegte(e.target.checked)} />
          {t('pay.showInactive')}
        </label>
      </div>

      <form className="rounded border border-neutral-200 bg-white p-3 space-y-3"
            onSubmit={e => {
              e.preventDefault()
              if (code.trim() === '' || name.trim() === '') return
              anlegen.mutate({ code: code.trim(), name: name.trim(), isExternal },
                { onSuccess: () => { setCode(''); setName('') } })
            }}>
        <div className="font-medium">{t('pay.new')}</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <div className="text-neutral-600">{t('pay.code')}</div>
            <input value={code} onChange={e => setCode(e.target.value)} required
                   className="border border-neutral-300 rounded px-2 py-1 w-32" />
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('pay.name')}</div>
            <input value={name} onChange={e => setName(e.target.value)} required
                   className="border border-neutral-300 rounded px-2 py-1 w-64" />
          </label>
          <label className="text-sm flex items-center gap-1.5 text-neutral-700">
            <input type="checkbox" checked={isExternal}
                   onChange={e => setIsExternal(e.target.checked)} />
            {t('pay.external')}
          </label>
          <button type="submit" disabled={!online || anlegen.isPending}
                  className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('common.save')}
          </button>
        </div>
        {anlegen.isError && <Fehler error={anlegen.error} />}
      </form>

      {/* Zwei Sätze, die beide eine Erwartung korrigieren: hier wird nichts
          abgewickelt, und es wird nichts gelöscht. */}
      <div className="text-xs text-neutral-500">
        {q.data?.hinweis} {t('pay.noDelete')}
      </div>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : arten.length === 0
            ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
            : <ul className="space-y-2">
                {arten.map(a => (
                  <Zahlart key={a.id} art={a} propertyId={propertyId} />
                ))}
              </ul>}
    </div>
  )
}

export function Settings({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const { darf, isTraining, geladen } = useHausrechte(propertyId)
  const [reiter, setReiter] = useReiter<Reiter>('settings', REITER, 'mail')

  const bereiche = einstellungsBereiche(darf)
  if (!geladen) return <Laedt />
  if (bereiche.length === 0) {
    return <div className="text-sm text-neutral-500">{t('report.nothingAllowed')}</div>
  }
  const aktiv = bereiche.find(b => b.key === reiter) ?? bereiche[0]!

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t('nav.settings')}</h1>

      <div className="flex flex-wrap gap-1 border-b border-neutral-200">
        {bereiche.map(b => (
          <button key={b.key} onClick={() => setReiter(b.key)}
                  aria-current={b.key === aktiv.key ? 'page' : undefined}
                  className={`text-sm px-3 py-1.5 -mb-px border-b-2 ${
                    b.key === aktiv.key
                      ? 'border-neutral-900 font-medium'
                      : 'border-transparent text-neutral-600 hover:text-neutral-900'}`}>
            {t(b.label)}
          </button>
        ))}
      </div>

      {aktiv.key === 'mail' && (
        <Gastpost propertyId={propertyId} isTraining={isTraining} />
      )}
      {aktiv.key === 'pay' && <Zahlungsarten propertyId={propertyId} />}
    </div>
  )
}
