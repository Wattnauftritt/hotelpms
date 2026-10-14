-- ---------------------------------------------------------------------------
-- 0172 -- Zahlungslink an einer Rechnung.
--
-- Anforderung von Sven, 14.10.2026: reist ein Gast ab, ohne zu zahlen, soll
-- die Rechnung mit Bankverbindung, mit Zahlungslink oder mit beidem
-- hinausgehen. Bisher war das eine Rechnungsmail und eine zweite mit dem
-- Link, und die Zahlung ueber den Link landete nur auf dem Folio: die
-- Rechnung stand in der Liste weiter als offen, obwohl der Saldo null war.
--
-- Ein Link traegt jetzt die Rechnung, auf die er zahlt. Der Webhook setzt
-- damit `settlement.invoice_id` gleich beim Anlegen des Zahlungsvermerks,
-- und die Zahlseite verlangt, was von der Rechnung noch offen ist -- nicht
-- den Betrag von damals, wenn der Gast inzwischen einen Teil ueberwiesen hat.
--
-- Anzahlung oder Rechnung, nie beides: eine Anzahlung geht einer Rechnung
-- voraus, und ein Link, der auf beides zahlte, haette zwei offene Betraege.
-- ---------------------------------------------------------------------------

ALTER TABLE payment_link ADD COLUMN invoice_id bigint REFERENCES invoice(id);
ALTER TABLE payment_link ADD CONSTRAINT payment_link_ein_zweck
  CHECK (deposit_request_id IS NULL OR invoice_id IS NULL);
CREATE INDEX payment_link_invoice ON payment_link (invoice_id)
  WHERE invoice_id IS NOT NULL;
