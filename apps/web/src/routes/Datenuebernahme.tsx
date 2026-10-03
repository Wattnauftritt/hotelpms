import { useMemo, useState } from 'react'
import type { KwhotelImportReport, KwhotelImportRequest, KwhotelRoomMatch } from '@hotelpms/contracts'
import { useCategories, useRooms } from '../lib/queries.js'
import { useKwhotelImport } from '../lib/queries/altsystem.js'
import { auszugAusAbzug, KWHOTEL_TABELLEN, namenAus, zahlenAus } from '../lib/altsystem.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { apiText, fehlerMeldung } from '../lib/meldungen.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Übernahme aus einem Altsystem. Zuerst KWHotel: die `.bak` ist dessen
 * Datenbankabzug, und der Bestand eines Hauses liegt darin vollständig.
 *
 * **Prüfen vor Übernehmen.** Die Schnittstelle prüft im Trockenlauf genau
 * das, was sie beim Übernehmen täte, und rollt zurück. Der Knopf zum
 * Übernehmen erscheint erst nach einer fehlerfreien Prüfung mit genau
 * diesen Einstellungen; wer danach etwas ändert, prüft neu.
 *
 * **Die Datei bleibt im Speicher dieser Seite.** Kein `localStorage`, kein
 * Zwischenspeicher der Abfragen: sie trägt Gastnamen, und wer die Seite
 * verlässt, soll sie nicht beim nächsten Mal noch vorfinden.
 *
 * **Fehlende Zimmer werden gefragt, nicht angelegt.** Ein Zimmer aus dem
 * Abzug, das es hier nicht gibt, lässt sich zuordnen, auslassen oder neu
 * anlegen, mit eigener Nummer und Zimmergruppe. Vorbelegt ist, was KWHotel
 * dazu weiß; angelegt wird erst mit der Übernahme und in derselben
 * Transaktion, so dass eine abgebrochene Übernahme keine Zimmer hinterlässt.
 */
export function Datenuebernahme({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const zimmer = useRooms(propertyId, true)
  const gruppen = useCategories(propertyId)

  if (zimmer.isError) return <Fehler error={zimmer.error} />
  if (gruppen.isError) return <Fehler error={gruppen.error} />
  if (zimmer.data === undefined || gruppen.data === undefined) return <Laedt />

  return (
    <div className="space-y-6 max-w-5xl">
      <section className="bg-white border border-neutral-200 rounded-sm p-4 space-y-3">
        <h2 className="text-sm font-medium">{t('import.title')}</h2>
        <label className="block w-64">
          <span className="block text-xs text-neutral-600">{t('import.system')}</span>
          {/* Eine Auswahl mit einem Eintrag: die naechsten Altsysteme kommen
              hier dazu, ohne dass sich der Bildschirm aendert. */}
          <select className={FELD} value="kwhotel" disabled>
            <option value="kwhotel">KWHotel</option>
          </select>
        </label>
        <KwhotelUebernahme propertyId={propertyId}
          zimmer={zimmer.data.rooms.map(z => ({ id: z.id, code: z.code,
                                               categoryCode: z.categoryCode }))}
          gruppen={gruppen.data.categories.map(g => ({ id: g.id, code: g.code, name: g.name }))} />
      </section>
    </div>
  )
}

const FELD = 'mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'
const KNOPF = 'text-sm px-3 py-1.5 rounded-sm border border-neutral-300 hover:bg-neutral-50 '
            + 'disabled:opacity-50'

interface Zimmer { id: number; code: string; categoryCode: string }
interface Gruppe { id: number; code: string; name: string }

/** Ein Zimmer, das mit der Übernahme neu angelegt wird. */
interface NeuesZimmer {
  code: string
  /** Eine vorhandene Zimmergruppe, oder `null` für eine neue. */
  gruppe: number | null
  gruppeCode: string
  gruppeName: string
  belegung: string
}

interface Einstellungen {
  ausschluss: string
  ab: string
  aktiv: string
  storno: string
  karte: Record<string, number | null>
  neu: Record<string, NeuesZimmer>
}

/**
 * Der Vorschlag der Schnittstelle als Eingabe. Gibt es das Kürzel schon als
 * Gruppe, ist sie vorgewählt: "DZ" aus KWHotel ist fast immer das "DZ" hier.
 */
function ausVorschlag(r: KwhotelRoomMatch, gruppen: Gruppe[]): NeuesZimmer {
  const s = r.suggestion
  const da = gruppen.find(g => g.code.toLowerCase() === s.categoryCode.toLowerCase())
  return { code: s.code, gruppe: da?.id ?? null, gruppeCode: s.categoryCode,
           gruppeName: s.categoryName, belegung: String(s.maxOccupancy) }
}

function neueZimmer(neu: Record<string, NeuesZimmer>): KwhotelImportRequest['createRooms'] {
  return Object.entries(neu).map(([kwRoomId, n]) => ({
    kwRoomId, code: n.code.trim(),
    ...(n.gruppe !== null ? { categoryId: n.gruppe } : {
      newCategory: { code: n.gruppeCode.trim(), name: n.gruppeName.trim(),
                     maxOccupancy: Number(n.belegung) } })
  }))
}

function KwhotelUebernahme({ propertyId, zimmer, gruppen }: {
  propertyId: number; zimmer: Zimmer[]; gruppen: Gruppe[]
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const lauf = useKwhotelImport(propertyId)
  const [datei, setDatei] = useState<{ name: string; groesse: number; text: string } | null>(null)
  const [e, setE] = useState<Einstellungen>({
    ausschluss: '', ab: '', aktiv: '0, 1, 2, 4', storno: '10, 11, 12, 13, 14, 19, 22', karte: {}, neu: {}
  })
  const [bericht, setBericht] = useState<KwhotelImportReport | null>(null)
  // Mit welchen Einstellungen der Bericht entstand. Uebernommen wird nur,
  // was genau so geprueft wurde.
  const [geprueft, setGeprueft] = useState<string | null>(null)
  const stand = useMemo(() => JSON.stringify(e), [e])

  const anfrage = (commit: boolean) => ({
    data: datei!.text,
    commit,
    excludeGuestNames: namenAus(e.ausschluss),
    activeStatus: zahlenAus(e.aktiv),
    canceledStatus: zahlenAus(e.storno),
    roomMap: e.karte,
    ...(Object.keys(e.neu).length > 0 ? { createRooms: neueZimmer(e.neu) } : {}),
    ...(e.ab !== '' ? { fromDate: e.ab } : {})
  })

  const pruefen = () => {
    const fuer = stand
    lauf.mutate(anfrage(false), {
      onSuccess: b => { setBericht(b); setGeprueft(fuer) }
    })
  }
  const uebernehmen = () => {
    lauf.mutate(anfrage(true), {
      onSuccess: b => {
        setBericht(b)
        setGeprueft(null)
        // Die neuen Zimmer gibt es jetzt; sie stehen ab hier in der Auswahl.
        setE(x => ({ ...x, neu: {} }))
      }
    })
  }

  const fehlerfrei = bericht !== null && bericht.dryRun
    && !bericht.findings.some(f => f.level === 'error')
  const bereit = fehlerfrei && geprueft === stand && bericht.imported > 0
  const fehler = lauf.isError ? fehlerMeldung(lauf.error, locale) : null

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1)

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-600">{t('import.kwhotel.hint')}</p>
      <label className="inline-block">
        <span className={KNOPF + ' inline-block cursor-pointer'}>{t('import.file')}</span>
        <input type="file" accept=".bak,.sql,text/plain" className="sr-only"
               onChange={async ev => {
                 const f = ev.target.files?.[0]
                 if (f === undefined) return
                 const voll = await f.text()
                 setDatei({ name: f.name, groesse: f.size,
                            text: auszugAusAbzug(voll, KWHOTEL_TABELLEN) })
                 setBericht(null)
                 setGeprueft(null)
                 setE(x => ({ ...x, karte: {}, neu: {} }))
               }} />
      </label>
      {datei !== null && (
        <p className="text-xs text-neutral-500">
          {t('import.fileRead', { name: datei.name, size: mb(datei.groesse),
                                  sent: mb(new Blob([datei.text]).size) })}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block md:col-span-2">
          <span className="block text-xs text-neutral-600">{t('import.exclude')}</span>
          <input className={FELD} value={e.ausschluss} placeholder="ungereinigt"
                 onChange={ev => setE({ ...e, ausschluss: ev.target.value })} />
          <span className="block text-[11px] text-neutral-400">{t('import.exclude.hint')}</span>
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('import.statusActive')}</span>
          <input className={FELD} value={e.aktiv}
                 onChange={ev => setE({ ...e, aktiv: ev.target.value })} />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('import.statusCanceled')}</span>
          <input className={FELD} value={e.storno}
                 onChange={ev => setE({ ...e, storno: ev.target.value })} />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('import.fromDate')}</span>
          <input type="date" className={FELD} value={e.ab}
                 onChange={ev => setE({ ...e, ab: ev.target.value })} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={KNOPF} disabled={datei === null || lauf.isPending}
                onClick={pruefen}>
          {lauf.isPending ? t('import.checking') : t('import.check')}
        </button>
        {bereit && (
          <button type="button" disabled={lauf.isPending} onClick={uebernehmen}
                  className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                             disabled:opacity-50">
            {t('import.commit', { n: bericht.imported })}
          </button>
        )}
      </div>
      {fehlerfrei && <p className="text-[11px] text-neutral-400">{t('import.commit.hint')}</p>}
      {fehler !== null && <p className="text-sm text-red-700">{fehler.text}</p>}

      {bericht !== null && (
        <Bericht bericht={bericht} zimmer={zimmer} gruppen={gruppen}
                 einstellungen={e} setEinstellungen={setE} />
      )}
    </div>
  )
}

function Bericht({ bericht: b, zimmer, gruppen, einstellungen: e,
                   setEinstellungen: setE }: {
  bericht: KwhotelImportReport; zimmer: Zimmer[]; gruppen: Gruppe[]
  einstellungen: Einstellungen; setEinstellungen: (e: Einstellungen) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const c = b.counts
  const zahl = (n: number) => n.toLocaleString(locale)

  return (
    <div className="space-y-5 border-t border-neutral-200 pt-4">
      {b.dryRun
        ? <p className="text-xs text-amber-800">{t('import.dryRun')}</p>
        : <p className="text-sm text-emerald-800">{t('import.done', { n: zahl(b.imported) })}</p>}
      {b.range !== null && (
        <p className="text-sm">
          {t('import.summary', { hotel: b.hotelName ?? 'KWHotel', rows: zahl(b.rows),
                                 from: formatDate(b.range.from, locale),
                                 to: formatDate(b.range.to, locale),
                                 date: formatDate(b.businessDate, locale) })}
        </p>
      )}

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-sm">
        {([['import.count.confirmed', c.confirmed], ['import.count.inHouse', c.inHouse],
           ['import.count.checkedOut', c.checkedOut], ['import.count.canceled', c.canceled],
           ['import.count.placeholder', c.placeholder],
           ['import.count.alreadyImported', c.alreadyImported],
           ['import.count.beforeFrom', c.beforeFrom],
           ['import.count.roomSkipped', c.roomSkipped],
           ['import.count.guests', c.guests]] as const).map(([k, n]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-neutral-600">{t(k)}</dt>
            <dd className="tabular-nums">{zahl(n)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-2 md:col-span-2">
          <dt className="text-neutral-600">
            {t('import.count.bookings', { groups: zahl(c.groupBookings) })}
          </dt>
          <dd className="tabular-nums">{zahl(c.bookings)}</dd>
        </div>
      </dl>
      {c.multiGuest > 0 && (
        <p className="text-xs text-neutral-500">{t('import.multiGuest', { n: zahl(c.multiGuest) })}</p>
      )}

      <div>
        <h3 className="text-xs font-medium text-neutral-700">{t('import.findings')}</h3>
        {b.findings.length === 0
          ? <p className="text-sm text-neutral-500">{t('import.noFindings')}</p>
          : (
            <ul className="mt-1 space-y-1">
              {b.findings.map((f, i) => (
                <li key={i} className={`text-sm ${f.level === 'error'
                                                  ? 'text-red-700' : 'text-amber-800'}`}>
                  {apiText(f.messageKey, f.message, locale, f.params)}
                </li>
              ))}
            </ul>
          )}
      </div>

      <div>
        <h3 className="text-xs font-medium text-neutral-700">{t('import.names')}</h3>
        <p className="text-[11px] text-neutral-400">{t('import.names.hint')}</p>
        <ul className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-6 text-sm">
          {b.frequentNames.map(n => (
            <li key={n.name} className="flex items-center justify-between gap-2">
              <span>{n.name} <span className="text-neutral-400 tabular-nums">{zahl(n.count)}</span></span>
              {n.excluded
                ? <span className="text-xs text-neutral-500">{t('import.names.excluded')}</span>
                : (
                  <button type="button" className="text-xs underline text-neutral-600"
                          onClick={() => setE({ ...e, ausschluss: [...namenAus(e.ausschluss),
                                                                  n.name].join(', ') })}>
                    {t('import.names.exclude')}
                  </button>
                )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-medium text-neutral-700">{t('import.statusCodes')}</h3>
        <ul className="mt-1 flex flex-wrap gap-x-4 text-sm">
          {b.statusCodes.map(s => (
            <li key={s.code} className={s.group === null ? 'text-red-700' : ''}>
              {s.code}: {zahl(s.count)} ({t(s.group === 'active' ? 'import.status.active'
                : s.group === 'canceled' ? 'import.status.canceled' : 'import.status.unknown')})
            </li>
          ))}
        </ul>
      </div>

      <Zimmerzuordnung bericht={b} zimmer={zimmer} gruppen={gruppen}
                       einstellungen={e} setEinstellungen={setE} />
    </div>
  )
}

/**
 * Zimmer aus KWHotel auf Zimmer hier. Ein Zimmer ohne Gegenstück wird nicht
 * still angelegt: wer übernimmt, entscheidet je Zimmer, ob es ein neues ist,
 * ein vorhandenes unter anderer Nummer, oder eines, dessen Reservierungen
 * nicht mitkommen sollen.
 */
function Zimmerzuordnung({ bericht: b, zimmer, gruppen, einstellungen: e,
                           setEinstellungen: setE }: {
  bericht: KwhotelImportReport; zimmer: Zimmer[]; gruppen: Gruppe[]
  einstellungen: Einstellungen; setEinstellungen: (e: Einstellungen) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const zahl = (n: number) => n.toLocaleString(locale)

  // Was im letzten Bericht ohne Gegenstück war und noch nicht entschieden ist.
  const offen = b.rooms.filter(r => r.match === 'none' && r.reservations > 0
                                    && !(r.kwRoomId in e.karte) && !(r.kwRoomId in e.neu))

  const setze = (kw: string, wert: string) => {
    const karte = { ...e.karte }
    const neu = { ...e.neu }
    delete karte[kw]
    delete neu[kw]
    const r = b.rooms.find(x => x.kwRoomId === kw)!
    if (wert === 'new') neu[kw] = ausVorschlag(r, gruppen)
    else karte[kw] = wert === 'skip' ? null : Number(wert)
    setE({ ...e, karte, neu })
  }
  const aendere = (kw: string, n: Partial<NeuesZimmer>) =>
    setE({ ...e, neu: { ...e.neu, [kw]: { ...e.neu[kw]!, ...n } } })

  return (
    <div>
      <h3 className="text-xs font-medium text-neutral-700">{t('import.rooms')}</h3>
      <p className="text-[11px] text-neutral-400">{t('import.rooms.hint')}</p>
      {offen.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-red-700">
          <span>{t('import.rooms.missing', { n: zahl(offen.length) })}</span>
          <button type="button" className={KNOPF}
                  onClick={() => {
                    const neu = { ...e.neu }
                    for (const r of offen) neu[r.kwRoomId] = ausVorschlag(r, gruppen)
                    setE({ ...e, neu })
                  }}>
            {t('import.rooms.createAll')}
          </button>
        </div>
      )}
      <table className="mt-1 text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th className="pr-6 font-normal">{t('import.rooms.kw')}</th>
            <th className="pr-6 font-normal text-right">{t('import.rooms.reservations')}</th>
            <th className="font-normal">{t('import.rooms.target')}</th>
          </tr>
        </thead>
        <tbody>
          {b.rooms.map(r => {
            const n = e.neu[r.kwRoomId]
            // Die eigene Aenderung gilt, bis neu geprueft ist; sonst
            // spraenge die Auswahl auf den Stand des letzten Berichts zurueck.
            // Ein im Trockenlauf angelegtes Zimmer ist zurueckgerollt und
            // steht nicht in der Liste; es bleibt "neu anlegen".
            const ziel = r.kwRoomId in e.karte ? e.karte[r.kwRoomId]
              : r.match === 'skipped' ? null
              : r.match === 'created' ? undefined : r.resourceId ?? undefined
            const wert = n !== undefined ? 'new'
              : ziel === null ? 'skip' : ziel === undefined ? '' : String(ziel)
            return (
              <tr key={r.kwRoomId} className="align-top">
                <td className="pr-6 py-0.5">{r.name}</td>
                <td className="pr-6 py-0.5 text-right tabular-nums">{zahl(r.reservations)}</td>
                <td className="py-0.5">
                  <select value={wert} aria-label={r.name}
                          className={`border rounded-sm px-1 py-0.5 text-sm ${
                            wert === '' && r.reservations > 0
                              ? 'border-red-400' : 'border-neutral-300'}`}
                          onChange={ev => setze(r.kwRoomId, ev.target.value)}>
                    <option value="" disabled>{t('import.rooms.none')}</option>
                    <option value="skip">{t('import.rooms.skip')}</option>
                    <option value="new">{t('import.rooms.create')}</option>
                    {zimmer.map(z => (
                      <option key={z.id} value={z.id}>{z.code} ({z.categoryCode})</option>
                    ))}
                  </select>
                  {n !== undefined && (
                    <NeuesZimmerFelder wert={n} gruppen={gruppen}
                                       aendere={x => aendere(r.kwRoomId, x)} />
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function NeuesZimmerFelder({ wert: n, gruppen, aendere }: {
  wert: NeuesZimmer; gruppen: Gruppe[]; aendere: (n: Partial<NeuesZimmer>) => void
}): JSX.Element {
  const t = useT()
  const klein = 'border border-neutral-300 rounded-sm px-1 py-0.5 text-sm'
  return (
    <div className="mt-1 mb-2 flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="block text-[11px] text-neutral-500">{t('import.rooms.newCode')}</span>
        <input className={klein + ' w-20'} value={n.code} maxLength={20}
               onChange={ev => aendere({ code: ev.target.value })} />
      </label>
      <label className="block">
        <span className="block text-[11px] text-neutral-500">{t('import.rooms.category')}</span>
        <select className={klein} value={n.gruppe === null ? 'new' : String(n.gruppe)}
                onChange={ev => aendere({ gruppe: ev.target.value === 'new'
                                                  ? null : Number(ev.target.value) })}>
          <option value="new">{t('import.rooms.newCategory')}</option>
          {gruppen.map(g => <option key={g.id} value={g.id}>{g.code} ({g.name})</option>)}
        </select>
      </label>
      {n.gruppe === null && (
        <>
          <label className="block">
            <span className="block text-[11px] text-neutral-500">
              {t('import.rooms.categoryCode')}
            </span>
            <input className={klein + ' w-20'} value={n.gruppeCode} maxLength={10}
                   onChange={ev => aendere({ gruppeCode: ev.target.value })} />
          </label>
          <label className="block">
            <span className="block text-[11px] text-neutral-500">
              {t('import.rooms.categoryName')}
            </span>
            <input className={klein + ' w-48'} value={n.gruppeName} maxLength={80}
                   onChange={ev => aendere({ gruppeName: ev.target.value })} />
          </label>
          <label className="block">
            <span className="block text-[11px] text-neutral-500">
              {t('import.rooms.maxOccupancy')}
            </span>
            <input type="number" min={1} max={99} className={klein + ' w-16'} value={n.belegung}
                   onChange={ev => aendere({ belegung: ev.target.value })} />
          </label>
        </>
      )}
    </div>
  )
}
