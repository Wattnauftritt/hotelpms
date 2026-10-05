-- ---------------------------------------------------------------------------
-- 0090 -- Verkaufscode je Zimmer, unabhaengig von der Zimmergruppe.
--
-- Anforderung: Sven, 05.10.2026, ueber das Adminpanel. Zimmer 8
-- (Familienzimmer) und 9 (Apartment) bleiben in einer Zimmergruppe "Apart",
-- wie frueher in KWHotel; RoomCloud verkauft sie aber als zwei Kategorien,
-- FZ und Apt, je ein Zimmer. StayGrid zaehlt Bestand je Gruppe und konnte
-- die beiden nicht unterscheiden: das Adminpanel meldete Zimmer 8 dauerhaft
-- als frei.
--
-- Warum nicht zwei Gruppen. Die Gruppe ist das, was die Rezeption plant und
-- wofuer die Raten gelten; Sven will sie behalten. Der Verkaufscode ist nur
-- das Etikett, unter dem ein Kanal das Zimmer verkauft.
--
-- Der Bestand (`inventory_day`) bleibt je Gruppe. Gebunden wird weiter
-- gegen die Gruppe; der Code sagt, welchem Verkaufsposten eine Belegung
-- gehoert, und wird beim Abruf gezaehlt (`/availability?by=salesCode`).
-- ---------------------------------------------------------------------------

ALTER TABLE resource
  ADD COLUMN sales_code text
    CHECK (sales_code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$');

-- Eine Buchung ohne Zimmer -- vom Kanal oder auf eine Gruppe -- traegt den
-- gebuchten Code. Mit Zimmer gilt der Code des Zimmers.
ALTER TABLE reservation
  ADD COLUMN sales_code text
    CHECK (sales_code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$');
