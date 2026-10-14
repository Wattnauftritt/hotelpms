-- Fruehstueck inklusive als Regel des Hauses, abwaehlbar je Reservierung
-- (Sven, 14.10.2026: "wenn nicht abgewaehlt ist ja immer Fruehstueck
-- inklusive bei diesem Hotel ... muessen wir in den Einstellungen festlegen,
-- weil das nicht jedes Haus so macht").
--
-- Befund: 0158 kennt das Fruehstueck nur an der Rate. Eine Buchung ohne
-- Rate -- jede aus dem Altsystem und dem Adminpanel -- buchte deshalb die
-- ganze Nacht als Logis zu 7 %, obwohl Fruehstueck darin steckte; die
-- Getraenke zu 19 % fehlten auf der Rechnung.
--
-- Die Reihenfolge: hat die Rate einen eigenen Fruehstueckspreis, gilt er;
-- sonst der des Hauses; ist die Reservierung "ohne Fruehstueck", keiner.
-- Leer am Haus heisst wie an der Rate "nicht enthalten" -- das ist der
-- Stand aller Haeuser, die hier nichts eintragen.

ALTER TABLE property ADD COLUMN breakfast_cent integer
  CHECK (breakfast_cent IS NULL OR breakfast_cent BETWEEN 1 AND 100000);
ALTER TABLE property ADD COLUMN breakfast_child_cent integer
  CHECK (breakfast_child_cent IS NULL OR breakfast_child_cent BETWEEN 0 AND 100000);
ALTER TABLE property ADD CONSTRAINT property_breakfast_child_needs_adult
  CHECK (breakfast_child_cent IS NULL OR breakfast_cent IS NOT NULL);

COMMENT ON COLUMN property.breakfast_cent IS
  'Fruehstueck inklusive, brutto je Person und Nacht, fuer Raten ohne eigenen Preis. Leer: nicht enthalten.';
COMMENT ON COLUMN property.breakfast_child_cent IS
  'Fruehstueck je Kind und Nacht, brutto; 0 frei. Leer: wie Erwachsene.';

-- Abgewaehlt ist die Ausnahme, deshalb der Standard false: eine Buchung,
-- die nichts sagt, folgt Rate und Haus.
ALTER TABLE reservation ADD COLUMN breakfast_declined boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN reservation.breakfast_declined IS
  'Ohne Fruehstueck gebucht: weder Rate noch Haus rechnen es aus dem Nachtpreis heraus.';
