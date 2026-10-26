import { BREAKFAST_DRINKS_ACCOUNT, BREAKFAST_DRINKS_RATE_BP, BREAKFAST_DRINKS_SHARE_BP,
         BREAKFAST_FOOD_ACCOUNT, BREAKFAST_FOOD_RATE_BP } from './breakfast.js'

/**
 * Die Logis buchen: eine geschlossene Nacht im Nachtlauf, oder alle offenen
 * Naechte eines Aufenthalts auf Knopfdruck.
 *
 * **Warum in der Domaene.** Zwei Seiten buchen dieselbe Nacht: der Nachtlauf
 * (`apps/worker`) jede Nacht fuer das ganze Haus, und seit dem 15.10.2026 die
 * Rezeption, wenn ein Gast beim Check-in zahlt und sofort die Rechnung will
 * (Sven: "wenn gäste beim checkin sofort eine rechnung wollen drücken wir
 * unseren neuen button"). Apps duerfen einander nicht importieren; zwei
 * Fassungen derselben Aufteilung in Logis, Fruehstueck und
 * Inklusivleistungen liefen auseinander, und die Rechnung einer vorab
 * gebuchten Nacht saehe anders aus als die einer im Nachtlauf gebuchten.
 *
 * **Jede Nacht mit ihrem eigenen Tag**, auch vorab: die Gegenbuchungen beim
 * No-Show, die Preiskorrektur und die Fruehstuecksaufteilung finden die
 * Buchungen einer Nacht ueber `business_date`. Gebucht wird nur, was noch
 * nicht gebucht ist (`posted`); der Nachtlauf laesst eine vorab gebuchte
 * Nacht deshalb aus.
 */

/** Was ein Datenbankclient hier koennen muss -- wie in `roomSortRun.ts`. */
export interface StayPostingSqlClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]
                                                         rowCount?: number | null }>
}

export type NightPostingScope =
  /** Alle Aufenthalte des Hauses in dieser Nacht (Nachtlauf). */
  | { date: string }
  /** Alle offenen Naechte eines Aufenthalts (Vorausbuchung). */
  | { reservationId: number }

/**
 * Bucht die Logis und gibt die gebuchten Naechte zurueck.
 *
 * Gebucht werden nur Aufenthalte im Haus oder abgereist, und nur auf das
 * offene Gastfolio; eine Umleitung (`routing_rule`) gilt wie im Nachtlauf.
 *
 * Enthaelt die Rate Fruehstueck (`rate_plan.breakfast_cent`, Migration
 * 0158), wird es aus dem Nachtpreis herausgerechnet und als Speisen und
 * Getraenke gebucht, je zu ihrem Satz. Die Rechnung dazu steht in
 * `breakfastPerNight` und `splitNight`; hier dieselbe in SQL, damit der
 * Nachtlauf bei 250 Zimmern eine Anweisung bleibt.
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
export async function postNights(
  client: StayPostingSqlClient, propertyId: number, scope: NightPostingScope
): Promise<string[]> {
  // Zwei Texte statt eines ODER: der Nachtlauf soll ueber den Index auf
  // (Haus, Datum) gehen und nicht ueber alle Naechte des Hauses.
  const filter = 'date' in scope ? 'rn.date = $2::date' : 'rn.reservation_id = $2::bigint'
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
              -- den erfassten Gaesten, mindestens eine. Der Preis kommt
              -- aus der Rate, sonst aus der Regel des Hauses (fp, 0169).
              LEAST(CASE
                      WHEN fp.erwachsen IS NULL THEN 0
                      WHEN fp.kind IS NOT NULL AND r.adults IS NOT NULL
                        THEN r.adults::bigint * fp.erwachsen
                             + COALESCE(r.children, 0)::bigint * fp.kind
                      ELSE fp.erwachsen::bigint
                           * GREATEST(COALESCE(r.guest_count,
                                               (SELECT count(*) FROM reservation_occupant o
                                                 WHERE o.reservation_id = r.id)::int), 1)
                    END,
                    GREATEST(rn.price_cent, 0)) AS fruehstueck,
              -- Die Menge der Fruehstueckszeilen wie breakfastCount
              -- (domain): wer zahlt, ein freies Kinderfruehstueck nicht.
              CASE WHEN fp.kind IS NOT NULL AND r.adults IS NOT NULL
                     THEN GREATEST(r.adults + CASE WHEN fp.kind > 0
                                                   THEN COALESCE(r.children, 0)
                                                   ELSE 0 END, 1)
                   ELSE GREATEST(COALESCE(r.guest_count,
                                          (SELECT count(*) FROM reservation_occupant o
                                            WHERE o.reservation_id = r.id)::int), 1)
              END AS fruehstuecke,
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
         JOIN property pr ON pr.id = r.property_id
         -- Hat die Rate einen eigenen Fruehstueckspreis, gilt er samt
         -- Kinderpreis; sonst der des Hauses. "Ohne Fruehstueck" an der
         -- Reservierung schlaegt beides (0169).
         CROSS JOIN LATERAL (
           SELECT CASE WHEN r.breakfast_declined THEN NULL
                       ELSE COALESCE(rp.breakfast_cent, pr.breakfast_cent) END AS erwachsen,
                  CASE WHEN rp.breakfast_cent IS NOT NULL THEN rp.breakfast_child_cent
                       ELSE pr.breakfast_child_cent END AS kind
         ) fp
         LEFT JOIN LATERAL (
           SELECT target_folio_id FROM routing_rule x
            WHERE x.reservation_id = r.id
              AND x.match_kind IN ('all', 'accommodation')
            -- Die genauere Regel gewinnt: 'accommodation' vor 'all'.
            ORDER BY CASE x.match_kind WHEN 'accommodation' THEN 0 ELSE 1 END, x.id
            LIMIT 1
         ) rr ON true
        WHERE r.property_id = $1 AND ${filter}
          AND r.status IN ('InHouse', 'CheckedOut') AND NOT rn.posted
        FOR UPDATE OF rn
     ), teile AS (
       -- Getraenke einmal gerundet, Speisen der Rest: die drei Teile ergeben
       -- immer genau den Nachtpreis (wie splitNight).
       SELECT f.*, round(f.fruehstueck * $3::int / 10000.0)::bigint AS getraenke
         FROM faellig f
     ), inklusiv_roh AS (
       SELECT t.reservation_id, t.date, p.id AS product_id, p.name, p.revenue_account,
              tr.rate_bp,
              p.price_cent * CASE p.charge_mode WHEN 'per_person_night' THEN t.personen
                                                ELSE 1 END AS brutto
         FROM teile t
         JOIN rate_plan_product rpp ON rpp.rate_plan_id = t.plan_id
         JOIN product p ON p.id = rpp.product_id AND p.active AND p.property_id = $1
         LEFT JOIN tax_rule tr ON tr.id = p.tax_rule_id
        WHERE p.price_cent > 0 AND (p.charge_mode <> 'once' OR t.arrival = t.date)
     ), inklusiv AS (
       -- Was Fruehstueck und die vorigen Leistungen von der Nacht uebrig
       -- lassen, nie weniger als null.
       SELECT i.*,
              GREATEST(LEAST(i.brutto,
                             GREATEST(t.price_cent, 0) - t.fruehstueck
                             - COALESCE(sum(i.brutto) OVER (
                                 PARTITION BY i.reservation_id, i.date ORDER BY i.product_id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)),
                       0)::bigint AS anteil
         FROM inklusiv_roh i
         JOIN teile t ON t.reservation_id = i.reservation_id AND t.date = i.date
     ), inklusiv_summe AS (
       SELECT reservation_id, date, sum(anteil)::bigint AS summe
         FROM inklusiv GROUP BY reservation_id, date
     ), zeilen AS (
       SELECT t.property_id, t.folio_id, t.reservation_id, t.date,
              z.n, z.text, z.menge, z.brutto, z.satz, z.konto, z.teil
         FROM teile t CROSS JOIN steuer s
         LEFT JOIN inklusiv_summe k ON k.reservation_id = t.reservation_id AND k.date = t.date
         -- Die Texte stehen so auf der Rechnung des Gastes; dort gehoeren
         -- die Umlaute hin (Sven, 14.10.2026). Aeltere Buchungen tragen
         -- noch die Umschreibung, die Abfragen kennen beide.
         CROSS JOIN LATERAL (VALUES
           (1, 'Übernachtung', 1, t.price_cent - t.fruehstueck - COALESCE(k.summe, 0),
               s.rate_bp, '8300', NULL::text),
           (2, 'Frühstück Speisen', t.fruehstuecke, t.fruehstueck - t.getraenke, $4::int,
               $6::text, 'breakfast_food'),
           (3, 'Frühstück Getränke', t.fruehstuecke, t.getraenke, $5::int, $7::text,
               'breakfast_drinks')
         ) z(n, text, menge, brutto, satz, konto, teil)
        -- Die Logis auch bei null: eine Nacht, die gebucht wurde, steht im
        -- Folio, wie bisher. Fruehstuecksteile nur, wenn es sie gibt.
        WHERE z.n = 1 OR z.brutto > 0
       UNION ALL
       -- Ohne eigene Steuerregel traegt die Leistung den Satz der Logis,
       -- wie in der Anzahlung.
       SELECT t.property_id, t.folio_id, t.reservation_id, t.date,
              3 + row_number() OVER (PARTITION BY i.reservation_id, i.date
                                     ORDER BY i.product_id),
              i.name, 1, i.anteil, COALESCE(i.rate_bp, s.rate_bp), i.revenue_account,
              'inclusion'
         FROM inklusiv i
         JOIN teile t ON t.reservation_id = i.reservation_id AND t.date = i.date
        CROSS JOIN steuer s
        WHERE i.anteil > 0
     ), gebucht AS (
       INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id, package_part)
       SELECT z.property_id, z.folio_id, z.date,
              z.text || ' ' || to_char(z.date, 'DD.MM.YYYY'), z.menge,
              z.brutto - round(z.brutto * z.satz / (10000.0 + z.satz)),
              round(z.brutto * z.satz / (10000.0 + z.satz)),
              z.brutto, z.satz, z.konto, z.reservation_id, z.teil
         FROM zeilen z
        ORDER BY z.reservation_id, z.date, z.n
       RETURNING 1
     )
     UPDATE reservation_night rn SET posted = true
       FROM faellig f
      WHERE rn.reservation_id = f.reservation_id AND rn.date = f.date
     RETURNING rn.date::text AS date`,
    [propertyId, 'date' in scope ? scope.date : scope.reservationId,
     BREAKFAST_DRINKS_SHARE_BP, BREAKFAST_FOOD_RATE_BP, BREAKFAST_DRINKS_RATE_BP,
     BREAKFAST_FOOD_ACCOUNT, BREAKFAST_DRINKS_ACCOUNT])
  return (r.rows as Array<{ date: string }>).map(n => n.date).sort()
}
