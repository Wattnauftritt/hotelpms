import { useState } from 'react'
import type { JSX } from 'react'
import type { PropertyUser, PropertyRole } from '@hotelpms/contracts'
import { usePropertyUsers, useRoles, useSetUserRoles, useInviteUser, useUserAction,
         useRenameUser, useRemoveUser, useAccountRoles, useSetAccountRoles }
  from '../lib/queries/integrations.js'
import { useHausrechte } from '../lib/rechte.js'
import { useT, useLocale, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { ZugangsLink } from '../components/ZugangsLink.tsx'

/**
 * Benutzer und Rollen: der Kunde verwaltet sein Personal selbst (0040).
 *
 * Stand bis Oktober 2026 als vierter Reiter unter „Schnittstellen" und wurde
 * dort nicht gefunden -- wer eine neue Rezeptionistin anlegen will, sucht
 * nicht neben Webhooks und Maschinenzugängen. Jetzt ein eigener Bildschirm
 * im Menü „Einstellungen", sichtbar für jeden mit `user:manage`.
 */

const knopf = 'text-sm px-3 py-1.5 rounded-sm border border-neutral-300 ' +
              'hover:bg-neutral-50 disabled:opacity-40'
const knopfStark = 'text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white ' +
                   'disabled:opacity-40'
const feld = 'border border-neutral-300 rounded-sm px-2 py-1'

function Zeitpunkt({ wert, leer }: { wert: string | null; leer: TextKey }): JSX.Element {
  const t = useT()
  return <>{wert === null ? t(leer) : new Date(wert).toLocaleString()}</>
}

// ---------------------------------------------------- Benutzer und Rollen
//
// Der Kunde verwaltet sein Personal selbst (0040): einladen, Rollen, Name,
// Link, entsperren, sperren, entfernen. Zwei Ebenen, zwei Rechte -- und die
// Grenze dazwischen zeigt die Oberflaeche so, wie die API sie zieht: wer den
// Betrieb nicht verwaltet, sieht an einem Inhaber keinen Knopf, der ihm
// ohnehin nur mit 403 antwortete.

function RollenWahl({ rollen, gewaehlt, onChange }: {
  rollen: PropertyRole[]; gewaehlt: string[]; onChange: (keys: string[]) => void
}): JSX.Element {
  const umschalten = (key: string): void => {
    onChange(gewaehlt.includes(key) ? gewaehlt.filter(x => x !== key) : [...gewaehlt, key])
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {rollen.map(r => (
        <label key={r.key} className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={gewaehlt.includes(r.key)}
                 onChange={() => umschalten(r.key)} />
          {r.name}
          <span className="text-xs text-neutral-400">({r.permissions.length})</span>
        </label>
      ))}
    </div>
  )
}

function BenutzerZeile(
  { benutzer, rollen, betriebsrollen, propertyId, darfBetrieb, istSelbst }:
  { benutzer: PropertyUser; rollen: PropertyRole[]; betriebsrollen: PropertyRole[]
    propertyId: number; darfBetrieb: boolean; istSelbst: boolean }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const [offen, setOffen] = useState<'rollen' | 'betrieb' | 'name' | null>(null)
  const [gewaehlt, setGewaehlt] = useState(benutzer.roles.map(r => r.key))
  const [betrieb, setBetrieb] = useState(benutzer.accountRoles.map(r => r.key))
  const [name, setName] = useState(benutzer.displayName)
  const setzen = useSetUserRoles(propertyId)
  const betriebSetzen = useSetAccountRoles(propertyId)
  const aktion = useUserAction(propertyId)
  const umbenennen = useRenameUser(propertyId)
  const entfernen = useRemoveUser(propertyId)

  /*
   * Wer eine Rolle fuer den ganzen Betrieb traegt, wird nur von jemandem
   * mit settings:account angefasst -- sonst koennte die Direktion eines
   * Hauses den Inhaber sperren. Die API weist es ab; hier fehlt dann der
   * Knopf, statt dass er mit 403 antwortet.
   */
  const anfassbar = benutzer.accountRoles.length === 0 || darfBetrieb
  const zeit = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
  const fehler = [setzen, betriebSetzen, aktion, umbenennen, entfernen].find(m => m.isError)

  return (
    <li className={`rounded-sm border bg-white p-3 ${benutzer.blocked
      ? 'border-red-200' : 'border-neutral-200'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{benutzer.displayName}</span>
        {istSelbst && <span className="text-xs text-neutral-400">{t('user.you')}</span>}
        {/* Personal ohne Mailadresse meldet sich mit dem Benutzernamen an
            (0105); dann steht der hier, sonst wuesste niemand, womit. */}
        <span className="text-sm text-neutral-500 grow">
          {benutzer.email ?? benutzer.username}
        </span>
        {benutzer.blocked ? (
          <span className="text-xs px-1.5 py-0.5 rounded-sm bg-red-50 text-red-900
                           border border-red-200">{t('user.blocked')}</span>
        ) : (
          <span className="text-xs text-neutral-500">
            {t(`user.status.${benutzer.status === 'active' ? 'active'
                : benutzer.status === 'invited' ? 'invited' : 'disabled'}`)}
          </span>
        )}
        <span className="text-xs text-neutral-500">
          {t('user.lastLogin')}: <Zeitpunkt wert={benutzer.lastLoginAt} leer="user.never" />
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-1">
        {benutzer.accountRoles.map(r => (
          <span key={r.key} className="text-xs px-1.5 py-0.5 rounded-sm
                                       bg-amber-50 border border-amber-200">
            {r.name}
          </span>
        ))}
        {benutzer.roles.length === 0 && benutzer.accountRoles.length === 0
          ? <span className="text-xs text-neutral-500">{t('user.noRoles')}</span>
          : benutzer.roles.map(r => (
              <span key={r.key} className="text-xs px-1.5 py-0.5 rounded-sm
                                           bg-neutral-100 border border-neutral-200">
                {r.name}
              </span>
            ))}
      </div>
      {benutzer.lockedUntil !== null && (
        <p className="mt-1 text-xs text-red-800">
          {t('user.lockedUntil', { bis: zeit(benutzer.lockedUntil) })}
        </p>
      )}
      {/* Die Rechte stehen so da, wie die API sie liefert. Aus dem
          Rollennamen darauf zu schließen, geht bei der ersten eigenen Rolle
          eines Kunden schief -- und zwar lautlos. */}
      <details className="mt-1">
        <summary className="text-xs text-neutral-600 cursor-pointer">
          {t('user.permissions')} ({benutzer.permissions.length})
        </summary>
        <div className="mt-1 flex flex-wrap gap-1">
          {benutzer.permissions.map(p => (
            <code key={p} className="text-xs px-1.5 py-0.5 rounded-sm bg-neutral-50
                                     border border-neutral-200">{p}</code>
          ))}
        </div>
      </details>

      {anfassbar && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => setOffen(o => o === 'rollen' ? null : 'rollen')}
                  className={knopf}>{t('user.edit')}</button>
          {darfBetrieb && (
            <button onClick={() => setOffen(o => o === 'betrieb' ? null : 'betrieb')}
                    className={knopf}>{t('user.accountRoles')}</button>
          )}
          <button onClick={() => setOffen(o => o === 'name' ? null : 'name')}
                  className={knopf}>{t('user.rename')}</button>
          {!benutzer.blocked && benutzer.status !== 'disabled' && benutzer.email !== null && (
            <button disabled={!online || aktion.isPending} className={knopf}
                    onClick={() => aktion.mutate({ userRef: benutzer.userRef,
                                                   action: 'access-link',
                                                   delivery: 'email' })}>
              {t(benutzer.status === 'invited' ? 'user.sendInvite' : 'user.sendReset')}
            </button>
          )}
          {/* Zum Weitergeben nur, wo die API es erlaubt: offene Einladung
              oder kein Postfach. Bei einem benutzten Zugang mit Adresse waere
              der sichtbare Link der Weg, ihn zu uebernehmen. */}
          {!benutzer.blocked && benutzer.status !== 'disabled'
            && (benutzer.status === 'invited' || benutzer.email === null) && (
            <button disabled={!online || aktion.isPending} className={knopf}
                    onClick={() => aktion.mutate({ userRef: benutzer.userRef,
                                                   action: 'access-link',
                                                   delivery: 'link' })}>
              {t('user.showLink')}
            </button>
          )}
          {benutzer.lockedUntil !== null && (
            <button disabled={!online || aktion.isPending} className={knopf}
                    onClick={() => aktion.mutate({ userRef: benutzer.userRef,
                                                   action: 'unlock' })}>
              {t('user.unlock')}
            </button>
          )}
          {/* Der eigene Zugang traegt weder Sperre noch Entfernen. Die
              Route weist beides ab -- ein Knopf, der nur 409 sagt, ist eine
              Falle und keine Sicherung. */}
          {!istSelbst && (
            <>
              <button disabled={!online || aktion.isPending} className={knopf}
                      onClick={() => {
                        if (benutzer.blocked) {
                          aktion.mutate({ userRef: benutzer.userRef, action: 'unblock' })
                        } else if (window.confirm(
                            t('user.blockConfirm', { name: benutzer.displayName }))) {
                          aktion.mutate({ userRef: benutzer.userRef, action: 'block' })
                        }
                      }}>
                {t(benutzer.blocked ? 'user.unblock' : 'user.block')}
              </button>
              <button disabled={!online || entfernen.isPending}
                      className={`${knopf} text-red-800`}
                      onClick={() => {
                        if (window.confirm(
                            t('user.removeConfirm', { name: benutzer.displayName }))) {
                          entfernen.mutate(benutzer.userRef)
                        }
                      }}>
                {t('user.remove')}
              </button>
            </>
          )}
          {aktion.isSuccess && aktion.data.kind !== undefined
            && aktion.data.link === undefined && (
            <span className="text-xs text-green-800 self-center">{t('user.linkSent')}</span>
          )}
        </div>
      )}
      {aktion.isSuccess && aktion.data.link !== undefined
        && aktion.data.linkExpiresAt !== undefined && (
        <div className="mt-2">
          <ZugangsLink link={aktion.data.link} gueltigBis={aktion.data.linkExpiresAt} />
        </div>
      )}

      {fehler !== undefined && <div className="mt-2"><Fehler error={fehler.error} /></div>}

      {offen === 'rollen' && (
        <form className="mt-3 space-y-2"
              onSubmit={e => {
                e.preventDefault()
                setzen.mutate({ userRef: benutzer.userRef, roleKeys: gewaehlt },
                  { onSuccess: () => setOffen(null) })
              }}>
          <RollenWahl rollen={rollen} gewaehlt={gewaehlt} onChange={setGewaehlt} />
          <button type="submit" disabled={!online || setzen.isPending}
                  className={knopfStark}>{t('common.save')}</button>
        </form>
      )}

      {offen === 'betrieb' && (
        <form className="mt-3 space-y-2"
              onSubmit={e => {
                e.preventDefault()
                betriebSetzen.mutate({ userRef: benutzer.userRef, roleKeys: betrieb },
                  { onSuccess: () => setOffen(null) })
              }}>
          <p className="text-xs text-neutral-500">{t('user.accountRolesHint')}</p>
          <RollenWahl rollen={betriebsrollen} gewaehlt={betrieb} onChange={setBetrieb} />
          <button type="submit" disabled={!online || betriebSetzen.isPending}
                  className={knopfStark}>{t('common.save')}</button>
        </form>
      )}

      {offen === 'name' && (
        <form className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={e => {
                e.preventDefault()
                umbenennen.mutate({ userRef: benutzer.userRef, displayName: name.trim() },
                  { onSuccess: () => setOffen(null) })
              }}>
          <label className="block grow max-w-xs">
            <span className="block text-xs text-neutral-600">{t('user.name')}</span>
            <input required value={name} onChange={e => setName(e.target.value)}
                   className={feld} />
          </label>
          <button type="submit" disabled={!online || umbenennen.isPending}
                  className={knopfStark}>{t('common.save')}</button>
        </form>
      )}
    </li>
  )
}

/**
 * Einladen. Die Person bekommt eine E-Mail und setzt ihr Kennwort selbst --
 * ein Kennwort, das der Chef auf einen Zettel schreibt, bleibt auf dem
 * Zettel.
 */
function BenutzerEinladen({ propertyId, rollen }: {
  propertyId: number; rollen: PropertyRole[]
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const einladen = useInviteUser(propertyId)
  const [email, setEmail] = useState('')
  const [benutzername, setBenutzername] = useState('')
  const [name, setName] = useState('')
  const [weg, setWeg] = useState<'email' | 'link'>('email')
  const [gewaehlt, setGewaehlt] = useState<string[]>(['reception'])
  // Ohne Adresse gibt es nur den Link; die Wahl steht dann gar nicht da.
  const ohneMail = email.trim() === ''
  const wirklich = ohneMail ? 'link' : weg

  return (
    <form className="rounded-sm border border-neutral-200 bg-white p-3 space-y-2"
          onSubmit={e => {
            e.preventDefault()
            einladen.mutate({ email: email.trim() || undefined,
                              username: benutzername.trim().toLowerCase() || undefined,
                              displayName: name.trim(), roleKeys: gewaehlt,
                              delivery: wirklich },
              { onSuccess: () => { setEmail(''); setBenutzername(''); setName('') } })
          }}>
      <div className="font-medium text-sm">{t('user.invite')}</div>
      <p className="text-xs text-neutral-500">{t('user.inviteHint')}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('user.name')}</span>
          <input required value={name} onChange={e => setName(e.target.value)}
                 className={feld} />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('user.username')}</span>
          <input value={benutzername} autoCapitalize="none" spellCheck={false}
                 placeholder={t('user.usernameHint')}
                 required={ohneMail}
                 onChange={e => setBenutzername(e.target.value)} className={feld} />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('user.emailOptional')}</span>
          <input type="email" value={email}
                 required={benutzername.trim() === ''}
                 onChange={e => setEmail(e.target.value)} className={feld} />
        </label>
      </div>
      {!ohneMail && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="text-xs text-neutral-600">{t('user.delivery')}</legend>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={weg === 'email'} onChange={() => setWeg('email')} />
            {t('user.deliveryEmail')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={weg === 'link'} onChange={() => setWeg('link')} />
            {t('user.deliveryLink')}
          </label>
        </fieldset>
      )}
      <RollenWahl rollen={rollen} gewaehlt={gewaehlt} onChange={setGewaehlt} />
      {einladen.isError && <Fehler error={einladen.error} />}
      {einladen.isSuccess && (
        <p className="text-sm text-green-900 bg-green-50 border border-green-200
                      rounded-sm px-2 py-1">
          {t(einladen.data.addedToProperty ? 'user.added'
             : einladen.data.link !== undefined ? 'user.invitedLink' : 'user.invited')}
        </p>
      )}
      {einladen.isSuccess && einladen.data.link !== undefined
        && einladen.data.linkExpiresAt !== undefined && (
        <ZugangsLink link={einladen.data.link} gueltigBis={einladen.data.linkExpiresAt} />
      )}
      <button type="submit" disabled={!online || einladen.isPending || gewaehlt.length === 0}
              className={knopfStark}>{t('user.invite')}</button>
    </form>
  )
}

export function Benutzer({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const { darfKonto } = useHausrechte(propertyId)
  const darfBetrieb = darfKonto('settings:account')
  const q = usePropertyUsers(propertyId)
  const rollen = useRoles()
  const betriebsrollen = useAccountRoles(propertyId, darfBetrieb)

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t('user.title')}</h1>
      <div className="text-xs text-neutral-500">
        {t('user.rolesHint')} {t('user.noCreate')}
      </div>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined || rollen.data === undefined
          ? <Laedt />
          : <>
              {q.data.users.length === 0
                ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
                : <ul className="space-y-2">
                    {q.data.users.map(u => (
                      <BenutzerZeile key={u.userRef} benutzer={u}
                                     rollen={rollen.data.roles}
                                     betriebsrollen={betriebsrollen.data?.roles ?? []}
                                     propertyId={propertyId} darfBetrieb={darfBetrieb}
                                     istSelbst={u.isSelf} />
                    ))}
                  </ul>}
              <BenutzerEinladen propertyId={propertyId} rollen={rollen.data.roles} />
            </>}
    </div>
  )
}
