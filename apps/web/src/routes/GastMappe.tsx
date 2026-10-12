import { useCallback, useEffect, useState, type JSX } from 'react'
import { FOLDER_ROOM_HEADER, SPRACHNAMEN, folderRefAusFragment, wifiQrText,
         type FolderLocale, type FolderWifi, type GuestFolderView } from '@hotelpms/contracts'
import { api, ApiError } from '../lib/api.js'
import { useQr } from '../lib/qr.js'
import { Inhaltstext } from '../components/Inhaltstext.tsx'
import { FOLDER_LOCALES, MappeSprache, startSprache, useMappeT,
         type MappeTextKey } from '../gast/mappeTexte.js'

/**
 * Digitale Gaestemappe: die Seite auf dem Telefon des Gastes (Migration 0143).
 *
 * Geoeffnet ueber den QR-Code der Zimmerkarte, `/mappe#<referenz>`. Die
 * Referenz steht im Fragment und reist in der Kopfzeile, wie das Token des
 * Online-Check-ins. Sie wird nirgends abgelegt: kein `localStorage`, kein
 * Zwischenspeicher -- wer die Seite wieder oeffnen will, scannt die Karte
 * noch einmal oder nimmt den Verlauf seines Browsers.
 *
 * Gezeigt wird, was ohnehin auf der Karte im Zimmer steht oder dort
 * ausliegen koennte: WLAN, Zeiten, die Seiten des Hauses. Den eigenen
 * Aufenthalt sieht erst, wer mit Nachname oder PLZ freigeschaltet hat
 * (0147), und auch dann nur den Abreisetag. Die Freischaltung haelt ein
 * Cookie, das die Seite nie zu sehen bekommt (`httpOnly`).
 */

export function mappeRefAusAdresse(hash: string = location.hash): string | null {
  return folderRefAusFragment(hash)
}

type Laden =
  | { art: 'laedt' }
  | { art: 'da'; view: GuestFolderView }
  | { art: 'fehler'; text: MappeTextKey }

export function GastMappeSeite({ roomRef }: { roomRef: string | null }): JSX.Element {
  const [locale, setLocale] = useState<FolderLocale>(() => startSprache(navigator.language))
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  const [stand, setStand] = useState<Laden>(
    roomRef === null ? { art: 'fehler', text: 'unknown' } : { art: 'laedt' })
  const [versuch, setVersuch] = useState(0)

  useEffect(() => {
    if (roomRef === null) return
    let aktiv = true
    setStand({ art: 'laedt' })
    api.get<GuestFolderView>('/v1/mappe', { [FOLDER_ROOM_HEADER]: roomRef })
      .then(view => { if (aktiv) setStand({ art: 'da', view }) })
      .catch((e: unknown) => {
        if (!aktiv) return
        const text: MappeTextKey = !(e instanceof ApiError) ? 'offline'
          : e.status === 404 ? 'unknown' : e.status === 410 ? 'off' : 'offline'
        setStand({ art: 'fehler', text })
      })
    return () => { aktiv = false }
  }, [roomRef, versuch])

  useEffect(() => {
    if (stand.art === 'da') document.title = stand.view.propertyName
  }, [stand])

  return (
    <MappeSprache.Provider value={locale}>
      <div lang={locale} className="min-h-screen bg-neutral-50 px-4 py-6">
        <div className="mx-auto w-full max-w-xl space-y-4 text-[15px]">
          <Kopf view={stand.art === 'da' ? stand.view : null} locale={locale}
                onLocale={setLocale} />
          {stand.art === 'laedt' && <Hinweis text="loading" />}
          {stand.art === 'fehler' && (
            <Hinweis text={stand.text}
                     onRetry={stand.text === 'offline' ? () => setVersuch(v => v + 1) : undefined} />
          )}
          {stand.art === 'da' && roomRef !== null && (
            <>
              <Aufenthalt view={stand.view} roomRef={roomRef} locale={locale}
                          onChange={stay => setStand({ art: 'da',
                                                      view: { ...stand.view, stay } })} />
              {stand.view.wifi !== null && <Wlan wifi={stand.view.wifi} />}
              <Zeiten view={stand.view} />
              {stand.view.pages.map(s => (
                <Seite key={s.contentRef} seite={s} roomRef={roomRef} locale={locale} />
              ))}
            </>
          )}
        </div>
      </div>
    </MappeSprache.Provider>
  )
}

/**
 * Der eigene Aufenthalt: freischalten, oder Abreisetag und Abmelden.
 *
 * Ein Feld fuer beides, Nachname oder PLZ: zwei Felder hiessen, den Gast
 * entscheiden zu lassen, welches der Meldeschein kennt. Die Schnittstelle
 * versucht beides.
 */
function Aufenthalt({ view, roomRef, locale, onChange }: {
  view: GuestFolderView; roomRef: string; locale: FolderLocale
  onChange: (stay: GuestFolderView['stay']) => void
}): JSX.Element {
  const t = useMappeT()
  const [wert, setWert] = useState('')
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<MappeTextKey | null>(null)
  const kopf = { [FOLDER_ROOM_HEADER]: roomRef }

  const senden = (pfad: string, rumpf: object): void => {
    setBusy(true); setFehler(null)
    api.post<{ stay: GuestFolderView['stay'] }>(pfad, rumpf, kopf)
      .then(r => { setWert(''); onChange(r.stay) })
      .catch((e: unknown) => setFehler(!(e instanceof ApiError) ? 'offline'
        : e.status === 429 ? 'stay.locked' : e.status === 422 ? 'stay.wrong' : 'offline'))
      .finally(() => setBusy(false))
  }

  if (view.stay !== null) {
    return (
      <section className={KARTE} aria-labelledby="mappe-aufenthalt">
        <h2 id="mappe-aufenthalt" className="font-semibold">{t('stay.title')}</h2>
        <p>{t('stay.departure', { date: kalendertag(view.stay.departure, locale) })}</p>
        <button type="button" disabled={busy} onClick={() => senden('/v1/mappe/lock', {})}
                className="text-sm text-neutral-600 underline disabled:opacity-40">
          {t('stay.lock')}
        </button>
      </section>
    )
  }
  return (
    <section className={KARTE} aria-labelledby="mappe-aufenthalt">
      <h2 id="mappe-aufenthalt" className="font-semibold">{t('stay.title')}</h2>
      <p className="text-sm text-neutral-600">{t('stay.hint')}</p>
      <form className="flex gap-2" onSubmit={e => {
        e.preventDefault()
        if (wert.trim() !== '') senden('/v1/mappe/unlock', { value: wert.trim() })
      }}>
        <label className="grow">
          <span className="sr-only">{t('stay.field')}</span>
          <input value={wert} onChange={e => setWert(e.target.value)} maxLength={100}
                 placeholder={t('stay.field')} autoComplete="off" autoCapitalize="words"
                 spellCheck={false}
                 className="w-full rounded-md border border-neutral-300 px-3 py-2" />
        </label>
        <button type="submit" disabled={busy || wert.trim() === ''}
                className="rounded-md bg-neutral-900 px-4 py-2 text-white disabled:opacity-40">
          {t('stay.unlock')}
        </button>
      </form>
      {fehler !== null && <p role="alert" className="text-sm text-red-800">{t(fehler)}</p>}
    </section>
  )
}

/**
 * Ein Kalendertag in der Sprache der Mappe. Ueber UTC und nicht ueber
 * `new Date(iso)` in Ortszeit: sonst rutscht die Abreise auf einem Telefon
 * westlich von Greenwich auf den Vortag (CLAUDE.md, Geld und Datum).
 */
function kalendertag(iso: string, locale: FolderLocale): string {
  const [j, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long',
                                           timeZone: 'UTC' })
    .format(new Date(Date.UTC(j!, m! - 1, d!)))
}

function Kopf({ view, locale, onLocale }: {
  view: GuestFolderView | null; locale: FolderLocale; onLocale: (l: FolderLocale) => void
}): JSX.Element {
  const t = useMappeT()
  return (
    <header className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">{t('title')}</div>
          <h1 className="text-xl font-semibold text-neutral-900">
            {view?.propertyName ?? t('title')}
          </h1>
          {view !== null && (
            <div className="text-sm text-neutral-600">{t('room', { room: view.roomName })}</div>
          )}
        </div>
        <Sprachen locale={locale} onLocale={onLocale} />
      </div>
    </header>
  )
}

const SPRACHNAME: Record<FolderLocale, string> = SPRACHNAMEN

function Sprachen({ locale, onLocale }: {
  locale: FolderLocale; onLocale: (l: FolderLocale) => void
}): JSX.Element {
  const t = useMappeT()
  return (
    <label className="text-xs text-neutral-600 shrink-0">
      <span className="sr-only">{t('language')}</span>
      <select value={locale} onChange={e => onLocale(e.target.value as FolderLocale)}
              className="border border-neutral-300 rounded-sm bg-white px-2 py-1.5 text-sm">
        {FOLDER_LOCALES.map(l => <option key={l} value={l}>{SPRACHNAME[l]}</option>)}
      </select>
    </label>
  )
}

function Hinweis({ text, onRetry }: { text: MappeTextKey; onRetry?: () => void }): JSX.Element {
  const t = useMappeT()
  return (
    <div role={text === 'loading' ? 'status' : 'alert'}
         className="rounded-md border border-neutral-200 bg-white p-4 space-y-3">
      <p className="text-neutral-700">{t(text)}</p>
      {onRetry !== undefined && (
        <button type="button" onClick={onRetry}
                className="px-3 py-2 rounded-md border border-neutral-300 text-sm">
          {t('retry')}
        </button>
      )}
    </div>
  )
}

const KARTE = 'rounded-md border border-neutral-200 bg-white p-4 space-y-3'

function Wlan({ wifi }: { wifi: FolderWifi }): JSX.Element {
  const t = useMappeT()
  const [kopiert, setKopiert] = useState(false)
  const { pfad, groesse } = useQr(wifiQrText(wifi))
  const kopieren = useCallback(async () => {
    if (wifi.password === null) return
    try {
      await navigator.clipboard.writeText(wifi.password)
      setKopiert(true)
      setTimeout(() => setKopiert(false), 2500)
    } catch {
      // Ohne Zwischenablage bleibt das Passwort zum Abschreiben stehen.
    }
  }, [wifi.password])

  return (
    <section className={KARTE} aria-labelledby="mappe-wlan">
      <h2 id="mappe-wlan" className="font-semibold">{t('wifi.title')}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-neutral-500">{t('wifi.network')}</dt>
        <dd className="font-mono break-all">{wifi.ssid}</dd>
        {wifi.password !== null && (
          <>
            <dt className="text-neutral-500">{t('wifi.password')}</dt>
            <dd className="font-mono break-all select-all">{wifi.password}</dd>
          </>
        )}
      </dl>
      {wifi.password === null && <p className="text-sm text-neutral-600">{t('wifi.noPassword')}</p>}
      {wifi.hidden && <p className="text-sm text-neutral-600">{t('wifi.hidden')}</p>}
      {wifi.password !== null && (
        <button type="button" onClick={() => { void kopieren() }}
                className="w-full px-3 py-2.5 rounded-md bg-neutral-900 text-white font-medium">
          {kopiert ? `✓ ${t('wifi.copied')}` : t('wifi.copy')}
        </button>
      )}
      <details className="text-sm text-neutral-600">
        <summary className="cursor-pointer">{t('wifi.qr')}</summary>
        <svg viewBox={`0 0 ${groesse} ${groesse}`} role="img" aria-label={t('wifi.title')}
             className="mt-2 w-44 h-44 bg-white" shapeRendering="crispEdges">
          <path d={pfad} fill="#000" />
        </svg>
      </details>
    </section>
  )
}

function Zeiten({ view }: { view: GuestFolderView }): JSX.Element {
  const t = useMappeT()
  return (
    <section className={KARTE} aria-labelledby="mappe-zeiten">
      <h2 id="mappe-zeiten" className="font-semibold">{t('times.title')}</h2>
      <p>{t('times.checkin', { time: view.checkinTime })}</p>
      <p>{t('times.checkout', { time: view.checkoutTime })}</p>
    </section>
  )
}

/**
 * Eine Seite des Hauses. Text, kein HTML -- im kleinen Format des Terminals
 * (`Inhaltstext`); ein Bild per `fetch` mit der Kopfzeile, weil ein
 * Bild-Element keine schicken kann.
 *
 * In der gewaehlten Sprache, wenn es eine passende Uebersetzung gibt (0144),
 * sonst deutsch -- und dann mit `lang="de"`, damit ein Vorleseprogramm die
 * Seite nicht mit niederlaendischer Aussprache liest.
 */
function Seite({ seite, roomRef, locale }: {
  seite: GuestFolderView['pages'][number]; roomRef: string; locale: FolderLocale
}): JSX.Element {
  const fassung = locale === 'de' ? undefined : seite.translations[locale]
  const titel = fassung?.title ?? seite.title
  const text = fassung?.body ?? seite.body
  const [bild, setBild] = useState<string | null>(null)
  useEffect(() => {
    if (seite.imageRef === null) return
    let aktiv = true
    /*
     * Als data-URL und nicht als `blob:`: die Content-Security-Policy
     * (`ops/caddy/Caddyfile`) erlaubt fuer Bilder `'self' data:`, und eine
     * Ausnahme fuer `blob:` gaelte fuer die ganze Rezeption.
     */
    void fetch(`/v1/mappe/images/${seite.imageRef}`, { headers: { [FOLDER_ROOM_HEADER]: roomRef } })
      .then(async r => {
        if (!r.ok) return
        const b = await r.blob()
        const leser = new FileReader()
        leser.onload = () => { if (aktiv && typeof leser.result === 'string') setBild(leser.result) }
        leser.readAsDataURL(b)
      })
      .catch(() => undefined)
    return () => { aktiv = false }
  }, [seite.imageRef, roomRef])

  return (
    <section className={KARTE} lang={fassung === undefined ? 'de' : locale}>
      <h2 className="font-semibold">{titel}</h2>
      {bild !== null && <img src={bild} alt="" className="w-full rounded-sm object-cover" />}
      {text.trim() !== '' && (
        <div className="text-neutral-800"><Inhaltstext text={text} /></div>
      )}
    </section>
  )
}
