import { useState, useEffect } from 'react'
import { KENNWORT_MIN } from '@hotelpms/contracts'
import { api, ApiError } from '../lib/api.js'
import { useT } from '../lib/i18n/index.js'

/**
 * Zugang: Einladung annehmen, Kennwort vergessen, Kennwort setzen,
 * neue Mailadresse bestaetigen.
 *
 * **Warum vor der Anmeldung und ohne den Rest der Oberflaeche.** Wer hier
 * landet, ist nicht angemeldet und kann es auch nicht sein -- im Gegenteil,
 * er will es gerade erst werden. Die Shell mit Haus und Bildschirmen haette
 * an dieser Stelle nichts anzuzeigen.
 *
 * **Warum ein Pfad und keine Ansicht im Zustand.** Der Link kommt aus einer
 * E-Mail; er muss beim Anklicken funktionieren, ohne dass vorher etwas
 * geladen war. Caddy liefert dafuer `index.html` fuer jeden unbekannten Pfad
 * (`try_files`), die Anwendung liest ihn hier.
 */

export type ZugangArt = 'invite' | 'reset' | 'emailChange'

/**
 * Welche Seite steht in der Adresse?
 *
 * Null heisst: keine. Dann laeuft die Anwendung normal weiter -- diese Datei
 * darf den Regelfall nicht anfassen.
 *
 * Pfad und Abfrageteil kommen als Parameter herein, mit `location` als
 * Vorgabe. Nicht der Zierde halber: so laesst sich die Auswertung pruefen,
 * ohne einen Browser zu bauen oder `location` zu faelschen -- und geprueft
 * gehoert sie, weil ein falsch gelesener Pfad die ganze Anwendung durch die
 * Zugangsseite ersetzen wuerde.
 */
export function zugangAusAdresse(
  pathname: string = location.pathname, search: string = location.search
): { art: ZugangArt; token: string | null } | null {
  // Abschliessende Schraegstriche weg: /kennwort/ kommt aus einem
  // Mailprogramm haeufiger vor, als man denkt.
  const pfad = pathname.replace(/\/+$/, '')
  const art: ZugangArt | null =
    pfad === '/einladung' ? 'invite'
    : pfad === '/kennwort' ? 'reset'
    : pfad === '/mailadresse' ? 'emailChange'
    : null
  if (art === null) return null
  // Ein leerer Parameter ist kein Token. Sonst liefe der Benutzer in ein
  // Formular, das beim Absenden sicher scheitert.
  const token = new URLSearchParams(search).get('token')
  return { art, token: token !== null && token.length > 0 ? token : null }
}

/** Zurueck in die Anwendung, ohne Token in der Adresse. */
function zurAnmeldung(): void {
  location.href = '/'
}

function Rahmen({ titel, children }: {
  titel: string; children: React.ReactNode
}): JSX.Element {
  return (
    <div className="min-h-screen grid place-items-center bg-neutral-50 p-4">
      <div className="w-full max-w-sm bg-white border border-neutral-200 rounded
                      p-6 space-y-3">
        <h1 className="font-semibold">{titel}</h1>
        {children}
      </div>
    </div>
  )
}

function Fehler({ text }: { text: string }): JSX.Element {
  return (
    <p role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200
                               rounded px-2 py-1">{text}</p>
  )
}

const FELD = `mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm`
const KNOPF = `w-full py-1.5 text-sm rounded bg-neutral-900 text-white
               disabled:bg-neutral-300`

/** Einen Link anfordern. Ohne Token in der Adresse ist das der Fall. */
function Anfordern(): JSX.Element {
  const t = useT()
  const [email, setEmail] = useState('')
  const [laeuft, setLaeuft] = useState(false)
  const [fertig, setFertig] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)

  if (fertig) {
    return (
      <Rahmen titel={t('zugang.reset.title')}>
        <p className="text-sm text-neutral-700">{t('zugang.reset.done')}</p>
        <button type="button" className={KNOPF} onClick={zurAnmeldung}>
          {t('zugang.toLogin')}
        </button>
      </Rahmen>
    )
  }

  return (
    <Rahmen titel={t('zugang.reset.title')}>
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault()
        setFehler(null)
        setLaeuft(true)
        try {
          await api.post('/v1/auth/password-reset', { email })
          /*
           * Immer derselbe Abschluss, auch wenn es die Adresse nicht gibt.
           * Die Schnittstelle antwortet aus gutem Grund immer 202; hier den
           * Unterschied doch noch sichtbar zu machen, gaebe die Auskunft
           * zurueck, die sie gerade verweigert hat.
           */
          setFertig(true)
        } catch (err) {
          setFehler(err instanceof ApiError ? err.message : String(err))
        } finally {
          setLaeuft(false)
        }
      }}>
        <p className="text-sm text-neutral-600">{t('zugang.reset.hint')}</p>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('login.email')}</span>
          <input type="email" required autoComplete="username" value={email}
                 onChange={e => setEmail(e.target.value)} className={FELD} />
        </label>
        {fehler !== null && <Fehler text={fehler} />}
        <button type="submit" disabled={laeuft} className={KNOPF}>
          {t(laeuft ? 'common.loading' : 'zugang.reset.submit')}
        </button>
      </form>
    </Rahmen>
  )
}

/** Kennwort setzen. Mit Token in der Adresse, fuer Einladung wie Ruecksetzung. */
function Setzen({ art, token }: { art: ZugangArt; token: string }): JSX.Element {
  const t = useT()
  const [kennwort, setKennwort] = useState('')
  const [wieder, setWieder] = useState('')
  const [laeuft, setLaeuft] = useState(false)
  const [fertig, setFertig] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)

  const titel = art === 'invite' ? t('zugang.invite.title') : t('zugang.set.title')

  if (fertig) {
    return (
      <Rahmen titel={titel}>
        <p className="text-sm text-neutral-700">{t('zugang.set.done')}</p>
        <button type="button" className={KNOPF} onClick={zurAnmeldung}>
          {t('zugang.toLogin')}
        </button>
      </Rahmen>
    )
  }

  /*
   * Die Wiederholung wird hier geprueft und nicht von der Schnittstelle: sie
   * kennt nur ein Kennwort. Ein Tippfehler in einem Feld, das niemand liest,
   * spraeche sich sonst erst beim Anmelden aus -- und dann ist das Token
   * verbraucht.
   */
  const passtNicht = wieder.length > 0 && kennwort !== wieder

  return (
    <Rahmen titel={titel}>
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault()
        setFehler(null)
        setLaeuft(true)
        try {
          await api.post('/v1/auth/password-reset/confirm', { token, password: kennwort })
          setFertig(true)
        } catch (err) {
          setFehler(err instanceof ApiError ? err.message : String(err))
        } finally {
          setLaeuft(false)
        }
      }}>
        {art === 'invite' && (
          <p className="text-sm text-neutral-600">{t('zugang.invite.hint')}</p>
        )}
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('zugang.password')}</span>
          <input type="password" required autoComplete="new-password"
                 minLength={KENNWORT_MIN} value={kennwort}
                 onChange={e => setKennwort(e.target.value)} className={FELD} />
        </label>
        <p className="text-xs text-neutral-500">
          {t('zugang.rule', { min: KENNWORT_MIN })}
        </p>
        <label className="block">
          <span className="block text-xs text-neutral-600">
            {t('zugang.passwordRepeat')}
          </span>
          <input type="password" required autoComplete="new-password" value={wieder}
                 onChange={e => setWieder(e.target.value)} className={FELD} />
        </label>
        {passtNicht && <Fehler text={t('zugang.mismatch')} />}
        {fehler !== null && <Fehler text={fehler} />}
        <button type="submit" disabled={laeuft || passtNicht || kennwort.length === 0}
                className={KNOPF}>
          {t(laeuft ? 'common.loading' : 'zugang.set.submit')}
        </button>
      </form>
    </Rahmen>
  )
}

/**
 * Die neue Mailadresse bestätigen.
 *
 * Ein Bildschirm ohne Eingabe: beim Öffnen wird der Link eingelöst, und
 * danach steht dort, was geschehen ist. Ein Knopf „Jetzt bestätigen" wäre
 * ein Klick, der nichts hinzufügt — geklickt hat der Benutzer schon, im
 * Postfach.
 */
function MailBestaetigen({ token }: { token: string }): JSX.Element {
  const t = useT()
  const [stand, setStand] = useState<'laeuft' | 'ok' | 'fehler'>('laeuft')
  const [meldung, setMeldung] = useState<string | null>(null)

  useEffect(() => {
    let abgebrochen = false
    void api.post('/v1/auth/email/confirm', { token })
      .then(() => { if (!abgebrochen) setStand('ok') })
      .catch((e: unknown) => {
        if (abgebrochen) return
        setMeldung(e instanceof ApiError ? e.message : String(e))
        setStand('fehler')
      })
    return () => { abgebrochen = true }
  }, [token])

  return (
    <Rahmen titel={t('zugang.mail.title')}>
      {stand === 'laeuft' && (
        <p className="text-sm text-neutral-600">{t('common.loading')}</p>
      )}
      {stand === 'ok' && (
        <>
          <p className="text-sm text-neutral-700">{t('zugang.mail.done')}</p>
          <button type="button" className={KNOPF} onClick={zurAnmeldung}>
            {t('zugang.toLogin')}
          </button>
        </>
      )}
      {stand === 'fehler' && (
        <>
          {meldung !== null && <Fehler text={meldung} />}
          <button type="button" className={KNOPF} onClick={zurAnmeldung}>
            {t('zugang.toLogin')}
          </button>
        </>
      )}
    </Rahmen>
  )
}

export function Zugang({ art, token }: {
  art: ZugangArt; token: string | null
}): JSX.Element {
  const t = useT()

  /*
   * Eine Einladung ohne Token ist ein kaputter Link -- dort gibt es nichts
   * anzufordern, weil der Eingeladene noch gar keinen Zugang hat, dessen
   * Kennwort man zuruecksetzen koennte. Bei der Ruecksetzung dagegen ist der
   * Aufruf ohne Token der Normalfall: so kommt man ueber "Kennwort
   * vergessen" hierher.
   */
  /*
   * Die Bestaetigung einer neuen Mailadresse braucht kein Formular: der
   * Link traegt alles, was noetig ist. Ein Feld "neue Adresse" hier waere
   * die Stelle, an der sich die bestaetigte Adresse noch einmal austauschen
   * liesse -- und damit der ganze Zwischenschritt wertlos.
   */
  if (art === 'emailChange') {
    if (token === null) {
      return (
        <Rahmen titel={t('zugang.mail.title')}>
          <p className="text-sm text-neutral-700">{t('zugang.noToken')}</p>
          <button type="button" className={KNOPF} onClick={zurAnmeldung}>
            {t('zugang.toLogin')}
          </button>
        </Rahmen>
      )
    }
    return <MailBestaetigen token={token} />
  }

  if (token === null) {
    if (art === 'reset') return <Anfordern />
    return (
      <Rahmen titel={t('zugang.invite.title')}>
        <p className="text-sm text-neutral-700">{t('zugang.noToken')}</p>
        <button type="button" className={KNOPF} onClick={zurAnmeldung}>
          {t('zugang.toLogin')}
        </button>
      </Rahmen>
    )
  }
  return <Setzen art={art} token={token} />
}
