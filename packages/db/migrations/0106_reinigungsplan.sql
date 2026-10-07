-- ---------------------------------------------------------------------------
-- 0106 -- Reinigungsplan: Sollminuten je Haus, Zuteilung mit Minuten,
-- Verlauf jeder Aenderung.
--
-- Anforderung: Sven, 07.10.2026, Thread "Personalsystem in StayGrid",
-- Baustein 2 des Plans in /mnt/project-files/personal-app/plan.md.
--
-- 1. `cleaning_norm`: wie viele Minuten ein Zimmer bei Abreise oder als
--    Bleiber zaehlt, fuer das ganze Haus, je Kategorie oder je Zimmer. Die
--    alte App hatte das im Code (Zimmer 8 und 9 sechzig Minuten, Gaestehaus
--    zwanzig ...). Die Minuten sind die **Abrechnungsgrundlage** mit der
--    Zeitarbeitsfirma, keine Schaetzung (Svens Entscheidung: keine
--    Kommen/Gehen-Erfassung). Fehlt ein Eintrag, gilt die Vorgabe der
--    alten App aus `@hotelpms/domain` (Abreise 30, Bleiber 10).
--
-- 2. `housekeeping_task` bekommt die Minuten, mit denen geplant wurde,
--    und wer wann geplant hat. Die Minuten werden **beim Planen
--    festgeschrieben**, nicht beim Lesen nachgeschlagen: aendert das Haus im
--    November die Sollminuten, darf sich der abgerechnete Oktober nicht
--    mitaendern. `source` unterscheidet Zeilen aus der alten App (Baustein 9),
--    deren gespeicherte Minuten uebernommen und nie neu gerechnet werden.
--
-- 3. `housekeeping_task_log`: wer wann wem welches Zimmer zugeteilt, die
--    Minuten geaendert oder den Stand gesetzt hat. Die alte App hat beim
--    Speichern eines Plans hart geloescht und neu geschrieben; ob eine Kraft
--    ein Zimmer erst um elf bekam, war danach nicht mehr zu sehen. An den
--    Minuten haengt Geld, deshalb ist der Verlauf nur anzuhaengen (wie
--    `audit_log`). Er traegt Benutzer-IDs, keine Namen: ein Mensch wird erst
--    beim Lesen daraus.
--
-- 4. Recht `housekeeping:plan` -- den Plan aufstellen und die Sollminuten
--    pflegen. Hausdame (`housekeeping`), Direktion, Betriebsverwaltung,
--    Inhaber. Die Rezeption sieht den Plan ueber `housekeeping:read`, stellt
--    ihn aber nicht auf.
-- ---------------------------------------------------------------------------

CREATE TABLE cleaning_norm (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  kind         text   NOT NULL CHECK (kind IN ('departure','stayover')),
  category_id  bigint REFERENCES resource_category(id),
  resource_id  bigint REFERENCES resource(id),
  minutes      integer NOT NULL CHECK (minutes BETWEEN 0 AND 480),
  updated_by   bigint REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Kategorie oder Zimmer oder keines (= ganzes Haus), nie beides: welches
  -- von beiden gaelte, waere sonst eine Frage der Lesart.
  CONSTRAINT cleaning_norm_ziel CHECK (category_id IS NULL OR resource_id IS NULL)
);
-- Je Ziel und Art ein Wert. Drei Indizes, weil NULL in einem gemeinsamen
-- eindeutigen Index nie gleich NULL ist und zwei Hauswerte durchliessen.
CREATE UNIQUE INDEX cleaning_norm_haus ON cleaning_norm (property_id, kind)
  WHERE category_id IS NULL AND resource_id IS NULL;
CREATE UNIQUE INDEX cleaning_norm_kategorie ON cleaning_norm (property_id, kind, category_id)
  WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX cleaning_norm_zimmer ON cleaning_norm (property_id, kind, resource_id)
  WHERE resource_id IS NOT NULL;

ALTER TABLE cleaning_norm ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleaning_norm FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON cleaning_norm USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('cleaning_norm');

ALTER TABLE housekeeping_task
  ADD COLUMN minutes    integer CHECK (minutes IS NULL OR minutes BETWEEN 0 AND 480),
  ADD COLUMN planned_by bigint REFERENCES app_user(id),
  ADD COLUMN planned_at timestamptz,
  ADD COLUMN source     text NOT NULL DEFAULT 'staygrid'
                        CHECK (source IN ('staygrid','legacy'));

-- Der Plan eines Tages je Kraft: so liest ihn die Personal-App (Baustein 3).
CREATE INDEX hk_task_staff_day ON housekeeping_task (assigned_to, business_date)
  WHERE assigned_to IS NOT NULL;

CREATE TABLE housekeeping_task_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  -- Kein Fremdschluessel: der Verlauf ueberlebt die geloeschte Aufgabe, und
  -- genau dann ist er am wichtigsten.
  task_id        bigint NOT NULL,
  resource_id    bigint NOT NULL,
  business_date  date   NOT NULL,
  kind           text   NOT NULL,
  action         text   NOT NULL CHECK (action IN ('created','changed','deleted')),
  assigned_from  bigint,
  assigned_to    bigint,
  minutes_from   integer,
  minutes_to     integer,
  status_from    text,
  status_to      text,
  changed_by     bigint,
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hk_task_log_tag ON housekeeping_task_log (property_id, business_date);

ALTER TABLE housekeeping_task_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE housekeeping_task_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON housekeeping_task_log
  USING (property_id = ANY (app_property_ids()));
SELECT make_append_only('housekeeping_task_log');

/*
 * Je Zeile und nicht je Anweisung: der Trigger rechnet nichts nach, er
 * schreibt eine Zeile mit, und ein Plan hat selten mehr als einige Dutzend
 * Zimmer. Nur was sich wirklich aendert, kommt in den Verlauf -- ein
 * Speichern ohne Aenderung hinterlaesst nichts.
 */
CREATE OR REPLACE FUNCTION housekeeping_task_protokoll() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                       kind, action, assigned_to, minutes_to, status_to,
                                       changed_by)
    VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.business_date, NEW.kind,
            'created', NEW.assigned_to, NEW.minutes, NEW.status, app_user_id());
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.minutes IS DISTINCT FROM OLD.minutes
       OR NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                         kind, action, assigned_from, assigned_to,
                                         minutes_from, minutes_to, status_from, status_to,
                                         changed_by)
      VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.business_date, NEW.kind,
              'changed', OLD.assigned_to, NEW.assigned_to, OLD.minutes, NEW.minutes,
              OLD.status, NEW.status, app_user_id());
    END IF;
  ELSE
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, business_date,
                                       kind, action, assigned_from, minutes_from,
                                       status_from, changed_by)
    VALUES (OLD.property_id, OLD.id, OLD.resource_id, OLD.business_date, OLD.kind,
            'deleted', OLD.assigned_to, OLD.minutes, OLD.status, app_user_id());
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_housekeeping_task_protokoll
  AFTER INSERT OR UPDATE OR DELETE ON housekeeping_task
  FOR EACH ROW EXECUTE FUNCTION housekeeping_task_protokoll();

INSERT INTO permission (key, grp, description) VALUES
  ('housekeeping:plan', 'Housekeeping', 'Reinigungsplan aufstellen und Sollminuten pflegen')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'housekeeping:plan'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key IN ('owner','account_admin','hotel_director','housekeeping')
ON CONFLICT DO NOTHING;
