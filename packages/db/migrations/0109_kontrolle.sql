-- ---------------------------------------------------------------------------
-- 0109 Kontrolle durch die Hausdame (Aufgabe 18, Baustein 4)
--
-- In der alten App sah die Hausdame die Zimmer aller Kraefte, und ein
-- "kontrolliert" wurde nirgends gespeichert. Hier haelt die Aufgabe fest,
-- wie die Kontrolle ausging:
--
--   passed   kontrolliert -- das Zimmer ist bezugsfertig, der Zimmerstand
--            wird `inspected`, und die Rezeption sieht es im Zimmerplan.
--   rework   nacharbeiten -- mit einem Satz, was fehlt. Das Zimmer steht
--            wieder oben in der Liste der Kraft, mit diesem Satz.
--
-- Nacharbeit nimmt den Ausgang `cleaned` **nicht** zurueck: die Kraft hat
-- das Zimmer gereinigt, und abgerechnet wird die Reinigung einmal, nicht
-- je Durchgang. Meldet die Kraft "nachgearbeitet", faellt die Kontrolle
-- auf offen zurueck, und die Hausdame schaut noch einmal.
--
-- Eigenes Recht `housekeeping:inspect`: Kontrollieren ist etwas anderes als
-- Planen (an den Minuten haengt Geld) und als den Zimmerstand setzen (das
-- darf die Rezeption auch).
--
-- Der Verlauf (0106) nimmt die Kontrolle mit; wer "nacharbeiten" sagte,
-- soll sich spaeter nachlesen lassen.
-- ---------------------------------------------------------------------------

ALTER TABLE housekeeping_task
  ADD COLUMN inspection      text CHECK (inspection IN ('passed','rework')),
  ADD COLUMN inspection_note text CHECK (inspection_note IS NULL
                                         OR length(inspection_note) <= 500),
  ADD COLUMN inspected_by    bigint REFERENCES app_user(id),
  ADD COLUMN inspected_at    timestamptz;

-- Nacharbeit ohne Satz ist eine Rueckgabe ohne Grund, und die Kraft steht
-- ratlos im Zimmer.
ALTER TABLE housekeeping_task ADD CONSTRAINT housekeeping_task_nacharbeit
  CHECK (inspection IS DISTINCT FROM 'rework' OR inspection_note IS NOT NULL);

ALTER TABLE housekeeping_task_log
  ADD COLUMN inspection_from text,
  ADD COLUMN inspection_to   text;

CREATE OR REPLACE FUNCTION housekeeping_task_protokoll() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                       kind, action, assigned_to, minutes_to, status_to,
                                       outcome_to, inspection_to, changed_by)
    VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.business_date, NEW.kind,
            'created', NEW.assigned_to, NEW.minutes, NEW.status, NEW.outcome,
            NEW.inspection, app_user_id());
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.minutes IS DISTINCT FROM OLD.minutes
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.outcome IS DISTINCT FROM OLD.outcome
       OR NEW.inspection IS DISTINCT FROM OLD.inspection THEN
      INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                         kind, action, assigned_from, assigned_to,
                                         minutes_from, minutes_to, status_from, status_to,
                                         outcome_from, outcome_to,
                                         inspection_from, inspection_to, changed_by)
      VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.business_date, NEW.kind,
              'changed', OLD.assigned_to, NEW.assigned_to, OLD.minutes, NEW.minutes,
              OLD.status, NEW.status, OLD.outcome, NEW.outcome,
              OLD.inspection, NEW.inspection, app_user_id());
    END IF;
  ELSE
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                       kind, action, assigned_from, minutes_from,
                                       status_from, outcome_from, inspection_from, changed_by)
    VALUES (OLD.property_id, OLD.id, OLD.resource_id, OLD.business_date, OLD.kind,
            'deleted', OLD.assigned_to, OLD.minutes, OLD.status, OLD.outcome,
            OLD.inspection, app_user_id());
  END IF;
  RETURN NULL;
END $$;

INSERT INTO permission (key, grp, description) VALUES
  ('housekeeping:inspect', 'Housekeeping', 'Gereinigte Zimmer kontrollieren')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'housekeeping:inspect'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key IN ('owner','account_admin','hotel_director','housekeeping')
ON CONFLICT DO NOTHING;
