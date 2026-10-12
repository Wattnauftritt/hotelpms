-- ---------------------------------------------------------------------------
-- 0144 Digitale Gaestemappe, Baustein 3: Hausseiten in den Sprachen der Gaeste
--
-- Svens Entscheidung vom 11.10.2026 (Plan gaestemappe/plan.md, Frage 2): die
-- Seiten werden automatisch uebersetzt, mit DeepL wie die Texte des Personals
-- (0112). Deutsch bleibt die Vorlage; eine einzelne Uebersetzung laesst sich
-- von Hand ueberschreiben.
--
--   terminal_content_translation   je Seite und Sprache Titel und Text, dazu
--                                  der Auftrag an den Worker
--
-- **Eine Uebersetzung gehoert zu genau einer deutschen Fassung.** Mitgeschrieben
-- wird der Fingerabdruck von Titel und Text, zu denen sie entstand. Aendert
-- jemand die deutsche Seite, passt er nicht mehr: die Mappe zeigt dann die
-- deutsche Seite, bis die neue Uebersetzung da ist. Eine veraltete
-- Uebersetzung nennt womoeglich die alte Fruehstueckszeit, und ein Gast
-- glaubt einer Seite in seiner Sprache mehr als einer, die er nicht lesen
-- kann.
--
-- **Kein eigener Auftrag beim Speichern.** Faellig ist, was nicht zum
-- Fingerabdruck passt; der Worker findet das selbst. Ein Trigger auf
-- terminal_content, der Auftraege einreiht, waere eine zweite Stelle, die
-- dasselbe weiss -- und die Seiten des Terminals kennen die Mappe nicht.
--
-- Uebersetzt wird nur, was in einer eingeschalteten Mappe steht: eine Seite
-- nur fuer das Terminal liest dort niemand auf Polnisch, und jedes Zeichen
-- kostet Kontingent.
-- ---------------------------------------------------------------------------

-- Fingerabdruck einer Seite. Das Trennzeichen (US, 0x1f) kommt in keinem
-- Titel vor; ohne es haetten "ab"+"c" und "a"+"bc" denselben.
CREATE FUNCTION terminal_content_hash(p_title text, p_body text) RETURNS bytea
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT digest(p_title || chr(31) || p_body, 'sha256')
$$;

CREATE TABLE terminal_content_translation (
  content_id    bigint NOT NULL REFERENCES terminal_content(id) ON DELETE CASCADE,
  property_id   bigint NOT NULL REFERENCES property(id),
  -- Die Sprachen der Mappe ohne die Vorlage (FOLDER_LOCALES).
  lang          text NOT NULL CHECK (lang IN ('en', 'nl', 'pl')),
  -- Laenger als die deutsche Grenze (120, 5000): eine Uebersetzung ist oft
  -- laenger als ihr Original, und abschneiden hiesse einen Satz verlieren.
  title         text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 300),
  body          text CHECK (body IS NULL OR length(body) <= 10000),
  -- Fingerabdruck der deutschen Fassung, zu der title und body gehoeren.
  source_hash   bytea,
  origin        text CHECK (origin IN ('machine', 'manual')),
  updated_by    bigint REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Der Auftrag. pending_hash ist die Fassung, die gerade uebersetzt wird;
  -- die Versuche zaehlen je Fassung, damit eine korrigierte Seite nicht an
  -- den Fehlschlaegen der vorigen haengen bleibt.
  pending_hash  bytea,
  attempts      smallint NOT NULL DEFAULT 0,
  next_at       timestamptz,
  last_error    text,
  PRIMARY KEY (content_id, lang),
  -- Entweder eine ganze Uebersetzung oder noch keine; ein Auftrag allein
  -- (erster Versuch gescheitert) steht ohne Text.
  CONSTRAINT translation_complete CHECK (
    (title IS NULL) = (body IS NULL) AND (title IS NULL) = (source_hash IS NULL)
    AND (title IS NULL) = (origin IS NULL))
);
CREATE INDEX terminal_content_translation_property
  ON terminal_content_translation (property_id);

ALTER TABLE terminal_content_translation ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminal_content_translation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON terminal_content_translation
  USING (property_id = ANY (app_property_ids()));

-- Wie staff_text_translation (0112): wer eine Uebersetzung von Hand
-- geaendert hat, soll nachzulesen sein. Kein Eintrag in audit_redaction --
-- eine Hausseite bezeichnet keinen Menschen und traegt kein Geheimnis; das
-- WLAN-Kennwort steht in guest_folder_setting, nicht auf einer Seite.
SELECT attach_audit('terminal_content_translation');

COMMENT ON TABLE terminal_content_translation IS
  'Uebersetzung einer Seite des Gaesteterminals fuer die Gaestemappe; gilt nur, '
  'solange source_hash zur deutschen Fassung passt.';
