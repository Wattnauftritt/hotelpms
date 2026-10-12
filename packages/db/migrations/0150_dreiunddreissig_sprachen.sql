-- ---------------------------------------------------------------------------
-- 0150 Dreiunddreissig Sprachen
--
-- Sven, 12.10.2026: "China, Korea vielleicht noch. Koennen wir arabisch
-- nicht ohne UI-Umbau integrieren?" und "Mach mal alle europaeischen Laender
-- dazu". Zu den vierzehn aus 0146 kommen Finnisch, Islaendisch, Slowakisch,
-- Slowenisch, Ungarisch, Rumaenisch, Bulgarisch, Kroatisch, Serbisch,
-- Mazedonisch, Albanisch, Griechisch, Litauisch, Lettisch, Estnisch,
-- Portugiesisch, Arabisch, Chinesisch und Koreanisch.
--
-- Dieselben Pruefungen wie in 0146, dazu die Uebersetzung der
-- Gaestemappe (0145), die alle Sprachen ausser der deutschen Vorlage nennt.
-- DeepL uebersetzt in jede dieser Sprachen; eine, die es nicht koennte,
-- duerfte hier nicht stehen, sonst bliebe ein Auftrag fuer immer offen.
-- ---------------------------------------------------------------------------

ALTER TABLE app_user DROP CONSTRAINT app_user_locale_wert;
ALTER TABLE app_user ADD CONSTRAINT app_user_locale_wert
  CHECK (locale IS NULL OR locale IN
    ('de','en','nl','da','sv','nb','fi','is','pl','cs','sk','sl','hu','ro','bg','hr','sr','mk','sq','el','lt','lv','et','fr','it','es','pt','tr','ru','uk','ar','zh','ko'));

ALTER TABLE staff_text_job DROP CONSTRAINT staff_text_job_targets_check;
ALTER TABLE staff_text_job ADD CONSTRAINT staff_text_job_targets_check
  CHECK (targets <@ ARRAY['de','en','nl','da','sv','nb','fi','is','pl','cs','sk','sl','hu','ro','bg','hr','sr','mk','sq','el','lt','lv','et','fr','it','es','pt','tr','ru','uk','ar','zh','ko']
         AND cardinality(targets) > 0);

ALTER TABLE staff_text_translation DROP CONSTRAINT staff_text_translation_lang_check;
ALTER TABLE staff_text_translation ADD CONSTRAINT staff_text_translation_lang_check
  CHECK (lang IN ('de','en','nl','da','sv','nb','fi','is','pl','cs','sk','sl','hu','ro','bg','hr','sr','mk','sq','el','lt','lv','et','fr','it','es','pt','tr','ru','uk','ar','zh','ko'));

ALTER TABLE terminal_content_translation DROP CONSTRAINT terminal_content_translation_lang_check;
ALTER TABLE terminal_content_translation ADD CONSTRAINT terminal_content_translation_lang_check
  CHECK (lang IN ('en','nl','da','sv','nb','fi','is','pl','cs','sk','sl','hu','ro','bg','hr','sr','mk','sq','el','lt','lv','et','fr','it','es','pt','tr','ru','uk','ar','zh','ko'));
