import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KENNWORT_MIN, STAFF_LOCALES, type StaffLocale } from '@hotelpms/contracts'
import { api, ApiError } from '../lib/api.js'
import { useInstallation } from '../lib/pwa.js'
import { nurPersonal, personalSeite } from './adresse.js'
import { SpracheContext, SPRACHNAME, fehlerText, startSprache, usePT }
  from './texte.js'
import { FELD, Fehler, KNOPF, KNOPF_LEISE, Karte } from './teile.js'
import { MeineZimmer } from './MeineZimmer.js'
import { Kontrolle } from './Kontrolle.js'
import { Kueche } from './Kueche.js'

/**
 * Die Personal-App (Baustein 1b, Aufgabe 18 in Dokument 16).
 *
 * Fuer das Telefon gebaut, nicht fuer den Tresen: eine Spalte, grosse
 * Flaechen zum Tippen, unten die Reiter in Daumenreichweite. Sie spricht
 * die vier Sprachen des Personals (`STAFF_LOCALES`) und haelt nichts fest,
 * was ueber das Abmelden hinaus bliebe -- keinen Browserspeicher, keinen
 * Zwischenspeicher der Schnittstelle (der Service Worker laesst `/v1/`
 * ohnehin vorbei). Das Telefon gehoert nicht dem Haus.
 */

interface Me {
  userId: number
  displayName: string
  username: string | null
  locale: string | null
  properties: Array<{ id: number; name: string; permissions: string[] }>
}

/** Vor der Anmeldung: eine Spalte mittig, mit Sprachwahl darueber. */
function Vorraum({ locale, onLocale, children }: {
  locale: StaffLocale; onLocale: (l: StaffLocale) => void; children: React.ReactNode
}): JSX.Element {
  const t = usePT()
  return <div className="min-h-dvh bg-neutral-50 px-4 py-8">
    <div className="mx-auto max-w-sm space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t('app.title')}</h1>
        <SprachWahl locale={locale} onLocale={onLocale} knapp />
      </div>
      {children}
    </div>
  </div>
}

function SprachWahl({ locale, onLocale, knapp = false }: {
  locale: StaffLocale; onLocale: (l: StaffLocale) => void; knapp?: boolean
}): JSX.Element {
  if (knapp) {
    return <select value={locale} aria-label="Sprache / Language / Язык / Мова"
                   onChange={e => onLocale(e.target.value as StaffLocale)}
                   className="border border-neutral-300 rounded-md px-2 py-1.5 text-sm bg-white">
      {STAFF_LOCALES.map(l => <option key={l} value={l}>{SPRACHNAME[l]}</option>)}
    </select>
  }
  return <div className="grid grid-cols-2 gap-2">
    {STAFF_LOCALES.map(l => (
      <button key={l} type="button" aria-pressed={l === locale}
              onClick={() => onLocale(l)}
              className={`py-3 rounded-md border text-base
                ${l === locale ? 'border-neutral-900 bg-neutral-900 text-white'
                               : 'border-neutral-300 bg-white active:bg-neutral-100'}`}>
        {SPRACHNAME[l]}
      </button>
    ))}
  </div>
}

function Anmelden({ locale, onDone }: {
  locale: StaffLocale; onDone: () => void
}): JSX.Element {
  const t = usePT()
  const [name, setName] = useState('')
  const [kennwort, setKennwort] = useState('')
  const [fehler, setFehler] = useState<string | null>(null)
  const [laeuft, setLaeuft] = useState(false)
  return <Karte titel={t('login.title')}>
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault()
      setFehler(null)
      setLaeuft(true)
      try {
        await api.post('/v1/auth/login', { login: name.trim(), password: kennwort })
        onDone()
      } catch (err) {
        setFehler(fehlerText(err, locale))
      } finally {
        setLaeuft(false)
      }
    }}>
      <label className="block">
        <span className="block text-sm text-neutral-600">{t('login.name')}</span>
        <input type="text" required autoComplete="username" autoCapitalize="none"
               spellCheck={false} value={name} onChange={e => setName(e.target.value)}
               className={FELD} />
      </label>
      <label className="block">
        <span className="block text-sm text-neutral-600">{t('login.password')}</span>
        <input type="password" required autoComplete="current-password" value={kennwort}
               onChange={e => setKennwort(e.target.value)} className={FELD} />
      </label>
      {fehler !== null && <Fehler text={fehler} />}
      <button type="submit" disabled={laeuft} className={KNOPF}>
        {t(laeuft ? 'app.loading' : 'login.submit')}
      </button>
      <p className="text-sm text-neutral-500">{t('login.forgot')}</p>
    </form>
  </Karte>
}

/**
 * Kennwort setzen aus dem Link der Rezeption -- Einladung wie Ruecksetzung.
 * Dieselbe Schnittstelle wie `routes/Zugang.tsx`; eine eigene Seite nur,
 * weil sie in den Sprachen des Personals und am Telefon stehen muss.
 */
function KennwortSetzen({ art, token, locale }: {
  art: 'einladung' | 'kennwort'; token: string | null; locale: StaffLocale
}): JSX.Element {
  const t = usePT()
  const [kennwort, setKennwort] = useState('')
  const [wieder, setWieder] = useState('')
  const [laeuft, setLaeuft] = useState(false)
  const [fertig, setFertig] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  // Ohne Token in der Adresse, damit es nicht in der Geschichte stehen bleibt.
  const zurAnmeldung = (): void => { location.replace('/personal') }
  const titel = t(art === 'einladung' ? 'set.inviteTitle' : 'set.resetTitle')

  if (token === null || fertig) {
    return <Karte titel={titel}>
      <p className="text-base">{t(fertig ? 'set.done' : 'set.noToken')}</p>
      <button type="button" className={KNOPF} onClick={zurAnmeldung}>
        {t('set.toLogin')}
      </button>
    </Karte>
  }
  // Die Wiederholung prueft nur die Oberflaeche: die Schnittstelle kennt ein
  // Kennwort. Ein Tippfehler fiele sonst erst beim Anmelden auf, und dann
  // ist der Link verbraucht.
  const passtNicht = wieder.length > 0 && kennwort !== wieder
  return <Karte titel={titel}>
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault()
      setFehler(null)
      setLaeuft(true)
      try {
        await api.post('/v1/auth/password-reset/confirm', { token, password: kennwort })
        setFertig(true)
      } catch (err) {
        setFehler(fehlerText(err, locale))
      } finally {
        setLaeuft(false)
      }
    }}>
      {art === 'einladung' && <p className="text-base">{t('set.inviteHint')}</p>}
      <label className="block">
        <span className="block text-sm text-neutral-600">{t('set.password')}</span>
        <input type="password" required autoComplete="new-password"
               minLength={KENNWORT_MIN} value={kennwort}
               onChange={e => setKennwort(e.target.value)} className={FELD} />
      </label>
      <p className="text-sm text-neutral-500">{t('set.rule', { min: KENNWORT_MIN })}</p>
      <label className="block">
        <span className="block text-sm text-neutral-600">{t('set.repeat')}</span>
        <input type="password" required autoComplete="new-password" value={wieder}
               onChange={e => setWieder(e.target.value)} className={FELD} />
      </label>
      {passtNicht && <Fehler text={t('set.mismatch')} />}
      {fehler !== null && <Fehler text={fehler} />}
      <button type="submit" disabled={laeuft || passtNicht || kennwort.length === 0}
              className={KNOPF}>
        {t(laeuft ? 'app.loading' : 'set.submit')}
      </button>
    </form>
  </Karte>
}

function KennwortAendern({ locale }: { locale: StaffLocale }): JSX.Element {
  const t = usePT()
  const [alt, setAlt] = useState('')
  const [neu, setNeu] = useState('')
  const [laeuft, setLaeuft] = useState(false)
  const [fertig, setFertig] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  return <Karte titel={t('more.password')}>
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault()
      setFehler(null)
      setFertig(false)
      setLaeuft(true)
      try {
        await api.post('/v1/auth/password', { currentPassword: alt, newPassword: neu })
        setAlt('')
        setNeu('')
        setFertig(true)
      } catch (err) {
        setFehler(fehlerText(err, locale))
      } finally {
        setLaeuft(false)
      }
    }}>
      <label className="block">
        <span className="block text-sm text-neutral-600">{t('more.current')}</span>
        <input type="password" required autoComplete="current-password" value={alt}
               onChange={e => setAlt(e.target.value)} className={FELD} />
      </label>
      <label className="block">
        <span className="block text-sm text-neutral-600">{t('more.new')}</span>
        <input type="password" required autoComplete="new-password"
               minLength={KENNWORT_MIN} value={neu}
               onChange={e => setNeu(e.target.value)} className={FELD} />
      </label>
      <p className="text-sm text-neutral-500">{t('set.rule', { min: KENNWORT_MIN })}</p>
      {fehler !== null && <Fehler text={fehler} />}
      {fertig && <p role="status" className="text-sm text-green-800">{t('more.passwordSaved')}</p>}
      <button type="submit" disabled={laeuft} className={KNOPF_LEISE}>
        {t(laeuft ? 'app.loading' : 'more.password')}
      </button>
    </form>
  </Karte>
}

/**
 * Safari auf iPhone und iPad bietet das Installieren nicht an, das eine
 * Seite abfangen koennte; dort hilft nur der Satz, wo der Weg ist. Steht
 * die App schon auf dem Startbildschirm, ist beides ueberfluessig.
 */
function Installieren(): JSX.Element | null {
  const t = usePT()
  const installieren = useInstallation()
  const installiert = window.matchMedia('(display-mode: standalone)').matches
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  if (installiert) return null
  if (installieren !== null) {
    return <button type="button" className={KNOPF_LEISE} onClick={installieren}>
      {t('more.install')}
    </button>
  }
  if (ios) return <p className="text-sm text-neutral-600">{t('more.installIos')}</p>
  return null
}

/**
 * Abmelden mit Neuaufbau, aus demselben Grund wie in der Rezeption
 * (`main.tsx`): nur der Neuaufbau laesst garantiert nichts stehen. Auf einem
 * Telefon, das abends jemand anderes in die Hand nimmt, ist das genauso
 * wichtig wie am Tresen.
 */
async function abmelden(): Promise<void> {
  try {
    await api.post('/v1/auth/logout')
  } finally {
    location.replace('/personal')
  }
}

function Start({ me, locale, onLocale }: {
  me: Me; locale: StaffLocale; onLocale: (l: StaffLocale) => void
}): JSX.Element {
  const t = usePT()
  const vorname = me.displayName.split(' ')[0] ?? me.displayName
  // Meist ein Haus. Arbeitet jemand in zweien, waehlt er oben -- die Liste
  // gilt immer fuer ein Haus, wie der Plan der Hausdame.
  const haeuser = me.properties.filter(p => p.permissions.includes('staff:app'))
  const [haus, setHaus] = useState(() => haeuser[0]?.id ?? 0)
  const rechte = haeuser.find(h => h.id === haus)?.permissions ?? []
  // Die Hausdame beginnt mit der Kontrolle, die Kueche mit dem Fruehstueck:
  // Zimmer haben beide selten selbst.
  const kontrolle = rechte.includes('housekeeping:inspect')
  const kueche = rechte.includes('kitchen:breakfast')
  type Reiter = 'heute' | 'kontrolle' | 'kueche' | 'mehr'
  const reiterListe: Reiter[] = ['heute', ...(kontrolle ? ['kontrolle' as const] : []),
    ...(kueche ? ['kueche' as const] : []), 'mehr']
  const [reiter, setReiter] = useState<Reiter>(
    () => kontrolle ? 'kontrolle' : kueche ? 'kueche' : 'heute')
  const hausWahl = haeuser.length > 1 && <label className="block">
    <span className="block text-sm text-neutral-600">{t('today.property')}</span>
    <select value={haus} onChange={e => setHaus(Number(e.target.value))} className={FELD}>
      {haeuser.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
    </select>
  </label>

  return <div className="min-h-dvh bg-neutral-50 flex flex-col">
    <header className="bg-neutral-900 text-white px-4 py-3
                       pt-[max(0.75rem,env(safe-area-inset-top))]">
      <h1 className="text-lg font-semibold">{t('app.title')}</h1>
    </header>
    <main className="flex-1 px-4 py-4 pb-24 space-y-4 max-w-lg w-full mx-auto">
      {reiter === 'heute' && <>
        <p className="text-xl font-semibold">{t('today.hello', { name: vorname })}</p>
        {hausWahl}
        <MeineZimmer key={haus} propertyId={haus} locale={locale} />
      </>}
      {reiter === 'kontrolle' && kontrolle && <>
        {hausWahl}
        <Kontrolle key={haus} propertyId={haus} locale={locale} />
      </>}
      {reiter === 'kueche' && kueche && <>
        {hausWahl}
        <Kueche key={haus} propertyId={haus} locale={locale} />
      </>}
      {reiter === 'mehr' && <>
        <Karte titel={t('more.language')}>
          <SprachWahl locale={locale} onLocale={onLocale} />
        </Karte>
        <KennwortAendern locale={locale} />
        <Karte>
          <p className="text-sm text-neutral-600">
            {t('more.signedInAs', { name: me.username ?? me.displayName })}
          </p>
          <Installieren />
          {/*
            * Wer mehr darf als die Personal-App -- Hausdame, Direktion --,
            * arbeitet auch an der Oberflaeche der Rezeption und wechselt
            * zwischen beiden (Sven, 07.10.2026). Dieselbe Sitzung, ein Link.
            */}
          {!nurPersonal(me.properties) && (
            <a href="/" className={`block text-center ${KNOPF_LEISE}`}>
              {t('more.toReception')}
            </a>
          )}
          <button type="button" className={KNOPF_LEISE} onClick={() => { void abmelden() }}>
            {t('more.logout')}
          </button>
        </Karte>
      </>}
    </main>
    <nav className="fixed bottom-0 inset-x-0 bg-white border-t border-neutral-200
                    grid pb-[env(safe-area-inset-bottom)]"
         style={{ gridTemplateColumns: `repeat(${reiterListe.length}, minmax(0, 1fr))` }}>
      {reiterListe.map(r => (
        <button key={r} type="button" aria-current={r === reiter ? 'page' : undefined}
                onClick={() => setReiter(r)}
                className={`py-4 text-base ${r === reiter
                  ? 'font-semibold text-neutral-900' : 'text-neutral-500'}`}>
          {t(r === 'heute' ? 'tab.today' : r === 'kontrolle' ? 'tab.inspect'
             : r === 'kueche' ? 'tab.kitchen' : 'tab.more')}
        </button>
      ))}
    </nav>
  </div>
}

/** Keine Antwort der Anwendung -- im Gegensatz zu einer Antwort "nein". */
function serverWeg(e: unknown): boolean {
  if (e === null || e === undefined) return false
  return !(e instanceof ApiError) || e.status >= 500
}

export function PersonalApp(): JSX.Element {
  const [seite] = useState(() => personalSeite(location.pathname, location.search))
  const [locale, setLocale] = useState<StaffLocale>(
    () => startSprache(null, navigator.language))
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  const qc = useQueryClient()

  const me = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/v1/auth/me'),
    retry: false,
    enabled: seite.art === 'app',
    refetchInterval: q => serverWeg(q.state.error) ? 15_000 : false
  })

  // Die gespeicherte Sprache gilt, sobald bekannt ist, wer angemeldet ist --
  // auf jedem Telefon dieselbe, nicht die des Geraets.
  const gespeichert = me.data?.locale
  useEffect(() => {
    if (gespeichert !== undefined) {
      setLocale(startSprache(gespeichert, navigator.language))
    }
  }, [gespeichert])

  /*
   * Sprache waehlen: sofort umschalten, im Hintergrund festhalten. Scheitert
   * das Festhalten, bleibt die Wahl fuer diese Sitzung stehen -- an der
   * Sprache haengt nichts, wofuer sich ein Fehlerhinweis lohnte.
   */
  const spracheWaehlen = (l: StaffLocale): void => {
    setLocale(l)
    if (me.data !== undefined) {
      void api.put('/v1/auth/locale', { locale: l })
        .then(() => qc.invalidateQueries({ queryKey: ['me'] }))
        .catch(() => { /* bleibt fuer diese Sitzung */ })
    }
  }

  const rahmen = (inhalt: React.ReactNode): JSX.Element =>
    <SpracheContext.Provider value={locale}>
      <Vorraum locale={locale} onLocale={spracheWaehlen}>{inhalt}</Vorraum>
    </SpracheContext.Provider>

  if (seite.art !== 'app') {
    return rahmen(<KennwortSetzen art={seite.art} token={seite.token} locale={locale} />)
  }

  const unerreichbar = (me.isPending && me.fetchStatus === 'paused')
    || (me.isError && serverWeg(me.error))
  if (unerreichbar) {
    return rahmen(<Hinweis k="app.offline">
      <button type="button" className={KNOPF_LEISE} onClick={() => { void me.refetch() }}>
        <T k="app.retry" />
      </button>
    </Hinweis>)
  }
  if (me.isPending) return rahmen(<Hinweis k="app.loading" />)
  if (me.isError) {
    return rahmen(<Anmelden locale={locale}
                            onDone={() => void qc.invalidateQueries({ queryKey: ['me'] })} />)
  }

  /*
   * Wer angemeldet ist, aber in keinem Haus `staff:app` traegt, sieht hier
   * nichts -- etwa eine Rezeptionskraft, die den Link aufgerufen hat. Sie
   * bekommt den Satz und das Abmelden, nicht eine leere App.
   */
  const darf = me.data.properties.some(p => p.permissions.includes('staff:app'))
  if (!darf) {
    return rahmen(<Hinweis k="app.noAccess">
      <button type="button" className={KNOPF_LEISE} onClick={() => { void abmelden() }}>
        <T k="more.logout" />
      </button>
    </Hinweis>)
  }

  return <SpracheContext.Provider value={locale}>
    <Start me={me.data} locale={locale} onLocale={spracheWaehlen} />
  </SpracheContext.Provider>
}

function T({ k }: { k: Parameters<ReturnType<typeof usePT>>[0] }): JSX.Element {
  return <>{usePT()(k)}</>
}

function Hinweis({ k, children }: {
  k: Parameters<ReturnType<typeof usePT>>[0]; children?: React.ReactNode
}): JSX.Element {
  return <Karte>
    <p className="text-base text-neutral-700"><T k={k} /></p>
    {children}
  </Karte>
}
