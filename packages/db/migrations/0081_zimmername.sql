-- ---------------------------------------------------------------------------
-- 0081 -- Ein Zimmer darf neben seiner Nummer einen Namen tragen.
--
-- Anforderung: Sven, 04.10.2026. Ein Haus nennt seine Zimmer nicht nur
-- "12", sondern "Kapitaenskajuete" oder "Duenenblick", und so fragt der Gast
-- am Telefon danach.
--
-- Die Nummer bleibt die Kennung: sie ist eindeutig im Haus, die Schnittstellen
-- (Reinigungssystem, KWHotel-Uebernahme) ordnen danach zu. Der Name ist eine
-- Beschriftung daneben, ohne Eindeutigkeit -- zwei "Doppelzimmer Meerblick"
-- sind kein Fehler. NULL statt Leertext, damit "kein Name" eine Aussage ist
-- und nicht ein Leerzeichen, das am Plan eine leere Zeile zeichnet.
--
-- Der Name bezeichnet ein Zimmer, keinen Menschen; audit_redaction bleibt
-- unberuehrt.
-- ---------------------------------------------------------------------------

ALTER TABLE resource ADD COLUMN name text
  CHECK (name IS NULL OR (length(name) BETWEEN 1 AND 60 AND name = btrim(name)));
