import { useQuery } from '@tanstack/react-query'
import type { StaffLocale } from '@hotelpms/contracts'
import { api } from '../lib/api.js'
import { fehlerText, usePT } from './texte.js'
import { Fehler, KNOPF_LEISE, Karte } from './teile.js'

/**
 * Fruehstueck (Baustein 5, Aufgabe 18 in Dokument 16).
 *
 * Zwei grosse Zahlen -- heute und morgen --, darunter die Woche. Mehr
 * braucht die Kueche nicht, und mehr bekommt sie auch nicht: das Recht
 * `kitchen:breakfast` zeigt nur diese Zahl.
 */

export interface FruehstuecksTag {
  date: string
  breakfasts: number
  adults: number
  children: number
  unsplit: number
  assumed: number
}
/** Bei gemeinsamer Kueche (0116) die Summe in `days`, die Haeuser hier. */
interface Woche {
  date: string; days: FruehstuecksTag[]
  houses?: Array<{ propertyId: number; name: string; days: FruehstuecksTag[] }> | null
}

/** Wochentag und Datum in der Sprache des Personals, ohne Zeitzone. */
export function tagName(iso: string, locale: StaffLocale): string {
  const [j, m, t] = iso.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'numeric',
    timeZone: 'UTC' }).format(new Date(Date.UTC(j, m - 1, t)))
}

export function Kueche({ propertyId, locale }: {
  propertyId: number; locale: StaffLocale
}): JSX.Element {
  const t = usePT()
  const q = useQuery<Woche>({
    queryKey: ['kitchen', propertyId],
    queryFn: () => api.get<Woche>(`/v1/properties/${propertyId}/kitchen`),
    // Spaete Anreisen und Stornos kommen den Tag ueber dazu.
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true
  })
  if (q.isPending) return <Karte><p>{t('app.loading')}</p></Karte>
  if (q.isError) {
    return <Karte>
      <Fehler text={fehlerText(q.error, locale)} />
      <button type="button" className={KNOPF_LEISE} onClick={() => { void q.refetch() }}>
        {t('app.retry')}
      </button>
    </Karte>
  }
  const [heute, morgen, ...rest] = q.data.days
  const haeuser = q.data.houses ?? []
  const aufteilung = (date: string): string => haeuser.map(h =>
    `${h.name} ${h.days.find(x => x.date === date)?.breakfasts ?? 0}`).join(' · ')
  return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-3">
      {[['kitchen.today', heute], ['kitchen.tomorrow', morgen]].map(([k, d]) => {
        const tag = d as FruehstuecksTag | undefined
        if (tag === undefined) return null
        return <section key={k as string}
                        className="bg-white border border-neutral-200 rounded-lg p-4 text-center">
          <h2 className="text-sm text-neutral-600">{t(k as 'kitchen.today')}</h2>
          <p className="text-5xl font-semibold tabular-nums my-2">{tag.breakfasts}</p>
          <p className="text-sm text-neutral-600">{tagName(tag.date, locale)}</p>
          {tag.children > 0 && <p className="text-sm text-neutral-600">
            {t('kitchen.children', { n: tag.children })}</p>}
          {haeuser.length > 1
            && <p className="text-sm text-neutral-600">{aufteilung(tag.date)}</p>}
        </section>
      })}
    </div>
    {rest.length > 0 && <Karte titel={t('kitchen.week')}>
      <ul className="divide-y divide-neutral-100">
        {rest.map(d => <li key={d.date} className="flex justify-between py-2 text-base">
          <span>{tagName(d.date, locale)}</span>
          <span className="font-semibold tabular-nums">{d.breakfasts}</span>
        </li>)}
      </ul>
    </Karte>}
    {/*
      * Gaeste ohne bekannte Personenzahl zaehlen mit der Hoechstbelegung.
      * Das steht da, damit niemand eine geschaetzte Zahl fuer genau haelt.
      */}
    {heute !== undefined && heute.assumed > 0
      && <p className="text-sm text-neutral-600">{t('kitchen.assumed', { n: heute.assumed })}</p>}
  </div>
}
