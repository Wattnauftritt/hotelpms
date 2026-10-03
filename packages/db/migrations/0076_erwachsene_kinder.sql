-- ---------------------------------------------------------------------------
-- 0076 -- Erwachsene und Kinder an der Reservierung.
--
-- Anforderung: API-Entwurf fuers Adminpanel (03.10.2026), Abschnitt 3.3. Das
-- Adminpanel rechnet aus der Personenzahl je Nacht das Fruehstueck, und ein
-- Kanal liefert die Zahl ohnehin getrennt. `guest_count` (0054) ist nur die
-- Summe; wer sie getrennt braucht, konnte sie bisher nirgends ablegen.
--
-- **Nullbar wie `guest_count`, aus demselben Grund.** Leer heisst "nicht
-- gesagt", und dieser Unterschied geht mit einer Vorgabe fuer immer
-- verloren. Bestehende Zeilen bleiben leer: aus "drei Personen" laesst sich
-- nicht ablesen, wie viele davon Kinder sind.
--
-- **`guest_count` bleibt, und es ist die Summe.** Kurtaxe, Belegungsplan und
-- jeder bisherige Leser arbeiten mit der Gesamtzahl weiter; die Bedingung
-- unten haelt fest, dass beide Angaben nicht auseinanderlaufen. Wer nur
-- eine Gesamtzahl kennt -- die Rezeption am Telefon --, setzt nur sie.
--
-- **Kinder nur mit Erwachsenen.** Eine Kinderzahl allein ergaebe keine
-- Summe, und eine Reservierung nur aus Kindern ist ein Tippfehler.
--
-- Altersgruppen bleiben vorerst weg (Antwort des Adminpanels, 03.10.). Wer
-- sie spaeter braucht, haengt sie an, ohne diese beiden Felder zu aendern.
--
-- Keine Eintraege in `audit_redaction`: eine Anzahl bezeichnet keinen
-- Menschen.
-- ---------------------------------------------------------------------------

ALTER TABLE reservation ADD COLUMN adults   integer;
ALTER TABLE reservation ADD COLUMN children integer;

COMMENT ON COLUMN reservation.adults IS
  'Erwachsene. Leer heisst: nicht getrennt angegeben. Mit children zusammen gleich guest_count.';
COMMENT ON COLUMN reservation.children IS
  'Kinder. Leer heisst: nicht angegeben. Nur zusammen mit adults.';

ALTER TABLE reservation ADD CONSTRAINT reservation_adults_check
  CHECK (adults IS NULL OR (adults >= 1 AND adults <= 99));
ALTER TABLE reservation ADD CONSTRAINT reservation_children_check
  CHECK (children IS NULL OR (children >= 0 AND children <= 98));
ALTER TABLE reservation ADD CONSTRAINT reservation_children_need_adults
  CHECK (children IS NULL OR adults IS NOT NULL);
ALTER TABLE reservation ADD CONSTRAINT reservation_persons_sum
  CHECK (adults IS NULL OR guest_count = adults + COALESCE(children, 0));
