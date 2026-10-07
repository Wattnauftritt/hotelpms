-- ---------------------------------------------------------------------------
-- 0116 Reinigungsbereiche (Aufgabe 18, Nachtrag)
--
-- Sven, 07.10.2026, Thread "Personalsystem in StayGrid": "Es gibt aber das
-- Bad in StayGrid, obwohl das kein angelegtes Zimmer ist?" Die alte App
-- fuehrt neben den Zimmern das Gemeinschaftsbad ("Bad") im Putzplan, mit
-- eigenen Minuten. In StayGrid gab es dafuer keinen Platz: ein `resource`
-- ist ein verkaufbares Zimmer, zaehlt zur Kapazitaet, steht im Kalender und
-- in der Belegungsstatistik. Ein Bad als Zimmer anzulegen haette dem Haus
-- ein Zimmer geschenkt, das niemand buchen kann.
--
-- 1. `cleaning_area`: was gereinigt wird, aber kein Zimmer ist -- ein Bad,
--    ein Flur, ein Fruehstuecksraum. Je Haus, mit Kennung (der Name, den
--    das Personal kennt), Gebaeude fuer die Gehreihenfolge und den
--    Minuten, nach denen abgerechnet wird. Nicht loeschbar, nur
--    abschaltbar: an alten Aufgaben haengen abgerechnete Minuten.
--
-- 2. `housekeeping_task` traegt entweder ein Zimmer oder einen Bereich,
--    nie beides und nie keines. Ein Bereich wird gereinigt wie ein
--    Abreisezimmer, das immer frei ist -- so fuehrte ihn die alte App --,
--    deshalb ist seine Art immer `departure`, und je Bereich und Tag gibt
--    es hoechstens eine Aufgabe. Alles, was an Aufgaben haengt
--    (Personal-App, Kontrolle, Arbeitszeit, Verlauf), traegt den Bereich
--    damit ohne eigene Art mit; was am Zimmer haengt (Zimmerstand,
--    Reservierungen, Reinigungsverzicht), findet fuer ihn schlicht nichts.
--
-- 3. Der Verlauf (0106, 0108, 0109) nimmt den Bereich mit.
--
-- 4. `account_staff_setting.shared`: Reinigung und Fruehstueck fuer alle
--    Haeuser des Betriebs gemeinsam oder je Haus getrennt (Sven,
--    07.10.2026: "Der Betrieb muss einstellen koennen, ob Reinigung und
--    Fruehstueck betriebsuebergreifend ist oder separat pro Haus").
--    Getrennt ist die Vorgabe und der bisherige Stand: das Personal gehoert
--    dem Haus, in dem es seine Rolle hat. Gemeinsam gehoert es dem Betrieb:
--    eine Rolle Reinigung, Kueche oder Hausdame in **einem** Haus wirkt in
--    allen aktiven Haeusern des Betriebs (`user_shared_staff_permissions`),
--    die Hausdame plant alle Haeuser auf einer Seite, die Kueche zaehlt die
--    Fruehstuecke aller Haeuser zusammen.
--
--    Nur diese drei Rollen. Rezeption, Direktion, Buchhaltung bleiben am
--    Haus -- dass das Personal geteilt wird, heisst nicht, dass die
--    Rezeption des Gaestehauses die Rechnungen des Hotels sieht.
--
--    Die Rechte werden bei jeder Anfrage neu geladen (`loadPrincipal`);
--    das Umschalten wirkt deshalb sofort, ohne Sitzungen zu beenden.
-- ---------------------------------------------------------------------------

CREATE TABLE cleaning_area (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint  NOT NULL REFERENCES property(id),
  code         text    NOT NULL CHECK (length(code) BETWEEN 1 AND 20 AND code = btrim(code)),
  building     text    CHECK (building IS NULL
                              OR (length(building) BETWEEN 1 AND 40
                                  AND building = btrim(building))),
  minutes      integer NOT NULL CHECK (minutes BETWEEN 0 AND 480),
  active       boolean NOT NULL DEFAULT true,
  updated_by   bigint  REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

ALTER TABLE cleaning_area ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleaning_area FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON cleaning_area USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('cleaning_area');

ALTER TABLE housekeeping_task
  ALTER COLUMN resource_id DROP NOT NULL,
  ADD COLUMN area_id bigint REFERENCES cleaning_area(id),
  ADD CONSTRAINT housekeeping_task_ziel CHECK (num_nonnulls(resource_id, area_id) = 1),
  ADD CONSTRAINT housekeeping_task_bereich CHECK (area_id IS NULL OR kind = 'departure');

-- Das Gegenstueck zu UNIQUE (resource_id, business_date, kind) fuer
-- Bereiche; dort ist resource_id NULL und zaehlt nie als gleich.
CREATE UNIQUE INDEX hk_task_area_day ON housekeeping_task (area_id, business_date)
  WHERE area_id IS NOT NULL;

ALTER TABLE housekeeping_task_log
  ALTER COLUMN resource_id DROP NOT NULL,
  ADD COLUMN area_id bigint;

-- Stand von 0109 (mit Kontrolle), dazu der Bereich.
CREATE OR REPLACE FUNCTION housekeeping_task_protokoll() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, area_id, business_date,
                                       kind, action, assigned_to, minutes_to, status_to,
                                       outcome_to, inspection_to, changed_by)
    VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.area_id, NEW.business_date, NEW.kind,
            'created', NEW.assigned_to, NEW.minutes, NEW.status, NEW.outcome,
            NEW.inspection, app_user_id());
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.minutes IS DISTINCT FROM OLD.minutes
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.outcome IS DISTINCT FROM OLD.outcome
       OR NEW.inspection IS DISTINCT FROM OLD.inspection THEN
      INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, area_id,
                                         business_date, kind, action, assigned_from,
                                         assigned_to, minutes_from, minutes_to, status_from,
                                         status_to, outcome_from, outcome_to,
                                         inspection_from, inspection_to, changed_by)
      VALUES (NEW.property_id, NEW.id, NEW.resource_id, NEW.area_id, NEW.business_date,
              NEW.kind, 'changed', OLD.assigned_to, NEW.assigned_to, OLD.minutes, NEW.minutes,
              OLD.status, NEW.status, OLD.outcome, NEW.outcome,
              OLD.inspection, NEW.inspection, app_user_id());
    END IF;
  ELSE
    INSERT INTO housekeeping_task_log (property_id, task_id, resource_id, area_id, business_date,
                                       kind, action, assigned_from, minutes_from,
                                       status_from, outcome_from, inspection_from, changed_by)
    VALUES (OLD.property_id, OLD.id, OLD.resource_id, OLD.area_id, OLD.business_date, OLD.kind,
            'deleted', OLD.assigned_to, OLD.minutes, OLD.status, OLD.outcome,
            OLD.inspection, app_user_id());
  END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------- gemeinsam oder getrennt

CREATE TABLE account_staff_setting (
  account_id  bigint  PRIMARY KEY REFERENCES account(id),
  shared      boolean NOT NULL DEFAULT false,
  updated_by  bigint  REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE account_staff_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_staff_setting FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON account_staff_setting USING (account_id = ANY (app_account_ids()));
SELECT attach_audit('account_staff_setting');

/*
 * Die Haeuser, deren Personal und Plan zusammengehoeren: bei getrennt nur
 * das Haus selbst, bei gemeinsam alle aktiven Haeuser des Betriebs, das
 * genannte zuerst. SECURITY DEFINER, weil `property` eine Zeilenrichtlinie
 * traegt und eine Kraft die Schwesterhaeuser erst ueber diese Antwort
 * kennenlernt (die Falle aus 0014 und 0018). Die Funktion liefert nur
 * Kennungen.
 */
CREATE OR REPLACE FUNCTION staff_houses(p_property bigint) RETURNS bigint[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN COALESCE((SELECT s.shared FROM account_staff_setting s
                    JOIN property p ON p.account_id = s.account_id
                   WHERE p.id = p_property), false)
    THEN (SELECT array_agg(q.id ORDER BY q.id <> p_property, q.name, q.id)
            FROM property q
           WHERE q.account_id = (SELECT account_id FROM property WHERE id = p_property)
             AND (q.status = 'active' OR q.id = p_property))
    ELSE ARRAY[p_property]
  END
$$;

/*
 * Was eine Personalrolle in den Schwesterhaeusern mitbringt, wenn der
 * Betrieb gemeinsam arbeitet. Dieselben Sperren wie `user_property_scope`
 * (0040): Haus und Betrieb aktiv, die Person beim Betrieb nicht gesperrt.
 */
CREATE OR REPLACE FUNCTION user_shared_staff_permissions(p_user bigint)
RETURNS TABLE (property_id bigint, account_id bigint, permission_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT q.id, q.account_id, rp.permission_key
    FROM user_property_role upr
    JOIN role ro ON ro.id = upr.role_id
                AND ro.key IN ('housekeeping_staff','kitchen','housekeeping')
    JOIN role_permission rp ON rp.role_id = ro.id
    JOIN property p ON p.id = upr.property_id AND p.status = 'active'
    JOIN account a ON a.id = p.account_id AND a.status = 'active'
    JOIN account_staff_setting s ON s.account_id = a.id AND s.shared
    JOIN property q ON q.account_id = a.id AND q.status = 'active' AND q.id <> p.id
   WHERE upr.user_id = p_user
     AND NOT EXISTS (SELECT 1 FROM account_user_block b
                      WHERE b.account_id = a.id AND b.user_id = p_user)
$$;
