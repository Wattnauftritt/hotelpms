import { withTransaction, type DbContext, type Pool, type PoolClient } from '@hotelpms/db'
import { addDays, businessDateFor } from '@hotelpms/domain'

export interface NightAuditResult {
  businessDate: string
  /** Ergebnis je Schritt. Bei einem Wiederholungslauf aus der Schrittmarke. */
  steps: Record<string, number>
  /** Schritte, die dieser Lauf nicht erneut ausgefuehrt hat. */
  skipped: string[]
  checklist: Array<{ kind: string; detail: string }>
}

export interface NightAuditOptions {
  /**
   * Erzwingt einen Geschaeftstag. Ohne Angabe sucht der Lauf den aeltesten
   * Tag mit unvollstaendigen Schrittmarken und prueft die Faelligkeit.
   */
  businessDate?: string
  /** Ersetzt die Uhr fuer die Faelligkeitspruefung. */
  now?: Date
}

/** Reihenfolge ist Teil der Fachlichkeit, nicht Geschmack. */
const STEPS = [
  'rollover', 'post_accommodation', 'post_city_tax', 'no_shows', 'expire_options',
  'release_blocks', 'statistics'
] as const
type Step = (typeof STEPS)[number]

/**
 * Nachtlauf einer Property.
 *
 * Drei Eigenschaften, die jede fuer sich schon Datenverlust verhindern:
 *
 * 1. Der Tageswechsel ist **Schritt 1**, nicht der letzte (B1, Dokument 13).
 *    Sonst buchen Rezeption und Worker waehrend des Laufs noch mit dem alten
 *    Datum, und ein Abbruch in der Mitte hinterlaesst einen Zustand, den kein
 *    zweiter Lauf sauber aufloesen kann.
 * 2. **Jeder Schritt hat eine eigene Transaktion.** Ein Absturz in Schritt 4
 *    laesst die Schritte 1 bis 3 bestehen. Ein Lauf ueber alle Schritte in
 *    einer Transaktion haette keine Schrittmarken noetig, wuerde aber bei
 *    300 Zimmern minutenlang Zeilen sperren.
 * 3. **Jeder Schritt hinterlaesst eine Marke** je (Property, Geschaeftstag,
 *    Schritt). Ein Wiederholungslauf ueberspringt markierte Schritte und
 *    liefert dasselbe Ergebnis. Die Marke wird in derselben Transaktion
 *    geschrieben wie die Wirkung des Schritts, nie danach.
 */
export async function runNightAudit(
  pool: Pool, ctx: DbContext, propertyId: number, opts: NightAuditOptions = {}
): Promise<NightAuditResult | null> {
  const businessDate = await withTransaction(pool, ctx, c =>
    resolveBusinessDate(c, propertyId, opts))
  if (businessDate === null) return null

  const steps: Record<string, number> = {}
  const skipped: string[] = []

  for (const step of STEPS) {
    await withTransaction(pool, ctx, async client => {
      const mark = await client.query<{ count: number }>(
        `SELECT (detail->>'count')::int AS count FROM night_audit_step
          WHERE property_id = $1 AND business_date = $2::date AND step = $3`,
        [propertyId, businessDate, step])
      if (mark.rowCount !== 0) {
        skipped.push(step)
        steps[step] = mark.rows[0]!.count
        return
      }
      const count = await execute(step, client, propertyId, businessDate)
      await client.query(
        `INSERT INTO night_audit_step (property_id, business_date, step, detail)
         VALUES ($1, $2::date, $3, $4)`,
        [propertyId, businessDate, step, JSON.stringify({ count })])
      steps[step] = count
    })
  }

  const checklist = await withTransaction(pool, ctx, c => buildChecklist(c, propertyId))
  return { businessDate, steps, skipped, checklist }
}

/**
 * Welcher Tag ist dran?
 *
 * Der aelteste Geschaeftstag, dessen Schrittmarken unvollstaendig sind. Damit
 * nimmt ein Lauf nach einem Absturz genau dort wieder auf, statt den bereits
 * geschlossenen Tag zu ueberspringen und die Logis der Nacht zu verlieren.
 * Ist dieser Tag noch offen und das Geschaeftsdatum noch nicht weiter, ist
 * der Lauf nicht faellig: sonst wuerde ein Neustart des Workers den Tag
 * mitten am Nachmittag abschliessen.
 */
async function resolveBusinessDate(
  client: PoolClient, propertyId: number, opts: NightAuditOptions
): Promise<string | null> {
  if (opts.businessDate !== undefined) return opts.businessDate

  const r = await client.query<{ date: string; status: string
                                 timezone: string; rollover_time: string }>(
    `SELECT bd.date::text, bd.status, p.timezone, p.rollover_time::text
       FROM business_day bd
       JOIN property p ON p.id = bd.property_id
      WHERE bd.property_id = $1
        AND (SELECT count(*) FROM night_audit_step s
              WHERE s.property_id = bd.property_id AND s.business_date = bd.date) < $2
      ORDER BY bd.date
      LIMIT 1`,
    [propertyId, STEPS.length])
  if (r.rowCount === 0) return null

  const row = r.rows[0]!
  if (row.status === 'open') {
    const heute = businessDateFor(opts.now ?? new Date(), row.timezone, row.rollover_time)
    if (heute <= row.date) return null      // Tag laeuft noch.
  }
  return row.date
}

async function execute(
  step: Step, client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  switch (step) {
    case 'rollover':          return rollover(client, propertyId, businessDate)
    case 'post_accommodation': return postAccommodation(client, propertyId, businessDate)
    case 'post_city_tax':     return postCityTax(client, propertyId, businessDate)
    case 'no_shows':          return noShows(client, propertyId, businessDate)
    case 'expire_options':    return expireOptions(client, propertyId, businessDate)
    case 'release_blocks':    return releaseBlocks(client, propertyId, businessDate)
    case 'statistics':        return statistics(client, propertyId, businessDate)
  }
}

/** Schritt 1: Tageswechsel. Eine Zeilenaenderung, ab hier gilt das neue Datum. */
async function rollover(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  await client.query(
    `UPDATE business_day SET status = 'closed', closed_at = now()
      WHERE property_id = $1 AND date = $2::date AND status = 'open'`,
    [propertyId, businessDate])
  await client.query(
    `INSERT INTO business_day (property_id, date) VALUES ($1, $2::date)
     ON CONFLICT DO NOTHING`,
    [propertyId, addDays(businessDate, 1)])
  return 1
}

/**
 * Schritt 2: Logis der geschlossenen Nacht buchen, mit dem geschlossenen
 * Datum, nie mit "heute". Der Steuersatz kommt aus der Regel der Property;
 * fehlt sie, bleibt es beim ermaessigten Satz fuer Beherbergung.
 */
async function postAccommodation(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const r = await client.query(
    `WITH steuer AS (
       SELECT COALESCE((SELECT rate_bp FROM tax_rule
                         WHERE property_id = $1 AND kind = 'vat' AND basis = 'percent'
                           AND active ORDER BY id LIMIT 1), 700) AS rate_bp
     ), faellig AS (
       SELECT rn.reservation_id, rn.date, rn.price_cent, r.property_id, f.id AS folio_id
         FROM reservation_night rn
         JOIN reservation r ON r.id = rn.reservation_id
         JOIN folio f ON f.reservation_id = r.id AND f.status = 'open'
        WHERE r.property_id = $1 AND rn.date = $2::date
          AND r.status IN ('InHouse', 'CheckedOut') AND NOT rn.posted
        FOR UPDATE OF rn
     ), gebucht AS (
       INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id)
       SELECT f.property_id, f.folio_id, $2::date,
              'Uebernachtung ' || to_char($2::date, 'DD.MM.YYYY'), 1,
              f.price_cent - round(f.price_cent * s.rate_bp / (10000.0 + s.rate_bp)),
              round(f.price_cent * s.rate_bp / (10000.0 + s.rate_bp)),
              f.price_cent, s.rate_bp, '8300', f.reservation_id
         FROM faellig f CROSS JOIN steuer s
       RETURNING 1
     )
     UPDATE reservation_night rn SET posted = true
       FROM faellig f
      WHERE rn.reservation_id = f.reservation_id AND rn.date = f.date`,
    [propertyId, businessDate])
  return r.rowCount ?? 0
}

/**
 * Schritt 3: Kurtaxe und Bettensteuer der geschlossenen Nacht.
 *
 * Nach der Logis, weil eine prozentuale Bettensteuer auf dem Logiserlös
 * aufsetzt. Die Regeln je Gemeinde stehen in `tax_rule`, die Rechnung macht
 * die Datenbank in einer Anweisung: bei 250 belegten Zimmern wären 250
 * Runden im Nachtlauf eine schlechte Idee (Migration 0016).
 */
async function postCityTax(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const r = await client.query<{ post_city_tax: number }>(
    `SELECT post_city_tax($1, $2::date)`, [propertyId, businessDate])
  return r.rows[0]!.post_city_tax
}

/** Schritt 4: No-Shows. Das Kontingent wird frei, die Reservierung bleibt. */
async function noShows(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const offen = await client.query<{ id: number; category_id: number
                                     arrival: string; departure: string }>(
    `SELECT id, category_id, arrival::text, departure::text FROM reservation
      WHERE property_id = $1 AND arrival = $2::date AND status = 'Confirmed'
      ORDER BY id FOR UPDATE`,
    [propertyId, businessDate])
  for (const r of offen.rows) {
    await client.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
      [propertyId, r.category_id, r.arrival, r.departure])
    await client.query(
      `UPDATE reservation SET status = 'NoShow', updated_at = now() WHERE id = $1`, [r.id])
  }
  return offen.rowCount ?? 0
}

/**
 * Schritt 5: Abgelaufene Optionen verfallen.
 *
 * Die Frist wird gegen das **Ende des geschlossenen Geschaeftstags** geprueft,
 * nicht gegen now(). Zwei Gruende: ein Wiederholungslauf faende mit der Uhr
 * andere Zeilen als der erste und waere damit nicht wiederholbar, und eine
 * Option, die um 23:50 ablaeuft, darf nicht schon um 04:00 desselben Tages
 * verfallen. Die Grenze liegt in der Zeitzone der Property, nicht des Servers.
 */
async function expireOptions(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const abgelaufen = await client.query<{ id: number; category_id: number
                                          arrival: string; departure: string }>(
    `SELECT id, category_id, arrival::text, departure::text FROM reservation
      WHERE property_id = $1 AND status = 'Optional'
        AND option_expires_at < (($2::date + 1)::timestamp
              AT TIME ZONE (SELECT timezone FROM property WHERE id = $1))
      ORDER BY id FOR UPDATE`,
    [propertyId, businessDate])
  for (const r of abgelaufen.rows) {
    await client.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
      [propertyId, r.category_id, r.arrival, r.departure])
    await client.query(
      `UPDATE reservation SET status = 'Canceled', canceled_at = now() WHERE id = $1`, [r.id])
  }
  return abgelaufen.rowCount ?? 0
}

/** Schritt 6: Abgelaufene Kontingente freigeben, nur den nicht abgerufenen Rest. */
async function releaseBlocks(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const blocks = await client.query<{ id: number; category_id: number; from_date: string
                                      to_date: string; quantity: number; picked_up: number }>(
    `SELECT id, category_id, from_date::text, to_date::text, quantity, picked_up
       FROM availability_block
      WHERE property_id = $1 AND status = 'active' AND release_date <= $2::date
      ORDER BY id FOR UPDATE`,
    [propertyId, businessDate])
  for (const b of blocks.rows) {
    const rest = b.quantity - b.picked_up
    if (rest > 0) {
      await client.query(`SELECT inventory_unblock($1,$2,$3::date,$4::date,$5)`,
        [propertyId, b.category_id, b.from_date, b.to_date, rest])
    }
    await client.query(`UPDATE availability_block SET status = 'released' WHERE id = $1`, [b.id])
  }
  return blocks.rowCount ?? 0
}

/**
 * Schritt 7: Kennzahlen des geschlossenen Tages festhalten.
 *
 * Muss **nach** dem Buchen der Logis laufen, sonst fehlt der Erloes. Und es
 * muss ueberhaupt geschehen: `inventory_day.sold` ist ein laufender Zaehler,
 * der nach der Abreise zu Recht auf null faellt. Wer Kennzahlen der
 * Vergangenheit daraus liest, bekommt eine Auslastung nahe null
 * (Befund aus dem Saatlauf, Migration 0014).
 */
async function statistics(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  await client.query(`SELECT record_day_statistics($1, $2::date)`, [propertyId, businessDate])
  return 1
}

/**
 * Schritt 8: Pruefliste. Macht Auffaelligkeiten sichtbar und loest sie nicht.
 * Ein Nachtlauf, der selbsttaetig Salden korrigiert, ist ein Nachtlauf, dem
 * am Morgen niemand mehr glaubt.
 */
async function buildChecklist(
  client: PoolClient, propertyId: number
): Promise<NightAuditResult['checklist']> {
  const checklist: NightAuditResult['checklist'] = []

  const hoch = await client.query<{ public_ref: string; saldo: string }>(
    `SELECT f.public_ref,
            (COALESCE(sum(c.gross_cent), 0) - COALESCE((
               SELECT sum(s.amount_cent) FROM settlement s WHERE s.folio_id = f.id), 0))::text
            AS saldo
       FROM folio f LEFT JOIN charge c ON c.folio_id = f.id
      WHERE f.property_id = $1 AND f.status = 'open'
      GROUP BY f.id, f.public_ref
     HAVING (COALESCE(sum(c.gross_cent), 0) - COALESCE((
               SELECT sum(s.amount_cent) FROM settlement s WHERE s.folio_id = f.id), 0)) > 50000
      ORDER BY f.public_ref`,
    [propertyId])
  for (const h of hoch.rows) {
    checklist.push({ kind: 'hoher_saldo', detail: `Folio ${h.public_ref}: ${h.saldo} Cent` })
  }

  const ohneStatus = await client.query<{ code: string }>(
    `SELECT r.code FROM reservation res
       JOIN resource r ON r.id = res.resource_id
       LEFT JOIN housekeeping_status h ON h.resource_id = r.id
      WHERE res.property_id = $1 AND res.status = 'InHouse' AND h.resource_id IS NULL
      ORDER BY r.code`,
    [propertyId])
  for (const o of ohneStatus.rows) {
    checklist.push({ kind: 'kein_housekeeping_status', detail: `Zimmer ${o.code}` })
  }

  return checklist
}
