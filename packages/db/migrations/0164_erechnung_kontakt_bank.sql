-- Kontakt, Bankverbindung, Handelsregister und Leitweg-ID fuer die
-- E-Rechnung (Pruefung Rechnungssystem 13.10.2026, Mittel: "Keine
-- XRechnung bzw. Leitweg-ID, kein Verkaeuferkontakt, ohne USt-IdNr. des
-- Hauses entsteht kein XML").
--
-- Bisher stand auf keiner Rechnung eine Bankverbindung. Eine Firma mit
-- Zahlungsziel musste die IBAN erfragen, und das XML hatte keine
-- Zahlungsanweisung (BG-16), ohne die eine XRechnung gar nicht angenommen
-- wird (BR-DE-1).
--
-- Alles landet in der Momentaufnahme der Rechnung, wie Anschrift und
-- Steuernummer: zieht das Haus zu einer anderen Bank um, bleibt die alte
-- Rechnung bei der alten Verbindung.

ALTER TABLE property
  ADD COLUMN invoice_contact_name text,
  ADD COLUMN invoice_phone        text,
  ADD COLUMN invoice_email        text,
  ADD COLUMN bank_iban            text,
  ADD COLUMN bank_bic             text,
  ADD COLUMN bank_name            text,
  -- BT-30: genuegt BR-CO-26 wie die USt-IdNr. Ein Haus in der Rechtsform
  -- einer GmbH hat sie immer, eine USt-IdNr. nicht unbedingt.
  ADD COLUMN commercial_register  text;

-- Die Pruefsumme der IBAN prueft die Route; hier nur die Form, damit kein
-- Leerzeichen oder Kleinbuchstabe in eine Momentaufnahme geraet.
ALTER TABLE property ADD CONSTRAINT property_bank_iban
  CHECK (bank_iban IS NULL OR bank_iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$');
ALTER TABLE property ADD CONSTRAINT property_bank_bic
  CHECK (bank_bic IS NULL OR bank_bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$');

-- BT-10. Mit ihr wird das XML eine XRechnung; sie gehoert dem Auftraggeber,
-- nicht der einzelnen Rechnung.
ALTER TABLE company ADD COLUMN buyer_reference text;
ALTER TABLE company ADD CONSTRAINT company_buyer_reference
  CHECK (buyer_reference IS NULL OR buyer_reference ~ '^[0-9A-Za-z-]{1,46}$');

-- Ansprechpartner, Telefon und Mail koennen einen Menschen bezeichnen
-- ("Frau Meyer, 0172 ..."). Das Protokoll braucht sie nicht, um eine
-- Aenderung nachzuvollziehen (CLAUDE.md, Migration 0044).
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('property', 'invoice_contact_name', 'Name'),
  ('property', 'invoice_phone',        'Kontaktdatum'),
  ('property', 'invoice_email',        'Kontaktdatum')
ON CONFLICT DO NOTHING;
