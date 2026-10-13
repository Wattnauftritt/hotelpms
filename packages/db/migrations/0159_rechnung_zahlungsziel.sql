-- Zahlungsziel an der Rechnung (Sven, 13.10.2026; Pruefung Rechnungssystem,
-- Befund 4).
--
-- Firmengaeste zahlen auf Rechnung, und die Rechnung sagte nicht, bis wann.
-- Das Zahlungsziel stand nur an der Firma (`company.payment_terms_days`)
-- und wirkte allein in der Rechnungsmail. Ohne Faelligkeit (BT-9) oder
-- Zahlungsbedingung (BT-20) weist der Validator jede Rechnung mit offenem
-- Betrag ab (BR-CO-25).
--
-- **An der Rechnung, nicht abgeleitet.** Die Faelligkeit wird beim
-- Festschreiben bestimmt und bleibt: aendert die Firma spaeter ihr Ziel,
-- aendert das keine ausgestellte Rechnung (wie Aussteller und Empfaenger,
-- B6 in Dokument 13). `invoice` ist append-only; die Spalte wird beim
-- Einfuegen gesetzt und nie danach.
ALTER TABLE invoice ADD COLUMN due_on date;
ALTER TABLE invoice ADD CONSTRAINT invoice_due_on_after_issue
  CHECK (due_on IS NULL OR due_on >= issued_on);

-- Vorgabe des Hauses fuer Gaeste ohne Firma. Eine Firma bringt ihr eigenes
-- Ziel mit; im Rechnungsdialog laesst sich beides je Rechnung aendern.
ALTER TABLE property ADD COLUMN payment_terms_days integer NOT NULL DEFAULT 14
  CHECK (payment_terms_days BETWEEN 0 AND 365);
