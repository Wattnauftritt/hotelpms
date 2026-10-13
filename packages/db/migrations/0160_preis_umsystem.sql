-- ---------------------------------------------------------------------------
-- 0160 -- Centgenauer Preis aus einem Umsystem.
--
-- Anforderung: Sven, 13.10.2026. Die Rezeption traegt bei einer Buchung den
-- Gesamtbetrag in ganzen Euro ein; zum Planen genuegt das. Das Umsystem, das
-- Buchungen mit ihren Quellen abgleicht (Gastkontakt, 0083), kennt aus der
-- Quellbuchung den Preis auf den Cent, bei RoomCloud sogar je Zimmer und je
-- Nacht. Die Rechnung braucht den genauen Betrag, und der Nachtlauf bucht,
-- was in `reservation_night` steht.
--
-- **Wer gewinnt.** Was die Rezeption eingetragen hat, bevor der Preis aus der
-- Quelle kam, ist eine Schaetzung und wird ersetzt. Was sie danach aendert,
-- wiegt hoeher: ein spaeterer Abgleich laesst es stehen. Erkannt wird das
-- an `nights`: die Naechte, wie das Umsystem sie zuletzt geschrieben hat.
-- Sehen sie heute anders aus, hat jemand in StayGrid Preis oder Zeitraum
-- geaendert. Ein Vergleich statt eines Triggers, weil jeder Weg zaehlt, der
-- Naechte aendert -- Preis vereinbaren, verlaengern, Gruppenpreis --, und
-- ein Trigger mit einer Liste der Wege den naechsten nicht kennt.
--
-- Eine eigene Tabelle wie 0085: das Umsystem bestaetigt den Preis bei
-- jedem Lauf, und eine Bestaetigung ist keine Aenderung, die der
-- Aenderungscursor der Reservierung zeigen soll.
--
-- Kein Eintrag in `audit_redaction`: Betraege, Daten und eine Buchungsnummer
-- der Quelle bezeichnen keinen Menschen.
-- ---------------------------------------------------------------------------

CREATE TABLE reservation_external_price (
  -- Faellt mit der Reservierung: ein uebernommener Preis ist kein Grund,
  -- die Ruecknahme einer Uebernahme aufzuhalten.
  reservation_id bigint PRIMARY KEY REFERENCES reservation(id) ON DELETE CASCADE,
  property_id    bigint NOT NULL REFERENCES property(id),
  system         text NOT NULL,
  reference      text,
  total_cent     bigint NOT NULL CHECK (total_cent >= 0),
  -- Wie die Quelle den Preis kannte: je Nacht oder nur als Summe.
  per_night      boolean NOT NULL,
  -- [[date, price_cent], ...] nach dem Schreiben, nach Datum geordnet.
  nights         jsonb NOT NULL,
  applied_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reservation_external_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_external_price FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON reservation_external_price
  USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('reservation_external_price');

/*
 * Ein eigenes Recht, nicht `guest:contact_write`: ein Preis landet auf der
 * Rechnung, eine Mailadresse nicht. Keiner Rolle zugeordnet, es ist fuer
 * Maschinenzugaenge.
 */
INSERT INTO permission (key, grp, description) VALUES
  ('reservation:price_import', 'Reservierung', 'Centgenauen Preis aus einem Umsystem uebernehmen')
ON CONFLICT DO NOTHING;
