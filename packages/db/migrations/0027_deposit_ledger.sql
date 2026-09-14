-- Anzahlungen und ihre Steuerpflicht (Aufgabe 3, Dokument 13 B4).
--
-- Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Steuer einer Anzahlung mit der
-- Vereinnahmung, nicht mit der Leistung. Eine Anzahlung ist deshalb weder
-- eine gebuchte Leistung (charge) noch nur ein Zahlungsvermerk (settlement):
-- sie braucht eine eigene Rechnung mit eigener Nummer und einen eigenen
-- Saldo, unabhaengig vom Gastkonto. Wuerde man sie stattdessen als charge
-- buchen, zaehlte sie doppelt, sobald spaeter die Schlussrechnung entsteht.
--
-- Zwei Ereignisarten je Anzahlungsrechnung:
--   'received' bei der Vereinnahmung: verweist auf den Zahlungsvermerk, der
--              das Geld belegt.
--   'applied'  bei der Verrechnung in einer Schlussrechnung: verweist auf
--              diese Rechnung. Der offene Saldo einer Anzahlungsrechnung ist
--              die Summe der 'received'-Zeilen abzueglich der 'applied'-
--              Zeilen; im Regelfall genau eine von jeder.
CREATE TABLE deposit_ledger (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  folio_id           bigint NOT NULL REFERENCES folio(id),
  deposit_invoice_id bigint NOT NULL REFERENCES invoice(id),
  kind               text NOT NULL CHECK (kind IN ('received','applied')),
  amount_gross_cent  bigint NOT NULL CHECK (amount_gross_cent > 0),
  net_cent           bigint NOT NULL,
  tax_cent           bigint NOT NULL,
  tax_rate_bp        integer NOT NULL,
  business_date      date NOT NULL,
  -- Nur bei 'received' gesetzt: der Zahlungsvermerk, der die Vereinnahmung belegt.
  settlement_id      bigint REFERENCES settlement(id),
  -- Nur bei 'applied' gesetzt: die Schlussrechnung, die die Anzahlung verrechnet.
  applied_invoice_id bigint REFERENCES invoice(id),
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_ledger_sum CHECK (amount_gross_cent = net_cent + tax_cent),
  CONSTRAINT deposit_ledger_shape CHECK (
    (kind = 'received' AND settlement_id IS NOT NULL AND applied_invoice_id IS NULL) OR
    (kind = 'applied' AND settlement_id IS NULL AND applied_invoice_id IS NOT NULL)
  )
);
CREATE INDEX deposit_ledger_folio ON deposit_ledger (folio_id);
CREATE INDEX deposit_ledger_deposit_invoice ON deposit_ledger (deposit_invoice_id);
-- Derselbe Zahlungsvermerk darf nicht zweimal zu einer Anzahlungsrechnung
-- werden: das ist der eigentliche Schutz gegen Doppelverbuchung unter
-- Nebenlaeufigkeit, nicht die Pruefung davor (vgl. Aufgabe 5 und 6).
CREATE UNIQUE INDEX deposit_ledger_settlement_once ON deposit_ledger (settlement_id)
  WHERE settlement_id IS NOT NULL;
-- Dieselbe Anzahlungsrechnung darf nicht zweimal verrechnet werden.
CREATE UNIQUE INDEX deposit_ledger_applied_once ON deposit_ledger (deposit_invoice_id)
  WHERE kind = 'applied';

ALTER TABLE deposit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON deposit_ledger USING (property_id = ANY (app_property_ids()));

-- Haertegrad 1 wie charge und settlement: eine Vereinnahmung oder eine
-- Verrechnung ist eine Tatsache. Falsch verbucht wird durch eine neue Zeile
-- richtiggestellt, nie durch Aendern der alten.
SELECT make_append_only('deposit_ledger');

SELECT attach_audit('deposit_ledger');
