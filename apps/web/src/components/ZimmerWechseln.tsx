import { useState, type JSX } from 'react'
import { useRoomMoveOptions, useRoomMove } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate, formatMoney } from '../lib/i18n/index.js'
import { centAusEingabe, eingabeAusCent } from '../lib/preisraster.js'
import { Dialog, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * "Zimmer wechseln" (Migration 0195): derselbe Aufenthalt, ab einem Tag in
 * einem anderen Zimmer. Ein Folio, ein Meldeschein, eine Kanalbuchung --
 * vorher musste die Rezeption den Gast frueher auschecken und neu buchen.
 *
 * **Der Tag ist die erste Nacht im neuen Zimmer.** Beim Gast im Haus steht
 * dort der Geschaeftstag; frueher geht nicht, die Naechte davor hat er im
 * alten Zimmer verbracht. Ein spaeterer Tag plant den Wechsel, der Nachtlauf
 * fuehrt ihn aus. Vor der Anreise teilt derselbe Dialog den Aufenthalt.
 *
 * **Gezeigt werden nur freie Zimmer.** Ein belegtes zur Wahl zu stellen
 * hiesse, eine Fehlermeldung anzubieten.
 *
 * **Ein Aufpreis ist ein hoeherer Nachtpreis ab dem Wechseltag**, keine
 * eigene Zeile (Sven, 23.10.2026). Er gilt nur fuer Naechte, die noch nicht
 * auf dem Folio stehen; gebucht ist gebucht.
 */
export function ZimmerWechseln({ reservationRef, onClose }: {
  reservationRef: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [ab, setAb] = useState<string | null>(null)
  const optionen = useRoomMoveOptions(reservationRef, ab)
  const wechseln = useRoomMove()
  // `'band'`: ohne Zimmer ab dem Tag, ins Band ueber dem Plan (0196). Im
  // vollen Haus ist ein Zimmer oft erst frei, wenn ein anderer Gast umgelegt
  // ist -- und genau dafuer ist das Band der Ablageplatz.
  const [zimmer, setZimmer] = useState<number | 'band' | null>(null)
  const [neuerPreis, setNeuerPreis] = useState(false)
  const [preisText, setPreisText] = useState<string | null>(null)

  const o = optionen.data
  const frei = (o?.rooms ?? []).filter(z => z.free)
  const gewaehlt = zimmer === 'band' || frei.some(z => z.resourceId === zimmer) ? zimmer : null
  const vorbelegt = o?.nightPriceCent ?? null
  const text = preisText ?? (vorbelegt === null ? '' : eingabeAusCent(vorbelegt))
  const preisCent = neuerPreis ? centAusEingabe(text) : null
  const bereit = o !== undefined && gewaehlt !== null && (!neuerPreis || preisCent !== null)
  const sofort = o !== undefined && o.status === 'InHouse' && o.from <= o.businessDate
  const jetzt = o?.rooms.find(z => z.resourceId === o.currentResourceId)

  const speichern = (): void => {
    if (o === undefined || gewaehlt === null) return
    wechseln.mutate({ reservationRef, from: o.from,
                      resourceId: gewaehlt === 'band' ? null : gewaehlt,
                      ...(preisCent === null ? {} : { priceCent: preisCent }) },
                    { onSuccess: onClose })
  }

  // Die Zimmer nach ihrer Gruppe, in der Reihenfolge der Schnittstelle: ein
  // Upgrade ist meist ein Wechsel der Gruppe, und dann sucht man sie.
  const gruppen: Array<{ name: string; zimmer: typeof frei }> = []
  for (const z of frei) {
    const letzte = gruppen[gruppen.length - 1]
    if (letzte !== undefined && letzte.name === z.categoryName) letzte.zimmer.push(z)
    else gruppen.push({ name: z.categoryName, zimmer: [z] })
  }

  return (
    <Dialog titel={t('rm.button')} breite="mittel" onClose={onClose}
            unterzeile={o === undefined ? reservationRef
              : `${reservationRef} · ${formatDate(o.arrival, locale)} – ${formatDate(o.departure, locale)}`}
            fuss={<>
              <button onClick={onClose} className={KNOPF_LEISE}>{t('common.cancel')}</button>
              <button onClick={speichern} disabled={!bereit || wechseln.isPending}
                      className={KNOPF}>
                {t('rm.button')}
              </button>
            </>}>
      {optionen.isPending && <Laedt />}
      {optionen.isError && <Fehler error={optionen.error} />}
      {o !== undefined && (
        <div className="space-y-4 text-sm">
          <label className="block space-y-1">
            <span className="text-neutral-600">{t('rm.from')}</span>
            <input type="date" className={FELD} value={o.from}
                   min={o.earliestFrom} max={o.departure}
                   onChange={e => { if (e.target.value !== '') setAb(e.target.value) }} />
            <span className="block text-xs text-neutral-500">
              {jetzt !== undefined && <>{t('rm.current', { room: jetzt.code })} · </>}
              {sofort ? t('rm.nowHint') : t('rm.plannedHint')}
            </span>
          </label>

          <div className="space-y-2">
            <div className="text-neutral-600">{t('rm.newRoom')}</div>
            {frei.length === 0 && (
              <p className="text-neutral-500">{t('rm.noRooms')}</p>
            )}
            {o.currentResourceId !== null && (
              <div className="space-y-1">
                <button type="button" onClick={() => setZimmer('band')}
                        aria-pressed={gewaehlt === 'band'}
                        className={`px-2 py-1 rounded-sm border
                                    ${gewaehlt === 'band'
                                      ? 'border-neutral-900 bg-neutral-900 text-white'
                                      : 'border-neutral-300 bg-white hover:bg-neutral-50'}`}>
                  {t('rm.toBand')}
                </button>
                <span className="block text-xs text-neutral-500">{t('rm.toBandHint')}</span>
              </div>
            )}
            {gruppen.map(g => (
              <div key={g.name} className="space-y-1">
                <div className="text-xs text-neutral-500">{g.name}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.zimmer.map(z => (
                    <button key={z.resourceId} type="button"
                            onClick={() => setZimmer(z.resourceId)}
                            aria-pressed={gewaehlt === z.resourceId}
                            className={`min-w-12 px-2 py-1 rounded-sm border tabular-nums
                                        ${gewaehlt === z.resourceId
                                          ? 'border-neutral-900 bg-neutral-900 text-white'
                                          : 'border-neutral-300 bg-white hover:bg-neutral-50'}`}>
                      {z.code}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <fieldset className="space-y-1">
            <legend className="text-neutral-600 mb-1">{t('rm.price')}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" checked={!neuerPreis} onChange={() => setNeuerPreis(false)} />
              {t('rm.priceKeep')}
              {vorbelegt !== null && (
                <span className="text-neutral-500">({formatMoney(vorbelegt, locale)})</span>
              )}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={neuerPreis} onChange={() => setNeuerPreis(true)} />
              {t('rm.priceNew')}
            </label>
            {neuerPreis && (
              <div className="ps-6 space-y-1">
                <input className={`${FELD} max-w-40`} inputMode="decimal" value={text}
                       onChange={e => setPreisText(e.target.value)} />
                <span className="block text-xs text-neutral-500">{t('rm.priceHint')}</span>
              </div>
            )}
          </fieldset>
          {wechseln.isError && <Fehler error={wechseln.error} />}
        </div>
      )}
    </Dialog>
  )
}
