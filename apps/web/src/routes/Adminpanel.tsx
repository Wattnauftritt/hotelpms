import { useState } from 'react'
import type { JSX } from 'react'
import { usePlatformAccounts, usePlatformAccount, useSetAccountStatus,
         useCreateAccount, usePlatformStaff, useCreateStaff, useSetStaffStatus,
         usePlatformHealth,
         type PlatformAccount } from '../lib/queries/platform.js'
import { useT, useLocale, type TextKey } from '../lib/i18n/index.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Anfrage, Liste, Ausrollen } from './SupportKonsole.tsx'

/**
 * Das Adminpanel.
 *
 * **Was es ist und was ausdruecklich nicht.** Es ist der Bildschirm, mit dem
 * die Plattform sich selbst wartet: Kunden anlegen und sperren,
 * Plattformbenutzer vergeben, sehen, was haengt, ausrollen. Es ist **kein**
 * Zugang zu Kundendaten. Der laeuft ueber eine Support-Sitzung, die der
 * Kunde freigibt, und ausschliesslich darueber -- die Routen dahinter geben
 * Namen, Zustaende und Zahlen heraus, keine Gaeste, keine Buchungen, keine
 * Umsaetze.
 *
 * **Warum es Reiter hat und keine vier Bildschirme.** Die vier Bereiche
 * gehoeren einer Person am selben Tag: wer einen Kunden anlegt, laedt danach
 * seinen ersten Benutzer ein; wer einen Anruf annimmt, sieht erst den
 * Zustand und fragt dann eine Sitzung an. Vier Eintraege in der Navigation
 * waeren vier Wege fuer einen Vorgang.
 *
 * **Warum er in der Navigation steht.** Bis hierher erschien die Konsole nur
 * da, wo sonst "diesem Benutzer ist kein Haus zugeordnet" stuende. Das war
 * fuer Plattformpersonal ohne Sitzung als Normalzustand gedacht -- hiess
 * aber auch: sobald eine Support-Sitzung lief, war der Bildschirm weg, samt
 * Ausrollknopf. Erreichbar sein und zufaellig sichtbar sein ist nicht
 * dasselbe.
 */

type Reiter = 'accounts' | 'staff' | 'operations' | 'support'

const KONTO_ZUSTAND: Record<PlatformAccount['status'], TextKey> = {
  active: 'admin.status.active',
  suspended: 'admin.status.suspended',
  archived: 'admin.status.archived'
}

const PERSONAL_ZUSTAND: Record<string, TextKey> = {
  active: 'admin.status.active',
  invited: 'admin.status.invited',
  disabled: 'admin.status.disabled'
}

/** Was die Rolle kann -- fuer das Auswahlfeld beim Vergeben. */
const ROLLE: Record<string, TextKey> = {
  platform_admin: 'admin.role.platform_admin',
  platform_support: 'admin.role.platform_support',
  platform_billing: 'admin.role.platform_billing',
  platform_ops: 'admin.role.platform_ops'
}

/** Wie die Rolle heisst -- fuer die Liste. */
const ROLLE_KURZ: Record<string, TextKey> = {
  platform_admin: 'admin.roleShort.platform_admin',
  platform_support: 'admin.roleShort.platform_support',
  platform_billing: 'admin.roleShort.platform_billing',
  platform_ops: 'admin.roleShort.platform_ops'
}

const FELD = 'mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm'
const KNOPF = 'text-sm px-3 py-1.5 rounded bg-neutral-900 text-white disabled:bg-neutral-300'

function Abzeichen({ k, ton }: { k: TextKey; ton: 'gut' | 'warn' | 'still' }): JSX.Element {
  const t = useT()
  const farbe = ton === 'gut' ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
    : ton === 'warn' ? 'bg-red-50 text-red-900 border-red-200'
      : 'bg-neutral-100 text-neutral-700 border-neutral-200'
  return <span className={`text-xs px-1.5 py-0.5 rounded border ${farbe}`}>{t(k)}</span>
}

// -------------------------------------------------------------------- Kunden

function KundenListe({ onOpen }: { onOpen: (id: number) => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = usePlatformAccounts()

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  if (q.data.accounts.length === 0) {
    return <p className="text-sm text-neutral-600">{t('admin.accounts.none')}</p>
  }

  const datum = (iso: string | null) => iso === null
    ? t('admin.accounts.never')
    : new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' })

  return (
    <ul className="divide-y divide-neutral-100 border border-neutral-200 rounded bg-white">
      {q.data.accounts.map(a => (
        <li key={a.id}>
          <button type="button" onClick={() => onOpen(a.id)}
                  className="w-full text-left px-3 py-2 hover:bg-neutral-50">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-sm">{a.name}</span>
              <Abzeichen k={KONTO_ZUSTAND[a.status]}
                         ton={a.status === 'active' ? 'gut'
                           : a.status === 'suspended' ? 'warn' : 'still'} />
              <code className="text-xs font-mono text-neutral-400">{a.ref}</code>
            </div>
            <div className="text-xs text-neutral-600 flex flex-wrap gap-x-3">
              <span>{a.properties} {t('admin.accounts.properties')}</span>
              <span>{a.users} {t('admin.accounts.users')}</span>
              <span>{t('admin.accounts.lastLogin')}: {datum(a.lastLoginAt)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function KundeDetail({ id, onClose }: { id: number; onClose: () => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = usePlatformAccount(id)
  const setzen = useSetAccountStatus()

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const { account, properties, users } = q.data

  const zeit = (iso: string | null) => iso === null
    ? t('admin.accounts.never')
    : new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  /*
   * Gefragt wird mit dem Satz, der sagt, was passiert -- nicht mit "Sind Sie
   * sicher?". Eine Sperre wirkt sofort und trifft die Rezeption mitten im
   * Check-in; wer das liest, entscheidet anders als wer nur bestaetigt.
   */
  const wechseln = (status: 'active' | 'suspended' | 'archived',
                    frage: TextKey | null) => {
    if (frage !== null && !window.confirm(t(frage, { name: account.name }))) return
    setzen.mutate({ id, status })
  }

  return (
    <section className="space-y-3 border border-neutral-200 rounded p-4 bg-white">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">{account.name}</h2>
          {account.legalName !== null && (
            <p className="text-xs text-neutral-600">{account.legalName}</p>
          )}
        </div>
        <button type="button" onClick={onClose}
                className="text-sm px-2 py-1 border border-neutral-300 rounded">
          {t('booking.close')}
        </button>
      </div>

      <p className="text-xs text-neutral-600">{t('admin.accounts.supportHint')}</p>

      {setzen.isError && <Fehler error={setzen.error} />}

      <div className="flex flex-wrap items-center gap-2">
        <Abzeichen k={KONTO_ZUSTAND[account.status]}
                   ton={account.status === 'active' ? 'gut'
                     : account.status === 'suspended' ? 'warn' : 'still'} />
        {account.status === 'active' ? (
          <button type="button" disabled={setzen.isPending}
                  onClick={() => wechseln('suspended', 'admin.accounts.suspendConfirm')}
                  className="text-sm px-3 py-1.5 rounded border border-red-300
                             text-red-800 disabled:text-neutral-400">
            {t('admin.accounts.suspend')}
          </button>
        ) : (
          <button type="button" disabled={setzen.isPending}
                  onClick={() => wechseln('active', null)} className={KNOPF}>
            {t('admin.accounts.unsuspend')}
          </button>
        )}
        {account.status !== 'archived' && (
          <button type="button" disabled={setzen.isPending}
                  onClick={() => wechseln('archived', 'admin.accounts.archiveConfirm')}
                  className="text-sm px-3 py-1.5 rounded border border-neutral-300
                             disabled:text-neutral-400">
            {t('admin.accounts.archive')}
          </button>
        )}
      </div>

      <div>
        <h3 className="text-xs font-medium text-neutral-600 uppercase tracking-wide">
          {t('admin.accounts.properties')}
        </h3>
        <ul className="mt-1 space-y-1 text-sm">
          {properties.map(p => (
            <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs">{p.code}</span>
              <span>{p.name}</span>
              <span className="text-xs text-neutral-500">
                {p.rooms} {t('admin.accounts.rooms')}
              </span>
              {/* Weit vorn, nicht als Fussnote: ein Uebungshaus exportiert
                  nichts nach draussen. Wer sucht, warum ein DATEV-Export
                  "nichts tut", soll es hier sehen und nicht im Export. */}
              {p.isTraining && <Abzeichen k="admin.accounts.training" ton="warn" />}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-medium text-neutral-600 uppercase tracking-wide">
          {t('admin.accounts.users')}
        </h3>
        <ul className="mt-1 space-y-1 text-sm">
          {users.map(u => (
            <li key={u.id} className="flex flex-wrap items-baseline gap-x-2">
              <span>{u.displayName}</span>
              <span className="text-xs text-neutral-500">{u.email}</span>
              {u.status !== 'active' && PERSONAL_ZUSTAND[u.status] !== undefined && (
                <Abzeichen k={PERSONAL_ZUSTAND[u.status]!} ton="still" />
              )}
              {u.lockedUntil !== null && (
                <span className="text-xs text-red-800">
                  {t('admin.accounts.locked', { bis: zeit(u.lockedUntil) })}
                </span>
              )}
              {u.roles !== null && (
                <span className="text-xs text-neutral-500">{u.roles}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/**
 * Kunden anlegen.
 *
 * Bis hierher lief das ueber `curl`. Die Pflichtfelder sind nicht Geschmack:
 * ohne Anschrift und Steuernummer ist das Haus nach § 14 UStG nicht
 * rechnungsfaehig, und das faellt sonst erst bei der ersten Rechnung auf.
 */
function KundeAnlegen(): JSX.Element {
  const t = useT()
  const anlegen = useCreateAccount()
  const [f, setF] = useState<Record<string, string>>({})
  const [uebung, setUebung] = useState(false)
  const setz = (k: string) => (e: { target: { value: string } }) =>
    setF(v => ({ ...v, [k]: e.target.value }))

  const felder: Array<[string, TextKey, boolean]> = [
    ['accountName', 'admin.field.accountName', true],
    ['code', 'admin.field.code', true],
    ['name', 'admin.field.propertyName', true],
    ['addressLine1', 'admin.field.addressLine1', true],
    ['postalCode', 'admin.field.postalCode', true],
    ['city', 'admin.field.city', true],
    ['taxNumber', 'admin.field.taxNumber', true],
    ['vatId', 'admin.field.vatId', false],
    ['userName', 'admin.field.userName', true],
    ['userEmail', 'admin.field.userEmail', true]
  ]

  return (
    <form className="space-y-3 border border-neutral-200 rounded p-4 bg-white"
          onSubmit={e => {
            e.preventDefault()
            anlegen.mutate({ ...f, isTraining: uebung },
              { onSuccess: () => { setF({}); setUebung(false) } })
          }}>
      <h2 className="text-sm font-medium">{t('admin.accounts.new')}</h2>
      <p className="text-xs text-neutral-600">{t('admin.accounts.invoiceHint')}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        {felder.map(([k, label, pflicht]) => (
          <label key={k} className="block">
            <span className="block text-xs text-neutral-600">{t(label)}</span>
            <input required={pflicht} value={f[k] ?? ''} onChange={setz(k)}
                   type={k === 'userEmail' ? 'email' : 'text'} className={FELD} />
          </label>
        ))}
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={uebung} className="mt-1"
               onChange={e => setUebung(e.target.checked)} />
        <span>{t('admin.field.isTraining')}</span>
      </label>

      {anlegen.isError && <Fehler error={anlegen.error} />}
      {anlegen.isSuccess && (
        <p className="text-sm text-green-900 bg-green-50 border border-green-200
                      rounded px-2 py-1">{t('admin.accounts.created.done')}</p>
      )}

      <button type="submit" disabled={anlegen.isPending} className={KNOPF}>
        {t(anlegen.isPending ? 'common.loading' : 'admin.accounts.new')}
      </button>
    </form>
  )
}

// --------------------------------------------------------- Plattformbenutzer

function Personal({ eigeneId }: { eigeneId: number | null }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = usePlatformStaff()
  const anlegen = useCreateStaff()
  const setzen = useSetStaffStatus()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [rolle, setRolle] = useState('platform_support')

  const zeit = (iso: string | null) => iso === null
    ? t('admin.accounts.never')
    : new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  return (
    <div className="space-y-4">
      <form className="space-y-3 border border-neutral-200 rounded p-4 bg-white"
            onSubmit={e => {
              e.preventDefault()
              anlegen.mutate({ email: email.trim(), displayName: name.trim(),
                roleKey: rolle }, { onSuccess: () => { setEmail(''); setName('') } })
            }}>
        <h2 className="text-sm font-medium">{t('admin.staff.new')}</h2>
        <p className="text-xs text-neutral-600">{t('admin.staff.hint')}</p>

        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block">
            <span className="block text-xs text-neutral-600">{t('admin.staff.name')}</span>
            <input required value={name} onChange={e => setName(e.target.value)}
                   className={FELD} />
          </label>
          <label className="block">
            <span className="block text-xs text-neutral-600">{t('admin.staff.email')}</span>
            <input required type="email" value={email}
                   onChange={e => setEmail(e.target.value)} className={FELD} />
          </label>
          <label className="block">
            <span className="block text-xs text-neutral-600">{t('admin.staff.role')}</span>
            <select value={rolle} onChange={e => setRolle(e.target.value)}
                    className={FELD}>
              {(q.data?.roles ?? Object.keys(ROLLE)).map(r => (
                <option key={r} value={r}>{ROLLE[r] !== undefined ? t(ROLLE[r]) : r}</option>
              ))}
            </select>
          </label>
        </div>

        {anlegen.isError && <Fehler error={anlegen.error} />}
        {anlegen.isSuccess && (
          <p className="text-sm text-green-900 bg-green-50 border border-green-200
                        rounded px-2 py-1">{t('admin.staff.invited')}</p>
        )}

        <button type="submit" disabled={anlegen.isPending} className={KNOPF}>
          {t(anlegen.isPending ? 'common.loading' : 'admin.staff.new')}
        </button>
      </form>

      {setzen.isError && <Fehler error={setzen.error} />}
      {q.isError && <Fehler error={q.error} />}
      {q.data === undefined ? <Laedt /> : (
        <ul className="divide-y divide-neutral-100 border border-neutral-200
                       rounded bg-white">
          {q.data.staff.map(p => (
            <li key={p.id} className="px-3 py-2 flex flex-wrap items-center gap-x-2">
              <span className="text-sm font-medium">{p.displayName}</span>
              <span className="text-xs text-neutral-500">{p.email}</span>
              {/* Der uebersetzte Name, nicht `roleName` aus der Datenbank:
                  der ist deutsch und bliebe es auch in einer englischen
                  Oberflaeche. */}
              {p.roleKey !== null && ROLLE_KURZ[p.roleKey] !== undefined && (
                <span className="text-xs text-neutral-600">
                  {t(ROLLE_KURZ[p.roleKey]!)}
                </span>
              )}
              {PERSONAL_ZUSTAND[p.status] !== undefined && (
                <Abzeichen k={PERSONAL_ZUSTAND[p.status]!}
                           ton={p.status === 'active' ? 'gut' : 'still'} />
              )}
              <span className="text-xs text-neutral-500">{zeit(p.lastLoginAt)}</span>
              <span className="grow" />
              {/* Der eigene Zugang traegt keinen Knopf. Die Route weist es
                  ohnehin ab -- aber ein Knopf, der nur 409 sagt, ist eine
                  Falle und keine Sicherung. */}
              {p.id === eigeneId ? (
                <span className="text-xs text-neutral-400">{t('admin.staff.you')}</span>
              ) : (
                <button type="button" disabled={setzen.isPending}
                        onClick={() => setzen.mutate({ id: p.id,
                          status: p.status === 'disabled' ? 'active' : 'disabled' })}
                        className="text-xs px-2 py-1 border border-neutral-300 rounded
                                   disabled:text-neutral-400">
                  {t(p.status === 'disabled' ? 'admin.staff.enable' : 'admin.staff.disable')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Betrieb

/** Ab wann ein Nachtlauf als stehengeblieben gilt: gestern muss zu sein. */
const NACHTLAUF_TOLERANZ_TAGE = 2

function Zustand(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = usePlatformHealth()

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const zeit = (iso: string | null) => iso === null ? '—'
    : new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  const heute = new Date()
  const alt = (tag: string | null): boolean => {
    if (tag === null) return false
    const tage = (heute.getTime() - new Date(`${tag}T00:00:00Z`).getTime())
      / 86_400_000
    return tage > NACHTLAUF_TOLERANZ_TAGE
  }

  const auffaellig = q.data.accounts.filter(a =>
    a.emailsPending > 0 || a.emailsFailed > 0 || a.webhooksFailed > 0
    || alt(a.nightAuditLast))

  return (
    <section className="space-y-3 border border-neutral-200 rounded p-4 bg-white">
      <h2 className="text-sm font-medium">{t('admin.health.title')}</h2>
      <p className="text-xs text-neutral-600">{t('admin.health.hint')}</p>

      {auffaellig.length === 0 ? (
        <p className="text-sm text-neutral-600">{t('admin.health.allClear')}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {auffaellig.map(a => (
            <li key={a.accountId} className="border-t border-neutral-100 pt-2">
              <div className="font-medium">{a.accountName}</div>
              <div className="text-xs text-neutral-700 flex flex-wrap gap-x-3">
                {a.emailsPending > 0 && (
                  <span>{t('admin.health.emails')}: {a.emailsPending}</span>
                )}
                {a.emailsFailed > 0 && (
                  <span className="text-red-800">
                    {t('admin.health.emailsFailed')}: {a.emailsFailed}
                    {a.emailsOldest !== null
                      && ` (${t('admin.health.since', { seit: zeit(a.emailsOldest) })})`}
                  </span>
                )}
                {a.webhooksFailed > 0 && (
                  <span className="text-red-800">
                    {t('admin.health.webhooks')}: {a.webhooksFailed}
                    {a.webhooksOldest !== null
                      && ` (${t('admin.health.since', { seit: zeit(a.webhooksOldest) })})`}
                  </span>
                )}
                {alt(a.nightAuditLast) && (
                  <span className="text-red-800">
                    {t('admin.health.nightAudit')}: {a.nightAuditLast} —{' '}
                    {t('admin.health.nightAuditStale')}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// -------------------------------------------------------------------- Rahmen

export function Adminpanel({ userId, platformPermissions = [] }: {
  userId?: number | null
  platformPermissions?: readonly string[]
}): JSX.Element {
  const t = useT()
  const [kunde, setKunde] = useState<number | null>(null)

  /*
   * Ein Reiter je Recht. Nicht aus Sicherheit -- die liegt in der API und in
   * den Funktionen dahinter --, sondern damit niemand einen Reiter oeffnet,
   * der ihm nur mit 403 antwortet. Ein Support-Zugang darf Sitzungen
   * anfragen und ausrollen, aber keine Kunden anlegen und keine Kollegen.
   */
  const reiters: Array<[Reiter, TextKey, string]> = ([
    ['accounts', 'admin.tab.accounts', 'platform:accounts'],
    ['staff', 'admin.tab.staff', 'platform:staff'],
    ['operations', 'admin.tab.operations', 'platform:operations'],
    ['support', 'admin.tab.support', 'platform:support_session']
  ] as Array<[Reiter, TextKey, string]>)
    .filter(([, , recht]) => platformPermissions.includes(recht))

  const [reiter, setReiter] = useState<Reiter | null>(null)
  const offen = reiter !== null && reiters.some(([k]) => k === reiter)
    ? reiter
    : reiters[0]?.[0] ?? null

  if (offen === null) {
    // Plattformpersonal ohne ein einziges Plattformrecht. Kommt vor, wenn
    // jemandem die Rolle entzogen wurde und das Kennzeichen stehenblieb.
    return <p className="text-sm text-neutral-600">{t('admin.noPermission')}</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-neutral-200">
        {reiters.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setReiter(k)}
                  className={`text-sm px-3 py-1.5 -mb-px border-b-2 ${offen === k
                    ? 'border-neutral-900 font-medium'
                    : 'border-transparent text-neutral-600'}`}>
            {t(label)}
          </button>
        ))}
      </div>

      {offen === 'accounts' && (
        <div className="space-y-4">
          {kunde !== null && (
            <KundeDetail id={kunde} onClose={() => setKunde(null)} />
          )}
          <KundenListe onOpen={setKunde} />
          <KundeAnlegen />
        </div>
      )}

      {offen === 'staff' && <Personal eigeneId={userId ?? null} />}

      {offen === 'operations' && (
        <div className="space-y-4">
          <Zustand />
          <Ausrollen />
        </div>
      )}

      {offen === 'support' && (
        <div className="space-y-4">
          <Anfrage />
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('support.mine')}</h2>
            <Liste />
          </section>
        </div>
      )}
    </div>
  )
}

/**
 * Derselbe Bildschirm ganzseitig -- fuer Plattformpersonal ohne Haus.
 *
 * Ohne freigegebene Sitzung hat es einen leeren Mandantenkontext und damit
 * kein Haus; die gewoehnliche Oberflaeche haette dann nichts anzuzeigen. Der
 * richtige Bildschirm ist hier, nicht eine Fehlermeldung.
 */
export function AdminpanelSeite({ userId, platformPermissions }: {
  userId?: number | null
  platformPermissions?: readonly string[]
}): JSX.Element {
  const t = useT()
  return (
    <div className="min-h-screen bg-neutral-50 p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <h1 className="text-lg font-semibold">{t('admin.title')}</h1>
        <Adminpanel userId={userId} platformPermissions={platformPermissions} />
      </div>
    </div>
  )
}
