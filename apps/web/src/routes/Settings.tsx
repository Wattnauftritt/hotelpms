import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PaymentMethod } from '@hotelpms/contracts'
import { useEmailSettings, useSaveEmailSettings, usePaymentMethodsAll,
         useCreatePaymentMethod, useUpdatePaymentMethod }
  from '../lib/queries/settings.js'
import { usePropertyTerms, useCreateTerms } from '../lib/queries/booking.js'
import { useHausrechte } from '../lib/rechte.js'
import { useReiter } from '../lib/reiter.js'
import { useT, useLocale, formatDate, type TextKey } from '../lib/i18n/index.js'
import { apiText } from '../lib/meldungen.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { SupportZugriff } from '../components/SupportZugriff.tsx'

/**
 * Einstellungen des Hauses, die nicht Einrichtung sind.
 *
 * Die Trennung ist nicht willkürlich: `Setup` beantwortet „kann dieses Haus
 * überhaupt buchen", hier steht, wie es nach außen auftritt und womit
 * abgerechnet wird. Beides braucht ein anderes Recht und einen anderen
 * Moment im Leben eines Hauses.
 */

const REITER = ['mail', 'pay', 'terms', 'support'] as const
type Reiter = (typeof REITER)[number]

interface Bereich { key: Reiter; label: TextKey }

export function einstellungsBereiche(darf: (p: string) => boolean): Bereich[] {
  const bereiche: Bereich[] = []
  if (darf('integration:manage')) bereiche.push({ key: 'mail', label: 'mail.title' })
  if (darf('settings:property')) bereiche.push({ key: 'pay', label: 'pay.title' })
  if (darf('settings:property')) bereiche.push({ key: 'terms', label: 'terms.title' })
  /*
   * Support-Zugriff an settings:account, nicht an settings:property: die
   * Freigabe gilt fuer den ganzen Account, nicht fuer ein Haus. Wer nur ein
   * Haus verwaltet, entscheidet das nicht.
   */
  if (darf('settings:account')) {
    bereiche.push({ key: 'support', label: 'support.title' })
  }
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
  const locale = useLocale()
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
        {apiText(q.data?.hinweisKey, q.data?.hinweis ?? '', locale)} {t('pay.noDelete')}
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

// ----------------------------------------------------------- Hausbedingungen

/**
 * Was das Haus am Tresen unterschreiben lässt.
 *
 * **Fassungen, keine Änderungen.** Wer die Pauschale von 50 auf 60 Euro
 * setzt, legt eine neue Fassung an; die alte Unterschrift behält ihren Text.
 * Deshalb gibt es hier kein Bearbeiten-Feld, sondern nur ein Anlegen — ein
 * geänderter Text unter einer alten Unterschrift wäre als Nachweis wertlos.
 *
 * **Nicht der Meldeschein.** Der ist öffentlich-rechtlich und wird nach
 * einem Jahr vernichtet; was hier steht, ist privatrechtlich, gilt für jeden
 * Gast — auch den inländischen, der seit dem 1.1.2025 keinen Meldeschein
 * mehr unterschreibt — und bleibt länger nachweisbar.
 */
function Hausbedingungen({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const q = usePropertyTerms(propertyId)
  const anlegen = useCreateTerms(propertyId)
  const [code, setCode] = useState('')
  const [titel, setTitel] = useState('')
  const [text, setText] = useState('')
  const [unterschrift, setUnterschrift] = useState(true)

  const gueltig = code.trim() !== '' && titel.trim() !== '' && text.trim() !== ''

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('terms.hint')}</p>

      {q.isError && <Fehler error={q.error} />}
      {q.data === undefined && !q.isError ? <Laedt /> : (
        <ul className="space-y-2">
          {(q.data?.terms ?? []).map(b => (
            <li key={b.termsRef}
                className={`border rounded p-2 text-sm
                            ${b.activeTo === null
                              ? 'border-neutral-300'
                              : 'border-neutral-200 bg-neutral-50 text-neutral-500'}`}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{b.title}</span>
                <span className="text-xs text-neutral-500">
                  {b.code} · {t('terms.version')} {b.version}
                </span>
                <div className="grow" />
                <span className="text-xs text-neutral-500">
                  {formatDate(b.activeFrom, locale)}
                  {b.activeTo === null
                    ? ` — ${t('terms.current')}`
                    : ` — ${formatDate(b.activeTo, locale)}`}
                </span>
              </div>
              <p className="text-xs text-neutral-600 mt-1 whitespace-pre-line">{b.body}</p>
              {!b.requiresSignature && (
                <p className="text-xs text-neutral-500 mt-1">{t('terms.noSignature')}</p>
              )}
            </li>
          ))}
          {(q.data?.terms ?? []).length === 0 && (
            <li className="text-sm text-neutral-500">{t('common.none')}</li>
          )}
        </ul>
      )}

      <div className="border-t border-neutral-200 pt-3 space-y-2">
        <h2 className="text-sm font-medium">{t('terms.new')}</h2>
        <p className="text-xs text-neutral-500">{t('terms.newHint')}</p>
        <div className="flex gap-2">
          <label className="block text-sm w-1/3">
            <span className="block text-xs text-neutral-600 mb-1">{t('terms.code')}</span>
            <input value={code} onChange={e => setCode(e.target.value)}
                   placeholder="key_deposit"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('terms.heading')}</span>
            <input value={titel} onChange={e => setTitel(e.target.value)}
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
        </div>
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('terms.text')}</span>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={4}
                    className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={unterschrift}
                 onChange={e => setUnterschrift(e.target.checked)} />
          {t('terms.requiresSignature')}
        </label>
        {anlegen.isError && <Fehler error={anlegen.error} />}
        {!online && <div className="text-sm text-amber-800">{t('error.offlineWrite')}</div>}
        <button type="button" disabled={!gueltig || anlegen.isPending || !online}
                onClick={() => anlegen.mutate(
                  { code: code.trim(), title: titel.trim(), body: text.trim(),
                    requiresSignature: unterschrift },
                  { onSuccess: () => { setCode(''); setTitel(''); setText('') } })}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('common.save')}
        </button>
      </div>
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
      {aktiv.key === 'terms' && <Hausbedingungen propertyId={propertyId} />}
      {aktiv.key === 'support' && <SupportZugriff />}
    </div>
  )
}
