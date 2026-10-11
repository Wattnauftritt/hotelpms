-- ---------------------------------------------------------------------------
-- 0129 -- Loeschung erreicht Notizen und Fehlertexte, Geheimnisse fallen aus
-- dem Pruefprotokoll.
--
-- Befunde M6, M7 und N11 aus dem Sicherheitsaudit vom 11.10.2026
-- (security/audit-2026-10-11.md).
--
-- M6: guest_erase_one() und guest_erase_partial() liessen reservation.notes
-- und short_note stehen. Dokument 26 (Befund 4) nennt genau dieses Feld als
-- Ort fuer Gesundheitsdaten ("Sauerstoffgeraet"); behoben wurde damals nur die
-- Kopie im Protokoll, nicht der Wert selbst. Eine Notiz ist kein Buchungsbeleg,
-- keine Frist haelt sie -- sie faellt deshalb auch bei der aufgeschobenen
-- Loeschung sofort.
--
-- N11: Der Versand schreibt die Antwort des Anbieters in last_error und in
-- outbound_email_attempt.error, und die nennt die Empfaengeradresse. Weder
-- die Loeschung noch email_redact_old() leerten diese Spalten, und
-- guest_erase_partial() fasste die Gastpost gar nicht an.
--
-- M7: webhook_subscription.signing_secret stand im Klartext im Pruefprotokoll
-- -- zehn Jahre, in jedem Backup, und wer es liest, faelscht Webhooks an das
-- Adminpanel. Die Hashes von Kanal- und OAuth-Zugang kommen aus demselben
-- Grund dazu: ein Geheimnis gehoert nicht ins Protokoll, auch nicht gehasht.
--
-- Beide Loeschfunktionen neu gefasst von Stand 0128 aus. Wer sie das naechste
-- Mal neu fasst, geht von dieser Fassung aus.
-- ---------------------------------------------------------------------------

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('webhook_subscription', 'signing_secret', 'Signiergeheimnis eines Webhooks'),
  ('channel_connection',   'token_hash',     'Hash eines Kanalzugangs, Geheimnis'),
  ('oauth_client',         'secret_hash',    'Hash eines Client-Geheimnisses')
ON CONFLICT DO NOTHING;

-- Die bereits geschriebenen Kopien, wie in 0044: der Append-only-Trigger wird
-- fuer genau diese Anweisung ausgesetzt, an der Elterntabelle und an jeder
-- Partition, und in derselben Transaktion wieder scharf geschaltet.
DO $$
DECLARE
  p regclass;
  t text;
  cols text[];
BEGIN
  FOR p IN SELECT 'audit_log'::regclass
           UNION ALL
           SELECT inhrelid::regclass FROM pg_inherits
            WHERE inhparent = 'audit_log'::regclass LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER trg_append_only', p);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['webhook_subscription', 'channel_connection', 'oauth_client'] LOOP
    SELECT array_agg(column_name) INTO cols FROM audit_redaction WHERE table_name = t;
    UPDATE audit_log SET changed = audit_redact(changed, cols)
     WHERE table_name = t AND changed IS NOT NULL AND changed ?| cols;
  END LOOP;

  FOR p IN SELECT 'audit_log'::regclass
           UNION ALL
           SELECT inhrelid::regclass FROM pg_inherits
            WHERE inhparent = 'audit_log'::regclass LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER trg_append_only', p);
  END LOOP;
END $$;

/**
 * Die Gastpost eines Gastes schwaerzen, unabhaengig vom Alter. Derselbe
 * Marker wie in email_redact_old(), damit beide Wege dasselbe Ergebnis
 * hinterlassen. Eine Funktion, weil beide Loeschwege sie brauchen und eine
 * zweite Abschrift genau die Spalte vergessen haette, um die es hier geht.
 */
CREATE OR REPLACE FUNCTION guest_email_redact(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH betroffen AS (
    UPDATE outbound_email e
       SET to_email = 'entfernt@invalid', to_name = NULL,
           body_text = '', body_html = NULL, last_error = NULL,
           redacted_at = COALESCE(e.redacted_at, now())
     WHERE (e.redacted_at IS NULL OR e.last_error IS NOT NULL)
       AND (EXISTS (SELECT 1 FROM reservation r
                     WHERE r.id = e.reservation_id AND r.primary_guest_id = p_guest)
            OR EXISTS (SELECT 1 FROM invoice i
                         JOIN folio f ON f.id = i.folio_id
                         JOIN reservation r2 ON r2.id = f.reservation_id
                        WHERE i.id = e.invoice_id AND r2.primary_guest_id = p_guest))
    RETURNING e.id
  )
  UPDATE outbound_email_attempt a SET error = NULL
    FROM betroffen b
   WHERE a.email_id = b.id AND a.error IS NOT NULL;
$$;


/** Notizen an den Reservierungen des Gastes. Keine Frist haelt sie. */
CREATE OR REPLACE FUNCTION guest_notes_erase(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE reservation SET notes = NULL, short_note = NULL
   WHERE primary_guest_id = p_guest
     AND (notes IS NOT NULL OR short_note IS NOT NULL);
$$;

/*
 * Die Hilfsfunktionen pruefen keinen Kontext; das tun die beiden
 * Loeschfunktionen davor. Die Voreinstellung (pg_default_acl) gibt jeder
 * neuen Funktion EXECUTE fuer die Anwendung -- ein REVOKE von PUBLIC allein
 * nimmt es ihr nicht, wie 0128 bei guest_registration_purge_expired()
 * angenommen hatte. Aufgerufen werden sie nur aus SECURITY-DEFINER-Code.
 */
REVOKE EXECUTE ON FUNCTION guest_email_redact(bigint),
                           guest_notes_erase(bigint),
                           guest_registration_purge_expired(bigint)
  FROM PUBLIC, hotelpms_app, hotelpms_readonly;

CREATE OR REPLACE FUNCTION guest_erase_one(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

-- email_redact_old() von Stand 0028 aus: dieselbe Schwaerzung, jetzt mit den
-- Fehlertexten. Die Versuchszeilen haengen an der Mail und fallen mit ihr.
CREATE OR REPLACE FUNCTION email_redact_old(p_property_id bigint, p_days integer DEFAULT 90)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  PERFORM assert_property_in_context(p_property_id);

  WITH betroffen AS (
    UPDATE outbound_email
       SET to_email = 'entfernt@invalid',
           to_name = NULL,
           body_text = '',
           body_html = NULL,
           last_error = NULL,
           redacted_at = now()
     WHERE property_id = p_property_id
       AND redacted_at IS NULL
       AND status <> 'pending'
       AND created_at < now() - make_interval(days => p_days)
    RETURNING id
  ), versuche AS (
    UPDATE outbound_email_attempt a SET error = NULL
      FROM betroffen b
     WHERE a.email_id = b.id AND a.error IS NOT NULL
  )
  SELECT count(*) INTO v_count FROM betroffen;

  RETURN v_count;
END $$;

-- Was vor dieser Migration geschwaerzt wurde, traegt die Fehlertexte noch.
UPDATE outbound_email SET last_error = NULL
 WHERE redacted_at IS NOT NULL AND last_error IS NOT NULL;
UPDATE outbound_email_attempt a SET error = NULL
  FROM outbound_email e
 WHERE e.id = a.email_id AND e.redacted_at IS NOT NULL AND a.error IS NOT NULL;
