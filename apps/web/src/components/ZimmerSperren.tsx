import { useState, type JSX } from 'react'
import { useCreateMaintenanceTicket } from '../lib/queries/settings.js'
import { useT } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { Dialog, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Ein Zimmer sperren -- aus dem Plan heraus, wo die Entscheidung faellt.
 *
 * **Warum hier und nicht nur im Wartungsbildschirm.** "Der Handwerker kommt
 * Dienstag an die Dusche in 204" faellt jemandem ein, waehrend er auf den
 * Plan sieht. Bisher hiess das: Bildschirm wechseln, Zimmer suchen, Datum
 * eintippen, zurueck. Der Weg ist so lang, dass die Sperrung haeufig gar
 * nicht entsteht -- und dann verkauft das Haus ein Zimmer ohne Dusche.
 *
 * **Es entsteht immer eine Wartungsmeldung, nicht nur ein Riegel.** Eine
 * Sperrung ohne Grund und ohne Zustaendigen bleibt stehen, bis jemand
 * darueber stolpert; die Meldung hat einen Zustand und taucht in der Liste
 * auf, die jemand abarbeitet. Deshalb ist der Titel Pflicht: "Sperrung" als
 * Grund ist keiner.
 *
 * **Out of Order senkt die Kapazitaet, Out of Service nicht.** Das ist der
 * ganze Unterschied und der Grund, warum hier gewaehlt werden muss: ein
 * Zimmer ohne Fernseher ist verkaeuflich, eines ohne Wasser nicht. Wer
 * beides gleich behandelt, verkauft entweder zu wenig oder das Falsche.
 *
 * **Mehrere Zimmer auf einmal.** Der Handwerker kommt an die Steigleitung
 * und nimmt eine Etage mit. Was im Plan markiert ist, wird zusammen
 * gesperrt -- in **einem** Aufruf, damit nicht die Haelfte gesperrt ist,
 * wenn das dritte Zimmer scheitert. Jedes Zimmer bekommt trotzdem seine
 * eigene Wartungsmeldung: erledigt wird einzeln, und "Dusche in 204
 * repariert" schliesst 205 nicht mit.
 */
export function ZimmerSperren({ propertyId, zimmer, ab, bis: bisVorgabe, onClose }: {
  propertyId: number
  /** Ein Zimmer oder mehrere. Leer kommt nicht vor -- der Plan ruft mit dem
      an, worauf gezeigt wurde. */
  zimmer: Array<{ resourceId: number; roomCode: string }>
  /** Der markierte Zeitraum. Vorbelegung, kein Zwang. */
  ab: string
  bis: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [von, setVon] = useState(ab)
  const [bis, setBis] = useState(bisVorgabe)
  const [art, setArt] = useState<'out_of_order' | 'out_of_service'>('out_of_order')
  const [titel, setTitel] = useState('')
  const anlegen = useCreateMaintenanceTicket(propertyId)

  /**
   * Warum der Knopf gesperrt ist -- `null`, wenn er es nicht ist.
   *
   * Der Grund ist Pflicht, und das ist leicht zu uebersehen: er steht als
   * letztes Feld, hinter Zeitraum und Art. Wer die oberen ausgefuellt hat,
   * haelt die Maske fuer fertig, klickt -- und nichts passiert.
   */
  const grund =
    bis <= von ? 'booking.needNights'
    : titel.trim() === '' ? 'sperre.needReason'
    : null
  const gueltig = grund === null

  /*
   * Die Zimmernummern in der Unterzeile, nicht nur ihre Zahl: wer eine
   * Etage markiert hat, prueft hier ein letztes Mal, ob das markierte
   * Zimmer daneben mitgegangen ist. Ab einem Dutzend wird daraus eine
   * Zeile, die niemand liest -- dann die Zahl.
   */
  const unterzeile = zimmer.length <= 12
    ? zimmer.map(z => z.roomCode).join(', ')
    : t('sperre.roomCount', { n: zimmer.length })

  return (
    <Dialog breite="mittel" onClose={onClose}
            titel={zimmer.length === 1 ? t('sperre.title') : t('sperre.titleMany')}
            unterzeile={unterzeile}
            fuss={anlegen.isSuccess ? (
              <>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.back')}
                </button>
                <span className="text-sm text-emerald-800">✓ {
                  zimmer.length === 1 ? t('sperre.created')
                    : t('sperre.createdMany', { n: zimmer.length })
                }</span>
              </>
            ) : (
              <>
                <button type="button" disabled={!gueltig || anlegen.isPending}
                        onClick={() => anlegen.mutate({
                          propertyId, resourceIds: zimmer.map(z => z.resourceId),
                          title: titel.trim(),
                          block: { from: von, to: bis, kind: art }
                        })}
                        className={KNOPF}>
                  {t('sperre.submit')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('booking.close')}
                </button>
                {/* Daneben und nicht im `title`: ein gesperrter Knopf nimmt keine
                    Zeigerereignisse an, sein Tooltip erscheint in den meisten
                    Browsern gar nicht. */}
                {grund !== null && (
                  <span className="self-center text-xs text-amber-800">{t(grund)}</span>
                )}
              </>
            )}>
      <div className="space-y-4">
        {/* Der Satz steht nur da, wenn er etwas sagt: bei einem Zimmer
            erklaert er das Offensichtliche. */}
        {zimmer.length > 1 && (
          <p className="text-sm text-neutral-600">
            {t('sperre.manyHint', { n: zimmer.length })}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Feld label={t('common.from')}>
            <input type="date" value={von} onChange={e => setVon(e.target.value)}
                   className={FELD} />
          </Feld>
          <Feld label={t('common.to')}>
            <input type="date" value={bis} onChange={e => setBis(e.target.value)}
                   className={FELD} />
          </Feld>
          {/* Die Naechte als Zahl daneben: "bis" ist der Abreisetag und
              nicht die letzte Nacht, und wer das verwechselt, sperrt einen
              Tag zu viel. */}
          <div className="self-end text-sm text-neutral-600 tabular-nums pb-2">
            {t('group.nights', { n: daysBetween(von, bis) })}
          </div>
        </div>

        {/*
          * Art und Grund nebeneinander: beides ist Pflicht, und untereinander
          * stand der Grund so weit unten, dass die Maske darueber fertig
          * aussah.
          */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Feld label={t('sperre.kind')}
                hinweis={art === 'out_of_order'
                  ? t('sperre.outOfOrderHint') : t('sperre.outOfServiceHint')}>
            <select value={art}
                    onChange={e => setArt(e.target.value as 'out_of_order' | 'out_of_service')}
                    className={FELD}>
              <option value="out_of_order">{t('sperre.outOfOrder')}</option>
              <option value="out_of_service">{t('sperre.outOfService')}</option>
            </select>
          </Feld>

          {/* Der Grund steht am Riegel im Plan und ist der Titel der
              Wartungsmeldung. Eine Sperrung, deren Grund niemand kennt,
              bleibt stehen, bis jemand darueber stolpert. */}
          <Feld label={t('sperre.reason')} hinweis={t('sperre.reasonHint')}>
            <input value={titel} onChange={e => setTitel(e.target.value)}
                   placeholder={t('sperre.reasonPlaceholder')}
                   className={FELD} />
          </Feld>
        </div>

        {anlegen.isError && <Fehler error={anlegen.error} />}
      </div>
    </Dialog>
  )
}
