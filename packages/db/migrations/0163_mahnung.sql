-- Offene Posten und Mahnung (Pruefung Rechnungssystem 13.10.2026, Mittel).
--
-- Firmenrechnungen mit Zahlungsziel liessen sich nicht verfolgen: welche
-- Rechnung ueberfaellig ist, sah man nur, wenn man jede einzeln aufklappte,
-- und eine Mahnung gab es nicht. Die Liste der offenen Posten rechnet
-- aus Rechnung und Zahlungsvermerken; festgehalten wird hier nur, was sich
-- nicht rechnen laesst: wann zu welcher Rechnung mit welcher Frist gemahnt
-- wurde.
--
-- Unveraenderlich wie die Rechnung: eine verschickte Mahnung laesst sich
-- nicht zuruecknehmen, und wer spaeter streitet, ob gemahnt wurde, braucht
-- genau diese Zeile.
CREATE TABLE invoice_reminder (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  invoice_id  bigint NOT NULL REFERENCES invoice(id),
  -- 1 Zahlungserinnerung, 2 und 3 Mahnung. Danach ist es ein Fall fuer
  -- das Inkasso und nicht fuer die Rezeption.
  level       smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
  -- Ortszeit des Hauses, wie das Ausstellungsdatum der Rechnung.
  reminded_on date NOT NULL,
  due_on      date NOT NULL CHECK (due_on >= reminded_on),
  -- Was zu dem Zeitpunkt offen war, in Cent: die Mahnung nennt diesen Betrag.
  open_cent   bigint NOT NULL CHECK (open_cent > 0),
  -- Ob eine Mail dazu ging. Gemahnt werden kann auch per Telefon oder
  -- Brief. Kein Verweis auf die Mail: die raeumt die Aufbewahrung nach
  -- Frist ab, und ein Fremdschluessel aus einer unveraenderlichen Tabelle
  -- hielte sie fest.
  emailed     boolean NOT NULL DEFAULT false,
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, level)
);
CREATE INDEX invoice_reminder_property ON invoice_reminder (property_id, invoice_id);

ALTER TABLE invoice_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoice_reminder USING (property_id = ANY (app_property_ids()));

SELECT make_append_only('invoice_reminder');
SELECT attach_audit('invoice_reminder');
