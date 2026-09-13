-- Tageskennzahlen als Historie.
--
-- Befund aus dem Saatlauf: die Auslastung der Vergangenheit wurde mit 0,3 %
-- gemeldet, obwohl die Haeuser zu zwei Dritteln belegt waren.
--
-- Die Ursache ist kein Rechenfehler, sondern eine Verwechslung von zwei
-- verschiedenen Dingen. `inventory_day.sold` ist ein **laufender Zaehler**:
-- er sagt, wie viele Einheiten gerade gebunden sind. Eine abgereiste
-- Reservierung bindet nichts mehr und wird darin zu Recht nicht gezaehlt.
-- Fuer die Zukunft ist das genau die richtige Zahl, fuer die Vergangenheit
-- ist sie strukturell null.
--
-- Kennzahlen der Vergangenheit brauchen deshalb eine **Aufzeichnung**, keinen
-- Zaehler: was an diesem Tag tatsaechlich verkauft war, festgehalten in dem
-- Moment, in dem der Tag geschlossen wurde. Das ist zugleich die schnellere
-- Loesung, denn eine Jahresauswertung liest dann 365 Zeilen statt Hunderttausende
-- Reservierungsnaechte zu aggregieren.

CREATE TABLE business_day_stat (
  property_id       bigint NOT NULL REFERENCES property(id),
  date              date   NOT NULL,
  capacity          integer NOT NULL,
  blocked           integer NOT NULL DEFAULT 0,
  sold              integer NOT NULL,
  arrivals          integer NOT NULL DEFAULT 0,
  departures        integer NOT NULL DEFAULT 0,
  occupants         integer NOT NULL DEFAULT 0,
  -- Logiserloes netto. Getrennt vom uebrigen Umsatz, weil ADR und RevPAR
  -- nur die Logis betreffen; Fruehstueck und Getraenke gehoeren nicht hinein.
  room_revenue_cent  bigint NOT NULL DEFAULT 0,
  other_revenue_cent bigint NOT NULL DEFAULT 0,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, date)
);
CREATE INDEX business_day_stat_date ON business_day_stat (property_id, date DESC);

ALTER TABLE business_day_stat ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_day_stat FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON business_day_stat USING (property_id = ANY (app_property_ids()));

/**
 * Schreibt die Kennzahlen eines Geschaeftstags fest.
 *
 * Idempotent: ein zweiter Aufruf fuer denselben Tag ueberschreibt mit
 * demselben Ergebnis. Der Nachtlauf ruft sie **nach** dem Buchen der Logis
 * auf, sonst fehlt der Erloes des Tages.
 */
CREATE OR REPLACE FUNCTION record_day_statistics(p_property bigint, p_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);

  INSERT INTO business_day_stat (property_id, date, capacity, blocked, sold,
                                 arrivals, departures, occupants,
                                 room_revenue_cent, other_revenue_cent)
  SELECT p_property, p_date,
         COALESCE(i.capacity, 0), COALESCE(i.blocked, 0),
         -- Verkauft ist, was in dieser Nacht im Haus war. Aus den Naechten,
         -- nicht aus dem laufenden Zaehler.
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
      SELECT COALESCE(sum(net_cent) FILTER (WHERE revenue_account = '8300'), 0) AS logis,
             COALESCE(sum(net_cent) FILTER (WHERE revenue_account <> '8300'), 0) AS sonstiges
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

-- Kennzahlen sind eine Aufzeichnung, keine Fachbuchung. Die Anwendungsrolle
-- schreibt sie nicht von Hand, sondern nur ueber die Funktion.
REVOKE INSERT, UPDATE, DELETE ON business_day_stat FROM hotelpms_app;
GRANT SELECT ON business_day_stat TO hotelpms_app;

/**
 * Kennzahlen fuer einen Zeitraum nachtragen.
 *
 * Gebraucht bei der Inbetriebnahme eines Hauses mit uebernommenem Bestand
 * und nach einer Korrektur an alten Buchungen. Im Regelbetrieb schreibt der
 * Nachtlauf je einen Tag, und zwar genau einen.
 */
CREATE OR REPLACE FUNCTION record_day_statistics_range(
  p_property bigint, p_from date, p_to date
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d date; n integer := 0;
BEGIN
  PERFORM assert_property_in_context(p_property);
  FOR d IN SELECT generate_series(p_from, p_to, interval '1 day')::date LOOP
    PERFORM record_day_statistics(p_property, d);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
