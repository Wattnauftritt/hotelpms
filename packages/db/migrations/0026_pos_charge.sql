-- Herkunftsvermerk an der Position, fuer die Kassenschnittstelle (Aufgabe 7).
--
-- **Warum ueberhaupt ein Vermerk.** Ein Umsatz, den die Ladenkasse auf ein
-- Zimmer bucht, ist bei uns eine gewoehnliche Position auf dem Gastkonto --
-- aber die massgebliche Aufzeichnung liegt nicht hier. Sie liegt in der
-- Kasse, mit ihrer TSE und ihrer Belegnummer. Ohne Vermerk stuende auf dem
-- Folio ein Betrag, dessen Herkunft niemand mehr nachvollziehen kann, und
-- bei einer Pruefung waere die Verbindung zwischen Kassenbeleg und
-- Hotelrechnung nur noch zu erraten.
--
-- Dieselbe Ueberlegung wie bei settlement.external_reference in 0010: der
-- Verweis macht sichtbar, dass anderswo das Original liegt. Er ist **kein**
-- Bon und **kein** Kassenbestand; beides entsteht in diesem System nicht
-- (Entscheidung 9, Dokument 09).

ALTER TABLE charge
  ADD COLUMN source             text,
  ADD COLUMN external_reference text,
  -- Bewusst eng: jede weitere Herkunft soll einmal bedacht werden, statt
  -- sich durch einen beliebigen Freitext einzuschleichen.
  ADD CONSTRAINT charge_source CHECK (source IS NULL OR source IN ('pos')),
  -- Ein Verweis ohne Herkunft waere nicht zuzuordnen, eine Herkunft ohne
  -- Verweis nicht nachpruefbar.
  ADD CONSTRAINT charge_source_reference
    CHECK ((source IS NULL) = (external_reference IS NULL));

COMMENT ON COLUMN charge.source IS
  'Herkunft der Position. NULL ist das Haus selbst, pos die angebundene Kasse.';
COMMENT ON COLUMN charge.external_reference IS
  'Belegnummer im Herkunftssystem. Dort liegt die massgebliche Aufzeichnung, hier nur der Verweis.';

-- Der eigentliche Schutz gegen die Doppelbuchung.
--
-- Eine Kasse wiederholt eine Zustellung, sobald sie keine Antwort bekommt --
-- nach einem Netzabbruch, einem Neustart, einem Timeout. Der
-- Idempotenzschluessel der Anwendung faengt die Wiederholung nur, solange
-- die Kasse denselben Schluessel schickt; nach einem Neustart tut sie das
-- typischerweise nicht mehr. Ihre eigene Belegnummer aendert sich dagegen
-- nie. Deshalb liegt die Eindeutigkeit hier, in der Datenbank, und nicht
-- allein in der Anwendung.
--
-- Die Gegenbuchung eines Kassenumsatzes traegt die Stornonummer der Kasse
-- und ist damit eine andere Zeile, kein Konflikt.
CREATE UNIQUE INDEX charge_source_ref_unique
  ON charge (property_id, source, external_reference)
  WHERE external_reference IS NOT NULL;

-- Der Storno sucht die vorhandene Gegenbuchung zu einer Position. Ohne
-- diesen Index liest er dafuer die ganze Tabelle, und die waechst mit jeder
-- Nacht jedes Zimmers.
CREATE INDEX charge_reverses ON charge (reverses_id) WHERE reverses_id IS NOT NULL;
