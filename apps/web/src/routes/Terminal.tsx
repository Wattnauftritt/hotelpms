import { useEffect, useRef, useState } from 'react'
import { LOCALES, I18nContext, useT, useLocale, formatDate, type Locale }
  from '../lib/i18n/index.js'
import { api, ApiError } from '../lib/api.js'
import { Unterschriftsfeld } from '../components/Unterschriftsfeld.tsx'
import { Inhaltstext } from '../components/Inhaltstext.tsx'
import { Fehler } from '../components/Shell.tsx'
import { GastCheckin } from './GastCheckin.tsx'
import { referrerFuer } from '../lib/rahmen.js'

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
 *   Kopplung beginnt die Abfrage, und eine 401 oder 403 beendet sie wieder.
 * - **Ein Kiosk, der alles vergisst, meldet sich ueber seine Adresse an.**
 *   Edge im Kioskmodus von Windows laeuft immer InPrivate und verwirft das
 *   Geraetecookie bei jedem Neustart und Leerlauf-Reset. Steht in der
 *   Adresse `#k=...`, tauscht die Seite das Geheimnis zuerst gegen das
 *   Cookie und nimmt es sofort aus der Adresse.
 */

export const TERMINAL_PFAD = '/terminal'

/** Steht die Terminalseite in der Adresse? Wie `zugangAusAdresse`, zum Pruefen ohne Browser. */
export function istTerminalAdresse(pathname: string = location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === TERMINAL_PFAD
}

/**
 * Das Geheimnis der Kiosk-Adresse (`/terminal#k=...`), sonst `null`.
 *
 * Hinter dem `#`, weil der Browser diesen Teil nie an einen Server
 * schickt: das Geheimnis erreicht keine Protokollzeile, nur den Rumpf von
 * `/v1/terminal/resume`.
 */
export function kioskSchluesselAusAdresse(hash: string = location.hash): string | null {
  const k = new URLSearchParams(hash.replace(/^#/, '')).get('k')
  return k !== null && /^[A-Za-z0-9_-]{43}$/.test(k) ? k : null
}

/** Wie oft das Terminal fragt. Zwei Sekunden: der Gast steht schon davor. */
const FRAGE_MS = 2_000
/** Ohne Verbindung seltener -- ein Netz, das weg ist, kommt nicht schneller zurueck. */
const FRAGE_OHNE_NETZ_MS = 10_000
/** Ohne Beruehrung zurueck in den Ruhezustand. */
const STILLE_MS = 90_000
/** Wie lange der Dank stehen bleibt. */
const DANKE_MS = 4_000

/** Wie oft die Diashow neu geholt wird. Seiten aendern sich selten. */
const DIASHOW_NEU_MS = 5 * 60_000

type Art = 'registration_fill' | 'registration_sign' | 'terms_sign' | 'content' | 'url'

interface Folie { title: string; body: string; seconds: number; imageRef: string | null }

interface Frage {
  property: string
  isTraining: boolean
  job: { jobRef: string; kind: Art; state: string } | null
}

type Phase =
  | { art: 'start' }
  | { art: 'kiosk'; key: string }
  | { art: 'koppeln'; fehler?: unknown }
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
  // Nur lesen, nicht aendern: im Entwicklungsmodus laeuft diese Funktion
  // zweimal. Aus der Adresse genommen wird das Geheimnis im Effekt unten.
  const [phase, setPhase] = useState<Phase>(() => {
    const key = kioskSchluesselAusAdresse()
    return key === null ? { art: 'start' } : { art: 'kiosk', key }
  })
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

  // ------------------------------------------------------ Kiosk-Adresse
  /*
   * Erst das Geheimnis aus der Adresse nehmen, dann einloesen. Es bleibt
   * nur im Zustand dieser Seite; ohne Netz wird weiter versucht, denn nach
   * einem Neustart ist der Browser oft schneller da als das Netz -- und
   * ohne die Adresse kaeme das Geheimnis bis zum naechsten Start nicht
   * wieder. Gilt es nicht mehr, steht die Codeeingabe da, mit dem Grund.
   */
  /*
   * Eine Kiosk-Adresse, die in eine schon offene Terminalseite kommt.
   * Aendert sich nur der Teil hinter dem `#`, laedt der Browser die Seite
   * nicht neu -- der Zustand oben wird nicht neu gelesen, und die Seite
   * fragte mit dem alten Stand weiter. Genau so sah es aus, als die Adresse
   * in einen Tab mit offenem `/terminal` eingefuegt wurde.
   */
  useEffect(() => {
    const neu = (): void => {
      const key = kioskSchluesselAusAdresse()
      if (key !== null) setPhase({ art: 'kiosk', key })
    }
    window.addEventListener('hashchange', neu)
    return () => window.removeEventListener('hashchange', neu)
  }, [])

  const kioskKey = phase.art === 'kiosk' ? phase.key : null
  useEffect(() => {
    if (kioskKey === null) return
    history.replaceState(null, '', TERMINAL_PFAD)
    let aus = false
    let zeitgeber: number | undefined
    const einloesen = (): void => {
      api.post('/v1/terminal/resume', { key: kioskKey })
        .then(() => { if (!aus) setPhase({ art: 'start' }) })
        .catch((e: unknown) => {
          if (aus) return
          if (e instanceof ApiError && e.status < 500 && e.status !== 429) {
            setPhase({ art: 'koppeln', fehler: e })
            return
          }
          setOhneNetz(true)
          zeitgeber = window.setTimeout(einloesen, FRAGE_OHNE_NETZ_MS)
        })
    }
    einloesen()
    return () => { aus = true; window.clearTimeout(zeitgeber) }
  }, [kioskKey])

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
        if (e instanceof ApiError && e.status === 403) {
          // Kein Geraet, aber eine Mitarbeitersitzung im selben Browser:
          // die Anfrage ist angemeldet, nur nicht als Terminal. Weiterfragen
          // aendert daran nichts -- hier stand die Seite einmal und fragte
          // alle zwei Sekunden ins Leere. Die Kopplung beendet die Sitzung.
          setPhase({ art: 'koppeln', fehler: e })
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

  /**
   * Den Auftrag abschliessen. Danach der Dank -- oder, wo die Ansicht selbst
   * dankt oder nichts zu danken ist (eine Seite, eine Adresse), gleich der
   * Ruhezustand. Ein Fehler geht an die Ansicht zurueck, die ihn zeigt.
   */
  const abschliessen = async (jobRef: string, body: Record<string, unknown>,
                              mitDank: boolean): Promise<void> => {
    await api.post(`/v1/terminal/job/${jobRef}/complete`, body)
    if (mitDank) setPhase({ art: 'danke' })
    else abraeumen()
  }

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
          <span className="text-xs px-2 py-1 rounded-sm bg-amber-100 text-amber-900">
            {t('kiosk.training')}
          </span>
        )}
        {/* Das Meldeformular fuehrt seine eigene Sprachwahl (GastCheckin). */}
        {!(phase.art === 'auftrag' && phase.kind === 'registration_fill') && (
          <Sprachwahl onLocale={onLocale} />
        )}
      </header>

      <main className="grow grid place-items-center px-6 pb-8">
        {(phase.art === 'start' || phase.art === 'kiosk') &&
          <div className="text-neutral-400">…</div>}
        {phase.art === 'koppeln' && <Koppeln anfangsFehler={phase.fehler}
                                             onGekoppelt={() => setPhase({ art: 'start' })} />}
        {phase.art === 'ruhe' && <Ruhe />}
        {phase.art === 'auftrag' && (() => {
          const Ansicht = ANSICHTEN[phase.kind]
          const jobRef = phase.jobRef
          return <Ansicht jobRef={jobRef} daten={phase.daten}
                          abschliessen={(body, mitDank) => abschliessen(jobRef, body, mitDank)}
                          onAbbrechen={() => abbrechen(jobRef)} />
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

/**
 * Der Ruhezustand: die Diashow des Hauses, sonst die Begruessung.
 *
 * Die Folien sind Seiten des Hauses -- Fruehstueckszeiten, Sauna, Werbung
 * --, keine Gastdaten; sie duerfen deshalb im Zustand der Seite liegen.
 * Ein Auftrag der Rezeption unterbricht die Diashow, und nach dem Auftrag
 * baut sich die Seite neu auf und beginnt sie von vorn.
 */
function Ruhe(): JSX.Element {
  const t = useT()
  const [folien, setFolien] = useState<Folie[]>([])
  const [nr, setNr] = useState(0)

  useEffect(() => {
    let aus = false
    const holen = (): void => {
      api.get<{ slides: Folie[] }>('/v1/terminal/idle')
        .then(r => { if (!aus) setFolien(r.slides) })
        .catch(() => { /* ohne Diashow bleibt die Begruessung */ })
    }
    holen()
    const z = window.setInterval(holen, DIASHOW_NEU_MS)
    return () => { aus = true; window.clearInterval(z) }
  }, [])

  const folie = folien.length === 0 ? undefined : folien[nr % folien.length]
  useEffect(() => {
    if (folie === undefined) return
    const z = window.setTimeout(() => setNr(n => n + 1), folie.seconds * 1000)
    return () => window.clearTimeout(z)
  }, [folie, nr])

  if (folie === undefined) {
    return (
      <div className="text-center space-y-3">
        <div className="text-4xl font-light">{t('kiosk.welcome')}</div>
        <p className="text-neutral-500">{t('kiosk.idleHint')}</p>
      </div>
    )
  }
  return <Inhaltsseite title={folie.title} body={folie.body} imageRef={folie.imageRef} />
}

/** Eine Seite des Hauses, wie das Terminal sie zeigt. */
function Inhaltsseite({ title, body, imageRef }: {
  title: string; body: string; imageRef: string | null
}): JSX.Element {
  return (
    <article className="w-full max-w-4xl space-y-5">
      <h1 className="text-4xl font-semibold">{title}</h1>
      {imageRef !== null && (
        <img src={`/v1/terminal/images/${imageRef}`} alt=""
             className="w-full max-h-[50vh] object-contain rounded-sm" />
      )}
      <Inhaltstext text={body} gross />
    </article>
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
                className={`px-3 py-2 text-sm rounded-sm border ${l === locale
                  ? 'border-neutral-900 bg-white font-medium'
                  : 'border-neutral-300 text-neutral-600'}`}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Koppeln

function Koppeln({ onGekoppelt, anfangsFehler }: {
  onGekoppelt: () => void; anfangsFehler?: unknown
}): JSX.Element {
  const t = useT()
  const [code, setCode] = useState('')
  const [fehler, setFehler] = useState<unknown>(anfangsFehler ?? null)
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
               className="mt-1 w-full border border-neutral-300 rounded-sm px-3 py-3 text-2xl
                          font-mono tracking-widest uppercase" />
      </label>
      {fehler !== null && <Fehler error={fehler} />}
      <button type="submit" disabled={laeuft || code.trim().length < 8}
              className="w-full py-3 rounded-sm bg-neutral-900 text-white disabled:bg-neutral-300">
        {t('kiosk.pair')}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------- Ansichten

interface AnsichtProps {
  jobRef: string
  daten: unknown
  /** Den Auftrag abschliessen; danach Dank oder gleich Ruhe. */
  abschliessen: (body: Record<string, unknown>, mitDank: boolean) => Promise<void>
  onAbbrechen: () => void
}

/**
 * Eine Ansicht je Art. Eine neue Art ist ein Eintrag hier, einer in
 * `ARTEN` der Schnittstelle (`apps/api/src/platform/terminalArten.ts`) und
 * ein Wert in der Pruefbedingung von `terminal_job.kind`.
 */
const ANSICHTEN: Record<Art, (p: AnsichtProps) => JSX.Element> = {
  registration_fill: MeldeformularAusfuellen,
  registration_sign: MeldescheinUnterschreiben,
  terms_sign: BedingungZustimmen,
  content: SeiteZeigen,
  url: AdresseZeigen
}

/**
 * Meldeformular ausfuellen: das Formular des Online-Check-ins im Modus des
 * Terminals (Dokument 30). Der Link dazu kam mit dem Oeffnen und steht nur
 * im Zustand dieser Ansicht; mit dem Neuaufbau danach ist er weg, und die
 * Schnittstelle zieht ihn mit dem Auftrag zurueck.
 *
 * Das Formular dankt selbst und meldet sich danach, nach Stille oder auf
 * "Fertig" (`onFertig`). Ob wirklich eingereicht wurde, entscheidet die
 * Schnittstelle, nicht diese Seite.
 */
function MeldeformularAusfuellen({ daten, abschliessen, onAbbrechen }: AnsichtProps): JSX.Element {
  const t = useT()
  const { token } = daten as { token: string }
  const gemeldet = useRef(false)
  const fertig = (): void => {
    if (gemeldet.current) return
    gemeldet.current = true
    abschliessen({}, false).catch(abraeumen)
  }
  /*
   * Abbrechen wie in jeder anderen Ansicht. Das Formular selbst kennt am
   * Terminal nur "absenden"; ohne diesen Knopf bliebe einem Gast, der es
   * sich anders ueberlegt, nur das Warten auf die Stille -- neunzig
   * Sekunden, in denen seine Angaben fuer den naechsten lesbar dastehen.
   */
  return (
    <div className="w-full space-y-4">
      <GastCheckin token={token} modus="terminal" onFertig={fertig} />
      <div className="max-w-3xl mx-auto">
        <button type="button" onClick={onAbbrechen}
                className="w-full py-4 text-lg rounded-sm border border-neutral-300 bg-white">
          {t('kiosk.abort')}
        </button>
      </div>
    </div>
  )
}

/**
 * Eine Hausbedingung: Text, und je nach Fassung Zustimmung oder
 * Unterschrift. Dieselbe Regel wie am Tresen; die Schnittstelle weist eine
 * fehlende Unterschrift ab, wo die Fassung eine verlangt.
 */
function BedingungZustimmen({ daten, abschliessen, onAbbrechen }: AnsichtProps): JSX.Element {
  const t = useT()
  const d = daten as { title: string; body: string; requiresSignature: boolean }
  const [signatur, setSignatur] = useState<string | null>(null)
  const [fehler, setFehler] = useState<unknown>(null)
  const [laeuft, setLaeuft] = useState(false)
  return (
    <div className="w-full max-w-3xl bg-white border border-neutral-200 rounded-lg p-6 space-y-4">
      <h1 className="text-2xl font-semibold">{d.title}</h1>
      <p className="text-lg whitespace-pre-line">{d.body}</p>
      {d.requiresSignature && (
        <div className="space-y-2">
          <div className="text-sm text-neutral-600">{t('kiosk.sign.here')}</div>
          <Unterschriftsfeld onChange={setSignatur} breite={900} hoehe={260} gross
                             beschriftungLoeschen={t('kiosk.sign.clear')} />
        </div>
      )}
      {fehler !== null && <Fehler error={fehler} />}
      <div className="flex gap-3">
        <button type="button" disabled={laeuft || (d.requiresSignature && signatur === null)}
                onClick={() => {
                  setLaeuft(true)
                  setFehler(null)
                  abschliessen(d.requiresSignature ? { signatureSvg: signatur } : {}, true)
                    .catch((e: unknown) => { setFehler(e); setLaeuft(false) })
                }}
                className="grow py-4 text-lg rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t(d.requiresSignature ? 'kiosk.terms.sign' : 'kiosk.terms.accept')}
        </button>
        <button type="button" onClick={onAbbrechen} disabled={laeuft}
                className="px-6 py-4 text-lg rounded-sm border border-neutral-300">
          {t('kiosk.abort')}
        </button>
      </div>
    </div>
  )
}

/** Eine Seite des Hauses, mit "Fertig". Nichts daran ist Gastdatum. */
function SeiteZeigen({ daten, abschliessen }: AnsichtProps): JSX.Element {
  const t = useT()
  const d = daten as { title: string; body: string; imageRef: string | null }
  return (
    <div className="w-full max-w-4xl space-y-6">
      <Inhaltsseite title={d.title} body={d.body} imageRef={d.imageRef} />
      <button type="button" onClick={() => { abschliessen({}, false).catch(abraeumen) }}
              className="w-full py-4 text-lg rounded-sm bg-neutral-900 text-white">
        {t('kiosk.done')}
      </button>
    </div>
  )
}

/**
 * Eine freigegebene externe Seite in einem abgeschotteten Rahmen.
 *
 * **Der Rahmen darf wenig.** Skript und Formulare der fremden Seite laufen
 * (sonst geht keine Speisekarte), aber sie darf das Terminal nicht
 * verlassen (keine Navigation der obersten Ebene), keine Fenster oeffnen
 * und nicht herunterladen. Mit ihrer eigenen Herkunft (`allow-same-origin`)
 * kommt sie an die Seite des Terminals nicht heran -- das ist eine andere.
 *
 * **Die Grenze:** viele Seiten verbieten, in einem Rahmen gezeigt zu werden
 * (`X-Frame-Options`, `frame-ancestors`). Der Browser zeigt dann eine leere
 * oder eine Fehlerflaeche, und von hier aus laesst sich das nicht sicher
 * erkennen -- der Inhalt einer fremden Herkunft ist fuer diese Seite
 * unsichtbar. Darum steht ueber dem Rahmen immer ein Satz, der es erklaert,
 * und "Fertig" ist nie verdeckt. Ob eine Adresse eingebettet werden kann,
 * sieht das Haus beim Freigeben in der Vorschau (Einstellungen).
 */
function AdresseZeigen({ daten, abschliessen }: AnsichtProps): JSX.Element {
  const t = useT()
  const d = daten as { label: string; url: string }
  return (
    // Ueber die ganze Flaeche, aber keine Maske: das Terminal hat nichts
    // darunter, zu dem man zurueckklickt. "Fertig" ist der einzige Weg.
    <div className="fixed left-0 top-0 h-screen w-screen flex flex-col bg-white">
      <div className="flex items-center gap-4 px-6 py-3 border-b border-neutral-200 bg-neutral-50">
        <div className="grow">
          <div className="text-lg font-medium">{d.label}</div>
          <div className="text-sm text-neutral-500">{t('kiosk.url.hint')}</div>
        </div>
        <button type="button" onClick={() => { abschliessen({}, false).catch(abraeumen) }}
                className="px-8 py-3 text-lg rounded-sm bg-neutral-900 text-white">
          {t('kiosk.done')}
        </button>
      </div>
      <iframe src={d.url} title={d.label} referrerPolicy={referrerFuer(d.url)}
              allow="encrypted-media; fullscreen; picture-in-picture"
              sandbox="allow-scripts allow-same-origin allow-forms"
              className="grow w-full border-0" />
    </div>
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
function MeldescheinUnterschreiben({ daten, abschliessen, onAbbrechen }: AnsichtProps
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
                           beschriftungLoeschen={t('kiosk.sign.clear')} />
        <p className="text-xs text-neutral-500">{t('kiosk.sign.legal')}</p>
      </div>

      {fehler !== null && <Fehler error={fehler} />}
      <div className="flex gap-3">
        <button type="button" disabled={signatur === null || laeuft}
                onClick={() => {
                  if (signatur === null) return
                  setLaeuft(true)
                  setFehler(null)
                  abschliessen({ signatureSvg: signatur }, true)
                    .catch((e: unknown) => { setFehler(e); setLaeuft(false) })
                }}
                className="grow py-4 text-lg rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('kiosk.sign.submit')}
        </button>
        <button type="button" onClick={onAbbrechen} disabled={laeuft}
                className="px-6 py-4 text-lg rounded-sm border border-neutral-300">
          {t('kiosk.abort')}
        </button>
      </div>
    </div>
  )
}
