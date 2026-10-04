import { addDays, isIsoDate } from '@hotelpms/domain'
import { DumpFormatError, readDumpTables, tableRecords } from './mysqlDump.js'

/**
 * Der Bestand eines KWHotel-Hauses, gelesen aus dessen Datenbankabzug.
 *
 * KWHotel sichert seine MariaDB als Textabzug und nennt die Datei `.bak`.
 * Die Tabellen sind polnisch benannt; was sie bedeuten, hat das Adminpanel
 * aus seinen Abfragen abgeleitet und am 03.10.2026 an einem echten Abzug
 * bestaetigt (API-Entwurf fuers Adminpanel, Abschnitt 3.7):
 *
 * | Tabelle        | Inhalt                                               |
 * |----------------|------------------------------------------------------|
 * | `Rezerwacje`   | eine Zeile je Zimmer und Aufenthalt                  |
 * | `Klienci`      | Gaeste; `Nazwisko` traegt oft den ganzen Namen       |
 * | `RezerwKlient` | Gaeste je Reservierung, mehrere moeglich             |
 * | `Pokoje`       | Zimmer, `Symbol` ist Nummer und Kurzbeschreibung     |
 * | `rooms`        | dieselben Zimmer in neuerer Form, gleiche Nummern    |
 *
 * Hier wird nur gelesen und in Kalenderdaten und Cent uebersetzt. Was davon
 * uebernommen wird -- welcher Status, welches Zimmer, welche Zeile ein
 * Platzhalter ist --, entscheidet `routes/kwhotelImport.ts` mit den Angaben
 * des Hauses.
 */

export interface KwRoom {
  id: string
  /** `rooms.name`, sonst `Pokoje.Symbol`, z. B. "08 FZ" oder "01 EZ Balkon". */
  name: string
  description: string | null
}

export interface KwReservation {
  id: string
  roomId: string | null
  arrival: string
  /**
   * Abreisetag. KWHotel fuehrt in `DataDo` die **letzte Nacht**; eine
   * Zeile mit `DataOd = DataDo` ist eine Nacht, nicht null.
   */
  departure: string
  /** `Cena`: der Preis der ganzen Zeile, nicht je Nacht. */
  totalCent: number
  /**
   * `Osob`: die **Gesamtzahl** der Personen, Kinder eingeschlossen. So
   * pflegt die Rezeption es (Sven, 04.10.2026); die Kinderspalten bleiben
   * meist leer.
   */
  persons: number
  /** `Dzieci1` bis `Dzieci3` zusammen: die Kinder **unter** `persons`, nicht dazu. */
  children: number
  status: number
  groupId: string | null
  guestId: string | null
  /** Alle Gaeste aus `RezerwKlient`, aufsteigend. */
  guestIds: string[]
  notes: string | null
  /** `modefied_date`, Ortszeit ohne Zone. */
  modifiedAt: string | null
}

export interface KwGuest {
  id: string
  name: string
  country: string | null
}

export interface KwhotelBestand {
  hotelName: string | null
  rooms: KwRoom[]
  reservations: KwReservation[]
  guests: Map<string, KwGuest>
}

const TABELLEN = ['Rezerwacje', 'Klienci', 'RezerwKlient', 'Pokoje', 'rooms', 'hotels'] as const

/** Kalenderdatum aus `2026-10-03 00:00:00`. Nie ueber `Date`, siehe CLAUDE.md. */
function datum(v: string | null): string | null {
  if (v === null) return null
  const d = v.slice(0, 10)
  return isIsoDate(d) ? d : null
}

/**
 * `625.5000` in Cent, ohne Fliesskomma. Die vierte Nachkommastelle von
 * `decimal(15,4)` wird kaufmaennisch gerundet.
 */
export function decimalToCent(v: string | null): number | null {
  if (v === null || v === '') return 0
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim())
  if (m === null) return null
  const nachkomma = (m[3] ?? '').padEnd(3, '0')
  let cent = Number(m[2]) * 100 + Number(nachkomma.slice(0, 2))
  if (Number(nachkomma[2]) >= 5) cent += 1
  return m[1] === '-' ? -cent : cent
}

function ganz(v: string | null): number {
  const n = v === null ? 0 : Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Eine Bemerkung ohne die Klammern, in die KWHotel Stornogruende setzt
 * (`{Aus persoenlichen Gruenden\r\n}`), und mit einheitlichen Umbruechen.
 */
function bemerkung(v: string | null): string | null {
  if (v === null) return null
  let s = v.replace(/\r\n?/g, '\n').trim()
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim()
  return s === '' ? null : s
}

export function readKwhotelDump(text: string): KwhotelBestand {
  if (!/^INSERT INTO `Rezerwacje`/m.test(text)) {
    // Die haeufigste Verwechslung: eine andere Datei, oder ein Abzug ohne
    // Daten. Lieber gleich so benennen als "Tabelle fehlt" melden.
    throw new DumpFormatError('import.kwhotel.notADump')
  }
  const t = readDumpTables(text, TABELLEN)

  const pokoje = tableRecords(t, 'Pokoje', ['PokojID', 'Symbol', 'Opis'])
  const rooms = t.has('rooms') ? tableRecords(t, 'rooms', ['id', 'name']) : []
  const neu = new Map(rooms.map(r => [r.id!, r]))
  const zimmer: KwRoom[] = pokoje.map(p => ({
    id: p.PokojID!,
    name: (neu.get(p.PokojID!)?.name ?? p.Symbol ?? '').trim(),
    description: p.Opis ?? null
  }))
  // Ein Zimmer, das nur in der neueren Tabelle steht, gibt es auch.
  for (const r of rooms) {
    if (!zimmer.some(z => z.id === r.id)) {
      zimmer.push({ id: r.id!, name: (r.name ?? '').trim(), description: null })
    }
  }

  const klienci = tableRecords(t, 'Klienci', ['KlientID', 'Nazwisko'])
  const gaeste = new Map<string, KwGuest>()
  for (const k of klienci) {
    const land = (k.Countrie ?? '').trim().toUpperCase()
    gaeste.set(k.KlientID!, {
      id: k.KlientID!,
      name: (k.Nazwisko ?? '').replace(/\s+/g, ' ').trim(),
      country: /^[A-Z]{2}$/.test(land) ? land : null
    })
  }

  const zuordnung = new Map<string, string[]>()
  for (const z of tableRecords(t, 'RezerwKlient', ['RezerwacjaID', 'KlientID'])) {
    const l = zuordnung.get(z.RezerwacjaID!) ?? []
    l.push(z.KlientID!)
    zuordnung.set(z.RezerwacjaID!, l)
  }

  const rez = tableRecords(t, 'Rezerwacje',
    ['RezerwacjaID', 'PokojID', 'DataOd', 'DataDo', 'Cena', 'Osob', 'status_id'])
  const reservierungen: KwReservation[] = []
  for (const r of rez) {
    const von = datum(r.DataOd ?? null)
    const letzte = datum(r.DataDo ?? null)
    const preis = decimalToCent(r.Cena ?? null)
    if (von === null || letzte === null || preis === null) {
      throw new DumpFormatError('import.kwhotel.unreadableRow', { reference: r.RezerwacjaID! })
    }
    const ids = (zuordnung.get(r.RezerwacjaID!) ?? []).sort((a, b) => Number(a) - Number(b))
    const gruppe = r.group_id ?? null
    reservierungen.push({
      id: r.RezerwacjaID!,
      roomId: r.PokojID ?? null,
      arrival: von,
      departure: addDays(letzte, 1),
      totalCent: preis,
      persons: ganz(r.Osob ?? null),
      children: ganz(r.Dzieci1 ?? null) + ganz(r.Dzieci2 ?? null) + ganz(r.Dzieci3 ?? null),
      status: Number(r.status_id),
      groupId: gruppe === null || gruppe === '0' ? null : gruppe,
      guestId: r.KlientID ?? null,
      guestIds: ids,
      notes: bemerkung(r.Uwagi ?? null),
      modifiedAt: r.modefied_date ?? null
    })
  }

  const hotels = t.has('hotels') ? tableRecords(t, 'hotels', ['name']) : []
  return {
    hotelName: hotels[0]?.name ?? null,
    rooms: zimmer,
    reservations: reservierungen,
    guests: gaeste
  }
}
