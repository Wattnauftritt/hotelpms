import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eachNight, isIsoDate } from '@hotelpms/domain'
import { renderMessage, type KwhotelFinding, type KwhotelImportReport,
         type KwhotelRoomMatch, type RoomSuggestion, type MessageKey, type MessageParams } from '@hotelpms/contracts'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { readKwhotelDump, type KwhotelBestand, type KwReservation, type KwRoom }
  from '../platform/legacyImport/kwhotel.js'
import { DumpFormatError } from '../platform/legacyImport/mysqlDump.js'

/**
 * Uebernahme aus KWHotel (Baustein 6 aus dem API-Entwurf fuers Adminpanel).
 *
 * **Warum nicht ueber `runImport` wie hotline, HS/3 und protel.** Jene
 * liefern eine Liste von Reservierungen, die sich Zeile fuer Zeile in die
 * Form des CSV-Imports uebersetzen laesst. KWHotel liefert seine ganze
 * Datenbank, und darin steckt, was diese Form nicht kennt: Zimmer statt
 * Zimmergruppen, Gruppen ueber mehrere Zeilen, Statuscodes, Platzhalter und
 * drei Jahre Vergangenheit. Wer das in den generischen Import presst, baut
 * dort eine zweite Fachlogik ein, die nur ein Altsystem braucht.
 *
 * **Was gleich bleibt.** Trockenlauf als Regelfall, ganz oder gar nicht in
 * einer Transaktion, Kontingent nur ueber `inventory_reserve`, und ein
 * zweiter Lauf desselben Abzugs ueberspringt, was schon da ist -- erkannt an
 * der KWHotel-Nummer in `reservation.legacy_reference` (Migration 0078).
 *
 * **Vergangenheit ist kein Bestand.** Eine Reservierung, deren Abreise am
 * Geschaeftstag oder davor liegt, kommt als `CheckedOut` und bindet kein
 * Kontingent; als `Confirmed` haette sie der Nachtlauf zum No-Show gemacht.
 * Wer gerade im Haus ist, kommt als `InHouse` und bindet nur die Naechte ab
 * heute -- genau die zaehlt der Abgleich in `reconcileInventory`.
 *
 * **Was das Haus entscheidet.** Welche Codes gueltig und welche storniert
 * sind, welche Gastnamen Platzhalter sind und welches KWHotel-Zimmer zu
 * welchem StayGrid-Zimmer gehoert, kommt aus der Anfrage. Fest eingebaut
 * ist nur die Einteilung der Codes als Vorgabe, so wie Sven sie am
 * 03.10.2026 am ersten echten Abzug bestaetigt hat.
 */

const SYSTEM = 'kwhotel'
const AKTIV_VORGABE = [0, 1, 2, 4]
const STORNO_VORGABE = [10, 11, 12, 13, 14, 19, 22]
const MAX_BEFUNDE = 500

interface Body {
  propertyId: number
  data: string
  commit?: boolean
  excludeGuestNames?: unknown
  activeStatus?: unknown
  canceledStatus?: unknown
  roomMap?: unknown
  createRooms?: unknown
  fromDate?: unknown
}

type Ziel = 'Confirmed' | 'InHouse' | 'CheckedOut' | 'Canceled'

/** Ein Name ohne Gross- und Kleinschreibung und ohne Leerzeichen. */
export function nameKey(v: string): string {
  return v.toLowerCase().replace(/\s+/g, '')
}

/**
 * Die Nummer, unter der ein Zimmer in beiden Systemen gleich heisst.
 * KWHotel schreibt "08 FZ" und "8 FZ" durcheinander; StayGrid fuehrt
 * meist "8" oder "08". Verglichen wird die fuehrende Zahl ohne Nullen,
 * sonst der ganze Name.
 */
export function roomKey(v: string): string {
  const m = /^\s*0*(\d+)/.exec(v)
  return m !== null ? (m[1] === '' ? '0' : m[1]!) : nameKey(v)
}

function zahlenliste(v: unknown, feld: string, vorgabe: number[]): number[] {
  if (v === undefined) return vorgabe
  if (!Array.isArray(v) || !v.every(x => Number.isInteger(x))) {
    throw Errors.validation({ [feld]: ['field.allowedValues'] }, { values: 'integer[]' })
  }
  return v as number[]
}

class Befunde {
  readonly liste: KwhotelFinding[] = []
  add(level: 'error' | 'warning', key: MessageKey, params: MessageParams = {},
      reference?: string): void {
    this.liste.push({ level, messageKey: key, message: renderMessage(key, 'de', params),
                      params, ...(reference !== undefined ? { reference } : {}) })
  }
  get fehler(): number { return this.liste.filter(f => f.level === 'error').length }
}

/**
 * Was die Maske fuer ein fehlendes Zimmer vorschlaegt: die Nummer aus dem
 * KWHotel-Namen, die Zimmergruppe aus dessen Kuerzel ("01 EZ Balkon" -> EZ)
 * und Beschreibung, die Belegung aus den Reservierungen, die tatsaechlich auf
 * dem Zimmer lagen. Nur ein Vorschlag -- angelegt wird, was die Anfrage sagt.
 */
export function vorschlag(r: KwRoom, bestand: KwhotelBestand): RoomSuggestion {
  const m = /^\s*0*(\d+)\s*(.*)$/.exec(r.name)
  const code = m !== null ? (m[1] === '' ? '0' : m[1]!) : r.name.trim().slice(0, 20)
  const rest = m !== null ? m[2]! : r.name
  const kuerzel = (/^([A-Za-zÄÖÜäöü]+)/.exec(rest.trim())?.[1] ?? '').toUpperCase().slice(0, 10)
  const name = (r.description ?? '').trim() || rest.trim() || r.name
  let personen = 1
  for (const x of bestand.reservations) {
    if (x.roomId === r.id) personen = Math.max(personen, x.persons)
  }
  return {
    code,
    categoryCode: kuerzel !== '' ? kuerzel : name.slice(0, 3).toUpperCase(),
    categoryName: name.slice(0, 80),
    maxOccupancy: Math.min(personen, 20)
  }
}

/**
 * Legt die Zimmer an, die das Haus im Dialog bestaetigt hat, samt neuer
 * Zimmergruppen, und bereitet den Bestand dafuer vor.
 *
 * In derselben Transaktion wie die Uebernahme: im Trockenlauf wird
 * mitgeprueft und zurueckgerollt, und beim Festschreiben gibt es kein Haus
 * mit neuen Zimmern, aber ohne die Buchungen, fuer die sie angelegt wurden.
 *
 * Eine schon vergebene Nummer oder ein schon vorhandenes Gruppenkuerzel ist
 * ein Befund, kein stilles Zusammenlegen: wer "DZ" neu anlegen will und es
 * gibt "DZ" schon, meint vielleicht eine andere Gruppe.
 */
async function zimmerAnlegen(
  client: PoolClient, propertyId: number, bestand: KwhotelBestand,
  roh: unknown, befunde: Befunde
): Promise<Map<string, number>> {
  const ergebnis = new Map<string, number>()
  if (roh === undefined) return ergebnis
  const ungueltig = () =>
    Errors.validation({ createRooms: ['field.allowedValues'] }, { values: 'object[]' })
  if (!Array.isArray(roh) || roh.length > 500) throw ungueltig()

  interface Auftrag { kwRoomId: string; code: string; categoryId: number | null
                      neu: { code: string; name: string; maxOccupancy: number } | null }
  const auftraege: Auftrag[] = []
  const text = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : null
  for (const e of roh as unknown[]) {
    if (typeof e !== 'object' || e === null) throw ungueltig()
    const o = e as Record<string, unknown>
    const kw = typeof o.kwRoomId === 'string' ? o.kwRoomId : null
    const code = text(o.code, 20)
    const nk = o.newCategory as Record<string, unknown> | undefined
    const neu = nk === undefined || nk === null ? null : {
      code: text(nk.code, 10), name: text(nk.name, 80), maxOccupancy: nk.maxOccupancy }
    const katId = Number.isInteger(o.categoryId) ? o.categoryId as number : null
    if (kw === null || code === null || !bestand.rooms.some(r => r.id === kw)
        || (katId === null) === (neu === null)
        || (neu !== null && (neu.code === null || neu.name === null
            || !Number.isInteger(neu.maxOccupancy) || (neu.maxOccupancy as number) < 1
            || (neu.maxOccupancy as number) > 99))) {
      throw ungueltig()
    }
    auftraege.push({ kwRoomId: kw, code, categoryId: katId,
      neu: neu === null ? null : { code: neu.code!, name: neu.name!,
                                   maxOccupancy: neu.maxOccupancy as number } })
  }
  if (auftraege.length === 0) return ergebnis

  const vorhanden = await client.query<{ code: string }>(
    `SELECT code FROM resource WHERE property_id = $1`, [propertyId])
  const belegt = new Set(vorhanden.rows.map(r => r.code.toLowerCase()))
  const gruppen = await client.query<{ id: number; code: string }>(
    `SELECT id, code FROM resource_category WHERE property_id = $1`, [propertyId])
  const gruppeById = new Set(gruppen.rows.map(g => Number(g.id)))
  const gruppeByCode = new Set(gruppen.rows.map(g => g.code.toLowerCase()))

  const neueGruppen = new Map<string, { code: string; name: string; maxOccupancy: number }>()
  const gesehen = new Set<string>()
  const kwGesehen = new Set<string>()
  let fehler = false
  for (const a of auftraege) {
    const k = a.code.toLowerCase()
    if (belegt.has(k) || gesehen.has(k)) {
      befunde.add('error', 'import.kwhotel.roomCodeTaken', { code: a.code })
      fehler = true
    }
    gesehen.add(k)
    if (kwGesehen.has(a.kwRoomId)) throw ungueltig()
    kwGesehen.add(a.kwRoomId)
    // Eine Gruppe eines anderen Hauses ist hier dasselbe wie keine.
    if (a.categoryId !== null && !gruppeById.has(a.categoryId)) {
      throw Errors.validation({ createRooms: ['field.unknownValues'] },
        { values: String(a.categoryId) })
    }
    if (a.neu !== null) {
      const g = a.neu.code.toLowerCase()
      if (gruppeByCode.has(g)) {
        befunde.add('error', 'import.kwhotel.categoryCodeTaken', { code: a.neu.code })
        fehler = true
      } else if (!neueGruppen.has(g)) {
        neueGruppen.set(g, a.neu)
      } else {
        // Mehrere Zimmer derselben neuen Gruppe: die groesste Belegung zaehlt.
        const x = neueGruppen.get(g)!
        x.maxOccupancy = Math.max(x.maxOccupancy, a.neu.maxOccupancy)
      }
    }
  }
  if (fehler) return ergebnis

  const katNr = new Map<string, number>()
  if (neueGruppen.size > 0) {
    const g = [...neueGruppen.values()]
    const r = await client.query<{ id: number; code: string }>(
      `INSERT INTO resource_category (property_id, code, name, max_occupancy, sort_order)
       SELECT $1, a.code, a.name, a.occ, b.base + a.ord * 10
         FROM unnest($2::text[], $3::text[], $4::int[]) WITH ORDINALITY AS a(code, name, occ, ord),
              (SELECT COALESCE(max(sort_order), 0) AS base
                 FROM resource_category WHERE property_id = $1) b
       RETURNING id, code`,
      [propertyId, g.map(x => x.code), g.map(x => x.name), g.map(x => x.maxOccupancy)])
    for (const x of r.rows) katNr.set(x.code.toLowerCase(), Number(x.id))
  }

  // Eine Anweisung fuer alle Zimmer: der Kapazitaetstrigger auf
  // Anweisungsebene rechnet einmal nach (Migration 0013).
  const z = await client.query<{ id: number; code: string }>(
    `INSERT INTO resource (property_id, category_id, code)
     SELECT $1, x.cat, x.code FROM unnest($2::bigint[], $3::text[]) AS x(cat, code)
     RETURNING id, code`,
    [propertyId,
     auftraege.map(a => a.categoryId ?? katNr.get(a.neu!.code.toLowerCase())!),
     auftraege.map(a => a.code)])
  const nachCode = new Map(z.rows.map(x => [x.code, Number(x.id)]))
  for (const a of auftraege) ergebnis.set(a.kwRoomId, nachCode.get(a.code)!)

  /*
   * Den Bestand gleich mit, wie bei der ersten Einrichtung (firstSetup.ts):
   * eine neue Gruppe hat sonst keine Tage in `inventory_day`, und jede
   * kuenftige Reservierung darauf scheiterte mit `not_materialized`.
   */
  await client.query(
    `SELECT inventory_materialize($1, LEAST(current_date, $2::date),
              (current_date + interval '24 months')::date)`,
    [propertyId, (await client.query<{ d: string }>(
      `SELECT COALESCE((SELECT min(date) FROM business_day
                         WHERE property_id = $1 AND status = 'open'), current_date)::text AS d`,
      [propertyId])).rows[0]!.d])
  return ergebnis
}

async function uebernehmen(
  client: PoolClient, propertyId: number, userId: number | null,
  bestand: KwhotelBestand, body: Body
): Promise<KwhotelImportReport> {
  const befunde = new Befunde()

  const aktiv = new Set(zahlenliste(body.activeStatus, 'activeStatus', AKTIV_VORGABE))
  const storno = new Set(zahlenliste(body.canceledStatus, 'canceledStatus', STORNO_VORGABE))
  for (const c of aktiv) {
    if (storno.has(c)) befunde.add('error', 'import.kwhotel.statusInBothGroups', { code: c })
  }

  let ausschluss: Set<string>
  if (body.excludeGuestNames === undefined) ausschluss = new Set()
  else if (Array.isArray(body.excludeGuestNames)
           && body.excludeGuestNames.every(x => typeof x === 'string')) {
    ausschluss = new Set((body.excludeGuestNames as string[]).map(nameKey).filter(s => s !== ''))
  } else {
    throw Errors.validation({ excludeGuestNames: ['field.allowedValues'] }, { values: 'string[]' })
  }

  const ab = body.fromDate
  if (ab !== undefined && (typeof ab !== 'string' || !isIsoDate(ab))) {
    throw Errors.validation({ fromDate: ['field.isoDate'] })
  }

  const haus = await client.query<{ account_id: number; timezone: string; bd: string }>(
    `SELECT p.account_id, p.timezone,
            COALESCE((SELECT max(b.date) FROM business_day b
                       WHERE b.property_id = p.id AND b.status = 'open'),
                     current_date)::text AS bd
       FROM property p WHERE p.id = $1`, [propertyId])
  if (haus.rowCount === 0) throw Errors.notFound('res.property')
  const { account_id: accountId, timezone, bd } = haus.rows[0]!

  // ------------------------------------------------------------- Zimmer
  const angelegt = await zimmerAnlegen(client, propertyId, bestand, body.createRooms, befunde)
  const zimmer = await client.query<{ id: number; code: string; category_id: number }>(
    `SELECT id, code, category_id FROM resource WHERE property_id = $1`, [propertyId])
  const zimmerById = new Map(zimmer.rows.map(z => [Number(z.id), z]))
  const zimmerByKey = new Map<string, typeof zimmer.rows[number]>()
  for (const z of zimmer.rows) {
    // Bei zwei Zimmern mit derselben Nummer ("8" und "08") ordnet die
    // Automatik keines zu; das muss ein Mensch entscheiden.
    const k = roomKey(z.code)
    zimmerByKey.set(k, zimmerByKey.has(k) ? { id: -1, code: '', category_id: -1 } : z)
  }

  const karte = new Map<string, number | null>()
  if (body.roomMap !== undefined) {
    if (typeof body.roomMap !== 'object' || body.roomMap === null || Array.isArray(body.roomMap)) {
      throw Errors.validation({ roomMap: ['field.allowedValues'] }, { values: 'object' })
    }
    const fremd: string[] = []
    for (const [kw, ziel] of Object.entries(body.roomMap)) {
      if (ziel !== null && !(Number.isInteger(ziel) && zimmerById.has(ziel as number))) {
        fremd.push(kw)
        continue
      }
      karte.set(kw, ziel as number | null)
    }
    // Ein Zimmer eines anderen Hauses ist hier dasselbe wie keines: die
    // Zeilenrichtlinie filtert nur nach Mandant (CLAUDE.md).
    if (fremd.length > 0) {
      throw Errors.validation({ roomMap: ['field.unknownValues'] }, { values: fremd.join(', ') })
    }
  }

  const zuordnung = new Map<string, KwhotelRoomMatch>()
  for (const r of bestand.rooms) {
    let resourceId: number | null = null
    let match: KwhotelRoomMatch['match'] = 'none'
    if (angelegt.has(r.id)) {
      resourceId = angelegt.get(r.id)!
      match = 'created'
    } else if (karte.has(r.id)) {
      resourceId = karte.get(r.id)!
      match = resourceId === null ? 'skipped' : 'manual'
    } else {
      const z = zimmerByKey.get(roomKey(r.name))
      if (z !== undefined && z.id !== -1) { resourceId = Number(z.id); match = 'auto' }
    }
    zuordnung.set(r.id, {
      kwRoomId: r.id, name: r.name, reservations: 0, resourceId,
      roomCode: resourceId === null ? null : zimmerById.get(resourceId)!.code, match,
      suggestion: vorschlag(r, bestand)
    })
  }

  // ------------------------------------------------------------- Auswahl
  const counts = { placeholder: 0, beforeFrom: 0, alreadyImported: 0, roomSkipped: 0,
                   confirmed: 0, inHouse: 0, checkedOut: 0, canceled: 0, bookings: 0,
                   groupBookings: 0, guests: 0, multiGuest: 0 }
  const codes = new Map<number, number>()
  const unbekannt = new Map<number, string[]>()
  const namen = new Map<string, { name: string; count: number }>()
  const ohneZimmer = new Map<string, number>()
  const kandidaten: KwReservation[] = []

  const gastName = (r: KwReservation): string => {
    const id = r.guestId !== null && bestand.guests.has(r.guestId) ? r.guestId : r.guestIds[0]
    return id === undefined ? '' : bestand.guests.get(id)?.name ?? ''
  }

  for (const r of bestand.reservations) {
    codes.set(r.status, (codes.get(r.status) ?? 0) + 1)
    const name = gastName(r)
    if (name !== '') {
      const k = nameKey(name)
      const n = namen.get(k) ?? { name, count: 0 }
      n.count++
      namen.set(k, n)
      if (ausschluss.has(k)) { counts.placeholder++; continue }
    }
    if (!aktiv.has(r.status) && !storno.has(r.status)) {
      const l = unbekannt.get(r.status) ?? []
      l.push(r.id)
      unbekannt.set(r.status, l)
      continue
    }
    if (ab !== undefined && r.departure <= (ab as string)) { counts.beforeFrom++; continue }
    if (r.departure <= r.arrival) {
      befunde.add('error', 'import.kwhotel.invalidStay', { reference: r.id }, r.id)
      continue
    }
    if (r.totalCent < 0) {
      befunde.add('error', 'import.kwhotel.negativePrice', { reference: r.id }, r.id)
      continue
    }
    const zm = r.roomId === null ? undefined : zuordnung.get(r.roomId)
    if (zm === undefined) {
      befunde.add('error', 'import.kwhotel.roomUnknown', { reference: r.id }, r.id)
      continue
    }
    zm.reservations++
    if (zm.match === 'skipped') { counts.roomSkipped++; continue }
    if (zm.resourceId === null) {
      ohneZimmer.set(zm.kwRoomId, (ohneZimmer.get(zm.kwRoomId) ?? 0) + 1)
      continue
    }
    kandidaten.push(r)
  }

  for (const [code, refs] of [...unbekannt].sort((a, b) => a[0] - b[0])) {
    befunde.add('error', 'import.kwhotel.unknownStatus',
      { code, count: refs.length, references: refs.slice(0, 5).join(', ') })
  }
  for (const [kw, n] of ohneZimmer) {
    befunde.add('error', 'import.kwhotel.roomUnmapped',
      { name: zuordnung.get(kw)!.name, count: n })
  }

  // Schon uebernommen? Eine Abfrage fuer alle, nicht eine je Zeile.
  const vorhanden = new Set((await client.query<{ ref: string }>(
    `SELECT legacy_reference AS ref FROM reservation
      WHERE property_id = $1 AND legacy_system = $2 AND legacy_reference = ANY($3::text[])`,
    [propertyId, SYSTEM, kandidaten.map(r => r.id)])).rows.map(r => r.ref))
  const neu = kandidaten.filter(r => !vorhanden.has(r.id))
  counts.alreadyImported = kandidaten.length - neu.length
  if (counts.alreadyImported > 0) {
    befunde.add('warning', 'import.kwhotel.alreadyImported', { count: counts.alreadyImported })
  }

  // ------------------------------------------------------------- Zustand
  const ziel = (r: KwReservation): Ziel =>
    storno.has(r.status) ? 'Canceled'
      : r.departure <= bd ? 'CheckedOut'
        : r.arrival < bd ? 'InHouse'
          : 'Confirmed'
  const zustand = new Map(neu.map(r => [r.id, ziel(r)]))
  for (const z of zustand.values()) {
    if (z === 'Confirmed') counts.confirmed++
    else if (z === 'InHouse') counts.inHouse++
    else if (z === 'CheckedOut') counts.checkedOut++
    else counts.canceled++
  }
  if (counts.inHouse > 0) {
    befunde.add('warning', 'import.kwhotel.inHouse', { count: counts.inHouse, date: bd })
  }

  // ------------------------------------------------------------- Kontingent
  /*
   * Eine Reservierung, die noch Naechte ab heute hat, bindet sie ueber
   * dieselbe Funktion wie die Rezeption. Je Zeile, weil `inventory_reserve`
   * je Zeile sagen muss, ob es reicht -- ein Abzug hat davon einige Hundert,
   * die Vergangenheit bindet nichts.
   */
  const kategorie = (r: KwReservation): number =>
    zimmerById.get(zuordnung.get(r.roomId!)!.resourceId!)!.category_id
  for (const r of neu) {
    const z = zustand.get(r.id)!
    if (z !== 'Confirmed' && z !== 'InHouse') continue
    const von = r.arrival < bd ? bd : r.arrival
    const e = (await client.query<{ e: string | null }>(
      `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
      [propertyId, kategorie(r), von, r.departure])).rows[0]!.e
    if (e === 'sold_out') {
      befunde.add('error', 'import.kwhotel.soldOut',
        { reference: r.id, from: von, to: r.departure }, r.id)
    } else if (e === 'not_materialized') {
      befunde.add('error', 'import.kwhotel.notMaterialized',
        { reference: r.id, to: r.departure }, r.id)
    }
  }

  // ------------------------------------------------------------- Gaeste
  const hauptgast = new Map<string, string | null>()
  const gastIds = new Set<string>()
  for (const r of neu) {
    if (r.guestIds.length > 1) counts.multiGuest++
    // Der Gast an der Zeile selbst; KWHotel setzt ihn bei jeder Buchung.
    // Fehlt er, der mit der kleinsten Nummer (Absprache mit dem Adminpanel).
    const id = r.guestId !== null && bestand.guests.has(r.guestId) ? r.guestId
      : r.guestIds.find(g => bestand.guests.has(g)) ?? null
    const g = id === null ? null : bestand.guests.get(id)!
    const nimm = g !== null && g.name !== '' ? g.id : null
    hauptgast.set(r.id, nimm)
    if (nimm !== null) gastIds.add(nimm)
  }

  // Buchungen: eine je Gruppe, sonst eine je Zeile.
  const gruppenSchluessel = (r: KwReservation) => r.groupId !== null ? `g${r.groupId}` : `r${r.id}`
  const gruppen = new Map<string, KwReservation[]>()
  for (const r of [...neu].sort((a, b) => Number(a.id) - Number(b.id))) {
    const k = gruppenSchluessel(r)
    gruppen.set(k, [...(gruppen.get(k) ?? []), r])
  }
  const gruppenNummern = [...new Set(neu.filter(r => r.groupId !== null).map(r => r.groupId!))]
  const alteBuchungen = new Map((await client.query<{ id: number; ref: string }>(
    `SELECT id, legacy_reference AS ref FROM booking
      WHERE property_id = $1 AND legacy_system = $2 AND legacy_reference = ANY($3::text[])`,
    [propertyId, SYSTEM, gruppenNummern])).rows.map(b => [b.ref, Number(b.id)]))

  const neueBuchungen = [...gruppen].filter(([k]) =>
    !(k.startsWith('g') && alteBuchungen.has(k.slice(1))))
  counts.bookings = neueBuchungen.length
  counts.groupBookings = neueBuchungen.filter(([k]) => k.startsWith('g')).length
  counts.guests = gastIds.size

  const imported = befunde.fehler === 0 ? neu.length : 0
  if (befunde.fehler === 0 && neu.length > 0) {
    await schreiben(client, {
      propertyId, accountId, userId, timezone, bestand, neu, zustand, hauptgast,
      gastIds: [...gastIds], gruppen: neueBuchungen, alteBuchungen, gruppenSchluessel,
      kategorie, zuordnung })
  }

  const daten = bestand.reservations
  return {
    dryRun: true,
    hotelName: bestand.hotelName,
    businessDate: bd,
    rows: daten.length,
    imported,
    skipped: daten.length - imported,
    counts,
    statusCodes: [...codes].sort((a, b) => a[0] - b[0]).map(([code, count]) => ({
      code, count, group: aktiv.has(code) ? 'active' as const
        : storno.has(code) ? 'canceled' as const : null })),
    rooms: [...zuordnung.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'de', { numeric: true })),
    frequentNames: [...namen.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)
      .map(([k, n]) => ({ name: n.name, count: n.count, excluded: ausschluss.has(k) })),
    range: daten.length === 0 ? null : {
      from: daten.reduce((m, r) => r.arrival < m ? r.arrival : m, daten[0]!.arrival),
      to: daten.reduce((m, r) => r.departure > m ? r.departure : m, daten[0]!.departure) },
    findings: befunde.liste.slice(0, MAX_BEFUNDE)
  }
}

interface Schreibauftrag {
  propertyId: number
  accountId: number
  userId: number | null
  timezone: string
  bestand: KwhotelBestand
  neu: KwReservation[]
  zustand: Map<string, Ziel>
  hauptgast: Map<string, string | null>
  gastIds: string[]
  gruppen: Array<[string, KwReservation[]]>
  alteBuchungen: Map<string, number>
  gruppenSchluessel: (r: KwReservation) => string
  kategorie: (r: KwReservation) => number
  zuordnung: Map<string, KwhotelRoomMatch>
}

/**
 * Schreibt mengenbasiert: eine Anweisung je Tabelle, gleich wie viele
 * Zeilen. Zwoelftausend Reservierungen einzeln waeren sechzigtausend Runden.
 *
 * Gast und Buchung bekommen ihre oeffentliche Kennung vorab, damit sich die
 * neue Datenbanknummer ueber `RETURNING` sicher zuordnen laesst. Auf die
 * Reihenfolge der zurueckgegebenen Zeilen verlaesst sich nichts hier: eine
 * Verwechslung wuerde den Aufenthalt eines Menschen einem anderen anhaengen.
 */
async function schreiben(client: PoolClient, a: Schreibauftrag): Promise<void> {
  const refs = async (n: number): Promise<string[]> => n === 0 ? [] :
    (await client.query<{ refs: string[] }>(
      `SELECT array_agg(generate_public_ref()) AS refs FROM generate_series(1, $1)`,
      [n])).rows[0]!.refs

  // Gaeste: nur Name und Land. Mehr fuehrt KWHotel bei diesem Haus nicht,
  // und eine Mailadresse wird dort nicht gepflegt (Abschnitt 3.7).
  const gastRefs = await refs(a.gastIds.length)
  const gastNr = new Map<string, number>()
  if (a.gastIds.length > 0) {
    const g = await client.query<{ id: number; public_ref: string }>(
      `INSERT INTO guest (account_id, public_ref, last_name, country)
       SELECT $1, x.ref, x.name, x.country
         FROM unnest($2::text[], $3::text[], $4::text[]) AS x(ref, name, country)
       RETURNING id, public_ref`,
      [a.accountId, gastRefs, a.gastIds.map(id => a.bestand.guests.get(id)!.name),
       a.gastIds.map(id => a.bestand.guests.get(id)!.country)])
    const nachRef = new Map(g.rows.map(r => [r.public_ref, Number(r.id)]))
    a.gastIds.forEach((id, i) => gastNr.set(id, nachRef.get(gastRefs[i]!)!))
  }
  const gast = (r: KwReservation): number | null => {
    const id = a.hauptgast.get(r.id)
    return id === null || id === undefined ? null : gastNr.get(id)!
  }

  const buchungRefs = await refs(a.gruppen.length)
  const buchungNr = new Map<string, number>()
  for (const [ref, id] of a.alteBuchungen) buchungNr.set(`g${ref}`, id)
  if (a.gruppen.length > 0) {
    const b = await client.query<{ id: number; public_ref: string }>(
      `INSERT INTO booking (property_id, public_ref, booker_guest_id, source,
                            legacy_system, legacy_reference, created_by)
       SELECT $1, x.ref, x.guest, 'import',
              CASE WHEN x.legacy IS NULL THEN NULL ELSE $2 END, x.legacy, $3
         FROM unnest($4::text[], $5::bigint[], $6::text[]) AS x(ref, guest, legacy)
       RETURNING id, public_ref`,
      [a.propertyId, SYSTEM, a.userId, buchungRefs,
       a.gruppen.map(([, rs]) => gast(rs[0]!)),
       a.gruppen.map(([k]) => k.startsWith('g') ? k.slice(1) : null)])
    const nachRef = new Map(b.rows.map(r => [r.public_ref, Number(r.id)]))
    a.gruppen.forEach(([k], i) => buchungNr.set(k, nachRef.get(buchungRefs[i]!)!))
  }

  /*
   * Personen: `Osob` ist die Gesamtzahl, die Kinderspalten sagen, wie viele
   * davon Kinder sind. Addiert wird nicht -- das hat im Adminpanel jedes
   * Kind doppelt ins Fruehstueck gezaehlt, wo die Spalten gepflegt waren.
   *
   * - Kinder weniger als Personen: aufgeteilt, Erwachsene = Rest.
   * - Kinder gleich oder mehr: widerspruechlich, es bleibt nur die
   *   Gesamtzahl ("nicht getrennt angegeben", Migration 0076).
   * - Keine brauchbare Gesamtzahl: alles leer statt einer erfundenen Eins.
   */
  const rs = a.neu
  const gesamt = rs.map(r => r.persons >= 1 && r.persons <= 99 ? r.persons : null)
  const getrennt = rs.map((r, i) => gesamt[i] !== null && r.children < gesamt[i]!)
  const erw = rs.map((r, i) => getrennt[i] ? gesamt[i]! - r.children : null)
  const kinder = rs.map((r, i) => getrennt[i] ? r.children : null)
  const res = await client.query<{ id: number; ref: string }>(
    `INSERT INTO reservation (property_id, booking_id, category_id, resource_id, arrival,
                              departure, status, primary_guest_id, notes, guest_count,
                              adults, children, legacy_system, legacy_reference,
                              checked_in_at, checked_out_at, canceled_at, created_by)
     SELECT $1, x.booking, x.category, x.resource, x.arrival, x.departure,
            x.status::reservation_status, x.guest, x.notes, x.persons,
            x.adults, x.children, $2, x.legacy,
            -- Den Tag kennt KWHotel, die Uhrzeit nicht.
            CASE WHEN x.status IN ('InHouse','CheckedOut')
                 THEN x.arrival::timestamp AT TIME ZONE $3 END,
            CASE WHEN x.status = 'CheckedOut' THEN x.departure::timestamp AT TIME ZONE $3 END,
            CASE WHEN x.status = 'Canceled'
                 THEN COALESCE(x.modified::timestamp AT TIME ZONE $3, now()) END,
            $4
       FROM unnest($5::bigint[], $6::bigint[], $7::bigint[], $8::date[], $9::date[],
                   $10::text[], $11::bigint[], $12::text[], $13::int[], $14::int[],
                   $15::text[], $16::text[], $17::int[])
            AS x(booking, category, resource, arrival, departure, status, guest, notes,
                 adults, children, legacy, modified, persons)
     RETURNING id, legacy_reference AS ref`,
    [a.propertyId, SYSTEM, a.timezone, a.userId,
     rs.map(r => buchungNr.get(a.gruppenSchluessel(r))!),
     rs.map(r => a.kategorie(r)),
     rs.map(r => a.zuordnung.get(r.roomId!)!.resourceId!),
     rs.map(r => r.arrival), rs.map(r => r.departure),
     rs.map(r => a.zustand.get(r.id)!), rs.map(gast), rs.map(r => r.notes),
     erw, kinder, rs.map(r => r.id), rs.map(r => r.modifiedAt), gesamt])
  const resNr = new Map(res.rows.map(r => [r.ref, Number(r.id)]))

  /*
   * `Cena` ist der Preis der ganzen Zeile (am Abzug und gegen RoomCloud
   * bestaetigt). Gleichmaessig auf die Naechte, der Restcent auf die letzte,
   * damit die Summe genau `Cena` ist.
   */
  const nId: number[] = []
  const nDatum: string[] = []
  const nPreis: number[] = []
  for (const r of rs) {
    const naechte = eachNight(r.arrival, r.departure)
    const je = Math.floor(r.totalCent / naechte.length)
    const rest = r.totalCent - je * naechte.length
    naechte.forEach((d, i) => {
      nId.push(resNr.get(r.id)!)
      nDatum.push(d)
      nPreis.push(je + (i === naechte.length - 1 ? rest : 0))
    })
  }
  await client.query(
    `INSERT INTO reservation_night (reservation_id, property_id, date, price_cent)
     SELECT x.id, $1, x.date, x.price
       FROM unnest($2::bigint[], $3::date[], $4::bigint[]) AS x(id, date, price)`,
    [a.propertyId, nId, nDatum, nPreis])

  // Ein Folio nur, wo in StayGrid noch abgerechnet wird. Vergangene und
  // stornierte Aufenthalte sind in KWHotel abgerechnet; ein leeres offenes
  // Folio je Altbuchung stuende fuer immer in jeder Liste offener Posten.
  const offen = rs.filter(r => ['Confirmed', 'InHouse'].includes(a.zustand.get(r.id)!))
  if (offen.length > 0) {
    await client.query(
      `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
       SELECT $1, x.id, x.guest, 'guest'
         FROM unnest($2::bigint[], $3::bigint[]) AS x(id, guest)`,
      [a.propertyId, offen.map(r => resNr.get(r.id)!), offen.map(gast)])
  }
}

/** Traegt den Bericht aus der Transaktion heraus und rollt sie dabei zurueck. */
class Zurueck extends Error {
  constructor(readonly report: KwhotelImportReport) {
    super('Trockenlauf')
    this.name = 'Zurueck'
  }
}

export function kwhotelImportRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/imports/legacy/kwhotel',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Bestand aus einem KWHotel-Datenbankabzug uebernehmen',
    // Ein KWHotel-Abzug eines kleinen Hauses mit drei Jahren hat 15 MB;
    // als JSON-Zeichenkette etwas mehr. Die Oberflaeche schickt nur die
    // benoetigten Tabellen, ein Skript vielleicht die ganze Datei.
    bodyLimit: 64 * 1024 * 1024,
    handler: async (req: FastifyRequest) => {
      const body = req.body as Body
      if (typeof body.data !== 'string' || body.data.trim() === '') {
        throw Errors.validation({ data: ['field.required'] })
      }
      let bestand: KwhotelBestand
      try {
        bestand = readKwhotelDump(body.data)
      } catch (e) {
        if (e instanceof DumpFormatError) throw Errors.unprocessable(e.message, e.params)
        throw e
      }

      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const report = await uebernehmen(client, body.propertyId, principal.userId,
                                         bestand, body)
        // Der Trockenlauf ist der Regelfall; mit Fehlern wird auch ein
        // festschreibender Lauf zum Trockenlauf. Ganz oder gar nicht.
        if (body.commit !== true || report.findings.some(f => f.level === 'error')) {
          throw new Zurueck({ ...report, imported: body.commit === true ? 0 : report.imported,
                              skipped: body.commit === true ? report.rows : report.skipped })
        }
        return { ...report, dryRun: false }
      }).catch((e: unknown) => {
        if (e instanceof Zurueck) return e.report
        throw e
      })
    }
  })
}
