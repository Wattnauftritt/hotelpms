-- Stornorechnung (Pruefung Rechnungssystem 13.10.2026, Befund 2).
--
-- Eine ausgestellte Rechnung liess sich nicht berichtigen. Schema, PDF-Titel
-- und XML-Typ 381 waren vorbereitet, eine Route gab es nicht. Bei zu hoch
-- ausgewiesener Steuer schuldet das Haus sie nach § 14c UStG, bis
-- berichtigt ist -- und berichtigen ging nicht.
--
-- Die Stornorechnung (`invoice.kind = 'credit_note'`, `reverses_id` auf das
-- Original) hebt das Original ganz auf. Ihre Positionen sind Gegenbuchungen
-- der Originalpositionen; daneben entsteht je Position eine neue, offene
-- Buchung, damit die richtige Rechnung danach wie jede andere entsteht.

-- Eine Rechnung wird hoechstens einmal storniert. Die Pruefung in der Route
-- laeuft unter der Sperre des Folios; das hier ist der Schutz, der auch
-- dann haelt, wenn jemand sie vergisst.
CREATE UNIQUE INDEX invoice_reversed_once ON invoice (reverses_id)
  WHERE reverses_id IS NOT NULL;

-- Nur eine Stornorechnung verweist auf ein Original, und nur sie muss es.
-- NOT VALID: bis hierher nahm die Route `kind: 'credit_note'` ungeprueft an,
-- und eine so entstandene Zeile laesst sich nicht mehr aendern. Sie soll
-- den Aufbau nicht anhalten; jede neue Zeile wird geprueft.
ALTER TABLE invoice ADD CONSTRAINT invoice_credit_note_reverses
  CHECK ((kind = 'credit_note') = (reverses_id IS NOT NULL)) NOT VALID;

-- Anzahlungen: die Stornierung einer Schlussrechnung hebt auch deren
-- Verrechnung auf ('unapplied', verweist auf die Stornorechnung). Die
-- Anzahlung ist danach wieder offen und geht in die naechste
-- Schlussrechnung ein. Die Sperre "einmal verrechnet" gilt deshalb je
-- Schlussrechnung, nicht je Anzahlung; dass sie nicht zweimal zugleich
-- verrechnet ist, haelt die Sperre des Folios beim Festschreiben.
ALTER TABLE deposit_ledger DROP CONSTRAINT deposit_ledger_kind_check;
ALTER TABLE deposit_ledger ADD CONSTRAINT deposit_ledger_kind_check
  CHECK (kind IN ('received','applied','unapplied'));
ALTER TABLE deposit_ledger DROP CONSTRAINT deposit_ledger_shape;
ALTER TABLE deposit_ledger ADD CONSTRAINT deposit_ledger_shape CHECK (
  (kind = 'received' AND settlement_id IS NOT NULL AND applied_invoice_id IS NULL) OR
  (kind IN ('applied','unapplied') AND settlement_id IS NULL
                                    AND applied_invoice_id IS NOT NULL)
);

DROP INDEX deposit_ledger_applied_once;
CREATE UNIQUE INDEX deposit_ledger_applied_once
  ON deposit_ledger (deposit_invoice_id, tax_rate_bp, applied_invoice_id)
  WHERE kind = 'applied';
CREATE UNIQUE INDEX deposit_ledger_unapplied_once
  ON deposit_ledger (deposit_invoice_id, tax_rate_bp, applied_invoice_id)
  WHERE kind = 'unapplied';
