-- Kurtaxe, Bettensteuer, Tourismusabgabe.
--
-- Kommunal geregelt und deshalb in jeder Gemeinde anders. Aus den Satzungen,
-- die in der Praxis vorkommen, ergeben sich fünf Achsen, und jede einzelne
-- fehlt irgendwo, wenn man sie nicht von Anfang an vorsieht:
--
-- 1. **Betrag je Person und Nacht** oder je Nacht und Einheit. Prozentual
--    kommt als Bettensteuer ebenfalls vor.
-- 2. **Altersfreigrenze.** Fast jede Satzung nimmt Kinder aus, die Grenze
--    liegt je nach Ort bei 6, 14, 16 oder 18 Jahren. Aus einer Anzahl Kinder
--    lässt sich das nicht rechnen, deshalb `reservation_occupant` mit Alter
--    (B7, Dokument 13).
-- 3. **Geschäftsreisende.** In vielen Städten ist die Übernachtungsteuer
--    beruflich veranlasst nicht zu zahlen. Das Haus braucht dafür einen
--    Nachweis; das System hält den erklärten Zweck fest, nicht den Nachweis.
-- 4. **Obergrenze der Nächte.** Viele Satzungen enden nach der 21. oder
--    28. Übernachtung. Ein Langzeitgast zahlt danach nichts mehr.
-- 5. **Gültigkeitszeitraum.** Sätze ändern sich zum Jahreswechsel. Eine Nacht
--    im Dezember muss den alten Satz behalten, auch wenn sie im Januar
--    nachgebucht wird. Ohne Datumsgrenze am Satz geht das nicht.

ALTER TABLE tax_rule
  ADD COLUMN valid_from      date    NOT NULL DEFAULT DATE '2000-01-01',
  ADD COLUMN valid_to        date,
  -- Nach dieser Zahl Übernachtungen entfällt die Abgabe. NULL = ohne Ende.
  ADD COLUMN max_nights      smallint CHECK (max_nights IS NULL OR max_nights > 0),
  ADD COLUMN revenue_account text    NOT NULL DEFAULT '8300',
  -- Ob die Abgabe selbst Umsatzsteuer trägt, ist Landesrecht und teils
  -- strittig. Deshalb ein Feld statt einer Annahme im Code.
  ADD COLUMN vat_rate_bp     integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT tax_rule_validity CHECK (valid_to IS NULL OR valid_to > valid_from);

-- Die bisherige Eindeutigkeit auf (property_id, code) muss weichen: ein Satz,
-- der zum Jahreswechsel steigt, behält sein Kürzel und bekommt nur einen
-- neuen Gültigkeitszeitraum. Genau das wäre sonst verboten.
ALTER TABLE tax_rule DROP CONSTRAINT tax_rule_property_id_code_key;

-- Ein Satz je Kürzel und Beginn. Zwei Sätze mit demselben Beginn wären
-- zweideutig, und die Zweideutigkeit fiele erst bei der Prüfung auf.
CREATE UNIQUE INDEX tax_rule_period
  ON tax_rule (property_id, code, valid_from);

/**
 * Der erklärte Zweck der Reise.
 *
 * Bewusst am Aufenthalt, nicht am Gastprofil: derselbe Mensch reist im März
 * beruflich und im Juli mit der Familie. Das System hält fest, was erklärt
 * wurde; den Nachweis führt das Haus in seiner Akte, nicht hier.
 */
ALTER TABLE reservation
  ADD COLUMN business_trip boolean NOT NULL DEFAULT false;

/**
 * Bucht die Abgaben einer Nacht.
 *
 * Eine Anweisung für das ganze Haus, nicht eine je Reservierung: bei 250
 * belegten Zimmern wären das 250 Runden im Nachtlauf.
 *
 * Idempotent über die Herkunft der Zeile: gibt es für dieses Folio, dieses
 * Datum und diese Regel bereits eine Buchung, entsteht keine zweite. Der
 * Nachtlauf hat zwar eine Schrittmarke, aber ein Nachtrag für einen alten
 * Tag darf ebenfalls nicht doppelt buchen.
 */
CREATE OR REPLACE FUNCTION post_city_tax(p_property bigint, p_date date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  PERFORM assert_property_in_context(p_property);

  WITH regel AS (
    SELECT id, code, name, basis, amount_cent, rate_bp, exempt_below_age,
           exempt_business, max_nights, revenue_account, vat_rate_bp
      FROM tax_rule
     WHERE property_id = p_property AND active
       AND kind IN ('city_tax', 'bed_tax')
       AND p_date >= valid_from AND (valid_to IS NULL OR p_date < valid_to)
  ), naechte AS (
    SELECT rn.reservation_id, rn.price_cent, r.business_trip, f.id AS folio_id,
           -- Die wievielte Nacht dieses Aufenthalts ist das? Die erste
           -- Nacht ist die Anreisenacht, also Nummer eins.
           (p_date - r.arrival) + 1 AS nacht_nummer
      FROM reservation_night rn
      JOIN reservation r ON r.id = rn.reservation_id
      JOIN folio f ON f.reservation_id = r.id AND f.status = 'open'
     WHERE rn.property_id = p_property AND rn.date = p_date
       AND r.status IN ('InHouse', 'CheckedOut')
  ), pflichtig AS (
    SELECT n.*, g.id AS regel_id, g.code, g.name, g.basis, g.amount_cent,
           g.rate_bp, g.revenue_account, g.vat_rate_bp,
           -- Zahlende Personen: wer keine Altersangabe hat, gilt als
           -- erwachsen. Lieber zu viel erheben und auf Nachweis erlassen
           -- als zu wenig und bei der Prüfung nachzahlen.
           (SELECT count(*) FROM reservation_occupant o
             WHERE o.reservation_id = n.reservation_id
               AND (g.exempt_below_age IS NULL
                    OR o.age_at_arrival IS NULL
                    OR o.age_at_arrival >= g.exempt_below_age))::integer AS personen
      FROM naechte n CROSS JOIN regel g
     WHERE NOT (g.exempt_business AND n.business_trip)
       AND (g.max_nights IS NULL OR n.nacht_nummer <= g.max_nights)
  ), betraege AS (
    SELECT p.*,
           CASE
             WHEN p.basis = 'per_person_night' THEN p.amount_cent * greatest(p.personen, 0)
             WHEN p.basis = 'per_night'        THEN CASE WHEN p.personen > 0
                                                         THEN p.amount_cent ELSE 0 END
             ELSE round(p.price_cent * p.rate_bp / 10000.0)::bigint
           END AS brutto
      FROM pflichtig p
  )
  INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                      net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                      revenue_account, reservation_id)
  SELECT p_property, b.folio_id, p_date,
         b.name || ' ' || to_char(p_date, 'DD.MM.YYYY'),
         greatest(b.personen, 1),
         b.brutto - round(b.brutto * b.vat_rate_bp / (10000.0 + b.vat_rate_bp)),
         round(b.brutto * b.vat_rate_bp / (10000.0 + b.vat_rate_bp)),
         b.brutto, b.vat_rate_bp, b.regel_id, b.revenue_account, b.reservation_id
    FROM betraege b
   WHERE b.brutto > 0
     AND NOT EXISTS (
       SELECT 1 FROM charge c
        WHERE c.folio_id = b.folio_id AND c.business_date = p_date
          AND c.tax_rule_id = b.regel_id);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
