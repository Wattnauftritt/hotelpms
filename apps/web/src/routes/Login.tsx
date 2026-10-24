import { useState } from 'react'
import { anmelden } from '../lib/api.js'
import { useLocale, useT } from '../lib/i18n/index.js'
import { fehlerMeldung } from '../lib/meldungen.js'
import { passkeyMoeglich, mitPasskeyAnmelden, abgebrochen } from '../lib/passkey.js'

/**
 * Anmeldung.
 *
 * Es gibt bewusst **keine** Unterscheidung zwischen "Adresse unbekannt" und
 * "Kennwort falsch" — die Antwort der Schnittstelle ist in beiden Fällen
 * dieselbe, und die Oberfläche gibt sie unverändert wieder. Eine hilfreiche
 * Meldung an dieser Stelle ist eine Auskunft darüber, welche Adressen es
 * gibt.
 */
export function Login({ onDone }: { onDone: () => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [email, setEmail] = useState('')
  const [kennwort, setKennwort] = useState('')
  const [fehler, setFehler] = useState<string | null>(null)
  const [laeuft, setLaeuft] = useState(false)

  return (
    <div className="min-h-screen grid place-items-center bg-neutral-50">
      <form
        className="w-80 bg-white border border-neutral-200 rounded-sm p-6 space-y-3"
        onSubmit={async e => {
          e.preventDefault()
          setFehler(null)
          setLaeuft(true)
          try {
            await anmelden(email.trim(), kennwort)
            onDone()
          } catch (err) {
            // In der Sprache der Maske; bis hierher stand der deutsche Satz
            // der Schnittstelle auch vor einer polnischen Anmeldung.
            setFehler(fehlerMeldung(err, locale).text)
          } finally {
            setLaeuft(false)
          }
        }}>
        <h1 className="font-semibold">StayGrid</h1>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('login.email')}</span>
          {/* Text, nicht `email`: Personal ohne Postfach meldet sich mit dem
              Benutzernamen an (0105), und den lehnte der Browser sonst ab. */}
          <input type="text" required autoComplete="username" autoCapitalize="none"
                 spellCheck={false} value={email}
                 onChange={e => setEmail(e.target.value)}
                 className="mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1
                            text-sm" />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('login.password')}</span>
          <input type="password" required autoComplete="current-password" value={kennwort}
                 onChange={e => setKennwort(e.target.value)}
                 className="mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1
                            text-sm" />
        </label>
        {fehler !== null && (
          <p role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200
                                     rounded-sm px-2 py-1">
            {fehler}
          </p>
        )}
        <button type="submit" disabled={laeuft}
                className="w-full py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t(laeuft ? 'common.loading' : 'login.submit')}
        </button>
        {/*
          * Unter dem Kennwort, nicht davor: das Kennwort hat jeder, einen
          * Passkey nur, wer ihn im Arbeitsplatz-Dialog angelegt hat. Eine
          * Adresse braucht er nicht -- der Browser fragt selbst, welcher
          * Passkey es sein soll.
          */}
        {passkeyMoeglich() && (
          <button type="button" disabled={laeuft}
                  onClick={async () => {
                    setFehler(null)
                    setLaeuft(true)
                    try {
                      await mitPasskeyAnmelden()
                      onDone()
                    } catch (err) {
                      setFehler(abgebrochen(err) ? t('passkey.cancelled')
                        : fehlerMeldung(err, locale).text)
                    } finally {
                      setLaeuft(false)
                    }
                  }}
                  className="w-full py-1.5 text-sm rounded-sm border border-neutral-300
                             text-neutral-800 disabled:text-neutral-400">
            {t('passkey.login')}
          </button>
        )}
        {/*
          * Ein echter Verweis, kein Knopf mit Sprungbefehl: wer sein Kennwort
          * vergessen hat, macht die Seite gern in einem zweiten Reiter auf,
          * um die Mail danebenzulegen.
          */}
        <a href="/kennwort" className="block text-center text-xs text-neutral-600
                                       underline underline-offset-2">
          {t('zugang.forgot')}
        </a>
      </form>
    </div>
  )
}
