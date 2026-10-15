-- Kontoinhaber und Webseite fuer den Fuss der Rechnung (Sven, 15.10.2026:
-- Vergleich mit der Rechnung aus Lexoffice, "dort sieht die rechnung anders
-- aus vom optischen aufbau und dem inhalt der fusszeile").
--
-- Kontoinhaber: das Konto eines Einzelunternehmens laeuft auf den Inhaber,
-- nicht auf den Namen des Hotels. Bisher stand als Empfaenger der
-- Ueberweisung der Name des Hauses -- in der Rechnungsmail, im XML (BT-85)
-- und damit im Ueberweisungsformular des Gastes. Weicht er vom Namen des
-- Kontos ab, meldet die Bank des Zahlers seit der Empfaengerueberpruefung
-- (VoP, Oktober 2025) "Name stimmt nicht ueberein", und mancher Gast bricht
-- die Zahlung dort ab.
--
-- Beide landen wie Bank und Kontakt in der Momentaufnahme der Rechnung (0164).

ALTER TABLE property
  ADD COLUMN bank_account_holder text,
  ADD COLUMN invoice_website     text;

-- Der Kontoinhaber ist bei einem Einzelunternehmen ein Mensch. Das
-- Protokoll braucht den Namen nicht, um eine Aenderung nachzuvollziehen
-- (CLAUDE.md, Migration 0044).
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('property', 'bank_account_holder', 'Name')
ON CONFLICT DO NOTHING;
