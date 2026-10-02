-- ---------------------------------------------------------------------------
-- 0065 -- Preissteuerung: Regeln, Leitplanken, Laeufe (Dokument 32).
--
-- Anforderung: Stufe 4 aus Dokument 02, "Revenue-Management-Anbindung".
-- Ein Haus soll seine Verkaufspreise nach Belegung, Vorlauf und Kalender
-- steuern lassen -- regelbasiert und nachvollziehbar, kein schwarzer Kasten.
-- Die Funktionen, die rechnen und schreiben, stehen in 0066; hier steht nur,
-- was gespeichert wird, und warum es so geschnitten ist.
--
-- **Die eine Entscheidung, an der alles haengt: der Grundpreis wird nie
-- ueberschrieben.** Eine Steuerung, die ihren eigenen Ausgabewert beim
-- naechsten Lauf wieder als Eingabe nimmt, schaukelt sich auf: +10 % auf
-- 100 Euro sind 110, beim naechsten Lauf 121, dann 133 -- und zwar bei
-- jedem Tick des Workers, ohne dass sich die Belegung bewegt. Deshalb
-- merkt sich `rate_steer_state` je Tag zweierlei: den Grundpreis, von dem
-- der Lauf ausging, und den Preis, den er geschrieben hat. Steht in
-- `rate_day` noch genau der geschriebene Preis, rechnet der naechste Lauf
-- wieder vom gemerkten Grundpreis; steht dort etwas anderes, hat ein Mensch,
-- ein Import oder ein externes RMS den Preis gesetzt, und **das** ist der
-- neue Grundpreis. Der Lauf sieht seinen eigenen Ausgabewert also nie als
-- Eingabe. Keiner der bestehenden Schreiber von `rate_day` (Preispflege,
-- Import, Testhaus) muss dafuer etwas wissen.
--
-- Bewusst **keine** zweite Preisspalte in `rate_day`: jeder Leser dort --
-- ARI, Preisraster, Buchung, abgeleitete Raten -- muesste dann entscheiden,
-- welche er meint, und der erste, der es vergisst, verkauft zum Grundpreis.
-- `rate_day.price_cent` bleibt der Verkaufspreis, sonst nichts.
--
-- Kein personenbezogenes Feld in diesen Tabellen, also kein Eintrag in
-- `audit_redaction`: Plaene, Daten, Betraege, Schwellen. `user_id` am Lauf
-- ist ein Verweis auf das Personal, wie `created_by` an jeder anderen Tabelle.
-- ---------------------------------------------------------------------------

-- Bezugsziel fuer die zusammengesetzten Fremdschluessel unten (wie 0049 fuer
-- rate_plan und product). Bedingt angelegt: wer parallel dieselbe Zusage
-- braucht, soll nicht an einem doppelten Namen scheitern.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'resource_category_id_property_uq') THEN
    ALTER TABLE resource_category
      ADD CONSTRAINT resource_category_id_property_uq UNIQUE (id, property_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Einstellung je Haus. Fehlt die Zeile, gilt der Vorschlagsmodus mit einem
-- Jahr Horizont: wer die Steuerung nie angefasst hat, dem aendert sie nichts.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_steer_setting (
  property_id  bigint PRIMARY KEY REFERENCES property(id),
  -- suggest: die Rezeption sieht Vorschlaege und uebernimmt sie selbst.
  -- auto:    der Worker uebernimmt einmal je Geschaeftstag.
  mode         text NOT NULL DEFAULT 'suggest' CHECK (mode IN ('suggest','auto')),
  -- Obergrenze, nicht Empfehlung: ohne sie waere jeder Lauf ein Selbstangriff
  -- ueber alle materialisierten Tage.
  horizon_days integer NOT NULL DEFAULT 365 CHECK (horizon_days BETWEEN 1 AND 365),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Je Ratenplan: wem der Verkaufspreis gehoert, und welche Leitplanken gelten.
--
-- `source` ist die Antwort auf "wer darf diesen Preis bewegen". manual heisst
-- wie bisher: Menschen und jede Schnittstelle. rules heisst: die Steuerung;
-- Menschen setzen den Grundpreis, ein externes RMS wird abgewiesen. external
-- heisst: ein RMS ueber `PUT /v1/rates/bulk`; die Regeln lassen den Plan in
-- Ruhe. Ohne diese Angabe ueberschrieben sich interne Regeln und ein
-- externes RMS gegenseitig, jedes mit gutem Gewissen und im Wechsel.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_plan_steering (
  rate_plan_id bigint PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  source       text NOT NULL DEFAULT 'manual'
               CHECK (source IN ('manual','rules','external')),
  -- Leitplanken in Cent. Sie begrenzen, was die Regeln tun; den Grundpreis
  -- selbst fassen sie nicht an (Dokument 32, Abschnitt 4).
  min_cent     bigint CHECK (min_cent >= 0),
  max_cent     bigint CHECK (max_cent >= 0),
  -- none: centgenau. euro: volle Euro. ninety: auf ,90.
  rounding     text NOT NULL DEFAULT 'euro' CHECK (rounding IN ('none','euro','ninety')),
  -- Hoechste Aenderung je Lauf in Basispunkten des aktuellen Preises.
  -- Mindestens ein Prozent: darunter bewegte sich ein gerundeter Preis nie.
  max_step_bp  integer CHECK (max_step_bp BETWEEN 100 AND 10000),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_plan_steering_min_max CHECK (
    min_cent IS NULL OR max_cent IS NULL OR min_cent <= max_cent),
  -- Ein Plan aus Haus A mit einer Steuerung in Haus B kann nicht entstehen,
  -- nicht nur nicht gelesen werden (Begruendung wie 0049).
  CONSTRAINT rate_plan_steering_plan_fkey FOREIGN KEY (rate_plan_id, property_id)
    REFERENCES rate_plan (id, property_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Regeln. Eine Regel hat einen Ausloeser (`kind`) und darf weitere
-- Bedingungen tragen, die alle zugleich gelten muessen: "Anreise in weniger
-- als drei Tagen **und** Belegung unter 40 %" ist eine Vorlaufregel mit
-- Belegungsbedingung.
--
-- Je Ausloeser wirkt an einem Tag nur die **staerkste** passende Regel; die
-- Ausloeser untereinander addieren sich. Sonst ergaeben zwei Belegungsstufen
-- "ab 70 % +10 %" und "ab 85 % +20 %" bei 90 % zusammen +30 %, und niemand
-- haette das so gemeint. Gerechnet wird immer auf den Grundpreis.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_steer_rule (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  -- Beide leer: alle gesteuerten Plaene des Hauses. Ein Plan bestimmt seine
  -- Kategorie, deshalb hoechstens eines von beiden.
  rate_plan_id       bigint,
  category_id        bigint,
  -- Eine Bezeichnung fuer Menschen ("Messe", "Last Minute"). Kein Gastdatum.
  name               text CHECK (name IS NULL OR length(name) <= 80),
  kind               text NOT NULL
                     CHECK (kind IN ('occupancy','lead_time','weekday','period')),
  -- Belegung in Basispunkten: 8500 = 85 %. Ganzzahlig, damit die Schwelle
  -- nicht an einer Fliesskommadarstellung von 0,85 haengt.
  occupancy_scope    text NOT NULL DEFAULT 'category'
                     CHECK (occupancy_scope IN ('category','house')),
  occupancy_min_bp   integer CHECK (occupancy_min_bp BETWEEN 0 AND 20000),
  occupancy_below_bp integer CHECK (occupancy_below_bp BETWEEN 1 AND 20000),
  -- Vorlauf in Tagen zwischen Geschaeftstag und Aufenthaltstag.
  lead_min_days      integer CHECK (lead_min_days BETWEEN 0 AND 365),
  lead_below_days    integer CHECK (lead_below_days BETWEEN 1 AND 366),
  -- Wochentage, Montag = 0, wie in der Preispflege (rates.ts).
  weekdays           smallint[],
  period_from        date,
  period_to          date,
  -- percent in Basispunkten (2000 = +20 %), amount in Cent. Beides mit
  -- Vorzeichen, beides ganzzahlig.
  effect_kind        text NOT NULL CHECK (effect_kind IN ('percent','amount')),
  effect_value       integer NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  -- Geloeschte Regeln bleiben stehen: der Verlauf nennt sie weiter beim Namen.
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_steer_rule_plan_fkey FOREIGN KEY (rate_plan_id, property_id)
    REFERENCES rate_plan (id, property_id),
  CONSTRAINT rate_steer_rule_category_fkey FOREIGN KEY (category_id, property_id)
    REFERENCES resource_category (id, property_id),
  CONSTRAINT rate_steer_rule_one_target CHECK (
    rate_plan_id IS NULL OR category_id IS NULL),
  CONSTRAINT rate_steer_rule_occupancy CHECK (
    kind <> 'occupancy' OR occupancy_min_bp IS NOT NULL OR occupancy_below_bp IS NOT NULL),
  CONSTRAINT rate_steer_rule_lead CHECK (
    kind <> 'lead_time' OR lead_min_days IS NOT NULL OR lead_below_days IS NOT NULL),
  CONSTRAINT rate_steer_rule_weekday CHECK (kind <> 'weekday' OR weekdays IS NOT NULL),
  CONSTRAINT rate_steer_rule_period CHECK (
    kind <> 'period' OR (period_from IS NOT NULL AND period_to IS NOT NULL)),
  CONSTRAINT rate_steer_rule_period_order CHECK (
    (period_from IS NULL) = (period_to IS NULL)
    AND (period_from IS NULL OR period_from <= period_to)),
  CONSTRAINT rate_steer_rule_weekdays_valid CHECK (
    weekdays IS NULL OR (cardinality(weekdays) BETWEEN 1 AND 7
                         AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[])),
  CONSTRAINT rate_steer_rule_occupancy_order CHECK (
    occupancy_min_bp IS NULL OR occupancy_below_bp IS NULL
    OR occupancy_min_bp < occupancy_below_bp),
  CONSTRAINT rate_steer_rule_lead_order CHECK (
    lead_min_days IS NULL OR lead_below_days IS NULL OR lead_min_days < lead_below_days),
  -- -90 % bis +200 %, hoechstens 1000 Euro: was darueber liegt, ist ein
  -- Tippfehler und kein Revenue Management.
  CONSTRAINT rate_steer_rule_effect CHECK (effect_value <> 0 AND (
    (effect_kind = 'percent' AND effect_value BETWEEN -9000 AND 20000) OR
    (effect_kind = 'amount'  AND effect_value BETWEEN -100000 AND 100000)))
);
CREATE INDEX rate_steer_rule_property ON rate_steer_rule (property_id)
  WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Laeufe. Ein automatischer Lauf je Haus und Geschaeftstag -- der eindeutige
-- Index ist die Wiederholbarkeit: ein zweiter Worker, ein Neustart, ein
-- zweiter Tick finden die Zeile vor und tun nichts. Eine Uebernahme aus der
-- Vorschau (`apply`) ist ein eigener Lauf, so oft wie jemand uebernimmt.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_steer_run (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  business_date date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('auto','apply')),
  mode          text NOT NULL CHECK (mode IN ('suggest','auto')),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  -- NULL beim Worker. Wer uebernommen hat, steht nur hier: `rate_day` hat
  -- keinen Audit-Trigger, das Protokoll wuesste es nicht.
  user_id       bigint REFERENCES app_user(id),
  changed_days  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rate_steer_run_auto_once ON rate_steer_run (property_id, business_date)
  WHERE kind = 'auto';
CREATE INDEX rate_steer_run_property ON rate_steer_run (property_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Was ein Lauf geaendert hat: Plan, Tag, alt -> neu, Grundpreis, Regeln,
-- Belegung. Unveraenderlich -- ein Verlauf, den man nachtraeglich glaetten
-- kann, beantwortet die Frage "warum stand am Freitag 149 Euro" nicht.
--
-- Eine eigene Tabelle und nicht `audit_log`: `rate_day` hat bewusst keinen
-- Audit-Trigger (eine Jahrespflege sind 365 Zeilen je Plan), und das
-- Protokoll kennte die Regel nicht, die den Preis bewegt hat.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_steer_change (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES rate_steer_run(id),
  property_id   bigint NOT NULL,
  rate_plan_id  bigint NOT NULL,
  date          date NOT NULL,
  old_cent      bigint[],
  new_cent      bigint[] NOT NULL,
  base_cent     bigint[] NOT NULL,
  rule_ids      bigint[] NOT NULL DEFAULT '{}',
  occupancy_bp  integer,
  CONSTRAINT rate_steer_change_plan_fkey FOREIGN KEY (rate_plan_id, property_id)
    REFERENCES rate_plan (id, property_id)
);
CREATE INDEX rate_steer_change_run ON rate_steer_change (run_id);
CREATE INDEX rate_steer_change_day ON rate_steer_change (rate_plan_id, date);
SELECT make_append_only('rate_steer_change');

-- ---------------------------------------------------------------------------
-- Der Gedaechtnisstand je Plan und Tag (siehe Kopf). Abgeleitet aus dem
-- letzten Lauf, deshalb veraenderlich und ohne eigenen Verlauf -- der steht
-- in rate_steer_change.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_steer_state (
  rate_plan_id  bigint NOT NULL,
  date          date NOT NULL,
  property_id   bigint NOT NULL,
  base_cent     bigint[] NOT NULL,
  applied_cent  bigint[] NOT NULL,
  PRIMARY KEY (rate_plan_id, date),
  CONSTRAINT rate_steer_state_plan_fkey FOREIGN KEY (rate_plan_id, property_id)
    REFERENCES rate_plan (id, property_id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rate_steer_setting','rate_plan_steering','rate_steer_rule',
                           'rate_steer_run','rate_steer_change','rate_steer_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

-- Wer Regeln, Leitplanken oder den Modus aendert, steht im Protokoll: das
-- sind die Stellschrauben, die den Umsatz des Hauses bewegen.
SELECT attach_audit('rate_steer_setting');
SELECT attach_audit('rate_plan_steering');
SELECT attach_audit('rate_steer_rule');

-- ---------------------------------------------------------------------------
-- Ein eigenes Recht. `rate:write` setzt einen Preis; `rate:steer` setzt die
-- Regeln, nach denen sich Preise **ohne weiteres Zutun** bewegen, und schaltet
-- auf automatisch. Das ist eine andere Groessenordnung: ein Tippfehler in
-- einer Regel verkauft ein Jahr lang falsch, und niemand sieht hin, weil
-- niemand mehr Preise pflegt.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, grp, description) VALUES
  ('rate:steer', 'Raten', 'Preissteuerung: Regeln, Leitplanken, automatischer Modus')
ON CONFLICT DO NOTHING;

-- Nachgetragen wie email:send in 0028: die Sammelvergabe in 0003 kannte
-- dieses Recht noch nicht. Revenue ist die Rolle, fuer die es gemacht ist;
-- Empfangsleitung und Rezeption bekommen es bewusst nicht.
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'rate:steer'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key IN ('owner', 'account_admin', 'hotel_director', 'revenue')
ON CONFLICT DO NOTHING;
