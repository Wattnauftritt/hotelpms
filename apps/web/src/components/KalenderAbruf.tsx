import { useState, type JSX } from 'react'
import { useKalenderAbruf, useKalenderAnfordern, useKalenderUebernehmen,
         MAX_RASTER_TAGE, type KalenderAbruf as Abruf } from '../lib/queries/rates.js'
import { useT, useLocale, formatDate, geldFormatierer } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today, addDays } from '../lib/dates.js'
import { Fehler } from './Shell.tsx'

/**
 * Preiskalender aus dem Channel Manager abrufen (Migration 0179).
 *
 * StayGrid fragt das Umsystem, das Umsystem holt bei RoomCloud und liefert,
 * und erst hier entscheidet ein Mensch. Die Vorschau zeigt, was sich
 * gegenueber dem stehenden Preis aendert, nicht die ganze Lieferung: ein
 * Jahr mal zehn Plaene liest niemand, die dreissig Tage, an denen etwas
 * anders ist, schon.
 *
 * **Offen bleibt, was offen ist.** Wartet ein Abruf oder liegt eine
 * Vorschau bereit, steht der Abschnitt aufgeklappt da, auch nach einem
 * Neuladen -- sonst laege eine Lieferung unbemerkt herum, bis jemand
 * zufaellig auf den Knopf drueckt.
 */

/** So lange gilt Warten als normal; danach die Frage, ob das Umsystem laeuft. */
const GEDULD_MS = 2 * 60_000

export function KalenderAbruf({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const stand = useKalenderAbruf(propertyId)
  const anfordern = useKalenderAnfordern(propertyId)
  const [offen, setOffen] = useState(false)
  const [von, setVon] = useState(today())
  const [bis, setBis] = useState(addDays(today(), 364))

  const pull = stand.data?.pull ?? null
  const laeuft = pull?.status === 'requested' || pull?.status === 'delivered'
  const zeigen = offen || laeuft

  if (!zeigen) {
    return (
      <button type="button" onClick={() => setOffen(true)}
              className="text-sm px-3 py-1.5 rounded-sm border border-neutral-300 bg-white">
        {t('rate.pull.open')}
      </button>
    )
  }

  const tage = Math.round((Date.parse(bis) - Date.parse(von)) / 86_400_000) + 1
  const bereit = von !== '' && bis !== '' && tage >= 1 && tage <= MAX_RASTER_TAGE

  return (
    <section className="w-full space-y-3 rounded-sm border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grow">
          <h2 className="font-medium">{t('rate.pull.open')}</h2>
          <p className="text-sm text-neutral-600">{t('rate.pull.intro')}</p>
        </div>
        {!laeuft && (
          <button type="button" onClick={() => setOffen(false)}
                  className="text-sm text-neutral-600 underline">
            {t('common.close')}
          </button>
        )}
      </div>

      <form className="flex flex-wrap items-end gap-3"
            onSubmit={e => {
              e.preventDefault()
              if (bereit) anfordern.mutate({ from: von, to: bis })
            }}>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.from')}</div>
          <input type="date" value={von} max={bis} onChange={e => setVon(e.target.value)}
                 className="border border-neutral-300 rounded-sm px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.to')}</div>
          <input type="date" value={bis} min={von}
                 max={von === '' ? undefined : addDays(von, MAX_RASTER_TAGE - 1)}
                 onChange={e => setBis(e.target.value)}
                 className="border border-neutral-300 rounded-sm px-2 py-1" />
        </label>
        <button type="submit"
                disabled={!online || !bereit || anfordern.isPending || pull?.status === 'requested'}
                className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('rate.pull.start')}
        </button>
      </form>
      {/* Ein grauer Knopf ohne Grund sah aus wie gesperrt durch offene
          Aenderungen (22.10.2026); der Grund war ein Bis zwei Jahre weiter. */}
      {von !== '' && bis !== '' && tage > MAX_RASTER_TAGE && (
        <div className="text-sm text-amber-800">
          {t('rate.pull.tooLong', { max: MAX_RASTER_TAGE })}
        </div>
      )}
      {anfordern.isError && <Fehler error={anfordern.error} />}
      {stand.isError && <Fehler error={stand.error} />}

      {pull !== null && (
        <Stand propertyId={propertyId} pull={pull} vorschau={stand.data?.preview ?? null}
               onUebernehmen={() => setOffen(true)} />
      )}
    </section>
  )
}

function Stand(
  { propertyId, pull, vorschau, onUebernehmen }: {
    propertyId: number; pull: Abruf
    /** Haelt den Abschnitt offen, damit das Ergebnis nach dem Klick stehen bleibt. */
    onUebernehmen: () => void
    vorschau: NonNullable<ReturnType<typeof useKalenderAbruf>['data']>['preview'] }
): JSX.Element | null {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const uebernehmen = useKalenderUebernehmen(propertyId)
  const geld = geldFormatierer(locale)
  const zeitraum = `${formatDate(pull.from, locale)} – ${formatDate(pull.to, locale)}`

  if (pull.status === 'superseded') return null

  if (pull.status === 'requested') {
    const lange = Date.now() - Date.parse(pull.requestedAt) > GEDULD_MS
    return (
      <div className="text-sm" role="status">
        <div>{t('rate.pull.waiting')} <span className="text-neutral-500">({zeitraum})</span></div>
        {lange && <div className="text-amber-800">{t('rate.pull.slow')}</div>}
      </div>
    )
  }

  if (pull.status === 'failed') {
    return (
      <div className="text-sm text-red-800" role="alert">
        {t('rate.pull.failed')}{pull.message !== null && <> {pull.message}</>}
      </div>
    )
  }

  if (pull.status === 'applied') {
    return (
      <div className="text-sm text-green-800" role="status">
        {t('rate.pull.applied', { prices: pull.result?.prices ?? 0,
                                  restrictions: pull.result?.restrictions ?? 0 })}
        {' '}<span className="text-neutral-500">({zeitraum})</span>
      </div>
    )
  }

  // delivered
  const uebergangen = pull.delivery.filter(d => d.result !== 'accepted')
  const nichts = vorschau !== null && vorschau.priceChanges + vorschau.restrictionChanges === 0
  const preis = (p: number[] | null): string =>
    p === null ? '—' : p.map(c => geld.format(c / 100)).join(' / ')
  const weitere = vorschau === null ? 0
    : vorschau.priceChanges + vorschau.restrictionChanges - vorschau.changes.length

  return (
    <div className="space-y-2 text-sm">
      <div>
        <span className="font-medium">
          {nichts
            ? t('rate.pull.nothing')
            : t('rate.pull.summary', { prices: vorschau?.priceChanges ?? 0,
                                       restrictions: vorschau?.restrictionChanges ?? 0 })}
        </span>{' '}
        <span className="text-neutral-500">({zeitraum})</span>
      </div>

      {uebergangen.length > 0 && (
        <div className="text-amber-800">
          {t('rate.pull.skipped')}:{' '}
          {uebergangen.map(d => `${d.ratePlanCode} (${t(
            `rate.pull.reason.${d.result}` as 'rate.pull.reason.derived')})`).join(', ')}
        </div>
      )}

      {vorschau !== null && vorschau.changes.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-sm border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-50 text-neutral-600">
              <tr>
                <th className="px-2 py-1 text-start font-normal">{t('rate.plan')}</th>
                <th className="px-2 py-1 text-start font-normal">{t('common.date')}</th>
                <th className="px-2 py-1 text-end font-normal">{t('rate.pull.old')}</th>
                <th className="px-2 py-1 text-end font-normal">{t('rate.pull.new')}</th>
              </tr>
            </thead>
            <tbody>
              {vorschau.changes.map(c => (
                <tr key={`${c.ratePlanCode}|${c.date}`} className="border-t border-neutral-100">
                  <td className="px-2 py-1">{c.ratePlanCode}</td>
                  <td className="px-2 py-1">{formatDate(c.date, locale)}</td>
                  <td className="px-2 py-1 text-end tabular-nums text-neutral-500">
                    {c.newPriceCent === null ? '' : preis(c.oldPriceCent)}
                  </td>
                  <td className="px-2 py-1 text-end tabular-nums">
                    {c.newPriceCent !== null && preis(c.newPriceCent)}
                    {c.restrictionChanged && (
                      <div className="text-xs text-neutral-500">{t('rate.pull.restriction')}</div>
                    )}
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

      {uebernehmen.isError && <Fehler error={uebernehmen.error} />}
      {/* Auch ohne Aenderung: die Uebernahme schliesst den Abruf ab, sonst
          stuende die Lieferung bei jedem Oeffnen der Preise wieder da. */}
      <button type="button"
              disabled={!online || uebernehmen.isPending || vorschau === null}
              onClick={() => {
                onUebernehmen()
                uebernehmen.mutate({ pullRef: pull.pullRef, version: pull.version })
              }}
              className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('common.apply')}
      </button>
    </div>
  )
}
