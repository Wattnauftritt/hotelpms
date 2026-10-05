-- ---------------------------------------------------------------------------
-- 0089 -- Befreiung von der Kurtaxe je Person, am Meldeschein erklaert.
--
-- Anforderung: Sven, 05.10.2026: "auch sollten wir die Befreiung von der
-- Kurtaxe abfragen im Meldeformular". Das Adminpanel fragt das heute je
-- Person ab (Grund, dazu freiwillig eine Ausweis- oder Kartennummer) und
-- bildet den Grund auf die AVS-Kategorie ab. Konzept:
-- adminpanel/gastdaten-meldeschein-konzept.md, Abschnitt 2.6.
--
-- Bisher kannte StayGrid Befreiungen nur nach Alter und als Geschaeftsreise
-- je Reservierung (0016). Was eine Befreiung begruendet, regelt die Satzung
-- jeder Gemeinde anders -- Schwerbehinderung, Begleitperson mit Merkzeichen
-- B, Kurklinik, Jahreskurkarte --, deshalb eine Liste je Haus und keine
-- feste im Code.
-- ---------------------------------------------------------------------------

/**
 * Die Gruende, die ein Haus im Meldeformular anbietet.
 *
 * `needs_proof`: ob nach einer Ausweis- oder Kartennummer gefragt wird. Die
 * Nummer ist freiwillig, sie dient der Pruefung durch die Gemeinde; ein
 * Upload des Ausweises kommt nicht in Frage (dieselbe Ueberlegung wie
 * § 30 BMG fuer den Personalausweis).
 *
 * `avs_category`: die Kategorie im Meldeschein-Export nach AVS. Die Nummern
 * gelten nur in der Gemeinde, deren Konfiguration sie festlegt.
 *
 * Abgeschaltet, nicht geloescht: ein Meldeschein zeigt auf den Grund, den
 * der Gast gewaehlt hat, auch wenn das Haus ihn spaeter nicht mehr anbietet.
 */
CREATE TABLE city_tax_exemption_reason (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  code          text NOT NULL CHECK (code ~ '^[a-z0-9_]{1,40}$'),
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  needs_proof   boolean NOT NULL DEFAULT false,
  avs_category  smallint CHECK (avs_category IS NULL OR avs_category BETWEEN 1 AND 99),
  active        boolean NOT NULL DEFAULT true,
  sort          smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

ALTER TABLE city_tax_exemption_reason ENABLE ROW LEVEL SECURITY;
ALTER TABLE city_tax_exemption_reason FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON city_tax_exemption_reason
  USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('city_tax_exemption_reason');

/*
 * Am Meldeschein, nicht am Gastprofil und nicht an `reservation_occupant`.
 *
 * - Nicht am Profil: derselbe Mensch reist einmal zur Kur und einmal privat.
 * - Am Meldeschein: dort wird die Befreiung erklaert, dorthin gehoert sie
 *   im AVS-Export, und sie geht mit ihm nach einem Jahr (§ 30 Abs. 4 BMG)
 *   und mit `guest_erase_one/partial`, die `registration` ohnehin loeschen.
 *   Eine eigene Stelle muessten die Loeschfunktionen kennen -- genau die
 *   Bauart, die einmal eine Unterschrift hat ueberleben lassen (0046).
 *
 * Jede Person hat ihre eigene Zeile: der Hauptschein und je Mitreisendem
 * eine, die auf ihn zeigt (Sammelmeldeschein).
 */
ALTER TABLE registration
  ADD COLUMN tax_exemption_reason_id bigint REFERENCES city_tax_exemption_reason(id),
  ADD COLUMN tax_exemption_proof     text CHECK (tax_exemption_proof IS NULL
                                                 OR length(tax_exemption_proof) <= 100),
  ADD CONSTRAINT registration_exemption_proof
    CHECK (tax_exemption_proof IS NULL OR tax_exemption_reason_id IS NOT NULL);

/*
 * Beides gehoert nicht ins Protokoll. Die Nummer ist die eines
 * Schwerbehindertenausweises oder einer Kurkarte und fuehrt zu einem
 * Menschen. Der Grund selbst ist bei "100 % Behinderung" ein
 * Gesundheitsdatum (Art. 9 DSGVO) -- und das Protokoll kann nicht geloescht
 * werden (0044).
 */
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('registration', 'tax_exemption_reason_id', 'Befreiungsgrund, teils Art.-9-Daten'),
  ('registration', 'tax_exemption_proof',     'Ausweis- oder Kartennummer')
ON CONFLICT DO NOTHING;

/**
 * Bucht die Abgaben einer Nacht -- jetzt ohne die befreiten Personen.
 *
 * Wer am Meldeschein eine Befreiung erklaert hat, zaehlt fuer die Kurtaxe
 * nicht mit. Sonst sagten Meldeschein und Rechnung Verschiedenes, und die
 * Kurverwaltung bekaeme eine Befreiung gemeldet, die der Gast trotzdem
 * bezahlt hat.
 *
 * Nur fuer `city_tax`, nicht fuer `bed_tax`: eine Befreiung nach der
 * Kurbeitragssatzung befreit nicht von der Uebernachtungsteuer, die eine
 * eigene Satzung mit eigenen Gruenden hat (AVS fuehrt dafuer sogar die
 * Kategorie "nur Uebernachtungsteuermeldung"). Die Geschaeftsreise bleibt
 * wie bisher am Satz (`exempt_business`).
 *
 * Sonst unveraendert gegenueber 0016.
 */
CREATE OR REPLACE FUNCTION post_city_tax(p_property bigint, p_date date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
      JOIN folio f ON f.reservation_id = r.id AND f.status = 'open'
     WHERE rn.property_id = p_property AND rn.date = p_date
       AND r.status IN ('InHouse', 'CheckedOut')
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
          AND c.tax_rule_id = b.regel_id);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
