-- ---------------------------------------------------------------------------
-- Die Loeschung erreicht alles, was zum Gast gehoert (Befund 5 und 7, Dok 24).
--
-- Befund 5. `guest_agreement` traegt guest_id und signature_svg -- die
-- Unterschrift unter die Hausbedingungen. Die Loeschroutine erwaehnte die
-- Tabelle nicht. Nach der Loeschung stand die Unterschrift weiter da,
-- verknuepft mit einem Profil, das jetzt "Anonymisiert" heisst -- die
-- Unterschrift traegt den Namen aber selbst.
--
-- Befund 7. `email_redact_old` entfernt Empfaenger und Rumpf nach 90 Tagen.
-- Die Regel ist richtig, haengt aber allein am Alter. Verlangte ein Gast
-- heute Loeschung, blieben Name, Adresse und der vollstaendige Rechnungstext
-- bis zu 90 Tage in `outbound_email` stehen.
--
-- Mitbehoben: der Satz zu loeschender Tabellen stand an **drei** Stellen --
-- zweimal in der Route (sofort und aufgeschoben) und einmal im Nachtlauf.
-- Genau deshalb hat die Einwilligung gefehlt: wer eine Tabelle ergaenzt, muss
-- an drei Orte denken. Ab hier gibt es eine Funktion, und die Route ruft sie.
-- ---------------------------------------------------------------------------

/**
 * Alles entfernen, was einen Gast bezeichnet -- ausser dem, was ein Beleg
 * braucht.
 *
 * Eine Stelle, nicht drei. Die Route ruft sie fuer den Sofortfall, der
 * Nachtlauf fuer den aufgeschobenen; der Unterschied liegt in der Frist, die
 * davor geprueft wird, nicht im Umfang.
 *
 * SECURITY DEFINER, weil die Post ueber alle Haeuser des Accounts laeuft,
 * der Aufrufer aber nur eines sieht. Die Grenze bleibt der Gast: die
 * Funktion fasst nur an, was an ihm haengt, und `app_account_ids()` haelt
 * fremde Accounts heraus.
 */
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
  DELETE FROM registration        WHERE guest_id = p_guest;

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

  UPDATE guest
     SET last_name = 'Anonymisiert', first_name = NULL, email = NULL, phone = NULL,
         birth_date = NULL, nationality = NULL, address_line1 = NULL,
         postal_code = NULL, city = NULL, country = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         status = 'anonymized', anonymized_at = now(), updated_at = now()
   WHERE id = p_guest;
END $$;

COMMENT ON FUNCTION guest_erase_one(bigint) IS
  'Loeschung eines Gastes nach Art. 17, vollstaendig. Eine Stelle fuer Route und Nachtlauf.';

/**
 * Die aufgeschobene Loeschung: alles ausser Name und Anschrift.
 *
 * Steht eine Aufbewahrungsfrist entgegen -- der Gaestebeitragsnachweis fuehrt
 * Name und Anschrift --, faellt sofort, was der Nachweis nicht braucht. Der
 * Rest faellt im Nachtlauf ueber `guest_erase_one`, sobald die Frist ablaeuft.
 *
 * Auch das eine Funktion und keine Folge von Anweisungen in der Route: hier
 * lag der Fehler aus Befund 5. Und sie muss SECURITY DEFINER sein, weil die
 * Anwendungsrolle auf `guest_agreement` kein UPDATE hat -- richtig so, das
 * ist ein Nachweis. Die Unterschrift zu entfernen ist kein Aendern des
 * Nachweises, sondern das Entfernen eines Kennzeichens daraus.
 */
CREATE OR REPLACE FUNCTION guest_erase_partial(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM guest
                  WHERE id = p_guest AND account_id = ANY (app_account_ids())) THEN
    RETURN;
  END IF;

  DELETE FROM guest_property_note WHERE guest_id = p_guest;
  DELETE FROM registration        WHERE guest_id = p_guest;
  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  UPDATE guest
     SET email = NULL, phone = NULL, birth_date = NULL, nationality = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         erasure_requested_at = COALESCE(erasure_requested_at, now()),
         updated_at = now()
   WHERE id = p_guest;
END $$;

COMMENT ON FUNCTION guest_erase_partial(bigint) IS
  'Aufgeschobene Loeschung: alles ausser dem, was eine Aufbewahrungsfrist haelt.';

-- Der Nachtlauf benutzt ab hier dieselbe Funktion.
CREATE OR REPLACE FUNCTION guest_erasure_complete()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer := 0; r record;
BEGIN
  FOR r IN
    SELECT g.id FROM guest g
     WHERE g.account_id = ANY (app_account_ids())
       AND g.erasure_requested_at IS NOT NULL
       AND g.status <> 'anonymized'
       AND guest_levy_retention_until(g.id) IS NULL
  LOOP
    PERFORM guest_erase_one(r.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION guest_erasure_complete() IS
  'Loeschungen vollenden, die eine Aufbewahrungsfrist aufgeschoben hat.';
