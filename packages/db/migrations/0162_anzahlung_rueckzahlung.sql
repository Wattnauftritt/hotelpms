-- Rueckzahlung einer Anzahlung (Pruefung Rechnungssystem 13.10.2026, Mittel).
--
-- Reiste ein Gast frueher ab, als er angezahlt hatte, wies die Schluss-
-- rechnung sich selbst ab: die Anzahlung ueberstieg die Leistungen, und
-- eine Rechnung ueber einen negativen Betrag ist das falsche Papier. Einen
-- anderen Weg gab es nicht, und die Steuer auf das zurueckgezahlte Geld
-- blieb auf der Anzahlungsrechnung ausgewiesen -- nach § 14c UStG schuldet
-- das Haus sie, bis berichtigt ist.
--
-- Die Rueckzahlung ist deshalb ein eigener Beleg: eine Rechnungskorrektur
-- zur Anzahlungsrechnung (`kind = 'credit_note'`, `reverses_id` auf die
-- Anzahlungsrechnung, `partial_reversal`), ueber den zurueckgezahlten Teil
-- zu dem Satz, zu dem er versteuert wurde. Daneben im Anzahlungsjournal
-- eine Zeile 'refunded' und am Folio der Zahlungsvermerk der Auszahlung.

-- Eine Anzahlung kann in mehreren Schritten zurueckgehen. "Einmal
-- storniert" gilt deshalb nur fuer die vollstaendige Stornierung.
ALTER TABLE invoice ADD COLUMN partial_reversal boolean NOT NULL DEFAULT false;
DROP INDEX invoice_reversed_once;
CREATE UNIQUE INDEX invoice_reversed_once ON invoice (reverses_id)
  WHERE reverses_id IS NOT NULL AND NOT partial_reversal;
-- Teilweise aufheben laesst sich nur eine Anzahlungsrechnung, und das nur
-- mit einer Korrektur; die Route prueft das Ziel, das hier die Form.
ALTER TABLE invoice ADD CONSTRAINT invoice_partial_reversal
  CHECK (NOT partial_reversal OR kind = 'credit_note');

ALTER TABLE deposit_ledger DROP CONSTRAINT deposit_ledger_kind_check;
ALTER TABLE deposit_ledger ADD CONSTRAINT deposit_ledger_kind_check
  CHECK (kind IN ('received','applied','unapplied','refunded'));
-- 'refunded': der Zahlungsvermerk der Auszahlung und die Korrektur, die
-- die Steuer berichtigt -- beides muss es geben. Je Vermerk und Satz eine
-- Zeile haelt schon deposit_ledger_settlement_once (0029).
ALTER TABLE deposit_ledger DROP CONSTRAINT deposit_ledger_shape;
ALTER TABLE deposit_ledger ADD CONSTRAINT deposit_ledger_shape CHECK (
  (kind = 'received' AND settlement_id IS NOT NULL AND applied_invoice_id IS NULL) OR
  (kind IN ('applied','unapplied') AND settlement_id IS NULL
                                    AND applied_invoice_id IS NOT NULL) OR
  (kind = 'refunded' AND settlement_id IS NOT NULL AND applied_invoice_id IS NOT NULL)
);
