-- ---------------------------------------------------------------------------
-- 0100 -- Kassenbuch: Buchungen loeschen, bis sie an DATEV gingen.
--
-- Anforderung: Sven, 07.10.2026 ("fuer Testeintraege waere es gut, wenn man
-- Eintraege im Kassenbuch auch vollstaendig loeschen kann"), auf der Karte
-- entschieden: "Bis zum DATEV-Export". Rechtsverbindlich ist das Kassenbuch,
-- das an DATEV ging und dort festgeschrieben ist; was noch nicht dort ist,
-- darf verschwinden. So hielt es auch das Adminpanel.
--
-- Was bleibt, wie es war:
--   * UPDATE bleibt verboten, fuer jeden. Geaendert wird nichts.
--   * Was an DATEV ging (Merker gleich welcher Quelle), bleibt fuer immer.
--   * Die Anwendungsrolle hat weiter kein DELETE. Der einzige Weg ist
--     cashbook_erase(), und die prueft selbst.
--   * Jede geloeschte Zeile steht im audit_log, mit dem Benutzer.
--
-- Die Sperre (trg_append_only) laesst ein DELETE nur durch, wenn die
-- Transaktion es ausdruecklich angemeldet hat. Die Anmeldung allein nuetzt
-- der Anwendungsrolle nichts, denn ihr fehlt das Recht zu loeschen; sie
-- ist der Riegel gegen ein versehentliches DELETE der Eigentuemerrolle.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION forbid_mutation_except_cashbook_erase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('hotelpms.cashbook_erase', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Tabelle % ist unveraenderlich (GoBD). Korrektur nur als Gegenbuchung.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cashbook_entry', 'cashbook_receipt'] LOOP
    EXECUTE format('DROP TRIGGER trg_append_only ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON %I
                      FOR EACH ROW EXECUTE FUNCTION forbid_mutation_except_cashbook_erase()', t);
  END LOOP;
END $$;

-- Loescht eine Buchung samt ihrer Gruppe, ihren Gegenbuchungen und Belegen.
-- Gibt die geloeschten Nummern zurueck. Die Route prueft dasselbe vorher und
-- antwortet lesbar; dies ist der Riegel dahinter.
CREATE OR REPLACE FUNCTION cashbook_erase(p_property bigint, p_entry_no bigint)
RETURNS bigint[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_kopf   cashbook_entry%ROWTYPE;
  v_ids    bigint[];
  v_nummer bigint[];
BEGIN
  -- Ohne Kontext loescht niemand: kein Nachtlauf, keine Wartung.
  IF NOT (p_property = ANY (app_property_ids())) THEN
    RAISE EXCEPTION 'Property % liegt nicht im Mandantenkontext', p_property
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_kopf FROM cashbook_entry
   WHERE property_id = p_property AND entry_no = p_entry_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buchung % gibt es nicht', p_entry_no USING ERRCODE = 'no_data_found';
  END IF;
  IF v_kopf.group_id IS NOT NULL THEN
    SELECT * INTO v_kopf FROM cashbook_entry WHERE id = v_kopf.group_id;
  END IF;
  IF v_kopf.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'Eine Gegenbuchung wird mit ihrer Buchung geloescht'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Eine uebernommene Zeile kaeme mit dem naechsten Push wieder.
  IF v_kopf.external_system IS NOT NULL THEN
    RAISE EXCEPTION 'Eine uebernommene Buchung wird im Umsystem geloescht'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(e.id) INTO v_ids FROM cashbook_entry e
   WHERE e.property_id = p_property
     AND (e.id = v_kopf.id OR e.group_id = v_kopf.id
          OR e.reverses_id IN (SELECT g.id FROM cashbook_entry g
                                WHERE g.id = v_kopf.id OR g.group_id = v_kopf.id));

  IF EXISTS (SELECT 1 FROM cashbook_datev_mark d WHERE d.entry_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'Buchung % ging an DATEV und bleibt', v_kopf.entry_no
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM outbound_email o JOIN cashbook_receipt r ON r.id = o.cashbook_receipt_id
              WHERE r.entry_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'Ein Beleg der Buchung % ist schon an DATEV unterwegs', v_kopf.entry_no
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('hotelpms.cashbook_erase', 'on', true);
  DELETE FROM cashbook_receipt WHERE entry_id = ANY (v_ids);
  -- Eine Anweisung: Gruppe und Gegenbuchung verweisen aufeinander, der
  -- Fremdschluessel wird am Ende der Anweisung geprueft.
  WITH weg AS (DELETE FROM cashbook_entry WHERE id = ANY (v_ids) RETURNING entry_no)
  SELECT array_agg(entry_no ORDER BY entry_no) INTO v_nummer FROM weg;
  PERFORM set_config('hotelpms.cashbook_erase', '', true);
  RETURN v_nummer;
END $$;

REVOKE EXECUTE ON FUNCTION cashbook_erase(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cashbook_erase(bigint, bigint) TO hotelpms_app;
