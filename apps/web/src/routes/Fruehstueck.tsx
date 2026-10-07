import { useQuery } from '@tanstack/react-query'
import { useT, useLocale, intlTag } from '../lib/i18n/index.js'
import { api } from '../lib/api.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Fruehstueck (Aufgabe 18, Baustein 5) -- die Seite der Personal-App am
 * Rechner. Die Hausdame kontrolliert die Zahl (Sven, 07.10.2026), die
 * Rezeption wird morgens danach gefragt. Arbeitet der Betrieb mit
 * gemeinsamem Personal, ist die Zahl die aller Haeuser, die Aufteilung
 * steht darunter.
 */

interface Tag { date: string; breakfasts: number; children: number; assumed: number }
/** Bei gemeinsamer Kueche (0116) die Summe in `days`, die Haeuser hier. */
interface Woche {
  date: string; days: Tag[]
  houses?: Array<{ propertyId: number; name: string; days: Tag[] }> | null
}

export function Fruehstueck({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = useQuery<Woche>({
    queryKey: ['kitchen', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/kitchen`),
    refetchInterval: 5 * 60_000
  })
  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const name = (iso: string): string => {
    const [j, m, d] = iso.split('-').map(Number) as [number, number, number]
    return new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', day: 'numeric',
      month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(j, m - 1, d)))
  }
  const [heute, morgen, ...rest] = q.data.days
  const haeuser = q.data.houses ?? []
  const aufteilung = (date: string): string => haeuser.map(h =>
    `${h.name} ${h.days.find(x => x.date === date)?.breakfasts ?? 0}`).join(' · ')
  return <div className="space-y-4 max-w-2xl">
    <div className="grid grid-cols-2 gap-4">
      {([['breakfast.today', heute], ['breakfast.tomorrow', morgen]] as const).map(([k, d]) =>
        d !== undefined && <section key={k}
                 className="border border-neutral-200 rounded-lg p-4 text-center bg-white">
          <h2 className="text-sm text-neutral-600">{t(k)}</h2>
          <p className="text-5xl font-semibold tabular-nums my-2">{d.breakfasts}</p>
          <p className="text-sm text-neutral-600">{name(d.date)}</p>
          {d.children > 0 && <p className="text-sm text-neutral-600">
            {t('breakfast.children', { n: d.children })}</p>}
          {haeuser.length > 1 && <p className="text-sm text-neutral-600">{aufteilung(d.date)}</p>}
        </section>)}
    </div>
    {rest.length > 0 && <section>
      <h2 className="text-sm font-semibold mb-1">{t('breakfast.week')}</h2>
      <table className="w-full text-sm">
        <tbody>
          {rest.map(d => <tr key={d.date} className="border-b border-neutral-100">
            <td className="py-1.5">{name(d.date)}</td>
            {haeuser.length > 1
              && <td className="py-1.5 text-right text-neutral-500">{aufteilung(d.date)}</td>}
            <td className="py-1.5 text-right font-semibold tabular-nums">{d.breakfasts}</td>
          </tr>)}
        </tbody>
      </table>
    </section>}
    {heute !== undefined && heute.assumed > 0
      && <p className="text-sm text-neutral-600">{t('breakfast.assumed', { n: heute.assumed })}</p>}
    <p className="text-sm text-neutral-500">{t('breakfast.rule')}</p>
  </div>
}
