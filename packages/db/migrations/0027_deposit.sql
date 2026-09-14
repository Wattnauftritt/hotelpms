-- Anzahlungen und ihre Steuerpflicht (Aufgabe 3, B4 in Dokument 13).
--
-- Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Umsatzsteuer auf eine
-- Anzahlung mit der **Vereinnahmung**, nicht mit der Leistung. Bisher war
-- eine Anzahlung in diesem Modell nur ein settlement ohne Rechnung, also
-- ein negativer Saldo und steuerlich unsichtbar: das Haus haette die
-- Steuer geschuldet, ohne dass irgendetwas davon wusste.

-- ---------------------------------------------------------------------------
-- 1. Ein Artikel, der zwei Steuersaetze traegt.
-- ---------------------------------------------------------------------------
--
-- Das Fruehstuecksbuffet ist ein Preis und zwei Saetze: Speisen in der
-- Gastronomie sind ermaessigt, Getraenke nicht. Ohne diese Aufteilung
-- koennte eine Anzahlung nicht im Verhaeltnis der erwarteten Leistung
-- aufgeteilt werden -- und genau das nennt Dokument 13 als den Punkt, der
-- "nicht trivial" ist.
--
-- Das Verhaeltnis legt das Haus fest, weil es von seinem Angebot abhaengt;
-- ueblich sind 30 Prozent Getraenke.

ALTER TABLE product
  ADD COLUMN split_tax_rule_id bigint REFERENCES tax_rule(id),
  ADD COLUMN split_share_bp    integer,
  -- Ein Anteil ohne zweiten Satz waere nicht zuzuordnen, ein zweiter Satz
  -- ohne Anteil nicht zu berechnen.
  ADD CONSTRAINT product_split CHECK (
    (split_tax_rule_id IS NULL) = (split_share_bp IS NULL)),
  -- Null oder alles waere keine Aufteilung, sondern ein anderer Satz.
  ADD CONSTRAINT product_split_share CHECK (
    split_share_bp IS NULL OR (split_share_bp > 0 AND split_share_bp < 10000));

COMMENT ON COLUMN product.split_share_bp IS
  'Anteil des Bruttopreises, der zum zweiten Satz gehoert. 3000 = 30 Prozent.';

-- ---------------------------------------------------------------------------
-- 2. Die Anrechnung auf der Schlussrechnung.
-- ---------------------------------------------------------------------------
--
-- § 14 Abs. 5 Satz 2 UStG: die Schlussrechnung lautet ueber den vollen
-- Betrag, die vereinnahmte Anzahlung und ihre Steuer werden abgesetzt. Die
-- Absetzung braucht einen Verweis auf die Anzahlungsrechnung, sonst ist
-- beim Empfaenger nicht nachvollziehbar, was hier abgezogen wird.

ALTER TABLE charge
  ADD COLUMN deposit_invoice_id bigint REFERENCES invoice(id);

COMMENT ON COLUMN charge.deposit_invoice_id IS
  'Bei einer Anrechnung: die Anzahlungsrechnung, die hier abgesetzt wird.';

-- ---------------------------------------------------------------------------
-- 3. Der eigene Saldo neben dem Gastkonto.
-- ---------------------------------------------------------------------------
--
-- Warum nicht einfach am Folio ablesbar: das Gastkonto beantwortet "was
-- schuldet der Gast", der Anzahlungssaldo beantwortet "was hat das Haus
-- vereinnahmt, ohne geleistet zu haben". Das ist eine Verbindlichkeit und
-- keine Forderung; sie gehoert auf ein eigenes Konto und in eine eigene
-- Aufzeichnung.
--
-- Der Geschaeftstag der Zeile 'received' ist der Tag der Vereinnahmung.
-- An ihm haengt die Steuer, und nur deshalb steht er hier und nicht nur
-- am Zahlungsvermerk: die Anzahlungsrechnung kann Wochen frueher
-- ausgestellt sein, und im Monat ihrer Ausstellung ist noch nichts
-- geschuldet.

CREATE TABLE deposit_ledger (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  folio_id           bigint NOT NULL REFERENCES folio(id),
  deposit_invoice_id bigint NOT NULL REFERENCES invoice(id),
  kind               text   NOT NULL CHECK (kind IN ('received','applied','refunded')),
  -- Vorzeichen: Eingang positiv, Anrechnung und Rueckzahlung negativ.
  amount_cent        bigint NOT NULL,
  business_date      date   NOT NULL,
  settlement_id      bigint REFERENCES settlement(id),
  applied_invoice_id bigint REFERENCES invoice(id),
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_sign CHECK (
    (kind = 'received' AND amount_cent > 0) OR
    (kind <> 'received' AND amount_cent < 0))
);
CREATE INDEX deposit_ledger_folio ON deposit_ledger (folio_id);
CREATE INDEX deposit_ledger_invoice ON deposit_ledger (deposit_invoice_id);
CREATE INDEX deposit_ledger_date ON deposit_ledger (property_id, business_date);

-- Eine Anzahlung wird genau einmal vereinnahmt und genau einmal
-- angerechnet. Ohne diese Sperre buchte ein wiederholter Aufruf sie
-- zweimal ab, und die Schlussrechnung zoege 400 Euro ab, wo 200 gezahlt
-- wurden.
CREATE UNIQUE INDEX deposit_ledger_once
  ON deposit_ledger (deposit_invoice_id, kind)
  WHERE kind IN ('received','applied');

ALTER TABLE deposit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_ledger FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON deposit_ledger
  USING (property_id = ANY (app_property_ids()));

-- Haertegrad 1 wie jede andere Aufzeichnung ueber Geld: eine Korrektur ist
-- eine Gegenbuchung, keine Aenderung.
SELECT make_append_only('deposit_ledger');
