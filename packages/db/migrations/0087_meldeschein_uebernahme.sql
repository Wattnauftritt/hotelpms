-- ---------------------------------------------------------------------------
-- 0087 -- Fertige Meldescheine aus einem Umsystem uebernehmen.
--
-- Anforderung: Sven, 04.10.2026. Bis zur Umstellung hat das Adminpanel die
-- Meldescheine eingesammelt; fuer Gaeste, die noch im Haus sind oder kommen,
-- liegen sie dort ausgefuellt und teils unterschrieben. Schaltet StayGrid um,
-- muss die Rezeption sie hier sehen, sonst fragt sie den Gast ein zweites Mal.
--
-- Der Schein bleibt eine Zeile in `registration`, mit derselben Frist und
-- derselben Loeschung (`guest_erase_one`). Eine eigene Tabelle fuer
-- uebernommene Scheine waere eine zweite Stelle, die die Loeschung kennen
-- muesste -- genau die Bauart, die einmal eine Unterschrift hat ueberleben
-- lassen (Migration 0046).
-- ---------------------------------------------------------------------------

ALTER TABLE registration DROP CONSTRAINT registration_source_check;
ALTER TABLE registration ADD CONSTRAINT registration_source_check
  CHECK (source IN ('desk','online','terminal','import'));

-- Woher und wann. `created_at` ist der Zeitpunkt der Uebernahme; ausgefuellt
-- hat der Gast frueher, und das ist der Zeitpunkt, den die Rezeption sieht.
ALTER TABLE registration
  ADD COLUMN external_system    text,
  ADD COLUMN external_reference text,
  ADD COLUMN completed_at       timestamptz,
  -- Schon an die Meldebehoerde (AVS) uebermittelt. Ein uebermittelter Schein
  -- ist endgueltig; der Export von StayGrid ueberspringt ihn, sonst stuende
  -- der Gast dort zweimal.
  ADD COLUMN avs_reported_at    timestamptz,
  ADD CONSTRAINT registration_import_origin
    CHECK (source <> 'import' OR external_system IS NOT NULL);

/*
 * Die Kennung im Umsystem fuehrt dort zu einem Menschen, wie der Verweis in
 * `guest.contact_origin` (0083). Ins Protokoll gehoert sie deshalb nicht.
 * Systemname und Zeitpunkte bezeichnen niemanden.
 */
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('registration', 'external_reference', 'Verweis auf den Meldeschein im Umsystem')
ON CONFLICT DO NOTHING;

/*
 * Ein eigenes Recht, enger als `reservation:checkin` und weiter als
 * `guest:contact_write`: es setzt Geburtsdatum und Staatsangehoerigkeit und
 * legt Mitreisende an. Keiner Rolle zugeordnet, es ist fuer Maschinenzugaenge.
 */
INSERT INTO permission (key, grp, description) VALUES
  ('registration:import', 'Gaeste', 'Fertige Meldescheine aus einem Umsystem uebernehmen')
ON CONFLICT DO NOTHING;
