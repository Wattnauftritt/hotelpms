import type { FastifyInstance } from 'fastify'
import type { KwhotelUndoReport } from '@hotelpms/contracts'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { geschaeftstag } from './depositRequests.js'
import { Befunde, SYSTEM } from './kwhotelImport.js'

/**
 * Eine KWHotel-Uebernahme zuruecknehmen.
 *
 * Anlass: am 04.10.2026 landete ein ganzes Hotel mit drei Jahren Buchungen
 * im Gaestehaus daneben, weil die Uebernahme still in das Haus der
 * Kopfzeile schrieb. Ein Neuimport im richtigen Haus ist geprueft und
 * dauert Sekunden; was fehlte, war der Weg zurueck.
 *
 * **Was dazugehoert, erkennt die Ruecknahme am Zeitpunkt.** Eine
 * Uebernahme laeuft in einer Transaktion, und `created_at` traegt ueberall
 * deren Startzeit (`now()`). Reservierungen tragen ausserdem die Kennung
 * des Altsystems. Buchungen, Gastprofile, Zimmer und Zimmergruppen mit genau
 * diesem Zeitpunkt sind also von der Uebernahme angelegt worden -- und nur
 * die werden entfernt. Was vorher da war, bleibt, auch wenn Reservierungen
 * der Uebernahme darauf lagen.
 *
 * **Nur, solange niemand daran gearbeitet hat.** Haengt an einer
 * uebernommenen Reservierung oder ihrem Folio inzwischen etwas -- eine
 * Buchung auf dem Folio, ein Meldeschein, eine Mail, eine Begleitperson --,
 * nimmt die Ruecknahme gar nichts zurueck und nennt, woran es haengt. Eine
 * Buchung auf einem Folio ist Haertegrad 1 (CLAUDE.md) und laesst sich
 * nicht entfernen; die Haelfte einer Uebernahme zurueckzunehmen hinterliesse
 * ein Haus, dessen Stand niemand mehr erklaeren kann.
 *
 * **Gastprofile werden geloescht, nicht anonymisiert.** Die Regel, dass
 * alles zu einem Gast an einer Stelle geloescht wird (`guest_erase_one`),
 * gilt der Loeschung eines Menschen auf Verlangen: dort muss der Beleg
 * bleiben und der Name gehen. Hier geht es um Zeilen, die nie haetten
 * entstehen sollen und beim Neuimport im richtigen Haus neu entstehen;
 * stehen blieben sonst Tausende anonymer Doppelgaenger. Ein Profil, an dem
 * inzwischen etwas anderes haengt, bleibt stehen. Der Audit-Trigger
 * schreibt die Loeschung mit, ohne personenbezogene Werte (Migration 0044).
 *
 * Trockenlauf als Regelfall, wie bei der Uebernahme: geprueft wird, indem
 * alles getan und zurueckgerollt wird.
 */

/**
 * Was an einer Reservierung oder einem Folio haengen kann, ohne Teil der
 * Uebernahme zu sein. Ein Test vergleicht diese Liste mit den
 * Fremdschluesseln der Datenbank: eine neue Tabelle mit einem Verweis auf
 * eine Reservierung muss hier auftauchen, sonst ist der Test rot.
 */
export const FOLGEN_RESERVIERUNG = [
  'registration', 'charge', 'outbound_email', 'guest_agreement', 'deposit_request',
  'checkin_token', 'terminal_job', 'reservation_occupant', 'routing_rule'
] as const
export const FOLGEN_FOLIO = [
  'invoice', 'charge', 'settlement', 'routing_rule', 'payment_intent', 'deposit_ledger',
  'deposit_request', 'deposit_request_settlement', 'payment_link'
] as const
/** Teil der Uebernahme selbst; geht mit der Reservierung bzw. wird hier entfernt. */
export const TEIL_DER_UEBERNAHME = ['reservation_night', 'reservation_change', 'folio'] as const

/** Was an einem Gastprofil haengen kann. Ebenso gegen die Datenbank getestet. */
export const VERWEISE_GAST = [
  ['guest_property_note', 'guest_id'], ['booking', 'booker_guest_id'],
  ['reservation', 'primary_guest_id'], ['reservation_occupant', 'guest_id'],
  ['registration', 'guest_id'], ['folio', 'guest_id'], ['guest_agreement', 'guest_id']
] as const

/** Was an einem Zimmer haengen kann und es deshalb stehen laesst. */
export const VERWEISE_ZIMMER = [
  ['reservation', 'resource_id'], ['maintenance_block', 'resource_id'],
  ['maintenance_ticket', 'resource_id']
] as const
/** Zustand des Zimmers, der mit ihm geht. */
export const ZUSTAND_ZIMMER = ['housekeeping_status', 'housekeeping_task'] as const

export const VERWEISE_GRUPPE = [
  ['resource', 'category_id'], ['reservation', 'category_id'], ['rate_plan', 'category_id'],
  ['availability_block', 'category_id'], ['rate_steer_rule', 'category_id']
] as const

class Zurueck extends Error {
  constructor(readonly report: KwhotelUndoReport) {
    super('Trockenlauf')
    this.name = 'Zurueck'
  }
}

const nichtVerwiesen = (alias: string, verweise: ReadonlyArray<readonly [string, string]>) =>
  verweise.map(([t, s]) => `NOT EXISTS (SELECT 1 FROM ${t} v WHERE v.${s} = ${alias}.id)`)
    .join(' AND ')

async function zuruecknehmen(client: PoolClient, propertyId: number): Promise<KwhotelUndoReport> {
  const befunde = new Befunde()
  const counts = { reservations: 0, bookings: 0, nights: 0, folios: 0, guests: 0,
                   guestsKept: 0, rooms: 0, roomsKept: 0, categories: 0, categoriesKept: 0 }

  const haus = await client.query<{ account_id: number }>(
    `SELECT account_id FROM property WHERE id = $1`, [propertyId])
  if (haus.rowCount === 0) throw Errors.notFound('res.property')
  const accountId = haus.rows[0]!.account_id

  // Der Zeitpunkt geht als Text weiter, nicht als `Date`: Postgres speichert
  // Mikrosekunden, JavaScript nur Millisekunden, und ein gerundeter Zeitpunkt
  // traefe keine einzige Zeile der Uebernahme.
  const laeufe = await client.query<{ at: Date; genau: string; n: number }>(
    `SELECT created_at AS at, created_at::text AS genau, count(*)::int AS n FROM reservation
      WHERE property_id = $1 AND legacy_system = $2
      GROUP BY created_at ORDER BY created_at`, [propertyId, SYSTEM])
  const runs = laeufe.rows.map(r => ({ at: r.at.toISOString(), reservations: r.n }))
  const zeitpunkte = laeufe.rows.map(r => r.genau)
  const bericht = (): KwhotelUndoReport =>
    ({ dryRun: true, runs, counts, findings: befunde.liste })
  if (runs.length === 0) {
    befunde.add('error', 'import.undo.nothing')
    return bericht()
  }

  const r = await client.query<{ id: number; booking_id: number; primary_guest_id: number | null }>(
    `SELECT id, booking_id, primary_guest_id FROM reservation
      WHERE property_id = $1 AND legacy_system = $2`, [propertyId, SYSTEM])
  const resIds = r.rows.map(x => Number(x.id))
  counts.reservations = resIds.length

  // ----------------------------------------------------------- Folgedaten
  const folgen: Array<{ table: string; n: number }> = []
  for (const t of FOLGEN_RESERVIERUNG) {
    const n = await client.query<{ n: number }>(
      `SELECT count(DISTINCT reservation_id)::int AS n FROM ${t}
        WHERE reservation_id = ANY($1::bigint[])`, [resIds])
    if (n.rows[0]!.n > 0) folgen.push({ table: t, n: n.rows[0]!.n })
  }
  for (const t of FOLGEN_FOLIO) {
    const spalte = t === 'routing_rule' ? 'target_folio_id' : 'folio_id'
    const n = await client.query<{ n: number }>(
      `SELECT count(DISTINCT f.id)::int AS n FROM ${t} x JOIN folio f ON f.id = x.${spalte}
        WHERE f.reservation_id = ANY($1::bigint[])`, [resIds])
    if (n.rows[0]!.n > 0) folgen.push({ table: t, n: n.rows[0]!.n })
  }
  // Eine Buchung der Uebernahme, an der inzwischen eine andere Reservierung haengt.
  const fremd = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reservation x
      WHERE x.booking_id IN (SELECT booking_id FROM reservation WHERE id = ANY($1::bigint[]))
        AND NOT (x.id = ANY($1::bigint[]))`, [resIds])
  if (fremd.rows[0]!.n > 0) folgen.push({ table: 'reservation', n: fremd.rows[0]!.n })
  for (const f of folgen) {
    befunde.add('error', 'import.undo.blocked', { table: f.table, count: f.n })
  }
  if (folgen.length > 0) return bericht()

  // ----------------------------------------------------------- Bestand
  /*
   * Freigegeben wird, was heute noch gebunden ist: die Naechte ab dem
   * Geschaeftstag. Die Uebernahme hat genau ab ihrem Geschaeftstag
   * gebunden; was dazwischen liegt, ist Vergangenheit, und der Nachtlauf hat
   * es als Aufzeichnung festgehalten (`business_day_stat`), nicht als Zaehler.
   */
  const heute = await geschaeftstag(client, propertyId)
  await client.query(
    `SELECT inventory_release_bulk($1, array_agg(category_id), array_agg(von),
                                   array_agg(departure), array_agg(1))
       FROM (SELECT category_id, GREATEST(arrival, $3::date) AS von, departure
               FROM reservation
              WHERE id = ANY($2::bigint[]) AND departure > $3::date
                AND status IN ('Optional','Confirmed','InHouse')) b
     HAVING count(*) > 0`, [propertyId, resIds, heute])

  // ----------------------------------------------------------- Reservierungen
  const gastKandidaten = new Set<number>()
  for (const x of r.rows) if (x.primary_guest_id !== null) gastKandidaten.add(Number(x.primary_guest_id))
  const b = await client.query<{ id: number; booker_guest_id: number | null }>(
    `SELECT DISTINCT b.id, b.booker_guest_id FROM booking b
       JOIN reservation x ON x.booking_id = b.id
      WHERE x.id = ANY($1::bigint[]) AND b.created_at = ANY($2::timestamptz[])`,
    [resIds, zeitpunkte])
  for (const x of b.rows) if (x.booker_guest_id !== null) gastKandidaten.add(Number(x.booker_guest_id))

  counts.nights = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reservation_night WHERE reservation_id = ANY($1::bigint[])`,
    [resIds])).rows[0]!.n
  counts.folios = (await client.query(
    `DELETE FROM folio WHERE reservation_id = ANY($1::bigint[])`, [resIds])).rowCount ?? 0
  await client.query(`DELETE FROM reservation WHERE id = ANY($1::bigint[])`, [resIds])
  counts.bookings = (await client.query(
    `DELETE FROM booking WHERE id = ANY($1::bigint[])`,
    [b.rows.map(x => Number(x.id))])).rowCount ?? 0

  // ----------------------------------------------------------- Gastprofile
  const gaeste = await client.query<{ id: number; frei: boolean }>(
    `SELECT g.id, (${nichtVerwiesen('g', VERWEISE_GAST)}) AS frei FROM guest g
      WHERE g.id = ANY($1::bigint[]) AND g.account_id = $2
        AND g.created_at = ANY($3::timestamptz[])`,
    [[...gastKandidaten], accountId, zeitpunkte])
  const weg = gaeste.rows.filter(x => x.frei).map(x => Number(x.id))
  counts.guestsKept = gaeste.rows.length - weg.length
  counts.guests = (await client.query(
    `DELETE FROM guest WHERE id = ANY($1::bigint[])`, [weg])).rowCount ?? 0

  // ----------------------------------------------------------- Zimmer
  const zimmer = await client.query<{ id: number; frei: boolean }>(
    `SELECT z.id, (${nichtVerwiesen('z', VERWEISE_ZIMMER)}) AS frei FROM resource z
      WHERE z.property_id = $1 AND z.created_at = ANY($2::timestamptz[])`,
    [propertyId, zeitpunkte])
  const zimmerWeg = zimmer.rows.filter(x => x.frei).map(x => Number(x.id))
  counts.roomsKept = zimmer.rows.length - zimmerWeg.length
  for (const t of ZUSTAND_ZIMMER) {
    await client.query(`DELETE FROM ${t} WHERE resource_id = ANY($1::bigint[])`, [zimmerWeg])
  }
  counts.rooms = (await client.query(
    `DELETE FROM resource WHERE id = ANY($1::bigint[])`, [zimmerWeg])).rowCount ?? 0

  // ----------------------------------------------------------- Zimmergruppen
  const gruppen = await client.query<{ id: number; frei: boolean }>(
    `SELECT k.id, (${nichtVerwiesen('k', VERWEISE_GRUPPE)}) AS frei FROM resource_category k
      WHERE k.property_id = $1 AND k.created_at = ANY($2::timestamptz[])`,
    [propertyId, zeitpunkte])
  const gruppenWeg = gruppen.rows.filter(x => x.frei).map(x => Number(x.id))
  counts.categoriesKept = gruppen.rows.length - gruppenWeg.length
  for (const k of gruppenWeg) {
    await client.query(`SELECT inventory_drop_category($1, $2)`, [propertyId, k])
  }
  counts.categories = (await client.query(
    `DELETE FROM resource_category WHERE id = ANY($1::bigint[])`, [gruppenWeg])).rowCount ?? 0

  return { ...bericht(), dryRun: false }
}

export function kwhotelUndoRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/imports/legacy/kwhotel/undo',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Eine KWHotel-Uebernahme in einem Haus zuruecknehmen',
    handler: async (req) => {
      const body = req.body as { propertyId: number; commit?: boolean }
      return tx(req.pool, req, async client => {
        const report = await zuruecknehmen(client, body.propertyId)
        if (body.commit !== true || report.findings.some(f => f.level === 'error')) {
          throw new Zurueck({ ...report, dryRun: true })
        }
        return report
      }).catch((e: unknown) => {
        if (e instanceof Zurueck) return e.report
        throw e
      })
    }
  })
}
