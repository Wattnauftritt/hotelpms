-- ---------------------------------------------------------------------------
-- 0055 -- Kurznotiz fuer den Balken, lange Notiz fuer alles andere.
--
-- Aus dem Betrieb: "die Notiz sollte unterscheiden zwischen Kurznotiz, die
-- in den Chip soll, und langen Notizen, die nur im Tooltipp und beim
-- Oeffnen der Reservierung angezeigt werden".
--
-- **Warum zwei Spalten und nicht eine gekuerzte.** Die Balkenbeschriftung
-- ist ein paar Dutzend Pixel breit -- bei einer Nacht sind es 44. Wer dort
-- die ersten Zeichen einer langen Notiz zeigt, zeigt "Gast hat angerufen
-- weg..." und damit nichts. Die beiden Texte haben verschiedene Aufgaben:
-- die eine ist ein Merkmal, das man im Vorbeigehen liest ("Balkon",
-- "1. Stock", "Spaetanreise"), die andere ist der Vorgang.
--
-- Eine Spalte mit Trennzeichen -- erste Zeile kurz, Rest lang -- waere die
-- naheliegende Sparsamkeit und die schlechtere Loesung: sie laesst sich
-- nicht begrenzen, nicht einzeln aendern, und die erste Zeile waechst beim
-- ersten Menschen, der Enter vergisst.
--
-- `notes` bleibt, wie es ist. Es traegt den Bestand, und es ist die Spalte,
-- die im Meldeschein-Umfeld als Freitext gilt (0044: reservation.notes
-- steht auf der Redaktionsliste, weil dort faktisch auch Gesundheitliches
-- landet).
-- ---------------------------------------------------------------------------

ALTER TABLE reservation ADD COLUMN short_note text;

COMMENT ON COLUMN reservation.short_note IS
  'Merkmal fuer den Balken im Belegungsplan, etwa "Balkon" oder "1. Stock". '
  'Der Vorgang gehoert in notes.';

/*
 * Vierzig Zeichen, und die Grenze ist der Zweck.
 *
 * Auf den Balken passt weniger -- bei einer Nacht praktisch nichts --, aber
 * eine Grenze, die exakt der Anzeige folgt, waere bei jeder
 * Schriftgroessenaenderung falsch. Vierzig sagt: ein Merkmal, kein Satz.
 * Wer mehr braucht, schreibt es in notes, und genau dorthin soll er.
 */
ALTER TABLE reservation ADD CONSTRAINT reservation_short_note_check
  CHECK (short_note IS NULL OR length(short_note) <= 40);

/*
 * Auf die Redaktionsliste, wie notes.
 *
 * Der Audit-Trigger schreibt sonst eine Kopie mit, die keine Loeschung mehr
 * entfernt (CLAUDE.md, Migration 0044). Dass hier nur "Balkon" stehen soll,
 * ist eine Absicht und keine Zusicherung: in ein Freitextfeld schreibt
 * frueher oder spaeter jemand einen Namen.
 */
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('reservation', 'short_note', 'Freitext, faktisch auch personenbezogen')
ON CONFLICT DO NOTHING;
