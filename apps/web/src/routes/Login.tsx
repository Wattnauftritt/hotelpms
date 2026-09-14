import { useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { useT } from '../lib/i18n/index.js'

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
  const [email, setEmail] = useState('')
  const [kennwort, setKennwort] = useState('')
  const [fehler, setFehler] = useState<string | null>(null)
  const [laeuft, setLaeuft] = useState(false)

  return (
    <div className="min-h-screen grid place-items-center bg-neutral-50">
      <form
        className="w-80 bg-white border border-neutral-200 rounded p-6 space-y-3"
        onSubmit={async e => {
          e.preventDefault()
          setFehler(null)
          setLaeuft(true)
          try {
            await api.post('/v1/auth/login', { email, password: kennwort })
            onDone()
          } catch (err) {
            setFehler(err instanceof ApiError ? err.message : String(err))
          } finally {
            setLaeuft(false)
          }
        }}>
        <h1 className="font-semibold">hotelpms</h1>
        <label className="block">
          <span className="block text-xs text-neutral-600">E-Mail</span>
          <input type="email" required autoComplete="username" value={email}
                 onChange={e => setEmail(e.target.value)}
                 className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1
                            text-sm" />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">Kennwort</span>
          <input type="password" required autoComplete="current-password" value={kennwort}
                 onChange={e => setKennwort(e.target.value)}
                 className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1
                            text-sm" />
        </label>
        {fehler !== null && (
          <p role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200
                                     rounded px-2 py-1">
            {fehler}
          </p>
        )}
        <button type="submit" disabled={laeuft}
                className="w-full py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {laeuft ? t('common.loading') : 'Anmelden'}
        </button>
      </form>
    </div>
  )
}
