-- ---------------------------------------------------------------------------
-- 0108 Meine Zimmer in der Personal-App (Aufgabe 18, Baustein 3)
--
-- Die Reinigungskraft setzt an ihren Zimmern des Tages, wie es ausging. Die
-- alte App kannte vier Ausgaenge; drei davon uebernehmen wir als
-- `outcome`, der vierte ("Fehler") wird eine Wartungsmeldung, weil ein
-- tropfender Hahn nicht mit dem Zimmer erledigt ist:
--
--   cleaned    gereinigt                          status = 'done'
--   declined   der Gast wollte keine Reinigung    status = 'skipped'
--   was_clean  war schon sauber                   status = 'skipped'
--
-- `status` bleibt, wie es ist, und sagt weiter nur offen/erledigt/
-- uebersprungen -- der Housekeeping-Bildschirm und der Aufgabengenerator
-- lesen es. Der Ausgang steht daneben, weil an ihm die Abrechnung haengt:
-- die alte App rechnete nur "gereinigt" mit Minuten ab (Baustein 6), und
-- "keine Reinigung gewuenscht" ist spaeter der Anlass fuer die
-- Wasserflasche (Baustein 10).
--
-- `done_by` haelt fest, wer den Ausgang gesetzt hat. Meist die Kraft
-- selbst, manchmal die Hausdame fuer sie -- und dann soll man es sehen.
--
-- Der Verlauf (0106) nimmt den Ausgang mit: "uebersprungen" allein sagt
-- nicht, ob der Gast abgelehnt hat oder das Zimmer sauber war, und genau
-- das fragt die Abrechnung nach.
-- ---------------------------------------------------------------------------

ALTER TABLE housekeeping_task
  ADD COLUMN outcome text CHECK (outcome IN ('cleaned','declined','was_clean')),
  ADD COLUMN done_by bigint REFERENCES app_user(id);

-- Ausgang und Status passen zusammen, sonst zaehlte die Abrechnung ein
-- Zimmer, das der Bildschirm als offen zeigt.
ALTER TABLE housekeeping_task ADD CONSTRAINT housekeeping_task_ausgang
  CHECK (outcome IS NULL
         OR (outcome = 'cleaned' AND status = 'done')
         OR (outcome IN ('declined','was_clean') AND status = 'skipped'));

ALTER TABLE housekeeping_task_log
  ADD COLUMN outcome_from text,
  ADD COLUMN outcome_to   text;

CREATE OR REPLACE FUNCTION housekeeping_task_protokoll() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                       kind, action, assigned_to, minutes_to, status_to,
                                       outcome_to, changed_by)
    VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.business_date, NEW.kind,
            'created', NEW.assigned_to, NEW.minutes, NEW.status, NEW.outcome,
            app_user_id());
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.minutes IS DISTINCT FROM OLD.minutes
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.outcome IS DISTINCT FROM OLD.outcome THEN
      INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                         kind, action, assigned_from, assigned_to,
                                         minutes_from, minutes_to, status_from, status_to,
                                         outcome_from, outcome_to, changed_by)
      VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.business_date, NEW.kind,
              'changed', OLD.assigned_to, NEW.assigned_to, OLD.minutes, NEW.minutes,
              OLD.status, NEW.status, OLD.outcome, NEW.outcome, app_user_id());
    END IF;
  ELSE
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                       kind, action, assigned_from, minutes_from,
                                       status_from, outcome_from, changed_by)
    VALUES (OLD.property_id, OLD.id, OLD.resource_id, OLD.business_date, OLD.kind,
            'deleted', OLD.assigned_to, OLD.minutes, OLD.status, OLD.outcome,
            app_user_id());
  END IF;
  RETURN NULL;
END $$;
