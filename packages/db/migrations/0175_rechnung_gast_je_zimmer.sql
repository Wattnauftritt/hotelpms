-- Gast je Zimmer auf der Rechnung (Sven, 15.10.2026).
--
-- Firmen buchen oft mehrere Zimmer in einer Buchung, und die Rechnung geht
-- als Sammelrechnung an die Firma. Jede Position eines Zimmers braucht dann
-- den Namen dessen, der dort uebernachtet hat: die Firma rechnet die Reise
-- je Mitarbeiter ab, und "Uebernachtung 08.10.2026" dreimal untereinander
-- sagt ihr nicht, welche wem gehoert.
--
-- **Warum an der Rechnung und nicht an der Buchung.** Die Buchung
-- (`charge`) ist unveraenderlich und entsteht im Nachtlauf, bevor jemand
-- weiss, an wen abgerechnet wird. Ein Name in ihrem Text bliebe ausserdem
-- fuer immer stehen, auch nach der Loeschung des Gastes. Die Rechnung
-- dagegen haelt ihren Empfaenger ohnehin als Momentaufnahme fest und
-- unterliegt derselben Aufbewahrungsfrist; der Name des Uebernachtenden
-- gehoert zu ihrem Inhalt wie der des Empfaengers (`recipient_snapshot`).
--
-- Schluessel ist die Buchung (charge.id), Wert der Zusatz der Position,
-- etwa "Zimmer 12, Max Mustermann". Die Stornorechnung uebernimmt die
-- Zuordnung des Originals; ihre Gegenbuchungen finden den Zusatz ueber
-- `reverses_id`.

ALTER TABLE invoice ADD COLUMN line_guests jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN invoice.line_guests IS
  'Zusatz je Position (charge.id -> Zimmer und Name des Uebernachtenden), festgeschrieben mit der Rechnung.';

-- `invoice` traegt den Audit-Trigger (0012), und der schreibt beim Anlegen
-- die ganze Zeile ins Protokoll. Die Namen gehoeren nicht dorthin (Regel
-- aus Migration 0044): die Rechnung ist der Beleg, den die Frist meint,
-- eine zweite Kopie im Protokoll ist es nicht. Mitbehoben:
-- `recipient_snapshot` stand dort bisher genauso -- bei einer Gastrechnung
-- Name und Anschrift des Gastes, unredigiert.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('invoice', 'line_guests',        'Namen der Uebernachtenden'),
  ('invoice', 'recipient_snapshot', 'Name und Anschrift des Empfaengers, oft ein Gast');
