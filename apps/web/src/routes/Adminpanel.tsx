import { useState } from 'react'
import type { JSX } from 'react'
import { usePlatformAccounts, usePlatformAccount, useSetAccountStatus,
         useCreateAccount, usePlatformStaff, useCreateStaff, useSetStaffStatus,
         usePlatformHealth, useUnlockUser, useSendAccessLink, useRevokeSessions,
         useInviteAccountUser, useAddProperty, useAccountSupportSessions,
         useSetCustomerPropertyRoles, useSetCustomerAccountRoles,
         useSupportAudit, useSessionActivity, useSetStaffRole, useStaffAccessLink,
         type PlatformAccount, type PlatformAccountUser, type PlatformProperty,
         type SupportAuditRow } from '../lib/queries/platform.js'
import { useT, useLocale, type TextKey } from '../lib/i18n/index.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Anfrage, Liste, Ausrollen } from './SupportKonsole.tsx'

/**
 * Das Adminpanel.
 *
 * **Was es ist und was ausdruecklich nicht.** Es ist der Bildschirm, mit dem
 * die Plattform sich selbst wartet: Kunden anlegen und sperren,
 * Plattformbenutzer vergeben, sehen, was haengt, ausrollen -- und die
 * Handgriffe des Supports am Telefon: entsperren, einen Link schicken,
 * Sitzungen beenden, einen Benutzer einladen. Es ist **kein** Zugang zu
 * Kundendaten. Der laeuft ueber eine Support-Sitzung, die der Kunde
 * freigibt, und ausschliesslich darueber -- die Routen dahinter geben
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

/*
 * Die Rollen des Kunden, die das Panel vergeben darf. Dieselbe Liste wie in
 * der Route; der Name kommt aus dem Katalog und nicht aus `role.name`, der
 * deutsch ist und es in jeder Sprache bliebe.
 */
const KUNDEN_ROLLEN: Array<[string, TextKey, 'account' | 'property']> = [
  ['owner', 'admin.crole.owner', 'account'],
  ['account_admin', 'admin.crole.account_admin', 'account'],
  ['accounting', 'admin.crole.accounting', 'account'],
  ['revenue', 'admin.crole.revenue', 'account'],
  ['tax_advisor', 'admin.crole.tax_advisor', 'account'],
  ['read_only', 'admin.crole.read_only', 'account'],
  ['hotel_director', 'admin.crole.hotel_director', 'property'],
  ['front_office_mgr', 'admin.crole.front_office_mgr', 'property'],
  ['reception', 'admin.crole.reception', 'property'],
  ['reservations', 'admin.crole.reservations', 'property'],
  ['night_audit', 'admin.crole.night_audit', 'property'],
  ['housekeeping', 'admin.crole.housekeeping', 'property'],
  ['maintenance', 'admin.crole.maintenance', 'property']
]

const SITZUNG_ZUSTAND: Record<SupportAuditRow['state'], TextKey> = {
  pending: 'support.state.pending',
  active: 'support.state.active',
  expired: 'support.state.expired',
  revoked: 'support.state.revoked'
}

const MAIL_ZUSTAND: Record<string, TextKey> = {
  pending: 'admin.mail.pending',
  sent: 'admin.mail.sent',
  failed: 'admin.mail.failed'
}

const FELD = 'mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm'
const KNOPF = 'text-sm px-3 py-1.5 rounded bg-neutral-900 text-white disabled:bg-neutral-300'
const KNOPF_KLEIN = 'text-xs px-2 py-1 border border-neutral-300 rounded disabled:text-neutral-400'
const UEBERSCHRIFT = 'text-xs font-medium text-neutral-600 uppercase tracking-wide'

function Abzeichen({ k, ton }: { k: TextKey; ton: 'gut' | 'warn' | 'still' }): JSX.Element {
  const t = useT()
  const farbe = ton === 'gut' ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
    : ton === 'warn' ? 'bg-red-50 text-red-900 border-red-200'
      : 'bg-neutral-100 text-neutral-700 border-neutral-200'
  return <span className={`text-xs px-1.5 py-0.5 rounded border ${farbe}`}>{t(k)}</span>
}

function Erfolg({ k, params }: { k: TextKey; params?: Record<string, string | number> }): JSX.Element {
  const t = useT()
  return (
    <p className="text-sm text-green-900 bg-green-50 border border-green-200
                  rounded px-2 py-1">{t(k, params)}</p>
  )
}

function useZeit(): (iso: string | null) => string {
  const t = useT()
  const locale = useLocale()
  return (iso) => iso === null
    ? t('admin.accounts.never')
    : new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
}

// -------------------------------------------------------------------- Kunden

function KundenListe({ onOpen }: { onOpen: (id: number) => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = usePlatformAccounts()
  const [filter, setFilter] = useState('')

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  if (q.data.accounts.length === 0) {
    return <p className="text-sm text-neutral-600">{t('admin.accounts.none')}</p>
  }

  const datum = (iso: string | null) => iso === null
    ? t('admin.accounts.never')
    : new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' })

  // Gefiltert wird im Browser: die Liste ist schon da, und die Zahl der
  // Kunden waechst mit dem Vertrieb, nicht mit dem Betrieb.
  const suche = filter.trim().toLowerCase()
  const treffer = suche === '' ? q.data.accounts
    : q.data.accounts.filter(a =>
        a.name.toLowerCase().includes(suche)
        || (a.legalName ?? '').toLowerCase().includes(suche)
        || a.ref.toLowerCase().includes(suche))

  return (
    <div className="space-y-2">
      <input value={filter} onChange={e => setFilter(e.target.value)}
             placeholder={t('admin.accounts.filter')} className={FELD} />
      <ul className="divide-y divide-neutral-100 border border-neutral-200 rounded bg-white">
        {treffer.map(a => (
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
    </div>
  )
}

/**
 * Ein Benutzer des Kunden mit den drei Handgriffen des Supports.
 *
 * Entsperren, einen Link schicken, ueberall abmelden -- das sind die drei
 * Saetze, die am Telefon fallen, und keiner davon fasst ein Kennwort an. Der
 * Zustand der letzten Post steht daneben, weil "die Einladung ist nie
 * angekommen" die zweithaeufigste Frage ist und die Antwort hier steht:
 * noch nicht versendet, gescheitert (mit dem Fehler), oder versendet -- dann
 * liegt sie im Spam.
 */
function KundenBenutzer({ accountId, u, properties }: {
  accountId: number; u: PlatformAccountUser; properties: PlatformProperty[]
}): JSX.Element {
  const t = useT()
  const zeit = useZeit()
  const entsperren = useUnlockUser()
  const link = useSendAccessLink()
  const abmelden = useRevokeSessions()
  const [rollenOffen, setRollenOffen] = useState(false)

  return (
    <li className="py-1.5 space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
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
        {u.lastMail !== null && MAIL_ZUSTAND[u.lastMail.status] !== undefined && (
          <span className={`text-xs ${u.lastMail.status === 'failed'
            ? 'text-red-800' : 'text-neutral-500'}`}
                title={u.lastMail.error ?? undefined}>
            {t(u.lastMail.kind === 'invite' ? 'admin.mail.invite' : 'admin.mail.password_reset')}
            {': '}{t(MAIL_ZUSTAND[u.lastMail.status]!)}
            {' · '}{zeit(u.lastMail.at)}
          </span>
        )}
      </div>
      {u.status !== 'disabled' && (
        <div className="flex flex-wrap items-center gap-2">
          {u.lockedUntil !== null && (
            <button type="button" className={KNOPF_KLEIN} disabled={entsperren.isPending}
                    onClick={() => entsperren.mutate({ accountId, userId: u.id })}>
              {t('admin.user.unlock')}
            </button>
          )}
          <button type="button" className={KNOPF_KLEIN} disabled={link.isPending}
                  onClick={() => link.mutate({ accountId, userId: u.id })}>
            {t(u.status === 'invited' ? 'admin.user.sendInvite' : 'admin.user.sendReset')}
          </button>
          {u.status === 'active' && (
            <button type="button" className={KNOPF_KLEIN} disabled={abmelden.isPending}
                    onClick={() => {
                      if (window.confirm(t('admin.user.revokeConfirm', { name: u.displayName }))) {
                        abmelden.mutate({ accountId, userId: u.id })
                      }
                    }}>
              {t('admin.user.revokeSessions')}
            </button>
          )}
          <button type="button" className={KNOPF_KLEIN}
                  onClick={() => setRollenOffen(o => !o)}>
            {t('admin.user.roles')}
          </button>
          {link.isSuccess && <span className="text-xs text-green-800">{t('admin.user.linkSent')}</span>}
          {abmelden.isSuccess && (
            <span className="text-xs text-green-800">
              {t('admin.user.sessionsRevoked', { n: abmelden.data.revoked })}
            </span>
          )}
        </div>
      )}
      {rollenOffen && u.status !== 'disabled' && (
        <RollenEditor accountId={accountId} u={u} properties={properties} />
      )}
      {entsperren.isError && <Fehler error={entsperren.error} />}
      {link.isError && <Fehler error={link.error} />}
      {abmelden.isError && <Fehler error={abmelden.error} />}
    </li>
  )
}

/** Ein Satz Kaestchen je Rolle -- ersetzend gespeichert. */
function RollenKaestchen({ rollen, gewaehlt, onChange }: {
  rollen: Array<[string, TextKey]>; gewaehlt: string[]; onChange: (keys: string[]) => void
}): JSX.Element {
  const t = useT()
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {rollen.map(([k, label]) => (
        <label key={k} className="text-xs flex items-center gap-1.5">
          <input type="checkbox" checked={gewaehlt.includes(k)}
                 onChange={() => onChange(gewaehlt.includes(k)
                   ? gewaehlt.filter(x => x !== k) : [...gewaehlt, k])} />
          {t(label)}
        </label>
      ))}
    </div>
  )
}

/**
 * Rollen eines Kundenbenutzers aendern: je Haus des Kunden ein Satz
 * Hausrollen, dazu die Rollen fuer den ganzen Betrieb. Ersetzend, wie beim
 * Kunden selbst -- und dieselbe Sperre: der letzte Verwalter bleibt, die
 * Route sagt es, und der Fehler steht dann hier.
 */
function RollenEditor({ accountId, u, properties }: {
  accountId: number; u: PlatformAccountUser; properties: PlatformProperty[]
}): JSX.Element {
  const t = useT()
  const hausRollen = KUNDEN_ROLLEN.filter(r => r[2] === 'property')
    .map(([k, label]) => [k, label] as [string, TextKey])
  const betriebsRollen = KUNDEN_ROLLEN.filter(r => r[2] === 'account')
    .map(([k, label]) => [k, label] as [string, TextKey])
  const hausSetzen = useSetCustomerPropertyRoles()
  const betriebSetzen = useSetCustomerAccountRoles()
  const [jeHaus, setJeHaus] = useState<Record<number, string[]>>(() =>
    Object.fromEntries(properties.map(p => [
      p.id, u.propertyRoles.find(r => r.propertyId === p.id)?.roleKeys ?? []])))
  const [betrieb, setBetrieb] = useState<string[]>(u.accountRoles)

  return (
    <div className="mt-1 space-y-2 border-l-2 border-neutral-200 pl-3">
      <p className="text-xs text-neutral-600">{t('admin.user.rolesHint')}</p>
      {properties.map(p => (
        <form key={p.id} className="space-y-1"
              onSubmit={e => {
                e.preventDefault()
                hausSetzen.mutate({ accountId, userId: u.id, propertyId: p.id,
                                    roleKeys: jeHaus[p.id] ?? [] })
              }}>
          <span className="text-xs font-medium">{t('admin.user.rolesIn', { code: p.code })}</span>
          <RollenKaestchen rollen={hausRollen} gewaehlt={jeHaus[p.id] ?? []}
                           onChange={keys => setJeHaus(alt => ({ ...alt, [p.id]: keys }))} />
          <button type="submit" className={KNOPF_KLEIN} disabled={hausSetzen.isPending}>
            {t('common.save')}
          </button>
        </form>
      ))}
      <form className="space-y-1"
            onSubmit={e => {
              e.preventDefault()
              betriebSetzen.mutate({ accountId, userId: u.id, roleKeys: betrieb })
            }}>
        <span className="text-xs font-medium">{t('admin.user.rolesAccount')}</span>
        <RollenKaestchen rollen={betriebsRollen} gewaehlt={betrieb} onChange={setBetrieb} />
        <button type="submit" className={KNOPF_KLEIN} disabled={betriebSetzen.isPending}>
          {t('common.save')}
        </button>
      </form>
      {(hausSetzen.isSuccess || betriebSetzen.isSuccess) && (
        <span className="text-xs text-green-800">{t('admin.user.rolesSaved')}</span>
      )}
      {hausSetzen.isError && <Fehler error={hausSetzen.error} />}
      {betriebSetzen.isError && <Fehler error={betriebSetzen.error} />}
    </div>
  )
}

/**
 * Benutzer beim Kunden einladen.
 *
 * Der Kunde kann das seit der Selbstverwaltung (0040) auch selbst; hier
 * bleibt es fuer den Fall, dass niemand beim Kunden mehr hereinkommt.
 */
function BenutzerEinladen({ accountId, properties }: {
  accountId: number; properties: PlatformProperty[]
}): JSX.Element {
  const t = useT()
  const einladen = useInviteAccountUser()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [rolle, setRolle] = useState('reception')
  const [haus, setHaus] = useState<string>(String(properties[0]?.id ?? ''))
  const ebene = KUNDEN_ROLLEN.find(([k]) => k === rolle)?.[2] ?? 'property'

  return (
    <form className="space-y-2 border-t border-neutral-100 pt-3"
          onSubmit={e => {
            e.preventDefault()
            einladen.mutate({
              accountId, email: email.trim(), displayName: name.trim(), roleKey: rolle,
              propertyId: ebene === 'property' ? Number(haus) : null
            }, { onSuccess: () => { setEmail(''); setName('') } })
          }}>
      <h3 className={UEBERSCHRIFT}>{t('admin.invite.title')}</h3>
      <p className="text-xs text-neutral-600">{t('admin.invite.hint')}</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('admin.staff.name')}</span>
          <input required value={name} onChange={e => setName(e.target.value)} className={FELD} />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('admin.staff.email')}</span>
          <input required type="email" value={email}
                 onChange={e => setEmail(e.target.value)} className={FELD} />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('admin.staff.role')}</span>
          <select value={rolle} onChange={e => setRolle(e.target.value)} className={FELD}>
            {KUNDEN_ROLLEN.map(([k, label]) => (
              <option key={k} value={k}>{t(label)}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('admin.invite.scope')}</span>
          {ebene === 'account' ? (
            <input disabled value={t('admin.invite.scopeAccount')} className={FELD} />
          ) : (
            <select value={haus} onChange={e => setHaus(e.target.value)} className={FELD}>
              {properties.map(p => (
                <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
              ))}
            </select>
          )}
        </label>
      </div>
      {einladen.isError && <Fehler error={einladen.error} />}
      {einladen.isSuccess && <Erfolg k="admin.invite.done" />}
      <button type="submit" disabled={einladen.isPending || (ebene === 'property' && haus === '')}
              className={KNOPF}>
        {t(einladen.isPending ? 'common.loading' : 'admin.invite.title')}
      </button>
    </form>
  )
}

/** Dieselben Pflichtfelder wie beim Anlegen des Kunden, ohne den Benutzer. */
const HAUS_FELDER: Array<[string, TextKey, boolean]> = [
  ['code', 'admin.field.code', true],
  ['name', 'admin.field.propertyName', true],
  ['addressLine1', 'admin.field.addressLine1', true],
  ['postalCode', 'admin.field.postalCode', true],
  ['city', 'admin.field.city', true],
  ['taxNumber', 'admin.field.taxNumber', true],
  ['vatId', 'admin.field.vatId', false]
]

function HausAnlegen({ accountId }: { accountId: number }): JSX.Element {
  const t = useT()
  const anlegen = useAddProperty()
  const [offen, setOffen] = useState(false)
  const [f, setF] = useState<Record<string, string>>({})
  const [uebung, setUebung] = useState(false)

  if (!offen) {
    return (
      <button type="button" className={KNOPF_KLEIN} onClick={() => setOffen(true)}>
        {t('admin.property.new')}
      </button>
    )
  }
  return (
    <form className="space-y-2 border-t border-neutral-100 pt-3"
          onSubmit={e => {
            e.preventDefault()
            anlegen.mutate({ accountId, ...f, isTraining: uebung },
              { onSuccess: () => { setF({}); setUebung(false) } })
          }}>
      <h3 className={UEBERSCHRIFT}>{t('admin.property.new')}</h3>
      <p className="text-xs text-neutral-600">{t('admin.accounts.invoiceHint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {HAUS_FELDER.map(([k, label, pflicht]) => (
          <label key={k} className="block">
            <span className="block text-xs text-neutral-600">{t(label)}</span>
            <input required={pflicht} value={f[k] ?? ''}
                   onChange={e => setF(v => ({ ...v, [k]: e.target.value }))}
                   className={FELD} />
          </label>
        ))}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={uebung} className="mt-1"
               onChange={e => setUebung(e.target.checked)} />
        <span>{t('admin.field.isTraining')}</span>
      </label>
      {anlegen.isError && <Fehler error={anlegen.error} />}
      {anlegen.isSuccess && <Erfolg k="admin.property.done" />}
      <div className="flex gap-2">
        <button type="submit" disabled={anlegen.isPending} className={KNOPF}>
          {t(anlegen.isPending ? 'common.loading' : 'admin.property.new')}
        </button>
        <button type="button" className={KNOPF_KLEIN} onClick={() => setOffen(false)}>
          {t('booking.close')}
        </button>
      </div>
    </form>
  )
}

/** Eine Support-Sitzung in einer Zeile, mit aufklappbaren Aenderungszahlen. */
function SitzungZeile({ s, mitKunde }: { s: SupportAuditRow; mitKunde: boolean }): JSX.Element {
  const t = useT()
  const zeit = useZeit()
  const [offen, setOffen] = useState(false)
  const aktivitaet = useSessionActivity(offen ? s.id : null)

  return (
    <li className="py-1.5 text-sm space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {mitKunde && <span className="font-medium">{s.accountName}</span>}
        <span>{s.staffName}</span>
        <Abzeichen k={SITZUNG_ZUSTAND[s.state]}
                   ton={s.state === 'active' ? 'gut' : s.state === 'pending' ? 'warn' : 'still'} />
        <span className="text-xs text-neutral-600">
          {t(s.level === 'write' ? 'support.level.write' : 'support.level.read')}
        </span>
        <span className="text-xs text-neutral-500">{zeit(s.requestedAt)}</span>
        <button type="button" onClick={() => setOffen(!offen)}
                className="text-xs underline underline-offset-2 text-neutral-600">
          {t('admin.audit.activity')}
        </button>
      </div>
      <p className="text-xs text-neutral-700">{s.reason}</p>
      {offen && aktivitaet.data !== undefined && (
        aktivitaet.data.activity.length === 0
          ? <p className="text-xs text-neutral-500">{t('admin.audit.noActivity')}</p>
          : <ul className="text-xs text-neutral-700 flex flex-wrap gap-x-3">
              {aktivitaet.data.activity.map(a => (
                <li key={`${a.table}-${a.action}`}>
                  <code className="font-mono">{a.table}</code> {a.action.toLowerCase()} × {a.count}
                </li>
              ))}
            </ul>
      )}
    </li>
  )
}

function KundenSitzungen({ accountId, accountName }: {
  accountId: number; accountName: string
}): JSX.Element {
  const t = useT()
  const q = useAccountSupportSessions(accountId)
  const [anfrage, setAnfrage] = useState(false)

  return (
    <div className="space-y-2 border-t border-neutral-100 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className={UEBERSCHRIFT}>{t('admin.sessions.title')}</h3>
        <button type="button" className={KNOPF_KLEIN} onClick={() => setAnfrage(!anfrage)}>
          {t('admin.sessions.request')}
        </button>
      </div>
      {anfrage && (
        <Anfrage accountId={accountId} accountName={accountName}
                 onDone={() => { setAnfrage(false); void q.refetch() }} />
      )}
      {q.isError && <Fehler error={q.error} />}
      {q.data !== undefined && (
        q.data.sessions.length === 0
          ? <p className="text-xs text-neutral-500">{t('admin.sessions.none')}</p>
          : <ul className="divide-y divide-neutral-100">
              {q.data.sessions.map(s => <SitzungZeile key={s.id} s={s} mitKunde={false} />)}
            </ul>
      )}
    </div>
  )
}

function KundeDetail({ id, onClose, darfSupport }: {
  id: number; onClose: () => void; darfSupport: boolean
}): JSX.Element {
  const t = useT()
  const q = usePlatformAccount(id)
  const setzen = useSetAccountStatus()

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const { account, properties, users } = q.data

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
        <h3 className={UEBERSCHRIFT}>{t('admin.accounts.properties')}</h3>
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
        <div className="mt-2"><HausAnlegen accountId={id} /></div>
      </div>

      <div>
        <h3 className={UEBERSCHRIFT}>{t('admin.accounts.users')}</h3>
        <ul className="mt-1 divide-y divide-neutral-100 text-sm">
          {users.map(u => (
            <KundenBenutzer key={u.id} accountId={id} u={u} properties={properties} />
          ))}
        </ul>
      </div>

      <BenutzerEinladen accountId={id} properties={properties} />

      {darfSupport && <KundenSitzungen accountId={id} accountName={account.name} />}
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
      {anlegen.isSuccess && <Erfolg k="admin.accounts.created.done" />}

      <button type="submit" disabled={anlegen.isPending} className={KNOPF}>
        {t(anlegen.isPending ? 'common.loading' : 'admin.accounts.new')}
      </button>
    </form>
  )
}

// --------------------------------------------------------- Plattformbenutzer

function Personal({ eigeneId }: { eigeneId: number | null }): JSX.Element {
  const t = useT()
  const zeit = useZeit()
  const q = usePlatformStaff()
  const anlegen = useCreateStaff()
  const setzen = useSetStaffStatus()
  const rolleSetzen = useSetStaffRole()
  const link = useStaffAccessLink()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [rolle, setRolle] = useState('platform_support')

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
        {anlegen.isSuccess && <Erfolg k="admin.staff.invited" />}

        <button type="submit" disabled={anlegen.isPending} className={KNOPF}>
          {t(anlegen.isPending ? 'common.loading' : 'admin.staff.new')}
        </button>
      </form>

      {setzen.isError && <Fehler error={setzen.error} />}
      {rolleSetzen.isError && <Fehler error={rolleSetzen.error} />}
      {link.isError && <Fehler error={link.error} />}
      {link.isSuccess && <Erfolg k="admin.user.linkSent" />}
      {q.isError && <Fehler error={q.error} />}
      {q.data === undefined ? <Laedt /> : (
        <ul className="divide-y divide-neutral-100 border border-neutral-200
                       rounded bg-white">
          {q.data.staff.map(p => (
            <li key={p.id} className="px-3 py-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{p.displayName}</span>
              <span className="text-xs text-neutral-500">{p.email}</span>
              {/* Der eigene Zugang traegt weder Rollenwahl noch Knopf. Die
                  Route weist beides ohnehin ab -- aber ein Knopf, der nur
                  409 sagt, ist eine Falle und keine Sicherung. */}
              {p.id === eigeneId ? (
                <>
                  {p.roleKey !== null && ROLLE_KURZ[p.roleKey] !== undefined && (
                    <span className="text-xs text-neutral-600">{t(ROLLE_KURZ[p.roleKey]!)}</span>
                  )}
                </>
              ) : (
                <select value={p.roleKey ?? ''} disabled={rolleSetzen.isPending}
                        onChange={e => rolleSetzen.mutate({ id: p.id, roleKey: e.target.value })}
                        className="text-xs border border-neutral-300 rounded px-1 py-0.5">
                  {(q.data?.roles ?? []).map(r => (
                    <option key={r} value={r}>
                      {ROLLE_KURZ[r] !== undefined ? t(ROLLE_KURZ[r]!) : r}
                    </option>
                  ))}
                </select>
              )}
              {PERSONAL_ZUSTAND[p.status] !== undefined && (
                <Abzeichen k={PERSONAL_ZUSTAND[p.status]!}
                           ton={p.status === 'active' ? 'gut' : 'still'} />
              )}
              <span className="text-xs text-neutral-500">{zeit(p.lastLoginAt)}</span>
              <span className="grow" />
              {p.id === eigeneId ? (
                <span className="text-xs text-neutral-400">{t('admin.staff.you')}</span>
              ) : (
                <>
                  {p.status !== 'disabled' && (
                    <button type="button" className={KNOPF_KLEIN} disabled={link.isPending}
                            onClick={() => link.mutate(p.id)}>
                      {t(p.status === 'invited' ? 'admin.user.sendInvite' : 'admin.staff.sendLink')}
                    </button>
                  )}
                  <button type="button" disabled={setzen.isPending} className={KNOPF_KLEIN}
                          onClick={() => setzen.mutate({ id: p.id,
                            status: p.status === 'disabled' ? 'active' : 'disabled' })}>
                    {t(p.status === 'disabled' ? 'admin.staff.enable' : 'admin.staff.disable')}
                  </button>
                </>
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
  const zeit = useZeit()
  const q = usePlatformHealth()

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const heute = new Date()
  const alt = (tag: string | null): boolean => {
    if (tag === null) return false
    const tage = (heute.getTime() - new Date(`${tag}T00:00:00Z`).getTime())
      / 86_400_000
    return tage > NACHTLAUF_TOLERANZ_TAGE
  }

  const pf = q.data.platform
  const plattformHaengt = pf.emailsPending > 0 || pf.emailsFailed > 0
    || (pf.deployment !== null && pf.deployment.stuck)

  const auffaellig = q.data.accounts.filter(a =>
    a.emailsPending > 0 || a.emailsFailed > 0 || a.webhooksFailed > 0
    || alt(a.nightAuditLast))

  return (
    <section className="space-y-3 border border-neutral-200 rounded p-4 bg-white">
      <h2 className="text-sm font-medium">{t('admin.health.title')}</h2>
      <p className="text-xs text-neutral-600">{t('admin.health.hint')}</p>

      {/* Die Plattform selbst zuerst: steht ihre Post, kommt beim Kunden
          keine Einladung an, und das sieht man an keinem Kunden. */}
      {plattformHaengt && (
        <div className="text-sm border-t border-neutral-100 pt-2 space-y-1">
          <div className="font-medium">{t('admin.health.platformMail')}</div>
          <p className="text-xs text-neutral-600">{t('admin.health.platformMailHint')}</p>
          <div className="text-xs text-neutral-700 flex flex-wrap gap-x-3">
            {pf.emailsPending > 0 && <span>{t('admin.health.emails')}: {pf.emailsPending}</span>}
            {pf.emailsFailed > 0 && (
              <span className="text-red-800">
                {t('admin.health.emailsFailed')}: {pf.emailsFailed}
                {pf.emailsOldest !== null
                  && ` (${t('admin.health.since', { seit: zeit(pf.emailsOldest) })})`}
              </span>
            )}
          </div>
          {pf.emailsLastError !== null && (
            <p className="text-xs text-red-800 font-mono break-all">
              {t('admin.health.lastError')}: {pf.emailsLastError}
            </p>
          )}
          {pf.deployment !== null && pf.deployment.stuck && (
            <p className="text-xs text-red-800">
              {t('admin.health.deployStuck', { id: pf.deployment.id, status: pf.deployment.status })}
            </p>
          )}
        </div>
      )}

      {auffaellig.length === 0 && !plattformHaengt ? (
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

// ------------------------------------------------------------------ Aufsicht

function Aufsicht(): JSX.Element {
  const t = useT()
  const q = useSupportAudit(true)
  return (
    <section className="space-y-2 border border-neutral-200 rounded p-4 bg-white">
      <h2 className="text-sm font-medium">{t('admin.audit.title')}</h2>
      <p className="text-xs text-neutral-600">{t('admin.audit.hint')}</p>
      {q.isError && <Fehler error={q.error} />}
      {q.data === undefined ? <Laedt /> : q.data.sessions.length === 0
        ? <p className="text-sm text-neutral-500">{t('common.none')}</p>
        : <ul className="divide-y divide-neutral-100">
            {q.data.sessions.map(s => <SitzungZeile key={s.id} s={s} mitKunde />)}
          </ul>}
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

  const darfSupport = platformPermissions.includes('platform:support_session')
  const darfAufsicht = platformPermissions.includes('platform:staff')

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
            <KundeDetail id={kunde} onClose={() => setKunde(null)} darfSupport={darfSupport} />
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
          {darfAufsicht && <Aufsicht />}
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
