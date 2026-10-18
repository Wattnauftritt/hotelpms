import { useEffect, useRef, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useKalenderSendenStand, useKalenderSenden,
         type KalenderSenden as Senden } from '../lib/queries/rates.js'
import { useT, useLocale, formatDate, intlTag, type Locale } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
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

      {senden.isError && <Fehler error={senden.error} />}
      {stand.isError && <Fehler error={stand.error} />}
      {stand.data !== undefined && (
        <Zustand push={push} lastSentAt={stand.data.lastSentAt} locale={locale} />
      )}
    </section>
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
