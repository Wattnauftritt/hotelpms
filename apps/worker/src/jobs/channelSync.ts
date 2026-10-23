import { withTransaction, type DbContext, type Pool, type PoolClient } from '@hotelpms/db'
import {
  addDays, decryptSecret, kanalBuchungSetzen, kanalBuchungStornieren, kanalRumpfPruefen,
  roomSortToday, AdapterError, DomainError, RoomSortRoomTakenError,
  CHANNEL_CREDENTIALS_PURPOSE,
  type AdapterBuchung, type AdapterVerfuegbarkeit, type AdapterZugang, type ChannelAdapter,
  type KanalRumpf, type KanalZugang
} from '@hotelpms/domain'

/*
 * Kanalabgleich: StayGrid spricht einen Channel Manager selbst an
 * (Migration 0198, Thread "Anbindung weiterer Channelmanager").
 *
 * **Verfuegbarkeit automatisch, Preise per Knopf.** Sven, 23.10.2026: "die
 * verfuegbarkeit darf natuerlich immer automatisch rausgehen ... preise die
 * manuell geaendert werden sind ja etwas anderes". Was ein Zimmer bindet
 * oder freigibt, muss in Minuten beim Portal sein, sonst verkauft es ein
 * Zimmer, das es nicht mehr gibt. Dieser Lauf sendet deshalb nur die Zahl
 * freier Zimmer; Preise gehen weiter ueber die drei Knoepfe im Preisraster.
 *
 * **Absolute Werte, Grenze mit Ueberlappung.** Gesendet wird, was sich seit
 * `availability_sent_until` geaendert hat, mit zwei Minuten Ueberlappung:
 * `updated_at` ist der Beginn der schreibenden Transaktion, und eine, die
 * vor unserem Lesen begann und danach festschrieb, laege sonst fuer immer
 * vor der Grenze. Doppelt gesendet schadet nicht -- es sind Bestaende, keine
 * Aenderungen.
 *
 * **Buchungen: erst festschreiben, dann bestaetigen.** Eine Buchung wird
 * beim Anbieter erst bestaetigt, wenn sie in StayGrid steht. Faellt der
 * Worker dazwischen aus, kommt dieselbe Revision wieder, und
 * `channel_booking_revision` sorgt dafuer, dass sie nur noch bestaetigt
 * wird. Der Abgleich selbst ist derselbe wie beim Push des Adminpanels
 * (`kanalBuchungSetzen` in `@hotelpms/domain`), mit denselben Schutzregeln.
 *
 * **Probebetrieb** (`sync_mode = 'shadow'`): nichts senden, nichts
 * bestaetigen, nichts anlegen. Im eigenen Hotel spricht das Adminpanel
 * weiter mit RoomCloud (Sven, 23.10.2026), und zwei Absender ueberschrieben
 * sich. Der Lauf schreibt nur ins Kanalprotokoll, wie viele Tage er gesendet
 * haette und wie viele Buchungen StayGrid anders kennt als die Quelle.
 *
 * **Fehler stehen einmal im Protokoll, nicht jede Minute.** Ein Anbieter,
 * der eine Stunde nicht antwortet, ergaebe sonst sechzig gleiche Zeilen.
 * Eine Zeile entsteht, wenn sich der Fehler aendert; `last_error_key` am
 * Zugang haelt den Stand.
 */

/** Ein Jahr voraus, wie das Preisraster und die ARI-Schnittstelle. */
const HORIZONT_TAGE = 365
/** Siehe oben: Transaktionen, die ueber die Grenze festschreiben. */
const UEBERLAPPUNG = '2 minutes'
/** So oft vergleicht der Probebetrieb Buchungen; er bestaetigt nichts, also kaeme jede Minute dieselbe Liste. */
const PROBE_BUCHUNGEN_MINUTEN = 15
/** Wie lange das Kanalprotokoll reicht. */
const PROTOKOLL_TAGE = 90

const LEBEND = ['Optional', 'Confirmed', 'InHouse', 'CheckedOut']

interface ZugangZeile {
  id: number
  account_id: number
  provider: string
  sync_mode: 'shadow' | 'active'
  credentials_enc: Buffer
  external_property_id: string
  availability_sent_until: string | null
  full_sync_requested_at: string | null
  last_error_key: string | null
}

export interface KanalLaufErgebnis {
  connections: number
  /** Gesendete (oder im Probebetrieb: zu sendende) Tage. */
  days: number
  /** Verarbeitete Buchungsstaende. */
  bookings: number
  /** Zugaenge mit Fehler in diesem Lauf. */
  failed: number
}

export interface KanalDeps {
  adapters: Partial<Record<string, ChannelAdapter>>
  /** ID_DOCUMENT_KEY, aus dem der Schluessel der Zugangsdaten abgeleitet wird. */
  secret: string
  log: { error: (o: object, m: string) => void }
}

/** Schluessel einer Meldung fuer das Protokoll, nie der Text: der kann Gastdaten tragen. */
function fehlerSchluessel(e: unknown): string {
  if (e instanceof AdapterError) return e.key
  if (e instanceof DomainError) return e.key ?? Object.values(e.fields ?? {}).flat()[0] ?? e.kind
  if (e instanceof RoomSortRoomTakenError) return 'roomSort.roomTaken'
  if (e instanceof ZuordnungFehlt) return 'channel.unmappedRoomType'
  return 'channel.internal'
}

class ZuordnungFehlt extends Error {
  constructor() { super('channel.unmappedRoomType') }
}

/** Tage mit gleichem Wert zu Zeitraeumen zusammenfassen, je Zimmertyp. */
export function zeitraeume(
  tage: Array<{ roomType: string; date: string; available: number }>
): AdapterVerfuegbarkeit[] {
  const sortiert = [...tage].sort((a, b) =>
    a.roomType === b.roomType ? a.date.localeCompare(b.date) : a.roomType.localeCompare(b.roomType))
  const aus: AdapterVerfuegbarkeit[] = []
  for (const t of sortiert) {
    const letzter = aus.at(-1)
    if (letzter !== undefined && letzter.roomType === t.roomType && letzter.to === t.date
        && letzter.available === t.available) {
      letzter.to = addDays(t.date, 1)
    } else {
      aus.push({ roomType: t.roomType, from: t.date, to: addDays(t.date, 1),
                 available: t.available })
    }
  }
  return aus
}

async function protokoll(
  client: PoolClient, propertyId: number, z: ZugangZeile,
  e: { kind: string; status: 'ok' | 'failed'; items: number; differences?: number | null
       errorKey?: string | null; startedAt: Date }
): Promise<void> {
  await client.query(
    `INSERT INTO channel_sync_log
       (property_id, connection_id, kind, mode, status, items, differences, error_key, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [propertyId, z.id, e.kind, z.sync_mode, e.status, e.items, e.differences ?? null,
     e.errorKey ?? null, e.startedAt])
}

/** Fehler am Zugang festhalten; eine Protokollzeile nur, wenn er neu ist. */
async function fehlerVermerken(
  pool: Pool, ctx: DbContext, propertyId: number, z: ZugangZeile, kind: string,
  key: string, startedAt: Date
): Promise<void> {
  await withTransaction(pool, ctx, async client => {
    if (z.last_error_key !== key) {
      await protokoll(client, propertyId, z, { kind, status: 'failed', items: 0, errorKey: key,
                                               startedAt })
    }
    await client.query(`UPDATE channel_connection SET last_error_key = $2 WHERE id = $1`,
      [z.id, key])
  })
  z.last_error_key = key
}

export async function syncChannels(
  pool: Pool, ctx: DbContext, propertyId: number, deps: KanalDeps
): Promise<KanalLaufErgebnis> {
  const ergebnis: KanalLaufErgebnis = { connections: 0, days: 0, bookings: 0, failed: 0 }
  const { zugaenge, uebung } = await withTransaction(pool, ctx, async client => {
    const p = await client.query<{ is_training: boolean }>(
      `SELECT is_training FROM property WHERE id = $1`, [propertyId])
    const z = await client.query<ZugangZeile>(
      `SELECT id, account_id, provider, sync_mode, credentials_enc, external_property_id,
              availability_sent_until::text, full_sync_requested_at::text, last_error_key
         FROM channel_connection
        WHERE property_id = $1 AND kind = 'adapter' AND status = 'active'
        ORDER BY id`, [propertyId])
    return { zugaenge: z.rows, uebung: p.rows[0]?.is_training ?? false }
  })
  // Ein Uebungshaus exportiert nicht nach draussen (CLAUDE.md). Anlegen
  // laesst die API einen Adapter dort nicht; das hier faengt ein Haus, das
  // nachtraeglich zum Uebungshaus wurde.
  if (uebung) return ergebnis

  for (const z of zugaenge) {
    ergebnis.connections++
    const beginn = new Date()
    const adapter = deps.adapters[z.provider]
    if (adapter === undefined) {
      await fehlerVermerken(pool, ctx, propertyId, z, 'availability', 'channel.adapterMissing',
        beginn)
      ergebnis.failed++
      continue
    }
    let zugang: AdapterZugang
    try {
      zugang = { externalPropertyId: z.external_property_id,
                 credentials: decryptSecret(z.credentials_enc, deps.secret,
                   CHANNEL_CREDENTIALS_PURPOSE) }
    } catch {
      await fehlerVermerken(pool, ctx, propertyId, z, 'availability',
        'channel.credentialsUnreadable', beginn)
      ergebnis.failed++
      continue
    }

    try {
      ergebnis.days += await verfuegbarkeit(pool, ctx, propertyId, z, adapter, zugang, beginn)
    } catch (e) {
      const key = fehlerSchluessel(e)
      if (key === 'channel.internal') deps.log.error({ property: propertyId, connection: z.id,
                                                       err: e }, 'Kanalabgleich fehlgeschlagen')
      await fehlerVermerken(pool, ctx, propertyId, z, 'availability', key, beginn)
      ergebnis.failed++
      // Ohne Verfuegbarkeit auch keine Buchungen: meist ist der Anbieter
      // ganz weg, und der naechste Lauf versucht beides.
      continue
    }

    try {
      ergebnis.bookings += await buchungen(pool, ctx, propertyId, z, adapter, zugang, deps)
    } catch (e) {
      const key = fehlerSchluessel(e)
      if (key === 'channel.internal') deps.log.error({ property: propertyId, connection: z.id,
                                                       err: e }, 'Abholen der Buchungen fehlgeschlagen')
      await fehlerVermerken(pool, ctx, propertyId, z, 'bookings', key, beginn)
      ergebnis.failed++
    }
  }

  if (zugaenge.length > 0) {
    await withTransaction(pool, ctx, client => client.query(
      `DELETE FROM channel_sync_log
        WHERE property_id = $1 AND finished_at < now() - make_interval(days => $2)`,
      [propertyId, PROTOKOLL_TAGE]))
  }
  return ergebnis
}

async function verfuegbarkeit(
  pool: Pool, ctx: DbContext, propertyId: number, z: ZugangZeile, adapter: ChannelAdapter,
  zugang: AdapterZugang, beginn: Date
): Promise<number> {
  const voll = z.full_sync_requested_at !== null || z.availability_sent_until === null
  const { tage, bis } = await withTransaction(pool, ctx, async client => {
    const heute = await roomSortToday(client, propertyId)
    // Nur zugeordnete Gruppen: was keinem Zimmertyp beim Anbieter
    // entspricht, wird dort nicht verkauft. Dieselbe Rechnung wie die
    // ARI-Schnittstelle (`ariAvailability`), nie unter null.
    const r = await client.query<{ room_type: string; date: string; available: number
                                   updated_at: Date }>(
      `SELECT m.external_room_type AS room_type, d.date::text,
              GREATEST(d.capacity - d.sold - d.blocked + d.overbooking, 0) AS available,
              d.updated_at
         FROM inventory_day d
         JOIN channel_room_map m ON m.category_id = d.category_id AND m.connection_id = $2
        WHERE d.property_id = $1 AND d.date >= $3::date AND d.date < $4::date
          AND ($5::timestamptz IS NULL
               OR d.updated_at > $5::timestamptz - $6::interval)`,
      [propertyId, z.id, heute, addDays(heute, HORIZONT_TAGE),
       voll ? null : z.availability_sent_until, UEBERLAPPUNG])
    const bis = r.rows.reduce<Date | null>((m, x) =>
      m === null || x.updated_at > m ? x.updated_at : m, null)
    return { tage: r.rows.map(x => ({ roomType: x.room_type, date: x.date,
                                      available: Number(x.available) })), bis }
  })
  if (tage.length === 0 && !voll) return 0

  const posten = zeitraeume(tage)
  if (z.sync_mode === 'active' && posten.length > 0) {
    await adapter.pushAvailability(zugang, posten)
  }

  await withTransaction(pool, ctx, async client => {
    await client.query(
      `UPDATE channel_connection
          SET availability_sent_until = GREATEST(availability_sent_until,
                                                 COALESCE($2::timestamptz, availability_sent_until),
                                                 CASE WHEN availability_sent_until IS NULL
                                                      THEN $3::timestamptz END),
              full_sync_requested_at = CASE WHEN full_sync_requested_at <= $3::timestamptz
                                            THEN NULL ELSE full_sync_requested_at END,
              last_sync_at = now(), last_error_key = NULL
        WHERE id = $1`, [z.id, bis, beginn])
    await protokoll(client, propertyId, z, { kind: voll ? 'full' : 'availability', status: 'ok',
                                             items: tage.length, startedAt: beginn })
  })
  z.last_error_key = null
  return tage.length
}

/** Die Gruppe zum Zimmertyp des Anbieters; ohne Zuordnung keine Buchung. */
async function gruppen(client: PoolClient, connectionId: number): Promise<Map<string, {
  id: number; code: string }>> {
  const r = await client.query<{ external_room_type: string; id: number; code: string }>(
    `SELECT m.external_room_type, c.id, c.code
       FROM channel_room_map m JOIN resource_category c ON c.id = m.category_id
      WHERE m.connection_id = $1`, [connectionId])
  return new Map(r.rows.map(x => [x.external_room_type, { id: Number(x.id), code: x.code }]))
}

function rumpf(b: AdapterBuchung, nachTyp: Map<string, { code: string }>): KanalRumpf {
  return {
    segments: b.segments.map(s => {
      const g = nachTyp.get(s.roomType)
      if (g === undefined) throw new ZuordnungFehlt()
      return { categoryCode: g.code, arrival: s.arrival, departure: s.departure,
               adults: s.adults, children: s.children, totalCent: s.totalCent }
    }),
    totalCent: b.totalCent,
    channelCode: b.channelCode,
    guest: b.guest,
    notes: b.notes,
    sourceUpdatedAt: b.sourceUpdatedAt
  }
}

async function buchungen(
  pool: Pool, ctx: DbContext, propertyId: number, z: ZugangZeile, adapter: ChannelAdapter,
  zugang: AdapterZugang, deps: KanalDeps
): Promise<number> {
  const beginn = new Date()
  if (z.sync_mode === 'shadow') return probeVergleich(pool, ctx, propertyId, z, adapter, zugang)

  const liste = await adapter.fetchBookings(zugang)
  if (liste.length === 0) return 0
  const kz: KanalZugang = { connectionId: z.id, propertyId, accountId: z.account_id,
                            provider: z.provider }
  let verarbeitet = 0
  let ersterFehler: string | null = null
  for (const b of liste) {
    try {
      await withTransaction(pool, ctx, async client => {
        // Schon verarbeitet: die Bestaetigung ging verloren, oder der
        // Anbieter liefert erneut. Nur noch einmal bestaetigen.
        const schon = await client.query(
          `SELECT 1 FROM channel_booking_revision
            WHERE connection_id = $1 AND external_revision_id = $2`, [z.id, b.revisionId])
        if ((schon.rowCount ?? 0) > 0) return true
        let outcome: string
        if (b.status === 'cancelled') {
          try {
            outcome = (await kanalBuchungStornieren(client, kz, b.externalReference,
              b.sourceUpdatedAt ?? null)).status
          } catch (e) {
            // Ein Storno einer Buchung, die StayGrid nie bekam: nichts zu tun.
            if (e instanceof DomainError && e.kind === 'notFound') outcome = 'unknown'
            else throw e
          }
        } else {
          const body = kanalRumpfPruefen(rumpf(b, await gruppen(client, z.id)))
          outcome = (await kanalBuchungSetzen(client, kz, b.externalReference, body)).status
        }
        await client.query(
          `INSERT INTO channel_booking_revision
             (connection_id, external_revision_id, property_id, external_reference, outcome)
           VALUES ($1,$2,$3,$4,$5)`,
          [z.id, b.revisionId, propertyId, b.externalReference, outcome])
        return true
      })
      await adapter.ackBooking(zugang, b.revisionId)
      await withTransaction(pool, ctx, client => client.query(
        `UPDATE channel_booking_revision SET acknowledged = true
          WHERE connection_id = $1 AND external_revision_id = $2`, [z.id, b.revisionId]))
      verarbeitet++
    } catch (e) {
      // Nicht bestaetigt: der Anbieter liefert die Revision wieder, und der
      // naechste Lauf versucht es neu -- etwa nachdem jemand den Zimmertyp
      // zugeordnet hat. Die uebrigen Buchungen laufen weiter.
      const key = fehlerSchluessel(e)
      if (key === 'channel.internal') {
        deps.log.error({ property: propertyId, connection: z.id, err: e },
          'Kanalbuchung nicht verarbeitet')
      }
      ersterFehler ??= key
    }
  }

  await withTransaction(pool, ctx, client => protokoll(client, propertyId, z, {
    kind: 'bookings', status: ersterFehler === null ? 'ok' : 'failed', items: verarbeitet,
    errorKey: ersterFehler, startedAt: beginn }))
  if (ersterFehler !== null) {
    await withTransaction(pool, ctx, client => client.query(
      `UPDATE channel_connection SET last_error_key = $2 WHERE id = $1`, [z.id, ersterFehler]))
    z.last_error_key = ersterFehler
  }
  return verarbeitet
}

/**
 * Probebetrieb: lesen, vergleichen, nichts schreiben ausser dem Protokoll.
 *
 * Verglichen werden Gruppe und Tage der lebenden Reservierungen mit den
 * Aufenthalten beim Anbieter. Personen und Preis nicht: die fuehrt das
 * Adminpanel auf seine Art, und ein Unterschied dort hiesse nichts ueber
 * die Frage, ob der direkte Weg dieselben Buchungen saehe.
 */
async function probeVergleich(
  pool: Pool, ctx: DbContext, propertyId: number, z: ZugangZeile, adapter: ChannelAdapter,
  zugang: AdapterZugang
): Promise<number> {
  if (adapter.peekBookings === undefined) return 0
  const faellig = await withTransaction(pool, ctx, async client => {
    const r = await client.query(
      `SELECT 1 FROM channel_sync_log
        WHERE connection_id = $1 AND kind = 'bookings'
          AND finished_at > now() - make_interval(mins => $2) LIMIT 1`,
      [z.id, PROBE_BUCHUNGEN_MINUTEN])
    return (r.rowCount ?? 0) === 0
  })
  if (!faellig) return 0

  const beginn = new Date()
  const liste = await adapter.peekBookings(zugang)
  const unterschiede = await withTransaction(pool, ctx, async client => {
    const nachTyp = await gruppen(client, z.id)
    let n = 0
    for (const b of liste) {
      const ist = await client.query<{ category_id: number; arrival: string; departure: string }>(
        `SELECT r.category_id, r.arrival::text, r.departure::text
           FROM booking k JOIN reservation r ON r.booking_id = k.id
          WHERE k.property_id = $1 AND k.external_reference = $2
            AND r.status = ANY($3::reservation_status[])
          ORDER BY r.arrival, r.category_id`, [propertyId, b.externalReference, LEBEND])
      const soll = b.status === 'cancelled' ? [] : b.segments.map(s => ({
        category_id: nachTyp.get(s.roomType)?.id ?? -1, arrival: s.arrival,
        departure: s.departure }))
      soll.sort((a, x) => a.arrival.localeCompare(x.arrival) || a.category_id - x.category_id)
      const gleich = ist.rows.length === soll.length && ist.rows.every((r, i) =>
        Number(r.category_id) === soll[i]!.category_id && r.arrival === soll[i]!.arrival
        && r.departure === soll[i]!.departure)
      if (!gleich) n++
    }
    return n
  })
  await withTransaction(pool, ctx, client => protokoll(client, propertyId, z, {
    kind: 'bookings', status: 'ok', items: liste.length, differences: unterschiede,
    startedAt: beginn }))
  return liste.length
}
