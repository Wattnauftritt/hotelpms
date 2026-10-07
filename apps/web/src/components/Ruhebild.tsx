import { useEffect, useState, type ReactNode } from 'react'
import { useT, useLocale } from '../lib/i18n/index.js'
import { Inhaltstext } from './Inhaltstext.tsx'

/** Eine Folie der Diashow, wie `GET /v1/terminal/idle` sie liefert. */
export interface Folie { title: string; body: string; seconds: number; imageRef: string | null }

/**
 * Wohin der Zoom einer Folie laeuft. Abwechselnd, damit nicht jedes Bild
 * gleich in dieselbe Ecke kriecht.
 */
const ZOOMRICHTUNG = ['50% 50%', '20% 30%', '80% 70%', '70% 25%', '30% 75%']

const bildAdresse = (ref: string): string => `/v1/terminal/images/${ref}`

/**
 * Der Ruhezustand des Gaesteterminals: was der Gast sieht, solange die
 * Rezeption nichts geoeffnet hat.
 *
 * Bilder fuellen den ganzen Bildschirm und blenden ueber, Titel und Text
 * stehen unten auf einem Verlauf, der sie auf jedem Foto lesbar haelt. Eine
 * Folie ohne Bild steht auf dem Meeresverlauf des Grundes. Ohne Folien
 * bleibt die Begruessung mit dem Namen des Hauses -- ein Terminal, das
 * gerade aufgestellt ist, sieht damit schon fertig aus.
 *
 * Gezeigt wird nur, was das Haus als Seite angelegt hat (Dokument 31, §6):
 * kein Text aus einem Auftrag, keine fremde Adresse. Die Komponente haelt
 * nichts ausser der Uhrzeit; Folien und Nummer kommen von aussen, und ein
 * Auftrag ersetzt sie sofort.
 */
export function Ruhebild({ folien, nr, haus, kopf }: {
  folien: Folie[]
  /** Die laufende Nummer, ueber die Liste hinaus gezaehlt. */
  nr: number
  haus: string | null
  /** Sprachwahl und Uebungshinweis, oben rechts. */
  kopf: ReactNode
}): JSX.Element {
  const t = useT()
  const n = folien.length
  const jetzt = n === 0 ? undefined : folien[nr % n]
  const vorher = n === 0 || nr === 0 ? undefined : folien[(nr - 1) % n]

  // Die Bilder einmal vorab holen: beim Ueberblenden soll das naechste schon
  // da sein, nicht erst zeilenweise erscheinen.
  useEffect(() => {
    for (const f of folien) if (f.imageRef !== null) new Image().src = bildAdresse(f.imageRef)
  }, [folien])

  return (
    <div className="fixed inset-0 overflow-hidden text-white">
      <Meer />

      {/* Zwei Ebenen: die vorige bleibt stehen, bis die neue sie ganz
          verdeckt. Der Schluessel ist die laufende Nummer, damit die vorige
          ihr DOM-Element behaelt und ihr Zoom nicht zurueckspringt. */}
      {vorher !== undefined && <Hintergrund key={nr - 1} folie={vorher} nr={nr - 1} />}
      {jetzt !== undefined && <Hintergrund key={nr} folie={jetzt} nr={nr} />}

      <div className="relative h-full flex flex-col">
        <header className="flex items-start gap-4 px-10 pt-8">
          <div className="grow">
            <div className="inline-block px-3 py-1 rounded-sm bg-[#e8891c] text-sm font-semibold
                            uppercase tracking-wider shadow">
              {t('kiosk.welcome')}
            </div>
            {haus !== null && n > 0 && (
              <div className="mt-3 font-serif text-3xl drop-shadow-md">{haus}</div>
            )}
          </div>
          <div className="flex flex-col items-end gap-6">
            {kopf}
            {/* Hochkant steht die Uhr oben: unten braucht der Text die
                ganze Breite, neben ihm bliebe er zu schmal. */}
            <Uhr className="hidden portrait:block" />
          </div>
        </header>

        <main className="grow flex items-end px-10 pb-10 gap-10">
          {jetzt === undefined
            ? <Begruessung haus={haus} />
            : (
              <article key={nr} className={`ruhe-text grow max-w-4xl space-y-4
                                            ${jetzt.imageRef === null ? 'self-center' : ''}`}>
                <div className="h-1 w-20 rounded-full bg-[#e8891c]" />
                <h1 className="font-serif text-6xl leading-tight drop-shadow-lg">{jetzt.title}</h1>
                {jetzt.body.trim() !== '' && (
                  <div className={`max-w-3xl text-white/95 drop-shadow
                                   ${jetzt.imageRef === null ? '' : 'line-clamp-6'}`}>
                    <Inhaltstext text={jetzt.body} gross />
                  </div>
                )}
              </article>
            )}
          <Uhr className="portrait:hidden" />
        </main>

        {n > 1 && (
          <div className="flex justify-center gap-2 pb-6" aria-hidden="true">
            {folien.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all duration-700
                ${i === nr % n ? 'w-8 bg-white' : 'w-1.5 bg-white/45'}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Der Grund einer Folie: ihr Bild, abgedunkelt fuer die Schrift -- oder,
 * ohne Bild, das Meer. Auch das blendet ein: sonst bliebe unter einer
 * Textfolie das Foto der vorigen stehen.
 */
function Hintergrund({ folie, nr }: { folie: Folie; nr: number }): JSX.Element {
  if (folie.imageRef === null) {
    return <div className="ruhe-ein absolute inset-0"><Meer /></div>
  }
  return (
    <div className="ruhe-ein absolute inset-0">
      <img src={bildAdresse(folie.imageRef)} alt=""
           className="ruhe-zoom absolute inset-0 w-full h-full object-cover"
           style={{
             transformOrigin: ZOOMRICHTUNG[nr % ZOOMRICHTUNG.length],
             // Etwas laenger als die Folie: der Zoom laeuft noch, waehrend
             // die naechste darueber einblendet.
             ['--ruhe-dauer' as string]: `${folie.seconds + 2}s`
           }} />
      <div className="absolute inset-0 bg-linear-to-t from-black/80 via-transparent via-45% to-black/35" />
    </div>
  )
}

/** Ohne Folien: Begruessung und Hinweis, gross und mittig. */
function Begruessung({ haus }: { haus: string | null }): JSX.Element {
  const t = useT()
  return (
    // Ueber dem ganzen Bildschirm zentriert, nicht neben der Uhr.
    <div className="ruhe-text absolute inset-0 flex flex-col items-center justify-center
                    text-center space-y-6 pointer-events-none">
      <div className="mx-auto h-1 w-24 rounded-full bg-[#e8891c]" />
      <h1 className="font-serif text-7xl drop-shadow-lg">{haus ?? t('kiosk.welcome')}</h1>
      <p className="text-2xl text-white/85">{t('kiosk.idleHint')}</p>
    </div>
  )
}

/** Uhrzeit und Datum, wie in einer Hotelhalle. Die Zeit des Geraets genuegt. */
function Uhr({ className }: { className: string }): JSX.Element {
  const locale = useLocale()
  const [jetzt, setJetzt] = useState(() => new Date())
  useEffect(() => {
    const z = window.setInterval(() => setJetzt(new Date()), 10_000)
    return () => window.clearInterval(z)
  }, [])
  return (
    <div className={`ml-auto shrink-0 text-right drop-shadow-md ${className}`}>
      <div className="text-6xl font-light tabular-nums">
        {new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(jetzt)}
      </div>
      <div className="text-lg text-white/85">
        {new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' })
          .format(jetzt)}
      </div>
    </div>
  )
}

/** Der Meeresverlauf mit zwei ruhigen Wellen: Grund ohne Bild. */
function Meer(): JSX.Element {
  return (
    <div className="absolute inset-0 bg-linear-to-br from-[#0b1d4a] via-[#123f7a] to-[#1b8fb8]">
      <Wellen />
    </div>
  )
}

function Wellen(): JSX.Element {
  return (
    <svg className="absolute inset-x-0 bottom-0 w-full h-1/3 text-white" viewBox="0 0 1440 320"
         preserveAspectRatio="none" aria-hidden="true">
      <path fill="currentColor" fillOpacity="0.06"
            d="M0 192l60-16c60-16 180-48 300-42.7C480 139 600 181 720 192s240-11 360-26.7
               C1200 149 1320 139 1380 133l60-5v192H0z" />
      <path fill="currentColor" fillOpacity="0.08"
            d="M0 256l80-10.7c80-10.3 240-32.3 400-21.3 160 11 320 53 480 53.3 160-.3 320-42.3
               400-64l80-21.3V320H0z" />
    </svg>
  )
}
