import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SetupStatus } from '@hotelpms/contracts'
import { api } from '../lib/api.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { type ArtZeile, type FirstSetupReport, IMPORT_BILDSCHIRM, ErsteSchritteContext,
         hausIstLeer, nutzlast, zeilenLuecken, zimmerNummern } from '../lib/ersteSchritte.js'
import { useFirstSetup } from '../lib/queries/ersteSchritte.js'
import { Dialog, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Erste Schritte: aus einem leeren Haus ein buchbares.
 *
 * Ein neuer Kunde meldet sich zum ersten Mal an und sitzt vor einem System
 * ohne Zimmer. Die Einrichtung kann alles, was er braucht, aber in einer
 * Reihenfolge, die man kennen muss. Hier sind es drei Fragen -- welche
 * Zimmer, was kostet eine Nacht, stimmt das so -- und eine Anfrage an
 * `first-setup`, die alles in einer Transaktion anlegt, den Bestand
 * eingeschlossen.
 *
 * **Bewusst klein.** Saison, Wochenende, Frühstück und Storno sind Pflege im
 * Preisraster; am Ende steht deshalb der Weg dorthin, nicht eine vierte
 * Seite, die die Hälfte davon nachbaut.
 *
 * **Schließen ist erlaubt.** Wer erst Daten aus dem alten Programm
 * übernehmen will oder sich umsehen möchte, ist kein Fehler. Der Assistent
 * kommt beim nächsten Login wieder, solange das Haus leer ist, und lässt
 * sich in der Einrichtung jederzeit öffnen.
 */

/**
 * Der Rahmen, der den Assistenten von selbst öffnet.
 *
 * Er hängt um alle Bildschirme eines Hauses und nicht an einem davon: wer
 * sich zum ersten Mal anmeldet, landet auf dem ersten erlaubten Bildschirm,
 * und welcher das ist, hängt an seinen Rechten. Von selbst erscheint der
 * Assistent nur dem, der das Haus einrichten darf, und nur, solange es leer
 * ist (`hausIstLeer`).
 *
 * Geschlossen bleibt er bis zum nächsten Laden der Seite. Nicht länger und
 * nicht im Browser gemerkt: ein leeres Haus ist kein Zustand, an den man
 * sich gewöhnen soll, und wer es vertagt hat, findet ihn beim nächsten
 * Login wieder.
 */
export function ErsteSchritteRahmen({ propertyId, rechte, bildschirme, onScreen, children }: {
  propertyId: number
  rechte: readonly string[]
  bildschirme: readonly string[]
  onScreen: (key: string) => void
  children: ReactNode
}): JSX.Element {
  const darfEinrichten = rechte.includes('settings:property')
  // Derselbe Schluessel wie der Einrichtungsstand: eine Anfrage, nicht zwei,
  // wenn beide auf dem Bildschirm stehen.
  const status = useQuery<SetupStatus>({
    queryKey: ['setup', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/setup-status`),
    enabled: darfEinrichten
  })
  /*
   * `null` heisst: noch nicht entschieden, der Stand entscheidet. Sobald er
   * den Assistenten einmal geoeffnet hat, haelt `true` ihn offen -- sonst
   * verschwaende er mitten in der Fertig-Seite, weil das Haus nach dem
   * Anlegen nicht mehr leer ist.
   */
  const [offen, setOffen] = useState<boolean | null>(null)
  const leer = darfEinrichten && status.data !== undefined && hausIstLeer(status.data)
  useEffect(() => { if (leer) setOffen(o => o ?? true) }, [leer])

  return (
    <ErsteSchritteContext.Provider
      value={darfEinrichten ? { oeffnen: () => setOffen(true) } : null}>
      {children}
      {offen === true && (
        <ErsteSchritte propertyId={propertyId} darfPreise={rechte.includes('rate:write')}
                       bildschirme={bildschirme} onScreen={onScreen}
                       onClose={() => setOffen(false)} />
      )}
    </ErsteSchritteContext.Provider>
  )
}

type Schritt = 'zimmer' | 'preise' | 'pruefen' | 'fertig'

export function ErsteSchritte({ propertyId, darfPreise, bildschirme, onScreen, onClose }: {
  propertyId: number
  /** `rate:write`. Ohne es entfällt der Preisschritt, die Zimmer entstehen trotzdem. */
  darfPreise: boolean
  /** Die Bildschirme, die dieser Benutzer sehen darf, als Schlüssel. */
  bildschirme: readonly string[]
  onScreen: (key: string) => void
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [schritt, setSchritt] = useState<Schritt>('zimmer')
  const [zeilen, setZeilen] = useState<ArtZeile[]>(() => [
    { code: 'EZ', name: t('first.tplSingle'), personen: 1, anzahl: 4, ab: 101,
      vorsatz: '', preis: '' },
    { code: 'DZ', name: t('first.tplDouble'), personen: 2, anzahl: 10, ab: 201,
      vorsatz: '', preis: '' }
  ])
  const [ratenName, setRatenName] = useState(() => t('first.rateNameDefault'))
  const [bericht, setBericht] = useState<FirstSetupReport | null>(null)
  const einrichtung = useFirstSetup(propertyId)

  const luecken = zeilenLuecken(zeilen)
  const aendern = (i: number, teil: Partial<ArtZeile>): void => {
    setZeilen(z => z.map((x, j) => j === i ? { ...x, ...teil } : x))
    // Eine Vorschau gilt für genau eine Eingabe, ihr Fehler ebenso.
    setBericht(null)
    einrichtung.reset()
  }

  const vorschau = (): void => {
    einrichtung.mutate(nutzlast(propertyId, zeilen, ratenName, darfPreise, false), {
      onSuccess: r => { setBericht(r); setSchritt('pruefen') }
    })
  }
  const anlegen = (): void => {
    einrichtung.mutate(nutzlast(propertyId, zeilen, ratenName, darfPreise, true), {
      onSuccess: r => { setBericht(r); setSchritt('fertig') }
    })
  }
  const gehe = (key: string): void => { onClose(); onScreen(key) }

  const SCHRITTE: Array<[Schritt, Parameters<typeof t>[0]]> = [
    ['zimmer', 'first.stepRooms'], ['preise', 'first.stepPrices'],
    ['pruefen', 'first.stepCheck'], ['fertig', 'first.stepDone']]

  const fuss = schritt === 'fertig'
    ? <button type="button" className={`${KNOPF} ml-auto`} onClick={onClose}>
        {t('common.close')}
      </button>
    : <>
        <button type="button" className={KNOPF_LEISE} onClick={onClose}>
          {t('first.later')}
        </button>
        {schritt !== 'zimmer' && (
          <button type="button" className={`${KNOPF_LEISE} ml-auto`}
                  onClick={() => setSchritt(schritt === 'pruefen' && darfPreise
                                              ? 'preise' : 'zimmer')}>
            {t('first.back')}
          </button>
        )}
        {schritt === 'zimmer' && (
          <button type="button" className={`${KNOPF} ml-auto`}
                  disabled={zeilen.length === 0 || luecken.length > 0
                            || einrichtung.isPending}
                  onClick={() => darfPreise ? setSchritt('preise') : vorschau()}>
            {t('first.next')}
          </button>
        )}
        {schritt === 'preise' && (
          <button type="button" className={KNOPF}
                  disabled={luecken.length > 0 || einrichtung.isPending}
                  onClick={vorschau}>
            {t('first.next')}
          </button>
        )}
        {schritt === 'pruefen' && (
          <button type="button" className={KNOPF}
                  disabled={bericht === null || einrichtung.isPending}
                  onClick={anlegen}>
            {t('first.create')}
          </button>
        )}
      </>

  return (
    // Nicht durch einen Klick daneben schliessen: zehn Zeilen Eingabe waeren
    // mit einem Ausrutscher weg. Escape und das Kreuz bleiben.
    <Dialog titel={t('first.title')} breite="weit" fuss={fuss} onClose={onClose}
            nebenbeiSchliessen={false}
            unterzeile={
              <span className="inline-flex gap-3">
                {SCHRITTE.filter(([s]) => darfPreise || s !== 'preise').map(([s, k]) => (
                  <span key={s} className={s === schritt
                    ? 'text-neutral-900 font-medium' : 'text-neutral-400'}>{t(k)}</span>
                ))}
              </span>
            }>
      {schritt === 'zimmer' && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-700">{t('first.intro')}</p>
          {bildschirme.includes(IMPORT_BILDSCHIRM) && (
            <div className="flex flex-wrap items-center gap-3 rounded-sm border
                            border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
              <span className="grow">{t('first.importHint')}</span>
              <button type="button" className={KNOPF_LEISE}
                      onClick={() => gehe(IMPORT_BILDSCHIRM)}>
                {t('first.importButton')}
              </button>
            </div>
          )}
          <div>
            <h3 className="text-sm font-medium">{t('first.roomsTitle')}</h3>
            <p className="text-xs text-neutral-500">{t('first.roomsHint')}</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-600">
                <th className="pb-1 pr-2 font-normal w-24">{t('first.code')}</th>
                <th className="pb-1 pr-2 font-normal">{t('first.name')}</th>
                <th className="pb-1 pr-2 font-normal w-24">{t('first.persons')}</th>
                <th className="pb-1 pr-2 font-normal w-24">{t('first.count')}</th>
                <th className="pb-1 pr-2 font-normal w-24">{t('first.prefix')}</th>
                <th className="pb-1 pr-2 font-normal w-28">{t('first.from')}</th>
                <th className="pb-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z, i) => {
                const nummern = zimmerNummern(z)
                return (
                  <tr key={i} className="align-top">
                    <td className="pr-2 pb-2">
                      <input className={FELD} value={z.code} maxLength={20}
                             aria-label={t('first.code')}
                             onChange={e => aendern(i, { code: e.target.value })} />
                    </td>
                    <td className="pr-2 pb-2">
                      <input className={FELD} value={z.name} aria-label={t('first.name')}
                             onChange={e => aendern(i, { name: e.target.value })} />
                      {nummern.length > 0 && (
                        <span className="block text-[11px] text-neutral-400 tabular-nums">
                          {nummern.length > 3
                            ? `${nummern[0]}, ${nummern[1]} … ${nummern.at(-1)}`
                            : nummern.join(', ')}
                        </span>
                      )}
                    </td>
                    <td className="pr-2 pb-2">
                      <input className={FELD} type="number" min={1} max={30}
                             value={z.personen} aria-label={t('first.persons')}
                             onChange={e => aendern(i, { personen: Number(e.target.value) })} />
                    </td>
                    <td className="pr-2 pb-2">
                      <input className={FELD} type="number" min={1} max={1000}
                             value={z.anzahl} aria-label={t('first.count')}
                             onChange={e => aendern(i, { anzahl: Number(e.target.value) })} />
                    </td>
                    <td className="pr-2 pb-2">
                      <input className={FELD} value={z.vorsatz} maxLength={10}
                             aria-label={t('first.prefix')}
                             onChange={e => aendern(i, { vorsatz: e.target.value })} />
                    </td>
                    <td className="pr-2 pb-2">
                      <input className={FELD} type="number" min={0} value={z.ab}
                             aria-label={t('first.from')}
                             onChange={e => aendern(i, { ab: Number(e.target.value) })} />
                    </td>
                    <td className="pb-2">
                      <button type="button" aria-label={t('first.removeRow')}
                              title={t('first.removeRow')}
                              disabled={zeilen.length === 1}
                              onClick={() => {
                                setZeilen(zs => zs.filter((_, j) => j !== i))
                                setBericht(null)
                              }}
                              className="px-2 py-2 text-neutral-400 hover:text-neutral-900
                                         disabled:opacity-30">
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex items-center gap-3">
            <button type="button" className={KNOPF_LEISE}
                    onClick={() => {
                      // Die naechste Art beginnt eine Hunderterreihe weiter,
                      // damit sich die Nummern nicht schon beim Anlegen der
                      // Zeile ueberschneiden.
                      const hoechste = Math.max(0, ...zeilen.map(z => z.ab + z.anzahl))
                      setZeilen(zs => [...zs, { code: '', name: '', personen: 2, anzahl: 1,
                        ab: Math.ceil((hoechste + 1) / 100) * 100 + 1, vorsatz: '',
                        preis: '' }])
                      setBericht(null)
                    }}>
              + {t('first.addRow')}
            </button>
            {luecken.length > 0 && (
              <span className="text-xs text-amber-800">{t('first.rowIncomplete')}</span>
            )}
          </div>
        </div>
      )}

      {schritt === 'preise' && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t('first.pricesTitle')}</h3>
            <p className="text-xs text-neutral-500">{t('first.pricesHint')}</p>
          </div>
          <div className="max-w-xl space-y-2">
            {zeilen.map((z, i) => (
              <label key={i} className="flex items-center gap-3 text-sm">
                <span className="grow">{z.code} · {z.name}</span>
                <span className="text-xs text-neutral-500">{t('first.pricePerNight')}</span>
                <input className={`${FELD} w-32 text-right tabular-nums`} inputMode="decimal"
                       value={z.preis} placeholder="0,00"
                       onChange={e => aendern(i, { preis: e.target.value })} />
              </label>
            ))}
            <label className="flex items-center gap-3 pt-2 text-sm">
              <span className="grow">{t('first.rateName')}</span>
              <input className={`${FELD} w-64`} value={ratenName} maxLength={80}
                     onChange={e => setRatenName(e.target.value)} />
            </label>
          </div>
        </div>
      )}

      {schritt === 'pruefen' && bericht !== null && (
        <div className="space-y-4 text-sm">
          <h3 className="font-medium">{t('first.checkTitle')}</h3>
          {!darfPreise && (
            <p className="text-amber-800">{t('first.noPricePermission')}</p>
          )}
          <ul className="space-y-3">
            {bericht.categories.map(c => (
              <li key={c.code}>
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{c.code} · {c.name}</span>
                  <span className="text-neutral-500">
                    {t('first.checkRooms', { n: c.rooms.length })}
                  </span>
                  <span className="text-neutral-700 tabular-nums">
                    {c.priceCent === null
                      ? t('first.checkNoRate')
                      : `${formatMoney(c.priceCent, locale)} · ${ratenName}`}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.rooms.map(r => (
                    <span key={r} className="px-1.5 py-0.5 rounded-sm bg-emerald-50 border
                                             border-emerald-200 text-xs tabular-nums">
                      {r}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {bericht.pricedFrom !== null && bericht.pricedTo !== null
            ? <p className="text-neutral-600">
                {t('first.checkPeriod', { from: formatDate(bericht.pricedFrom, locale),
                                          to: formatDate(bericht.pricedTo, locale) })}
              </p>
            : <p className="text-amber-800">{t('first.checkNoPrices')}</p>}
        </div>
      )}

      {schritt === 'fertig' && bericht?.created !== undefined && (
        <div className="space-y-5 text-sm">
          <div>
            <h3 className="text-base font-medium text-emerald-800">
              ✓ {t('first.doneTitle')}
            </h3>
            <p className="text-neutral-700">
              {t('first.doneSummary', { categories: bericht.created.categories,
                                        rooms: bericht.created.rooms,
                                        rates: bericht.created.ratePlans })}
            </p>
          </div>
          {bildschirme.includes('rates') && (
            <div className="rounded-sm border border-neutral-200 p-4">
              <h4 className="font-medium">{t('first.priceListTitle')}</h4>
              <p className="mt-1 text-neutral-600">{t('first.priceListHint')}</p>
              <button type="button" className={`${KNOPF} mt-3`} onClick={() => gehe('rates')}>
                {t('first.toRates')}
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {bildschirme.includes('tape') && (
              <button type="button" className={KNOPF_LEISE} onClick={() => gehe('tape')}>
                {t('first.toPlan')}
              </button>
            )}
            {bildschirme.includes('setup') && (
              <button type="button" className={KNOPF_LEISE} onClick={() => gehe('setup')}>
                {t('first.toSetup')}
              </button>
            )}
            <span className="text-xs text-neutral-500">{t('first.setupHint')}</span>
          </div>
        </div>
      )}

      {einrichtung.isError && <div className="mt-4"><Fehler error={einrichtung.error} /></div>}
    </Dialog>
  )
}
