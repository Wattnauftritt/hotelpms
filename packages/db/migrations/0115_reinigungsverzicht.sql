-- ---------------------------------------------------------------------------
-- 0115 Reinigungsverzicht des Gastes (Aufgabe 18, Baustein 10)
--
-- Ein Gast verzichtet fuer einen Tag seines Aufenthalts auf die
-- Zwischenreinigung; als Dank stellt das Personal eine Flasche Wasser vor
-- die Tuer und hakt das ab. In der alten App war das eine offene Seite
-- ohne Bezug zur Buchung: jeder mit dem Link konnte fuer jedes Zimmer
-- verzichten. Hier haengt der Verzicht an der Reservierung, und ihn setzt
-- nur, wer sie vor sich hat --
--
--   der Gast ueber seinen Online-Check-in-Link (gueltig bis zur Abreise,
--   Migration 0061), auch an der Station im Haus, oder
--   die Rezeption, wenn der Gast am Tresen oder am Telefon fragt.
--
-- **Ein Wunsch, kein Beleg.** Zurueckgenommen wird er mit `withdrawn_at`,
-- nicht geloescht: die Hausdame soll sehen koennen, warum ein Zimmer
-- gestern nicht gereinigt wurde, auch wenn der Gast heute anders will.
--
-- Zwei Schalter je Haus, wie in der alten App: der Verzicht ueberhaupt, und
-- ob es dafuer Wasser gibt. Beide aus als Vorgabe -- ein Haus soll nicht
-- durch eine Auslieferung ploetzlich etwas versprechen.
-- ---------------------------------------------------------------------------

CREATE TABLE property_cleaning_waiver_setting (
  property_id   bigint PRIMARY KEY REFERENCES property(id),
  enabled       boolean NOT NULL DEFAULT false,
  water_gift    boolean NOT NULL DEFAULT false,
  updated_by    bigint REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cleaning_waiver (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  reservation_id     bigint NOT NULL REFERENCES reservation(id),
  business_date      date   NOT NULL,
  source             text   NOT NULL CHECK (source IN ('guest','reception')),
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  withdrawn_at       timestamptz,
  withdrawn_by       bigint REFERENCES app_user(id),
  water_delivered_at timestamptz,
  water_delivered_by bigint REFERENCES app_user(id)
);
CREATE UNIQUE INDEX cleaning_waiver_aktiv ON cleaning_waiver (reservation_id, business_date)
  WHERE withdrawn_at IS NULL;
CREATE INDEX cleaning_waiver_tag ON cleaning_waiver (property_id, business_date)
  WHERE withdrawn_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['property_cleaning_waiver_setting','cleaning_waiver'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('property_cleaning_waiver_setting');
SELECT attach_audit('cleaning_waiver');
