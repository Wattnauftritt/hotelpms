-- ---------------------------------------------------------------------------
-- 0128 -- Loeschantrag haelt die Meldescheinfrist ein.
--
-- Befund H5 aus dem Sicherheitsaudit vom 11.10.2026
-- (security/audit-2026-10-11.md). guest_erase_one() und
-- guest_erase_partial() loeschten jeden Meldeschein des Gastes sofort:
--
--   DELETE FROM registration WHERE guest_id = p_guest;
--
-- Zwei Fehler in einer Zeile. Der Hauptschein einer Gruppe traegt die Scheine
-- der Mitreisenden (registration_group_registration_id_fkey, NO ACTION); die
-- Anweisung brach dort ab, die Route lieferte 500, und weil die Transaktion
-- auch erasure_requested_at zurueckrollte, ging der Antrag still verloren.
-- Im Nachtlauf brach derselbe Fehler die Schleife fuer den ganzen Account ab.
-- Und ein Meldeschein ist ein Jahr nach der Abreise aufzubewahren
-- (§ 30 Abs. 4 BMG); Art. 17 Abs. 3 lit. b DSGVO nimmt das von der Loeschung
-- aus.
--
-- Svens Entscheidung: Meldescheine bleiben bis destroy_after stehen und
-- fallen dann mit denen der Mitreisenden. Damit wird die Meldescheinfrist zu
-- einer zweiten Aufbewahrungsfrist neben dem Gaestebeitragsnachweis, und sie
-- laeuft durch denselben Weg: jetzt die aufgeschobene Loeschung, der Rest im
-- Nachtlauf. Was der Meldeschein vom Gast braucht -- Geburtsdatum,
-- Staatsangehoerigkeit, bei Auslaendern das Ausweisdokument --, bleibt so
-- lange am Gast; ohne das waere der aufbewahrte Schein leer.
--
-- Beide Loeschfunktionen neu gefasst von Stand 0068 aus. Wer sie das naechste
-- Mal neu fasst, geht von dieser Fassung aus.
-- ---------------------------------------------------------------------------

/**
 * Bis wann ein Meldeschein des Gastes aufzubewahren ist, NULL wenn keiner.
 * Gegen current_date wie der Nachtlauf, der die Scheine vernichtet
 * (purgeRegistrations): beide muessen denselben Tag fuer "abgelaufen" halten.
 */
CREATE OR REPLACE FUNCTION guest_registration_retention_until(p_guest bigint)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max(reg.destroy_after)
    FROM registration reg
    JOIN property p ON p.id = reg.property_id
   WHERE reg.guest_id = p_guest
     AND p.account_id = ANY (app_account_ids())
     AND reg.destroy_after >= current_date;
$$;

/** Die spaetere der beiden Fristen, die eine Loeschung aufschieben. */
CREATE OR REPLACE FUNCTION guest_retention_until(p_guest bigint)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(guest_levy_retention_until(p_guest),
                  guest_registration_retention_until(p_guest));
$$;

COMMENT ON FUNCTION guest_retention_until(bigint) IS
  'Ende der laengsten Aufbewahrung (Gaestebeitrag, Meldeschein), NULL wenn keine.';

/**
 * Abgelaufene Meldescheine des Gastes vernichten, samt der Scheine seiner
 * Mitreisenden. In einer Anweisung: der Fremdschluessel wird an ihrem Ende
 * geprueft, und Haupt- und Mitreisendenschein tragen dieselbe Frist, weil sie
 * an derselben Reservierung haengen.
 */
CREATE OR REPLACE FUNCTION guest_registration_purge_expired(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM registration reg
   WHERE reg.destroy_after < current_date
     AND (reg.guest_id = p_guest
          OR reg.group_registration_id IN (
               SELECT id FROM registration WHERE guest_id = p_guest));
$$;

REVOKE EXECUTE ON FUNCTION guest_registration_purge_expired(bigint) FROM PUBLIC;

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
  -- Seit 0128: nur, was die Meldescheinfrist nicht mehr haelt. Route und
  -- Nachtlauf rufen diese Funktion erst nach Ablauf auf; laeuft sie doch
  -- davor, bleibt der Schein stehen und faellt im Nachtlauf (maintenance.ts).
  PERFORM guest_registration_purge_expired(p_guest);
  -- Seit 0061: die Links zum Online-Check-in.
  DELETE FROM checkin_token t
   USING reservation r
   WHERE r.id = t.reservation_id AND r.primary_guest_id = p_guest;

  -- Die Zeile bleibt: **dass** zugestimmt wurde und wann, ist der Nachweis,
  -- um den es geht. Das Bild der Unterschrift ist es nicht.
  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  -- Gastpost, unabhaengig vom Alter. Derselbe Marker wie in
  -- `email_redact_old`, damit beide Wege dasselbe Ergebnis hinterlassen.
  UPDATE outbound_email e
     SET to_email = 'entfernt@invalid', to_name = NULL,
         body_text = '', body_html = NULL, redacted_at = now()
   WHERE e.redacted_at IS NULL
     AND (EXISTS (SELECT 1 FROM reservation r
                   WHERE r.id = e.reservation_id AND r.primary_guest_id = p_guest)
          OR EXISTS (SELECT 1 FROM invoice i
                       JOIN folio f ON f.id = i.folio_id
                       JOIN reservation r2 ON r2.id = f.reservation_id
                      WHERE i.id = e.invoice_id AND r2.primary_guest_id = p_guest));

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

-- Der Nachtlauf vollendet erst, wenn **keine** Frist mehr haelt. Bis 0128
-- fragte er nur den Gaestebeitrag; mit der Meldescheinfrist haette er einen
-- Schein vor ihrem Ende zum Loeschen gegeben.
CREATE OR REPLACE FUNCTION guest_erasure_complete()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer := 0; r record;
BEGIN
  FOR r IN
    SELECT g.id FROM guest g
     WHERE g.account_id = ANY (app_account_ids())
       AND g.erasure_requested_at IS NOT NULL
       AND g.status <> 'anonymized'
       AND guest_retention_until(g.id) IS NULL
  LOOP
    PERFORM guest_erase_one(r.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
