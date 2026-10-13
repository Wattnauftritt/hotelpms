-- Weitere Inklusivleistungen einer Rate: Parken, Getraenk zur Begruessung,
-- Wellness (Pruefung Rechnungssystem 13.10.2026, Befund 3, Nachtrag: "Parken
-- und andere Inklusivleistungen sind weiterhin nicht aufgeteilt").
--
-- Das Datenmodell gab es seit 0007: `product` mit Preis, Steuerregel und
-- Abrechnungsart, verknuepft ueber `rate_plan_product`. Die Anzahlung rechnet
-- schon damit (`erwarteteSaetze`), der Nachtlauf nicht -- er buchte den
-- ganzen Nachtpreis als Logis zu 7 %, auch wenn ein Stellplatz zu 19 % darin
-- steckte. Damit wies die Anzahlungsrechnung andere Saetze aus als die
-- Schlussrechnung.
--
-- Neu ist nur die Markierung: ein herausgerechneter Teil traegt
-- package_part 'inclusion'. Wie beim Fruehstueck haelt sie ihn aus dem
-- Zimmerumsatz der Kennzahlen, aus der Einheit DAY im XML, und das Storno
-- einer Nichtanreise nimmt ihn mit (alle drei fragen nur
-- `package_part IS NOT NULL`).

ALTER TABLE charge DROP CONSTRAINT charge_package_part_check;
ALTER TABLE charge ADD CONSTRAINT charge_package_part_check
  CHECK (package_part IN ('breakfast_food', 'breakfast_drinks', 'inclusion'));
