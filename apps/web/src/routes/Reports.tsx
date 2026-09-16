import { useState } from 'react'
import type { JSX } from 'react'
import type { KpiTotal, NightAuditDay, NightAuditStatus } from '@hotelpms/contracts'
import { useKpi, useNightAuditStatus, useAccommodationStatistics, useAusgabe }
  from '../lib/queries/reports.js'
import { useHausrechte } from '../lib/rechte.js'
import { useReiter } from '../lib/reiter.js'
import { useT, useLocale, formatMoney, formatDate, intlTag,
         type TextKey, type Locale } from '../lib/i18n/index.js'
import { apiText } from '../lib/meldungen.js'
import { today, addDays } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Berichte: Kennzahlen, Nachtlauf, Beherbergungsstatistik, Ausgaben.
 *
 * **Vier Bereiche, drei Rechte.** Eine Rezeption hat `report:operational`
 * und sieht damit den Nachtlauf-Stand; Umsatz und Ausgaben nicht. Der
 * Bildschirm zeigt deshalb nur die Reiter, die dieses Konto auch bedienen
 * kann -- ein Knopf, der 403 antwortet, ist schlechter als kein Knopf.
 *
 * **Ein Übungshaus gibt nichts nach draußen.** Die Ausgaben und die
 * Beherbergungsstatistik werden dort gar nicht erst angeboten. Die API weist
 * sie ohnehin ab (422); die Maske sagt vorher, warum.
 */

const REITER = ['kpi', 'audit', 'statistics', 'exports'] as const
type Reiter = (typeof REITER)[number]

interface Bereich { key: Reiter; label: TextKey }

/**
 * Welche Bereiche dieses Konto in diesem Haus benutzen kann.
 *
 * Getrennt von der Darstellung, weil hier ein Fehler nicht auffällt: ein
 * zu großzügiger Reiter zeigt sich erst als 403 beim Klicken, ein zu
 * strenger nie.
 */
export function berichtsBereiche(
  darf: (p: string) => boolean, isTraining: boolean
): Bereich[] {
  const bereiche: Bereich[] = []
  if (darf('report:revenue')) bereiche.push({ key: 'kpi', label: 'report.tab.kpi' })
  if (darf('report:operational')) {
    bereiche.push({ key: 'audit', label: 'report.tab.audit' })
  }
  // Statistik und Ausgaben gehen nach draußen: im Übungshaus gibt es sie
  // nicht, gleich welches Recht jemand hat.
  if (!isTraining && darf('report:export')) {
    bereiche.push({ key: 'statistics', label: 'report.tab.statistics' })
  }
  if (!isTraining && (darf('report:export') || darf('settings:account'))) {
    bereiche.push({ key: 'exports', label: 'report.tab.exports' })
  }
  return bereiche
}

/**
 * Prozent in der Sprache der Oberfläche.
 *
 * `toLocaleString()` ohne Angabe nimmt die Sprache des Browsers. An einer
 * Rezeption steht die Oberfläche auf Deutsch und der Browser oft auf
 * Englisch — dann stünde die Belegung mit Punkt und der Umsatz daneben mit
 * Komma, auf demselben Bildschirm.
 */
function prozent(n: number, locale: Locale): string {
  return new Intl.NumberFormat(intlTag(locale),
    { maximumFractionDigits: 1 }).format(n) + ' %'
}

/**
 * Veränderung gegenüber dem Vorjahr in Prozent.
 *
 * `null` heißt: nicht ausrechenbar. Von null auf etwas ist keine Steigerung
 * um unendlich Prozent, und ein Haus, das im Vorjahr geschlossen war, würde
 * sonst „+∞ %" melden.
 */
export function veraenderung(jetzt: number, vorher: number): number | null {
  if (vorher === 0) return null
  return Math.round(((jetzt - vorher) / vorher) * 1000) / 10
}

function Zahl(
  { label, wert, vorjahr, hinweis }:
  { label: TextKey; wert: string; vorjahr?: { wert: string; delta: number | null }
    hinweis?: TextKey }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <div className="rounded border border-neutral-200 bg-white p-3 min-w-44">
      <div className="text-sm text-neutral-600">{t(label)}</div>
      <div className="text-2xl font-semibold tabular-nums">{wert}</div>
      {vorjahr !== undefined && (
        <div className="mt-1 text-xs text-neutral-500 tabular-nums">
          {t('kpi.previousYear')}: {vorjahr.wert}
          {vorjahr.delta !== null && (
            <span className={vorjahr.delta < 0 ? ' text-red-700' : ' text-emerald-700'}>
              {' '}{vorjahr.delta > 0 ? '+' : ''}{prozent(vorjahr.delta, locale)}
            </span>
          )}
        </div>
      )}
      {/* Der Hinweis steht sichtbar da und nicht in einem `title`: den
          bekommt nur zu sehen, wer mit der Maus stehen bleibt. */}
      {hinweis !== undefined && (
        <div className="mt-1 text-xs text-neutral-500 max-w-64">{t(hinweis)}</div>
      )}
    </div>
  )
}

function Kennzahlen({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [from, setFrom] = useState(addDays(today(), -30))
  const [to, setTo] = useState(today())
  const [vergleich, setVergleich] = useState(true)
  const q = useKpi(propertyId, from, to, vergleich)

  const gegen = (
    hole: (x: KpiTotal) => number, zeige: (n: number) => string
  ): { wert: string; delta: number | null } | undefined => {
    const v = q.data?.comparison
    if (v === undefined) return undefined
    return { wert: zeige(hole(v.total)), delta: veraenderung(hole(q.data!.total), hole(v.total)) }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.from')}</div>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.to')}</div>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm flex items-center gap-1.5 text-neutral-600">
          <input type="checkbox" checked={vergleich}
                 onChange={e => setVergleich(e.target.checked)} />
          {t('kpi.compare')}
        </label>
      </div>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : <>
              <div className="flex flex-wrap gap-2">
                <Zahl label="kpi.occupancy"
                      wert={prozent(q.data.total.occupancyPercent, locale)}
                      vorjahr={gegen(x => x.occupancyPercent, n => prozent(n, locale))} />
                <Zahl label="kpi.adr" hinweis="kpi.adrHint"
                      wert={formatMoney(q.data.total.adrCent, locale)}
                      vorjahr={gegen(x => x.adrCent, n => formatMoney(n, locale))} />
                <Zahl label="kpi.revpar" hinweis="kpi.revparHint"
                      wert={formatMoney(q.data.total.revparCent, locale)}
                      vorjahr={gegen(x => x.revparCent, n => formatMoney(n, locale))} />
                <Zahl label="kpi.revenue"
                      wert={formatMoney(q.data.total.roomRevenueCent, locale)}
                      vorjahr={gegen(x => x.roomRevenueCent, n => formatMoney(n, locale))} />
              </div>

              <div className="text-xs text-neutral-500">{t('kpi.sourceHint')}</div>

              <div className="overflow-x-auto">
                <table className="text-sm w-full">
                  <thead className="text-neutral-600 text-left">
                    <tr>
                      <th className="py-1 pr-3">{t('common.date')}</th>
                      <th className="py-1 pr-3 text-right">{t('kpi.sold')}</th>
                      <th className="py-1 pr-3 text-right">{t('kpi.available')}</th>
                      <th className="py-1 pr-3 text-right">{t('kpi.occupancy')}</th>
                      <th className="py-1 pr-3 text-right">{t('kpi.adr')}</th>
                      <th className="py-1 pr-3 text-right">{t('kpi.revpar')}</th>
                      <th className="py-1 pr-3 text-right">{t('kpi.revenue')}</th>
                      <th className="py-1">{t('kpi.source')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.days.map(d => (
                      <tr key={d.date} className="border-t border-neutral-100">
                        <td className="py-1 pr-3">{formatDate(d.date, locale)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{d.sold}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{d.available}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {prozent(d.occupancyPercent, locale)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {formatMoney(d.adrCent, locale)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {formatMoney(d.revparCent, locale)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {formatMoney(d.roomRevenueCent, locale)}</td>
                        <td className="py-1 text-neutral-500">
                          {t(d.source === 'aufgezeichnet'
                             ? 'kpi.source.recorded' : 'kpi.source.books')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>}
    </div>
  )
}

/** Die Schritte, für die es eine Beschriftung gibt. Ein unbekannter bleibt roh. */
const SCHRITTE = ['rollover', 'post_accommodation', 'post_city_tax', 'no_shows',
                  'expire_options', 'release_blocks', 'statistics'] as const

function Schritt({ step }: { step: string }): JSX.Element {
  const t = useT()
  const bekannt = (SCHRITTE as readonly string[]).includes(step)
  return <>{bekannt ? t(`audit.step.${step as (typeof SCHRITTE)[number]}`) : step}</>
}

function Tag(
  { tag, erwartet }: { tag: NightAuditDay; erwartet: readonly string[] }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const vollstaendig = tag.steps.length >= erwartet.length
  return (
    <li className="rounded border border-neutral-200 bg-white p-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{formatDate(tag.date, locale)}</span>
        <span className="text-neutral-500">
          {t(tag.status === 'closed' ? 'audit.closed' : 'audit.open')}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded border ${
          vollstaendig
            ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
            : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
          {tag.steps.length}/{erwartet.length}{' '}
          {t(vollstaendig ? 'audit.complete' : 'audit.incomplete')}
        </span>
        {tag.sold !== null && (
          <span className="text-neutral-500 tabular-nums">
            {t('kpi.sold')}: {tag.sold}
          </span>
        )}
      </div>
      {/* Die fehlenden Schritte stehen mit da: der Lauf nimmt genau dort
          wieder auf, und wer hinsieht, will wissen, was aussteht. */}
      <div className="mt-1 flex flex-wrap gap-1 text-xs">
        {erwartet.map(s => {
          const gelaufen = tag.steps.some(x => x.step === s)
          return (
            <span key={s}
                  className={`px-1.5 py-0.5 rounded border ${
                    gelaufen ? 'border-neutral-300 bg-neutral-100 text-neutral-700'
                             : 'border-neutral-200 text-neutral-400'}`}>
              <Schritt step={s} />
            </span>
          )
        })}
      </div>
    </li>
  )
}

function Nachtlauf({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = useNightAuditStatus(propertyId)

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const s: NightAuditStatus = q.data

  return (
    <div className="space-y-3">
      <div className={`rounded border p-3 text-sm ${
        s.overdue ? 'border-red-200 bg-red-50 text-red-900'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}
           role={s.overdue ? 'alert' : 'status'}>
        {s.openDate === null
          ? t('audit.noOpenDay')
          : s.overdue ? t('audit.overdue') : t('audit.ok')}
      </div>

      <div className="flex flex-wrap gap-2">
        <Zahl label="audit.businessDate" wert={formatDate(s.businessDate, locale)} />
        <Zahl label="audit.openDay"
              wert={s.openDate === null ? '—' : formatDate(s.openDate, locale)} />
        <Zahl label="audit.daysBehind"
              wert={s.daysBehind === null ? '—' : `${s.daysBehind} ${t('audit.days')}`} />
      </div>

      {s.days.length === 0
        ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
        : <ul className="space-y-1.5">
            {s.days.map(d => <Tag key={d.date} tag={d} erwartet={s.expectedSteps} />)}
          </ul>}
    </div>
  )
}

function Beherbergung({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [month, setMonth] = useState(() => today().slice(0, 7))
  const q = useAccommodationStatistics(propertyId, month, /^\d{4}-\d{2}$/.test(month))
  const ausgabe = useAusgabe()

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('stat.month')}</div>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
      </div>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : <>
              <div className="flex flex-wrap gap-2">
                <Zahl label="stat.rooms" wert={String(q.data.rooms)} />
                <Zahl label="stat.beds" wert={String(q.data.beds)} />
                <Zahl label="stat.arrivals" wert={String(q.data.totals.arrivals)} />
                <Zahl label="stat.nights" wert={String(q.data.totals.nights)} />
              </div>
              <div className="text-xs text-neutral-500">
                {t(q.data.reportingRequired ? 'stat.required' : 'stat.notRequired')}
                {' '}{apiText(q.data.hinweisKey, q.data.hinweis, locale)}
              </div>

              <table className="text-sm">
                <thead className="text-neutral-600 text-left">
                  <tr>
                    <th className="py-1 pr-6">{t('stat.country')}</th>
                    <th className="py-1 pr-6 text-right">{t('stat.arrivals')}</th>
                    <th className="py-1 text-right">{t('stat.nights')}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.byCountry.map(z => (
                    <tr key={z.country ?? 'XX'} className="border-t border-neutral-100">
                      <td className="py-1 pr-6">
                        {z.country === 'XX' || z.country === null
                          ? t('stat.unknownCountry') : z.country}
                      </td>
                      <td className="py-1 pr-6 text-right tabular-nums">{z.arrivals}</td>
                      <td className="py-1 text-right tabular-nums">{z.nights}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-neutral-300 font-medium">
                    <td className="py-1 pr-6">{t('stat.total')}</td>
                    <td className="py-1 pr-6 text-right tabular-nums">
                      {q.data.totals.arrivals}</td>
                    <td className="py-1 text-right tabular-nums">{q.data.totals.nights}</td>
                  </tr>
                </tbody>
              </table>

              <button
                onClick={() => ausgabe.mutate({
                  pfad: `/v1/properties/${propertyId}/accommodation-statistics`
                      + `?month=${month}`,
                  dateiname: `beherbergung-${month}.json` })}
                disabled={ausgabe.isPending}
                className="text-sm px-3 py-1.5 rounded border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
                {t(ausgabe.isPending ? 'export.running' : 'export.start')}
              </button>
              {ausgabe.isError && <Fehler error={ausgabe.error} />}
            </>}
    </div>
  )
}

function Ausgaben(
  { propertyId, darf }: { propertyId: number; darf: (p: string) => boolean }
): JSX.Element {
  const t = useT()
  const [from, setFrom] = useState(() => `${today().slice(0, 4)}-01-01`)
  const [to, setTo] = useState(today)
  const [berater, setBerater] = useState('')
  const [mandant, setMandant] = useState('')
  const ausgabe = useAusgabe()

  const starten = (pfad: string, dateiname: string): void => {
    ausgabe.mutate({ pfad, dateiname })
  }
  // Ein laufender Export sperrt alle drei Knoepfe -- zwei Jahresexporte
  // gleichzeitig helfen niemandem --, aber nur der laufende sagt es auch.
  const laeuft = (pfad: string): boolean =>
    ausgabe.isPending && ausgabe.variables?.pfad === pfad

  const datevPfad = `/v1/properties/${propertyId}/exports/datev?from=${from}&to=${to}`
    + (berater === '' ? '' : `&consultantNumber=${encodeURIComponent(berater)}`)
    + (mandant === '' ? '' : `&clientNumber=${encodeURIComponent(mandant)}`)
  const gobdPfad = `/v1/properties/${propertyId}/exports/gobd?from=${from}&to=${to}`
  const mandantPfad = `/v1/properties/${propertyId}/exports/tenant`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.from')}</div>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.to')}</div>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
      </div>

      {ausgabe.isError && <Fehler error={ausgabe.error} />}

      {darf('report:export') && <>
        <div className="rounded border border-neutral-200 bg-white p-3 space-y-2">
          <div className="font-medium">{t('export.datev')}</div>
          <div className="text-xs text-neutral-500">{t('export.datevHint')}</div>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              <div className="text-neutral-600">{t('export.consultantNumber')}</div>
              <input value={berater} onChange={e => setBerater(e.target.value)}
                     className="border border-neutral-300 rounded px-2 py-1 w-40" />
            </label>
            <label className="text-sm">
              <div className="text-neutral-600">{t('export.clientNumber')}</div>
              <input value={mandant} onChange={e => setMandant(e.target.value)}
                     className="border border-neutral-300 rounded px-2 py-1 w-40" />
            </label>
          </div>
          <button
            onClick={() => starten(datevPfad, `datev-${from}-${to}.csv`)}
            disabled={ausgabe.isPending}
            className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                       disabled:opacity-40">
            {t(laeuft(datevPfad) ? 'export.running' : 'export.start')}
          </button>
        </div>

        <div className="rounded border border-neutral-200 bg-white p-3 space-y-2">
          <div className="font-medium">{t('export.gobd')}</div>
          <div className="text-xs text-neutral-500">{t('export.gobdHint')}</div>
          <button
            onClick={() => starten(gobdPfad, `gobd-${from}-${to}.json`)}
            disabled={ausgabe.isPending}
            className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                       disabled:opacity-40">
            {t(laeuft(gobdPfad) ? 'export.running' : 'export.start')}
          </button>
        </div>
      </>}

      {/* Wer das ganze Haus exportiert, beendet in der Regel den Vertrag.
          Das ist keine Entscheidung der Rezeption und hängt deshalb an der
          Einstellungsberechtigung des Accounts. */}
      {darf('settings:account') && (
        <div className="rounded border border-neutral-200 bg-white p-3 space-y-2">
          <div className="font-medium">{t('export.tenant')}</div>
          <div className="text-xs text-neutral-500">{t('export.tenantHint')}</div>
          <button
            onClick={() => starten(mandantPfad,
              `mandantenexport-${propertyId}-${today()}.json`)}
            disabled={ausgabe.isPending}
            className="text-sm px-3 py-1.5 rounded border border-neutral-300
                       hover:bg-neutral-50 disabled:opacity-40">
            {t(laeuft(mandantPfad) ? 'export.running' : 'export.start')}
          </button>
        </div>
      )}
    </div>
  )
}

export function Reports({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const { darf, isTraining, geladen } = useHausrechte(propertyId)
  const [reiter, setReiter] = useReiter<Reiter>('report', REITER, 'kpi')

  const bereiche = berichtsBereiche(darf, isTraining)
  if (!geladen) return <Laedt />
  if (bereiche.length === 0) {
    return <div className="text-sm text-neutral-500">{t('report.nothingAllowed')}</div>
  }
  const aktiv = bereiche.find(b => b.key === reiter) ?? bereiche[0]!

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t('report.title')}</h1>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-neutral-200">
        {bereiche.map(b => (
          <button key={b.key} onClick={() => setReiter(b.key)}
                  aria-current={b.key === aktiv.key ? 'page' : undefined}
                  className={`text-sm px-3 py-1.5 -mb-px border-b-2 ${
                    b.key === aktiv.key
                      ? 'border-neutral-900 font-medium'
                      : 'border-transparent text-neutral-600 hover:text-neutral-900'}`}>
            {t(b.label)}
          </button>
        ))}
      </div>

      {isTraining && (
        <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200
                        rounded p-2">
          {t('export.training')}
        </div>
      )}

      {aktiv.key === 'kpi' && <Kennzahlen propertyId={propertyId} />}
      {aktiv.key === 'audit' && <Nachtlauf propertyId={propertyId} />}
      {aktiv.key === 'statistics' && <Beherbergung propertyId={propertyId} />}
      {aktiv.key === 'exports' && <Ausgaben propertyId={propertyId} darf={darf} />}
    </div>
  )
}
