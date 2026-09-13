import pg from 'pg'
import { dbUrl } from '../config.js'

/**
 * Erzeugt einen Bestand in der Groessenordnung, in der Fehler sichtbar
 * werden: vier Haeuser zu je 250 Zimmern in 15 Kategorien, drei Jahre
 * Horizont, zusammen rund 180 000 Reservierungen.
 *
 * Der Zweck ist nicht, die Oberflaeche zu fuellen, sondern die Annahmen des
 * Entwurfs zu pruefen. Ein Belegungsplan, der mit zwanzig Reservierungen in
 * zwei Millisekunden antwortet, sagt nichts; erst bei sechsstelligen Zahlen
 * zeigt sich, ob ein Index greift oder ob irgendwo ein Scan ueber die ganze
 * Tabelle steht (P-Gesetz, Dokument 04).
 *
 * **Warum vier Haeuser und nicht eines.** Der urspruengliche Plan sah
 * 200 000 Reservierungen fuer ein Haus mit 250 Zimmern ueber drei Jahre vor.
 * Diese Zahl gibt es nicht: 250 Zimmer mal 1095 Tage sind 273 750
 * Zimmernaechte, 200 000 Reservierungen zu im Mittel vier Naechten waeren
 * 800 000. Der erste Lauf erzeugte entsprechend 5137 ueberbuchte
 * Kategorietage mit bis zu 183 verkauften Einheiten bei 17 Zimmern. Ein
 * Bestand, den es so nicht geben kann, taugt nicht zum Messen: er faellt in
 * andere Ausfuehrungsplaene als der echte. Also dieselbe Zeilenzahl,
 * verteilt auf eine kleine Kette. Das prueft nebenbei die Mandantentrennung
 * unter Last, was mehr wert ist als ein unmoegliches Einzelhaus.
 *
 * **Warum je Zimmer statt je Reservierung.** Reservierungen unabhaengig
 * voneinander zu wuerfeln erzeugt immer Ueberbuchung an den Spitzen. Hier
 * belegt jedes Zimmer seine eigene Zeitachse: Aufenthalt, Luecke,
 * Aufenthalt. Damit kann sich nichts ueberschneiden, und die Auslastung
 * ergibt sich aus dem Verhaeltnis von Aufenthalt zu Luecke.
 *
 * Alles wird **mengenbasiert** erzeugt. Die erste Fassung holte den Gast je
 * Reservierung mit `SELECT ... OFFSET (i % 60000) LIMIT 1`; bei 200 000
 * Zeilen war das ein Scan ueber Milliarden Zeilen und lief nicht zu Ende.
 * Genau die Falle, die im Betrieb eine Liste zum Stillstand bringt, nur
 * hier gut sichtbar.
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error('seed ist in Produktion nicht erlaubt.')
}

const HAEUSER = Number(process.env.SEED_PROPERTIES ?? 4)
const ZIMMER = Number(process.env.SEED_ROOMS ?? 250)
const KATEGORIEN = Number(process.env.SEED_CATEGORIES ?? 15)
const GAESTE = Number(process.env.SEED_GUESTS ?? 60_000)
const JAHRE = 3

const client = new pg.Client({ connectionString: dbUrl('owner') })
await client.connect()

const t0 = Date.now()
const zeiten: Array<{ schritt: string; ms: number; zeilen: number }> = []

const schritt = async (name: string, sql: string, params: unknown[] = []): Promise<number> => {
  const t = Date.now()
  const r = await client.query(sql, params)
  const ms = Date.now() - t
  const zeilen = r.rowCount ?? 0
  const vorhanden = zeiten.find(z => z.schritt === name)
  if (vorhanden) { vorhanden.ms += ms; vorhanden.zeilen += zeilen }
  else zeiten.push({ schritt: name, ms, zeilen })
  return zeilen
}

// Der Horizont liegt um den heutigen Tag: ein Jahr Vergangenheit fuer
// Kennzahlen, zwei Jahre Zukunft fuer die Belegungsplanung.
const VON = `(current_date - interval '1 year')::date`
const BIS = `(current_date + interval '2 years')::date`
const TAGE = JAHRE * 365

await client.query('BEGIN')

const account = await client.query<{ id: number }>(
  `INSERT INTO account (name) VALUES ('Wattenblick Hotels') RETURNING id`)
const accountId = account.rows[0]!.id

await schritt('Gaeste',
  `INSERT INTO guest (account_id, last_name, first_name, email, city, postal_code, country)
   SELECT $1,
          (ARRAY['Petersen','Jansen','Hansen','Nissen','Carstens','Boysen','Thomsen',
                 'Lorenzen','Matthiesen','Clausen','Schmidt','Mueller','Wagner',
                 'Feddersen','Iversen'])[1 + (i % 15)],
          (ARRAY['Anke','Jan','Lena','Ole','Maren','Sven','Birte','Kai','Silke',
                 'Torben'])[1 + (i % 10)],
          'gast' || i || '@example.invalid',
          (ARRAY['Husum','Flensburg','Kiel','Hamburg','Bremen','Amsterdam',
                 'Kopenhagen'])[1 + (i % 7)],
          lpad((20000 + i % 60000)::text, 5, '0'),
          (ARRAY['DE','DE','DE','DE','DE','NL','DK'])[1 + (i % 7)]
     FROM generate_series(1, $2) i`, [accountId, GAESTE])

const properties: number[] = []
const ORTE = ['Husum', 'St. Peter-Ording', 'Buesum', 'Friedrichstadt',
              'Toenning', 'Niebuell']

for (let h = 1; h <= HAEUSER; h++) {
  const p = await client.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, city, postal_code, country)
     VALUES ($1, $2, $3, $4, $5, 'DE') RETURNING id`,
    [accountId, `H${h}`, `Seehotel ${ORTE[(h - 1) % ORTE.length]}`,
     ORTE[(h - 1) % ORTE.length], String(25800 + h)])
  const propertyId = p.rows[0]!.id
  properties.push(propertyId)

  await schritt('Kategorien',
    `INSERT INTO resource_category (property_id, code, name, max_occupancy, sort_order)
     SELECT $1, 'K' || lpad(i::text, 2, '0'), 'Kategorie ' || i, 1 + (i % 4), i
       FROM generate_series(1, $2) i`, [propertyId, KATEGORIEN])

  await schritt('Zimmer',
    `INSERT INTO resource (property_id, category_id, code, floor)
     SELECT $1, c.id, lpad((100 + n)::text, 4, '0'), ((n / 30) + 1)::text
       FROM generate_series(0, $2 - 1) n
       JOIN LATERAL (
         SELECT id FROM resource_category WHERE property_id = $1
          ORDER BY sort_order OFFSET (n % $3) LIMIT 1
       ) c ON true`, [propertyId, ZIMMER, KATEGORIEN])

  await schritt('Stammdaten',
    `INSERT INTO tax_rule (property_id, code, name, kind, rate_bp, basis)
     VALUES ($1,'UST7','Beherbergung','vat',700,'percent'),
            ($1,'UST19','Sonstige Leistungen','vat',1900,'percent')`, [propertyId])
  await schritt('Stammdaten',
    `INSERT INTO payment_method (property_id, code, name, sort_order)
     VALUES ($1,'CASH','Barzahlung vor Ort',1),
            ($1,'CARD','Kartenzahlung vor Ort',2),
            ($1,'TRANSFER','Ueberweisung',3),
            ($1,'OTA','Abrechnung ueber Portal',4)`, [propertyId])
  await schritt('Stammdaten',
    `INSERT INTO rate_plan (property_id, category_id, code, name)
     SELECT $1, id, code || '-BAR', name || ' Basisrate'
       FROM resource_category WHERE property_id = $1`, [propertyId])
  await schritt('Stammdaten',
    `INSERT INTO business_day (property_id, date) VALUES ($1, current_date)`, [propertyId])

  await schritt('Preise',
    `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
     SELECT $1, rp.id, d::date,
            ARRAY[
              (7000 + (rp.id % 7) * 1500
                + CASE WHEN EXTRACT(isodow FROM d) IN (5,6) THEN 2500 ELSE 0 END
                + CASE WHEN EXTRACT(month FROM d) IN (6,7,8) THEN 3000 ELSE 0 END)::bigint,
              (9000 + (rp.id % 7) * 1500
                + CASE WHEN EXTRACT(isodow FROM d) IN (5,6) THEN 2500 ELSE 0 END
                + CASE WHEN EXTRACT(month FROM d) IN (6,7,8) THEN 3000 ELSE 0 END)::bigint
            ]
       FROM rate_plan rp
       CROSS JOIN generate_series(${VON}, ${BIS}, interval '1 day') d
      WHERE rp.property_id = $1`, [propertyId])

  const mat = await client.query<{ inventory_materialize: number }>(
    `SELECT inventory_materialize($1, ${VON}, ${BIS})`, [propertyId])
  zeiten.push({ schritt: `Inventar H${h}`, ms: 0,
                zeilen: mat.rows[0]!.inventory_materialize })

  /*
   * Aufenthalte je Zimmer auf einer eigenen Zeitachse. Zykluslaenge aus
   * Aufenthalt plus Luecke, beides aus der Zimmernummer abgeleitet und
   * damit reproduzierbar. Der Versatz `rn % zyklus` verhindert, dass alle
   * Zimmer am selben Tag wechseln.
   */
  await client.query(
    `CREATE TEMP TABLE plan_${propertyId} ON COMMIT DROP AS
     WITH zimmer AS (
       SELECT r.id AS resource_id, r.category_id,
              row_number() OVER (ORDER BY r.id) AS rn
         FROM resource r WHERE r.property_id = $1
     ), takt AS (
       SELECT z.*,
              (1 + (z.rn * 7919) % 7)::int  AS naechte,
              (1 + (z.rn * 104729) % 3)::int AS luecke
         FROM zimmer z
     )
     SELECT t.resource_id, t.category_id, t.rn,
            (${VON}) + (k * (t.naechte + t.luecke) + (t.rn % (t.naechte + t.luecke)))::int
              AS arrival,
            t.naechte,
            row_number() OVER (ORDER BY t.rn, k) AS n
       FROM takt t
       CROSS JOIN LATERAL generate_series(0, $2 / (t.naechte + t.luecke)) k
      WHERE (${VON}) + (k * (t.naechte + t.luecke)
                        + (t.rn % (t.naechte + t.luecke)))::int + t.naechte
            < (${BIS})`,
    [propertyId, TAGE])

  await schritt('Buchungen',
    `INSERT INTO booking (property_id, source, external_reference, channel_code,
                          market_segment, commission_bp)
     SELECT $1,
            (ARRAY['direct','booking_engine','channel','channel','walk_in'])[1 + (n % 5)],
            'SEED-' || $2 || '-' || n,
            CASE WHEN n % 5 = 2 THEN (ARRAY['BOOKING','EXPEDIA','HRS'])[1 + (n % 3)] END,
            (ARRAY['leisure','corporate','group'])[1 + (n % 3)],
            CASE WHEN n % 5 = 2 THEN 1500 END
       FROM plan_${propertyId}`,
    // Die Property-ID zweimal: einmal als Zahl fuer die Spalte, einmal als
    // Text fuer die Referenz. PostgreSQL leitet den Typ eines Parameters aus
    // seiner Verwendung ab und verweigert zwei verschiedene fuer denselben.
    [propertyId, String(propertyId)])

  await schritt('Reservierungen',
    `WITH plan AS (
       SELECT p.*, b.id AS booking_id
         FROM plan_${propertyId} p
         JOIN booking b ON b.property_id = $1
                       AND b.external_reference = 'SEED-' || $4 || '-' || p.n
     ), rp AS (
       SELECT DISTINCT ON (category_id) category_id, id
         FROM rate_plan WHERE property_id = $1 ORDER BY category_id, id
     ), g AS (
       SELECT id, row_number() OVER (ORDER BY id) - 1 AS gn
         FROM guest WHERE account_id = $2
     )
     INSERT INTO reservation (property_id, booking_id, category_id, resource_id,
                              arrival, departure, status, option_expires_at,
                              rate_plan_id, primary_guest_id, checked_in_at, checked_out_at)
     SELECT $1, plan.booking_id, plan.category_id,
            -- Vergangene und laufende Aufenthalte haben ihr Zimmer, kuenftige
            -- bekommen es erst bei der Anreise. So arbeitet die Rezeption.
            CASE WHEN plan.arrival <= current_date THEN plan.resource_id END,
            plan.arrival, plan.arrival + plan.naechte,
            CASE WHEN plan.arrival + plan.naechte <= current_date THEN 'CheckedOut'
                 WHEN plan.arrival <= current_date THEN 'InHouse'
                 WHEN plan.n % 37 = 0 THEN 'Optional'
                 ELSE 'Confirmed' END::reservation_status,
            -- Eine Option ohne Frist ist keine Option.
            CASE WHEN plan.n % 37 = 0 AND plan.arrival > current_date
                 THEN (plan.arrival - 7)::timestamptz END,
            rp.id, g.id,
            CASE WHEN plan.arrival <= current_date
                 THEN plan.arrival::timestamptz + interval '15 hours' END,
            CASE WHEN plan.arrival + plan.naechte <= current_date
                 THEN (plan.arrival + plan.naechte)::timestamptz + interval '11 hours' END
       FROM plan
       JOIN rp ON rp.category_id = plan.category_id
       JOIN g  ON g.gn = plan.n % $3`,
    [propertyId, accountId, GAESTE, String(propertyId)])

  await schritt('Naechte',
    `INSERT INTO reservation_night (reservation_id, property_id, date, rate_plan_id, price_cent)
     SELECT r.id, r.property_id, d::date, r.rate_plan_id,
            COALESCE(rd.price_cent[2], 9900)
       FROM reservation r
       CROSS JOIN LATERAL generate_series(r.arrival, r.departure - 1, interval '1 day') d
       LEFT JOIN rate_day rd ON rd.rate_plan_id = r.rate_plan_id AND rd.date = d::date
      WHERE r.property_id = $1`, [propertyId])

  /*
   * Der Bestandszaehler wird **einmal** aus den Reservierungen gerechnet,
   * nicht ueber inventory_reserve je Zeile. Im Betrieb ist es genau
   * umgekehrt richtig: dort bindet jede Buchung ihr Kontingent einzeln und
   * geprueft. Hier ist der Bestand bereits ueberschneidungsfrei erzeugt, und
   * der Abgleich des Workers rechnet dasselbe nach.
   */
  await schritt('Bestandszaehler',
    `UPDATE inventory_day i SET sold = COALESCE(z.n, 0)
       FROM (
         SELECT r.category_id, d.day::date AS date, count(*)::int AS n
           FROM reservation r
           CROSS JOIN LATERAL generate_series(r.arrival, r.departure - 1,
                                              interval '1 day') d(day)
          WHERE r.property_id = $1 AND r.status IN ('Optional','Confirmed','InHouse')
          GROUP BY r.category_id, d.day
       ) z
      WHERE i.property_id = $1 AND i.category_id = z.category_id AND i.date = z.date`,
    [propertyId])

  await schritt('Bestandszaehler',
    `UPDATE inventory_day i SET sold = COALESCE(z.n, 0)
       FROM (
         SELECT date, sum(sold)::int AS n FROM inventory_day
          WHERE property_id = $1 AND category_id <> 0 GROUP BY date
       ) z
      WHERE i.property_id = $1 AND i.category_id = 0 AND i.date = z.date`, [propertyId])

  await schritt('Folios',
    `INSERT INTO folio (property_id, reservation_id, guest_id, kind, status, closed_at)
     SELECT r.property_id, r.id, r.primary_guest_id, 'guest',
            CASE WHEN r.status = 'CheckedOut' THEN 'closed' ELSE 'open' END,
            r.checked_out_at
       FROM reservation r WHERE r.property_id = $1`, [propertyId])

  // Logis nur fuer vergangene Naechte: den Rest bucht der Nachtlauf.
  await schritt('Logisbuchungen',
    `WITH gebucht AS (
       INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account,
                           reservation_id)
       SELECT $1, f.id, n.date,
              'Uebernachtung ' || to_char(n.date, 'DD.MM.YYYY'), 1,
              n.price_cent - round(n.price_cent * 700.0 / 10700.0),
              round(n.price_cent * 700.0 / 10700.0),
              n.price_cent, 700, '8300', n.reservation_id
         FROM reservation_night n
         JOIN reservation r ON r.id = n.reservation_id
         JOIN folio f ON f.reservation_id = r.id
        WHERE r.property_id = $1 AND n.date < current_date
       RETURNING 1
     )
     UPDATE reservation_night n SET posted = true
       FROM reservation r
      WHERE r.id = n.reservation_id AND r.property_id = $1 AND n.date < current_date`,
    [propertyId])

  // Kennzahlen der Vergangenheit nachtragen. Im Betrieb tut das der
  // Nachtlauf je Tag; bei uebernommenem Bestand muss es einmal nachgeholt
  // werden, sonst meldet jede Jahresauswertung eine Auslastung nahe null.
  await schritt('Kennzahlen',
    `SELECT record_day_statistics_range($1, ${VON}, (current_date - 1)::date)`,
    [propertyId])

  console.log(`Haus ${h} von ${HAEUSER} (Property ${propertyId}) fertig, `
    + `${Math.round((Date.now() - t0) / 1000)} s`)
}

await client.query('COMMIT')
console.log('\nStatistiken aktualisieren...')
await client.query('ANALYZE')

console.log('\nSchritte:')
for (const z of zeiten) {
  console.log(`  ${z.schritt.padEnd(22)} ${String(z.zeilen).padStart(9)} Zeilen  `
    + `${String(z.ms).padStart(7)} ms`)
}

const zahlen = await client.query<{ was: string; n: string }>(
  `SELECT 'Properties' AS was, count(*)::text AS n FROM property
   UNION ALL SELECT 'Zimmer', count(*)::text FROM resource
   UNION ALL SELECT 'Gaeste', count(*)::text FROM guest
   UNION ALL SELECT 'Reservierungen', count(*)::text FROM reservation
   UNION ALL SELECT 'Naechte', count(*)::text FROM reservation_night
   UNION ALL SELECT 'Charges', count(*)::text FROM charge
   UNION ALL SELECT 'inventory_day', count(*)::text FROM inventory_day
   UNION ALL SELECT 'audit_log', count(*)::text FROM audit_log`)
console.log('\nBestand:')
for (const z of zahlen.rows) console.log(`  ${z.was.padEnd(22)} ${z.n.padStart(9)}`)

// Die eine Zahl, die stimmen muss.
const ueberbucht = await client.query<{ n: string; sold: number; cap: number }>(
  `SELECT count(*)::text AS n, COALESCE(max(sold),0) AS sold, COALESCE(max(capacity),0) AS cap
     FROM inventory_day WHERE sold + blocked > capacity + overbooking`)
console.log(`\n  Ueberbuchte Kategorietage: ${ueberbucht.rows[0]!.n}`
  + '  (muss 0 sein, sonst ist der Bestand nicht messtauglich)')

// Vergangenheit aus der Aufzeichnung, Zukunft aus dem Zaehler: zwei
// verschiedene Fragen, zwei verschiedene Quellen (Migration 0014).
const auslastung = await client.query<{ frueher: string; kuenftig: string }>(
  `SELECT (SELECT round(100.0 * sum(sold) / NULLIF(sum(capacity - blocked), 0), 1)::text
             FROM business_day_stat) AS frueher,
          (SELECT round(100.0 * sum(sold) / NULLIF(sum(capacity - blocked), 0), 1)::text
             FROM inventory_day
            WHERE category_id = 0 AND date >= current_date
              AND date < current_date + 365) AS kuenftig`)
console.log(`  Auslastung Vergangenheit (aufgezeichnet): ${auslastung.rows[0]!.frueher} %`)
console.log(`  Auslastung kommendes Jahr (auf den Buechern): ${auslastung.rows[0]!.kuenftig} %`)

console.log('\nMessungen (nach ANALYZE, warmer Cache):')
const messen = async (name: string, sql: string, params: unknown[]): Promise<void> => {
  await client.query(sql, params)                     // aufwaermen
  const t = Date.now()
  const r = await client.query(sql, params)
  console.log(`  ${name.padEnd(46)} ${String(Date.now() - t).padStart(5)} ms  `
    + `${r.rowCount} Zeilen`)
}
const p1 = properties[0]!
await messen('Jahresverfuegbarkeit, eine Abfrage',
  `SELECT date, capacity - sold - blocked + overbooking AS available
     FROM inventory_day WHERE property_id = $1 AND category_id = 0
      AND date >= current_date AND date < current_date + 365`, [p1])
await messen('Verfuegbarkeit alle Kategorien, 365 Tage',
  `SELECT category_id, date, capacity - sold - blocked + overbooking AS available
     FROM inventory_day WHERE property_id = $1
      AND date >= current_date AND date < current_date + 365`, [p1])
await messen('Belegungsplan 30 Tage, alle Zimmer',
  `SELECT r.id, r.code, res.id, res.arrival, res.departure, res.status
     FROM resource r
     LEFT JOIN reservation res ON res.resource_id = r.id
           AND res.status IN ('Confirmed','InHouse')
           AND res.arrival < current_date + 30 AND res.departure > current_date
    WHERE r.property_id = $1 AND r.active ORDER BY r.code`, [p1])
await messen('Gastsuche ueber Namensteil',
  `SELECT id, last_name, first_name FROM guest
    WHERE account_id = $1 AND last_name % 'Matthies'
    ORDER BY similarity(last_name, 'Matthies') DESC LIMIT 20`, [accountId])
await messen('Anreiseliste eines Tages',
  `SELECT r.public_ref, g.last_name FROM reservation r
     LEFT JOIN guest g ON g.id = r.primary_guest_id
    WHERE r.property_id = $1 AND r.arrival = current_date
      AND r.status IN ('Confirmed','InHouse')`, [p1])
await messen('Kennzahlen ueber ein Jahr (aufgezeichnet)',
  `SELECT date, capacity, blocked, sold, room_revenue_cent
     FROM business_day_stat
    WHERE property_id = $1 AND date >= current_date - 365 AND date < current_date`, [p1])
await messen('Dieselben Kennzahlen roh aggregiert (Vergleich)',
  `SELECT rn.date, count(*) AS sold,
          COALESCE(sum(c.net_cent), 0) AS rev
     FROM reservation_night rn
     JOIN reservation r ON r.id = rn.reservation_id
     LEFT JOIN charge c ON c.reservation_id = r.id AND c.business_date = rn.date
                       AND c.revenue_account = '8300'
    WHERE rn.property_id = $1
      AND rn.date >= current_date - 365 AND rn.date < current_date
    GROUP BY rn.date`, [p1])

console.log(`\nFertig in ${Math.round((Date.now() - t0) / 1000)} s.`)
console.log(`\n  export SEED_PROPERTY_IDS=${properties.join(',')}`)
await client.end()
