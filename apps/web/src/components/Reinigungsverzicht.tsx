import type { CleaningWaiverView } from '@hotelpms/contracts'
import { useT, useLocale, formatDate, formatDayMonth, weekdayShort } from '../lib/i18n/index.js'
import { VerzichtListe } from './VerzichtListe.tsx'

/**
 * Die Bleibetage mit je einem Haken "keine Reinigung" (Migration 0115).
 *
 * Eine Komponente fuer die Gastseite und das Seitenfenster der Rezeption:
 * was der Gast sieht, soll die Rezeption am Telefon genauso vor sich haben.
 * Wer was mit dem Haken tut, entscheidet der Aufrufer (`onSet`) -- der Gast
 * mit seinem Link, die Rezeption mit ihrer Sitzung. Die Liste selbst steht
 * in `VerzichtListe.tsx`, weil die Gaestemappe sie mit ihrem Katalog zeigt.
 */
export function VerzichtTage({ view, onSet, busy, gross = false }: {
  view: CleaningWaiverView
  onSet: (date: string, waived: boolean) => void
  busy: boolean
  gross?: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <VerzichtListe view={view} onSet={onSet} busy={busy} gross={gross}
                   tag={d => `${weekdayShort(d, locale)} ${formatDate(d, locale)}`}
                   erledigt={t('gastCheckin.waiver.locked')} />
  )
}

/**
 * Die abgewaehlten Tage als eine kurze Marke, nur zum Lesen (Sven,
 * 12.10.2026): in der Hausliste und an den Meldescheinen soll man sehen,
 * wann nicht gereinigt wird, ohne die Reservierung aufzuklappen. Geaendert
 * wird weiter im Seitenfenster, ueber `setzeVerzicht`.
 *
 * `heute` hebt den Tag hervor, um den es auf dem Bildschirm gerade geht.
 */
export function VerzichtMarke({ dates, heute }: {
  dates: readonly string[]; heute?: string
}): JSX.Element | null {
  const t = useT()
  const locale = useLocale()
  if (dates.length === 0) return null
  return (
    <span title={t('waiver.daysHint')}
          className="inline-flex flex-wrap items-center gap-x-1 text-[11px] px-1 rounded-sm
                     bg-rose-50 text-rose-800">
      <span>{t('waiver.days')}:</span>
      {dates.map((d, i) => (
        <span key={d} className={`tabular-nums ${d === heute ? 'font-semibold underline' : ''}`}>
          {weekdayShort(d, locale)} {formatDayMonth(d, locale)}{i < dates.length - 1 ? ',' : ''}
        </span>
      ))}
    </span>
  )
}
