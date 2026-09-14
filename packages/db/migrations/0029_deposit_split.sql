-- Anzahlungen, zweiter Teil: Steuersaetze und der Buchungsstapel
-- (Aufgabe 3, B4 in Dokument 13).
--
-- Befund an 0027: eine Anzahlung traegt dort genau einen Steuersatz, vom
-- Aufrufer mitgegeben. Das Haus verkauft aber Uebernachtung zum
-- ermaessigten und Getraenke zum vollen Satz, und ein Fruehstuecksbuffet
-- beides in einem Preis. Wer pauschal den vollen Satz nimmt, weist zu viel
-- aus und korrigiert jede Schlussrechnung; wer pauschal den ermaessigten
-- nimmt, schuldet die Differenz.

-- ---------------------------------------------------------------------------
-- 1. Ein Artikel, der zwei Steuersaetze traegt.
-- ---------------------------------------------------------------------------
--
-- Speisen in der Gastronomie sind ermaessigt, Getraenke nicht. Das
-- Verhaeltnis legt das Haus fest, weil es von seinem Angebot abhaengt;
-- ueblich sind 30 Prozent Getraenke. Ohne diese Angabe liesse sich eine
-- Anzahlung nicht im Verhaeltnis der erwarteten Leistung aufteilen.

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
-- 2. Eine Anzahlung, mehrere Satzgruppen.
-- ---------------------------------------------------------------------------
--
-- Die Sperren aus 0027 lassen je Zahlungsvermerk genau eine Zeile und je
-- Anzahlungsrechnung genau eine Verrechnung zu. Das ist richtig gedacht und
-- zu eng gefasst: aufgeteilt braucht dieselbe Anzahlung eine Zeile **je
-- Satz**. Die Sperre wandert deshalb auf (Vermerk, Satz) und
-- (Anzahlungsrechnung, Satz) -- doppelt verbucht wird damit weiterhin
-- nicht, aufgeteilt aber schon.

DROP INDEX deposit_ledger_settlement_once;
CREATE UNIQUE INDEX deposit_ledger_settlement_once
  ON deposit_ledger (settlement_id, tax_rate_bp)
  WHERE settlement_id IS NOT NULL;

DROP INDEX deposit_ledger_applied_once;
CREATE UNIQUE INDEX deposit_ledger_applied_once
  ON deposit_ledger (deposit_invoice_id, tax_rate_bp)
  WHERE kind = 'applied';

-- ---------------------------------------------------------------------------
-- 3. Der Buchungstag im Stapel.
-- ---------------------------------------------------------------------------
--
-- Der DATEV-Export liest ueber invoice JOIN charge. Eine Anzahlung erzeugt
-- keine charge-Zeile -- sie ist keine Leistung --, und damit stand ihre
-- Steuer zwar auf dem Beleg, aber in keinem Buchungsstapel. Genau das
-- verlangt die Abnahme aber: die Steuer im Monat der Vereinnahmung.
--
-- Gebucht wird deshalb aus dem Anzahlungsjournal, und der Index dafuer ist
-- der Geschaeftstag je Haus: der Export fragt immer einen Zeitraum eines
-- Hauses ab.
CREATE INDEX deposit_ledger_date ON deposit_ledger (property_id, business_date);
