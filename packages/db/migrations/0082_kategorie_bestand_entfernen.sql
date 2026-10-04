-- ---------------------------------------------------------------------------
-- 0082 -- Den Bestand einer leeren Zimmergruppe entfernen.
--
-- Anforderung: Sven, 04.10.2026. Eine KWHotel-Uebernahme landete im falschen
-- Haus, samt 35 im Rueckfragedialog angelegter Zimmer und ihrer Gruppen. Wer
-- die Uebernahme zuruecknimmt, nimmt auch diese Gruppen zurueck -- und deren
-- Tage in `inventory_day`, die die Anwendung nicht schreiben darf.
--
-- Nur fuer eine Gruppe ohne Zimmer und ohne gebundenen oder gesperrten
-- Bestand: sonst verschwaende mit den Zeilen eine Zahl, die noch etwas
-- bedeutet. Die Haussumme (category_id 0) rechnet der Kapazitaetstrigger
-- beim Loeschen der Zimmer ohnehin neu.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION inventory_drop_category(p_property bigint, p_category bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF p_category = 0 THEN
    RAISE EXCEPTION 'Die Haussumme ist keine Zimmergruppe';
  END IF;
  IF EXISTS (SELECT 1 FROM resource WHERE property_id = p_property
                                      AND category_id = p_category) THEN
    RAISE EXCEPTION 'Zimmergruppe % hat noch Zimmer', p_category;
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_day
              WHERE property_id = p_property AND category_id = p_category
                AND (sold <> 0 OR blocked <> 0)) THEN
    RAISE EXCEPTION 'Zimmergruppe % hat noch gebundenen Bestand', p_category;
  END IF;
  DELETE FROM inventory_day WHERE property_id = p_property AND category_id = p_category;
END $$;

REVOKE ALL ON FUNCTION inventory_drop_category(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_drop_category(bigint, bigint) TO hotelpms_app;
