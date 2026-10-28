-- ---------------------------------------------------------------------------
-- 0219 -- Ein Zimmerwechsel nimmt die Buchung dem Umsystem nicht mehr weg,
-- wenn StayGrid die Zimmer selbst vergibt.
--
-- Befund: Sven, 28.10.2026 (Thread "Stornierte Buchung Kerl nicht
-- storniert"). Ein Gast im Gaestehaus storniert bei Booking.com, RoomCloud
-- meldet das Storno, StayGrid nimmt es nicht an: die Buchung stand auf
-- "In StayGrid geaendert" (`channel_owner = 'local'`, 0092).
--
-- Den Vermerk setzte bisher jeder andere Wert in `resource_id`, ob aus dem
-- Plan gezogen, zugewiesen, getauscht oder per Zimmerwechsel (0195). Das ist
-- richtig, solange das Umsystem die Zimmer vergibt: sonst legte der naechste
-- Push den Gast still zurueck. Im Gaestehaus vergibt aber StayGrid selbst
-- (Modus `auto`, Sven 07.10.2026); ein mitgeschicktes Zimmer gilt dort ohnehin
-- nicht, der Push behaelt das bisherige (channelBooking.ts). Ein Zug der
-- Rezeption ist dort dasselbe wie ein Zug des Sortierers, und der
-- haelt den Vermerk schon seit 0122 nicht. Die Wahl eines bestimmten
-- Zimmers schuetzt "Zimmer fest" (`room_fixed`) vor dem Sortierer, nicht der
-- Besitz der Buchung.
--
-- Ohne diese Ausnahme stand jede Gaestehausbuchung nach dem ersten
-- Verschieben im Plan fest: kein Storno, keine Verlaengerung, keine
-- Verkuerzung kam mehr an, und der Hinweis "Bitte pruefen" war die einzige
-- Spur eines Zimmers, das leer bleibt und nicht verkauft wird.
--
-- Zeitraum, Gruppe, Personenzahl und Storno an der Rezeption machen die
-- Buchung weiter lokal (Svens Regel vom 05.10.2026). Bestehende Vermerke
-- bleiben: aus dem Vermerk allein ist nicht abzulesen, ob nur das Zimmer
-- wechselte, und eine falsch freigegebene Buchung ueberschriebe eine echte
-- Aenderung der Rezeption.
-- ---------------------------------------------------------------------------

-- Vergibt StayGrid die Zimmer in diesem Haus selbst? Liest im Kontext der
-- Anfrage; ohne Kontext (kein Haus sichtbar) gilt das Umsystem als Vergeber,
-- und der Vermerk wird wie bisher gesetzt -- im Zweifel geschuetzt.
CREATE OR REPLACE FUNCTION room_sort_is_auto(p_property bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM room_sort_setting
                  WHERE property_id = p_property AND mode = 'auto')
$$;

CREATE OR REPLACE FUNCTION channel_owner_from_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF nullif(current_setting('app.channel_push', true), '') IS NOT NULL
     OR nullif(current_setting('app.room_sort', true), '') IS NOT NULL THEN
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
             OR (n.resource_id IS DISTINCT FROM a.resource_id
                 AND NOT room_sort_is_auto(n.property_id))
             OR n.category_id IS DISTINCT FROM a.category_id
             OR n.guest_count IS DISTINCT FROM a.guest_count
             OR n.adults      IS DISTINCT FROM a.adults
             OR n.children    IS DISTINCT FROM a.children
             OR ((n.status IN ('Canceled','NoShow')) <> (a.status IN ('Canceled','NoShow'))));
  END IF;
  RETURN NULL;
END $$;

-- Wie 0196, nur der Vermerk haengt jetzt am Modus des Hauses.
CREATE OR REPLACE FUNCTION reservation_room_move(
  p_reservation bigint, p_from date, p_resource bigint, p_business_day date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r reservation%ROWTYPE;
  vorher jsonb;
  hk text;
  alt_zimmer bigint;
  ausdruck text := coalesce(current_setting('app.inventory_by_room', true), '');
BEGIN
  SELECT * INTO r FROM reservation WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation_room_move: keine Reservierung'; END IF;
  PERFORM assert_property_in_context(r.property_id);
  IF p_from >= r.departure THEN
    RAISE EXCEPTION 'reservation_room_move: Wechseltag nach der Abreise';
  END IF;
  IF r.room_moved AND p_from <= r.arrival THEN
    RAISE EXCEPTION 'reservation_room_move: Aufenthalt ist schon geteilt';
  END IF;

  alt_zimmer := r.resource_id;
  vorher := reservation_room_shift_rows(ARRAY[r.id], -1);
  SELECT status INTO hk FROM housekeeping_status WHERE resource_id = p_resource;

  PERFORM set_config('app.inventory_by_room', 'on', true);
  IF p_from <= r.arrival THEN
    UPDATE reservation SET resource_id = p_resource, updated_at = now() WHERE id = r.id;
  ELSE
    IF NOT r.room_moved THEN
      INSERT INTO reservation_room_part
        (reservation_id, property_id, from_date, to_date, resource_id, created_by)
      VALUES (r.id, r.property_id, r.arrival, NULL, r.resource_id, app_user_id());
    END IF;
    DELETE FROM reservation_room_part WHERE reservation_id = r.id AND from_date >= p_from;
    UPDATE reservation_room_part SET to_date = p_from
     WHERE reservation_id = r.id AND from_date < p_from
       AND (to_date IS NULL OR to_date > p_from);
    INSERT INTO reservation_room_part
      (reservation_id, property_id, from_date, to_date, resource_id, hk_before, created_by)
    VALUES (r.id, r.property_id, p_from, NULL, p_resource, hk, app_user_id());
    PERFORM reservation_room_settle(r.id, p_business_day);
  END IF;
  PERFORM set_config('app.inventory_by_room', ausdruck, true);

  PERFORM inventory_room_shift_apply(vorher || reservation_room_shift_rows(ARRAY[r.id], 1));

  -- Eine Kanalbuchung, die hier ein anderes Zimmer bekommt, ist lokal
  -- geaendert und vor dem Umsystem geschuetzt (0092) -- ausser StayGrid
  -- vergibt die Zimmer selbst (0219). Vor der Anreise aendert sich das
  -- Zimmer von heute nicht, der Trigger dort saehe es nicht.
  IF NOT room_sort_is_auto(r.property_id) THEN
    UPDATE booking b SET channel_owner = 'local', owned_locally_at = now()
     WHERE b.id = r.booking_id AND b.channel_owner = 'source';
  END IF;

  IF r.status = 'InHouse' AND p_from <= p_business_day THEN
    UPDATE reservation_room_part SET moved_out_at = now()
     WHERE reservation_id = r.id AND to_date <= p_business_day AND moved_out_at IS NULL;
    -- Beim Wechsel ins Band bleibt die Reinigung, wie sie ist: der Gast
    -- liegt noch im alten Zimmer (siehe settle). Schmutzig wird es, wenn er
    -- aus dem Band ein neues bekommt -- dann ist `alt_zimmer` dieses.
    IF p_resource IS NOT NULL THEN
      IF alt_zimmer IS NOT NULL AND alt_zimmer <> p_resource THEN
        PERFORM reservation_room_hk_set(r.property_id, alt_zimmer, 'dirty');
      END IF;
      PERFORM reservation_room_hk_set(r.property_id, p_resource, 'occupied');
    END IF;
  END IF;
END $$;
