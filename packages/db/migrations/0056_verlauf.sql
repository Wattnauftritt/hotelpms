-- ---------------------------------------------------------------------------
-- Ein Index fuer die erste Route, die das Protokoll liest.
--
-- `audit_log` wird seit Migration 0001 geschrieben und war bis jetzt nur das:
-- geschrieben. Die vorhandenen Indizes passen dazu --
-- `audit_log_lookup (table_name, row_id, occurred_at DESC)` beantwortet "was
-- ist mit dieser Zeile passiert", `audit_log_user` "was hat dieser Benutzer
-- getan". Beide beantworten nicht die Frage, die am Zimmerplan gestellt wird:
-- **was wurde zuletzt in diesem Haus geaendert.**
--
-- Ohne Index liest diese Abfrage die Monatspartition vollstaendig und
-- sortiert sie, um dreissig Zeilen zu zeigen. Ein Haus mit 250 Zimmern
-- erzeugt im Monat sechsstellig viele Protokollzeilen; das ist genau die
-- Bauform, die im Test schnell ist und im Betrieb nicht.
--
-- An der Elterntabelle angelegt: PostgreSQL legt ihn damit auf jeder
-- bestehenden Partition mit an und auf jeder kuenftigen automatisch --
-- `audit_log_ensure_partitions` muss davon nichts wissen.
-- ---------------------------------------------------------------------------

CREATE INDEX audit_log_property ON audit_log (property_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Und der Preis gehoert ins Protokoll.
--
-- `reservation_night` traegt den Preis je Nacht -- es ist die Tabelle, die
-- sich aendert, wenn jemand im Plan oder in der Gruppenmaske einen Betrag
-- anfasst. Sie war als einzige der Buchungstabellen **nicht** am Audit-
-- Trigger: 0009 haengt ihn an booking, reservation, reservation_occupant,
-- availability_block und registration, an die Naechte nicht. Aufgefallen ist
-- das erst, als der Verlauf gebaut wurde und die Frage "wer hat den Preis
-- geaendert" als einzige unbeantwortbar blieb -- `charge` entsteht erst im
-- Nachtlauf und beantwortet sie fuer eine kuenftige Buchung gar nicht.
--
-- Was das kostet: der Nachtlauf setzt `posted` je Nacht und Zimmer einmal,
-- das sind bei 250 Zimmern 250 Zeilen am Tag. Das ist vertretbar -- und die
-- Oberflaeche zeigt sie nicht, weil sie nur Felder anzeigt, die ein Mensch
-- gesucht hat (`posted` gehoert nicht dazu).
--
-- Kein personenbezogenes Feld in dieser Tabelle, also auch kein Eintrag in
-- `audit_redaction`: Reservierung, Datum, Ratenplan, Betrag.
-- ---------------------------------------------------------------------------

SELECT attach_audit('reservation_night');
