-- ---------------------------------------------------------------------------
-- 0111 Arbeitszeit des Personals (Aufgabe 18, Baustein 6)
--
-- Keine Zeiterfassung mit Kommen und Gehen: das Personal kommt von einer
-- Zeitarbeitsfirma und wird vertraglich nach Pauschalminuten abgerechnet
-- (Sven, 07.10.2026). Die Arbeitszeit eines Tages ist deshalb wie in der
-- alten App
--
--   Minuten der gereinigten Zimmer (housekeeping_task, outcome 'cleaned')
--   + Zusatzarbeiten mit Minuten           (staff_work_entry, 'extra')
--   + Kueche mit Beginn und Ende           (staff_work_entry, 'kitchen')
--   + Korrekturen der Leitung mit Grund    (staff_work_entry, 'correction')
--
-- Was die alte App nicht hatte und hier dazukommt:
--
-- * **Korrektur statt Ueberschreiben.** Die Leitung aendert keine Zeile
--   der Kraft, sie legt eine Korrektur mit Vorzeichen und Grund daneben.
--   Die Kraft sieht sie in ihrem Monat -- eine Abrechnung, die sich still
--   aendert, ist der Anfang jedes Streits mit der Zeitarbeitsfirma.
-- * **Zurueckziehen statt Loeschen.** Die Kraft kann einen Eintrag von heute
--   oder gestern zurueckziehen (`withdrawn_at`); er zaehlt dann nicht mehr,
--   bleibt aber stehen. Die alte App loeschte hart, und mit dem Benutzer
--   verschwand seine ganze Geschichte.
-- * **Monatsabschluss.** Ein abgeschlossener Monat aendert sich nicht mehr:
--   keine Eintraege, keine Korrekturen, keine Minuten an Zimmern. Ein
--   Trigger haelt das fest, nicht nur die Route. Wieder oeffnen geht, mit
--   Grund, und steht im Protokoll.
-- * **Kuechenzeiten als Uhrzeit.** Die alte App nahm Beginn und Ende
--   entgegen und speicherte nur Minuten. Hier bleiben beide stehen; ueber
--   Mitternacht zaehlt das Ende am Folgetag.
--
-- **Datenschutz.** Arbeitszeit ist ein Personaldatum. Minuten, Uhrzeiten,
-- Text und Grund stehen in `audit_redaction`: das Protokoll sagt, wer wann
-- welchen Eintrag geaendert hat, nicht was darin stand. Die Geschichte der
-- Werte steht in dieser Tabelle selbst -- Korrekturen und Zurueckgezogenes
-- bleiben ja stehen. Wer was sieht, entscheiden die Routen: die Kraft nur
-- sich, die Leitung (`worktime:manage`) alle, die Hausdame niemanden.
-- ---------------------------------------------------------------------------

CREATE TABLE staff_work_entry (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  user_id        bigint NOT NULL REFERENCES app_user(id),
  business_date  date   NOT NULL,
  kind           text   NOT NULL CHECK (kind IN ('extra','kitchen','correction')),
  description    text   CHECK (description IS NULL OR length(description) <= 500),
  -- Bei Korrekturen mit Vorzeichen; sonst positiv. Hoechstens ein Tag.
  minutes        integer NOT NULL CHECK (minutes BETWEEN -1440 AND 1440 AND minutes <> 0),
  start_time     time,
  end_time       time,
  source         text   NOT NULL DEFAULT 'staygrid' CHECK (source IN ('staygrid','legacy')),
  created_by     bigint REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint REFERENCES app_user(id),
  updated_at     timestamptz,
  withdrawn_at   timestamptz,
  CONSTRAINT staff_work_entry_art CHECK (
    (kind = 'extra'      AND minutes > 0 AND description IS NOT NULL
                         AND start_time IS NULL AND end_time IS NULL)
    OR (kind = 'kitchen' AND minutes > 0
                         AND start_time IS NOT NULL AND end_time IS NOT NULL)
    OR (kind = 'correction' AND description IS NOT NULL
                         AND start_time IS NULL AND end_time IS NULL))
);
CREATE INDEX staff_work_entry_person ON staff_work_entry (user_id, business_date);
CREATE INDEX staff_work_entry_monat ON staff_work_entry (property_id, business_date);

-- Abschluesse mit Geschichte: ein wieder geoeffneter Monat behaelt seine
-- Zeile mit Wer, Wann und Grund, und ein neuer Abschluss ist eine neue
-- Zeile. Abgeschlossen ist ein Monat, solange eine Zeile ohne
-- `reopened_at` da ist.
CREATE TABLE staff_month_close (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  -- Der Erste des Monats.
  month          date   NOT NULL CHECK (extract(day FROM month) = 1),
  closed_by      bigint REFERENCES app_user(id),
  closed_at      timestamptz NOT NULL DEFAULT now(),
  reopened_by    bigint REFERENCES app_user(id),
  reopened_at    timestamptz,
  reopen_reason  text CHECK (reopen_reason IS NULL OR length(reopen_reason) <= 500),
  CHECK ((reopened_at IS NULL) = (reopen_reason IS NULL))
);
CREATE UNIQUE INDEX staff_month_close_offen ON staff_month_close (property_id, month)
  WHERE reopened_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_work_entry','staff_month_close'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('staff_work_entry');
SELECT attach_audit('staff_month_close');

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('staff_work_entry', 'description', 'Arbeitszeit, Personaldatum'),
  ('staff_work_entry', 'minutes',     'Arbeitszeit, Personaldatum'),
  ('staff_work_entry', 'start_time',  'Arbeitszeit, Personaldatum'),
  ('staff_work_entry', 'end_time',    'Arbeitszeit, Personaldatum');

/*
 * Ein abgeschlossener Monat bleibt, wie er ist. Fuer Eintraege jede
 * Aenderung; fuer Zimmeraufgaben nur, was an der Abrechnung haengt
 * (Kraft, Minuten, Ausgang) -- die Kontrolle der Hausdame darf noch fallen.
 */
CREATE OR REPLACE FUNCTION staff_month_is_closed(p_property bigint, p_date date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM staff_month_close
                  WHERE property_id = p_property
                    AND month = date_trunc('month', p_date)::date
                    AND reopened_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION staff_work_entry_monat_offen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND staff_month_is_closed(OLD.property_id, OLD.business_date) THEN
    RAISE EXCEPTION 'Monat abgeschlossen' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND staff_month_is_closed(NEW.property_id, NEW.business_date) THEN
    RAISE EXCEPTION 'Monat abgeschlossen' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_staff_work_entry_monat
  BEFORE INSERT OR UPDATE OR DELETE ON staff_work_entry
  FOR EACH ROW EXECUTE FUNCTION staff_work_entry_monat_offen();

CREATE OR REPLACE FUNCTION housekeeping_task_monat_offen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to
     AND NEW.minutes IS NOT DISTINCT FROM OLD.minutes
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome THEN
    RETURN NEW;
  END IF;
  IF staff_month_is_closed(COALESCE(NEW.property_id, OLD.property_id),
                           COALESCE(NEW.business_date, OLD.business_date)) THEN
    RAISE EXCEPTION 'Monat abgeschlossen' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_housekeeping_task_monat
  BEFORE INSERT OR UPDATE OR DELETE ON housekeeping_task
  FOR EACH ROW EXECUTE FUNCTION housekeeping_task_monat_offen();

INSERT INTO permission (key, grp, description) VALUES
  ('worktime:manage', 'Personal',
   'Arbeitszeiten aller Kraefte sehen, korrigieren, Monat abschliessen und ausgeben')
ON CONFLICT DO NOTHING;

-- Nicht die Hausdame: sie sieht Zimmer, nicht die Arbeitszeit (Plan,
-- Abschnitt 3).
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'worktime:manage'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key IN ('owner','account_admin','hotel_director')
ON CONFLICT DO NOTHING;
