-- ---------------------------------------------------------------------------
-- 0103 -- Zimmer sortieren, Schritt 1: was der Sortierer wissen muss.
--
-- Anforderung: Sven, 07.10.2026, Thread "Zimmer-Sortierung". StayGrid soll
-- Buchungen auf Zimmer verteilen -- im Gaestehaus automatisch, im Hotel auf
-- Knopfdruck. Plan in /mnt/project-files/zimmer-sortierung/plan.md; die
-- Regeln stammen aus dem Adminpanel, das beides bisher gemacht hat.
--
-- Diese Migration legt nur die Angaben an, der Sortierer kommt danach:
--
-- 1. `resource.quality` (0..100): wie gut ein Zimmer ist. Der Sortierer gibt
--    die besten Zimmer den Gaesten, fuer die sie sich lohnen. Eine Zahl
--    statt einer Rangfolge: ein neues Zimmer bekommt einen Wert, statt dass
--    alle anderen umnummeriert werden. 50 ist "gewoehnlich"; ab der Grenze
--    in den Einstellungen gilt ein Zimmer als Spitzenzimmer.
--
-- 2. `resource.building`: Haupthaus, Nebenhaus. Eine Gruppe soll moeglichst
--    in einem Haus liegen. Die Etage gibt es schon (`floor`).
--
-- 3. `reservation.room_fixed`: "Zimmer fest". Im Adminpanel stand das als
--    Codewort "manuell" oder "Zi. 10" in der Notiz, und eine vertippte Notiz
--    machte aus dem Stammgast im Wunschzimmer einen beliebigen. Ein Schalter
--    ist sichtbar und eindeutig. Er bewegt weder Bestand noch Zimmer und ist
--    deshalb auch keine Aenderung im Sinne von 0092: eine gepushte Buchung
--    bleibt der Quelle, wenn jemand nur das Schloss setzt.
--
-- 4. `room_sort_setting` je Haus: ob und wie sortiert wird, und mit welchen
--    Gewichten. Nichts davon gehoert in den Code -- "1-9 Nebenhaus" und
--    "Balkon" sind Eigenschaften eines Hauses (Projektentscheidung vom
--    03.10.2026: hausspezifische Regeln nicht hart in die API). Die
--    Gewichte stehen als JSON, weil sie vom Sortierer gelesen und von der
--    Route gegen ein festes Schema geprueft werden; fehlende Schluessel
--    nehmen die Vorgabe aus `@hotelpms/domain`.
--
-- Kein Eintrag in audit_redaction: keine der Spalten bezeichnet einen
-- Menschen oder traegt ein Geheimnis.
-- ---------------------------------------------------------------------------

ALTER TABLE resource
  ADD COLUMN quality  smallint NOT NULL DEFAULT 50 CHECK (quality BETWEEN 0 AND 100),
  ADD COLUMN building text CHECK (building IS NULL
                                  OR (length(building) BETWEEN 1 AND 40
                                      AND building = btrim(building)));

ALTER TABLE reservation
  ADD COLUMN room_fixed boolean NOT NULL DEFAULT false;

CREATE TABLE room_sort_setting (
  property_id    bigint PRIMARY KEY REFERENCES property(id),
  -- off: nie. manual: nur auf Knopfdruck im Zimmerplan. auto: der Worker
  -- sortiert nach jeder Aenderung (Gaestehaus).
  mode           text NOT NULL DEFAULT 'manual'
                 CHECK (mode IN ('off', 'manual', 'auto')),
  -- Anreisen von heute bleiben liegen: die Reinigung hat das Zimmer fuer
  -- sie vorbereitet, und der Gast steht unter Umstaenden schon am Tresen.
  keep_today     boolean NOT NULL DEFAULT true,
  weights        jsonb NOT NULL DEFAULT '{}'::jsonb
                 CHECK (jsonb_typeof(weights) = 'object'),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE room_sort_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_sort_setting FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON room_sort_setting USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('room_sort_setting');
