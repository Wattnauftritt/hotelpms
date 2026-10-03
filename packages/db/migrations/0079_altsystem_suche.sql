-- ---------------------------------------------------------------------------
-- 0079 -- Die KWHotel-Nummer in der Suche der Rezeption.
--
-- Anforderung: Sven, 03.10.2026, im Thread zum KWHotel-Import. Nach der
-- Umstellung liegen Zettel, Mails und Rueckfragen mit der alten Nummer
-- herum; wer sie eintippt, soll die Buchung finden, ohne den Namen zu
-- kennen.
--
-- Der eindeutige Index aus 0078 beginnt mit (property_id, legacy_system).
-- Die Suche kennt das System nicht -- wer "35993" tippt, sagt nicht dazu,
-- woher die Nummer stammt --, deshalb ein eigener Index ohne die Spalte.
-- ---------------------------------------------------------------------------

CREATE INDEX reservation_legacy_suche ON reservation (property_id, legacy_reference)
  WHERE legacy_reference IS NOT NULL;
