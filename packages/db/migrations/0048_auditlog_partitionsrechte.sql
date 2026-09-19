-- Rechte an den Partitionen des Audit-Protokolls entziehen.
--
-- Befund H1 (Dokument 25): `audit_log` traegt keine Zeilenrichtlinie, und die
-- Anwendungsrolle hat `SELECT` auf einer Tabelle mit geaenderten Zeilendaten
-- **aller** Mandanten.
--
-- Die Richtlinie selbst ist inzwischen da: Migration 0045 setzt sie samt
-- FORCE, aus demselben Befund als Nummer 2 in Dokument 26. Das Leserecht
-- bleibt deshalb hier absichtlich stehen -- gelesen wird im eigenen Kontext,
-- und die erste Route, die ein Pruefprotokoll anzeigen will, soll gebaut
-- werden koennen und nicht an einem Rechteentzug scheitern.
--
-- Was 0045 **nicht** erreicht, und das ist der Grund fuer diese Migration:
-- die Partitionen. Eine Zeilenrichtlinie an der Elterntabelle wirkt fuer
-- Abfragen **ueber** die Elterntabelle. Eine Partition fuehrt eigene Rechte
-- und eigene Richtlinien, und sie erbt keine -- nachgerechnet an der
-- laufenden Datenbank:
--
--   audit_log            relrowsecurity = t, Richtlinie `tenant`
--   audit_log_2026_09    relrowsecurity = f, keine Richtlinie
--
-- Die Rechte kommen aus `ALTER DEFAULT PRIVILEGES` in 0001, also SELECT,
-- INSERT, UPDATE **und** DELETE fuer die Anwendungsrolle an jeder Partition.
-- Was daraus folgt, ist ebenfalls nachgerechnet: zwei Haeuser, je eine
-- Protokollzeile, gelesen als Anwendungsrolle im Kontext des einen:
--
--   SELECT count(*) FROM audit_log                        ->   1
--   SELECT count(*) FROM audit_log_2026_09                -> 221
--   ... WHERE property_id = <das fremde Haus>              ->   1
--
-- Ueber die Elterntabelle greift die Richtlinie und zeigt die eigene Zeile.
-- Auf der Partition zeigt dieselbe Rolle in derselben Transaktion alles, was
-- in diesem Monat protokolliert wurde, das fremde Haus eingeschlossen. Der
-- Monatsname ist dabei in einer Sekunde geraten. Die Richtlinie aus 0045 ist
-- damit nicht falsch, sondern umgehbar, und zwar mit einem Tabellennamen, der
-- in jedem Kalender steht.
--
-- **Zweiter Teil, Haertegrad 1.** UPDATE und DELETE an den Partitionen sind
-- dieselbe Luecke fuer die Unveraenderlichkeit. Der Rechteentzug aus
-- `make_append_only` traf nur die Elterntabelle. Auch das nachgerechnet: mit
-- den Rechten aus 0001 weist ein `DELETE FROM audit_log_2026_09` nicht die
-- Rechtepruefung ab, sondern der Trigger --
-- "Tabelle audit_log_2026_09 ist unveraenderlich (GoBD)". Die
-- Unveraenderlichkeit haengt damit an **einer** Sicherung statt an zwei, und
-- Haertegrad 1 heisst ausdruecklich: kein UPDATE, kein DELETE.
--
-- Entzogen wird deshalb an jeder Partition alles ausser INSERT: gelesen wird
-- ueber die Elterntabelle, wo die Richtlinie greift, geschrieben unmittelbar
-- in die Partition, wie es der Trigger tut.

DO $$
DECLARE p regclass;
BEGIN
  FOR p IN SELECT inhrelid::regclass FROM pg_inherits
            WHERE inhparent = 'audit_log'::regclass LOOP
    EXECUTE format('REVOKE SELECT, UPDATE, DELETE ON %s FROM hotelpms_app', p);
  END LOOP;
END $$;

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
