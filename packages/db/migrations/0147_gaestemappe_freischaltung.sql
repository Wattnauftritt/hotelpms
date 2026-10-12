-- ---------------------------------------------------------------------------
-- 0147 Digitale Gaestemappe, Baustein 4: Freischalten mit Nachname oder PLZ
--
-- Plan gaestemappe/plan.md (Sven, 11.10.2026): wer die Karte im Zimmer
-- scannt, sieht Hausinfos und WLAN -- das liegt ohnehin auf dem Tisch.
-- Handeln (Reinigungsverzicht, Wuensche) darf nur der laufende Aufenthalt
-- in diesem Zimmer. Der Gast bestaetigt dafuer einmal mit Nachname oder PLZ,
-- und das Telefon bleibt bis zum Ende des Abreisetags freigeschaltet.
--
--   guest_folder_session         eine Freischaltung: Hash im Cookie des
--                                Telefons, gebunden an genau eine Reservierung
--   guest_folder_unlock_failure  Fehlversuche je Zimmer
--
-- **An die Reservierung gebunden, nicht an das Zimmer.** Am Wechseltag gelten
-- zwei Aufenthalte im selben Zimmer; jede Freischaltung sieht nur ihren
-- eigenen. Wechselt der Gast das Zimmer, folgt sie ihm: die Mappe prueft,
-- dass die Reservierung jetzt im Zimmer der Karte steht.
--
-- **Fehlversuche in der Datenbank und je Zimmer**, nicht im Speicher je
-- Herkunft: im Hotel-WLAN teilen sich alle Gaeste eine Adresse, und im
-- Mobilnetz wechselt sie. Was durchprobiert wird, ist ein Zimmer.
--
-- Diese Nummer folgt auf 0145 (Uebersetzung in alle Sprachen der Mappe) und
-- 0146 (Sprachen im ganzen System), die in anderen Zweigen entstehen.
-- ---------------------------------------------------------------------------

CREATE TABLE guest_folder_session (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  reservation_id bigint NOT NULL REFERENCES reservation(id),
  -- SHA-256 des Cookies, nie der Wert -- wie checkin_token (0061).
  token_hash     text NOT NULL UNIQUE,
  -- room: am Zimmer mit Nachname oder PLZ; mail: ueber den Link zum
  -- Online-Check-in, der schon an genau diesen Aufenthalt gebunden ist.
  channel        text NOT NULL CHECK (channel IN ('room', 'mail')),
  -- Ein Kalendertag, gegen den Geschaeftstag geprueft: der Abreisetag.
  expires_on     date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  -- Leer, wenn der Gast sich selbst abgemeldet hat.
  revoked_by     bigint REFERENCES app_user(id)
);
CREATE INDEX guest_folder_session_reservation ON guest_folder_session (reservation_id);

CREATE TABLE guest_folder_unlock_failure (
  resource_id     bigint PRIMARY KEY REFERENCES resource(id),
  property_id     bigint NOT NULL REFERENCES property(id),
  failures        integer NOT NULL DEFAULT 0,
  window_start    timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guest_folder_session','guest_folder_unlock_failure'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

-- Wer wann freigeschaltet und wer aufgehoben hat, soll nachzulesen sein.
-- Der Zaehler nicht: er aendert sich mit jedem Tippfehler und sagt nichts,
-- was jemand spaeter wissen muesste.
SELECT attach_audit('guest_folder_session');

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('guest_folder_session', 'token_hash', 'Geheimnis: Hash der Freischaltung eines Telefons');

-- Wie bei checkin_token: aufheben ja, sonst nichts. Ein UPDATE auf
-- expires_on oder reservation_id verlaengerte eine Freischaltung oder haengte
-- sie an einen fremden Aufenthalt. Geloescht wird ueber die Loeschfunktionen
-- des Gastes und das Aufraeumen des Workers, beide als Eigentuemerin.
REVOKE UPDATE, DELETE ON guest_folder_session FROM hotelpms_app;
GRANT UPDATE (revoked_at, revoked_by) ON guest_folder_session TO hotelpms_app;

-- ---------------------------------------------------------------------------
-- Loeschung (CLAUDE.md: was zu einem Gast gehoert, wird an einer Stelle
-- geloescht). Beide Funktionen von Stand 0129 aus neu gefasst, mit dem
-- Suchpfad aus 0133; wer sie das naechste Mal neu fasst, geht von hier aus.
-- ---------------------------------------------------------------------------

/** Freischaltungen an den Reservierungen des Gastes. Keine Frist haelt sie. */
CREATE OR REPLACE FUNCTION guest_folder_sessions_erase(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM guest_folder_session s
   USING reservation r
   WHERE r.id = s.reservation_id AND r.primary_guest_id = p_guest;
$$;

REVOKE EXECUTE ON FUNCTION guest_folder_sessions_erase(bigint)
  FROM PUBLIC, hotelpms_app, hotelpms_readonly;

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
