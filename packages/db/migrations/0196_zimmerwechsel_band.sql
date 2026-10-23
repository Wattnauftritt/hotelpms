-- ---------------------------------------------------------------------------
-- 0196 -- Zimmerwechsel ins Ablageband.
--
-- Sven, 23.10.2026, nach dem ersten Ausprobieren von 0195: "wenn ich das
-- anklicke ist der button in der maske ausgegraut. vermutlich weil es kein
-- freies zimmer gibt. das zimmer muss ab der gewechselten nacht am besten in
-- das Ablageband springen damit man platz zum sortieren hat".
--
-- Im vollen Haus ist ab dem Wechseltag oft kein Zimmer frei, solange nicht
-- erst ein anderer Gast umgelegt ist. Das Band ist dafuer der Ablageplatz,
-- wie beim Abnehmen eines ganzen Aufenthalts: ein Abschnitt darf jetzt
-- ohne Zimmer sein. Seine Naechte zaehlen in der gebuchten Gruppe, wie jede
-- Buchung ohne Zimmer (0120); die Verschiebung dort verbindet ohnehin nur
-- Abschnitte mit Zimmer.
--
-- Ein Gast im Haus behaelt dabei am Aufenthalt das alte Zimmer, bis er ein
-- neues hat: er schlaeft dort, und ein angereister Gast hat immer ein Zimmer
-- (`inhouse_needs_resource`, Regel aus `stay.inHouseKeepsRoom`). Im Plan ist
-- das alte Zimmer ab dem Wechseltag frei. Ein Zimmer fuer den Abschnitt im
-- Band vergibt dieselbe Funktion ab demselben Tag; erst dann wird das alte
-- schmutzig und das neue belegt (Svens Regel "sofort beim Wechsel" aus 0195).
-- ---------------------------------------------------------------------------

ALTER TABLE reservation_room_part ALTER COLUMN resource_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION reservation_room_settle(p_reservation bigint, p_business_day date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r reservation%ROWTYPE;
  p record;
  -- Der vorige Abschnitt als einzelne Werte: ein `record` ohne Zuweisung
  -- laesst sich in PL/pgSQL nicht einmal auf NULL pruefen.
  vorher_ab date;
  vorher_zimmer bigint;
  anzahl integer;
  zimmer bigint;
BEGIN
  SELECT * INTO r FROM reservation WHERE id = p_reservation;

  -- Zusammenlegen, von vorn nach hinten.
  FOR p IN SELECT * FROM reservation_room_part
            WHERE reservation_id = p_reservation ORDER BY from_date LOOP
    -- IS NOT DISTINCT FROM: zwei Abschnitte im Band hintereinander sind einer.
    IF vorher_ab IS NOT NULL AND vorher_zimmer IS NOT DISTINCT FROM p.resource_id THEN
      DELETE FROM reservation_room_part
       WHERE reservation_id = p_reservation AND from_date = p.from_date;
      UPDATE reservation_room_part SET to_date = p.to_date
       WHERE reservation_id = p_reservation AND from_date = vorher_ab;
    ELSE
      vorher_ab := p.from_date;
      vorher_zimmer := p.resource_id;
    END IF;
  END LOOP;

  SELECT count(*) INTO anzahl FROM reservation_room_part
   WHERE reservation_id = p_reservation
     AND from_date < r.departure AND coalesce(to_date, r.departure) > r.arrival;

  IF anzahl <= 1 THEN
    zimmer := coalesce(reservation_room_on(p_reservation, greatest(p_business_day, r.arrival)),
                       r.resource_id);
    DELETE FROM reservation_room_part WHERE reservation_id = p_reservation;
    UPDATE reservation SET room_moved = false, resource_id = zimmer, updated_at = now()
     WHERE id = p_reservation;
  ELSE
    zimmer := reservation_room_on(p_reservation, greatest(p_business_day, r.arrival));
    /*
     * Liegt der Gast im Haus und sein Abschnitt von heute im Band, bleibt am
     * Aufenthalt das Zimmer, in dem er zuletzt lag: er hat noch kein neues
     * und schlaeft bis dahin im alten (ein angereister Gast hat immer ein
     * Zimmer, `inhouse_needs_resource`). Im Plan ist das alte Zimmer ab dem
     * Wechseltag trotzdem frei -- dafuer ist das Band da.
     */
    IF zimmer IS NULL AND r.status = 'InHouse' THEN
      zimmer := coalesce(
        (SELECT resource_id FROM reservation_room_part
          WHERE reservation_id = p_reservation AND resource_id IS NOT NULL
            AND from_date <= greatest(p_business_day, r.arrival)
          ORDER BY from_date DESC LIMIT 1),
        r.resource_id);
    END IF;
    UPDATE reservation SET room_moved = true, resource_id = zimmer, updated_at = now()
     WHERE id = p_reservation;
  END IF;
END $$;

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
  -- geaendert und vor dem Umsystem geschuetzt (0092). Vor der Anreise aendert
  -- sich das Zimmer von heute nicht, der Trigger dort saehe es nicht.
  UPDATE booking b SET channel_owner = 'local', owned_locally_at = now()
   WHERE b.id = r.booking_id AND b.channel_owner = 'source';

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

CREATE OR REPLACE FUNCTION reservation_room_move_undo(
  p_reservation bigint, p_business_day date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r reservation%ROWTYPE;
  letzter reservation_room_part%ROWTYPE;
  davor reservation_room_part%ROWTYPE;
  vorher jsonb;
  ausdruck text := coalesce(current_setting('app.inventory_by_room', true), '');
BEGIN
  SELECT * INTO r FROM reservation WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR NOT r.room_moved THEN
    RAISE EXCEPTION 'reservation_room_move_undo: kein Zimmerwechsel';
  END IF;
  PERFORM assert_property_in_context(r.property_id);

  SELECT * INTO letzter FROM reservation_room_part
   WHERE reservation_id = r.id AND from_date < r.departure
   ORDER BY from_date DESC LIMIT 1;
  IF letzter.from_date < p_business_day THEN
    RAISE EXCEPTION 'reservation_room_move_undo: Wechsel liegt vor dem Geschaeftstag';
  END IF;
  SELECT * INTO davor FROM reservation_room_part
   WHERE reservation_id = r.id AND from_date < letzter.from_date
   ORDER BY from_date DESC LIMIT 1;

  vorher := reservation_room_shift_rows(ARRAY[r.id], -1);
  PERFORM set_config('app.inventory_by_room', 'on', true);
  DELETE FROM reservation_room_part WHERE reservation_id = r.id AND from_date >= letzter.from_date;
  UPDATE reservation_room_part SET to_date = NULL, moved_out_at = NULL
   WHERE reservation_id = r.id AND from_date = davor.from_date;
  PERFORM reservation_room_settle(r.id, p_business_day);
  PERFORM set_config('app.inventory_by_room', ausdruck, true);

  PERFORM inventory_room_shift_apply(vorher || reservation_room_shift_rows(ARRAY[r.id], 1));

  -- War der Wechsel schon vollzogen, kehrt der Gast zurueck: sein altes
  -- Zimmer ist wieder belegt, das neue bekommt den Stand von vor dem Einzug.
  -- Eine Seite kann das Band sein, und dort gibt es keinen Reinigungsstand.
  IF r.status = 'InHouse' AND letzter.from_date <= p_business_day
     AND letzter.resource_id IS DISTINCT FROM davor.resource_id THEN
    IF davor.resource_id IS NOT NULL THEN
      PERFORM reservation_room_hk_set(r.property_id, davor.resource_id, 'occupied');
    END IF;
    IF letzter.resource_id IS NOT NULL THEN
      PERFORM reservation_room_hk_set(r.property_id, letzter.resource_id,
                                      coalesce(letzter.hk_before, 'dirty'));
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reservation_room_day_roll(p_property bigint, p_day date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM assert_property_in_context(p_property);

  /*
   * Eine Anweisung: alle Teile sehen denselben Stand vor der Aenderung --
   * `hk_before` den Reinigungsstand vor dem Einzug, die Reinigung das Zimmer
   * von gestern. Tauschen zwei Gaeste am selben Tag die Zimmer, steht ein
   * Zimmer zweimal in der Liste; belegt gewinnt, denn darin liegt jetzt
   * jemand.
   */
  WITH z AS (
    SELECT r.id, r.resource_id AS alt, reservation_room_on(r.id, p_day) AS neu
      FROM reservation r
     WHERE r.property_id = p_property AND r.room_moved
       AND r.status = 'InHouse' AND r.arrival <= p_day AND r.departure > p_day
       AND r.resource_id IS DISTINCT FROM reservation_room_on(r.id, p_day)
       -- Ein Abschnitt im Band (0196) hat noch kein Zimmer; der Gast bleibt
       -- im alten, bis eines zugewiesen ist.
       AND reservation_room_on(r.id, p_day) IS NOT NULL
  ), vorher AS (
    UPDATE reservation_room_part p SET hk_before = h.status
      FROM z LEFT JOIN housekeeping_status h ON h.resource_id = z.neu
     WHERE p.reservation_id = z.id AND p.from_date = p_day
    RETURNING 1
  ), verlassen AS (
    UPDATE reservation_room_part p SET moved_out_at = now()
      FROM z
     WHERE p.reservation_id = z.id AND p.to_date <= p_day AND p.moved_out_at IS NULL
    RETURNING 1
  ), zimmer AS (
    UPDATE reservation r SET resource_id = z.neu, updated_at = now()
      FROM z WHERE r.id = z.id
    RETURNING 1
  ), reinigung AS (
    INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
    SELECT DISTINCT ON (x.res) p_property, x.res, x.st, NULL::bigint
      FROM (SELECT alt AS res, 'dirty' AS st, 1 AS rang FROM z WHERE alt IS NOT NULL
            UNION ALL
            SELECT neu, 'occupied', 0 FROM z WHERE neu IS NOT NULL) x
     ORDER BY x.res, x.rang
    ON CONFLICT (resource_id) DO UPDATE
      SET status = EXCLUDED.status, updated_by = NULL, updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO n FROM z;
  RETURN n;
END $$;
