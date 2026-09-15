import type { FastifyInstance, FastifyRequest } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { parseCsv, toRecords, CsvError } from '../platform/csv.js'
import { isIsoDate, nightsBetween, eachNight } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Minimaler CSV-Import (AP 11b).
 *
 * Das Pilothaus hat am Starttag Reservierungen fuer Monate im Voraus. Ohne
 * einen Weg, die zu uebernehmen, geht es nicht produktiv (E1, Dokument 13).
 *
 * Drei Eigenschaften machen den Unterschied zwischen einem Import und einem
 * Datenunfall:
 *
 * 1. **Der Trockenlauf ist der Regelfall.** Ohne `commit: true` wird nichts
 *    geschrieben, aber alles geprueft. Der Bericht ist derselbe.
 * 2. **Es laeuft durch dieselben Funktionen wie die Oberflaeche.** Das
 *    Kontingent wird ueber `inventory_reserve` gebunden, nicht per INSERT
 *    danebengeschrieben. Sonst stimmen die Zaehler ab dem ersten Tag nicht.
 * 3. **Ganz oder gar nicht.** Der ganze Import ist eine Transaktion. Ein
 *    halb uebernommener Bestand ist schlimmer als gar keiner, weil niemand
 *    weiss, welche Haelfte fehlt.
 */

const MAX_ZEILEN = 20_000

export interface Befund {
  row: number
  level: 'error' | 'warning'
  message: string
  reference?: string
}

interface ImportBody {
  propertyId: number
  /** Der Inhalt der Datei als Text. Kein Datei-Upload, kein Zwischenspeicher. */
  csv: string
  commit?: boolean
}

export interface ImportResult {
  dryRun: boolean
  rows: number
  imported: number
  skipped: number
  findings: Befund[]
}

/** Deutsches Datum oder ISO. Das Altsystem liefert selten ISO. */
function parseDatum(v: string): string | null {
  if (isIsoDate(v)) return v
  const m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(v)
  if (m === null) return null
  const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  return isIsoDate(iso) ? iso : null
}

/** "1.234,50" und "1234.50" ergeben beide 123450 Cent. */
function parseCent(v: string): number | null {
  if (v === '') return 0
  const norm = v.replace(/[^\d,.-]/g, '')
  const deutsch = /,\d{1,2}$/.test(norm)
  const zahl = deutsch
    ? Number(norm.replace(/\./g, '').replace(',', '.'))
    : Number(norm.replace(/,/g, ''))
  if (!Number.isFinite(zahl)) return null
  return Math.round(zahl * 100)
}

const KATEGORIE_SPALTEN = ['code', 'name'] as const
const GAST_SPALTEN = ['last_name'] as const
const RESERVIERUNG_SPALTEN = ['external_reference', 'category_code',
                              'arrival', 'departure'] as const

async function importCategories(
  client: PoolClient, propertyId: number, records: Array<Record<string, string>>
): Promise<{ imported: number; findings: Befund[] }> {
  const findings: Befund[] = []
  let imported = 0
  for (const [i, r] of records.entries()) {
    const row = i + 2
    if (r.code === '') { findings.push({ row, level: 'error', message: 'code fehlt' }); continue }
    const belegung = r.max_occupancy === '' ? 2 : Number(r.max_occupancy)
    if (!Number.isInteger(belegung) || belegung < 1) {
      findings.push({ row, level: 'error', message: 'max_occupancy ist keine ganze Zahl' })
      continue
    }
    const res = await client.query(
      `INSERT INTO resource_category (property_id, code, name, max_occupancy)
       VALUES ($1,$2,$3,$4) ON CONFLICT (property_id, code) DO NOTHING`,
      [propertyId, r.code, r.name === '' ? r.code : r.name, belegung])
    if (res.rowCount === 0) {
      findings.push({ row, level: 'warning', message: 'Kategorie existiert bereits',
                      reference: r.code })
    } else imported++
  }
  return { imported, findings }
}

async function importGuests(
  client: PoolClient, accountId: number, records: Array<Record<string, string>>
): Promise<{ imported: number; findings: Befund[] }> {
  const findings: Befund[] = []
  let imported = 0
  for (const [i, r] of records.entries()) {
    const row = i + 2
    if (r.last_name === '') {
      findings.push({ row, level: 'error', message: 'last_name fehlt' }); continue
    }
    const geburt = r.birth_date === '' || r.birth_date === undefined
      ? null : parseDatum(r.birth_date)
    if (r.birth_date !== '' && r.birth_date !== undefined && geburt === null) {
      findings.push({ row, level: 'warning', message: 'birth_date unlesbar, wird ignoriert' })
    }
    // Eine vorhandene E-Mail bedeutet denselben Gast. Ohne E-Mail wird
    // angelegt: zwei Profile sind reparabel, ein falsch zusammengefuehrtes
    // Profil verbindet die Aufenthalte zweier Menschen.
    if (r.email !== '' && r.email !== undefined) {
      const da = await client.query(
        `SELECT 1 FROM guest WHERE account_id = $1 AND lower(email) = lower($2) LIMIT 1`,
        [accountId, r.email])
      if (da.rowCount && da.rowCount > 0) {
        findings.push({ row, level: 'warning', message: 'Gast mit dieser E-Mail existiert',
                        reference: r.email })
        continue
      }
    }
    await client.query(
      `INSERT INTO guest (account_id, last_name, first_name, email, phone, birth_date,
                          address_line1, postal_code, city, country, language)
       VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6::date,NULLIF($7,''),
               NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),COALESCE(NULLIF($11,''),'de'))`,
      [accountId, r.last_name, r.first_name ?? null, r.email ?? '', r.phone ?? '',
       geburt, r.address_line1 ?? '', r.postal_code ?? '', r.city ?? '',
       (r.country ?? '').toUpperCase().slice(0, 2), r.language ?? ''])
    imported++
  }
  return { imported, findings }
}

async function importReservations(
  client: PoolClient, propertyId: number, accountId: number, userId: number | null,
  records: Array<Record<string, string>>
): Promise<{ imported: number; findings: Befund[] }> {
  const findings: Befund[] = []
  let imported = 0

  const kategorien = await client.query<{ id: number; code: string }>(
    `SELECT id, code FROM resource_category WHERE property_id = $1`, [propertyId])
  const byCode = new Map(kategorien.rows.map(k => [k.code, k.id]))

  for (const [i, r] of records.entries()) {
    const row = i + 2
    const ref = r.external_reference
    const catId = byCode.get(r.category_code!)
    if (catId === undefined) {
      findings.push({ row, level: 'error', reference: ref,
                      message: `Kategorie ${r.category_code} gibt es nicht` })
      continue
    }
    const arrival = parseDatum(r.arrival!)
    const departure = parseDatum(r.departure!)
    if (arrival === null || departure === null) {
      findings.push({ row, level: 'error', reference: ref,
                      message: 'arrival oder departure unlesbar' })
      continue
    }
    if (nightsBetween(arrival, departure) <= 0) {
      findings.push({ row, level: 'error', reference: ref,
                      message: 'departure liegt nicht nach arrival' })
      continue
    }
    const preis = parseCent(r.total_price ?? '')
    if (preis === null) {
      findings.push({ row, level: 'error', reference: ref,
                      message: 'total_price unlesbar' })
      continue
    }

    const doppelt = await client.query(
      `SELECT 1 FROM booking WHERE property_id = $1 AND external_reference = $2 LIMIT 1`,
      [propertyId, ref])
    if (doppelt.rowCount && doppelt.rowCount > 0) {
      findings.push({ row, level: 'warning', reference: ref,
                      message: 'Bereits importiert, wird uebersprungen' })
      continue
    }

    // Dieselbe Funktion wie die Oberflaeche: die Zaehler bleiben stimmig.
    const inv = await client.query<{ e: string | null }>(
      `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
      [propertyId, catId, arrival, departure])
    const fehler = inv.rows[0]!.e
    if (fehler === 'sold_out') {
      findings.push({ row, level: 'error', reference: ref,
                      message: 'Kein Kontingent frei. Der Altbestand ist ueberbucht '
                             + 'oder es fehlen Zimmer in dieser Kategorie.' })
      continue
    }
    if (fehler === 'not_materialized') {
      findings.push({ row, level: 'error', reference: ref,
                      message: 'Zeitraum liegt ausserhalb des vorbereiteten Horizonts' })
      continue
    }

    let guestId: number | null = null
    if (r.guest_email !== '' && r.guest_email !== undefined) {
      const g = await client.query<{ id: number }>(
        `SELECT id FROM guest WHERE account_id = $1 AND lower(email) = lower($2) LIMIT 1`,
        [accountId, r.guest_email])
      guestId = g.rows[0]?.id ?? null
      if (guestId === null) {
        findings.push({ row, level: 'warning', reference: ref,
                        message: 'Gast zur E-Mail nicht gefunden, Reservierung ohne Profil' })
      }
    } else if (r.guest_last_name !== '' && r.guest_last_name !== undefined) {
      const g = await client.query<{ id: number }>(
        `INSERT INTO guest (account_id, last_name, first_name)
         VALUES ($1,$2,NULLIF($3,'')) RETURNING id`,
        [accountId, r.guest_last_name, r.guest_first_name ?? ''])
      guestId = g.rows[0]!.id
    }

    const booking = await client.query<{ id: number }>(
      `INSERT INTO booking (property_id, booker_guest_id, source, external_reference,
                            channel_code, created_by)
       VALUES ($1,$2,'import',$3,NULLIF($4,''),$5) RETURNING id`,
      [propertyId, guestId, ref, r.channel ?? '', userId])

    const reservierung = await client.query<{ id: number; public_ref: string }>(
      `INSERT INTO reservation (property_id, booking_id, category_id, arrival, departure,
                                status, primary_guest_id, notes, created_by)
       VALUES ($1,$2,$3,$4::date,$5::date,'Confirmed',$6,NULLIF($7,''),$8)
       RETURNING id, public_ref`,
      [propertyId, booking.rows[0]!.id, catId, arrival, departure, guestId,
       r.notes ?? '', userId])

    // Der Gesamtpreis wird gleichmaessig auf die Naechte verteilt, der Rest
    // faellt auf die erste Nacht. Das Altsystem liefert selten Tagespreise,
    // und die Summe muss stimmen.
    const naechte = eachNight(arrival, departure)
    const proNacht = Math.floor(preis / naechte.length)
    const rest = preis - proNacht * naechte.length
    for (const [n, datum] of naechte.entries()) {
      await client.query(
        `INSERT INTO reservation_night (reservation_id, property_id, date, price_cent)
         VALUES ($1,$2,$3::date,$4)`,
        [reservierung.rows[0]!.id, propertyId, datum, proNacht + (n === 0 ? rest : 0)])
    }
    await client.query(
      `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
       VALUES ($1,$2,$3,'guest')`,
      [propertyId, reservierung.rows[0]!.id, guestId])

    imported++
  }
  return { imported, findings }
}

/**
 * Fuehrt einen Import durch, gleich welche Quelle die Zeilen geliefert hat
 * (CSV eines Aufrufers oder ein Adapter fuer ein Altsystem, siehe
 * routes/legacyImport.ts). Ganz oder gar nicht, Trockenlauf als Regelfall:
 * ein Aufrufer, der wiederholt importiert - etwa bei einer
 * Stichtagsmigration, erst zur Probe, dann kurz vor und am Stichtag selbst -
 * bekommt jedes Mal denselben Bericht, und eine schon uebernommene externe
 * Nummer wird uebersprungen, nicht doppelt angelegt (siehe importReservations
 * oben). Der Bericht selbst ist der Abgleich: jede nicht uebernommene Zeile
 * steht mit Grund darin, ob Ursache ein Fehler im Altbestand ist oder eine
 * bereits erledigte Zeile aus einem frueheren Lauf.
 */
export async function runImport(
  req: FastifyRequest, propertyId: number, commit: boolean,
  records: Array<Record<string, string>>,
  art: 'categories' | 'guests' | 'reservations'
): Promise<ImportResult> {
  const principal = req.principal as Principal
  return tx(req.pool, req, async client => {
    const account = await client.query<{ account_id: number }>(
      `SELECT account_id FROM property WHERE id = $1`, [propertyId])
    if (account.rowCount === 0) throw Errors.notFound('res.property')
    const accountId = account.rows[0]!.account_id

    const r = art === 'categories'
      ? await importCategories(client, propertyId, records)
      : art === 'guests'
        ? await importGuests(client, accountId, records)
        : await importReservations(client, propertyId, accountId,
                                   principal.userId, records)

    const fehler = r.findings.filter(f => f.level === 'error').length
    const result: ImportResult = {
      dryRun: commit !== true,
      rows: records.length,
      imported: r.imported,
      skipped: records.length - r.imported,
      findings: r.findings.slice(0, 500)
    }

    // Der Trockenlauf ist der Regelfall: ohne commit wird zurueckgerollt,
    // aber alles geprueft. Der Bericht ist in beiden Faellen derselbe.
    if (commit !== true) {
      throw new DryRun(result)
    }
    if (fehler > 0) {
      // Ganz oder gar nicht. Ein halb uebernommener Bestand ist schlimmer
      // als keiner, weil niemand weiss, welche Haelfte fehlt.
      throw new DryRun({ ...result, dryRun: true, imported: 0,
                         skipped: records.length })
    }
    return result
  }).catch((e: unknown) => {
    if (e instanceof DryRun) return e.result
    throw e
  })
}

export function importRoutes(app: FastifyInstance): void {
  const route = (
    art: 'categories' | 'guests' | 'reservations',
    spalten: readonly string[],
    summary: string
  ) => registerRoute(app, {
    method: 'POST',
    url: `/v1/imports/${art}`,
    // Import legt Stammdaten und Bestand an. Das ist Einrichtung, nicht
    // Tagesgeschaeft, und braucht deshalb die Einstellungsberechtigung.
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary,
    // 20 000 Reservierungen als CSV sind mehrere Megabyte. Mit dem Standard
    // von einem Megabyte waere der Import genau dann unbrauchbar, wenn er
    // gebraucht wird: bei der Uebernahme eines ganzen Hauses.
    bodyLimit: 32 * 1024 * 1024,
    handler: async (req) => {
      const body = req.body as ImportBody
      if (typeof body.csv !== 'string' || body.csv.trim() === '') {
        throw Errors.validation({ csv: ['field.required'] })
      }

      let records: Array<Record<string, string>>
      try {
        const { header, rows } = parseCsv(body.csv, { maxRows: MAX_ZEILEN })
        records = toRecords(header, rows, spalten)
      } catch (e) {
        if (e instanceof CsvError) throw Errors.unprocessable(e.message)
        throw e
      }

      return runImport(req, body.propertyId, body.commit === true, records, art)
    }
  })

  route('categories', KATEGORIE_SPALTEN, 'Kategorien aus CSV importieren')
  route('guests', GAST_SPALTEN, 'Gaeste aus CSV importieren')
  route('reservations', RESERVIERUNG_SPALTEN, 'Reservierungen aus CSV importieren')

  registerRoute(app, {
    method: 'GET',
    url: '/v1/imports/templates',
    permission: 'settings:property',
    summary: 'Spaltenvorlagen fuer den Import',
    handler: async () => ({
      categories: {
        required: KATEGORIE_SPALTEN,
        optional: ['max_occupancy'],
        example: 'code;name;max_occupancy\r\nDZ;Doppelzimmer;2\r\nEZ;Einzelzimmer;1\r\n'
      },
      guests: {
        required: GAST_SPALTEN,
        optional: ['first_name', 'email', 'phone', 'birth_date', 'address_line1',
                   'postal_code', 'city', 'country', 'language'],
        example: 'last_name;first_name;email;city;country\r\n'
               + 'Sonnenschein;Anke;anke@example.de;Husum;DE\r\n'
      },
      reservations: {
        required: RESERVIERUNG_SPALTEN,
        optional: ['total_price', 'guest_email', 'guest_last_name', 'guest_first_name',
                   'channel', 'notes'],
        example: 'external_reference;category_code;arrival;departure;total_price;'
               + 'guest_last_name\r\nALT-1001;DZ;01.07.2026;05.07.2026;480,00;Petersen\r\n'
      },
      hinweise: [
        'Trennzeichen Semikolon oder Komma, Kodierung UTF-8.',
        'Datum als TT.MM.JJJJ oder JJJJ-MM-TT.',
        'Betraege als 1.234,50 oder 1234.50, immer der Gesamtpreis des Aufenthalts.',
        'Ohne commit=true laeuft nur ein Trockenlauf. Der Bericht ist derselbe.',
        'Reihenfolge: erst Kategorien, dann Gaeste, dann Reservierungen.'
      ]
    })
  })
}

/**
 * Traegt das Ergebnis aus der Transaktion heraus und rollt sie dabei zurueck.
 * Ein Trockenlauf, der per Flag am Ende nicht committet, laesst leicht eine
 * Abzweigung offen, die doch schreibt; ein Fehlerwurf kann das nicht.
 */
class DryRun extends Error {
  constructor(readonly result: ImportResult) {
    super('Trockenlauf')
    this.name = 'DryRun'
  }
}
