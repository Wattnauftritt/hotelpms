import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { dbUrl } from '../config.js'

/**
 * Ein einzelnes, benutzbares Testhotel — zum Anfassen, nicht zum Messen.
 *
 * **Warum neben dem Saatlauf.** `db:seed` erzeugt vier Haeuser mit 180 000
 * Reservierungen, damit sich zeigt, ob ein Index greift. Zum *Ausprobieren*
 * taugt das nicht: niemand ueberblickt einen Belegungsplan mit 250 Zimmern,
 * und was dort auffaellt, ist Zufall. Hier steht ein Haus in der Groesse, in
 * der ein Mensch jede Zeile nachrechnen kann — 24 Zimmer, vier Kategorien,
 * ein halbes Jahr Horizont, rund vierzig Reservierungen um den heutigen Tag.
 *
 * **Warum ein Uebungshaus (`is_training = true`).** Das ist keine
 * Kleinigkeit, sondern der Punkt: ein Uebungshaus weist DATEV-, GoBD- und
 * Statistikexport hart ab und verschickt keine Gastpost. Ein Testhaus ohne
 * dieses Kennzeichen wuerde frueher oder spaeter eine Uebungsrechnung in die
 * echte Buchhaltung schieben oder einer erfundenen Adresse eine Mail
 * schicken — beides ist schwerer zu entfernen als zu verhindern (C11,
 * Dokument 13).
 *
 * **Warum nicht ueber die API.** Es gibt (noch) keinen Weg, einen Account
 * anzulegen; das ist die Onboarding-Luecke. Dieses Skript laeuft mit der
 * Eigentuemerrolle wie der Saatlauf und nimmt der Onboarding-Entscheidung
 * nichts vorweg.
 *
 * Aufruf:
 *   pnpm db:testhotel                        # legt an, Kennwort wird erzeugt
 *   TESTHOTEL_PASSWORD=… pnpm db:testhotel
 *   TESTHOTEL_CODE=TEST2 pnpm db:testhotel   # ein zweites daneben
 */

const CODE = process.env.TESTHOTEL_CODE ?? 'TEST'
const EMAIL = process.env.TESTHOTEL_EMAIL
  ?? `${(process.env.TESTHOTEL_CODE ?? 'test').toLowerCase()}@hotelpms.local`
const VON = "(current_date - 30)"
const BIS = "(current_date + 180)"

/** Vier Kategorien, wie sie ein Haus an der Nordseekueste wirklich hat. */
const KATEGORIEN = [
  { code: 'EZ',    name: 'Einzelzimmer',   belegung: 1, zimmer: 4,  ab: 100 },
  { code: 'DZ',    name: 'Doppelzimmer',   belegung: 2, zimmer: 12, ab: 200 },
  { code: 'FEWO',  name: 'Ferienwohnung',  belegung: 4, zimmer: 6,  ab: 300 },
  { code: 'SUITE', name: 'Suite',          belegung: 3, zimmer: 2,  ab: 400 }
]

/**
 * Legt das Testhotel an.
 *
 * Nach aussen gegeben, damit ein Test es aufrufen kann, ohne einen
 * Unterprozess zu starten. Der Aufruf am Dateiende laeuft nur, wenn diese
 * Datei das Startmodul ist -- sonst saete ein blosser Import ein Hotel in
 * die Testdatenbank.
 */
export async function testhotelAnlegen(): Promise<void> {
  const client = new pg.Client({ connectionString: dbUrl('owner') })
  await client.connect()

  try {
    await client.query('BEGIN')

    /*
     * Es gibt kein --force, das ein vorhandenes Testhotel wegraeumt, und das
     * ist Absicht. Ein Account haengt ueber Fremdschluessel an rund zwei
     * Dutzend Tabellen, von guest bis audit_log; eine Loeschkette in der
     * richtigen Reihenfolge waere beim ersten Lauf richtig und still falsch,
     * sobald jemand eine Tabelle hinzufuegt. Auffallen wuerde es Wochen
     * spaeter an einer Zeile, die nicht mehr wegging.
     *
     * Wer neu anfangen will, hat zwei saubere Wege, und beide stehen in der
     * Meldung.
     */
    const da = await client.query<{ id: number }>(
      `SELECT id FROM property WHERE code = $1`, [CODE])
    if (da.rows.length > 0) {
      console.error(
        `Es gibt schon ein Haus mit dem Kuerzel ${CODE}.\n\n`
        + `  Ganz neu aufsetzen:   pnpm db:reset && pnpm db:testhotel\n`
        + `  Ein zweites daneben:  TESTHOTEL_CODE=${CODE}2 pnpm db:testhotel\n`)
      process.exitCode = 1
      await client.query('ROLLBACK')
      return
    }

    const a = await client.query<{ id: number }>(
      `INSERT INTO account (name) VALUES ('Testbetrieb') RETURNING id`)
    const accountId = a.rows[0]!.id

    /*
     * Anschrift und Steuernummer gehoeren zur Grundausstattung, nicht zur
     * Kuer: ohne sie darf nach § 14 UStG keine Rechnung ausgestellt werden.
     * Ein Testhaus ohne sie verdeckt eine Luecke, die jedes echte Haus hat.
     */
    const p = await client.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code,
                             city, country, tax_number, is_training)
       VALUES ($1,$2,'Testhotel Wattenblick','Hafenstr. 1','25813','Husum','DE',
               '21/815/00123', true)
       RETURNING id`, [accountId, CODE])
    const propertyId = p.rows[0]!.id

    for (const k of KATEGORIEN) {
      const c = await client.query<{ id: number }>(
        `INSERT INTO resource_category (property_id, code, name, max_occupancy, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [propertyId, k.code, k.name, k.belegung, KATEGORIEN.indexOf(k) + 1])
      await client.query(
        `INSERT INTO resource (property_id, category_id, code, floor)
         SELECT $1, $2, ($3 + n)::text, (($3 + n) / 100)::text
           FROM generate_series(1, $4) n`,
        [propertyId, c.rows[0]!.id, k.ab, k.zimmer])
    }

    await client.query(
      `INSERT INTO tax_rule (property_id, code, name, kind, rate_bp, basis)
       VALUES ($1,'UST7','Beherbergung','vat',700,'percent'),
              ($1,'UST19','Sonstige Leistungen','vat',1900,'percent')`, [propertyId])
    await client.query(
      `INSERT INTO payment_method (property_id, code, name, sort_order)
       VALUES ($1,'CASH','Barzahlung vor Ort',1),
              ($1,'CARD','Kartenzahlung vor Ort',2),
              ($1,'TRANSFER','Ueberweisung',3)`, [propertyId])
    await client.query(
      `INSERT INTO rate_plan (property_id, category_id, code, name)
       SELECT $1, id, code || '-BAR', name || ' Basisrate'
         FROM resource_category WHERE property_id = $1`, [propertyId])
    await client.query(
      `INSERT INTO business_day (property_id, date) VALUES ($1, current_date)`, [propertyId])

    /*
     * Preise je Belegungsstufe als Vektor, nicht als eine Zahl: der Ratenplan
     * schreibt den ganzen Tag, und wer nur eine Stufe schickt, loescht die
     * anderen. Wochenende und Sommer teurer, damit im Preisraster etwas zu
     * sehen ist, an dem sich eine Massenaenderung nachrechnen laesst.
     */
    await client.query(
      `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
       SELECT $1, rp.id, d::date,
              ARRAY[
                (6900 + c.sort_order * 2000
                  + CASE WHEN EXTRACT(isodow FROM d) IN (5,6) THEN 2000 ELSE 0 END
                  + CASE WHEN EXTRACT(month FROM d) IN (6,7,8) THEN 2500 ELSE 0 END)::bigint,
                (8900 + c.sort_order * 2000
                  + CASE WHEN EXTRACT(isodow FROM d) IN (5,6) THEN 2000 ELSE 0 END
                  + CASE WHEN EXTRACT(month FROM d) IN (6,7,8) THEN 2500 ELSE 0 END)::bigint
              ]
         FROM rate_plan rp
         JOIN resource_category c ON c.id = rp.category_id
         CROSS JOIN generate_series(${VON}, ${BIS}, interval '1 day') d
        WHERE rp.property_id = $1`, [propertyId])

    const mat = await client.query<{ inventory_materialize: number }>(
      `SELECT inventory_materialize($1, ${VON}, ${BIS})`, [propertyId])

    // Ein paar Gaeste mit vollstaendiger Anschrift — ohne sie laesst sich
    // oberhalb der Kleinbetragsgrenze keine Rechnung stellen (§ 14 UStG).
    await client.query(
      `INSERT INTO guest (account_id, last_name, first_name, email, address_line1,
                          postal_code, city, country)
       SELECT $1,
              (ARRAY['Petersen','Hansen','Jansen','Bruns','Carstens','Thiessen',
                     'Nissen','Boysen','Clausen','Ketelsen'])[1 + (n % 10)],
              (ARRAY['Jan','Anke','Nils','Maike','Ole','Silke',
                     'Lars','Britta','Finn','Wiebke'])[1 + (n / 10 % 10)],
              'gast' || n || '@example.invalid',
              'Deichweg ' || n, '24937', 'Flensburg', 'DE'
         FROM generate_series(1, 40) n`, [accountId])

    /*
     * Reservierungen um den heutigen Tag herum: vergangene, laufende und
     * kuenftige. Ueberschneidungsfrei je Zimmer, sonst zeigt der
     * Belegungsplan einen Bestand, den es nicht geben kann.
     */
    await client.query(
      `CREATE TEMP TABLE plan ON COMMIT DROP AS
       WITH z AS (
         SELECT r.id AS resource_id, r.category_id,
                row_number() OVER (PARTITION BY r.id ORDER BY r.id) AS rn,
                row_number() OVER (ORDER BY r.id) AS zn
           FROM resource r WHERE r.property_id = $1
       ), s AS (
         SELECT z.*, g.n,
                -- ::int, nicht bigint: row_number() liefert bigint, und
                -- "date + bigint" gibt es in PostgreSQL nicht.
                (current_date - 21 + ((z.zn * 7 + g.n * 11) % 42)::int)::date AS arrival,
                (2 + ((z.zn + g.n) % 4))::int AS naechte
           FROM z CROSS JOIN generate_series(0, 1) g(n)
       )
       SELECT DISTINCT ON (resource_id, arrival) resource_id, category_id, zn, n,
              arrival, naechte,
              row_number() OVER (ORDER BY resource_id, arrival) AS lauf
         FROM s WHERE arrival + naechte < ${BIS}`, [propertyId])

    // Ueberschneidungen entfernen: je Zimmer nur Aufenthalte, die sich nicht
    // beruehren. Lieber weniger Reservierungen als ein unmoeglicher Bestand.
    await client.query(
      `DELETE FROM plan a USING plan b
        WHERE a.resource_id = b.resource_id AND a.lauf > b.lauf
          AND a.arrival < b.arrival + b.naechte
          AND b.arrival < a.arrival + a.naechte`)

    await client.query(
      `INSERT INTO booking (property_id, source, external_reference, market_segment)
       SELECT $1, (ARRAY['direct','booking_engine','channel','walk_in'])[1 + (lauf % 4)],
              'TEST-' || lauf,
              (ARRAY['leisure','corporate','group'])[1 + (lauf % 3)]
         FROM plan`, [propertyId])

    await client.query(
      `WITH rp AS (
         SELECT DISTINCT ON (category_id) category_id, id
           FROM rate_plan WHERE property_id = $1 ORDER BY category_id, id
       ), g AS (
         SELECT id, row_number() OVER (ORDER BY id) - 1 AS gn
           FROM guest WHERE account_id = $2
       )
       INSERT INTO reservation (property_id, booking_id, category_id, resource_id,
                                arrival, departure, status, rate_plan_id,
                                primary_guest_id, checked_in_at, checked_out_at)
       SELECT $1, b.id, plan.category_id,
              -- Kuenftige Aufenthalte bekommen ihr Zimmer erst bei der
              -- Anreise. So arbeitet die Rezeption, und so sieht der
              -- Belegungsplan aus, wie er im Betrieb aussieht.
              CASE WHEN plan.arrival <= current_date THEN plan.resource_id END,
              plan.arrival, plan.arrival + plan.naechte,
              CASE WHEN plan.arrival + plan.naechte <= current_date THEN 'CheckedOut'
                   WHEN plan.arrival <= current_date THEN 'InHouse'
                   ELSE 'Confirmed' END::reservation_status,
              rp.id, g.id,
              CASE WHEN plan.arrival <= current_date
                   THEN plan.arrival::timestamptz + interval '15 hours' END,
              CASE WHEN plan.arrival + plan.naechte <= current_date
                   THEN (plan.arrival + plan.naechte)::timestamptz + interval '11 hours' END
         FROM plan
         JOIN booking b ON b.property_id = $1 AND b.external_reference = 'TEST-' || plan.lauf
         JOIN rp ON rp.category_id = plan.category_id
         JOIN g ON g.gn = plan.lauf % 40`, [propertyId, accountId])

    await client.query(
      `INSERT INTO reservation_night (reservation_id, property_id, date, rate_plan_id, price_cent)
       SELECT r.id, r.property_id, d::date, r.rate_plan_id,
              COALESCE(rd.price_cent[2], 9900)
         FROM reservation r
         CROSS JOIN LATERAL generate_series(r.arrival, r.departure - 1, interval '1 day') d
         LEFT JOIN rate_day rd ON rd.rate_plan_id = r.rate_plan_id AND rd.date = d::date
        WHERE r.property_id = $1`, [propertyId])

    /*
     * Der Zaehler wird einmal aus den Reservierungen gerechnet. Im Betrieb ist
     * es umgekehrt: dort bindet jede Buchung ihr Kontingent einzeln und
     * geprueft. Hier ist der Bestand schon ueberschneidungsfrei erzeugt.
     *
     * **Die Hauszeile muss mit.** inventory_day fuehrt je Tag eine Zeile je
     * Kategorie UND eine mit category_id = 0 fuer das ganze Haus;
     * inventory_reserve erhoeht immer beide. Hier stand einmal nur der
     * Verbund ueber die Kategorie -- die Hauszeile wurde von keiner Gruppe
     * getroffen und blieb auf null.
     *
     * Der Befund sah harmlos aus und war es nicht: die Verfuegbarkeit auf
     * Hausebene meldete alle 24 Zimmer frei, waehrend sechs belegt waren.
     * Der taegliche Abgleich des Workers faellt darauf nicht herein, er
     * faellt gar nicht erst darauf: reconcileInventory filtert ausdruecklich
     * category_id <> 0. Der Fehler war also weder auf dem Bildschirm noch im
     * Protokoll zu sehen -- nur in der Zahl.
     */
    await client.query(
      `WITH belegt AS (
         SELECT r.category_id, d.day::date AS date, count(*)::int AS n
           FROM reservation r
           CROSS JOIN LATERAL
             generate_series(r.arrival, r.departure - 1, interval '1 day') d(day)
          WHERE r.property_id = $1
            AND r.status IN ('Optional','Confirmed','InHouse')
          GROUP BY 1, 2
       ), je_zeile AS (
         SELECT category_id, date, n FROM belegt
         UNION ALL
         -- Das ganze Haus: die Summe ueber alle Kategorien desselben Tages.
         SELECT 0, date, sum(n)::int FROM belegt GROUP BY date
       )
       UPDATE inventory_day i SET sold = z.n
         FROM je_zeile z
        WHERE i.property_id = $1 AND i.category_id = z.category_id AND i.date = z.date`,
      [propertyId])

    /*
     * Ein Benutzer, mit dem man sich anmelden kann. Das Kennwort kommt aus
     * der Umgebung oder wird erzeugt und einmal ausgegeben — fest im Skript
     * waere es in jedem Klon dasselbe, und dieses Haus steht am Ende auf
     * einer Maschine, die aus dem Netz erreichbar ist.
     */
    const kennwort = process.env.TESTHOTEL_PASSWORD ?? randomBytes(12).toString('base64url')
    const u = await client.query<{ id: number }>(
      `INSERT INTO app_user (email, display_name, status, password_hash)
       VALUES ($1, 'Testbetrieb Leitung', 'active', $2) RETURNING id`,
      [EMAIL, await argonHash(kennwort, { memoryCost: 19_456, timeCost: 2, parallelism: 1 })])
    await client.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL`,
      [u.rows[0]!.id, propertyId])

    const z = await client.query<{ res: string; zimmer: string }>(
      `SELECT (SELECT count(*) FROM reservation WHERE property_id = $1)::text AS res,
              (SELECT count(*) FROM resource WHERE property_id = $1)::text AS zimmer`,
      [propertyId])

    await client.query('COMMIT')

    console.log(`
Testhotel Wattenblick steht.

  Haus          ${CODE}, Uebungshaus (kein Export nach draussen, keine Gastpost)
  Zimmer        ${z.rows[0]!.zimmer} in ${KATEGORIEN.length} Kategorien
  Inventar      ${mat.rows[0]!.inventory_materialize} Tage materialisiert
  Reservierungen ${z.rows[0]!.res} um den heutigen Tag

  Anmeldung     ${EMAIL}
  Kennwort      ${kennwort}${process.env.TESTHOTEL_PASSWORD ? ' (aus der Umgebung)' : ' (erzeugt — jetzt notieren)'}
`)
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw fehler
  } finally {
    await client.end()
  }
}

// Nur als Programm, nicht beim Import.
if (process.argv[1] !== undefined
    && import.meta.url === `file://${process.argv[1]}`) {
  testhotelAnlegen().catch((fehler: unknown) => {
    console.error(fehler)
    process.exit(1)
  })
}
