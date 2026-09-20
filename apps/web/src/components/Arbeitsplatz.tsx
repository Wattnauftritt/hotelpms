import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { KENNWORT_MIN } from '@hotelpms/contracts'
import { useT } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'

/**
 * Der Arbeitsplatz: wer handelt hier gerade, und wie wechselt man das.
 *
 * **Warum das nicht "Abmelden und neu anmelden" ist.** An einer Rezeption
 * steht ein Rechner, an dem im Lauf eines Tages vier Menschen arbeiten. Sich
 * jedes Mal ab- und wieder anzumelden dauert zu lange, also tut es niemand
 * -- und dann steht im Protokoll an jeder Buchung der Name dessen, der
 * morgens aufgeschlossen hat. Der PIN ist der kurze Weg, der trotzdem
 * festhält, wer wirklich gehandelt hat.
 *
 * **Warum es diese Maske bisher nicht gab.** Die Route existiert seit
 * Anfang, den PIN prüft sie korrekt -- nur setzen konnte ihn niemand, und
 * benutzen erst recht nicht. Beides steht deshalb hier nebeneinander: ohne
 * den zweiten Teil wäre der erste wieder unbenutzbar.
 *
 * Nach einem Wechsel wird der Zwischenspeicher geleert, nicht nur neu
 * geladen. Sonst bliebe der Stand des Vorgängers stehen, und die neue
 * Person sähe für einen Wimpernschlag dessen Haus.
 *
 * **Hier steht auch das eigene Konto.** Kennwort und Mailadresse ändern
 * gehören hinter denselben Knopf wie der eigene PIN: es ist derselbe
 * Gedanke — „das bin ich, und das ändere ich an mir". Ein zweiter
 * Bildschirm „Mein Profil" wäre ein weiterer Reiter, den Plattformpersonal
 * wieder nicht erreicht, weil es keine Hausbildschirme hat.
 *
 * **Der Arbeitsplatzteil ist deshalb bedingt.** Wer kein Haus hat — genau
 * das ist der Normalzustand von Plattformpersonal — kann keine Person
 * wechseln, es gibt niemanden zu wechseln. Die beiden Abschnitte darüber
 * gelten für alle.
 */
export function Arbeitsplatz({ benutzer, email, pinGesetzt, gewechselt,
                               mitArbeitsplatz, onClose }: {
  benutzer: string
  /** Die eigene Anmeldeadresse. Steht als Ausgangswert im Feld. */
  email: string
  pinGesetzt: boolean
  gewechselt: boolean
  /** Hat dieser Benutzer überhaupt ein Haus? Sonst kein Personenwechsel. */
  mitArbeitsplatz: boolean
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const qc = useQueryClient()

  // Die Adresse der **anderen** Person, auf die gewechselt wird -- nicht
  // die eigene. Die kommt als Prop herein.
  const [wechselEmail, setWechselEmail] = useState('')
  const [pin, setPin] = useState('')
  const [kennwort, setKennwort] = useState('')
  const [eigenerPin, setEigenerPin] = useState('')

  // Je Abschnitt ein eigenes Kennwortfeld. Eines für alle wäre kürzer und
  // gefährlicher: wer es für den PIN eingetippt hat, hätte es beim
  // versehentlichen Klick auf „Kennwort ändern" schon dabei.
  const [altesKennwort, setAltesKennwort] = useState('')
  const [neuesKennwort, setNeuesKennwort] = useState('')
  const [mailKennwort, setMailKennwort] = useState('')
  const [neueMail, setNeueMail] = useState(email)

  const wechseln = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/v1/auth/workstation-switch',
      { email: wechselEmail, pin }),
    onSuccess: async () => {
      qc.clear()
      await qc.invalidateQueries({ queryKey: ['me'] })
      onClose()
    }
  })

  const kennwortAendern = useMutation({
    mutationFn: () => api.post<{ status: string }>('/v1/auth/password',
      { currentPassword: altesKennwort, newPassword: neuesKennwort }),
    onSuccess: () => {
      // Die Felder leeren, nicht das Fenster schließen: die Bestätigung
      // stünde sonst nirgends, und der Benutzer wüsste nicht, ob es geklappt
      // hat. Die eigene Sitzung bleibt bestehen, ein Neuanmelden entfällt.
      setAltesKennwort('')
      setNeuesKennwort('')
    }
  })

  const mailAendern = useMutation({
    mutationFn: () => api.post<{ status: string }>('/v1/auth/email',
      { currentPassword: mailKennwort, newEmail: neueMail.trim() }),
    onSuccess: () => { setMailKennwort('') }
  })

  const pinSetzen = useMutation({
    mutationFn: (neu: string | null) =>
      api.post<{ pinSet: boolean }>('/v1/auth/workstation-pin',
        { password: kennwort, pin: neu }),
    onSuccess: async () => {
      setKennwort('')
      setEigenerPin('')
      await qc.invalidateQueries({ queryKey: ['me'] })
    }
  })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded shadow-xl p-4 space-y-4
                      max-h-[90vh] overflow-auto"
           onClick={e => e.stopPropagation()}>
        <div>
          <h2 className="text-sm font-medium">{t('workstation.title')}</h2>
          <p className="text-sm text-neutral-600 mt-1">{benutzer}</p>
          {gewechselt && (
            <p role="status" className="text-xs text-amber-800 mt-1">
              {t('workstation.acting')}
            </p>
          )}
        </div>

        <section className="space-y-2 border-t border-neutral-200 pt-3">
          <h3 className="text-sm font-medium">{t('konto.password')}</h3>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('konto.currentPassword')}
            </span>
            <input type="password" value={altesKennwort}
                   onChange={e => setAltesKennwort(e.target.value)}
                   autoComplete="current-password"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('konto.newPassword')}
            </span>
            <input type="password" value={neuesKennwort}
                   onChange={e => setNeuesKennwort(e.target.value)}
                   autoComplete="new-password"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <p className="text-xs text-neutral-500">
            {t('zugang.minLength', { min: KENNWORT_MIN })}
          </p>
          {kennwortAendern.isError && <Fehler error={kennwortAendern.error} />}
          {kennwortAendern.isSuccess && (
            <p className="text-sm text-emerald-800">✓ {t('konto.passwordSaved')}</p>
          )}
          <button type="button"
                  disabled={kennwortAendern.isPending || altesKennwort === ''
                            || neuesKennwort.length < KENNWORT_MIN}
                  onClick={() => kennwortAendern.mutate()}
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('konto.passwordSave')}
          </button>
        </section>

        <section className="space-y-2 border-t border-neutral-200 pt-3">
          <h3 className="text-sm font-medium">{t('konto.email')}</h3>
          {/* Der Hinweis steht über dem Feld, nicht darunter: dass die
              Änderung erst nach einem Klick im neuen Postfach gilt, will
              man wissen, bevor man tippt. */}
          <p className="text-xs text-neutral-500">{t('konto.emailHint')}</p>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('konto.newEmail')}
            </span>
            <input type="email" value={neueMail}
                   onChange={e => setNeueMail(e.target.value)} autoComplete="off"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('konto.currentPassword')}
            </span>
            <input type="password" value={mailKennwort}
                   onChange={e => setMailKennwort(e.target.value)}
                   autoComplete="current-password"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          {mailAendern.isError && <Fehler error={mailAendern.error} />}
          {mailAendern.isSuccess && (
            <p className="text-sm text-emerald-800">✓ {t('konto.emailSent')}</p>
          )}
          <button type="button"
                  disabled={mailAendern.isPending || mailKennwort === ''
                            || neueMail.trim() === '' || neueMail.trim() === email}
                  onClick={() => mailAendern.mutate()}
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('konto.emailSave')}
          </button>
        </section>

        {mitArbeitsplatz && <>
        <section className="space-y-2 border-t border-neutral-200 pt-3">
          <h3 className="text-sm font-medium">{t('workstation.switch')}</h3>
          <p className="text-xs text-neutral-500">{t('workstation.switchHint')}</p>
          {!pinGesetzt && (
            <p className="text-xs text-amber-800">{t('workstation.needOwnPin')}</p>
          )}
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">{t('login.email')}</span>
            <input type="email" value={wechselEmail}
                   onChange={e => setWechselEmail(e.target.value)} autoComplete="off"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('workstation.pin')}
            </span>
            {/* `inputMode` statt `type="number"`: eine PIN ist eine Ziffernfolge
                und keine Zahl -- fuehrende Nullen muessen stehen bleiben. */}
            <input type="password" inputMode="numeric" value={pin}
                   onChange={e => setPin(e.target.value)} autoComplete="off"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          {wechseln.isError && <Fehler error={wechseln.error} />}
          <button type="button"
                  disabled={wechseln.isPending || wechselEmail === '' || pin === ''}
                  onClick={() => wechseln.mutate()}
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('workstation.switchSubmit')}
          </button>
        </section>

        <section className="space-y-2 border-t border-neutral-200 pt-3">
          <h3 className="text-sm font-medium">
            {t('workstation.ownPin')}
            {' — '}
            <span className={pinGesetzt ? 'text-emerald-700' : 'text-neutral-500'}>
              {pinGesetzt ? t('workstation.pinSet') : t('workstation.pinNotSet')}
            </span>
          </h3>
          <p className="text-xs text-neutral-500">{t('workstation.ownPinHint')}</p>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('login.password')}
            </span>
            {/* Das eigene Kennwort ist die Stelle, an der sich beweisen laesst,
                dass wirklich der Betroffene davorsitzt -- an einem Tresen
                steht die Sitzung offen, waehrend die Person Kaffee holt. */}
            <input type="password" value={kennwort}
                   onChange={e => setKennwort(e.target.value)} autoComplete="current-password"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('workstation.pin')}
            </span>
            <input type="password" inputMode="numeric" value={eigenerPin}
                   onChange={e => setEigenerPin(e.target.value)} autoComplete="off"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          {pinSetzen.isError && <Fehler error={pinSetzen.error} />}
          {pinSetzen.isSuccess && (
            <p className="text-sm text-emerald-800">✓ {t('workstation.pinSaved')}</p>
          )}
          <div className="flex gap-2">
            <button type="button"
                    disabled={pinSetzen.isPending || kennwort === '' || eigenerPin === ''}
                    onClick={() => pinSetzen.mutate(eigenerPin)}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('workstation.pinSave')}
            </button>
            {pinGesetzt && (
              <button type="button"
                      disabled={pinSetzen.isPending || kennwort === ''}
                      onClick={() => pinSetzen.mutate(null)}
                      className="px-3 py-1.5 text-sm rounded border border-neutral-300
                                 disabled:text-neutral-400">
                {t('workstation.pinRemove')}
              </button>
            )}
          </div>
        </section>
        </>}

        <div className="border-t border-neutral-200 pt-3">
          <button type="button" onClick={onClose}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-300">
            {t('common.back')}
          </button>
        </div>
      </div>
    </div>
  )
}
