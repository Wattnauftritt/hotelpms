-- ---------------------------------------------------------------------------
-- 0119 Altdaten: eine Zusatzarbeit darf ueber einen Tag hinausgehen
--
-- Svens erster echter Export der alten App (10.10.2026) scheiterte an einer
-- einzigen Zeile: am 31.08.2025 steht "Uneingetragenes" mit 4080 Minuten --
-- die Stunden eines Monats, die vor dem Start der App nicht erfasst waren,
-- als Sammelbuchung am Monatsende. Die alte App hat den Wert angenommen und
-- abgerechnet; 0111 laesst nur 1440 Minuten (einen Tag) zu, und der Import
-- wies deshalb die ganze Datei ab.
--
-- Fuer Eintraege aus StayGrid bleibt es bei einem Tag: wer selbst eintraegt,
-- traegt einen Tag ein. Fuer Altdaten gilt hoechstens ein Monat -- die Zeile
-- wird uebernommen, wie sie abgerechnet wurde, und nicht aufgeteilt, damit
-- sie in StayGrid genauso aussieht wie in der alten App.
-- ---------------------------------------------------------------------------

ALTER TABLE staff_work_entry DROP CONSTRAINT staff_work_entry_minutes_check;
ALTER TABLE staff_work_entry ADD CONSTRAINT staff_work_entry_minutes_check CHECK (
  minutes <> 0
  AND minutes BETWEEN -1440 AND CASE WHEN source = 'legacy' THEN 44640 ELSE 1440 END);
