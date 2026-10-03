-- ---------------------------------------------------------------------------
-- 0078 -- Die Nummer aus dem Altsystem, getrennt von der Kanalnummer.
--
-- Anforderung: API-Entwurf fuers Adminpanel (03.10.2026), Abschnitt 3.7 und
-- Baustein 6 (KWHotel-Import). Bisher legte der Import die Altsystemnummer in
-- `booking.external_reference` ab. Dasselbe Feld traegt bei neuen Buchungen
-- die Kanalnummer (RoomCloud, Booking.com) -- bei einer importierten
-- Kanalbuchung haette eine von beiden weichen muessen. Und die Nummer gehoert
-- an die **Reservierung**: KWHotel fuehrt eine Zeile je Zimmer, das
-- Adminpanel kennt jede Zeile unter dieser Nummer, und eine Gruppe aus drei
-- Zimmern ist in StayGrid eine Buchung mit drei Reservierungen.
--
-- **Zwei Spalten statt eines Praefixes.** `kwhotel:35993` in einem Feld
-- muesste jeder Leser wieder zerlegen. Das System steht daneben, damit zwei
-- Altsysteme dieselbe Nummer haben duerfen.
--
-- **Eindeutig je Haus und System.** Daran erkennt ein zweiter Lauf desselben
-- Abzugs -- zur Probe, kurz vor und am Stichtag --, was schon uebernommen ist.
-- Die Pruefung im Import ist bequem; diese hier haelt auch dann, wenn zwei
-- Laeufe gleichzeitig gestartet werden.
--
-- An der Buchung steht die Gruppennummer des Altsystems, damit ein spaeterer
-- Lauf weitere Zimmer derselben Gruppe an dieselbe Buchung haengt.
--
-- Keine Eintraege in `audit_redaction`: eine Belegnummer bezeichnet keinen
-- Menschen, sie bezeichnet eine Buchung.
-- ---------------------------------------------------------------------------

ALTER TABLE reservation ADD COLUMN legacy_system    text;
ALTER TABLE reservation ADD COLUMN legacy_reference text;
ALTER TABLE booking     ADD COLUMN legacy_system    text;
ALTER TABLE booking     ADD COLUMN legacy_reference text;

ALTER TABLE reservation ADD CONSTRAINT reservation_legacy_pair
  CHECK ((legacy_system IS NULL) = (legacy_reference IS NULL));
ALTER TABLE booking ADD CONSTRAINT booking_legacy_pair
  CHECK ((legacy_system IS NULL) = (legacy_reference IS NULL));

CREATE UNIQUE INDEX reservation_legacy ON reservation (property_id, legacy_system, legacy_reference)
  WHERE legacy_reference IS NOT NULL;
CREATE UNIQUE INDEX booking_legacy ON booking (property_id, legacy_system, legacy_reference)
  WHERE legacy_reference IS NOT NULL;

COMMENT ON COLUMN reservation.legacy_reference IS
  'Nummer der Zeile im Altsystem (KWHotel: Rezerwacje.RezerwacjaID). Nicht die Kanalnummer.';
COMMENT ON COLUMN booking.legacy_reference IS
  'Gruppennummer im Altsystem (KWHotel: Rezerwacje.group_id), nur bei Gruppen.';
