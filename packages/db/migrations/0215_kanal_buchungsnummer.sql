-- ---------------------------------------------------------------------------
-- 0215 Buchungsnummer des Portals an der Buchung
--
-- Anlass (Sven, 27.10.2026): Booking.com stellt die Einladung zum
-- Online-Check-in an seine Weiterleitungsadressen nicht zu, auch nicht mit
-- einer Zwischenseite vor dem Formular (#384). Gaeste von Booking.com sollen
-- den Meldeschein deshalb ueber einen festen Link in einer Nachrichtenvorlage
-- von Booking.com erreichen und sich dort mit Buchungsnummer und Anreisetag
-- ausweisen.
--
-- Dafuer muss StayGrid die Nummer kennen, unter der das Portal die Buchung
-- fuehrt. `booking.external_reference` ist es nicht: dort steht die Nummer
-- des Zugangs, der die Buchung geschickt hat (`rc-...` aus RoomCloud ueber
-- das Adminpanel), und sie ist der Schluessel fuer jeden weiteren Push. Die
-- Portalnummer kommt vom Adminpanel, das sie aus RoomCloud uebernimmt; laut
-- Sven stimmt sie immer, auch wenn ein Gastname falsch erfasst ist.
--
-- **An der Buchung, nicht an der Reservierung:** eine Buchung mit drei
-- Zimmern hat beim Portal eine Nummer.
--
-- **Kein eindeutiger Index.** Das Adminpanel fuehrt Haus und Gaestehaus
-- getrennt, und ein Umoptimieren kann kurz zwei Buchungen mit derselben
-- Portalnummer erzeugen. Wer eine Nummer nachschlaegt, bekommt alle Treffer
-- und entscheidet am Anreisetag.
--
-- **Im Audit geschwaerzt.** Zusammen mit dem Anreisetag weist die Nummer
-- einen Gast am Meldeschein aus; sie gehoert damit zu den Werten, die der
-- Audit-Trigger nicht mitschreibt (CLAUDE.md, Migration 0044).
-- ---------------------------------------------------------------------------

ALTER TABLE booking
  ADD COLUMN channel_booking_number text
    CHECK (channel_booking_number IS NULL
           OR channel_booking_number ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

COMMENT ON COLUMN booking.channel_booking_number IS
  'Nummer der Buchung beim Portal (Booking.com ...), vom Umsystem gemeldet (0215). Nicht external_reference.';

CREATE INDEX booking_channel_booking_number
  ON booking (property_id, channel_booking_number)
  WHERE channel_booking_number IS NOT NULL;

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('booking', 'channel_booking_number',
   'Buchungsnummer beim Portal; weist mit dem Anreisetag einen Gast am Meldeschein aus')
ON CONFLICT DO NOTHING;
