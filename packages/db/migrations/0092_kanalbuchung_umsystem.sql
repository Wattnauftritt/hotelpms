-- ---------------------------------------------------------------------------
-- 0092 -- Kanalbuchungen aus einem fuehrenden Umsystem: anlegen, aendern,
-- stornieren, und was passiert, wenn die Rezeption sie in StayGrid aendert.
--
-- Anforderung: Sven, 05.10.2026, Thread "Gaestehaus-Buchungen nach
-- StayGrid". Das Adminpanel fuehrt das Gaestehaus (fuenf Zimmer): es holt
-- die Buchungen aus RoomCloud, vergibt die Zimmer selbst, teilt dabei
-- Aufenthalte auf und meldet die Verfuegbarkeit an RoomCloud. StayGrid soll
-- die Buchungen im Kalender zeigen. Bisher konnte ein Kanal nur anlegen.
--
-- Was die Migration dafuer braucht:
--
-- 1. Anbieter `generic` neben `roomcloud`. Die Schnittstelle bleibt
--    allgemein; dass dahinter das Adminpanel steht, weiss nur der Name des
--    Zugangs.
--
-- 2. Welcher Zugang eine Buchung gebracht hat. Ein PUT aendert nur, was
--    derselbe Zugang angelegt hat -- eine externe Nummer ist kein
--    Ausweis, und eine von Hand angelegte Buchung mit derselben Nummer
--    gehoert nicht dem Kanal.
--
-- 3. Wem die Buchung gehoert (`channel_owner`). Aendert die Rezeption eine
--    gepushte Buchung in StayGrid (Zeitraum, Zimmer, Gruppe, Storno), gehoert
--    sie ab dann StayGrid: der naechste Push ueberschriebe sonst still, was
--    jemand an der Rezeption bewusst getan hat. Das Umsystem liest den Wechsel
--    aus der Reservierungsliste und haelt die Buchung bei sich fest.
--    Erkannt wird das per Trigger und nicht in den Routen: Routen, die eine
--    Reservierung aendern, gibt es viele (Plan, Maske, Gruppe, Storno,
--    Wiederherstellen), und die naechste vergaesse den Vermerk.
--
-- 4. Ob die Quelle sich danach noch bewegt hat (`source_changed_at`). Eine
--    lokal gefuehrte Buchung nimmt keinen Push mehr an; aendert das Portal
--    sie trotzdem, muss es jemand sehen und von Hand abgleichen.
--
-- 5. Belegung erzwingen. Das Umsystem hat das Zimmer schon verkauft; eine
--    Absage wegen voller Gruppe verloere eine echte Buchung. Gebunden wird
--    trotzdem, damit der Zaehler stimmt, und der Konflikt wird vermerkt.
-- ---------------------------------------------------------------------------

ALTER TABLE channel_connection DROP CONSTRAINT channel_connection_provider_check;
ALTER TABLE channel_connection
  ADD CONSTRAINT channel_connection_provider_check
  CHECK (provider IN ('roomcloud', 'generic'));

ALTER TABLE booking
  ADD COLUMN channel_connection_id bigint REFERENCES channel_connection(id),
  ADD COLUMN channel_owner text CHECK (channel_owner IN ('source', 'local')),
  ADD COLUMN owned_locally_at timestamptz,
  -- Stand der Quelle, den der letzte angenommene Push trug. Ein aelterer
  -- Stand kommt vor, wenn zwei Laeufe einander ueberholen.
  ADD COLUMN source_updated_at timestamptz,
  -- Pruefsumme des letzten Pushes. Dient nur dazu, bei einer lokal gefuehrten
  -- Buchung zu erkennen, ob die Quelle seitdem etwas anderes sagt. Gerechnet
  -- nur ueber Zimmer, Tage, Personen und Preis, nie ueber Gastdaten: sie
  -- steht im Audit-Protokoll, und ein Hash ueber Name und Mail liesse sich
  -- dort durchprobieren.
  ADD COLUMN source_hash text,
  ADD COLUMN source_changed_at timestamptz,
  ADD COLUMN source_canceled_at timestamptz,
  ADD CONSTRAINT booking_channel_owner_needs_connection
    CHECK (channel_owner IS NULL OR channel_connection_id IS NOT NULL);

-- Belegung, die beim Push nicht frei war: die Gruppe war voll, oder im
-- Zimmer lag schon jemand. Wird bei jedem Push neu gesetzt.
ALTER TABLE reservation
  ADD COLUMN channel_conflict text CHECK (channel_conflict IN ('inventory', 'room'));

/**
 * Wie inventory_reserve, aber ohne Obergrenze. Liefert, ob die Belegung
 * ueber dem lag, was die Gruppe hergibt.
 *
 * Nur fuer Buchungen aus einem fuehrenden Umsystem: dort ist das Zimmer
 * verkauft, bevor StayGrid davon hoert, und eine Absage aenderte daran
 * nichts ausser, dass die Buchung im Kalender fehlte.
 */
CREATE OR REPLACE FUNCTION inventory_reserve_force(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  nights integer := (p_to - p_from);
  present integer;
  over integer;
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF nights <= 0 OR p_count <= 0 THEN RETURN 'invalid'; END IF;

  SELECT count(*) INTO present FROM inventory_day
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
  IF present <> nights * 2 THEN RETURN 'not_materialized'; END IF;

  -- Vor dem Erhoehen gezaehlt: ueber der Grenze ist, wo nach dem Erhoehen
  -- mehr verkauft ist als da ist.
  SELECT count(*) INTO over FROM inventory_day
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to
     AND sold + blocked + p_count > capacity + overbooking;

  UPDATE inventory_day SET sold = sold + p_count, updated_at = now()
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;

  RETURN CASE WHEN over > 0 THEN 'over' ELSE NULL END;
END $$;

REVOKE EXECUTE ON FUNCTION inventory_reserve_force(bigint,bigint,date,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_reserve_force(bigint,bigint,date,date,integer) TO hotelpms_app;

/*
 * Lokale Aenderung einer gepushten Buchung erkennen.
 *
 * Der Push selbst setzt `app.channel_push` transaktionslokal; alles andere
 * ist lokal. Gezaehlt wird, was die Belegung aendert -- Zeitraum, Zimmer,
 * Gruppe, Storno und Wiederherstellen. Ein Check-in oder Check-out aendert
 * sie nicht und laesst die Buchung beim Umsystem; sonst gehoerte jede
 * Gaestehausbuchung nach der Anreise StayGrid, und das Umsystem koennte
 * eine Verlaengerung nicht mehr melden.
 *
 * Auf Anweisungsebene (CLAUDE.md): eine Gruppe verschiebt viele Zeilen in
 * einer Anweisung.
 */
CREATE OR REPLACE FUNCTION channel_owner_from_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF nullif(current_setting('app.channel_push', true), '') IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    UPDATE booking b SET channel_owner = 'local', owned_locally_at = now()
     WHERE b.channel_owner = 'source'
       AND b.id IN (SELECT booking_id FROM neu);
  ELSE
    UPDATE booking b SET channel_owner = 'local', owned_locally_at = now()
     WHERE b.channel_owner = 'source'
       AND b.id IN (
         SELECT n.booking_id FROM neu n JOIN alt a ON a.id = n.id
          WHERE n.arrival     IS DISTINCT FROM a.arrival
             OR n.departure   IS DISTINCT FROM a.departure
             OR n.resource_id IS DISTINCT FROM a.resource_id
             OR n.category_id IS DISTINCT FROM a.category_id
             OR ((n.status IN ('Canceled','NoShow')) <> (a.status IN ('Canceled','NoShow'))));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_channel_owner_ins AFTER INSERT ON reservation
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION channel_owner_from_reservation();
CREATE TRIGGER trg_channel_owner_upd AFTER UPDATE ON reservation
  REFERENCING OLD TABLE AS alt NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION channel_owner_from_reservation();
