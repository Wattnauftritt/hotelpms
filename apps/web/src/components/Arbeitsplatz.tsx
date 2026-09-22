import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { KENNWORT_MIN } from '@hotelpms/contracts'
import { useT } from '../lib/i18n/index.js'
import { Dialog, Abschnitt, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
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
    <Dialog breite="breit" onClose={onClose}
            titel={t('workstation.title')} unterzeile={benutzer}
            fuss={
              <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                {t('common.back')}
              </button>
            }>
      {gewechselt && (
        <p role="status" className="text-sm text-amber-800 bg-amber-50 rounded
                                    px-3 py-2 mb-4">
          {t('workstation.acting')}
        </p>
      )}

      {/*
        * Vier Abschnitte, die nichts miteinander zu tun haben, ausser dass
        * sie alle "an mir" aendern. Untereinander war das eine Rolle von
        * zwoelf Feldern, in der der Personenwechsel -- der einzige, den
        * jemand mehrmals am Tag braucht -- ganz unten stand.
        */}
      <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
        <Abschnitt titel={t('konto.password')}>
          <Feld label={t('konto.currentPassword')}>
            <input type="password" value={altesKennwort}
                   onChange={e => setAltesKennwort(e.target.value)}
                   autoComplete="current-password" className={FELD} />
          </Feld>
          <Feld label={t('konto.newPassword')}
                hinweis={t('zugang.minLength', { min: KENNWORT_MIN })}>
            <input type="password" value={neuesKennwort}
                   onChange={e => setNeuesKennwort(e.target.value)}
                   autoComplete="new-password" className={FELD} />
          </Feld>
          {kennwortAendern.isError && <Fehler error={kennwortAendern.error} />}
          {kennwortAendern.isSuccess && (
            <p className="text-sm text-emerald-800">✓ {t('konto.passwordSaved')}</p>
          )}
          <button type="button"
                  disabled={kennwortAendern.isPending || altesKennwort === ''
                            || neuesKennwort.length < KENNWORT_MIN}
                  onClick={() => kennwortAendern.mutate()}
                  className={KNOPF}>
            {t('konto.passwordSave')}
          </button>
        </Abschnitt>

        {/* Der Hinweis steht über dem Feld, nicht darunter: dass die
            Änderung erst nach einem Klick im neuen Postfach gilt, will
            man wissen, bevor man tippt. */}
        <Abschnitt titel={t('konto.email')} hinweis={t('konto.emailHint')}>
          <Feld label={t('konto.newEmail')}>
            <input type="email" value={neueMail}
                   onChange={e => setNeueMail(e.target.value)} autoComplete="off"
                   className={FELD} />
          </Feld>
          <Feld label={t('konto.currentPassword')}>
            <input type="password" value={mailKennwort}
                   onChange={e => setMailKennwort(e.target.value)}
                   autoComplete="current-password" className={FELD} />
          </Feld>
          {mailAendern.isError && <Fehler error={mailAendern.error} />}
          {mailAendern.isSuccess && (
            <p className="text-sm text-emerald-800">✓ {t('konto.emailSent')}</p>
          )}
          <button type="button"
                  disabled={mailAendern.isPending || mailKennwort === ''
                            || neueMail.trim() === '' || neueMail.trim() === email}
                  onClick={() => mailAendern.mutate()}
                  className={KNOPF}>
            {t('konto.emailSave')}
          </button>
        </Abschnitt>

        {mitArbeitsplatz && <>
        <Abschnitt titel={t('workstation.switch')} hinweis={t('workstation.switchHint')}>
          {!pinGesetzt && (
            <p className="text-xs text-amber-800">{t('workstation.needOwnPin')}</p>
          )}
          <Feld label={t('login.email')}>
            <input type="email" value={wechselEmail}
                   onChange={e => setWechselEmail(e.target.value)} autoComplete="off"
                   className={FELD} />
          </Feld>
          <Feld label={t('workstation.pin')}>
            {/* `inputMode` statt `type="number"`: eine PIN ist eine Ziffernfolge
                und keine Zahl -- fuehrende Nullen muessen stehen bleiben. */}
            <input type="password" inputMode="numeric" value={pin}
                   onChange={e => setPin(e.target.value)} autoComplete="off"
                   className={FELD} />
          </Feld>
          {wechseln.isError && <Fehler error={wechseln.error} />}
          <button type="button"
                  disabled={wechseln.isPending || wechselEmail === '' || pin === ''}
                  onClick={() => wechseln.mutate()}
                  className={KNOPF}>
            {t('workstation.switchSubmit')}
          </button>
        </Abschnitt>

        <Abschnitt hinweis={t('workstation.ownPinHint')}
                   titel={<>
                     {t('workstation.ownPin')}
                     {' — '}
                     <span className={pinGesetzt ? 'text-emerald-700' : 'text-neutral-400'}>
                       {pinGesetzt ? t('workstation.pinSet') : t('workstation.pinNotSet')}
                     </span>
                   </>}>
          <Feld label={t('login.password')}>
            {/* Das eigene Kennwort ist die Stelle, an der sich beweisen laesst,
                dass wirklich der Betroffene davorsitzt -- an einem Tresen
                steht die Sitzung offen, waehrend die Person Kaffee holt. */}
            <input type="password" value={kennwort}
                   onChange={e => setKennwort(e.target.value)}
                   autoComplete="current-password" className={FELD} />
          </Feld>
          <Feld label={t('workstation.pin')}>
            <input type="password" inputMode="numeric" value={eigenerPin}
                   onChange={e => setEigenerPin(e.target.value)} autoComplete="off"
                   className={FELD} />
          </Feld>
          {pinSetzen.isError && <Fehler error={pinSetzen.error} />}
          {pinSetzen.isSuccess && (
            <p className="text-sm text-emerald-800">✓ {t('workstation.pinSaved')}</p>
          )}
          <div className="flex gap-2">
            <button type="button"
                    disabled={pinSetzen.isPending || kennwort === '' || eigenerPin === ''}
                    onClick={() => pinSetzen.mutate(eigenerPin)}
                    className={KNOPF}>
              {t('workstation.pinSave')}
            </button>
            {pinGesetzt && (
              <button type="button"
                      disabled={pinSetzen.isPending || kennwort === ''}
                      onClick={() => pinSetzen.mutate(null)}
                      className={`${KNOPF_LEISE} disabled:text-neutral-400`}>
                {t('workstation.pinRemove')}
              </button>
            )}
          </div>
        </Abschnitt>
        </>}
      </div>
    </Dialog>
  )
}
