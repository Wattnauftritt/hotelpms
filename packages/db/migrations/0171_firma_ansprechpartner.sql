-- Ansprechpartner in der Firmenanschrift (Sven, 14.10.2026: "bei Rechnungen
-- fehlt in der Firmenanschrift ein Feld fuer den Namen des Ansprechpartners").
--
--   Musterfirma
--   Herr Max Mustermann
--   Musterstrasse 34
--   12345 Berlin
--
-- Die zweite Zeile ist die, ohne die eine Rechnung in einer grossen Firma
-- in der Poststelle liegen bleibt. Im XML ist sie BT-56 (Kontakt des
-- Erwerbers), auf dem Blatt die Zeile unter dem Firmennamen.

ALTER TABLE company ADD COLUMN contact_name text;
ALTER TABLE company ADD CONSTRAINT company_contact_name
  CHECK (contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 200);

-- 0044 hat `company` bewusst nicht redigiert: ihre Felder bezeichnen eine
-- juristische Person. Der Ansprechpartner ist der eine, der einen Menschen
-- bezeichnet, und gehoert deshalb nicht ins Protokoll (CLAUDE.md).
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('company', 'contact_name', 'Name')
ON CONFLICT DO NOTHING;
