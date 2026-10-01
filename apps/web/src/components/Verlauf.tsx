import type { JSX } from 'react'
import { useVerlauf, type Aenderung, type Verlauf as VerlaufDaten }
  from '../lib/queries/booking.js'
import { useT, useLocale, formatDate, formatMoney, intlTag, type TextKey, type Locale }
  from '../lib/i18n/index.js'
import { Dialog, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Wer hat was geaendert -- am Haus, an einer Buchung, an einem Zimmer.
 *
 * **Warum es das gibt.** Am Zimmerplan schieben mehrere Menschen an mehreren
 * Rechnern den ganzen Tag Balken. Die Frage "wer hat das verlegt, und worauf
 * stand es vorher" war bisher nur in der Datenbank zu beantworten, also gar
 * nicht. Sie kommt nicht aus Neugier: steht ein Gast an der Rezeption und
 * sein Zimmer ist belegt, entscheidet die Antwort darueber, ob der Fehler
 * zurueckgenommen oder wiederholt wird.
 *
 * **Die Daten sind nicht neu.** Der Audit-Trigger schreibt jede Aenderung
 * mit, seit es das Schema gibt; sie wurden nur nie gelesen. Hier steht
 * deshalb keine zusaetzliche Protokollierung, sondern die erste Ansicht
 * darauf.
 *
 * **Was nicht drinsteht.** Was `audit_redaction` redigiert, hat nie einen
 * Wert im Protokoll gehabt: Name, Anschrift, Notiz, Unterschrift. Dort steht
 * "geaendert" und nicht, was darin stand -- und das bleibt so, weil sonst
 * die Loeschung nach Art. 17 eine Kopie zuruecklaesst, die niemand entfernen
 * kann.
 */

/** Felder, deren Wert eine Kennung ist und deren Name eine Nummer. */
const ZIMMER_FELDER = new Set(['resource_id'])
const GRUPPEN_FELDER = new Set(['category_id'])
const GELD_FELDER = new Set(['price_cent', 'net_cent', 'tax_cent', 'gross_cent',
                             'cancellation_fee_cent'])
const DATUM_FELDER = new Set(['arrival', 'departure', 'business_date',
                              'from_date', 'to_date'])
/**
 * Felder, deren Wert eine Kennung aus einer anderen Tabelle ist.
 *
 * Sie bleiben Kennung: "Hauptgast 9" liest sich wie eine Anzahl, "#9" nicht.
 * Den Namen dazu holen hiesse, fuer jede Zeile eine weitere Tabelle
 * mitzuschicken -- und beim Gast waere es zudem ein Name mehr an einer
 * Stelle, an der schon einer steht.
 */
const KENNUNG_FELDER = new Set(['primary_guest_id', 'booker_guest_id',
                                'booker_company_id', 'rate_plan_id',
                                'invoice_id', 'reverses_id'])

/**
 * Spaltenname → Beschriftung, und Tabellenname → Gegenstand.
 *
 * Als Tabelle und nicht als zusammengesetzter Schluessel (`verlauf.feld.` +
 * Name): der Katalog ist getippt, und ein zusammengesetzter Schluessel
 * umgeht genau die Pruefung, die eine fehlende Uebersetzung zum Typfehler
 * macht. Was hier fehlt, erscheint als Spaltenname -- lesbar genug, um es zu
 * bemerken, und ohne die Zeile zu verschlucken.
 */
const FELD_TEXT: Record<string, TextKey> = {
  arrival: 'booking.arrival',
  departure: 'booking.departure',
  resource_id: 'verlauf.feld.room',
  category_id: 'verlauf.feld.category',
  status: 'verlauf.feld.status',
  rate_plan_id: 'verlauf.feld.ratePlan',
  primary_guest_id: 'verlauf.feld.guest',
  guaranteed: 'verlauf.feld.guaranteed',
  option_expires_at: 'verlauf.feld.optionExpires',
  cancellation_fee_cent: 'verlauf.feld.cancellationFee',
  notes: 'verlauf.feld.notes',
  short_note: 'verlauf.feld.shortNote',
  price_cent: 'verlauf.feld.price',
  description: 'verlauf.feld.description',
  quantity: 'verlauf.feld.quantity',
  net_cent: 'verlauf.feld.net',
  tax_cent: 'verlauf.feld.tax',
  gross_cent: 'verlauf.feld.gross',
  business_date: 'verlauf.feld.businessDate',
  invoice_id: 'verlauf.feld.invoice',
  reverses_id: 'verlauf.feld.reverses',
  from_date: 'common.from',
  to_date: 'common.to',
  kind: 'verlauf.feld.kind',
  reason: 'verlauf.feld.reason',
  source: 'verlauf.feld.source',
  channel_code: 'verlauf.feld.channel',
  external_reference: 'verlauf.feld.externalRef',
  market_segment: 'verlauf.feld.segment',
  commission_bp: 'verlauf.feld.commission',
  booker_guest_id: 'verlauf.feld.booker',
  booker_company_id: 'verlauf.feld.bookerCompany'
}

const TABELLE_TEXT: Record<string, TextKey> = {
  reservation: 'verlauf.tabelle.reservation',
  booking: 'verlauf.tabelle.booking',
  reservation_night: 'verlauf.tabelle.night',
  charge: 'verlauf.tabelle.charge',
  maintenance_block: 'verlauf.tabelle.block'
}

const STATUS_TEXT: Record<string, TextKey> = {
  Optional: 'status.Optional',
  Confirmed: 'status.Confirmed',
  InHouse: 'status.InHouse',
  CheckedOut: 'status.CheckedOut',
  Canceled: 'status.Canceled',
  NoShow: 'status.NoShow'
}

export function VerlaufDialog({ was, titel, unterzeile, onClose }: {
  was:
    | { art: 'haus'; propertyId: number }
    | { art: 'buchung'; ref: string }
    | { art: 'reservierung'; ref: string }
  titel: string
  unterzeile?: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const q = useVerlauf(was)

  return (
    <Dialog breite="breit" onClose={onClose} titel={titel} unterzeile={unterzeile}
            /* "Schliessen" und nicht "Abbrechen": hier ist nichts
               abzubrechen, der Verlauf zeigt nur. */
            fuss={
              <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                {t('common.close')}
              </button>
            }>
      {q.isError && <Fehler error={q.error} />}
      {q.data === undefined && !q.isError && <Laedt />}
      {q.data !== undefined && <Liste daten={q.data} mitBuchung={was.art === 'haus'} />}
    </Dialog>
  )
}

/**
 * Die Liste selbst.
 *
 * Eine Zeile je Aenderung, nicht eine je Feld: "Zimmer 203 → 205, Anreise
 * 13.10. → 16.10." ist **eine** Handlung, und sie auf zwei Zeilen zu
 * verteilen laesst sie wie zwei aussehen.
 */
function Liste({ daten, mitBuchung }: {
  daten: VerlaufDaten; mitBuchung: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()

  if (daten.changes.length === 0) {
    return <p className="text-sm text-neutral-500">{t('verlauf.leer')}</p>
  }

  return (
    <ol className="divide-y divide-neutral-200 text-sm">
      {daten.changes.map(a => (
        <li key={a.id} className="py-2 flex gap-3">
          {/* Zeit und Mensch links, in fester Breite: die Augen laufen beim
              Ueberfliegen eine Spalte hinunter, nicht durch den Fliesstext. */}
          <div className="w-44 shrink-0 text-xs text-neutral-500 tabular-nums">
            <div>{zeitpunkt(a.occurredAt, locale)}</div>
            <div className="truncate" title={a.user ?? ''}>
              {a.user ?? t('verlauf.system')}
            </div>
          </div>
          <div className="grow min-w-0">
            <div className="text-neutral-900">
              <span className="font-medium">{was(a, t)}</span>
              {mitBuchung && a.reservationRef !== null && (
                <span className="text-neutral-500">
                  {' · '}{a.guest ?? t('plan.noGuest')}
                  {a.roomCode !== null && ` · ${a.roomCode}`}
                  {' · '}{a.reservationRef}
                </span>
              )}
            </div>
            <div className="text-neutral-700">{felder(a, daten, t, locale)}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Was passiert ist, in zwei bis drei Woertern. */
function was(a: Aenderung, t: ReturnType<typeof useT>): string {
  const schluessel = TABELLE_TEXT[a.table]
  const tabelle = schluessel === undefined ? a.table : t(schluessel)
  if (a.action === 'INSERT') return t('verlauf.angelegt', { was: tabelle })
  if (a.action === 'DELETE') return t('verlauf.entfernt', { was: tabelle })
  return t('verlauf.geaendert', { was: tabelle })
}

/**
 * Die geaenderten Felder als ein Satz.
 *
 * Die Kennung wird dabei zum Namen: im Protokoll steht `resource_id: 7 → 9`,
 * und niemand kennt die 7. Zimmer und Zimmergruppen kommen deshalb als
 * Nachschlagewerk mit der Antwort mit.
 */
function felder(a: Aenderung, daten: VerlaufDaten,
                t: ReturnType<typeof useT>, locale: Locale): string {
  const teile: string[] = []
  // Bei einer Nacht gehoert der Tag dazu: "Preis 90 → 100" ohne ihn ist
  // keine Auskunft.
  const tag = typeof a.rowKey.date === 'string'
    ? `${formatDate(a.rowKey.date, locale)}: ` : ''

  for (const [name, { von, nach }] of Object.entries(a.fields)) {
    const schluessel = FELD_TEXT[name]
    const label = schluessel === undefined ? name : t(schluessel)
    const links = wert(name, von, daten, t, locale)
    const rechts = wert(name, nach, daten, t, locale)

    if (a.action === 'UPDATE') {
      if (links === rechts) continue
      teile.push(`${tag}${label} ${links} → ${rechts}`)
      continue
    }
    /*
     * Beim Anlegen und Entfernen zaehlt nur, was dasteht.
     *
     * Vorher stand hinter jeder neuen Reservierung "Option bis —,
     * Stornogebuehr —, Notiz geaendert, Kurznotiz geaendert": drei leere
     * Felder und zwei, die behaupten, jemand haette etwas geaendert, wo
     * gerade erst etwas entstanden ist. Die Zeile war dreimal so lang und
     * sagte weniger.
     */
    const gezeigt = a.action === 'DELETE' ? links : rechts
    if (gezeigt === '—' || gezeigt === t('verlauf.redigiert')) continue
    teile.push(`${tag}${label} ${gezeigt}`)
  }
  return teile.join(' · ')
}

function wert(name: string, v: unknown, daten: VerlaufDaten,
              t: ReturnType<typeof useT>, locale: Locale): string {
  if (v === null || v === undefined) return '—'
  // Der Trigger legt redigierte Felder so ab. Dass etwas geaendert wurde,
  // ist die Auskunft; was, steht bewusst nirgends.
  if (v === '[redigiert]') return t('verlauf.redigiert')
  if (ZIMMER_FELDER.has(name)) return daten.rooms[String(v)] ?? `#${String(v)}`
  if (GRUPPEN_FELDER.has(name)) return daten.categories[String(v)] ?? `#${String(v)}`
  if (KENNUNG_FELDER.has(name)) return `#${String(v)}`
  if (GELD_FELDER.has(name)) return formatMoney(Number(v), locale)
  if (DATUM_FELDER.has(name) && typeof v === 'string') {
    return formatDate(v.slice(0, 10), locale)
  }
  if (name === 'status' && typeof v === 'string') {
    const schluessel = STATUS_TEXT[v]
    return schluessel === undefined ? v : t(schluessel)
  }
  if (typeof v === 'boolean') return v ? t('verlauf.ja') : t('verlauf.nein')
  return String(v)
}

/** Datum und Uhrzeit. Die Uhrzeit ist hier der Punkt -- "heute" reicht nicht. */
function zeitpunkt(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(intlTag(locale), {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}
