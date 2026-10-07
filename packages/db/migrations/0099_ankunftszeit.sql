-- ---------------------------------------------------------------------------
-- 0099 -- Voraussichtliche Ankunftszeit am Meldeschein.
--
-- Anforderung: Sven, 07.10.2026. Das Meldeformular im Adminpanel fragte den
-- Gast nach seiner ungefaehren Ankunftszeit, und die Rezeption sah sie bei
-- den Anreisen des Tages -- damit sie planen kann, wann wer kommt. Dasselbe
-- jetzt im Online-Check-in, und die Scheine, die das Adminpanel schon
-- eingesammelt hat, bringen ihren Wert bei der Uebernahme mit (0087).
--
-- **Freitext, keine Uhrzeit.** Im Adminpanel stehen Werte wie "16:00",
-- "ca. 18 Uhr" und "zwischen 16 und 17 Uhr" (Auskunft des Adminpanels,
-- 07.10.2026). Eine Spalte vom Typ time haette den groessten Teil davon
-- abgewiesen oder zu einer Genauigkeit gerundet, die der Gast nie
-- angegeben hat. Die Grenze von 255 Zeichen ist die der Spalte dort.
--
-- **Am Meldeschein, nicht an der Reservierung.** Der Gast gibt sie mit dem
-- Schein an, und mit ihm geht sie: ein Jahr nach Abreise (§ 30 Abs. 4 BMG)
-- und bei der Loeschung des Gastes, die den Schein entfernt
-- (guest_erase_one, guest_erase_partial). An der Reservierung bliebe ein
-- Freitext des Gastes acht Jahre stehen, laenger als alles andere, was er
-- selbst geschrieben hat. Nur am Hauptschein; ein Mitreisender kommt mit.
--
-- Freitext aus der Hand des Gastes kann alles enthalten ("komme mit Herrn
-- Mueller und Hund"), deshalb gehoert er nicht ins Protokoll.
-- ---------------------------------------------------------------------------

ALTER TABLE registration
  ADD COLUMN expected_arrival text
    CHECK (expected_arrival IS NULL
           OR (length(expected_arrival) BETWEEN 1 AND 255
               AND expected_arrival = btrim(expected_arrival))),
  ADD CONSTRAINT registration_expected_arrival_haupt
    CHECK (expected_arrival IS NULL OR group_registration_id IS NULL);

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('registration', 'expected_arrival', 'Freitext des Gastes, kann alles enthalten')
ON CONFLICT DO NOTHING;
