import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PaymentMethod } from '@hotelpms/contracts'
import { useEmailSettings, useSaveEmailSettings, useEmailDomain,
         useRequestEmailDomain, useCheckEmailDomain, useWithdrawEmailDomain,
         usePaymentMethodsAll, useCreatePaymentMethod, useUpdatePaymentMethod }
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
  const domain = useEmailDomain(propertyId)
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
  // Solange der Stand nicht da ist, gilt "nicht frei": lieber ein Häkchen,
  // das kurz gesperrt aussieht, als eines, das sich anklicken lässt und
  // beim Speichern abgewiesen wird.
  const domainFrei = domain.data?.status === 'active'

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
        <input type="checkbox" checked={enabled}
               disabled={isTraining || !domainFrei}
               onChange={e => setEnabled(e.target.checked)} />
        {t('mail.enabled')}
      </label>
      {/* Der Grund steht an der gesperrten Stelle, nicht irgendwo: sonst
          sucht jemand den Fehler bei sich. Drei Gründe, drei Sätze -- ein
          gemeinsamer "geht nicht" ließe offen, was zu tun ist. */}
      <div className="text-xs text-neutral-500">
        {isTraining ? t('mail.training')
          : !domainFrei ? t('mailDomain.needed')
          : t('mail.enabledHint')}
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

// ------------------------------------------------------- Absenderdomain

/**
 * Antrag, Wartezeit und die drei Zeilen zum Abtippen.
 *
 * **Über dem Formular für die Absenderangaben**, nicht darunter: ohne
 * freigeschaltete Domain lässt sich der Versand nicht einschalten, und ein
 * Formular, dessen entscheidende Bedingung weiter unten steht, wird ausgefüllt
 * und dann abgewiesen.
 */
function Absenderdomain(
  { propertyId, isTraining }: { propertyId: number; isTraining: boolean }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useEmailDomain(propertyId)
  const beantragen = useRequestEmailDomain(propertyId)
  const nachsehen = useCheckEmailDomain(propertyId)
  const zuruecknehmen = useWithdrawEmailDomain(propertyId)

  const [modus, setModus] = useState<'own' | 'relay'>('own')
  const [domain, setDomain] = useState('')
  const [localPart, setLocalPart] = useState('')

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const d = q.data
  const relay = d.relayDomain ?? 'mail.staygrid.cloud'

  // Noch nichts beantragt, oder abgelehnt: das Formular.
  if (d.status === null || d.status === 'rejected') {
    const bereit = modus === 'own' ? domain.trim() !== '' : localPart.trim() !== ''
    return (
      <form className="rounded border border-neutral-200 bg-white p-3 space-y-3
                       max-w-2xl"
            onSubmit={e => {
              e.preventDefault()
              if (!bereit) return
              beantragen.mutate(modus === 'own'
                ? { mode: 'own', domain: domain.trim() }
                : { mode: 'relay', localPart: localPart.trim() })
            }}>
        <div className="font-medium">{t('mailDomain.title')}</div>
        <p className="text-sm text-neutral-600">{t('mailDomain.intro')}</p>

        {/* Die Ablehnung steht über dem neuen Antrag, nicht daneben: wer
            gerade abgelehnt wurde, soll den Grund lesen, bevor er dasselbe
            noch einmal einträgt. */}
        {d.status === 'rejected' && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">
            <div className="font-medium">{t('mailDomain.statusRejected')}</div>
            <div className="text-neutral-700">{d.decisionNote}</div>
          </div>
        )}

        <div className="space-y-1.5 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={modus === 'own'}
                   onChange={() => setModus('own')} />
            {t('mailDomain.modeOwn')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={modus === 'relay'}
                   onChange={() => setModus('relay')} />
            {t('mailDomain.modeRelay')}
          </label>
        </div>

        {modus === 'own' ? (
          <label className="text-sm block">
            <div className="text-neutral-600">{t('mailDomain.domainLabel')}</div>
            <input value={domain} onChange={e => setDomain(e.target.value)}
                   placeholder="hotel-wattenblick.de"
                   className="border border-neutral-300 rounded px-2 py-1 w-72" />
            <div className="text-xs text-neutral-500 mt-0.5">
              {t('mailDomain.domainHint')}
            </div>
          </label>
        ) : (
          <label className="text-sm block">
            <div className="text-neutral-600">{t('mailDomain.localPartLabel')}</div>
            <div className="flex items-center gap-1">
              <input value={localPart} onChange={e => setLocalPart(e.target.value)}
                     placeholder="wattenblick"
                     className="border border-neutral-300 rounded px-2 py-1 w-48" />
              <span className="text-neutral-600">@{relay}</span>
            </div>
            <div className="text-xs text-neutral-500 mt-0.5">
              {t('mailDomain.relayHint',
                 { address: `${localPart.trim() || 'name'}@${relay}` })}
            </div>
          </label>
        )}

        {beantragen.isError && <Fehler error={beantragen.error} />}

        <button type="submit"
                disabled={!online || !bereit || isTraining || beantragen.isPending}
                className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('mailDomain.request')}
        </button>
        {isTraining && (
          <div className="text-xs text-neutral-500">{t('mail.training')}</div>
        )}
      </form>
    )
  }

  const statusText: TextKey =
    d.status === 'requested'   ? 'mailDomain.statusRequested'
    : d.status === 'dns_pending' ? 'mailDomain.statusDnsPending'
    : 'mailDomain.statusActive'

  return (
    <div className="rounded border border-neutral-200 bg-white p-3 space-y-3
                    max-w-3xl">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{t('mailDomain.title')}</span>
        <span className="font-mono text-sm">
          {d.mode === 'relay' ? `${d.localPart}@${d.domain}` : d.domain}
        </span>
      </div>
      <div className={`text-sm ${d.status === 'active'
                                 ? 'text-emerald-700' : 'text-neutral-600'}`}>
        {t(statusText)}
      </div>

      {d.status === 'dns_pending' && (
        <>
          <p className="text-sm text-neutral-600">{t('mailDomain.dnsIntro')}</p>
          {/* Eine Tabelle und kein Fließtext: das hier wird abgetippt, und
              ein Wert mit einem verschluckten Zeichen ist der häufigste
              Grund, warum die Prüfung danach fehlschlägt. */}
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead className="text-neutral-500 text-left">
                <tr>
                  <th className="pr-3 pb-1 font-normal">{t('mailDomain.host')}</th>
                  <th className="pr-3 pb-1 font-normal">{t('mailDomain.type')}</th>
                  <th className="pr-3 pb-1 font-normal">{t('mailDomain.value')}</th>
                  <th className="pb-1 font-normal" />
                </tr>
              </thead>
              <tbody className="font-mono align-top">
                {d.dnsRecords.map(r => (
                  <tr key={`${r.host}-${r.type}`} className="border-t border-neutral-100">
                    <td className="pr-3 py-1">{r.host}</td>
                    <td className="pr-3 py-1">{r.type}</td>
                    <td className="pr-3 py-1 break-all">{r.value}</td>
                    <td className={`py-1 font-sans whitespace-nowrap
                                    ${r.ok ? 'text-emerald-700' : 'text-neutral-500'}`}>
                      {t(r.ok ? 'mailDomain.recordOk' : 'mailDomain.recordMissing')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-neutral-500">
            {t('mailDomain.lastChecked')}: {d.checkedAt === null
              ? t('mailDomain.neverChecked')
              : new Date(d.checkedAt).toLocaleString()}
          </div>

          {nachsehen.isError && <Fehler error={nachsehen.error} />}

          <button type="button" disabled={!online || nachsehen.isPending}
                  onClick={() => nachsehen.mutate()}
                  className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('mailDomain.check')}
          </button>
        </>
      )}

      {zuruecknehmen.isError && <Fehler error={zuruecknehmen.error} />}
      <div>
        <button type="button" disabled={!online || zuruecknehmen.isPending}
                onClick={() => zuruecknehmen.mutate()}
                className="text-sm px-2 py-1 rounded border border-neutral-300
                           text-neutral-700 disabled:opacity-40">
          {t('mailDomain.withdraw')}
        </button>
      </div>
    </div>
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
        <div className="space-y-4">
          {/* Die Domain steht oben: ohne sie lässt sich der Versand darunter
              nicht einschalten, und eine Bedingung, die unter dem Formular
              steht, liest niemand vorher. */}
          <Absenderdomain propertyId={propertyId} isTraining={isTraining} />
          <Gastpost propertyId={propertyId} isTraining={isTraining} />
        </div>
      )}
      {aktiv.key === 'pay' && <Zahlungsarten propertyId={propertyId} />}
      {aktiv.key === 'terms' && <Hausbedingungen propertyId={propertyId} />}
      {aktiv.key === 'support' && <SupportZugriff />}
    </div>
  )
}
