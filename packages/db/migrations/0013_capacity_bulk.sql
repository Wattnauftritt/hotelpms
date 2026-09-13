-- Kapazitaetsberechnung fuer Massenaenderungen.
--
-- Befund aus dem Seed-Lauf: 250 Zimmer anzulegen dauerte 28 Sekunden. Der
-- Trigger auf `resource` lief FOR EACH ROW und rechnete jedes Mal die
-- Kapazitaet **aller** Kategorien der Property ueber 750 Tage neu. Bei n
-- Zimmern und k Kategorien sind das n * k * 750 Zeilenberechnungen, also
-- quadratischer Aufwand in der Hausgroesse.
--
-- Das ist kein Seed-Problem. Es trifft jede Einrichtung eines Hauses, jeden
-- Import und jede Sammelaenderung, und es haelt dabei Sperren auf
-- inventory_day, waehrend die Rezeption buchen will.
--
-- Zwei Aenderungen:
--
-- 1. **Trigger auf Anweisungsebene** mit Uebergangstabellen. Ein Einfuegen
--    von 250 Zimmern rechnet einmal, nicht 250 Mal.
-- 2. **Berechnung je Kategorie.** Ein neues Zimmer betrifft eine Kategorie,
--    nicht fuenfzehn. Die Haussumme wird danach einmal je Property
--    nachgezogen, nicht einmal je Kategorie.

-- ---------------------------------------------------------------------------
-- Kapazitaet einer einzelnen Kategorie.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_recalc_category_capacity(
  p_property bigint, p_category bigint, p_from date, p_to date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE inventory_day i
     SET capacity = c.cap
    FROM (
      SELECT d.day,
             count(r.id) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM maintenance_block m
                  WHERE m.resource_id = r.id
                    AND m.kind = 'out_of_order'
                    AND d.day >= m.from_date AND d.day < m.to_date))::integer AS cap
        FROM (
          SELECT generate_series(p_from, p_to - 1, interval '1 day')::date AS day
        ) d
        LEFT JOIN resource r
          ON r.category_id = p_category AND r.active AND r.property_id = p_property
       GROUP BY d.day
    ) c
   WHERE i.property_id = p_property
     AND i.category_id = p_category
     AND i.date = c.day
     AND i.capacity IS DISTINCT FROM c.cap;
END $$;

-- ---------------------------------------------------------------------------
-- Haussumme aus den Kategorien. Immer nach den Kategorien aufrufen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_recalc_house_capacity(
  p_property bigint, p_from date, p_to date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
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

-- ---------------------------------------------------------------------------
-- Sammeltrigger. Arbeiten auf der Uebergangstabelle, nicht je Zeile.
-- Die Uebergangstabelle heisst in jedem Trigger `betroffen`, beim
-- Aendern zusaetzlich `vorher` fuer den Zustand davor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_capacity_resource_stmt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT property_id, category_id FROM betroffen LOOP
    PERFORM inventory_recalc_category_capacity(
      r.property_id, r.category_id, current_date, current_date + 750);
  END LOOP;
  FOR r IN SELECT DISTINCT property_id FROM betroffen LOOP
    PERFORM inventory_recalc_house_capacity(
      r.property_id, current_date, current_date + 750);
  END LOOP;
  RETURN NULL;
END $$;

/**
 * Beim Verschieben eines Zimmers in eine andere Kategorie oder Property
 * muessen beide Seiten neu gerechnet werden: die alte verliert das Zimmer,
 * die neue bekommt es.
 */
CREATE OR REPLACE FUNCTION inventory_capacity_resource_upd_stmt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT property_id, category_id FROM betroffen
    UNION
    SELECT DISTINCT property_id, category_id FROM vorher
  LOOP
    PERFORM inventory_recalc_category_capacity(
      r.property_id, r.category_id, current_date, current_date + 750);
  END LOOP;
  FOR r IN
    SELECT DISTINCT property_id FROM betroffen
    UNION SELECT DISTINCT property_id FROM vorher
  LOOP
    PERFORM inventory_recalc_house_capacity(
      r.property_id, current_date, current_date + 750);
  END LOOP;
  RETURN NULL;
END $$;

/**
 * Sperrungen wirken nur in ihrem Zeitraum. Der wird aus der
 * Uebergangstabelle genommen statt pauschal 750 Tage zu rechnen: eine
 * dreitaegige Sperrung kostet dann drei Tage Rechenarbeit, nicht zwei Jahre.
 */
CREATE OR REPLACE FUNCTION inventory_capacity_block_stmt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT b.property_id, res.category_id,
           min(b.from_date) AS f, max(b.to_date) AS t
      FROM betroffen b JOIN resource res ON res.id = b.resource_id
     GROUP BY b.property_id, res.category_id
  LOOP
    PERFORM inventory_recalc_category_capacity(r.property_id, r.category_id, r.f, r.t);
  END LOOP;
  FOR r IN
    SELECT property_id, min(from_date) AS f, max(to_date) AS t
      FROM betroffen GROUP BY property_id
  LOOP
    PERFORM inventory_recalc_house_capacity(r.property_id, r.f, r.t);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_capacity ON resource;
DROP TRIGGER IF EXISTS trg_capacity ON maintenance_block;
DROP FUNCTION IF EXISTS inventory_capacity_trigger();

CREATE TRIGGER trg_capacity_ins AFTER INSERT ON resource
  REFERENCING NEW TABLE AS betroffen
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_capacity_resource_stmt();
CREATE TRIGGER trg_capacity_del AFTER DELETE ON resource
  REFERENCING OLD TABLE AS betroffen
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_capacity_resource_stmt();
CREATE TRIGGER trg_capacity_upd AFTER UPDATE ON resource
  REFERENCING NEW TABLE AS betroffen OLD TABLE AS vorher
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_capacity_resource_upd_stmt();

CREATE TRIGGER trg_capacity_block_ins AFTER INSERT ON maintenance_block
  REFERENCING NEW TABLE AS betroffen
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_capacity_block_stmt();
CREATE TRIGGER trg_capacity_block_del AFTER DELETE ON maintenance_block
  REFERENCING OLD TABLE AS betroffen
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_capacity_block_stmt();
-- Beim Verschieben einer Sperrung muss der alte **und** der neue Zeitraum
-- neu gerechnet werden, sonst bleibt der alte Zeitraum gesperrt.
CREATE TRIGGER trg_capacity_block_upd_new AFTER UPDATE ON maintenance_block
  REFERENCING NEW TABLE AS betroffen
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_capacity_block_stmt();
CREATE TRIGGER trg_capacity_block_upd_old AFTER UPDATE ON maintenance_block
  REFERENCING OLD TABLE AS betroffen
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_capacity_block_stmt();
