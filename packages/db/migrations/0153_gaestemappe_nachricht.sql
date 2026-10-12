-- ---------------------------------------------------------------------------
-- 0153 Digitale Gaestemappe: Nachricht an die Rezeption
--
-- Plan gaestemappe/plan.md, Abschnitt 3 Punkt 6 (Sven, 11.10.2026): ein
-- freies Feld "Sonstiges" statt eines Chats. Es kommt als Wunsch an, mit
-- demselben Stand -- offen, erledigt, nicht moeglich -- und derselben
-- Grenze offener Wuensche je Aufenthalt (0149).
--
-- **Freitext ist personenbezogen.** Was ein Gast schreibt, kann alles
-- sein: ein Name, eine Krankheit, eine Telefonnummer. Deshalb
--   - steht die Spalte in `audit_redaction` (CLAUDE.md, Migration 0044),
--   - leeren `guest_erase_one()` und `guest_erase_partial()` sie ueber
--     `guest_request_messages_erase()`, an genau einer Stelle,
--   - leert der Worker sie 30 Tage nach der Abreise (`purgeExpired`); der
--     Wunsch selbst bleibt als "Nachricht, erledigt" stehen.
-- Die Anwendung darf die Spalte nicht aendern (0149 gibt UPDATE nur auf
-- den Stand frei).
--
-- **Aus als Vorgabe**, wie die Mappe selbst (0143): eine Nachricht, die
-- niemand liest, ist schlimmer als keine. Das Haus schaltet sie ein.
-- ---------------------------------------------------------------------------

ALTER TABLE guest_folder_setting
  ADD COLUMN messages_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE guest_request ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE guest_request
  ADD COLUMN is_message boolean NOT NULL DEFAULT false,
  ADD COLUMN message text CHECK (message IS NULL OR length(btrim(message)) BETWEEN 1 AND 500),
  -- Entweder ein Eintrag aus dem Katalog oder eine Nachricht. Der Text
  -- darf fehlen: nach der Loeschung steht die Nachricht ohne ihn da.
  ADD CONSTRAINT guest_request_eintrag_oder_nachricht CHECK (
    (is_message AND item_id IS NULL AND qty = 1 AND unit_price_cent IS NULL)
    OR (NOT is_message AND item_id IS NOT NULL AND message IS NULL));

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('guest_request', 'message', 'Freitext des Gastes an die Rezeption')
ON CONFLICT DO NOTHING;

/** Der Text der Nachrichten an den Reservierungen des Gastes. */
CREATE OR REPLACE FUNCTION guest_request_messages_erase(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE guest_request q SET message = NULL
    FROM reservation r
   WHERE r.id = q.reservation_id AND r.primary_guest_id = p_guest
     AND q.message IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION guest_request_messages_erase(bigint)
  FROM PUBLIC, hotelpms_app, hotelpms_readonly;

-- ---------------------------------------------------------------------------
-- Loeschung: beide Funktionen von Stand 0147 aus neu gefasst; wer sie das
-- naechste Mal neu fasst, geht von hier aus.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guest_erase_one(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Fremder Account: nichts tun. Kein Fehler, damit ein Stapellauf nicht an
  -- einer Zeile haengenbleibt, die ihn ohnehin nichts angeht.
  IF NOT EXISTS (SELECT 1 FROM guest
                  WHERE id = p_guest AND account_id = ANY (app_account_ids())) THEN
    RETURN;
  END IF;

  DELETE FROM guest_property_note WHERE guest_id = p_guest;
  -- Seit 0128: nur, was die Meldescheinfrist nicht mehr haelt.
  PERFORM guest_registration_purge_expired(p_guest);
  -- Seit 0061: die Links zum Online-Check-in.
  DELETE FROM checkin_token t
   USING reservation r
   WHERE r.id = t.reservation_id AND r.primary_guest_id = p_guest;
  -- Seit 0147: die Freischaltungen der Gaestemappe.
  PERFORM guest_folder_sessions_erase(p_guest);
  -- Seit 0153: der Text seiner Nachrichten aus der Gaestemappe.
  PERFORM guest_request_messages_erase(p_guest);

  -- Die Zeile bleibt: **dass** zugestimmt wurde und wann, ist der Nachweis,
  -- um den es geht. Das Bild der Unterschrift ist es nicht.
  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  -- Seit 0129: Notizen und die Fehlertexte der Gastpost.
  PERFORM guest_notes_erase(p_guest);
  PERFORM guest_email_redact(p_guest);

  -- Zahlungslinks fuehren danach ins Leere (0068).
  PERFORM payment_link_revoke_for_guest(p_guest);

  UPDATE guest
     SET last_name = 'Anonymisiert', first_name = NULL, email = NULL, phone = NULL,
         birth_date = NULL, nationality = NULL, address_line1 = NULL,
         postal_code = NULL, city = NULL, country = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         status = 'anonymized', anonymized_at = now(), updated_at = now()
   WHERE id = p_guest;
END $$;

CREATE OR REPLACE FUNCTION guest_erase_partial(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_meldeschein boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM guest
                  WHERE id = p_guest AND account_id = ANY (app_account_ids())) THEN
    RETURN;
  END IF;

  DELETE FROM guest_property_note WHERE guest_id = p_guest;
  PERFORM guest_registration_purge_expired(p_guest);
  v_meldeschein := guest_registration_retention_until(p_guest) IS NOT NULL;
  -- Seit 0061: auch hier und nicht erst im Nachtlauf -- der Link fuehrt zu
  -- einer Maske, die genau das wieder abfragt, was gerade entfernt wurde.
  DELETE FROM checkin_token t
   USING reservation r
   WHERE r.id = t.reservation_id AND r.primary_guest_id = p_guest;
  -- Seit 0147: eine Freischaltung ist kein Nachweis, den eine Frist haelt.
  PERFORM guest_folder_sessions_erase(p_guest);
  -- Seit 0153: eine Nachricht an die Rezeption auch nicht.
  PERFORM guest_request_messages_erase(p_guest);
  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  -- Seit 0129: weder Notiz noch Mailkopie ist ein Nachweis, den eine Frist
  -- haelt. Die Rechnung selbst bleibt; ihre Kopie im Postausgang nicht.
  PERFORM guest_notes_erase(p_guest);
  PERFORM guest_email_redact(p_guest);

  -- Ein Zahlungslink ist kein Nachweis, den eine Frist haelt (0068).
  PERFORM payment_link_revoke_for_guest(p_guest);

  -- Was der Meldeschein vom Gast braucht, bleibt, solange er aufzubewahren
  -- ist (0128). Mailadresse, Telefon und Vorlieben braucht er nicht.
  UPDATE guest
     SET email = NULL, phone = NULL, preferences = '{}',
         birth_date  = CASE WHEN v_meldeschein THEN birth_date  END,
         nationality = CASE WHEN v_meldeschein THEN nationality END,
         id_document_type        = CASE WHEN v_meldeschein THEN id_document_type END,
         id_document_number_enc  = CASE WHEN v_meldeschein THEN id_document_number_enc END,
         id_document_key_version = CASE WHEN v_meldeschein THEN id_document_key_version END,
         erasure_requested_at = COALESCE(erasure_requested_at, now()),
         updated_at = now()
   WHERE id = p_guest;
END $$;
