-- ---------------------------------------------------------------------------
-- 0145 Gaestemappe: Hausseiten in alle vierzehn Sprachen uebersetzen
--
-- Sven, 12.10.2026: die Sprachen im ganzen System auf vierzehn erweitert
-- (0146, `LOCALES` in packages/contracts/src/messages.ts). Die Mappe bietet
-- seitdem alle vierzehn an, uebersetzte die Seiten des Hauses aber nur ins
-- Englische, Niederlaendische und Polnische (0144). Ein Gast, der Daenisch
-- waehlt, saehe die Knoepfe daenisch und darunter die Seiten deutsch.
--
-- Die Liste steht ausgeschrieben wie in 0146: eine CHECK-Bedingung soll
-- ohne einen Blick in eine zweite Stelle lesbar sein.
--
-- Diese Nummer liegt vor 0146 und 0147, die zuerst gemergt wurden; zwischen
-- unabhaengigen Migrationen ist die Reihenfolge beliebig (CLAUDE.md).
-- ---------------------------------------------------------------------------

ALTER TABLE terminal_content_translation DROP CONSTRAINT terminal_content_translation_lang_check;
ALTER TABLE terminal_content_translation ADD CONSTRAINT terminal_content_translation_lang_check
  CHECK (lang IN ('en','nl','da','sv','nb','pl','cs','fr','it','es','tr','ru','uk'));
