import { useEffect, useMemo, useRef, useState } from 'react'
import { CHECKIN_PATH, CHECKIN_TOKEN_HEADER, LAENDER, checkinTokenAusFragment,
         istAuslaendisch, type CheckinFormView, type CheckinSubmit,
         type CheckinSubmitted, type CheckinTaxExemption,
         type CleaningWaiverView } from '@hotelpms/contracts'
import { api, ApiError } from '../lib/api.js'
import { fehlerMeldung } from '../lib/meldungen.js'
import { LOCALES, I18nContext, useT, useLocale, intlTag, formatDate, type Locale,
         type TextKey } from '../lib/i18n/index.js'
import { Unterschriftsfeld } from '../components/Unterschriftsfeld.tsx'
import { Datumsfeld } from '../components/Datumsfeld.tsx'
import { VerzichtTage } from '../components/Reinigungsverzicht.tsx'

/**
 * Online-Check-in: die Seite des Gastes (Dokument 30).
 *
 * **Zwei Modi, eine Maske.** Per Mail-Link (`mail`) auf dem eigenen Geraet
 * vor Anreise; an der Station im Haus (`terminal`) am Anreisetag. Die
 * Station bettet genau diese Komponente ein, statt eine zweite zu bauen --
 * zwei Masken fuer denselben Meldeschein liefen auseinander, und die eine
 * fragte irgendwann etwas ab, was die andere vergessen hat.
 *
 * **Die Schnittstelle dazu** steht in `routes/checkin.ts`: das Token reist
 * in der Kopfzeile, nie im Pfad. Hier wird es nirgends abgelegt -- kein
 * `localStorage`, kein `sessionStorage`, kein Zwischenspeicher von TanStack
 * Query. Letzteres ist der unscheinbare Fall: der Zwischenspeicher haelt
 * eine Antwort nach dem Schliessen noch Minuten im Speicher, und am
 * Terminal steht nach dem Gast der Naechste vor demselben Browser. Deshalb
 * hier eigener Zustand, der mit der Komponente verschwindet.
 *
 * **Staatsangehoerigkeit zuerst.** Von ihr haengt ab, ob nach einem
 * Reisedokument gefragt wird und ob eine Unterschrift faellig ist; erst
 * wenn sie gewaehlt ist, erscheint der Rest. Ein Gast soll nicht ein
 * Passfeld sehen, das ihn nichts angeht.
 */

export type CheckinModus = 'mail' | 'terminal'

/**
 * Steht die Gastseite in der Adresse?
 *
 * Wie `zugangAusAdresse()`: Pfad und Fragment kommen als Parameter, damit
 * sich die Auswertung ohne Browser pruefen laesst. Null heisst: nicht diese
 * Seite, die Anwendung laeuft normal weiter. Das Token steht im **Fragment**
 * (`/checkin#...`), damit es nie einen Server oder dessen Protokoll erreicht.
 */
export function checkinAusAdresse(
  pathname: string = location.pathname, hash: string = location.hash
): { token: string | null } | null {
  if (pathname.replace(/\/+$/, '') !== CHECKIN_PATH) return null
  return { token: checkinTokenAusFragment(hash) }
}

/**
 * Die Sprache, mit der die Seite beginnt.
 *
 * Die des Browsers, wenn wir sie anbieten; sonst Englisch und nicht
 * Deutsch: wer hier mit einem niederlaendischen Browser ankommt, liest
 * eher Englisch als Deutsch. Am Terminal ist der Browser der des Hauses,
 * dort zaehlt die Sprache am Gastprofil.
 */
function startSprache(browser: string, profil?: string): Locale {
  const angeboten = (l: string): l is Locale => (LOCALES as readonly string[]).includes(l)
  if (profil !== undefined && angeboten(profil)) return profil
  const b = browser.slice(0, 2).toLowerCase()
  return angeboten(b) ? b : 'en'
}

/** Nach so langer Stille gibt das Terminal die Seite frei. */
const TERMINAL_RUHE_MS = 3 * 60_000
/** So lange steht der Dank am Terminal, bevor es von selbst weitergeht. */
const TERMINAL_DANK_MS = 20_000

export function GastCheckin({ token, modus, onFertig }: {
  token: string
  modus: CheckinModus
  /** Am Terminal: nach dem Dank, nach Stille, und beim Druck auf "Fertig". */
  onFertig?: () => void
}): JSX.Element {
  const [locale, setLocale] = useState<Locale>(() => startSprache(navigator.language))
  const [view, setView] = useState<CheckinFormView | null>(null)
  const [ladefehler, setLadefehler] = useState<unknown>(null)
  const [ergebnis, setErgebnis] = useState<CheckinSubmitted['state'] | null>(null)
  const sprachGesetzt = useRef(false)

  useEffect(() => {
    let aktiv = true
    setView(null); setLadefehler(null); setErgebnis(null)
    api.get<CheckinFormView>('/v1/checkin/form', { [CHECKIN_TOKEN_HEADER]: token })
      .then(v => {
        if (!aktiv) return
        setView(v)
        if (modus === 'terminal' && !sprachGesetzt.current) {
          setLocale(startSprache('de', v.language))
        }
      })
      .catch((e: unknown) => { if (aktiv) setLadefehler(e) })
    return () => { aktiv = false }
  }, [token, modus])

  /*
   * Am Terminal geht die Seite nach Stille von selbst zurueck. Wer mitten im
   * Ausfuellen weggeht, laesst sonst Name und Passnummer fuer den Naechsten
   * auf dem Bildschirm stehen.
   */
  useEffect(() => {
    if (modus !== 'terminal' || onFertig === undefined) return
    let zeit = setTimeout(onFertig, TERMINAL_RUHE_MS)
    const neu = (): void => { clearTimeout(zeit); zeit = setTimeout(onFertig, TERMINAL_RUHE_MS) }
    const arten = ['pointerdown', 'keydown'] as const
    for (const a of arten) window.addEventListener(a, neu)
    return () => {
      clearTimeout(zeit)
      for (const a of arten) window.removeEventListener(a, neu)
    }
  }, [modus, onFertig])

  useEffect(() => {
    if (modus !== 'terminal' || onFertig === undefined || ergebnis === null) return
    const zeit = setTimeout(onFertig, TERMINAL_DANK_MS)
    return () => clearTimeout(zeit)
  }, [modus, onFertig, ergebnis])

  const gross = modus === 'terminal'

  return (
    <I18nContext.Provider value={locale}>
      <div lang={locale}
           className={`mx-auto w-full ${gross ? 'max-w-3xl text-lg' : 'max-w-xl text-sm'}
                       space-y-4`}>
        <Kopf gross={gross} onLocale={l => { sprachGesetzt.current = true; setLocale(l) }} />
        {ladefehler !== null && <Meldung fehler={ladefehler} gross={gross} />}
        {view === null && ladefehler === null && <Laden />}
        {view !== null && ergebnis !== null && (
          <Dank zustand={ergebnis} gross={gross} modus={modus} onFertig={onFertig} />
        )}
        {view !== null && ergebnis === null && view.state === 'done' && (
          <Dank zustand="done" gross={gross} modus={modus} onFertig={onFertig} />
        )}
        {view !== null && ergebnis === null && view.state === 'signatureOnly' && (
          view.signatureAllowed
            ? <NurUnterschrift token={token} view={view} gross={gross}
                               onErledigt={setErgebnis} />
            : <Dank zustand="signatureOnly" gross={gross} modus={modus} onFertig={onFertig} />
        )}
        {view !== null && ergebnis === null && view.state === 'open' && (
          <Formular token={token} view={view} gross={gross} onErledigt={setErgebnis} />
        )}
        {view?.cleaningWaiver != null && (
          <Verzicht token={token} start={view.cleaningWaiver} gross={gross} />
        )}
      </div>
    </I18nContext.Provider>
  )
}

/** Die Seite unter `/checkin`, fuer den Link aus der Mail. */
export function GastCheckinSeite({ token }: { token: string | null }): JSX.Element {
  const [locale] = useState<Locale>(() => startSprache(navigator.language))
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  return (
    <div className="min-h-screen bg-neutral-50 p-4 sm:p-8">
      {token === null
        ? <I18nContext.Provider value={locale}><OhneLink /></I18nContext.Provider>
        : <GastCheckin token={token} modus="mail" />}
    </div>
  )
}

function OhneLink(): JSX.Element {
  const t = useT()
  return (
    <div className="mx-auto max-w-xl rounded-sm border border-neutral-200 bg-white p-6 space-y-2">
      <h1 className="font-semibold">{t('gastCheckin.title')}</h1>
      <p role="alert" className="text-sm text-neutral-700">{t('gastCheckin.noLink')}</p>
    </div>
  )
}

// ------------------------------------------------------------- Bausteine

/**
 * Reinigungsverzicht (0115). Unter dem Meldeschein und nicht davor: wer den
 * Link oeffnet, soll zuerst sehen, was er tun muss, dann was er tun kann.
 * Eigener Zustand wie der Rest der Seite, kein Zwischenspeicher.
 */
function Verzicht({ token, start, gross }: {
  token: string; start: CleaningWaiverView; gross: boolean
}): JSX.Element | null {
  const t = useT()
  const [view, setView] = useState<CleaningWaiverView | null>(start)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<unknown>(null)
  if (view === null) return null
  const setzen = (date: string, waived: boolean): void => {
    setBusy(true); setFehler(null)
    api.post<CleaningWaiverView | null>('/v1/checkin/cleaning-waiver', { date, waived },
      { [CHECKIN_TOKEN_HEADER]: token })
      .then(setView)
      .catch((e: unknown) => setFehler(e))
      .finally(() => setBusy(false))
  }
  return (
    <section className={`rounded-sm border border-neutral-200 bg-white space-y-3
                         ${gross ? 'p-6' : 'p-4'}`}>
      <h2 className={`${gross ? 'text-xl' : 'text-base'} font-semibold`}>
        {t('gastCheckin.waiver.title')}
      </h2>
      <p className="text-neutral-700">
        {t('gastCheckin.waiver.text')}{view.waterGift && <> {t('gastCheckin.waiver.water')}</>}
      </p>
      <p className="font-medium">{t('gastCheckin.waiver.skip')}:</p>
      <VerzichtTage view={view} onSet={setzen} busy={busy} gross={gross} />
      {fehler !== null && <Meldung fehler={fehler} gross={gross} />}
    </section>
  )
}

function Kopf({ gross, onLocale }: { gross: boolean; onLocale: (l: Locale) => void }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <div className="flex items-center gap-3">
      <h1 className={`${gross ? 'text-2xl' : 'text-lg'} font-semibold grow`}>
        {t('gastCheckin.title')}
      </h1>
      {/* Die Sprachen als Knoepfe und nicht als Auswahlliste: am Terminal
          trifft ein Finger einen Knopf sicherer als eine aufklappende Liste. */}
      <div role="group" aria-label={t('gastCheckin.language')} className="flex gap-1">
        {LOCALES.map(l => (
          <button key={l} type="button" onClick={() => onLocale(l)}
                  aria-pressed={l === locale}
                  className={`${gross ? 'px-4 py-2' : 'px-2 py-0.5'} rounded-sm border uppercase
                    ${l === locale ? 'border-neutral-900 bg-neutral-900 text-white'
                                   : 'border-neutral-300 bg-white'}`}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}

function Laden(): JSX.Element {
  const t = useT()
  return <p className="text-neutral-500">{t('gastCheckin.loading')}</p>
}

function Meldung({ fehler, gross }: { fehler: unknown; gross: boolean }): JSX.Element {
  const locale = useLocale()
  const { text } = fehlerMeldung(fehler, locale)
  return (
    <p role="alert" className={`rounded-sm border border-red-200 bg-red-50 text-red-900
                                ${gross ? 'p-4' : 'p-3'}`}>{text}</p>
  )
}

function Dank({ zustand, gross, modus, onFertig }: {
  zustand: CheckinSubmitted['state']; gross: boolean; modus: CheckinModus
  onFertig?: () => void
}): JSX.Element {
  const t = useT()
  return (
    <div className={`rounded-sm border border-emerald-200 bg-emerald-50 space-y-3
                     ${gross ? 'p-8' : 'p-6'}`}>
      <h2 className={`${gross ? 'text-2xl' : 'text-lg'} font-semibold text-emerald-900`}>
        {t('gastCheckin.done.title')}
      </h2>
      <p className="text-emerald-900">
        {zustand === 'done' ? t('gastCheckin.done.text') : t('gastCheckin.done.signatureLater')}
      </p>
      {modus === 'terminal' && onFertig !== undefined && (
        <button type="button" onClick={onFertig}
                className="px-8 py-4 text-xl rounded-sm bg-neutral-900 text-white">
          {t('gastCheckin.done.close')}
        </button>
      )}
    </div>
  )
}

/** Ein Land je ISO-Code, in der Sprache des Gastes, alphabetisch. */
function useLaender(): Array<{ code: string; name: string }> {
  const locale = useLocale()
  return useMemo(() => {
    const tag = intlTag(locale)
    let namen: Intl.DisplayNames | null = null
    try { namen = new Intl.DisplayNames([tag], { type: 'region' }) } catch { namen = null }
    return LAENDER.map(code => ({ code, name: namen?.of(code) ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name, tag))
  }, [locale])
}

function Feld({ label, fehler, gross, children }: {
  label: string; fehler?: string; gross: boolean; children: React.ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className={`${gross ? 'text-base' : 'text-xs'} text-neutral-600`}>{label}</span>
      {children}
      {fehler !== undefined && (
        <span className={`${gross ? 'text-base' : 'text-xs'} block text-red-700`}>{fehler}</span>
      )}
    </label>
  )
}

interface Person {
  lastName: string; firstName: string; birthDate: string; nationality: string
  /** Kuerzel des Befreiungsgrunds, leer = kurtaxepflichtig. */
  befreiung: string
  nachweis: string
}
const LEER: Person = { lastName: '', firstName: '', birthDate: '', nationality: '',
                       befreiung: '', nachweis: '' }

/**
 * Die Befreiung, wie die Schnittstelle sie erwartet. Die Nummer nur, wo der
 * Grund danach fragt: ein Feld, das der Gast nicht mehr sieht, soll nichts
 * mitschicken, was er vorher hineingetippt hat.
 */
function befreiungFuer(p: Person, gruende: CheckinFormView['exemptionReasons']
): { taxExemption?: CheckinTaxExemption } {
  const g = gruende.find(x => x.code === p.befreiung)
  if (g === undefined) return {}
  const nr = p.nachweis.trim()
  return { taxExemption: { reason: g.code, ...(g.needsProof && nr !== '' ? { proof: nr } : {}) } }
}

/** Mitreisende ohne die Felder, die nur die Maske braucht. */
function person(p: Person, gruende: CheckinFormView['exemptionReasons']) {
  return { lastName: p.lastName, firstName: p.firstName, birthDate: p.birthDate,
           nationality: p.nationality, ...befreiungFuer(p, gruende) }
}

/** Feldname der Schnittstelle -> Beschriftung, fuer Meldungen an der Stelle. */
function feldFehler(error: unknown, locale: Locale): Map<string, string> {
  const m = new Map<string, string>()
  if (!(error instanceof ApiError)) return m
  for (const [feld, text] of fehlerMeldung(error, locale).felder) {
    if (!m.has(feld)) m.set(feld, text)
  }
  return m
}

/**
 * Der volle Name fuer die Begruessung. Eine Anrede ("Herr", "Frau") kennt
 * StayGrid nicht -- es gibt dafuer kein Feld --, und nur der Vorname klang
 * wie ein "Hallo" ohne Anrede.
 */
function vollerName(view: CheckinFormView): string {
  return [view.firstName, view.lastName].filter(Boolean).join(' ')
}

function Formular({ token, view, gross, onErledigt }: {
  token: string; view: CheckinFormView; gross: boolean
  onErledigt: (s: CheckinSubmitted['state']) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const laender = useLaender()

  const [ich, setIch] = useState<Person>({ ...LEER, lastName: view.lastName,
                                           firstName: view.firstName ?? '' })
  const [strasse, setStrasse] = useState('')
  const [plz, setPlz] = useState('')
  const [ort, setOrt] = useState('')
  const [land, setLand] = useState('')
  const [dokTyp, setDokTyp] = useState<'passport' | 'id_card' | 'other'>('passport')
  const [dokNr, setDokNr] = useState('')
  const [begleiter, setBegleiter] = useState<Person[]>([])
  const [signatur, setSignatur] = useState<string | null>(null)
  const [bedingungenOk, setBedingungenOk] = useState(false)
  const [bestaetigt, setBestaetigt] = useState(false)
  const [gaestekarte, setGaestekarte] = useState(false)
  const [ankunft, setAnkunft] = useState('')
  const [telefon, setTelefon] = useState('')
  const [laeuft, setLaeuft] = useState(false)
  const [fehler, setFehler] = useState<unknown>(null)

  const auslaendisch = ich.nationality !== '' && istAuslaendisch({ nationality: ich.nationality })
  const jemandAuslaendisch = auslaendisch
    || begleiter.some(b => b.nationality !== '' && istAuslaendisch({ nationality: b.nationality }))
  const mitUnterschrift = jemandAuslaendisch && view.signatureAllowed
  const mitBedingungen = view.terms.length > 0
  const bedingungenUnterschrift = view.terms.some(b => b.requiresSignature)
  // Eine Unterschrift fuer beides (Sven, 05.10.2026): am Ende des Formulars,
  // unter dem Meldeschein und den Hausbedingungen.
  const mitFeld = mitUnterschrift || bedingungenUnterschrift
  const bedingungenFertig = !mitBedingungen || bedingungenOk
  // Nur ueber den Mail-Link: am Terminal ist der Gast schon angekommen.
  const mitAnkunft = view.channel === 'mail'
  const felder = feldFehler(fehler, locale)

  /*
   * Am Terminal geht nach der Wahl der Staatsangehoerigkeit das erste leere
   * Feld in Fokus, und damit die Bildschirmtastatur auf. Ohne das stand der
   * Gast vor einer Seite voller Felder ohne Tastatur und wusste nicht, dass
   * er erst eines antippen muss. Nur beim ersten Mal: wer danach das Land
   * aendert, steht schon mitten in den Feldern.
   */
  const formular = useRef<HTMLFormElement | null>(null)
  const landGewaehlt = ich.nationality !== ''
  const schonFokussiert = useRef(false)
  useEffect(() => {
    if (!gross || !landGewaehlt || schonFokussiert.current) return
    schonFokussiert.current = true
    const felder = [...(formular.current?.querySelectorAll<HTMLInputElement>(
      'input:not([type]), input[type="text"]') ?? [])]
    ;(felder.find(f => f.value === '') ?? felder[0])?.focus()
  }, [gross, landGewaehlt])

  const eingabe = `mt-0.5 w-full border rounded-sm bg-white
    ${gross ? 'px-3 py-3 text-lg' : 'px-2 py-1.5 text-sm'}`
  const rahmen = (pfad: string): string =>
    felder.has(pfad) ? 'border-red-400' : 'border-neutral-300'
  const abschnitt = `rounded-sm border border-neutral-200 bg-white space-y-3 ${gross ? 'p-6' : 'p-4'}`

  const absenden = async (): Promise<void> => {
    setFehler(null)
    setLaeuft(true)
    const body: CheckinSubmit = {
      guest: {
        lastName: ich.lastName, firstName: ich.firstName, birthDate: ich.birthDate,
        nationality: ich.nationality,
        address: { line1: strasse, postalCode: plz, city: ort, country: land },
        ...(auslaendisch ? { idDocumentType: dokTyp, idDocumentNumber: dokNr } : {}),
        ...befreiungFuer(ich, view.exemptionReasons)
      },
      ...(begleiter.length > 0
        ? { companions: begleiter.map(b => person(b, view.exemptionReasons)) } : {}),
      ...(mitUnterschrift && signatur !== null ? { signatureSvg: signatur } : {}),
      ...(mitBedingungen && bedingungenOk
        ? { termsAccepted: view.terms.map(b => b.termsRef) } : {}),
      ...(bedingungenUnterschrift && signatur !== null
        ? { termsSignatureSvg: signatur } : {}),
      ...(view.digitalGuestCardOffered && gaestekarte ? { digitalGuestCard: true } : {}),
      ...(mitAnkunft ? { expectedArrival: ankunft } : {}),
      ...(telefon.trim() !== '' ? { phone: telefon } : {}),
      confirmed: true
    }
    try {
      const r = await api.post<CheckinSubmitted>('/v1/checkin/form', body,
        { [CHECKIN_TOKEN_HEADER]: token })
      onErledigt(r.state)
    } catch (e) {
      setFehler(e)
    } finally {
      setLaeuft(false)
    }
  }

  /*
   * Am Terminal tippt der Gast das Datum als Ziffern (`Datumsfeld`); per
   * Mail-Link auf dem eigenen Geraet bleibt das Datumsfeld des Browsers, das
   * dort Kalender und Tastatur des Telefons mitbringt.
   */
  const datum = (wert: string, setzen: (v: string) => void, pfad: string,
                 vervollstaendigen: string): JSX.Element => gross
    ? <Datumsfeld value={wert} onChange={setzen} className={`${eingabe} ${rahmen(pfad)}`} />
    : <input type="date" value={wert} autoComplete={vervollstaendigen}
             onChange={e => setzen(e.target.value)}
             className={`${eingabe} ${rahmen(pfad)}`} />

  const laenderAuswahl = (wert: string, setzen: (v: string) => void, pfad: string,
                          beschriftung: TextKey): JSX.Element => (
    <Feld label={t(beschriftung)} fehler={felder.get(pfad)} gross={gross}>
      <select value={wert} onChange={e => setzen(e.target.value)}
              className={`${eingabe} ${rahmen(pfad)}`}>
        <option value="">{t('gastCheckin.choose')}</option>
        {/* Deutschland zuerst: fuer die meisten Gaeste eines deutschen
            Hauses ist es die Antwort, und sie soll nicht unter "D" stehen. */}
        <option value="DE">{laender.find(l => l.code === 'DE')?.name ?? 'DE'}</option>
        {laender.filter(l => l.code !== 'DE').map(l => (
          <option key={l.code} value={l.code}>{l.name}</option>
        ))}
      </select>
    </Feld>
  )

  /*
   * Je Person, wie im Adminpanel: Mitreisende koennen befreit sein, auch wenn
   * der Hauptgast es nicht ist. Ohne Gruende des Hauses gibt es die Frage
   * nicht -- eine Auswahl mit nur "keine" waere eine Frage ohne Antwort.
   */
  const befreiungAuswahl = (p: Person, setzen: (neu: Partial<Person>) => void,
                            pfad: string): JSX.Element | null => {
    if (view.exemptionReasons.length === 0) return null
    const grund = view.exemptionReasons.find(g => g.code === p.befreiung)
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Feld label={t('gastCheckin.exemption.title')}
              fehler={felder.get(`${pfad}.taxExemption.reason`)} gross={gross}>
          <select value={p.befreiung} onChange={e => setzen({ befreiung: e.target.value })}
                  className={`${eingabe} ${rahmen(`${pfad}.taxExemption.reason`)}`}>
            <option value="">{t('gastCheckin.exemption.none')}</option>
            {view.exemptionReasons.map(g => (
              <option key={g.code} value={g.code}>{g.label}</option>
            ))}
          </select>
        </Feld>
        {grund?.needsProof === true && (
          <Feld label={t('gastCheckin.exemption.proof')}
                fehler={felder.get(`${pfad}.taxExemption.proof`)} gross={gross}>
            <input value={p.nachweis} autoComplete="off" spellCheck={false} maxLength={100}
                   onChange={e => setzen({ nachweis: e.target.value })}
                   className={`${eingabe} ${rahmen(`${pfad}.taxExemption.proof`)}`} />
          </Feld>
        )}
      </div>
    )
  }

  return (
    <form ref={formular} className="space-y-4" noValidate
          onSubmit={e => { e.preventDefault(); void absenden() }}>
      <div className={abschnitt}>
        <p className="font-medium">{t('gastCheckin.welcome', { name: vollerName(view) })}</p>
        <p>{t('gastCheckin.stay', { haus: view.propertyName,
                                     von: formatDate(view.arrival, locale),
                                     bis: formatDate(view.departure, locale) })}</p>
        {/* Am Terminal ist der Gast schon da: "spart Zeit bei der Ankunft"
            stimmt dort nicht mehr (Sven, 05.10.2026). Der Link aus der Mail
            kommt vor der Anreise und behaelt den Satz. */}
        <p className="text-neutral-600">
          {t(view.channel === 'terminal' ? 'gastCheckin.intro' : 'gastCheckin.introBeforeArrival')}
        </p>
      </div>

      <div className={abschnitt}>
        <h2 className="font-semibold">{t('gastCheckin.nationality.title')}</h2>
        {laenderAuswahl(ich.nationality, v => {
          setIch({ ...ich, nationality: v })
          // Die Anschrift liegt meist im selben Land. Vorschlag, kein Zwang.
          if (land === '') setLand(v)
        }, 'guest.nationality', 'gastCheckin.nationality.title')}
        <p className="text-neutral-500">{t('gastCheckin.nationality.hint')}</p>
      </div>

      {ich.nationality !== '' && (
        <>
          <div className={abschnitt}>
            <h2 className="font-semibold">{t('gastCheckin.person.title')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Feld label={t('gastCheckin.lastName')} fehler={felder.get('guest.lastName')} gross={gross}>
                <input value={ich.lastName} autoComplete="family-name"
                       onChange={e => setIch({ ...ich, lastName: e.target.value })}
                       className={`${eingabe} ${rahmen('guest.lastName')}`} />
              </Feld>
              <Feld label={t('gastCheckin.firstName')} fehler={felder.get('guest.firstName')} gross={gross}>
                <input value={ich.firstName} autoComplete="given-name"
                       onChange={e => setIch({ ...ich, firstName: e.target.value })}
                       className={`${eingabe} ${rahmen('guest.firstName')}`} />
              </Feld>
              <Feld label={t('gastCheckin.birthDate')} fehler={felder.get('guest.birthDate')} gross={gross}>
                {datum(ich.birthDate, v => setIch({ ...ich, birthDate: v }), 'guest.birthDate', 'bday')}
              </Feld>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Feld label={t('gastCheckin.street')} fehler={felder.get('guest.address.line1')} gross={gross}>
                <input value={strasse} autoComplete="street-address"
                       onChange={e => setStrasse(e.target.value)}
                       className={`${eingabe} ${rahmen('guest.address.line1')}`} />
              </Feld>
              <Feld label={t('gastCheckin.postalCode')} fehler={felder.get('guest.address.postalCode')} gross={gross}>
                <input value={plz} autoComplete="postal-code"
                       onChange={e => setPlz(e.target.value)}
                       className={`${eingabe} ${rahmen('guest.address.postalCode')}`} />
              </Feld>
              <Feld label={t('gastCheckin.city')} fehler={felder.get('guest.address.city')} gross={gross}>
                <input value={ort} autoComplete="address-level2"
                       onChange={e => setOrt(e.target.value)}
                       className={`${eingabe} ${rahmen('guest.address.city')}`} />
              </Feld>
              {laenderAuswahl(land, setLand, 'guest.address.country', 'gastCheckin.country')}
            </div>
            {befreiungAuswahl(ich, neu => setIch({ ...ich, ...neu }), 'guest')}
            {view.exemptionReasons.length > 0 && (
              <p className="text-neutral-500">{t('gastCheckin.exemption.hint')}</p>
            )}
          </div>

          {auslaendisch && (
            <div className={abschnitt}>
              <h2 className="font-semibold">{t('gastCheckin.document.title')}</h2>
              <p className="text-neutral-600">{t('gastCheckin.document.hint')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Feld label={t('gastCheckin.document.type')} fehler={felder.get('guest.idDocumentType')} gross={gross}>
                  <select value={dokTyp}
                          onChange={e => setDokTyp(e.target.value as typeof dokTyp)}
                          className={`${eingabe} ${rahmen('guest.idDocumentType')}`}>
                    <option value="passport">{t('gastCheckin.document.passport')}</option>
                    <option value="id_card">{t('gastCheckin.document.idCard')}</option>
                    <option value="other">{t('gastCheckin.document.other')}</option>
                  </select>
                </Feld>
                {/* autoComplete="off": eine Passnummer soll der Browser nicht
                    fuer den naechsten Gast am selben Geraet vorschlagen. */}
                <Feld label={t('gastCheckin.document.number')} fehler={felder.get('guest.idDocumentNumber')} gross={gross}>
                  <input value={dokNr} autoComplete="off" spellCheck={false}
                         onChange={e => setDokNr(e.target.value)}
                         className={`${eingabe} ${rahmen('guest.idDocumentNumber')}`} />
                </Feld>
              </div>
            </div>
          )}

          {/* Die Nummer fuer den Aufenthalt (Sven, 10.10.2026): in der Buchung
              steht oft das Festnetz zu Hause. Pflicht auf beiden Wegen:
              gebraucht wird sie gerade, wenn der Gast im Haus ist. */}
          <div className={abschnitt}>
            <h2 className="font-semibold">{t('gastCheckin.phone.title')}</h2>
            <p className="text-neutral-600">{t('gastCheckin.phone.hint')}</p>
            <Feld label={t('gastCheckin.phone.label')}
                  fehler={felder.get('phone')} gross={gross}>
              <input type="tel" inputMode="tel" value={telefon} maxLength={50}
                     autoComplete="tel"
                     placeholder={t('gastCheckin.phone.placeholder')}
                     onChange={e => setTelefon(e.target.value)}
                     className={`${eingabe} ${rahmen('phone')}`} />
            </Feld>
          </div>

          {/* Wie im Formular des Adminpanels: Freitext, denn "zwischen 16 und
              17 Uhr" ist eine bessere Antwort als eine erfundene Minute. */}
          {mitAnkunft && (
            <div className={abschnitt}>
              <h2 className="font-semibold">{t('gastCheckin.arrival.title')}</h2>
              <p className="text-neutral-600">{t('gastCheckin.arrival.hint')}</p>
              <Feld label={t('gastCheckin.arrival.label')} fehler={felder.get('expectedArrival')}
                    gross={gross}>
                <input value={ankunft} maxLength={50} autoComplete="off"
                       placeholder={t('gastCheckin.arrival.placeholder')}
                       onChange={e => setAnkunft(e.target.value)}
                       className={`${eingabe} ${rahmen('expectedArrival')}`} />
              </Feld>
            </div>
          )}

          <div className={abschnitt}>
            <h2 className="font-semibold">{t('gastCheckin.companions.title')}</h2>
            <p className="text-neutral-600">
              {t('gastCheckin.companions.hint', { max: view.maxCompanions })}
            </p>
            {begleiter.map((b, i) => {
              const setzen = (neu: Partial<Person>): void =>
                setBegleiter(begleiter.map((x, j) => j === i ? { ...x, ...neu } : x))
              const pfad = (f: string): string => `companions.${i}.${f}`
              return (
                <fieldset key={i} className="border-t border-neutral-200 pt-3 space-y-2">
                  <div className="flex items-center">
                    <legend className="font-medium grow">
                      {t('gastCheckin.companions.person', { n: i + 1 })}
                    </legend>
                    <button type="button"
                            onClick={() => setBegleiter(begleiter.filter((_, j) => j !== i))}
                            className="text-neutral-500 underline">
                      {t('gastCheckin.companions.remove')}
                    </button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Feld label={t('gastCheckin.lastName')} fehler={felder.get(pfad('lastName'))} gross={gross}>
                      <input value={b.lastName} autoComplete="off"
                             onChange={e => setzen({ lastName: e.target.value })}
                             className={`${eingabe} ${rahmen(pfad('lastName'))}`} />
                    </Feld>
                    <Feld label={t('gastCheckin.firstName')} fehler={felder.get(pfad('firstName'))} gross={gross}>
                      <input value={b.firstName} autoComplete="off"
                             onChange={e => setzen({ firstName: e.target.value })}
                             className={`${eingabe} ${rahmen(pfad('firstName'))}`} />
                    </Feld>
                    <Feld label={t('gastCheckin.birthDate')} fehler={felder.get(pfad('birthDate'))} gross={gross}>
                      {datum(b.birthDate, v => setzen({ birthDate: v }), pfad('birthDate'), 'off')}
                    </Feld>
                    {laenderAuswahl(b.nationality, v => setzen({ nationality: v }),
                      pfad('nationality'), 'gastCheckin.nationality.title')}
                  </div>
                  {befreiungAuswahl(b, setzen, `companions.${i}`)}
                </fieldset>
              )
            })}
            {begleiter.length < view.maxCompanions && (
              <button type="button" onClick={() => setBegleiter([...begleiter, LEER])}
                      className={`${gross ? 'px-5 py-3' : 'px-3 py-1.5'} rounded-sm border
                                  border-neutral-300 bg-white`}>
                + {t('gastCheckin.companions.add')}
              </button>
            )}
          </div>

          {/*
            * Die Hausbedingungen vollstaendig, nicht als Verweis: was der Gast
            * unterschreibt, soll er auf derselben Seite lesen. Sie stehen am
            * Ende des Meldeformulars und werden mit derselben Unterschrift
            * unterschrieben (Sven, 05.10.2026); gespeichert wird sie dennoch
            * je Nachweis getrennt -- der Meldeschein wird nach einem Jahr
            * vernichtet, die Vereinbarung muss laenger halten (routes/terms.ts).
            */}
          {mitBedingungen && (
            <div className={abschnitt}>
              <h2 className="font-semibold">{t('gastCheckin.terms.title')}</h2>
              {view.terms.map(b => (
                <section key={b.termsRef} className="space-y-1">
                  <h3 className="font-medium">{b.title}</h3>
                  {/* Text, kein HTML: was das Haus anlegt, wird nie als Markup gezeigt. */}
                  <p className="whitespace-pre-line text-neutral-700">{b.body}</p>
                </section>
              ))}
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={bedingungenOk}
                       onChange={e => setBedingungenOk(e.target.checked)}
                       className={gross ? 'mt-1 h-6 w-6' : 'mt-0.5'} />
                <span>{t('gastCheckin.terms.accept')}</span>
              </label>
              {felder.has('termsAccepted') && (
                <p className="text-red-700">{felder.get('termsAccepted')}</p>
              )}
            </div>
          )}

          {(mitFeld || jemandAuslaendisch) && (
            <div className={abschnitt}>
              <h2 className="font-semibold">{t('gastCheckin.signature.title')}</h2>
              {mitFeld && (
                <>
                  <p className="text-neutral-600">
                    {t(mitUnterschrift && bedingungenUnterschrift ? 'gastCheckin.signature.both'
                      : mitUnterschrift ? 'gastCheckin.signature.hint'
                      : 'gastCheckin.terms.signatureHint')}
                  </p>
                  <Unterschriftsfeld onChange={setSignatur} gross={gross}
                                     beschriftungLoeschen={t('gastCheckin.signature.clear')} />
                  {felder.has('signatureSvg') && (
                    <p className="text-red-700">{felder.get('signatureSvg')}</p>
                  )}
                  {felder.has('termsSignatureSvg') && (
                    <p className="text-red-700">{felder.get('termsSignatureSvg')}</p>
                  )}
                </>
              )}
              {jemandAuslaendisch && !mitUnterschrift && (
                <p className="text-neutral-600">{t('gastCheckin.signature.later')}</p>
              )}
            </div>
          )}

          <div className={abschnitt}>
            <p className="text-neutral-600">
              {t('gastCheckin.privacy', { haus: view.propertyName })}
            </p>
            {/* Freiwillig und ungefragt aus: AVS verlangt fuer die digitale
                Gaestekarte eine Einwilligung (Migration 0090). */}
            {view.digitalGuestCardOffered && (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={gaestekarte}
                       onChange={e => setGaestekarte(e.target.checked)}
                       className={gross ? 'mt-1 h-6 w-6' : 'mt-0.5'} />
                <span>{t('gastCheckin.digitalGuestCard')}</span>
              </label>
            )}
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={bestaetigt}
                     onChange={e => setBestaetigt(e.target.checked)}
                     className={gross ? 'mt-1 h-6 w-6' : 'mt-0.5'} />
              <span>{t('gastCheckin.confirm')}</span>
            </label>
            {fehler !== null && (
              <div role="alert" className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-900">
                {felder.size > 0 ? t('gastCheckin.fixFields')
                                 : fehlerMeldung(fehler, locale).text}
              </div>
            )}
            <button type="submit"
                    disabled={!bestaetigt || laeuft || (mitFeld && signatur === null)
                              || !bedingungenFertig}
                    className={`${gross ? 'w-full py-4 text-xl' : 'px-4 py-2'} rounded-sm
                                bg-neutral-900 text-white disabled:bg-neutral-300`}>
              {t('gastCheckin.submit')}
            </button>
          </div>
        </>
      )}
    </form>
  )
}

/** Am Terminal: nach Vorab-Erfassung per Link fehlt nur noch die Unterschrift. */
function NurUnterschrift({ token, view, gross, onErledigt }: {
  token: string; view: CheckinFormView; gross: boolean
  onErledigt: (s: CheckinSubmitted['state']) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [signatur, setSignatur] = useState<string | null>(null)
  const [laeuft, setLaeuft] = useState(false)
  const [fehler, setFehler] = useState<unknown>(null)
  return (
    <div className={`rounded-sm border border-neutral-200 bg-white space-y-3 ${gross ? 'p-6' : 'p-4'}`}>
      <p className="font-medium">{t('gastCheckin.welcome', { name: vollerName(view) })}</p>
      <p>{t('gastCheckin.stay', { haus: view.propertyName,
                                   von: formatDate(view.arrival, locale),
                                   bis: formatDate(view.departure, locale) })}</p>
      <h2 className="font-semibold">{t('gastCheckin.signature.title')}</h2>
      <p className="text-neutral-600">{t('gastCheckin.signature.hint')}</p>
      <Unterschriftsfeld onChange={setSignatur} gross={gross}
                         beschriftungLoeschen={t('gastCheckin.signature.clear')} />
      {fehler !== null && (
        <p role="alert" className="text-red-700">{fehlerMeldung(fehler, locale).text}</p>
      )}
      <button type="button" disabled={signatur === null || laeuft}
              onClick={() => {
                setLaeuft(true); setFehler(null)
                api.post<CheckinSubmitted>('/v1/checkin/signature',
                  { signatureSvg: signatur }, { [CHECKIN_TOKEN_HEADER]: token })
                  .then(r => onErledigt(r.state))
                  .catch((e: unknown) => setFehler(e))
                  .finally(() => setLaeuft(false))
              }}
              className={`${gross ? 'w-full py-4 text-xl' : 'px-4 py-2'} rounded-sm
                          bg-neutral-900 text-white disabled:bg-neutral-300`}>
        {t('gastCheckin.submitSignature')}
      </button>
    </div>
  )
}
