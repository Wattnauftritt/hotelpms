import { useEffect, useRef, useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useKalenderSendenStand, useKalenderSenden, useOffeneAenderungen,
         useAenderungenVerwerfen, useKonflikteEntscheiden, type KalenderSenden as Senden,
         type KalenderWerte, type OffenerTag } from '../lib/queries/rates.js'
import { useT, useLocale, formatDate, intlTag, geldFormatierer,
         type Locale } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { addDays } from '../lib/dates.js'
import { Fehler } from './Shell.tsx'

/**
 * Preise an den Channel Manager senden (Migration 0179), nur per Knopf.
 *
 * Wie in RoomCloud gibt es drei Wege: nur die Aenderungen seit dem letzten
 * Senden, den gewaehlten Zeitraum und den ganzen Kalender. **Automatisch
 * geht nichts hinaus** und es gibt kein zeitlich geplantes Senden -- ein
 * getippter Preis soll erst bei den Portalen stehen, wenn jemand es will
 * (Svens Vorgabe). Die beiden grossen Wege fragen vorher nach, weil sie
 * Preise ueberschreiben, die jemand im Channel Manager selbst gesetzt hat.
 */

/** So weit reicht "ganzer Kalender" auf dem Server: heute und 399 Tage. */
const GANZER_KALENDER_TAGE = 400

export function KalenderSenden(
  { propertyId, von, bis }: { propertyId: number; von: string; bis: string }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const stand = useKalenderSendenStand(propertyId)
  const senden = useKalenderSenden(propertyId)

  const push = stand.data?.push ?? null
  const laeuft = push?.status === 'requested'
  // Ist das Senden durch, ist der gesendete Stand neu: die gelben
  // Markierungen im Raster gelten nicht mehr (Migration 0180).
  const qc = useQueryClient()
  const lastSentAt = stand.data?.lastSentAt
  const vorher = useRef(lastSentAt)
  useEffect(() => {
    if (vorher.current !== undefined && lastSentAt !== vorher.current) {
      void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] })
    }
    vorher.current = lastSentAt
  }, [qc, propertyId, lastSentAt])
  const offen = stand.data?.pendingChanges ?? null
  // Ohne ein erfolgreiches Senden gibt es keinen Stand, gegen den
  // "Aenderungen" rechnen koennte; der Server weist es dann ab.
  const ohneBasis = stand.data !== undefined && stand.data.lastSentAt === null
  const gesperrt = !online || laeuft || senden.isPending || stand.data === undefined
  const zeitraumTage = Math.round((Date.parse(bis) - Date.parse(von)) / 86_400_000) + 1

  const fragen = (tage: number): boolean =>
    window.confirm(t('rate.push.confirm', { days: tage }))

  const knopf = 'text-sm px-3 py-1.5 rounded-sm border border-neutral-300 bg-white ' +
                'hover:bg-neutral-50 disabled:opacity-40'

  return (
    <section className="w-full space-y-2 rounded-sm border border-neutral-200 bg-white p-3">
      <div>
        <h2 className="font-medium">{t('rate.push.title')}</h2>
        <p className="text-sm text-neutral-600">{t('rate.push.intro')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Grau ohne erstes Senden: dann gibt es keinen Stand, gegen den
            sich Aenderungen rechnen. Der Grund steht am Knopf. */}
        <button type="button" className={knopf}
                title={ohneBasis ? t('rate.push.never') : undefined}
                disabled={gesperrt || ohneBasis || offen === 0}
                onClick={() => senden.mutate({ mode: 'changes' })}>
          {t('rate.push.changes')}
          {offen !== null && <span className="ms-1 tabular-nums text-neutral-500">({offen})</span>}
        </button>
        <button type="button" className={knopf} disabled={gesperrt}
                onClick={() => {
                  if (fragen(zeitraumTage)) senden.mutate({ mode: 'range', from: von, to: bis })
                }}>
          {t('rate.push.range')}{' '}
          <span className="text-neutral-500">
            ({formatDate(von, locale)} – {formatDate(bis, locale)})
          </span>
        </button>
        <button type="button" className={knopf} disabled={gesperrt}
                onClick={() => { if (fragen(GANZER_KALENDER_TAGE)) senden.mutate({ mode: 'all' }) }}>
          {t('rate.push.all')}
        </button>
      </div>

      {offen !== null && offen > 0 && (
        <OffeneAenderungen propertyId={propertyId} gesperrt={gesperrt} />
      )}

      {senden.isError && <Fehler error={senden.error} />}
      {stand.isError && <Fehler error={stand.error} />}
      {push !== null && push.conflicts !== null && push.conflicts.length > 0 && (
        <Konflikte propertyId={propertyId} push={push} />
      )}
      {stand.data !== undefined && (
        <Zustand push={push} lastSentAt={stand.data.lastSentAt} locale={locale} />
      )}
    </section>
  )
}

/**
 * Woher die Zahl am Knopf kommt, und der Weg, sie loszuwerden, ohne zu
 * senden. Sven, 22.10.2026: "ich weis nicht woher die 21 Aenderungen kommen
 * ... ich moechte diese aber abbrechen koennen" -- in RoomCloud standen
 * inzwischen neuere Preise, und senden haette sie ueberschrieben.
 */
function OffeneAenderungen(
  { propertyId, gesperrt }: { propertyId: number; gesperrt: boolean }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [zeigen, setZeigen] = useState(false)
  const liste = useOffeneAenderungen(propertyId, zeigen)
  const verwerfen = useAenderungenVerwerfen(propertyId)
  const geld = geldFormatierer(locale)
  const preis = (p: number[] | null): string =>
    p === null ? '—' : p.map(c => geld.format(c / 100)).join(' / ')
  const gruppen = liste.data === undefined ? [] : zusammenfassen(liste.data.days)
  const weitere = liste.data === undefined ? 0 : liste.data.total - liste.data.days.length

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" className="text-neutral-700 underline"
                onClick={() => setZeigen(z => !z)}>
          {zeigen ? t('rate.push.hidePending') : t('rate.push.showPending')}
        </button>
        <button type="button" className="text-red-800 underline disabled:opacity-40"
                disabled={gesperrt || verwerfen.isPending}
                onClick={() => {
                  if (window.confirm(t('rate.push.discardConfirm'))) verwerfen.mutate()
                }}>
          {t('rate.push.discard')}
        </button>
      </div>

      {verwerfen.isError && <Fehler error={verwerfen.error} />}
      {verwerfen.isSuccess && (
        <div role="status" className="text-sm text-green-800">
          {t('rate.push.discarded', { prices: verwerfen.data.prices,
                                      restrictions: verwerfen.data.restrictions })}
          {verwerfen.data.remaining > 0 && (
            <div className="text-amber-800">
              {t('rate.push.discardRemaining', { n: verwerfen.data.remaining })}
            </div>
          )}
        </div>
      )}

      {zeigen && liste.isError && <Fehler error={liste.error} />}
      {zeigen && gruppen.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-sm border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-50 text-neutral-600">
              <tr>
                <th className="px-2 py-1 text-start font-normal">{t('rate.plan')}</th>
                <th className="px-2 py-1 text-start font-normal">{t('common.date')}</th>
                <th className="px-2 py-1 text-start font-normal" />
                <th className="px-2 py-1 text-end font-normal">{t('rate.pull.old')}</th>
                <th className="px-2 py-1 text-end font-normal">{t('rate.pull.new')}</th>
              </tr>
            </thead>
            <tbody>
              {gruppen.map(g => (
                <tr key={`${g.ratePlanCode}|${g.von}`} className="border-t border-neutral-100">
                  <td className="px-2 py-1" title={g.ratePlanName}>{g.ratePlanCode}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    {formatDate(g.von, locale)}
                    {g.bis !== g.von && <> – {formatDate(g.bis, locale)}</>}
                  </td>
                  <td className="px-2 py-1 text-neutral-600">
                    {[g.price && t('rate.push.kindPrice'),
                      g.restriction && t('rate.push.kindRestriction'),
                      g.neverSent && t('rate.push.neverSent')].filter(Boolean).join(', ')}
                  </td>
                  <td className="px-2 py-1 text-end tabular-nums text-neutral-500">
                    {g.price && !g.neverSent && preis(g.sentPriceCent)}
                  </td>
                  <td className="px-2 py-1 text-end tabular-nums">
                    {g.price && preis(g.priceCent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {weitere > 0 && (
            <div className="px-2 py-1 text-neutral-500">{t('rate.pull.more', { n: weitere })}</div>
          )}
        </div>
      )}
    </div>
  )
}

interface Gruppe extends OffenerTag { von: string; bis: string }

/**
 * Aufeinanderfolgende Tage desselben Plans mit derselben Abweichung als
 * eine Zeile: "DZ-STD, 23.11.–25.11.2027, noch nie gesendet" liest sich,
 * drei Zeilen mit je einem Tag nicht.
 */
export function zusammenfassen(tage: readonly OffenerTag[]): Gruppe[] {
  const gleich = (a: OffenerTag, b: OffenerTag): boolean =>
    a.price === b.price && a.restriction === b.restriction && a.neverSent === b.neverSent
    && JSON.stringify(a.priceCent) === JSON.stringify(b.priceCent)
    && JSON.stringify(a.sentPriceCent) === JSON.stringify(b.sentPriceCent)
  const offen = new Map<string, Gruppe>()
  const alle: Gruppe[] = []
  for (const d of [...tage].sort((a, b) => a.ratePlanCode.localeCompare(b.ratePlanCode)
                                          || a.date.localeCompare(b.date))) {
    const g = offen.get(d.ratePlanCode)
    if (g !== undefined && gleich(g, d) && addDays(g.bis, 1) === d.date) {
      g.bis = d.date
      continue
    }
    const neu = { ...d, von: d.date, bis: d.date }
    offen.set(d.ratePlanCode, neu)
    alle.push(neu)
  }
  return alle.sort((a, b) => a.von.localeCompare(b.von) || a.ratePlanCode.localeCompare(b.ratePlanCode))
}

/**
 * Im Channel Manager wurde parallel etwas geaendert (Migration 0218).
 *
 * Sven, 27.10.2026: "Das muss staygrid dann pro Tag anzeigen und warnen.
 * Sonst aendern wir veraltete Preise." Je Tag drei Staende -- zuletzt
 * abgeglichen, hier, jetzt drueben -- und die Wahl, welcher gilt.
 * Vorbelegt ist nichts: eine Vorauswahl wuerde durchgeklickt, und genau
 * gegen das stille Ueberschreiben steht diese Pruefung.
 */
function Konflikte(
  { propertyId, push }: { propertyId: number; push: Senden }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const entscheiden = useKonflikteEntscheiden(propertyId)
  const konflikte = push.conflicts ?? []
  const [wahl, setWahl] = useState<Record<string, 'mine' | 'channel'>>({})
  const geld = geldFormatierer(locale)
  const schluessel = (k: { ratePlanCode: string; date: string }): string =>
    `${k.ratePlanCode}|${k.date}`
  const alle = (take: 'mine' | 'channel'): void =>
    setWahl(Object.fromEntries(konflikte.map(k => [schluessel(k), take])))
  const fertig = konflikte.every(k => wahl[schluessel(k)] !== undefined)

  /** Ein Stand in einer Zeile; nur, was gesetzt ist. */
  const zeigen = (w: Partial<KalenderWerte> | null): string => {
    if (w === null) return t('rate.push.neverSent')
    const teile: string[] = []
    if (w.priceCent != null) teile.push(w.priceCent.map(c => geld.format(c / 100)).join(' / '))
    if (w.minLos != null) teile.push(`${t('rate.minLos')} ${w.minLos}`)
    if (w.maxLos != null) teile.push(`${t('rate.maxLos')} ${w.maxLos}`)
    if (w.closed === true) teile.push(t('rate.closed'))
    if (w.closedToArrival === true) teile.push(t('rate.cta'))
    if (w.closedToDeparture === true) teile.push(t('rate.ctd'))
    return teile.length === 0 ? '—' : teile.join(' · ')
  }
  const auswahl = 'rounded-sm border px-2 py-0.5 text-xs'

  return (
    <div className="space-y-2 rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm"
         role="alert">
      <div>
        <div className="font-medium text-amber-900">{t('rate.push.conflictTitle')}</div>
        <p className="text-amber-900">{t('rate.push.conflictIntro', { n: konflikte.length })}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="underline" onClick={() => alle('channel')}>
          {t('rate.push.allChannel')}
        </button>
        <button type="button" className="underline" onClick={() => alle('mine')}>
          {t('rate.push.allMine')}
        </button>
      </div>
      <div className="max-h-96 overflow-auto rounded-sm border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-neutral-50 text-neutral-600">
            <tr>
              <th className="px-2 py-1 text-start font-normal">{t('rate.plan')}</th>
              <th className="px-2 py-1 text-start font-normal">{t('common.date')}</th>
              <th className="px-2 py-1 text-start font-normal">{t('rate.push.colSent')}</th>
              <th className="px-2 py-1 text-start font-normal">{t('rate.push.colMine')}</th>
              <th className="px-2 py-1 text-start font-normal">{t('rate.push.colChannel')}</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {konflikte.map(k => {
              const w = wahl[schluessel(k)]
              const setzen = (take: 'mine' | 'channel'): void =>
                setWahl(v => ({ ...v, [schluessel(k)]: take }))
              return (
                <tr key={schluessel(k)} className="border-t border-neutral-100 align-top">
                  <td className="px-2 py-1">{k.ratePlanCode}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{formatDate(k.date, locale)}</td>
                  <td className="px-2 py-1 tabular-nums text-neutral-500">{zeigen(k.sent)}</td>
                  <td className="px-2 py-1 tabular-nums">{zeigen(k.local)}</td>
                  <td className="px-2 py-1 tabular-nums font-medium text-amber-900">
                    {zeigen(k.channel)}
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex gap-1">
                      <button type="button" aria-pressed={w === 'channel'}
                              className={`${auswahl} ${w === 'channel'
                                ? 'border-neutral-900 bg-neutral-900 text-white'
                                : 'border-neutral-300 bg-white'}`}
                              onClick={() => setzen('channel')}>
                        {t('rate.push.takeChannel')}
                      </button>
                      <button type="button" aria-pressed={w === 'mine'}
                              className={`${auswahl} ${w === 'mine'
                                ? 'border-neutral-900 bg-neutral-900 text-white'
                                : 'border-neutral-300 bg-white'}`}
                              onClick={() => setzen('mine')}>
                        {t('rate.push.takeMine')}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {entscheiden.isError && <Fehler error={entscheiden.error} />}
      <button type="button"
              disabled={!online || !fertig || entscheiden.isPending}
              onClick={() => entscheiden.mutate({
                pushRef: push.pushRef,
                decisions: konflikte.map(k => ({ ratePlanCode: k.ratePlanCode, date: k.date,
                                                 take: wahl[schluessel(k)]! })) })}
              className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('rate.push.resolve')}
      </button>
    </div>
  )
}

function Zustand(
  { push, lastSentAt, locale }: { push: Senden | null; lastSentAt: string | null; locale: Locale }
): JSX.Element {
  const t = useT()
  const zuletzt = (
    <div className="text-xs text-neutral-500">
      {lastSentAt === null
        ? t('rate.push.never')
        : t('rate.push.last', { at: zeitpunkt(lastSentAt, locale) })}
    </div>
  )
  if (push?.status === 'requested') {
    return <div className="text-sm" role="status">{t('rate.push.waiting')}{zuletzt}</div>
  }
  if (push?.status === 'failed') {
    return (
      <div className="text-sm text-red-800" role="alert">
        {t('rate.push.failed')}{push.message !== null && <> {push.message}</>}{zuletzt}
      </div>
    )
  }
  if (push?.status === 'done') {
    return (
      <div className="text-sm text-green-800" role="status">
        {t('rate.push.done', { days: push.days ?? 0 })}{zuletzt}
      </div>
    )
  }
  return zuletzt
}

/** Das Senden ist ein Zeitpunkt, anders als ein Aufenthaltstag. */
function zeitpunkt(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(intlTag(locale),
    { dateStyle: 'short', timeStyle: 'short' })
}
