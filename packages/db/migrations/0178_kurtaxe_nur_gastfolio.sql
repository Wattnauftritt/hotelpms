-- ---------------------------------------------------------------------------
-- 0178 -- Kurtaxe nur aufs Gastfolio.
--
-- Anlass: das Gruppenfolio (Sven, 16.10.2026). Es haengt an der ersten
-- Reservierung der Buchung, und post_city_tax nahm jedes offene Folio des
-- Aufenthalts: die Kurtaxe des ersten Zimmers stand danach jede Nacht
-- zweimal da, einmal am Zimmer und einmal auf der Gruppe. Dasselbe galt
-- schon fuer jedes Split-Folio (0010, 'company') -- die Pruefung gegen
-- doppeltes Buchen sieht nur das eigene Folio, und so bekam jedes weitere
-- Folio seine eigene Kurtaxe. Der Fehler stand still seit 0016.
--
-- Die Kurtaxe gehoert ans Gastfolio: sie steht auf keiner Rechnung, ihr
-- Beleg ist die Kurkarte des einzelnen Gastes (0157), und dorthin bucht
-- der Nachtlauf auch die Logis, wenn keine Umleitung etwas anderes sagt.
-- Sonst wie in 0176.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION post_city_tax(p_property bigint, p_date date,
                              p_reservation bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM assert_property_in_context(p_property);

  WITH regel AS (
    SELECT id, code, name, kind, basis, amount_cent, rate_bp, exempt_below_age,
           exempt_business, max_nights, revenue_account, vat_rate_bp
      FROM tax_rule
     WHERE property_id = p_property AND active
       AND kind IN ('city_tax', 'bed_tax')
       AND p_date >= valid_from AND (valid_to IS NULL OR p_date < valid_to)
  ), naechte AS (
    SELECT rn.reservation_id, rn.price_cent, r.business_trip, f.id AS folio_id,
           (p_date - r.arrival) + 1 AS nacht_nummer
      FROM reservation_night rn
      JOIN reservation r ON r.id = rn.reservation_id
      -- Nur das Gastfolio. Mit jedem offenen Folio des Aufenthalts buchte
      -- ein Split oder das Gruppenfolio die Kurtaxe ein zweites Mal.
      JOIN folio f ON f.reservation_id = r.id AND f.status = 'open' AND f.kind = 'guest'
     WHERE rn.property_id = p_property AND rn.date = p_date
       AND r.status IN ('InHouse', 'CheckedOut')
       AND (p_reservation IS NULL OR rn.reservation_id = p_reservation)
  ), pflichtig AS (
    SELECT n.*, g.id AS regel_id, g.code, g.name, g.basis, g.amount_cent,
           g.rate_bp, g.revenue_account, g.vat_rate_bp,
           (SELECT count(*) FROM reservation_occupant o
             WHERE o.reservation_id = n.reservation_id
               AND (g.exempt_below_age IS NULL
                    OR o.age_at_arrival IS NULL
                    OR o.age_at_arrival >= g.exempt_below_age)
               AND NOT (g.kind = 'city_tax' AND EXISTS (
                     SELECT 1 FROM registration x
                      WHERE x.reservation_id = o.reservation_id
                        AND x.guest_id = o.guest_id
                        AND x.tax_exemption_reason_id IS NOT NULL)))::integer AS personen
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
          AND c.tax_rule_id = b.regel_id
          -- Eine zurueckgenommene Vorausbuchung zaehlt nicht als gebucht.
          AND c.reverses_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id));

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
