-- ---------------------------------------------------------------------------
-- 0075 -- Ein Aenderungscursor fuer Reservierungen.
--
-- Anforderung: API-Entwurf fuers Adminpanel (03.10.2026), Abschnitt 3.1. Ein
-- angebundenes System soll fragen koennen "was hat sich seit meinem letzten
-- Abruf geaendert" und dabei **keine** Aenderung verlieren -- auch nicht die
-- an einem Nachtpreis, einem Mitreisenden oder am Namen des Hauptgastes.
--
-- **Warum nicht `reservation.updated_at`.** Es wird von Hand gesetzt, und
-- genau die Aenderungen, um die es geht, setzen es nicht: ein neuer
-- Nachtpreis liegt in `reservation_night`, eine Namenskorrektur in `guest`.
-- Und selbst ein vollstaendig gepflegter Zeitstempel verliert Zeilen: er
-- traegt den Zeitpunkt der Aenderung, nicht den des Commits. Eine
-- Transaktion, die um 10:00:00 schreibt und um 10:00:05 committet, steht mit
-- 10:00:00 in der Tabelle -- wer um 10:00:03 gelesen und sich "bis 10:00:03"
-- gemerkt hat, sieht sie nie.
--
-- **Warum auch eine Sequenz allein nicht reicht.** Sie hat dasselbe Problem
-- in anderer Form: die Nummer wird beim Schreiben gezogen, nicht beim
-- Commit. Transaktion A zieht 5, B zieht 6 und committet, ein Leser liefert
-- 6 aus und merkt sich 6 -- dann committet A mit 5.
--
-- **Was haelt.** Die Transaktionsnummer (`xid8`) der aendernden Transaktion,
-- und ausgeliefert wird nur, was unter `pg_snapshot_xmin` liegt. Alles
-- darunter ist abgeschlossen, und jede Transaktion, die noch committen kann,
-- traegt eine Nummer von xmin aufwaerts. Was der Leser ausliefert, kann
-- deshalb nachtraeglich nicht mehr von etwas Aelterem ueberholt werden. Eine
-- lange laufende Transaktion verzoegert die Auslieferung, sie verliert nichts.
-- `xid8` ist 64 Bit mit Epoche und laeuft nicht ueber.
--
-- Die Sequenz bleibt als zweiter Schluessel: innerhalb einer Transaktion
-- haben alle Zeilen dieselbe xid, und zum Blaettern braucht es eine
-- vollstaendige Ordnung. Der Cursor ist das Paar (change_xid, change_seq).
--
-- **Warum eine eigene Tabelle und keine Spalte an `reservation`.** An der
-- Reservierung haengt der Audit-Trigger. Jede Preisaenderung einer Nacht
-- schriebe dann zusaetzlich einen Protokolleintrag "Reservierung geaendert",
-- der nichts sagt ausser einer neuen Nummer -- und `audit_log` kann nicht
-- geloescht werden. Ausserdem schreibt die Anwendung diese Tabelle nicht:
-- sie darf nur lesen, gesetzt wird ausschliesslich ueber die Trigger hier.
-- Ein Cursor, den eine Route von Hand setzen kann, ist einer, den die
-- naechste Route vergisst.
--
-- **Wer hochzaehlt.** Jede Aenderung an `reservation`, `reservation_night`
-- (Preis, Ratenplan, Naechte -- nicht `posted`, das setzt der Nachtlauf jede
-- Nacht fuer jedes belegte Zimmer), `reservation_occupant`, `booking` und
-- am Hauptgast (Name, Mailadresse, Zustand). Damit kommt auch eine
-- Anonymisierung ueber `guest_erase_one()` als Aenderung an, ohne dass die
-- Loeschfunktion etwas davon wissen muss (CLAUDE.md: geloescht wird an
-- einer Stelle).
--
-- Alle Trigger laufen je Anweisung mit Uebergangstabellen, nicht je Zeile:
-- der Nachtlauf anonymisiert in Stapeln, und ein Gruppenumzug schreibt
-- Hunderte Naechte in einer Anweisung (Migration 0013).
-- ---------------------------------------------------------------------------

CREATE SEQUENCE reservation_change_seq;

CREATE TABLE reservation_change (
  reservation_id bigint PRIMARY KEY REFERENCES reservation(id) ON DELETE CASCADE,
  property_id    bigint NOT NULL REFERENCES property(id),
  change_xid     xid8   NOT NULL,
  change_seq     bigint NOT NULL,
  changed_at     timestamptz NOT NULL
);

COMMENT ON TABLE reservation_change IS
  'Letzte Aenderung je Reservierung als Cursor (xid, seq). Nur ueber Trigger geschrieben.';

-- In Cursorreihenfolge je Haus: der Abruf ist ein Bereichsscan ab dem Cursor.
CREATE INDEX reservation_change_cursor
  ON reservation_change (property_id, change_xid, change_seq);

ALTER TABLE reservation_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_change FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON reservation_change
  USING (property_id = ANY (app_property_ids()));

-- Lesen ja, schreiben nein. Die Vorgaberechte aus 0001 gaeben alles.
REVOKE INSERT, UPDATE, DELETE ON reservation_change FROM hotelpms_app;

/**
 * Die genannten Reservierungen als geaendert vermerken.
 *
 * SECURITY DEFINER, weil die Anwendung die Tabelle nicht schreiben darf. Die
 * Kennungen kommen ausschliesslich aus den Uebergangstabellen der Trigger,
 * also aus Zeilen, die die aendernde Transaktion ohnehin anfassen durfte.
 *
 * Sortiert nach id, damit zwei Transaktionen, die dieselben Reservierungen
 * beruehren, die Sperren in derselben Reihenfolge nehmen.
 */
CREATE OR REPLACE FUNCTION reservation_change_touch(p_ids bigint[])
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO reservation_change AS rc
         (reservation_id, property_id, change_xid, change_seq, changed_at)
  SELECT r.id, r.property_id, pg_current_xact_id(),
         nextval('reservation_change_seq'), now()
    FROM reservation r
   WHERE r.id = ANY (p_ids)
   ORDER BY r.id
  ON CONFLICT (reservation_id) DO UPDATE
     SET change_xid = EXCLUDED.change_xid,
         change_seq = EXCLUDED.change_seq,
         changed_at = EXCLUDED.changed_at;
$$;

REVOKE EXECUTE ON FUNCTION reservation_change_touch(bigint[]) FROM PUBLIC, hotelpms_app,
  hotelpms_readonly;

-- ----------------------------------------------------------------- reservation

CREATE OR REPLACE FUNCTION reservation_change_from_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM reservation_change_touch(ARRAY(SELECT DISTINCT id FROM neu));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_reservation_change_ins AFTER INSERT ON reservation
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_reservation();
CREATE TRIGGER trg_reservation_change_upd AFTER UPDATE ON reservation
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_reservation();

-- ----------------------------------------------------------- reservation_night

CREATE OR REPLACE FUNCTION reservation_change_from_night()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM reservation_change_touch(ARRAY(SELECT DISTINCT reservation_id FROM neu));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM reservation_change_touch(ARRAY(SELECT DISTINCT reservation_id FROM alt));
  ELSE
    /*
     * Nur was das Adminpanel sieht: Preis, Ratenplan, Tag. `posted` setzt
     * der Nachtlauf jede Nacht fuer jedes belegte Zimmer; zaehlte das mit,
     * kaeme jede Nacht das ganze Haus als "geaendert" an.
     */
    PERFORM reservation_change_touch(ARRAY(
      SELECT DISTINCT n.reservation_id
        FROM neu n
        JOIN alt a ON a.reservation_id = n.reservation_id AND a.date = n.date
       WHERE n.price_cent   IS DISTINCT FROM a.price_cent
          OR n.rate_plan_id IS DISTINCT FROM a.rate_plan_id
      UNION
      -- Ein geaenderter Schluessel (Tag oder Reservierung) findet oben
      -- keinen Partner und ist trotzdem eine Aenderung.
      SELECT n.reservation_id FROM neu n
       WHERE NOT EXISTS (SELECT 1 FROM alt a
                          WHERE a.reservation_id = n.reservation_id AND a.date = n.date)
      UNION
      SELECT a.reservation_id FROM alt a
       WHERE NOT EXISTS (SELECT 1 FROM neu n
                          WHERE n.reservation_id = a.reservation_id AND n.date = a.date)));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_reservation_change_night_ins AFTER INSERT ON reservation_night
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_night();
CREATE TRIGGER trg_reservation_change_night_upd AFTER UPDATE ON reservation_night
  REFERENCING OLD TABLE AS alt NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_night();
CREATE TRIGGER trg_reservation_change_night_del AFTER DELETE ON reservation_night
  REFERENCING OLD TABLE AS alt
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_night();

-- -------------------------------------------------------- reservation_occupant

CREATE OR REPLACE FUNCTION reservation_change_from_occupant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM reservation_change_touch(ARRAY(SELECT DISTINCT reservation_id FROM neu));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM reservation_change_touch(ARRAY(SELECT DISTINCT reservation_id FROM alt));
  ELSE
    PERFORM reservation_change_touch(ARRAY(
      SELECT reservation_id FROM neu UNION SELECT reservation_id FROM alt));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_reservation_change_occ_ins AFTER INSERT ON reservation_occupant
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_occupant();
CREATE TRIGGER trg_reservation_change_occ_upd AFTER UPDATE ON reservation_occupant
  REFERENCING OLD TABLE AS alt NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_occupant();
CREATE TRIGGER trg_reservation_change_occ_del AFTER DELETE ON reservation_occupant
  REFERENCING OLD TABLE AS alt
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_occupant();

-- --------------------------------------------------------------------- booking

-- Kanalnummer, Herkunft, Bucher: steht in jeder Zeile der Liste.
CREATE OR REPLACE FUNCTION reservation_change_from_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM reservation_change_touch(ARRAY(
    SELECT r.id FROM reservation r WHERE r.booking_id IN (SELECT id FROM neu)));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_reservation_change_booking AFTER UPDATE ON booking
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_booking();

-- ----------------------------------------------------------------------- guest

/*
 * Nur Name, Mailadresse und Zustand: das ist, was aus dem Gast in der Liste
 * steht. Eine geaenderte Telefonnummer eines Stammgastes wuerde sonst jede
 * seiner Reservierungen seit Jahren neu ausliefern.
 *
 * Der Zustand steht dabei, weil die Anonymisierung ihn setzt -- auch dann,
 * wenn der Name schon "Anonymisiert" hiess.
 */
CREATE OR REPLACE FUNCTION reservation_change_from_guest()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM reservation_change_touch(ARRAY(
    SELECT r.id
      FROM neu n
      JOIN alt a ON a.id = n.id
      JOIN reservation r ON r.primary_guest_id = n.id
     WHERE n.last_name  IS DISTINCT FROM a.last_name
        OR n.first_name IS DISTINCT FROM a.first_name
        OR n.email      IS DISTINCT FROM a.email
        OR n.status     IS DISTINCT FROM a.status));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_reservation_change_guest AFTER UPDATE ON guest
  REFERENCING OLD TABLE AS alt NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_change_from_guest();

-- Bestand: jede vorhandene Reservierung bekommt einen Stand, sonst fehlte
-- sie im Vollabzug.
INSERT INTO reservation_change (reservation_id, property_id, change_xid, change_seq, changed_at)
SELECT r.id, r.property_id, pg_current_xact_id(), nextval('reservation_change_seq'),
       r.updated_at
  FROM reservation r
 ORDER BY r.id;
