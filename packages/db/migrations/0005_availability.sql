-- Verfuegbarkeit. Das Kernstueck des Systems.
-- Zaehlertabelle statt Aggregation ueber Reservierungen: Laufzeit unabhaengig
-- von der Historie (Dokument 04, Abschnitt 2.5).

CREATE TABLE inventory_day (
  property_id bigint  NOT NULL REFERENCES property(id),
  -- category_id = 0 ist die Haussumme. Sie verhindert, dass erlaubtes
  -- Overbooking je Kategorie unbemerkt das Haus ueberbucht (B2, Dokument 13).
  -- Sie hat die kleinste id und wird in der Sperrreihenfolge stets zuerst
  -- gesperrt, was Deadlocks bei Gruppenbuchungen ausschliesst.
  category_id bigint  NOT NULL,
  date        date    NOT NULL,
  capacity    integer NOT NULL DEFAULT 0,
  sold        integer NOT NULL DEFAULT 0,
  blocked     integer NOT NULL DEFAULT 0,
  overbooking integer NOT NULL DEFAULT 0,
  PRIMARY KEY (property_id, category_id, date),
  CONSTRAINT sold_nonneg    CHECK (sold >= 0),
  CONSTRAINT blocked_nonneg CHECK (blocked >= 0),
  CONSTRAINT capacity_nonneg CHECK (capacity >= 0)
);

CREATE TABLE inventory_error (
  code text PRIMARY KEY, description text NOT NULL
);
INSERT INTO inventory_error VALUES
  ('sold_out',         'Kapazitaet fuer mindestens eine Nacht erschoepft'),
  ('not_materialized', 'Zeitraum nicht materialisiert, Vorlauf zu kurz');

-- ---------------------------------------------------------------------------
-- Genau ein Besitzer. Kein Pfad schreibt direkt in inventory_day (W1, Dok 12).
-- Die Anwendungsrolle bekommt kein UPDATE, nur EXECUTE auf diese Funktionen.
-- ---------------------------------------------------------------------------

/**
 * Materialisiert fehlende Zeilen fuer einen Zeitraum, inklusive Haussumme.
 * Rollierender Horizont von 24 Monaten, taeglich vom Worker aufgerufen.
 */
CREATE OR REPLACE FUNCTION inventory_materialize(
  p_property bigint, p_from date, p_to date
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inserted integer;
BEGIN
  WITH cats AS (
    SELECT id, overbooking_limit FROM resource_category
     WHERE property_id = p_property AND active
    UNION ALL
    SELECT 0, 0                                  -- Haussummenzeile
  ),
  days AS (SELECT generate_series(p_from, p_to - 1, interval '1 day')::date AS d),
  ins AS (
    INSERT INTO inventory_day (property_id, category_id, date, capacity, overbooking)
    SELECT p_property, c.id, days.d, 0, c.overbooking_limit
      FROM cats c CROSS JOIN days
    ON CONFLICT (property_id, category_id, date) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO inserted FROM ins;

  -- Kapazitaet neu berechnen: aktive Zimmer minus Out-of-Order an dem Tag.
  PERFORM inventory_recalc_capacity(p_property, p_from, p_to);
  RETURN inserted;
END $$;

/** Kapazitaet je Kategorie und Tag aus Zimmern und Sperrungen ableiten. */
CREATE OR REPLACE FUNCTION inventory_recalc_capacity(
  p_property bigint, p_from date, p_to date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE inventory_day i
     SET capacity = c.cap
    FROM (
      SELECT cat.id AS category_id, d.day,
             count(r.id) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM maintenance_block m
                  WHERE m.resource_id = r.id
                    AND m.kind = 'out_of_order'
                    AND d.day >= m.from_date AND d.day < m.to_date))::integer AS cap
        FROM resource_category cat
        CROSS JOIN LATERAL (
          SELECT generate_series(p_from, p_to - 1, interval '1 day')::date AS day
        ) d
        LEFT JOIN resource r
          ON r.category_id = cat.id AND r.active AND r.property_id = p_property
       WHERE cat.property_id = p_property AND cat.active
       GROUP BY cat.id, d.day
    ) c
   WHERE i.property_id = p_property
     AND i.category_id = c.category_id
     AND i.date = c.day
     AND i.capacity IS DISTINCT FROM c.cap;

  -- Haussumme ist die Summe der Kategorien.
  UPDATE inventory_day h
     SET capacity = s.cap
    FROM (
      SELECT date, sum(capacity)::integer AS cap
        FROM inventory_day
       WHERE property_id = p_property AND category_id <> 0
         AND date >= p_from AND date < p_to
       GROUP BY date
    ) s
   WHERE h.property_id = p_property AND h.category_id = 0
     AND h.date = s.date AND h.capacity IS DISTINCT FROM s.cap;
END $$;

/**
 * Belegt Kontingent. Prueft Kapazitaet und schreibt in einer Anweisung je
 * Ebene, damit kein Doppelverkauf moeglich ist: PostgreSQL bewertet die
 * WHERE-Bedingung nach Erwerb der Zeilensperre neu.
 * Gibt NULL bei Erfolg zurueck, sonst einen Fehlercode.
 */
CREATE OR REPLACE FUNCTION inventory_reserve(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  nights integer := (p_to - p_from);
  present integer;
  affected integer;
BEGIN
  IF nights <= 0 THEN RETURN 'sold_out'; END IF;

  SELECT count(*) INTO present FROM inventory_day
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
  IF present <> nights * 2 THEN
    RETURN 'not_materialized';   -- nie als "ausgebucht" melden (P1, Dok 12)
  END IF;

  -- Haussumme zuerst: kleinste category_id, feste Sperrreihenfolge.
  UPDATE inventory_day SET sold = sold + p_count
   WHERE property_id = p_property AND category_id = 0
     AND date >= p_from AND date < p_to
     AND sold + blocked + p_count <= capacity + overbooking;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights THEN RETURN 'sold_out'; END IF;

  UPDATE inventory_day SET sold = sold + p_count
   WHERE property_id = p_property AND category_id = p_category
     AND date >= p_from AND date < p_to
     AND sold + blocked + p_count <= capacity + overbooking;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights THEN RETURN 'sold_out'; END IF;

  RETURN NULL;
END $$;

/** Gibt Kontingent frei. Storno, No-Show, Verkuerzung. */
CREATE OR REPLACE FUNCTION inventory_release(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE inventory_day SET sold = greatest(sold - p_count, 0)
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
END $$;

/** Kontingent fuer Blocks. */
CREATE OR REPLACE FUNCTION inventory_block(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE nights integer := (p_to - p_from); affected integer;
BEGIN
  UPDATE inventory_day SET blocked = blocked + p_count
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to
     AND sold + blocked + p_count <= capacity + overbooking;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights * 2 THEN RETURN 'sold_out'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inventory_unblock(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE inventory_day SET blocked = greatest(blocked - p_count, 0)
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
END $$;

-- Trigger auf Zimmern und Sperrungen rufen set_capacity, sie schreiben nicht
-- selbst in inventory_day.
CREATE OR REPLACE FUNCTION inventory_capacity_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record := coalesce(NEW, OLD);
  f date;
  t date;
BEGIN
  IF TG_TABLE_NAME = 'maintenance_block' THEN
    f := least(coalesce(NEW.from_date, OLD.from_date), coalesce(OLD.from_date, NEW.from_date));
    t := greatest(coalesce(NEW.to_date, OLD.to_date), coalesce(OLD.to_date, NEW.to_date));
  ELSE
    f := current_date;
    t := current_date + 750;
  END IF;
  PERFORM inventory_recalc_capacity(r.property_id, f, t);
  RETURN r;
END $$;

CREATE TRIGGER trg_capacity AFTER INSERT OR UPDATE OR DELETE ON resource
  FOR EACH ROW EXECUTE FUNCTION inventory_capacity_trigger();
CREATE TRIGGER trg_capacity AFTER INSERT OR UPDATE OR DELETE ON maintenance_block
  FOR EACH ROW EXECUTE FUNCTION inventory_capacity_trigger();

ALTER TABLE inventory_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_day FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON inventory_day USING (property_id = ANY (app_property_ids()));

-- Die Anwendungsrolle darf lesen, aber nicht schreiben. Nur ueber Funktionen.
REVOKE INSERT, UPDATE, DELETE ON inventory_day FROM hotelpms_app;
GRANT SELECT ON inventory_day TO hotelpms_app;
