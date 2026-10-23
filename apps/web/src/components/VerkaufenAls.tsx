import { useState, type JSX } from 'react'
import type { Category } from '@hotelpms/contracts'
import { useRoomSellAs } from '../lib/queries/booking.js'
import { useT } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { Dialog, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Ein Zimmer an einzelnen Tagen als andere Kategorie verkaufen (Migration 0197).
 *
 * Sven, 23.10.2026: Ist kein Doppelzimmer mehr frei, aber ein
 * Vierbettzimmer, verkauft das Haus das Vierbettzimmer als Doppelzimmer.
 * Bisher sperrte es dafuer die Verfuegbarkeitspruefung im Adminpanel und
 * stellte RoomCloud von Hand ein. Hier traegt man es dort ein, wo man es
 * entscheidet: am Plan, mit dem markierten Zeitraum.
 *
 * **Aufheben ist dieselbe Maske.** Die eigene Kategorie des Zimmers steht
 * in der Auswahl und heisst so; wer sie waehlt, nimmt die Tage zurueck.
 * Ein zweiter Eintrag "Aufheben" im Menue muesste erst wissen, ob an den
 * markierten Tagen etwas steht -- die Maske zeigt es ohnehin.
 */
export function VerkaufenAls({ propertyId, resourceId, roomCode, categoryId, ab, bis: bisVorgabe,
                               vorbelegt, kategorien, onClose }: {
  propertyId: number
  resourceId: number
  roomCode: string
  /** Die eigene Gruppe des Zimmers. */
  categoryId: number
  /** Der markierte Zeitraum; `bis` ist der Tag nach der letzten Nacht. */
  ab: string
  bis: string
  /** Was an diesen Tagen schon steht, wenn etwas steht -- die Vorauswahl. */
  vorbelegt: number | null
  kategorien: Category[]
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [von, setVon] = useState(ab)
  const [bis, setBis] = useState(bisVorgabe)
  const andere = kategorien.filter(k => k.active && k.id !== categoryId)
  const eigene = kategorien.find(k => k.id === categoryId)
  const [ziel, setZiel] = useState<number>(vorbelegt ?? andere[0]?.id ?? categoryId)
  const speichern = useRoomSellAs(propertyId)
  const gueltig = bis > von

  return (
    <Dialog breite="mittel" onClose={onClose}
            titel={t('sa.title', { room: roomCode })}
            fuss={speichern.isSuccess ? (
              <>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.back')}
                </button>
                <span className="text-sm text-emerald-800">✓ {t('sa.saved')}</span>
              </>
            ) : (
              <>
                <button type="button" disabled={!gueltig || speichern.isPending}
                        onClick={() => speichern.mutate({
                          roomId: resourceId, from: von, to: bis,
                          categoryId: ziel === categoryId ? null : ziel })}
                        className={KNOPF}>
                  {t('common.save')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.cancel')}
                </button>
                {!gueltig && (
                  <span className="self-center text-xs text-amber-800">
                    {t('booking.needNights')}
                  </span>
                )}
              </>
            )}>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">{t('sa.hint')}</p>

        <div className="grid gap-4 sm:grid-cols-3">
          <Feld label={t('common.from')}>
            <input type="date" value={von} onChange={e => setVon(e.target.value)}
                   className={FELD} />
          </Feld>
          <Feld label={t('common.to')}>
            <input type="date" value={bis} onChange={e => setBis(e.target.value)}
                   className={FELD} />
          </Feld>
          {/* Die Naechte als Zahl daneben, wie beim Sperren: "bis" ist der
              Tag danach, und wer das verwechselt, verkauft einen Tag zu viel. */}
          <div className="self-end text-sm text-neutral-600 tabular-nums pb-2">
            {t('group.nights', { n: Math.max(0, daysBetween(von, bis)) })}
          </div>
        </div>

        <Feld label={t('sa.category')}>
          <select value={ziel} onChange={e => setZiel(Number(e.target.value))}
                  className={FELD}>
            {andere.map(k => (
              <option key={k.id} value={k.id}>{`${k.name} (${k.code})`}</option>
            ))}
            {eigene !== undefined && (
              <option value={eigene.id}>{t('sa.own', { name: eigene.name })}</option>
            )}
          </select>
        </Feld>

        {speichern.isError && <Fehler error={speichern.error} />}
      </div>
    </Dialog>
  )
}
