import { useEffect, useRef, useState } from 'react'
import { LOCALES, I18nContext, useT, useLocale, formatDate, type Locale }
  from '../lib/i18n/index.js'
import { api, ApiError } from '../lib/api.js'
import { Unterschriftsfeld } from '../components/Unterschriftsfeld.tsx'
import { Fehler } from '../components/Shell.tsx'

/**
 * Die Seite am Gaesteterminal (Dokument 31).
 *
 * Ein Touchscreen neben dem Tresen, davor ein **Gast**. Daraus folgt alles
 * Weitere:
 *
 * - **Keine Anmeldung, kein Zwischenspeicher.** Die Seite steht ausserhalb
 *   der Anmeldung wie die Einladung (`main.tsx`) und benutzt bewusst nicht
 *   TanStack Query: dessen Speicher haelt Antworten ueber das Ende einer
 *   Komponente hinaus, und genau das darf hier nicht sein. Gastdaten stehen
 *   nur im Zustand der gerade gezeigten Ansicht.
 * - **Nach jedem Auftrag ein Neuaufbau** (`abraeumen`), nicht nur ein
 *   geleerter Zustand -- dieselbe Begruendung wie beim Abmelden in
 *   `main.tsx`: nur der Neuaufbau laesst garantiert nichts stehen, weder im
 *   Zustand noch im abgeloesten DOM noch in der Leinwand. Die Adresse wird
 *   ersetzt, nicht ergaenzt: ein "Zurueck" fuehrt nicht in die Daten des
 *   Vorgaengers. Kein `localStorage`, kein `sessionStorage`.
 * - **Ohne Beruehrung raeumt die Seite selbst ab**, nach neunzig Sekunden.
 *   Ein Gast, der mitten im Formular geht, laesst sonst seine Anschrift
 *   fuer den naechsten stehen.
 * - **Ungekoppelt fragt sie nicht.** Ein Terminal ohne Geraetecookie wird
 *   als anonyme Anfrage gezaehlt; im Sekundentakt gefragt, sperrte es die
 *   Herkunft der ganzen Rezeption an der allgemeinen Grenze. Erst nach der
 *   Kopplung beginnt die Abfrage, und eine 401 beendet sie wieder.
 */

export const TERMINAL_PFAD = '/terminal'

/** Steht die Terminalseite in der Adresse? Wie `zugangAusAdresse`, zum Pruefen ohne Browser. */
export function istTerminalAdresse(pathname: string = location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === TERMINAL_PFAD
}

/** Wie oft das Terminal fragt. Zwei Sekunden: der Gast steht schon davor. */
const FRAGE_MS = 2_000
/** Ohne Verbindung seltener -- ein Netz, das weg ist, kommt nicht schneller zurueck. */
const FRAGE_OHNE_NETZ_MS = 10_000
/** Ohne Beruehrung zurueck in den Ruhezustand. */
const STILLE_MS = 90_000
/** Wie lange der Dank stehen bleibt. */
const DANKE_MS = 4_000

type Art = 'registration_sign' | 'registration_fill'

interface Frage {
  property: string
  isTraining: boolean
  job: { jobRef: string; kind: Art; state: string } | null
}

type Phase =
  | { art: 'start' }
  | { art: 'koppeln' }
  | { art: 'ruhe' }
  | { art: 'auftrag'; jobRef: string; kind: Art; daten: unknown }
  | { art: 'danke' }

/**
 * Zurueck in den Ruhezustand, und zwar durch Neuaufbau.
 *
 * Erst die Adresse ersetzen, dann neu laden: so bleibt kein Eintrag in der
 * Geschichte, und `replace` legt auch fuer das Neuladen keinen an. Das
 * Geraetecookie bleibt -- es ist die Kopplung, kein Gastdatum.
 */
export function abraeumen(): void {
  history.replaceState(null, '', TERMINAL_PFAD)
  location.replace(TERMINAL_PFAD)
}

function spracheDesBrowsers(): Locale {
  const l = navigator.language.slice(0, 2)
  return (LOCALES as readonly string[]).includes(l) ? (l as Locale) : 'de'
}

export function TerminalSeite(): JSX.Element {
  // Die Sprache waehlt der Gast; mit dem Neuaufbau nach dem Auftrag faellt
  // sie auf die des Geraets zurueck, der naechste Gast waehlt neu.
  const [locale, setLocale] = useState<Locale>(spracheDesBrowsers)
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  return (
    <I18nContext.Provider value={locale}>
      <Terminal onLocale={setLocale} />
    </I18nContext.Provider>
  )
}

function Terminal({ onLocale }: { onLocale: (l: Locale) => void }): JSX.Element {
  const t = useT()
  const [phase, setPhase] = useState<Phase>({ art: 'start' })
  const [haus, setHaus] = useState<{ name: string; uebung: boolean } | null>(null)
  const [ohneNetz, setOhneNetz] = useState(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  /*
   * Der Vor-Zurueck-Speicher des Browsers haelt eine Seite samt Zustand
   * fest. Kommt sie von dort zurueck, wird sie neu aufgebaut -- unabhaengig
   * davon, was die Kopfzeilen des Servers erlauben.
   */
  useEffect(() => {
    const zurueck = (e: PageTransitionEvent): void => { if (e.persisted) abraeumen() }
    window.addEventListener('pageshow', zurueck)
    return () => window.removeEventListener('pageshow', zurueck)
  }, [])

  // ------------------------------------------------------------ Abfrage
  const fragt = phase.art === 'start' || phase.art === 'ruhe' || phase.art === 'auftrag'
  useEffect(() => {
    if (!fragt) return
    let aus = false
    let zeitgeber: number | undefined

    const runde = async (): Promise<void> => {
      let warten = FRAGE_MS
      try {
        const f = await api.get<Frage>('/v1/terminal/job')
        if (aus) return
        setOhneNetz(false)
        setHaus({ name: f.property, uebung: f.isTraining })
        const p = phaseRef.current
        if (p.art === 'auftrag') {
          // Die Rezeption hat abgebrochen, oder der Auftrag ist abgelaufen:
          // weg mit den Daten, sofort.
          if (f.job === null || f.job.jobRef !== p.jobRef) { abraeumen(); return }
        } else if (f.job !== null) {
          const auf = await api.post<{ jobRef: string; kind: Art; data: unknown }>(
            `/v1/terminal/job/${f.job.jobRef}/open`)
          if (aus) return
          setPhase({ art: 'auftrag', jobRef: auf.jobRef, kind: auf.kind, daten: auf.data })
        } else if (p.art === 'start') {
          setPhase({ art: 'ruhe' })
        }
      } catch (e) {
        if (aus) return
        if (e instanceof ApiError && e.status === 401) {
          // Nicht (mehr) gekoppelt -- widerrufen oder nie gekoppelt. Ab
          // hier wird nicht mehr gefragt.
          setPhase({ art: 'koppeln' })
          return
        }
        if (!(e instanceof ApiError) || e.status >= 500 || e.status === 429) {
          setOhneNetz(true)
          warten = FRAGE_OHNE_NETZ_MS
        }
        // Eine 409 beim Oeffnen heisst: der Auftrag ist inzwischen zu.
        // Die naechste Frage sieht das und bleibt in Ruhe.
      }
      zeitgeber = window.setTimeout(() => { void runde() }, warten)
    }
    void runde()
    return () => { aus = true; window.clearTimeout(zeitgeber) }
  }, [fragt])

  // ---------------------------------------------- Stille raeumt ab
  const auftrag = phase.art === 'auftrag' ? phase.jobRef : null
  useEffect(() => {
    if (auftrag === null) return
    let zuletzt = Date.now()
    const beruehrt = (): void => { zuletzt = Date.now() }
    window.addEventListener('pointerdown', beruehrt)
    window.addEventListener('keydown', beruehrt)
    const pruefen = window.setInterval(() => {
      if (Date.now() - zuletzt < STILLE_MS) return
      window.clearInterval(pruefen)
      void api.post(`/v1/terminal/job/${auftrag}/abort`, { reason: 'timeout' })
        .catch(() => { /* abgeraeumt wird trotzdem */ })
        .finally(abraeumen)
    }, 5_000)
    return () => {
      window.removeEventListener('pointerdown', beruehrt)
      window.removeEventListener('keydown', beruehrt)
      window.clearInterval(pruefen)
    }
  }, [auftrag])

  // ---------------------------------------------- Dank, dann Ruhe
  useEffect(() => {
    if (phase.art !== 'danke') return
    const z = window.setTimeout(abraeumen, DANKE_MS)
    return () => window.clearTimeout(z)
  }, [phase.art])

  const abbrechen = (jobRef: string): void => {
    void api.post(`/v1/terminal/job/${jobRef}/abort`, { reason: 'guest' })
      .catch(() => { /* abgeraeumt wird trotzdem */ })
      .finally(abraeumen)
  }

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 select-none">
      <header className="flex items-center gap-3 px-6 py-4">
        <span className="text-lg font-semibold grow">{haus?.name ?? ''}</span>
        {haus?.uebung === true && (
          <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900">
            {t('kiosk.training')}
          </span>
        )}
        <Sprachwahl onLocale={onLocale} />
      </header>

      <main className="grow grid place-items-center px-6 pb-8">
        {phase.art === 'start' && <div className="text-neutral-400">…</div>}
        {phase.art === 'koppeln' && <Koppeln onGekoppelt={() => setPhase({ art: 'start' })} />}
        {phase.art === 'ruhe' && (
          <div className="text-center space-y-3">
            <div className="text-4xl font-light">{t('kiosk.welcome')}</div>
            <p className="text-neutral-500">{t('kiosk.idleHint')}</p>
          </div>
        )}
        {phase.art === 'auftrag' && (() => {
          const Ansicht = ANSICHTEN[phase.kind]
          return <Ansicht jobRef={phase.jobRef} daten={phase.daten}
                          onFertig={() => setPhase({ art: 'danke' })}
                          onAbbrechen={() => abbrechen(phase.jobRef)} />
        })()}
        {phase.art === 'danke' && (
          <div className="text-center space-y-3">
            <div className="text-4xl font-light">{t('kiosk.thanks')}</div>
            <p className="text-neutral-500">{t('kiosk.thanksHint')}</p>
          </div>
        )}
      </main>

      {ohneNetz && (
        <footer className="px-6 py-2 text-sm text-amber-800 bg-amber-50">
          {t('kiosk.offline')}
        </footer>
      )}
    </div>
  )
}

function Sprachwahl({ onLocale }: { onLocale: (l: Locale) => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <div className="flex gap-1" role="group" aria-label={t('kiosk.language')}>
      {LOCALES.map(l => (
        <button key={l} type="button" onClick={() => onLocale(l)}
                aria-pressed={l === locale}
                className={`px-3 py-2 text-sm rounded border ${l === locale
                  ? 'border-neutral-900 bg-white font-medium'
                  : 'border-neutral-300 text-neutral-600'}`}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Koppeln

function Koppeln({ onGekoppelt }: { onGekoppelt: () => void }): JSX.Element {
  const t = useT()
  const [code, setCode] = useState('')
  const [fehler, setFehler] = useState<unknown>(null)
  const [laeuft, setLaeuft] = useState(false)

  return (
    <form className="w-full max-w-sm bg-white border border-neutral-200 rounded-lg p-6 space-y-3"
          onSubmit={e => {
            e.preventDefault()
            setLaeuft(true)
            setFehler(null)
            api.post('/v1/terminal/pair', { code })
              .then(() => { setCode(''); onGekoppelt() })
              .catch((err: unknown) => setFehler(err))
              .finally(() => setLaeuft(false))
          }}>
      <h1 className="text-lg font-semibold">{t('kiosk.pairTitle')}</h1>
      <p className="text-sm text-neutral-600">{t('kiosk.pairHint')}</p>
      <label className="block text-sm">
        <span className="text-neutral-600">{t('kiosk.pairCode')}</span>
        <input value={code} onChange={e => setCode(e.target.value)} autoFocus
               autoComplete="off" autoCapitalize="characters" spellCheck={false}
               className="mt-1 w-full border border-neutral-300 rounded px-3 py-3 text-2xl
                          font-mono tracking-widest uppercase" />
      </label>
      {fehler !== null && <Fehler error={fehler} />}
      <button type="submit" disabled={laeuft || code.trim().length < 8}
              className="w-full py-3 rounded bg-neutral-900 text-white disabled:bg-neutral-300">
        {t('kiosk.pair')}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------- Ansichten

interface AnsichtProps {
  jobRef: string
  daten: unknown
  onFertig: () => void
  onAbbrechen: () => void
}

/**
 * Eine Ansicht je Art. Eine neue Art ist ein Eintrag hier, einer in
 * `ARTEN` der Schnittstelle (`apps/api/src/routes/terminal.ts`) und ein Wert
 * in der Pruefbedingung von `terminal_job.kind`.
 */
const ANSICHTEN: Record<Art, (p: AnsichtProps) => JSX.Element> = {
  registration_sign: MeldescheinUnterschreiben,
  /*
   * TODO(checkin): Meldeformular ausfuellen. Die Schnittstelle legt diese
   * Art noch nicht an (`verfuegbar: false`), die Ansicht wird also nie
   * erreicht. Sobald der Online-Check-in gemergt ist, steht hier
   * `<GastCheckin token={daten.token} modus="terminal" onFertig={onFertig} />`
   * -- der Token kommt mit dem Oeffnen, nicht mit der Frage.
   */
  registration_fill: ({ onAbbrechen }) => <NichtVerfuegbar onAbbrechen={onAbbrechen} />
}

function NichtVerfuegbar({ onAbbrechen }: { onAbbrechen: () => void }): JSX.Element {
  const t = useT()
  return (
    <button type="button" onClick={onAbbrechen}
            className="px-6 py-3 rounded border border-neutral-300">
      {t('kiosk.abort')}
    </button>
  )
}

interface MeldescheinDaten {
  arrival: string
  plannedDeparture: string
  occupantCount: number
  guest: { lastName: string; firstName: string | null; birthDate: string | null
           nationality: string | null
           address: { line1: string | null; postalCode: string | null
                      city: string | null; country: string | null } }
  companions: Array<{ lastName: string; firstName: string | null }>
}

/**
 * Meldeschein unterschreiben. Gezeigt wird, was der Gast mit seiner
 * Unterschrift bestaetigt, und nichts darueber hinaus -- keine Mailadresse,
 * kein Preis, keine Buchungsnummer (die Schnittstelle schickt sie gar
 * nicht erst). Stimmt etwas nicht, korrigiert die Rezeption: ein Formular
 * zum Aendern am Touchscreen waere eine zweite Fassung der Gastmaske.
 */
function MeldescheinUnterschreiben({ jobRef, daten, onFertig, onAbbrechen }: AnsichtProps
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const d = daten as MeldescheinDaten
  const [signatur, setSignatur] = useState<string | null>(null)
  const [fehler, setFehler] = useState<unknown>(null)
  const [laeuft, setLaeuft] = useState(false)
  const g = d.guest
  const anschrift = [g.address.line1,
    [g.address.postalCode, g.address.city].filter(Boolean).join(' '),
    g.address.country].filter(Boolean).join(', ')

  const Zeile = ({ label, wert }: { label: string; wert: string }): JSX.Element => (
    <div className="grid grid-cols-3 gap-3 py-2 border-b border-neutral-100">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="col-span-2 text-lg">{wert || '—'}</dd>
    </div>
  )

  return (
    <div className="w-full max-w-3xl bg-white border border-neutral-200 rounded-lg p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t('kiosk.sign.title')}</h1>
        <p className="text-neutral-600">{t('kiosk.sign.intro')}</p>
      </div>
      <dl>
        <Zeile label={t('kiosk.field.name')}
               wert={`${g.lastName}${g.firstName ? `, ${g.firstName}` : ''}`} />
        <Zeile label={t('kiosk.field.birthDate')}
               wert={g.birthDate === null ? '' : formatDate(g.birthDate, locale)} />
        <Zeile label={t('kiosk.field.nationality')} wert={g.nationality ?? ''} />
        <Zeile label={t('kiosk.field.address')} wert={anschrift} />
        <Zeile label={t('kiosk.field.stay')}
               wert={`${formatDate(d.arrival, locale)} – ${formatDate(d.plannedDeparture, locale)}`} />
        <Zeile label={t('kiosk.field.occupants')} wert={String(d.occupantCount)} />
        {d.companions.length > 0 && (
          <Zeile label={t('kiosk.field.companions')}
                 wert={d.companions.map(c =>
                   `${c.lastName}${c.firstName ? `, ${c.firstName}` : ''}`).join('; ')} />
        )}
      </dl>
      <p className="text-sm text-neutral-500">{t('kiosk.sign.wrong')}</p>

      <div className="space-y-2">
        <div className="text-sm text-neutral-600">{t('kiosk.sign.here')}</div>
        <Unterschriftsfeld onChange={setSignatur} breite={900} hoehe={260} gross
                           leeren="kiosk.sign.clear" />
        <p className="text-xs text-neutral-500">{t('kiosk.sign.legal')}</p>
      </div>

      {fehler !== null && <Fehler error={fehler} />}
      <div className="flex gap-3">
        <button type="button" disabled={signatur === null || laeuft}
                onClick={() => {
                  if (signatur === null) return
                  setLaeuft(true)
                  setFehler(null)
                  api.post(`/v1/terminal/job/${jobRef}/complete`, { signatureSvg: signatur })
                    .then(onFertig)
                    .catch((e: unknown) => { setFehler(e); setLaeuft(false) })
                }}
                className="grow py-4 text-lg rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('kiosk.sign.submit')}
        </button>
        <button type="button" onClick={onAbbrechen} disabled={laeuft}
                className="px-6 py-4 text-lg rounded border border-neutral-300">
          {t('kiosk.abort')}
        </button>
      </div>
    </div>
  )
}
