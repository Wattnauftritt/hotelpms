-- ---------------------------------------------------------------------------
-- 0097 -- Kassenbuch: Stichtag fuer den DATEV-Export.
--
-- Anforderung: Teil 3 des Kassenbuchs (Dokument 09, vierte Fassung). Bis zur
-- Umstellung exportiert das Adminpanel an DATEV, danach StayGrid. Exportieren
-- beide, steht jede Zeile zweimal in der Buchhaltung -- und das faellt dort
-- erst beim Abschluss auf. Die Absprache "nur ein System" haelt deshalb nicht
-- ein Hinweis, sondern dieser Stichtag: ohne ihn, oder vor ihm, weist StayGrid
-- den Export ab.
--
-- Ein Tag und kein Schalter, weil er zugleich festhaelt, ab wann StayGrid
-- verantwortlich war; die Frage stellt der Steuerberater beim ersten Abschluss.
-- ---------------------------------------------------------------------------

ALTER TABLE cashbook_setting ADD COLUMN datev_from date;
