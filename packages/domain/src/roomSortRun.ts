import { createHash } from 'node:crypto'
import { addDays, nightsBetween } from './dates.js'
import { resolveRoomSortWeights, type RoomSortMode, type RoomSortWeights } from './roomSort.js'
import { sortRooms, type SortRoom, type SortStay } from './roomSortEngine.js'

/**
 * Zimmer sortieren gegen die Datenbank: Lage lesen, rechnen, Zuege schreiben.
 *
 * **Warum in der Domaene und nicht in der API.** Zwei Seiten sortieren: die
 * Schnittstelle (Knopf im Zimmerplan, Kanal-Push im Gaestehaus) und seit
 * dem Performance-Audit vom 11.10.2026 (Befund 6) der Worker, der im Modus
 * `auto` das ganze Jahr sortiert, statt dass jeder Push es in seiner
 * Antwortzeit tut. Apps duerfen einander nicht importieren; was beide
 * brauchen, steht hier -- wie `createCheckinToken`.
 *
 * **Wer liegen bleibt** (die Regeln aus dem Adminpanel und Svens
 * Grundregeln): angereist oder abgereist, "Zimmer fest", Anreise vor dem
 * Geschaeftstag (gilt als angereist, Sven 05.10.2026), ueber den Zeitraum
 * hinaus, in einem Zimmer einer anderen Gruppe (Upgrade), und eine
 * Kanalbuchung, die in StayGrid von Hand geaendert wurde (`local`, Sven
 * 05.10.2026: geschuetzt). Wer heute anreist und noch nicht eingecheckt
 * ist, wird mitsortiert (Sven, 11.10.2026, Migration 0124).
 */

/**
 * Was ein Datenbankclient hier koennen muss. Strukturell und nicht als
 * Import von `pg`: die Domaene haengt an keinem Treiber, und ein
 * `PoolClient` aus `@hotelpms/db` passt hinein.
 */
export interface RoomSortSqlClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]
                                                         rowCount?: number | null }>
}

/** Zwei Monate: so weit plant eine Rezeption Zimmer, und es bleibt eine Runde. */
export const MAX_SORT_DAYS = 62

/** Ein Jahr: so weit reicht, was RoomCloud im Gaestehaus verkauft. */
export const AUTO_SORT_DAYS = 366

export interface RoomSortStayRow {
  id: number; public_ref: string; booking_id: number; category_id: number
  arrival: string; departure: string; resource_id: number | null; status: string
  room_fixed: boolean; channel_owner: string | null; price_cent: number | null
  text: string; last_name: string | null; updated_at: string
  /** Zimmerwechsel im Aufenthalt (0195): eine Zeile je Zimmer, und fest. */
  room_moved: boolean
}

export interface RoomSortSituation {
  stays: RoomSortStayRow[]
  rooms: SortRoom[]
  basis: string
  today: string
  weights: RoomSortWeights
}

export type RoomSortMoves = ReturnType<typeof sortRooms>['moves']

/** Ein Zug traf ein belegtes oder gesperrtes Zimmer; nichts bleibt geschrieben. */
export class RoomSortRoomTakenError extends Error {
  constructor(readonly room: string, readonly reservation: string) {
    super(`Zimmer ${room} ist fuer ${reservation} belegt oder gesperrt`)
    this.name = 'RoomSortRoomTakenError'
  }
}

/** Der Geschaeftstag des Hauses; ohne offenen Tag das Kalenderdatum. */
export async function roomSortToday(client: RoomSortSqlClient, propertyId: number): Promise<string> {
  const r = await client.query(
    `SELECT COALESCE((SELECT max(b.date) FROM business_day b WHERE b.property_id = $1),
                     current_date)::text AS d`, [propertyId])
  return (r.rows[0] as { d: string }).d
}

/** Die Einstellung des Hauses; ohne Zeile `manual` mit den Vorgaben. */
export async function roomSortSetting(
  client: RoomSortSqlClient, propertyId: number
): Promise<{ mode: RoomSortMode; weights: Partial<RoomSortWeights> }> {
  const s = await client.query(
    `SELECT mode, weights FROM room_sort_setting WHERE property_id = $1`, [propertyId])
  return (s.rows[0] as { mode: RoomSortMode; weights: Partial<RoomSortWeights> } | undefined)
    ?? { mode: 'manual', weights: {} }
}

/**
 * Alles, was im Zeitraum ein Zimmer belegt oder eines braucht, dazu die
 * Zimmer und ein Fingerabdruck (`basis`) des Stands.
 *
 * Gesperrt, wenn geschrieben werden soll: der Stand soll bis zum Schreiben
 * gelten. `null`, wenn das Haus "Nie" eingestellt hat -- die Route sagt das
 * dem Benutzer, der Worker tut einfach nichts. Wer Einstellung oder
 * Geschaeftstag schon gelesen hat, gibt sie mit (Befund 14: der Push las
 * beides bisher mehrmals je Aufruf).
 */
export async function roomSortLoad(
  client: RoomSortSqlClient, propertyId: number, from: string, to: string, lock: boolean,
  known: { setting?: { mode: RoomSortMode; weights: Partial<RoomSortWeights> }
           today?: string } = {}
): Promise<RoomSortSituation | null> {
  const einstellung = known.setting ?? await roomSortSetting(client, propertyId)
  if (einstellung.mode === 'off') return null
  const today = known.today ?? await roomSortToday(client, propertyId)

  const stays = await client.query(
    // Je Zimmerabschnitt (0195): ein Aufenthalt mit Zimmerwechsel belegt
    // jedes seiner Zimmer nur an dessen Tagen, und genau so muss der
    // Sortierer ihn sehen -- als feste Belegung, nicht als einen Balken
    // ueber den ganzen Aufenthalt im Zimmer von heute.
    `SELECT r.id, r.public_ref, r.booking_id, r.category_id,
            s.arrival::text, s.departure::text, s.resource_id, r.status::text,
            r.room_fixed, b.channel_owner, r.room_moved,
            (SELECT round(avg(n.price_cent))::int FROM reservation_night n
              WHERE n.reservation_id = r.id) AS price_cent,
            concat_ws(' ', r.short_note, r.notes) AS text,
            g.last_name, r.updated_at::text
       FROM reservation_room_stay s
       JOIN reservation r ON r.id = s.id
       JOIN booking b ON b.id = r.booking_id
       LEFT JOIN guest g ON g.id = r.primary_guest_id
      WHERE s.property_id = $1
        AND s.arrival < $3::date AND s.departure > $2::date
        AND r.status IN ('Optional','Confirmed','InHouse','CheckedOut')
      ORDER BY r.id, s.arrival
      ${lock ? 'FOR UPDATE OF r' : ''}`, [propertyId, from, to])
  const stayRows = stays.rows as RoomSortStayRow[]

  const rooms = await client.query(
    `SELECT r.id, r.category_id, r.code, r.quality, r.floor, r.building, r.attributes,
            COALESCE((SELECT json_agg(json_build_object('from', m.from_date::text,
                                                        'to', m.to_date::text))
                        FROM maintenance_block m
                       WHERE m.resource_id = r.id AND m.kind = 'out_of_order'
                         AND m.from_date < $3::date AND m.to_date > $2::date), '[]') AS blocked
       FROM resource r WHERE r.property_id = $1 AND r.active
      ORDER BY r.id`, [propertyId, from, to])
  const roomRows = rooms.rows as Array<{ id: number; category_id: number; code: string
                                         quality: number; floor: string | null
                                         building: string | null; attributes: string[]
                                         blocked: Array<{ from: string; to: string }> }>

  const basis = createHash('sha256').update(JSON.stringify([
    stayRows.map(x => [x.id, x.resource_id, x.arrival, x.departure, x.status, x.room_fixed,
                       x.channel_owner, x.updated_at]),
    roomRows.map(x => [x.id, x.category_id, x.blocked])
  ])).digest('base64url')

  return {
    stays: stayRows,
    rooms: roomRows.map(x => ({ id: Number(x.id), categoryId: Number(x.category_id), code: x.code,
                                quality: x.quality, floor: x.floor, building: x.building,
                                attributes: x.attributes, blocked: x.blocked })),
    basis, today,
    weights: resolveRoomSortWeights(einstellung.weights)
  }
}

export function roomSortMovable(
  x: RoomSortStayRow, l: RoomSortSituation, from: string, to: string
): boolean {
  if (x.status !== 'Optional' && x.status !== 'Confirmed') return false
  if (x.room_fixed || x.channel_owner === 'local' || x.room_moved) return false
  if (x.arrival < from || x.departure > to) return false
  // Wer heute anreist, wird mitsortiert, solange er nicht eingecheckt ist
  // (Status oben). Sven, 11.10.2026: "das ist der einzige punkt" -- bis zum
  // Check-in ist das Zimmer noch nicht seins, und gerade heute kostet eine
  // Luecke am meisten.
  if (x.arrival < l.today) return false
  return true
}

export function roomSortCompute(
  l: RoomSortSituation, from: string, to: string
): ReturnType<typeof sortRooms> {
  const stays: SortStay[] = l.stays.map(x => ({
    id: Number(x.id), bookingId: Number(x.booking_id), categoryId: Number(x.category_id),
    arrival: x.arrival, departure: x.departure,
    resourceId: x.resource_id === null ? null : Number(x.resource_id),
    // Abgereiste und Stornierte belegen nichts mehr, Abgereiste aber an
    // ihren Tagen schon: sie stehen nur bis zur Abreise im Zeitraum.
    fixed: !roomSortMovable(x, l, from, to),
    pricePerNightCent: x.price_cent === null ? null : Number(x.price_cent),
    text: x.text ?? ''
  }))
  return sortRooms(l.rooms, stays, l.weights)
}

/**
 * Zimmer setzen, in einer Anweisung, und danach pruefen, dass kein Zimmer
 * doppelt belegt oder gesperrt ist. Erst schreiben, dann pruefen: bei einem
 * Ringtausch (A nach B, B nach C, C nach A) ist jeder Zwischenstand belegt,
 * nur das Ergebnis nicht.
 *
 * `app.room_sort` haelt den Trigger aus 0092 an: ein Zug des Sortierers ist
 * keine Aenderung der Rezeption (Migration 0122).
 */
export async function roomSortWrite(
  client: RoomSortSqlClient, zuege: Array<{ id: number; resourceId: number | null }>
): Promise<void> {
  await client.query(`SELECT set_config('app.room_sort', 'on', true)`)
  await client.query(
    // Wer ein Zimmer bekommt, wartet nicht mehr auf das, das die Quelle
    // wollte (0121): sonst legte ihn der naechste Push dorthin zurueck, und
    // der Konfliktvermerk am Balken stimmte nicht mehr.
    `UPDATE reservation r SET resource_id = x.res, updated_at = now(),
            channel_wanted_resource_id = CASE WHEN x.res IS NULL
                                              THEN r.channel_wanted_resource_id END,
            channel_conflict = CASE WHEN x.res IS NOT NULL AND r.channel_conflict = 'room'
                                    THEN NULL ELSE r.channel_conflict END
       FROM unnest($1::bigint[], $2::bigint[]) AS x(id, res)
      WHERE r.id = x.id`,
    [zuege.map(z => z.id), zuege.map(z => z.resourceId)])
  await client.query(`SELECT set_config('app.room_sort', '', true)`)

  const konflikt = await client.query(
    `SELECT u.code, r.public_ref AS ref
       FROM reservation r JOIN resource u ON u.id = r.resource_id
      WHERE r.id = ANY($1::bigint[])
        AND (EXISTS (SELECT 1 FROM reservation_room_stay o
                      WHERE o.resource_id = r.resource_id AND o.id <> r.id
                        AND o.stay_status IN ('Optional','Confirmed','InHouse')
                        AND o.arrival < r.departure AND o.departure > r.arrival)
             OR EXISTS (SELECT 1 FROM maintenance_block m
                         WHERE m.resource_id = r.resource_id AND m.kind = 'out_of_order'
                           AND m.from_date < r.departure AND m.to_date > r.arrival))
      LIMIT 1`, [zuege.map(z => z.id)])
  const z = konflikt.rows[0] as { code: string; ref: string } | undefined
  if (z !== undefined) throw new RoomSortRoomTakenError(z.code, z.ref)
}

/**
 * Zuege schreiben, den Lauf festhalten und je Reservierung ein Ereignis --
 * alle Ereignisse in einer Anweisung (`webhook_enqueue_bulk`, 0141), nicht
 * eine Runde je Zug.
 */
export async function roomSortRun(
  client: RoomSortSqlClient, pid: number, from: string, to: string,
  trigger: 'manual' | 'auto', zuege: RoomSortMoves, nachId: Map<number, RoomSortStayRow>,
  userId: number | null
): Promise<string> {
  await roomSortWrite(client, zuege.map(m => ({ id: m.stayId, resourceId: m.toRoomId })))
  const run = await client.query(
    `INSERT INTO room_sort_run (property_id, from_date, to_date, trigger, moves, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING public_ref`,
    [pid, from, to, trigger, JSON.stringify(zuege.map(m => ({
      reservationId: m.stayId, fromResourceId: m.fromRoomId, toResourceId: m.toRoomId }))),
     userId])
  if (zuege.length > 0) {
    await client.query(`SELECT webhook_enqueue_bulk($1, 'reservation.changed', $2::jsonb[])`,
      [pid, zuege.map(m => {
        const x = nachId.get(m.stayId)!
        return JSON.stringify({
          reservationRef: x.public_ref, resourceId: m.toRoomId,
          arrival: x.arrival, departure: x.departure, categoryId: Number(x.category_id) })
      })])
  }
  return (run.rows[0] as { public_ref: string }).public_ref
}

/**
 * Ein Sortierlauf je Haus zur Zeit.
 *
 * Der Lauf sperrt alle Aufenthalte des Zeitraums, ein Push vorher seine
 * Buchung. Laufen zwei Pushes gleichzeitig, haelt jeder seine Buchung und
 * wartet auf die des anderen -- eine Verklemmung, die PostgreSQL mit einem
 * Abbruch aufloest. Die Sperre je Haus kommt deshalb zuerst, vor jeder
 * Zeilensperre. Der Worker nimmt dieselbe Sperre.
 */
export async function roomSortLock(client: RoomSortSqlClient, propertyId: number): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('room_sort'), $1::int)`,
    [propertyId])
}

/**
 * Automatisch sortieren (Modus `auto`, Gaestehaus) im Zeitraum `from` bis
 * `to`. Schreibt wie Uebernehmen und legt einen Lauf `auto` an, damit auch
 * ein automatischer Zug im Verlauf steht und sich zuruecknehmen laesst. Der
 * Aufrufer haelt `roomSortLock` und hat geprueft, dass das Haus auf `auto`
 * steht. Ergibt die Zahl der Zuege.
 */
export async function roomSortAuto(
  client: RoomSortSqlClient, propertyId: number, from: string, to: string,
  known: { setting: { mode: RoomSortMode; weights: Partial<RoomSortWeights> }; today: string }
): Promise<number> {
  if (nightsBetween(from, to) <= 0) return 0
  const l = await roomSortLoad(client, propertyId, from, to, true, known)
  if (l === null) return 0
  const r = roomSortCompute(l, from, to)
  if (r.moves.length === 0) return 0
  const nachId = new Map(l.stays.map(x => [Number(x.id), x]))
  await roomSortRun(client, propertyId, from, to, 'auto', r.moves, nachId, null)
  return r.moves.length
}

/** Sortieren im Worker faellig vormerken (Migration 0141). */
export async function roomSortMarkDue(client: RoomSortSqlClient, propertyId: number): Promise<void> {
  await client.query(
    `INSERT INTO room_sort_due (property_id) VALUES ($1)
     ON CONFLICT (property_id) DO UPDATE SET marked_at = now()`, [propertyId])
}

/**
 * Wie lange nach dem letzten Push der Worker wartet, bevor er sortiert, und
 * wie lange hoechstens nach dem ersten. Der Abgleich des Adminpanels laeuft
 * alle fuenf Minuten und schickt dann mehrere Pushes hintereinander; ein
 * Lauf danach genuegt. Wird ohne Pause gepusht, kommt das Haus nach
 * spaetestens zehn Minuten trotzdem dran.
 */
export const AUTO_SORT_QUIET_SECONDS = 60
export const AUTO_SORT_MAX_WAIT_SECONDS = 600

export interface RoomSortDueResult { sorted: boolean; moved: number }

/**
 * Den vorgemerkten Jahreslauf eines Hauses ausfuehren, wenn er faellig ist.
 *
 * In der Transaktion des Aufrufers, im Kontext genau dieses Hauses. Die
 * Sperre je Haus kommt zuerst, wie beim Push: ein Push wartet, bis der Lauf
 * fertig ist, und vermerkt danach neu. Steht das Haus nicht mehr auf
 * `auto`, faellt der Vermerk ohne Lauf weg.
 */
export async function roomSortRunDue(
  client: RoomSortSqlClient, propertyId: number,
  opts: { quietSeconds?: number; maxWaitSeconds?: number } = {}
): Promise<RoomSortDueResult> {
  const faellig = await client.query(
    `SELECT 1 FROM room_sort_due
      WHERE property_id = $1
        AND (marked_at <= now() - make_interval(secs => $2)
             OR due_since <= now() - make_interval(secs => $3))`,
    [propertyId, opts.quietSeconds ?? AUTO_SORT_QUIET_SECONDS,
     opts.maxWaitSeconds ?? AUTO_SORT_MAX_WAIT_SECONDS])
  if (faellig.rows.length === 0) return { sorted: false, moved: 0 }

  await roomSortLock(client, propertyId)
  await client.query(`DELETE FROM room_sort_due WHERE property_id = $1`, [propertyId])
  const setting = await roomSortSetting(client, propertyId)
  if (setting.mode !== 'auto') return { sorted: false, moved: 0 }
  // Ab dem Geschaeftstag, weil die Anreisen von heute ohne Zimmer auch
  // eines brauchen und bis zum Check-in mitsortiert werden.
  const today = await roomSortToday(client, propertyId)
  const moved = await roomSortAuto(client, propertyId, today, addDays(today, AUTO_SORT_DAYS),
    { setting, today })
  return { sorted: true, moved }
}
