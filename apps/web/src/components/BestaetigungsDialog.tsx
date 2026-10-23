import { useEffect, useRef, useState, type JSX } from 'react'
import { BESTAETIGUNG_MINUTEN } from '@hotelpms/contracts'
import { api } from '../lib/api.js'
import { bestaetigungAnmelden } from '../lib/bestaetigung.js'
import { useT } from '../lib/i18n/index.js'
import { Dialog, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Fehler.tsx'

/**
 * Die Frage nach dem Kennwort vor einer kritischen Handlung (Migration
 * 0208, Bedrohungsanalyse 23.10.2026, T3).
 *
 * Haengt einmal in der `Shell` und wartet, bis `lib/bestaetigung.ts` fragt.
 * Der Bildschirm, der die Handlung ausloest, weiss davon nichts: er schickt
 * seine Anfrage, und sie kommt nach dem Kennwort von selbst durch.
 *
 * **Warum ein Kennwort und nicht nur ein Klick.** Der Angreifer, gegen den
 * das steht, sitzt bereits in einer Sitzung -- an einem Rezeptionsrechner,
 * von dem jemand kurz aufgestanden ist, oder mit einem gestohlenen Cookie.
 * Einen Knopf "Ja, wirklich" drueckt er genauso.
 *
 * Ein Passkey kommt als zweiter Weg daneben (Thread "Passkeys und Passwort
 * vergessen"); er bekommt seinen Knopf unter dem Feld.
 */
export function BestaetigungsDialog(): JSX.Element | null {
  const t = useT()
  const [offen, setOffen] = useState(false)
  const [kennwort, setKennwort] = useState('')
  const [laeuft, setLaeuft] = useState(false)
  const [fehler, setFehler] = useState<unknown>(null)
  const antwort = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => bestaetigungAnmelden(() => new Promise<boolean>(resolve => {
    antwort.current = resolve
    setKennwort('')
    setFehler(null)
    setOffen(true)
  })), [])

  const schliessen = (ok: boolean): void => {
    setOffen(false)
    setKennwort('')
    antwort.current?.(ok)
    antwort.current = null
  }

  const senden = async (): Promise<void> => {
    setLaeuft(true)
    setFehler(null)
    try {
      await api.post('/v1/auth/confirm', { password: kennwort })
      schliessen(true)
    } catch (e) {
      // Das Feld leeren: wer sich vertippt hat, tippt neu und nicht dazu.
      setKennwort('')
      setFehler(e)
    } finally {
      setLaeuft(false)
    }
  }

  if (!offen) return null
  return (
    <Dialog titel={t('sicherheit.confirm.title')} breite="schmal"
            onClose={() => schliessen(false)}
            fuss={<>
              <button type="button" className={KNOPF_LEISE} onClick={() => schliessen(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" form="bestaetigung" className={KNOPF}
                      disabled={laeuft || kennwort === ''}>
                {t('sicherheit.confirm.submit')}
              </button>
            </>}>
      <form id="bestaetigung" className="space-y-3"
            onSubmit={e => { e.preventDefault(); void senden() }}>
        <p className="text-sm text-neutral-700">
          {t('sicherheit.confirm.hint', { minutes: BESTAETIGUNG_MINUTEN })}
        </p>
        <Feld label={t('konto.currentPassword')}>
          <input type="password" autoComplete="current-password" autoFocus
                 value={kennwort} onChange={e => setKennwort(e.target.value)}
                 className={FELD} />
        </Feld>
        {fehler !== null && <Fehler error={fehler} />}
      </form>
    </Dialog>
  )
}
