-- ---------------------------------------------------------------------------
-- 0101 -- Kassenbuch: eine Uebernahme verwerfen und neu beginnen.
--
-- Anforderung: Sven, 07.10.2026. Die erste Uebernahme in Haus 2 brachte
-- 30 Testbuchungen aus dem Adminpanel mit, samt Gegenbuchung; keine davon
-- ging je an DATEV. Entschieden ist "Neu uebernehmen": das Haus leeren, den
-- Zaehler zuruecksetzen, ohne die Testbuchungen neu schieben. Eine
-- Konsole auf der StayGrid-Maschine hat Sven nicht; also loest der
-- Maschinenzugang des Adminpanels es aus, wie die Uebernahme selbst.
--
-- Das ist kein Loeschen im Kassenbuch, sondern das Verwerfen einer Kopie,
-- und es geht nur, solange es eine reine Kopie ist:
--   * kein Stichtag gesetzt (danach ist StayGrid das fuehrende System),
--   * keine Buchung, die in StayGrid selbst entstand oder aus einem anderen
--     Umsystem kam,
--   * nichts, was StayGrid selbst an DATEV gab oder an die Uploadmail schickte.
-- Merker mit Quelle `import` gehen mit: sie sagen nur, dass das Adminpanel
-- die Zeile exportiert hat, und kommen mit dem naechsten Push wieder.
-- ---------------------------------------------------------------------------

-- Auch die Merker brauchen die Ausnahme aus 0100.
DROP TRIGGER trg_append_only ON cashbook_datev_mark;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON cashbook_datev_mark
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_except_cashbook_erase();

-- Zaehlt, prueft und loescht nur mit p_execute. Gibt die Anzahlen vor dem
-- Loeschen zurueck.
CREATE OR REPLACE FUNCTION cashbook_import_reset(p_property bigint, p_system text, p_execute boolean)
RETURNS TABLE (entries bigint, receipts bigint, datev_marks bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n bigint;
BEGIN
  IF NOT (p_property = ANY (app_property_ids())) THEN
    RAISE EXCEPTION 'Property % liegt nicht im Mandantenkontext', p_property
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM cashbook_setting s
              WHERE s.property_id = p_property AND s.datev_from IS NOT NULL) THEN
    RAISE EXCEPTION 'Nach dem Stichtag wird keine Uebernahme verworfen'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Eigen ist, was nicht aus diesem Umsystem kommt und auch keine
  -- Gegenbuchung einer Zeile von dort ist.
  SELECT count(*) INTO v_n
    FROM cashbook_entry e LEFT JOIN cashbook_entry o ON o.id = e.reverses_id
   WHERE e.property_id = p_property
     AND e.external_system IS DISTINCT FROM p_system
     AND (o.id IS NULL OR o.external_system IS DISTINCT FROM p_system);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Im Haus stehen % Buchungen, die nicht aus der Uebernahme kommen', v_n
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM cashbook_datev_mark d
              WHERE d.property_id = p_property AND d.source <> 'import')
     OR EXISTS (SELECT 1 FROM outbound_email o JOIN cashbook_receipt r ON r.id = o.cashbook_receipt_id
                 WHERE r.property_id = p_property) THEN
    RAISE EXCEPTION 'StayGrid hat aus diesem Haus schon an DATEV uebergeben'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY SELECT
    (SELECT count(*) FROM cashbook_entry      c WHERE c.property_id = p_property),
    (SELECT count(*) FROM cashbook_receipt    c WHERE c.property_id = p_property),
    (SELECT count(*) FROM cashbook_datev_mark c WHERE c.property_id = p_property);

  IF p_execute THEN
    PERFORM set_config('hotelpms.cashbook_erase', 'on', true);
    DELETE FROM cashbook_datev_mark WHERE property_id = p_property;
    DELETE FROM cashbook_receipt    WHERE property_id = p_property;
    -- Eine Anweisung: Gruppe und Gegenbuchung verweisen aufeinander.
    DELETE FROM cashbook_entry      WHERE property_id = p_property;
    -- Die naechste Uebernahme beginnt wieder bei Nummer 1.
    DELETE FROM cashbook_counter    WHERE property_id = p_property;
    PERFORM set_config('hotelpms.cashbook_erase', '', true);
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION cashbook_import_reset(bigint, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cashbook_import_reset(bigint, text, boolean) TO hotelpms_app;
