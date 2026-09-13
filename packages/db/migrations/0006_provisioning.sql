-- Bereitstellung und Absicherung der Inventarfunktionen.
--
-- Rollenaufteilung (W2, Dokument 12), praezisiert:
--   hotelpms_owner     Migrationen UND Bereitstellung neuer Accounts und
--                      Properties. Hat BYPASSRLS, weil beim Anlegen eines
--                      Accounts noch kein Mandantenkontext existieren kann.
--                      Wird nie fuer normale Anfragen benutzt.
--   hotelpms_app       Alle Anfragen. Kein BYPASSRLS, kein Eigentum.
--   hotelpms_readonly  Berichte und Replikat.

-- Die Inventarfunktionen laufen als SECURITY DEFINER und umgehen damit die
-- Zeilenrichtlinie. Sie muessen den Mandanten daher selbst pruefen, sonst
-- koennte ein Aufruf fremdes Kontingent belegen.
CREATE OR REPLACE FUNCTION assert_property_in_context(p_property bigint)
RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- Leerer Kontext = Systemarbeit (Worker, Migration, Bereitstellung).
  IF app_property_ids() = ARRAY[]::bigint[] THEN RETURN; END IF;
  IF NOT (p_property = ANY (app_property_ids())) THEN
    RAISE EXCEPTION 'Property % liegt nicht im Mandantenkontext', p_property
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION inventory_reserve(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  nights integer := (p_to - p_from);
  present integer;
  affected integer;
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF nights <= 0 OR p_count <= 0 THEN RETURN 'sold_out'; END IF;

  SELECT count(*) INTO present FROM inventory_day
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
  IF present <> nights * 2 THEN RETURN 'not_materialized'; END IF;

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

CREATE OR REPLACE FUNCTION inventory_release(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);
  UPDATE inventory_day SET sold = greatest(sold - p_count, 0)
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
END $$;

CREATE OR REPLACE FUNCTION inventory_block(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE nights integer := (p_to - p_from); affected integer;
BEGIN
  PERFORM assert_property_in_context(p_property);
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
  PERFORM assert_property_in_context(p_property);
  UPDATE inventory_day SET blocked = greatest(blocked - p_count, 0)
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
END $$;
