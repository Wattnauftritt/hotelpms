import { withTransaction, type DbContext, type Pool, type PoolClient } from '@hotelpms/db'
import { addDays, businessDateFor, BREAKFAST_DRINKS_ACCOUNT, BREAKFAST_DRINKS_RATE_BP,
         BREAKFAST_DRINKS_SHARE_BP, BREAKFAST_FOOD_ACCOUNT,
         BREAKFAST_FOOD_RATE_BP } from '@hotelpms/domain'

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
 * Wie weit zurueck nach einem unvollstaendigen Tag gesucht wird (Befund 14).
 *
 * Die Suche zaehlte je Geschaeftstag seit Inbetriebnahme die Schrittmarken
 * -- bei jedem Tick, und jeden Tag ein Tag mehr. Unvollstaendig kann aber
 * nur der offene Tag sein und der davor: der Tageswechsel ist Schritt 1,
 * schliesst den Tag und oeffnet den naechsten, und ein Lauf nach einem
 * Absturz macht erst den alten Tag fertig, bevor er den neuen anfasst.
 * Gezaehlt wird vom juengsten Geschaeftstag, nicht vom offenen: fehlt der
 * offene Tag, soll die Suche trotzdem etwas finden. Eine Woche ist
 * reichlich Abstand fuer beides.
 */
const SUCHFENSTER_TAGE = 7

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
        AND bd.date >= (SELECT max(m.date) FROM business_day m
                         WHERE m.property_id = $1) - $3::int
        AND (SELECT count(*) FROM night_audit_step s
              WHERE s.property_id = bd.property_id AND s.business_date = bd.date) < $2
      ORDER BY bd.date
      LIMIT 1`,
    [propertyId, STEPS.length, SUCHFENSTER_TAGE])
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
 *
 * Enthaelt die Rate Fruehstueck (`rate_plan.breakfast_cent`, Migration
 * 0158), wird es aus dem Nachtpreis herausgerechnet und als Speisen und
 * Getraenke gebucht, je zu ihrem Satz. Die Rechnung dazu steht in
 * `breakfastPerNight` und `splitNight` (domain); hier dieselbe in SQL, damit der Nachtlauf bei 250
 * Zimmern eine Anweisung bleibt. Anteil und Saetze kommen als Parameter aus
 * der Domain, damit es sie nur einmal gibt.
 *
 * Weitere Inklusivleistungen der Rate (`rate_plan_product`, Migration 0165)
 * gehen genauso heraus, jede zu ihrem Satz und auf ihr Konto: je Nacht, je
 * Person und Nacht oder einmal in der Anreisenacht -- dieselbe Rechnung wie
 * die Anzahlung (`erwarteteSaetze`), damit Anzahlungs- und Schlussrechnung
 * dieselben Saetze ausweisen. Fruehstueck und Leistungen zusammen nie mehr
 * als die Nacht; reicht der Preis nicht, bekommen die ersten Leistungen
 * (nach Anlage) ihren Wert und die letzten den Rest. Eine Aufteilung
 * innerhalb eines Produkts (`split_share_bp`) bietet keine Maske an; der
 * Nachtlauf bucht ein Produkt deshalb ganz zu seinem Satz.
 */
async function postAccommodation(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const r = await client.query(
    `WITH steuer AS (
       -- Beherbergung traegt den ermaessigten Satz (§ 12 Abs. 2 Nr. 11
       -- UStG). Bisher galt die erste Regel nach ID; legte ein Haus 19 %
       -- zuerst an, buchte jede Nacht zu 19 % (Pruefung 13.10.2026).
       SELECT COALESCE((SELECT rate_bp FROM tax_rule
                         WHERE property_id = $1 AND kind = 'vat' AND basis = 'percent'
                           AND active ORDER BY rate_bp = 700 DESC, id LIMIT 1), 700) AS rate_bp
     ), faellig AS (
       SELECT rn.reservation_id, rn.date, rn.price_cent, r.property_id,
              -- Umleitung beachten: sagt eine Regel, dass Logis auf ein
              -- anderes Folio geht, etwa das der Firma, dann dorthin. Ohne
              -- das landet die Firmenrechnung beim Gast, und der Check-out
              -- am Morgen wird zur Diskussion.
              COALESCE(rr.target_folio_id, f.id) AS folio_id,
              -- Fruehstueck wie breakfastPerNight (domain), nie mehr als
              -- die Nacht. Ein Kinderpreis greift nur, wenn die Buchung
              -- Erwachsene getrennt nennt; sonst zahlen alle wie
              -- Erwachsene, Personen aus der angegebenen Zahl, sonst aus
              -- den erfassten Gaesten, mindestens eine.
              LEAST(CASE
                      WHEN rp.breakfast_cent IS NULL THEN 0
                      WHEN rp.breakfast_child_cent IS NOT NULL AND r.adults IS NOT NULL
                        THEN r.adults::bigint * rp.breakfast_cent
                             + COALESCE(r.children, 0)::bigint * rp.breakfast_child_cent
                      ELSE rp.breakfast_cent::bigint
                           * GREATEST(COALESCE(r.guest_count,
                                               (SELECT count(*) FROM reservation_occupant o
                                                 WHERE o.reservation_id = r.id)::int), 1)
                    END,
                    GREATEST(rn.price_cent, 0)) AS fruehstueck,
              COALESCE(rn.rate_plan_id, r.rate_plan_id) AS plan_id,
              r.arrival,
              GREATEST(COALESCE(r.guest_count,
                                (SELECT count(*) FROM reservation_occupant o
                                  WHERE o.reservation_id = r.id)::int), 1) AS personen
         FROM reservation_night rn
         JOIN reservation r ON r.id = rn.reservation_id
         -- Das Gastfolio; ein weiteres Folio (Split) buchte jede Nacht sonst
         -- ein zweites Mal. Dorthin fuehrt nur die Umleitung.
         JOIN folio f ON f.reservation_id = r.id AND f.status = 'open' AND f.kind = 'guest'
         LEFT JOIN rate_plan rp ON rp.id = COALESCE(rn.rate_plan_id, r.rate_plan_id)
         LEFT JOIN LATERAL (
           SELECT target_folio_id FROM routing_rule x
            WHERE x.reservation_id = r.id
              AND x.match_kind IN ('all', 'accommodation')
            -- Die genauere Regel gewinnt: 'accommodation' vor 'all'.
            ORDER BY CASE x.match_kind WHEN 'accommodation' THEN 0 ELSE 1 END, x.id
            LIMIT 1
         ) rr ON true
        WHERE r.property_id = $1 AND rn.date = $2::date
          AND r.status IN ('InHouse', 'CheckedOut') AND NOT rn.posted
        FOR UPDATE OF rn
     ), teile AS (
       -- Getraenke einmal gerundet, Speisen der Rest: die drei Teile ergeben
       -- immer genau den Nachtpreis (wie splitNight).
       SELECT f.*, round(f.fruehstueck * $3::int / 10000.0)::bigint AS getraenke
         FROM faellig f
     ), inklusiv_roh AS (
       SELECT t.reservation_id, p.id AS product_id, p.name, p.revenue_account,
              tr.rate_bp,
              p.price_cent * CASE p.charge_mode WHEN 'per_person_night' THEN t.personen
                                                ELSE 1 END AS brutto
         FROM teile t
         JOIN rate_plan_product rpp ON rpp.rate_plan_id = t.plan_id
         JOIN product p ON p.id = rpp.product_id AND p.active AND p.property_id = $1
         LEFT JOIN tax_rule tr ON tr.id = p.tax_rule_id
        WHERE p.price_cent > 0 AND (p.charge_mode <> 'once' OR t.arrival = $2::date)
     ), inklusiv AS (
       -- Was Fruehstueck und die vorigen Leistungen von der Nacht uebrig
       -- lassen, nie weniger als null.
       SELECT i.*,
              GREATEST(LEAST(i.brutto,
                             GREATEST(t.price_cent, 0) - t.fruehstueck
                             - COALESCE(sum(i.brutto) OVER (
                                 PARTITION BY i.reservation_id ORDER BY i.product_id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)),
                       0)::bigint AS anteil
         FROM inklusiv_roh i JOIN teile t ON t.reservation_id = i.reservation_id
     ), inklusiv_summe AS (
       SELECT reservation_id, sum(anteil)::bigint AS summe FROM inklusiv GROUP BY reservation_id
     ), zeilen AS (
       SELECT t.property_id, t.folio_id, t.reservation_id,
              z.n, z.text, z.brutto, z.satz, z.konto, z.teil
         FROM teile t CROSS JOIN steuer s
         LEFT JOIN inklusiv_summe k ON k.reservation_id = t.reservation_id
         CROSS JOIN LATERAL (VALUES
           (1, 'Uebernachtung', t.price_cent - t.fruehstueck - COALESCE(k.summe, 0),
               s.rate_bp, '8300', NULL::text),
           (2, 'Fruehstueck Speisen', t.fruehstueck - t.getraenke, $4::int, $6::text,
               'breakfast_food'),
           (3, 'Fruehstueck Getraenke', t.getraenke, $5::int, $7::text, 'breakfast_drinks')
         ) z(n, text, brutto, satz, konto, teil)
        -- Die Logis auch bei null: eine Nacht, die gebucht wurde, steht im
        -- Folio, wie bisher. Fruehstuecksteile nur, wenn es sie gibt.
        WHERE z.n = 1 OR z.brutto > 0
       UNION ALL
       -- Ohne eigene Steuerregel traegt die Leistung den Satz der Logis,
       -- wie in der Anzahlung.
       SELECT t.property_id, t.folio_id, t.reservation_id,
              3 + row_number() OVER (PARTITION BY i.reservation_id ORDER BY i.product_id),
              i.name, i.anteil, COALESCE(i.rate_bp, s.rate_bp), i.revenue_account,
              'inclusion'
         FROM inklusiv i JOIN teile t ON t.reservation_id = i.reservation_id
        CROSS JOIN steuer s
        WHERE i.anteil > 0
     ), gebucht AS (
       INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id, package_part)
       SELECT z.property_id, z.folio_id, $2::date,
              z.text || ' ' || to_char($2::date, 'DD.MM.YYYY'), 1,
              z.brutto - round(z.brutto * z.satz / (10000.0 + z.satz)),
              round(z.brutto * z.satz / (10000.0 + z.satz)),
              z.brutto, z.satz, z.konto, z.reservation_id, z.teil
         FROM zeilen z
        ORDER BY z.reservation_id, z.n
       RETURNING 1
     )
     UPDATE reservation_night rn SET posted = true
       FROM faellig f
      WHERE rn.reservation_id = f.reservation_id AND rn.date = f.date`,
    [propertyId, businessDate, BREAKFAST_DRINKS_SHARE_BP, BREAKFAST_FOOD_RATE_BP,
     BREAKFAST_DRINKS_RATE_BP, BREAKFAST_FOOD_ACCOUNT, BREAKFAST_DRINKS_ACCOUNT])
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

/**
 * Schritt 4: No-Shows.
 *
 * Das Kontingent wird frei, die Reservierung bleibt bestehen: sie ist ein
 * Beleg dafuer, dass jemand gebucht und nicht abgesagt hat, und bei einer
 * garantierten Buchung ist sie die Grundlage der Gebuehr.
 *
 * **Garantiert und ungarantiert werden unterschieden** (B10, Dokument 13).
 * Eine garantierte Reservierung wird dem Gast in Rechnung gestellt, soweit
 * die Stornoregel das vorsieht; eine ungarantierte verfaellt folgenlos. Wer
 * beide gleich behandelt, stellt entweder zu Unrecht in Rechnung oder
 * verschenkt den Erloes einer verkauften Nacht.
 *
 * **Nur, wo das Haus es so will** (Migration 0088). Vorgabe ist das
 * Gegenteil: eine Anreise, die niemand storniert hat, gilt als angereist,
 * auch ohne Check-in. Wer nicht jeden Gast eincheckt -- oder noch im
 * Altsystem --, haette sonst jeden Morgen eine Liste falscher No-Shows.
 */
async function noShows(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const regel = await client.query<{ unchecked_arrival: string }>(
    `SELECT unchecked_arrival FROM property WHERE id = $1`, [propertyId])
  if (regel.rows[0]?.unchecked_arrival !== 'no_show') {
    return unattendedArrivals(client, propertyId, businessDate)
  }

  const offen = await client.query<{
    id: number; category_id: number; arrival: string; departure: string
    guaranteed: boolean; fee_kind: string | null; fee_value: number | null
    folio_id: number | null; erste_nacht: number | null; gesamt: number | null }>(
    `SELECT r.id, r.category_id, r.arrival::text, r.departure::text,
            -- Die Regel am Ratenplan hat Vorrang; ohne Regel gilt, was an
            -- der Reservierung steht.
            COALESCE(cp.guaranteed, r.guaranteed) AS guaranteed,
            cp.fee_kind, cp.fee_value,
            f.id AS folio_id,
            (SELECT price_cent FROM reservation_night n
              WHERE n.reservation_id = r.id ORDER BY n.date LIMIT 1) AS erste_nacht,
            (SELECT sum(price_cent) FROM reservation_night n
              WHERE n.reservation_id = r.id) AS gesamt
       FROM reservation r
       LEFT JOIN rate_plan rp ON rp.id = r.rate_plan_id
       LEFT JOIN cancellation_policy cp ON cp.id = rp.cancellation_policy_id
       LEFT JOIN folio f ON f.reservation_id = r.id AND f.status = 'open' AND f.kind = 'guest'
      WHERE r.property_id = $1 AND r.arrival = $2::date AND r.status = 'Confirmed'
      ORDER BY r.id FOR UPDATE OF r`,
    [propertyId, businessDate])
  if (offen.rowCount === 0) return 0

  // Mengenbasiert statt je Zeile (Performanceaudit): eine Freigabe, eine
  // Gebuehrenbuchung, ein Zustandswechsel -- unabhaengig davon, wie viele
  // No-Shows dieser Anreisetag hat.
  await client.query(
    `SELECT inventory_release_bulk($1,$2::bigint[],$3::date[],$4::date[],$5::int[])`,
    [propertyId, offen.rows.map(r => r.category_id), offen.rows.map(r => r.arrival),
     offen.rows.map(r => r.departure), offen.rows.map(() => 1)])

  const zeilen = offen.rows.map(r => ({
    id: r.id, folioId: r.folio_id, fee: r.guaranteed ? noShowFee(r) : 0 }))

  // Die Gebuehr ist keine Beherbergung: sie traegt den vollen Satz und ein
  // eigenes Erloeskonto, sonst faelscht sie ADR und RevPAR.
  const mitGebuehr = zeilen.filter(z => z.fee > 0 && z.folioId !== null)
  if (mitGebuehr.length > 0) {
    await client.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id)
       SELECT $1, x.folio_id, $2::date, 'No-Show-Gebuehr', 1,
              x.fee - round(x.fee * 1900.0 / 11900.0), round(x.fee * 1900.0 / 11900.0),
              x.fee, 1900, '8400', x.reservation_id
         FROM unnest($3::bigint[], $4::bigint[], $5::bigint[])
              AS x(folio_id, reservation_id, fee)`,
      [propertyId, businessDate, mitGebuehr.map(z => z.folioId),
       mitGebuehr.map(z => z.id), mitGebuehr.map(z => z.fee)])
  }

  await client.query(
    `UPDATE reservation r SET status = 'NoShow', updated_at = now(),
                              cancellation_fee_cent = x.fee
       FROM unnest($1::bigint[], $2::bigint[]) AS x(id, fee)
      WHERE r.id = x.id`,
    [zeilen.map(z => z.id), zeilen.map(z => z.fee > 0 ? z.fee : null)])

  return offen.rowCount ?? 0
}

/**
 * Was im Kalender steht, ist da: die nicht eingecheckten Anreisen des Tages
 * werden eingecheckt.
 *
 * Das Kontingent bleibt, wie es ist -- bestaetigt und im Haus binden beide.
 * Die Logis und die Kurtaxe dieser Nacht bucht der Schritt nach: Schritt 2
 * und 3 sind schon gelaufen, als die Reservierung noch bestaetigt war, und
 * haetten sie uebergangen. Beide Funktionen buchen nur, was noch fehlt, und
 * treffen die schon gebuchten Gaeste deshalb nicht ein zweites Mal.
 */
async function unattendedArrivals(
  client: PoolClient, propertyId: number, businessDate: string
): Promise<number> {
  const r = await client.query(
    `UPDATE reservation r
        SET status = 'InHouse', updated_at = now(),
            -- Den Tag kennt der Kalender, die Uhrzeit nicht.
            checked_in_at = r.arrival::timestamp AT TIME ZONE p.timezone
       FROM property p
      WHERE p.id = r.property_id
        AND r.property_id = $1 AND r.arrival = $2::date AND r.status = 'Confirmed'
        -- Im Haus heisst in einem Zimmer. Eine Anreise ohne Zimmer steht in
        -- keiner Zeile des Kalenders; sie bleibt bestaetigt, bindet weiter
        -- und zaehlt weiter mit, bis jemand ihr ein Zimmer gibt.
        AND r.resource_id IS NOT NULL`,
    [propertyId, businessDate])
  const n = r.rowCount ?? 0
  if (n > 0) {
    await postAccommodation(client, propertyId, businessDate)
    await postCityTax(client, propertyId, businessDate)
  }
  return n
}

/**
 * Gebuehr eines No-Shows nach der Stornoregel.
 *
 * Ohne hinterlegte Regel wird **nichts** berechnet. Eine stillschweigende
 * Annahme wie "erste Nacht" waere hier falsch: eine Gebuehr ohne vereinbarte
 * Grundlage ist nicht durchsetzbar, und sie dem Gast aufs Folio zu buchen
 * erzeugt einen Streit, den das Haus verliert.
 */
function noShowFee(r: {
  fee_kind: string | null; fee_value: number | null
  erste_nacht: number | null; gesamt: number | null
}): number {
  if (r.fee_kind === null) return 0
  switch (r.fee_kind) {
    case 'first_night': return r.erste_nacht ?? 0
    case 'percent':     return Math.round(((r.gesamt ?? 0) * (r.fee_value ?? 0)) / 100)
    case 'amount':      return r.fee_value ?? 0
    default:            return 0
  }
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
  if (abgelaufen.rowCount === 0) return 0

  // Mengenbasiert statt je Zeile (Performanceaudit).
  await client.query(
    `SELECT inventory_release_bulk($1,$2::bigint[],$3::date[],$4::date[],$5::int[])`,
    [propertyId, abgelaufen.rows.map(r => r.category_id),
     abgelaufen.rows.map(r => r.arrival), abgelaufen.rows.map(r => r.departure),
     abgelaufen.rows.map(() => 1)])
  await client.query(
    `UPDATE reservation SET status = 'Canceled', canceled_at = now()
      WHERE id = ANY($1::bigint[])`, [abgelaufen.rows.map(r => r.id)])
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
  if (blocks.rowCount === 0) return 0

  // Mengenbasiert statt je Zeile (Performanceaudit): nur die Bloecke mit
  // ungenutztem Rest wirken auf das Kontingent, alle wechseln den Zustand.
  const mitRest = blocks.rows
    .map(b => ({ ...b, rest: b.quantity - b.picked_up }))
    .filter(b => b.rest > 0)
  if (mitRest.length > 0) {
    await client.query(
      `SELECT inventory_unblock_bulk($1,$2::bigint[],$3::date[],$4::date[],$5::int[])`,
      [propertyId, mitRest.map(b => b.category_id), mitRest.map(b => b.from_date),
       mitRest.map(b => b.to_date), mitRest.map(b => b.rest)])
  }
  await client.query(
    `UPDATE availability_block SET status = 'released' WHERE id = ANY($1::bigint[])`,
    [blocks.rows.map(b => b.id)])
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
