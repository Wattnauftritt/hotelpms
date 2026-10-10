-- ---------------------------------------------------------------------------
-- 0123 -- Telefonnummer fuer den Aufenthalt am Meldeschein.
--
-- Anforderung: Sven, 10.10.2026. Das Meldeformular fragte keine Nummer ab,
-- das des Adminpanels schon. Und die Nummer aus der Buchung ist oft das
-- Festnetz zu Hause -- im Urlaub erreicht man den Gast ueber das Handy,
-- und das traegt er sinnvollerweise im Formular ein.
--
-- **Am Meldeschein, nicht im Gastprofil.** Die Gastseite laeuft ohne
-- Anmeldung; ueber sie soll niemand die Kontaktdaten eines Profils
-- umbiegen koennen (Dokument 30). Die Nummer gilt fuer diesen Aufenthalt
-- und steht an der Reservierung neben der aus dem Profil. Nur ein leeres
-- Profiltelefon wird mit ihr gefuellt (Route, nicht hier).
--
-- Mit dem Schein geht sie: ein Jahr nach Abreise (§ 30 Abs. 4 BMG) und bei
-- der Loeschung des Gastes (guest_erase_one, guest_erase_partial loeschen
-- den Schein). Nur am Hauptschein, wie die Ankunftszeit (0099).
-- ---------------------------------------------------------------------------

ALTER TABLE registration
  ADD COLUMN stay_phone text
    CHECK (stay_phone IS NULL
           OR (length(stay_phone) BETWEEN 1 AND 50 AND stay_phone = btrim(stay_phone))),
  ADD CONSTRAINT registration_stay_phone_haupt
    CHECK (stay_phone IS NULL OR group_registration_id IS NULL);

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('registration', 'stay_phone', 'Telefonnummer, bezeichnet einen Menschen')
ON CONFLICT DO NOTHING;
