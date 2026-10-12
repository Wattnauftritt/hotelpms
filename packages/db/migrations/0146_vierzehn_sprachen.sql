-- ---------------------------------------------------------------------------
-- 0146 Vierzehn Sprachen im ganzen System
--
-- Sven, 12.10.2026: "erweitere im gesamten System unser i18n und die
-- Uebersetzungen auf alle hier gaengigen Sprachen inkl. russisch,
-- ukrainisch, tuerkisch, alle angrenzenden und grossen Laender".
--
-- Oberflaeche, Gastpost und Personal-App sprechen seitdem dieselben
-- vierzehn Sprachen (`LOCALES` in packages/contracts/src/messages.ts). Drei
-- Pruefungen in der Datenbank nannten die alten Listen und haetten eine
-- neue Wahl still abgewiesen:
--
--   app_user.locale                 Sprache, die die Person selbst waehlt (0105)
--   staff_text_job.targets          Zielsprachen fuer DeepL (0112)
--   staff_text_translation.lang     die Uebersetzung daneben (0112)
--
-- Die Liste steht hier ausgeschrieben und nicht als Funktion: eine
-- CHECK-Bedingung soll ohne einen Blick in eine zweite Stelle lesbar sein,
-- und eine neue Sprache ist ohnehin eine neue Migration.
-- ---------------------------------------------------------------------------

ALTER TABLE app_user DROP CONSTRAINT app_user_locale_wert;
ALTER TABLE app_user ADD CONSTRAINT app_user_locale_wert
  CHECK (locale IS NULL OR locale IN
    ('de','en','nl','da','sv','nb','pl','cs','fr','it','es','tr','ru','uk'));

ALTER TABLE staff_text_job DROP CONSTRAINT staff_text_job_targets_check;
ALTER TABLE staff_text_job ADD CONSTRAINT staff_text_job_targets_check
  CHECK (targets <@ ARRAY['de','en','nl','da','sv','nb','pl','cs','fr','it','es','tr','ru','uk']
         AND cardinality(targets) > 0);

ALTER TABLE staff_text_translation DROP CONSTRAINT staff_text_translation_lang_check;
ALTER TABLE staff_text_translation ADD CONSTRAINT staff_text_translation_lang_check
  CHECK (lang IN ('de','en','nl','da','sv','nb','pl','cs','fr','it','es','tr','ru','uk'));
