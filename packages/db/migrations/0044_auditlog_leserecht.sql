-- Leserecht am Audit-Protokoll entziehen, samt Partitionen.
--
-- Befund H1 (Dokument 25): `audit_log` traegt **keine** Zeilenrichtlinie, und
-- die Anwendungsrolle hat `SELECT`. Ausnutzbar ist das heute nicht -- keine
-- Route liest das Protokoll, nur der Loeschvermerk schreibt hinein und der
-- Worker pflegt Partitionen. Die Tabelle haelt aber geaenderte Zeilendaten
-- **aller** Mandanten, und wer als naechstes eine Ansicht darauf baut -- ein
-- Pruefprotokoll will man irgendwann sehen -- erbt einen
-- mandantenuebergreifenden Fund, ohne dass ihn etwas warnt.
--
-- Von den beiden Abhilfen im Befund die billigere: Recht entziehen, statt
-- eine Zeilenrichtlinie zu pflegen, die niemand braucht. Sie faellt sofort
-- auf, wenn jemand das Protokoll wirklich lesen will, und der richtige Weg
-- steht dann schon da: `platform_session_activity` (0039) liest es als
-- SECURITY DEFINER und entscheidet selbst, wer was sehen darf. Genau so
-- gehoert ein Protokollleser gebaut, und genau so bleibt er unberuehrt von
-- diesem Entzug.
--
-- **Beim Nachrechnen mitgefunden, und das ist der schwerere Teil:** die
-- Partitionen fuehren eigene Rechte, und die kommen aus
-- `ALTER DEFAULT PRIVILEGES` in 0001 -- also SELECT, INSERT, UPDATE **und
-- DELETE** fuer die Anwendungsrolle. Nachgerechnet an der laufenden
-- Datenbank:
--
--   audit_log            -> INSERT, SELECT
--   audit_log_2026_09    -> INSERT, SELECT, UPDATE, DELETE
--
-- Der Rechteentzug aus `make_append_only` traf nur die Elterntabelle. Ein
-- `UPDATE audit_log_2026_09 ...` scheitert heute am Trigger, der auf
-- Partitionen mitwandert -- die Unveraenderlichkeit haengt damit an **einer**
-- Sicherung statt an zwei, und Haertegrad 1 heisst ausdruecklich: kein
-- UPDATE, kein DELETE. Deshalb hier beides, und in der Funktion, die
-- Partitionen anlegt, fuer jede kuenftige gleich mit.

DO $$
DECLARE p regclass;
BEGIN
  FOR p IN SELECT inhrelid::regclass FROM pg_inherits
            WHERE inhparent = 'audit_log'::regclass LOOP
    EXECUTE format('REVOKE SELECT, UPDATE, DELETE ON %s FROM hotelpms_app', p);
  END LOOP;
END $$;

REVOKE SELECT ON audit_log FROM hotelpms_app;

-- Die Berichtsrolle behaelt ihr Leserecht: sie laeuft auf dem Replikat, hat
-- keinen Schreibweg und ist genau fuer solche Auswertungen da.

-- Wie 0001, nur mit dem Rechteentzug an jeder neu angelegten Partition. Ohne
-- ihn holt sich jede neue Monatspartition die Standardrechte zurueck, und der
-- Entzug oben waere in einem Monat wieder wirkungslos -- still, denn auffallen
-- wuerde er erst an der Partition, in die dann geschrieben wird.
CREATE OR REPLACE FUNCTION audit_log_ensure_partitions(months_ahead integer DEFAULT 12)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  m integer;
  start_date date;
  end_date date;
  part_name text;
  created integer := 0;
BEGIN
  FOR m IN -1..months_ahead LOOP
    start_date := date_trunc('month', current_date + (m || ' months')::interval)::date;
    end_date   := (start_date + interval '1 month')::date;
    part_name  := 'audit_log_' || to_char(start_date, 'YYYY_MM');
    IF to_regclass(part_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date);
      EXECUTE format(
        'REVOKE SELECT, UPDATE, DELETE ON %I FROM hotelpms_app', part_name);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;
