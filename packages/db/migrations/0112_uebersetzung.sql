-- ---------------------------------------------------------------------------
-- 0112 Uebersetzung freier Texte des Personals (Aufgabe 18, Baustein 7)
--
-- Das Personal schreibt in seiner Sprache, die Leitung liest Deutsch (Sven,
-- 07.10.2026: "manuell eingetragene Taetigkeiten werden automatisch
-- zurueckuebersetzt"). Drei Texte:
--
--   work_entry       Zusatzarbeit oder Kuechendienst der Kraft  -> de
--   problem          Problem am Zimmer, aus der Personal-App    -> de
--   inspection_note  "nacharbeiten" der Hausdame               -> Sprache der Kraft
--
-- Uebersetzt wird im Hintergrund (Worker, DeepL), nicht beim Lesen: die
-- alte App uebersetzte synchron beim ersten Abruf, und dann wartete die
-- Leitung auf einen fremden Dienst, bevor sie ihre Liste sah. Das Original
-- bleibt immer, die Uebersetzung steht daneben.
--
-- `source_hash` ist der Fingerabdruck des Textes, der uebersetzt wurde. Die
-- alte App liess eine alte Uebersetzung stehen, wenn der Text spaeter
-- geaendert wurde; hier wird neu uebersetzt, sobald der Fingerabdruck nicht
-- mehr passt -- auch ueber eine Korrektur von Hand hinweg, denn die galt
-- dem alten Text.
--
-- **Nur ausdruecklich eingereiht.** Die Routen der Personal-App reihen ein,
-- kein Trigger auf `maintenance_ticket`: eine Meldung der Rezeption kann
-- einen Gastnamen tragen und hat bei einem Uebersetzungsdienst nichts
-- verloren. Ohne `DEEPL_API_KEY` bleibt die Warteschlange stehen, und jeder
-- liest das Original.
-- ---------------------------------------------------------------------------

CREATE TABLE staff_text_job (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  source_kind   text   NOT NULL CHECK (source_kind IN ('work_entry','problem','inspection_note')),
  source_id     bigint NOT NULL,
  targets       text[] NOT NULL CHECK (targets <@ ARRAY['de','en','ru','uk']
                                       AND cardinality(targets) > 0),
  status        text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  next_at       timestamptz NOT NULL DEFAULT now(),
  -- Nur ein Code oder ein Status des Dienstes, nie der Text.
  last_error    text CHECK (last_error IS NULL OR length(last_error) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id)
);
CREATE INDEX staff_text_job_faellig ON staff_text_job (property_id, next_at)
  WHERE status = 'pending';

CREATE TABLE staff_text_translation (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  source_kind   text   NOT NULL CHECK (source_kind IN ('work_entry','problem','inspection_note')),
  source_id     bigint NOT NULL,
  source_hash   bytea  NOT NULL,
  source_lang   text,
  lang          text   NOT NULL CHECK (lang IN ('de','en','ru','uk')),
  text          text   NOT NULL CHECK (length(text) <= 4000),
  origin        text   NOT NULL CHECK (origin IN ('machine','manual')),
  updated_by    bigint REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id, lang)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_text_job','staff_text_translation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('staff_text_translation');

-- Die Uebersetzung ist derselbe Text wie das Original, nur in einer anderen
-- Sprache -- und das Original steht schon in der Redaktionsliste (0111).
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('staff_text_translation', 'text', 'Uebersetzung eines Personaltextes'),
  ('housekeeping_task', 'inspection_note', 'Freitext der Hausdame'),
  ('maintenance_ticket', 'title', 'Freitext, kann einen Namen tragen'),
  ('maintenance_ticket', 'description', 'Freitext, kann einen Namen tragen')
ON CONFLICT DO NOTHING;
