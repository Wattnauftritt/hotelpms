-- Fruehstueck inklusive je Rate (Pruefung Rechnungssystem 2026-10-13, Befund 3).
--
-- Befund: der Nachtlauf bucht den ganzen Nachtpreis als Uebernachtung zu 7 %.
-- Steckt das Fruehstueck im Preis, ist das zu wenig Steuer: seit 2026 sind
-- die Speisen zwar ebenfalls 7 %, die Getraenke aber 19 %. Das
-- Aufteilungsgebot (§ 12 Abs. 2 Nr. 11 Satz 2 UStG) verlangt, den Anteil
-- herauszurechnen.
--
-- Das Haus sagt je Rate nur, ob Fruehstueck enthalten ist und was es je
-- Person und Nacht kostet. Den Getraenkeanteil gibt das BMF pauschal vor
-- (30 %, Schreiben vom 22.12.2025 zu Kombiangeboten); er ist deshalb keine
-- Einstellung, sondern steht einmal in `@hotelpms/domain` (breakfast.ts).
--
-- Leer heisst "nicht enthalten". Null Euro waere ein Fruehstueck, das
-- nichts kostet, und ergaebe keine Aufteilung -- dieselbe Wirkung, aber
-- eine Aussage, die niemand gemacht hat.

ALTER TABLE rate_plan ADD COLUMN breakfast_cent integer
  CHECK (breakfast_cent IS NULL OR breakfast_cent BETWEEN 1 AND 100000);

COMMENT ON COLUMN rate_plan.breakfast_cent IS
  'Im Preis enthaltenes Fruehstueck, brutto je Person und Nacht. Leer: nicht enthalten.';

-- Woran eine Buchung als Fruehstuecksteil der Nacht erkennbar ist.
--
-- Die Speisen gehen auf 8300 wie die Logis: in SKR03 ist das das
-- Automatikkonto fuer 7 %, und der DATEV-Stapel setzt keinen
-- Steuerschluessel, sondern verlaesst sich auf das Konto. 8300 heisst an
-- drei Stellen aber zugleich "Logis" -- Kennzahlen, Einheit `DAY` im XML,
-- Storno bei Nichtanreise. Ohne eigene Markierung zaehlte das Fruehstueck
-- als Zimmerumsatz und hebt still den Durchschnittspreis.
ALTER TABLE charge ADD COLUMN package_part text
  CHECK (package_part IN ('breakfast_food', 'breakfast_drinks'));

-- Kennzahlen: Logis ist 8300 ohne Fruehstuecksteil, alles andere
-- Sonstiges. Sonst unveraendert gegenueber 0014.
CREATE OR REPLACE FUNCTION record_day_statistics(p_property bigint, p_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);

  INSERT INTO business_day_stat (property_id, date, capacity, blocked, sold,
                                 arrivals, departures, occupants,
                                 room_revenue_cent, other_revenue_cent)
  SELECT p_property, p_date,
         COALESCE(i.capacity, 0), COALESCE(i.blocked, 0),
         COALESCE(n.belegt, 0),
         COALESCE(an.n, 0), COALESCE(ab.n, 0), COALESCE(n.personen, 0),
         COALESCE(u.logis, 0), COALESCE(u.sonstiges, 0)
    FROM (SELECT 1) x
    LEFT JOIN inventory_day i
           ON i.property_id = p_property AND i.category_id = 0 AND i.date = p_date
    LEFT JOIN (
      SELECT count(*)::int AS belegt,
             COALESCE(sum(GREATEST((SELECT count(*) FROM reservation_occupant o
                                     WHERE o.reservation_id = r.id), 1)), 0)::int AS personen
        FROM reservation_night rn
        JOIN reservation r ON r.id = rn.reservation_id
       WHERE rn.property_id = p_property AND rn.date = p_date
         AND r.status IN ('InHouse','CheckedOut')
    ) n ON true
    LEFT JOIN (
      SELECT count(*)::int AS n FROM reservation
       WHERE property_id = p_property AND arrival = p_date
         AND status IN ('InHouse','CheckedOut')
    ) an ON true
    LEFT JOIN (
      SELECT count(*)::int AS n FROM reservation
       WHERE property_id = p_property AND departure = p_date
         AND status = 'CheckedOut'
    ) ab ON true
    LEFT JOIN (
      SELECT COALESCE(sum(net_cent) FILTER (WHERE revenue_account = '8300'
                                              AND package_part IS NULL), 0) AS logis,
             COALESCE(sum(net_cent) FILTER (WHERE revenue_account <> '8300'
                                              OR package_part IS NOT NULL), 0) AS sonstiges
        FROM charge WHERE property_id = p_property AND business_date = p_date
    ) u ON true
  ON CONFLICT (property_id, date) DO UPDATE SET
    capacity = EXCLUDED.capacity, blocked = EXCLUDED.blocked, sold = EXCLUDED.sold,
    arrivals = EXCLUDED.arrivals, departures = EXCLUDED.departures,
    occupants = EXCLUDED.occupants,
    room_revenue_cent = EXCLUDED.room_revenue_cent,
    other_revenue_cent = EXCLUDED.other_revenue_cent,
    recorded_at = now();
END $$;
