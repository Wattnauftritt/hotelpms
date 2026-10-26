-- ---------------------------------------------------------------------------
-- 0214 -- Die Mailadresse, mit der eine Buchung kam, gilt fuer diese Buchung.
--
-- Anforderung: Sven, 26.10.2026 (Thread "Aktuelle Booking-
-- Weiterleitungsadresse je Buchung"). Booking.com vergibt dem Gast fuer jede
-- Buchung eine neue Adresse unter `guest.booking.com`. Bucht ein Gast ein
-- zweites Mal, haengt die Rezeption die neue Reservierung an sein
-- vorhandenes Profil, und StayGrid schrieb den Link zum Meldeformular an die
-- Adresse aus dem Profil -- die vom letzten Aufenthalt. Booking nimmt sie
-- an und stellt nichts mehr zu; im Versand steht "Zugestellt". Sven dazu:
-- generell gilt fuer eine neue Buchung die Adresse, mit der sie kam, nicht
-- die aus dem bestehenden Gastkontakt.
--
-- Ursache: Die Mailadresse gab es nur am Gastprofil (0083). Ein Profil ist
-- ein Mensch ueber viele Aufenthalte; die Adresse aus der Buchung gehoert zu
-- diesem einen. Der Gastkontakt aus dem Umsystem konnte die neue Adresse
-- ausserdem gar nicht setzen, wenn die alte nicht von ihm stammte
-- (`kept_existing`).
--
-- Deshalb:
--   - `reservation.booking_email`: die Adresse, die Kanal oder Umsystem fuer
--     genau diese Buchung melden. Sie ersetzt sich mit jeder Meldung. Eine
--     echte Adresse geht fuer diese Reservierung dem Profil vor; eine
--     Weiterleitung des Portals nur einer Weiterleitung, denn die private
--     Adresse des Gastes ist direkter (Sven).
--   - `guest_mail_address(gast, reservierung)`: die Adresse, an die Gastpost
--     zu dieser Reservierung geht. Jede Stelle, die einem Gast schreibt,
--     fragt hier und nicht `guest.email`.
--   - `email_is_channel_relay()`: eine Weiterleitungsadresse im Profil eines
--     Stammgastes stammt aus irgendeiner frueheren Buchung und taugt fuer
--     keine bestimmte.
--   - Die Spalte ist personenbezogen: `audit_redaction`, und beide
--     Loeschfunktionen leeren sie.
-- ---------------------------------------------------------------------------

/*
 * Dieselbe Liste wie `isChannelRelayAddress` in packages/domain/src/email.ts;
 * aendern nur beide zusammen.
 */
CREATE OR REPLACE FUNCTION email_is_channel_relay(p_email text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_email IS NOT NULL
     AND lower(substr(btrim(p_email), strpos(btrim(p_email), '@') + 1))
         = ANY (ARRAY['guest.booking.com']);
$$;

ALTER TABLE reservation
  ADD COLUMN booking_email text
    CHECK (booking_email IS NULL OR length(booking_email) BETWEEN 3 AND 320);

COMMENT ON COLUMN reservation.booking_email IS
  'Mailadresse, mit der diese Buchung kam (0214); Gastpost ueber guest_mail_address()';

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('reservation', 'booking_email', 'Mailadresse des Gastes aus dieser Buchung')
ON CONFLICT DO NOTHING;

/*
 * An welche Adresse Gastpost zu dieser Reservierung geht.
 *
 * Der Reihe nach (Sven, 26.10.2026):
 *   1. Die Adresse, mit der diese Buchung kam, wenn sie eine echte ist: sie
 *      ist die neueste, die es von diesem Gast gibt.
 *   2. Eine echte Adresse im Profil. Bringt die Buchung nur eine
 *      Weiterleitung des Portals mit, ist die private Adresse direkter; sie
 *      kommt ohne Absenderfreigabe und ohne Linkfilter des Portals an. Das
 *      Profil ist der Hauptgast dieser Reservierung, also derselbe Mensch:
 *      die Rezeption hat ihn bewusst angehaengt, und ein Umsystem schreibt
 *      nur in ein eigenes Profil je Aufenthalt (0107).
 *   3. Die Weiterleitung dieser Buchung.
 *   4. Eine Weiterleitung im Profil nur, solange das Profil an keiner
 *      anderen Reservierung haengt. Haengt es, stammt sie womoeglich aus der
 *      alten Buchung, und Post dorthin verschwindet still. Dann lieber keine
 *      Adresse: die Einladung wartet, bis die richtige da ist, und die
 *      Rezeption sieht, dass keine hinterlegt ist.
 *   Die Adresse der Buchung gilt nur fuer ihren Hauptgast; ein
 *   Rechnungsempfaenger aus einer anderen Reservierung ist ein anderer Mensch.
 *
 * SECURITY INVOKER: die Zeilenrichtlinie gilt wie bei jeder anderen Abfrage.
 */
CREATE OR REPLACE FUNCTION guest_mail_address(p_guest bigint, p_reservation bigint)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN r.primary_guest_id = g.id AND r.booking_email IS NOT NULL
                AND NOT email_is_channel_relay(r.booking_email) THEN r.booking_email
           WHEN g.email IS NOT NULL AND NOT email_is_channel_relay(g.email) THEN g.email
           WHEN r.primary_guest_id = g.id AND r.booking_email IS NOT NULL THEN r.booking_email
           WHEN g.email IS NULL THEN NULL
           WHEN r.id IS NULL THEN g.email
           WHEN guest_is_shared(g.id, r.id) THEN NULL
           ELSE g.email
         END
    FROM guest g
    LEFT JOIN reservation r ON r.id = p_reservation
   WHERE g.id = p_guest;
$$;

/** Die Mailadressen aus den Buchungen des Gastes. */
CREATE OR REPLACE FUNCTION reservation_booking_email_erase(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE reservation SET booking_email = NULL
   WHERE primary_guest_id = p_guest AND booking_email IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION reservation_booking_email_erase(bigint)
  FROM PUBLIC, hotelpms_app, hotelpms_readonly;

-- ---------------------------------------------------------------------------
-- Loeschung: beide Funktionen von Stand 0153 aus neu gefasst; wer sie das
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
  -- Seit 0214: die Mailadressen aus seinen Buchungen.
  PERFORM reservation_booking_email_erase(p_guest);

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
  -- Seit 0214: die Adresse aus der Buchung braucht der Meldeschein so wenig
  -- wie die Mailadresse im Profil.
  PERFORM reservation_booking_email_erase(p_guest);
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
