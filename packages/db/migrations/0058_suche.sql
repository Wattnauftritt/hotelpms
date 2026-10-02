-- ---------------------------------------------------------------------------
-- 0058 -- Indizes fuer die Suche der Rezeption.
--
-- Anforderung: Schnellsuche im Belegungsplan und Detailsuche hinter Strg+K
-- (`GET /v1/properties/:propertyId/search`) -- nach Reservierungs- und
-- Buchungsnummer, nach der Nummer des Kanals, nach Gast und Begleitperson.
--
-- Gemessen gegen das Saatlaufhaus (214 000 Reservierungen, 60 000 Gaeste),
-- ergaenzt um 300 000 Belegte und 800 Firmen, die der Saatlauf nicht
-- anlegt. Vorher je Tastendruck 120 bis 250 ms, fast alles in drei
-- sequentiellen Scans; die Zahlen danach stehen in Dokument 16.
--
-- **Warum `text_pattern_ops` und `^@` statt `LIKE`.** Die Tabellen stehen
-- unter einer erzwungenen Zeilenrichtlinie. Eine Bedingung des Aufrufers
-- darf nur dann als Indexbedingung vor der Richtlinie laufen, wenn ihr
-- Operator LEAKPROOF ist -- sonst koennte sie ueber eine Fehlermeldung
-- Werte fremder Zeilen verraten, bevor die Richtlinie sie aussortiert hat.
-- `LIKE` ist es nicht, `starts_with` (`^@`) schon, ebenso die Vergleiche
-- der Musteroperatorklasse, in die der Planer `^@` zerlegt. Mit `LIKE`
-- blieb der vorhandene eindeutige Index auf `public_ref` deshalb ungenutzt,
-- auch dort, wo die Sortierfolge ihn zuliesse.
--
-- `text_pattern_ops` und nicht die Sortierfolge der Datenbank, weil eine
-- Anfangssuche byteweise vergleichen muss: in einer sprachlichen
-- Sortierfolge liegt "AB-C" neben "ABC", und ein Bereich von "AB" bis "AC"
-- verfehlt Nummern, die mit "AB-" beginnen.
-- ---------------------------------------------------------------------------

-- Reservierungs- und Buchungsnummer von vorn. Ohne Hausspalte: die Nummer
-- ist ueber alle Mandanten eindeutig, ab drei Zeichen bleiben eine Handvoll
-- Zeilen, und die Hausbedingung prueft danach jede einzelne.
CREATE INDEX reservation_public_ref_prefix ON reservation (public_ref text_pattern_ops);
CREATE INDEX booking_public_ref_prefix     ON booking (public_ref text_pattern_ops);

-- Die Nummer des Kanals ist nur je Haus eindeutig (0023) und wird hier
-- genauso gesucht.
CREATE INDEX booking_external_prefix ON booking (property_id, external_reference text_pattern_ops)
  WHERE external_reference IS NOT NULL;

-- Die Begleitperson: von einem Gast zu seinen Aufenthalten. Bisher gab es
-- nur den Weg von der Reservierung zu ihren Belegten; die Suche las dafuer
-- jede Zeile der Tabelle (150 ms von 250). Dieselbe Richtung braucht die
-- Zahl der Aufenthalte an einem Kundentreffer.
CREATE INDEX occupant_guest ON reservation_occupant (guest_id)
  WHERE guest_id IS NOT NULL;

-- Was eine Firma gebucht hat, fuer die Zahl am Kundentreffer. Nur die
-- Buchungen mit Firma, das ist im Betrieb ein kleiner Teil.
CREATE INDEX booking_booker_company ON booking (booker_company_id)
  WHERE booker_company_id IS NOT NULL;
