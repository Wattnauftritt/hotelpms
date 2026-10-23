import { useRef, useState } from 'react'
import type { JSX } from 'react'
import { useT, useLocale, intlTag, type Locale, type TextKey } from '../lib/i18n/index.js'
import { belegVorbereiten, BelegArtFalsch } from '../lib/kassenbeleg.js'
import type { NeuerAnhang, TicketArt, TicketNachricht, TicketStatus,
              PlattformNachricht } from '../lib/queries/tickets.js'
import { DateiLink } from './DateiLink.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Was die beiden Seiten des Ticketsystems teilen: Zustandsmarke, Faden und
 * Anhangwahl. Eine Fassung, damit der Kunde und der Support denselben Faden
 * gleich lesen -- bis auf die internen Notizen, die nur die Plattform hat.
 */

/** Wie viele Anhaenge je Nachricht, wie gross. Wie in routes/tickets.ts. */
export const ANHAENGE_MAX = 3
export const ANHANG_MB = 5

export const ZUSTAND: Record<TicketStatus, TextKey> = {
  open: 'ticket.state.open',
  waiting_customer: 'ticket.state.waiting_customer',
  closed: 'ticket.state.closed'
}

export const ART: Record<TicketArt, TextKey> = {
  question: 'ticket.cat.question',
  bug: 'ticket.cat.bug',
  wish: 'ticket.cat.wish',
  billing: 'ticket.cat.billing'
}

/*
 * Ein Formatierer je Sprache, gemerkt: dieselbe Zeile steht an jeder
 * Nachricht und jeder Listenzeile (Performanceaudit, Befund 10 in
 * Dokument 24 -- toLocaleString je Zeile baut die Regeln jedes Mal neu).
 */
const zeitFormat = new Map<Locale, Intl.DateTimeFormat>()
export function zeitpunkt(iso: string, locale: Locale): string {
  let f = zeitFormat.get(locale)
  if (f === undefined) {
    f = new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'short', timeStyle: 'short' })
    zeitFormat.set(locale, f)
  }
  return f.format(new Date(iso))
}

export function ZustandMarke({ status, kunde }: { status: TicketStatus; kunde: boolean }
): JSX.Element {
  const t = useT()
  // Beim Kunden ist "Antwort da" das, worauf er schauen soll; beim Support
  // "bei StayGrid". Die Farbe folgt dem, der handeln muss.
  const handeln = kunde ? status === 'waiting_customer' : status === 'open'
  const farbe = status === 'closed'
    ? 'bg-neutral-100 text-neutral-600 border-neutral-300'
    : handeln ? 'bg-blue-50 text-blue-900 border-blue-300'
      : 'bg-white text-neutral-700 border-neutral-300'
  return (
    <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded-sm border ${farbe}`}>
      {t(ZUSTAND[status])}
    </span>
  )
}

export function DringendMarke(): JSX.Element {
  const t = useT()
  return (
    <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-sm border border-red-300
                     bg-red-50 text-red-900">
      {t('ticket.urgentBadge')}
    </span>
  )
}

/**
 * Der Faden. `anhangPfad` sagt, unter welcher Route ein Anhang liegt -- beim
 * Kunden und bei der Plattform sind es verschiedene, mit verschiedenen Rechten.
 */
export function Faden({ nachrichten, anhangPfad }: {
  nachrichten: Array<TicketNachricht | PlattformNachricht>
  anhangPfad: (anhangId: number) => string
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <ol className="space-y-2">
      {nachrichten.map(m => {
        const intern = 'internal' in m && m.internal
        const vonUns = m.side === 'platform'
        return (
          <li key={m.id}
              className={`rounded-sm border p-3 text-sm space-y-1
                          ${intern ? 'border-amber-300 bg-amber-50'
                            : vonUns ? 'border-blue-200 bg-blue-50/50'
                              : 'border-neutral-200 bg-white'}`}>
            <div className="flex flex-wrap items-baseline gap-2 text-xs text-neutral-600">
              <span className="font-medium text-neutral-800">
                {m.authorName ?? t('ticket.supportAuthor')}
              </span>
              <span>{zeitpunkt(m.createdAt, locale)}</span>
              {intern && (
                <span className="px-1 rounded-sm border border-amber-400 text-amber-900">
                  {t('ticket.admin.internalBadge')}
                </span>
              )}
            </div>
            {/* Text eines Menschen, kein HTML: als Text gesetzt, Umbrueche bleiben. */}
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
            {m.attachments.length > 0 && (
              <ul className="flex flex-wrap gap-2 pt-1">
                {m.attachments.map(a => (
                  <li key={a.id}>
                    <DateiLink pfad={anhangPfad(a.id)} name={a.name ?? `anhang-${a.id}`}
                               neuesFenster
                               className="text-xs underline underline-offset-2">
                      📎 {a.name ?? `#${a.id}`}
                    </DateiLink>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Anhaenge waehlen. Fotos werden verkleinert wie die Kassenbelege
 * (`belegVorbereiten`): ein Bildschirmfoto bleibt lesbar und wird einige
 * hundert Kilobyte gross statt mehrerer Megabyte.
 */
export function AnhangWahl({ anhaenge, onAnhaenge }: {
  anhaenge: NeuerAnhang[]
  onAnhaenge: (a: NeuerAnhang[]) => void
}): JSX.Element {
  const t = useT()
  const feld = useRef<HTMLInputElement>(null)
  const [fehler, setFehler] = useState<unknown>(null)
  const [artFalsch, setArtFalsch] = useState(false)
  const voll = anhaenge.length >= ANHAENGE_MAX

  const waehlen = async (dateien: FileList | null): Promise<void> => {
    setFehler(null)
    setArtFalsch(false)
    if (dateien === null) return
    const neu: NeuerAnhang[] = []
    for (const d of [...dateien].slice(0, ANHAENGE_MAX - anhaenge.length)) {
      try {
        neu.push(await belegVorbereiten(d))
      } catch (e) {
        if (e instanceof BelegArtFalsch) setArtFalsch(true)
        else setFehler(e)
      }
    }
    onAnhaenge([...anhaenge, ...neu])
    if (feld.current !== null) feld.current.value = ''
  }

  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={voll} onClick={() => feld.current?.click()}
                className="px-2 py-1 border border-neutral-300 rounded-sm
                           disabled:text-neutral-400">
          {t('ticket.attach')}
        </button>
        <input ref={feld} type="file" multiple hidden
               accept="image/png,image/jpeg,image/webp,image/heic,application/pdf"
               onChange={e => { void waehlen(e.target.files) }} />
        {anhaenge.map((a, i) => (
          <span key={`${a.name}-${i}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-neutral-100 rounded-sm">
            {a.name ?? `#${i + 1}`}
            <button type="button" aria-label={t('common.close')}
                    onClick={() => onAnhaenge(anhaenge.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
      </div>
      <p className="text-xs text-neutral-500">
        {t('ticket.attachHint', { max: ANHAENGE_MAX, mb: ANHANG_MB })}
      </p>
      {artFalsch && <p className="text-xs text-red-800">{t('ticket.attachType')}</p>}
      {fehler !== null && <Fehler error={fehler} />}
    </div>
  )
}
