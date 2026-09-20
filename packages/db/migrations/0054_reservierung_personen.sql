-- ---------------------------------------------------------------------------
-- 0054 -- Wie viele Personen wirklich anreisen.
--
-- Aus der Durchsicht des Belegungsplans: "die Maske braucht ein Feld fuer
-- Personen, da Zimmer nicht immer mit der maximal moeglichen Personenzahl
-- belegt werden".
--
-- **Warum das nicht schon ueber reservation_occupant geht.** Dort stehen
-- Menschen mit Namen, fuer den Meldeschein. Die Liste ist bei der Anlage
-- fast immer unvollstaendig: eine Buchung aus dem Kanal traegt genau einen
-- Belegten, den Bucher, auch wenn zwei anreisen. Sie als Personenzahl zu
-- lesen ergibt deshalb systematisch zu kleine Zahlen -- und zwar still.
--
-- **Und warum nicht die Kategorie.** Bisher gilt `max_occupancy` als Mass:
-- was verkauft wurde, ein Doppelzimmer bleibt fuer zwei verkauft. Das ist
-- fuer die Kapazitaet richtig und fuer die Kurtaxe falsch. Zwei Menschen in
-- einem Vierbettzimmer zahlen fuer zwei.
--
-- Also eine eigene Spalte, und sie darf leer bleiben. Leer heisst "nicht
-- gesagt", und dann gilt weiter, was verkauft wurde -- genau das heutige
-- Verhalten. Ein NOT NULL mit Vorgabe haette jede bestehende Zeile auf eine
-- Zahl festgelegt, die niemand geprueft hat, und der Unterschied zwischen
-- "zwei Personen" und "keine Angabe" waere fuer immer weg.
-- ---------------------------------------------------------------------------

ALTER TABLE reservation ADD COLUMN guest_count integer;

COMMENT ON COLUMN reservation.guest_count IS
  'Wie viele Personen anreisen. Leer heisst: nicht angegeben, dann gilt die '
  'Belegung der Kategorie. Nicht die Zahl der Meldescheine.';

/*
 * Null Personen sind keine Reservierung, und eine dreistellige Zahl ist ein
 * Tippfehler. Die Obergrenze ist bewusst grosszuegig und nicht die
 * Belegung der Kategorie: eine Ueberbelegung ist erlaubt, sie braucht nur
 * eine Rueckfrage -- ein Kleinkind im Doppelzimmer ist der Normalfall, kein
 * Fehler. Die Rueckfrage sitzt in der Oberflaeche, die Grenze hier faengt
 * nur den verrutschten Finger.
 */
ALTER TABLE reservation ADD CONSTRAINT reservation_guest_count_check
  CHECK (guest_count IS NULL OR (guest_count >= 1 AND guest_count <= 99));
