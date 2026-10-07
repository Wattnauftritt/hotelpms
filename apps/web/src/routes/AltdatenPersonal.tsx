import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { api } from '../lib/api.js'
import { Fehler } from '../components/Shell.tsx'

/**
 * Altdaten aus der alten Personal-App (Baustein 9, Dokument 34).
 *
 * Datei waehlen, pruefen, Personen zuordnen, uebernehmen. Der Knopf zum
 * Uebernehmen erscheint erst nach einer Pruefung mit genau dieser Zuordnung;
 * wer danach etwas aendert, prueft neu -- wie bei KWHotel.
 *
 * **Die Datei bleibt im Speicher dieser Seite.** Sie traegt Namen und
 * Arbeitszeiten; kein `localStorage`, kein Zwischenspeicher der Abfragen.
 */

interface Bericht {
  dryRun: boolean
  exportedAt: string
  days: { from: string; to: string; replaced: number; closed: number } | null
  staff: Array<{ username: string; displayName: string | null; status: string
                 userId: number | null; decided: boolean; schedules: number; workEntries: number }>
  candidates: Array<{ userId: number; name: string; username: string | null }>
  schedules: { total: number; imported: number; unmapped: number; unknownRoom: number
               staygrid: number; closed: number }
  workEntries: { total: number; imported: number; unmapped: number; closed: number
                 translations: number }
  unknownRooms: string[]
  /** Wohin die Putzplanzeilen gingen: eine Datei, mehrere Haeuser (0116). */
  houses?: Array<{ propertyId: number; name: string; schedules: number }>
}

export function AltdatenPersonal({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const [daten, setDaten] = useState<unknown>(null)
  const [unlesbar, setUnlesbar] = useState(false)
  const [zuordnung, setZuordnung] = useState<Record<string, number | null>>({})
  const [bericht, setBericht] = useState<Bericht | null>(null)
  const [geprueft, setGeprueft] = useState(false)

  const lauf = useMutation({
    mutationFn: (commit: boolean) => api.post<Bericht>(
      `/v1/properties/${propertyId}/staff-import`, { data: daten, mapping: zuordnung, commit }),
    onSuccess: (b, commit) => {
      setBericht(b)
      setGeprueft(!commit)
      if (commit) {
        void qc.invalidateQueries({ queryKey: ['worktime', propertyId] })
        void qc.invalidateQueries({ queryKey: ['worktime-person', propertyId] })
      }
    }
  })

  const lesen = async (f: File | undefined): Promise<void> => {
    setBericht(null); setGeprueft(false); setZuordnung({}); setUnlesbar(false); lauf.reset()
    if (f === undefined) { setDaten(null); return }
    try {
      setDaten(JSON.parse(await f.text()) as unknown)
    } catch {
      setDaten(null); setUnlesbar(true)
    }
  }
  const ordne = (username: string, wert: string): void => {
    setZuordnung(z => ({ ...z, [username]: wert === '' ? null : Number(wert) }))
    setGeprueft(false)
  }

  const b = bericht
  return <div className="space-y-3 text-sm">
    <p className="text-neutral-600 max-w-prose">{t('worktime.legacy.hint')}</p>
    <input type="file" accept="application/json,.json"
           onChange={e => { void lesen(e.target.files?.[0]) }} />
    {unlesbar && <p className="text-red-800">{t('worktime.legacy.notJson')}</p>}
    {daten !== null && <button type="button" disabled={lauf.isPending}
        onClick={() => lauf.mutate(false)}
        className="block px-3 py-1.5 rounded border border-neutral-300">
      {t('worktime.legacy.check')}</button>}
    {lauf.isError && <Fehler error={lauf.error} />}

    {b !== null && <div className="space-y-3">
      {!b.dryRun && <p className="font-medium text-green-800">{t('worktime.legacy.done')}</p>}
      {b.days !== null && <p>{t('worktime.legacy.days', {
        from: formatDate(b.days.from, locale), to: formatDate(b.days.to, locale),
        n: b.days.replaced })}
        {b.days.closed > 0 && <> {t('worktime.legacy.closedDays', { n: b.days.closed })}</>}</p>}
      <table className="text-sm">
        <tbody>
          <tr><td className="pr-4">{t('worktime.legacy.schedules')}</td>
            <td className="tabular-nums">{t('worktime.legacy.counts', {
              imported: b.schedules.imported, total: b.schedules.total })}</td></tr>
          {(b.houses ?? []).length > 1 && b.houses!.map(h => (
            <tr key={h.propertyId}>
              <td className="pr-4 pl-3 text-neutral-600">{h.name}</td>
              <td className="tabular-nums text-neutral-600">{h.schedules}</td>
            </tr>
          ))}
          <tr><td className="pr-4">{t('worktime.legacy.entries')}</td>
            <td className="tabular-nums">{t('worktime.legacy.counts', {
              imported: b.workEntries.imported, total: b.workEntries.total })}</td></tr>
        </tbody>
      </table>
      <ul className="list-disc pl-5 text-neutral-700">
        {b.schedules.staygrid > 0
          && <li>{t('worktime.legacy.skipStaygrid', { n: b.schedules.staygrid })}</li>}
        {b.schedules.unmapped + b.workEntries.unmapped > 0
          && <li>{t('worktime.legacy.skipUnmapped',
                    { n: b.schedules.unmapped + b.workEntries.unmapped })}</li>}
        {b.schedules.unknownRoom > 0 && <li>{t('worktime.legacy.skipRoom',
          { n: b.schedules.unknownRoom, rooms: b.unknownRooms.join(', ') })}</li>}
        {b.schedules.closed + b.workEntries.closed > 0
          && <li>{t('worktime.legacy.skipClosed',
                    { n: b.schedules.closed + b.workEntries.closed })}</li>}
      </ul>

      <table className="w-full text-sm border-collapse">
        <thead className="text-left text-neutral-500 border-b border-neutral-200">
          <tr><th className="py-1 pr-3 font-medium">{t('worktime.legacy.oldUser')}</th>
              <th className="py-1 pr-3 font-medium">{t('worktime.legacy.rows')}</th>
              <th className="py-1 font-medium">{t('worktime.legacy.person')}</th></tr>
        </thead>
        <tbody>
          {b.staff.map(s => {
            const wert = Object.hasOwn(zuordnung, s.username) ? zuordnung[s.username] : s.userId
            return <tr key={s.username} className="border-b border-neutral-100">
              <td className="py-1 pr-3">{s.username}
                {s.displayName !== null && <span className="ml-2 text-neutral-500">{s.displayName}</span>}
                {s.status === 'inactive'
                  && <span className="ml-2 text-neutral-400">({t('worktime.legacy.inactive')})</span>}
              </td>
              <td className="py-1 pr-3 tabular-nums">{s.schedules + s.workEntries}</td>
              <td className="py-1">
                <select value={wert ?? ''} onChange={e => ordne(s.username, e.target.value)}
                        className="border border-neutral-300 rounded px-2 py-0.5">
                  <option value="">{t('worktime.legacy.skip')}</option>
                  {b.candidates.map(c => <option key={c.userId} value={c.userId}>
                    {c.name}{c.username !== null ? ` (${c.username})` : ''}</option>)}
                </select>
                {!s.decided && s.userId !== null && !Object.hasOwn(zuordnung, s.username)
                  && <span className="ml-2 text-neutral-500">{t('worktime.legacy.suggested')}</span>}
              </td>
            </tr>
          })}
        </tbody>
      </table>
      {geprueft
        ? <button type="button" disabled={lauf.isPending} onClick={() => lauf.mutate(true)}
                  className="px-3 py-1.5 rounded bg-neutral-900 text-white disabled:bg-neutral-300">
            {t('worktime.legacy.commit')}</button>
        : b.dryRun && <p className="text-neutral-500">{t('worktime.legacy.recheck')}</p>}
    </div>}
  </div>
}
