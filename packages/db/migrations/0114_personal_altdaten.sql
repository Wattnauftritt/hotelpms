-- ---------------------------------------------------------------------------
-- 0114 Altdaten aus der alten Personal-App (Aufgabe 18, Baustein 9;
-- Dokument 34)
--
-- Die Alt-App kennt nur Benutzernamen. Die Leitung ordnet jeden einmal
-- einer Person in StayGrid zu, und jeder spaetere Export benutzt die
-- Zuordnung wieder -- bis zum Umschalttag kommen mehrere. `user_id` NULL
-- heisst: bewusst nicht uebernehmen (etwa ein Testzugang der Alt-App).
--
-- Die Zeilen selbst brauchen nichts Neues: `housekeeping_task.source` (0106)
-- und `staff_work_entry.source` (0111) unterscheiden schon, was aus der
-- Alt-App kam. Genau daran haengt das Ersetzen eines Tages.
-- ---------------------------------------------------------------------------

-- Eine eigene `id` statt des Paars als Schluessel: das Protokoll schreibt
-- den Primaerschluessel mit, und der Benutzername gehoert nicht hinein.
CREATE TABLE staff_legacy_user (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id      bigint NOT NULL REFERENCES property(id),
  legacy_username  text   NOT NULL CHECK (length(legacy_username) BETWEEN 1 AND 100),
  user_id          bigint REFERENCES app_user(id),
  updated_by       bigint REFERENCES app_user(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, legacy_username)
);

ALTER TABLE staff_legacy_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_legacy_user FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON staff_legacy_user USING (property_id = ANY (app_property_ids()));

SELECT attach_audit('staff_legacy_user');

-- Ein Benutzername bezeichnet einen Menschen.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('staff_legacy_user', 'legacy_username', 'Benutzername der Alt-App')
ON CONFLICT DO NOTHING;

-- Das Ersetzen eines Tages loescht und schreibt nur Zeilen aus der Alt-App.
CREATE INDEX hk_task_legacy ON housekeeping_task (property_id, business_date)
  WHERE source = 'legacy';
CREATE INDEX staff_work_entry_legacy ON staff_work_entry (property_id, business_date)
  WHERE source = 'legacy';
