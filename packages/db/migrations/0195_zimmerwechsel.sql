-- ---------------------------------------------------------------------------
-- 0195 -- Zimmerwechsel waehrend des Aufenthalts.
--
-- Sven, 23.10.2026: "manchmal wechseln gaeste waehrend des aufenthaltes das
-- zimmer weil sie ein upgrade buchen oder das zimmer nicht gefaellt. aktuell
-- kann ich das zimmer aber nicht verschieben. ich muesste die gaeste dann
-- immer frueher auschecken und eine neue buchung mit neuem folio erstellen."
--
-- Eine Reservierung hatte genau ein Zimmer fuer den ganzen Aufenthalt. Ein
-- Zimmerwechsel war deshalb einer von der Anreise an: `assign-unit` fragte,
-- ob das neue Zimmer ab dem Anreisetag frei ist, und in den Naechten davor
-- hatte dort meist jemand anders geschlafen. Ging es durch, schrieb es den
-- Aufenthalt rueckwirkend um, und das alte Zimmer bekam keine Reinigung.
--
-- Entscheidungen (Vorschlag im Faden "Zimmerwechsel waehrend des
-- Aufenthalts", Sven 23.10.2026):
--
-- * Eine Reservierung, ein Folio, ein Meldeschein, eine Kanalbuchung -- und
--   nacheinander mehrere Zimmer. Die Konkurrenz teilt den Aufenthalt meist
--   in zwei Reservierungen; daran haengt hier zu viel (Folio, Meldeschein,
--   Gaestemappe, Kanal), und genau das bemaengeln deren Nutzer.
-- * Ein bezahltes Upgrade ist ein hoeherer Nachtpreis ab dem Wechseltag,
--   keine eigene Position. Das schreibt die Route in `reservation_night`.
-- * Das alte Zimmer geht sofort an die Reinigung, kein eigener Schritt
--   "umgezogen".
-- * Auch ein geplanter Wechsel (ab Donnerstag ist die Suite frei) und eine
--   Buchung, die schon vor der Anreise auf zwei Zimmer verteilt wird.
--
-- Datenmodell:
--
-- * `reservation_room_part` haelt die Abschnitte eines geteilten
--   Aufenthalts, alle, auch den ersten: Zimmer ab `from_date` bis
--   `to_date`, beim letzten leer -- er laeuft bis zur Abreise und waechst mit
--   einer Verlaengerung mit. Ohne Wechsel gibt es keine Zeile.
-- * `reservation.room_moved` sagt, dass es Abschnitte gibt. Eine Spalte und
--   kein `EXISTS`, weil die Bestandstrigger auf Anweisungsebene alten und
--   neuen Stand derselben Zeile vergleichen: der Schalter wandert mit der
--   Zeile, die Abschnitte nicht.
-- * `reservation.resource_id` bleibt, und sie heisst jetzt: das Zimmer am
--   Geschaeftstag (vor der Anreise das erste). Rund dreissig Stellen in
--   Schnittstelle, Worker und Fachlogik fragen "wo liegt der Gast" -- die
--   Gaestemappe, das Terminal, die Kasse, die Rechnung, das Adminpanel. Fuer
--   sie alle ist das Zimmer von heute die richtige Antwort, und keine
--   muss die Abschnitte kennen. Der Nachtlauf zieht sie am Wechseltag nach
--   (`reservation_room_day_roll`).
-- * `reservation_room_stay` ist die Sicht fuer alle, die nach einem Datum
--   fragen: Belegungspruefung, Zimmerplan, Reinigung, Bestand. Eine Zeile je
--   Abschnitt, mit dessen Zimmer und Tagen; ein Aufenthalt ohne Wechsel ist
--   eine Zeile wie bisher. Ein verlassener Abschnitt steht dort als
--   `CheckedOut`, damit die Reinigung das alte Zimmer wie eine Abreise sieht.
--
-- Geschrieben werden Abschnitte nur ueber die Funktionen unten. Die
-- Anwendungsrolle darf lesen, nicht schreiben: jede Funktion rechnet den
-- Bestand je Zimmergruppe (0120) vorher und nachher und bucht den
-- Unterschied, und ein Weg daran vorbei hinterliesse einen Zaehler, den
-- keine Reservierung erklaert.
-- ---------------------------------------------------------------------------

ALTER TABLE reservation ADD COLUMN room_moved boolean NOT NULL DEFAULT false;

CREATE TABLE reservation_room_part (
  -- Kein ON DELETE CASCADE: der Bestandstrigger beim Loeschen einer
  -- Reservierung liest ihre Abschnitte, und eine Kaskade liefe vor ihm.
  -- Eine Reservierung mit Zimmerwechsel ist benutzt und wird nicht geloescht
  -- (die Ruecknahme einer KWHotel-Uebernahme laesst sie stehen).
  reservation_id bigint NOT NULL REFERENCES reservation(id),
  property_id    bigint NOT NULL REFERENCES property(id),
  from_date      date   NOT NULL,
  -- Leer beim letzten Abschnitt: bis zur Abreise, auch einer verlaengerten.
  to_date        date,
  resource_id    bigint NOT NULL REFERENCES resource(id),
  -- Wann der Gast dieses Zimmer verlassen hat. Leer, solange er darin liegt
  -- oder noch nicht angekommen ist.
  moved_out_at   timestamptz,
  -- Reinigungsstand des Zimmers vor dem Einzug, damit ein Zuruecknehmen am
  -- selben Tag ein unbenutztes sauberes Zimmer nicht schmutzig zuruecklaesst.
  hk_before      text CHECK (hk_before IN ('dirty','clean','inspected','occupied')),
  created_by     bigint REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, from_date),
  CONSTRAINT room_part_range CHECK (to_date IS NULL OR to_date > from_date)
);
-- Die Belegungsfrage "wer liegt wann in diesem Zimmer".
CREATE INDEX reservation_room_part_resource ON reservation_room_part (resource_id, from_date);

ALTER TABLE reservation_room_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_room_part FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON reservation_room_part USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('reservation_room_part');

-- Lesen ja, schreiben nur ueber die Funktionen unten (wie inventory_day).
REVOKE INSERT, UPDATE, DELETE ON reservation_room_part FROM hotelpms_app;

/*
 * Eine Zeile je Zimmer eines Aufenthalts.
 *
 * `arrival`, `departure`, `resource_id` und `status` sind die des
 * Abschnitts; wer bisher `FROM reservation` fuer "wer liegt wann wo" las,
 * liest hier dieselben Spalten. Die des ganzen Aufenthalts stehen daneben
 * (`stay_*`). Fuer den Bestand zaehlt `stay_status`: ein verlassener
 * Abschnitt ist fuer die Reinigung eine Abreise, gebunden war die Nacht
 * trotzdem.
 *
 * `security_invoker`: die Sicht liest mit den Rechten und der
 * Zeilenrichtlinie des Aufrufers, nicht mit denen des Eigentuemers -- sonst
 * saehe jeder Mandant die Aufenthalte aller.
 */
CREATE VIEW reservation_room_stay WITH (security_invoker = true) AS
SELECT r.id, r.property_id, r.public_ref, r.booking_id, r.category_id,
       r.primary_guest_id, r.resource_id, r.arrival, r.departure, r.status,
       r.arrival AS stay_arrival, r.departure AS stay_departure,
       r.status AS stay_status, false AS room_moved,
       true AS part_first, true AS part_last
  FROM reservation r
 WHERE NOT r.room_moved
UNION ALL
SELECT r.id, r.property_id, r.public_ref, r.booking_id, r.category_id,
       r.primary_guest_id, p.resource_id,
       greatest(p.from_date, r.arrival),
       least(coalesce(p.to_date, r.departure), r.departure),
       CASE WHEN p.moved_out_at IS NOT NULL AND r.status = 'InHouse'
            THEN 'CheckedOut'::reservation_status ELSE r.status END,
       r.arrival, r.departure, r.status, true,
       p.from_date <= r.arrival,
       p.to_date IS NULL OR p.to_date >= r.departure
  FROM reservation r
  JOIN reservation_room_part p ON p.reservation_id = r.id
 WHERE r.room_moved
   AND p.from_date < r.departure
   AND coalesce(p.to_date, r.departure) > r.arrival;

REVOKE INSERT, UPDATE, DELETE ON reservation_room_stay FROM hotelpms_app;

/*
 * Der Beitrag einer Reservierung zur Verschiebung aus 0120: je Nacht in
 * einem Zimmer einer fremden Gruppe -1 in der gebuchten, +1 in der des
 * Zimmers. Mit `p_sign` -1 der alte Stand, mit +1 der neue; zusammen auf
 * `inventory_room_shift_apply` gegeben bleibt der Unterschied.
 */
CREATE OR REPLACE FUNCTION reservation_room_shift_rows(p_ids bigint[], p_sign integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(z), '[]'::jsonb) FROM (
    SELECT s.property_id, c.cat AS category_id, d::date AS date, c.sgn * p_sign AS n
      FROM reservation_room_stay s
      JOIN resource u ON u.id = s.resource_id
     CROSS JOIN LATERAL (VALUES (s.category_id, -1), (u.category_id, 1)) c(cat, sgn)
     CROSS JOIN LATERAL generate_series(s.arrival, s.departure - 1, interval '1 day') d
     WHERE s.id = ANY (p_ids)
       AND s.stay_status IN ('Optional','Confirmed','InHouse')
       AND u.category_id <> s.category_id) z
$$;

/*
 * Der Trigger aus 0120, jetzt je Abschnitt. Ohne Wechsel liest er die Zeile
 * wie bisher; mit Wechsel die Abschnitte, beschnitten auf die Tage der
 * alten bzw. neuen Zeile. Die Abschnitte selbst aendert dieselbe Anweisung
 * nie -- das tun nur die Funktionen unten, und die rechnen selbst.
 *
 * Darum ist es auch richtig, wenn der Nachtlauf am Wechseltag nur das
 * Zimmer von heute nachzieht: alter und neuer Stand lesen dieselben
 * Abschnitte, und der Unterschied ist null.
 */
CREATE OR REPLACE FUNCTION inventory_room_shift_stmt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE zeilen jsonb;
BEGIN
  IF coalesce(current_setting('app.inventory_by_room', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(z) INTO zeilen FROM (
      SELECT t.property_id, c.cat AS category_id, d::date AS date, c.sgn AS n
        FROM (SELECT n.property_id, n.category_id, n.resource_id, n.arrival AS von,
                     n.departure AS bis
                FROM neu n
               WHERE n.status IN ('Optional','Confirmed','InHouse') AND NOT n.room_moved
              UNION ALL
              SELECT n.property_id, n.category_id, p.resource_id,
                     greatest(p.from_date, n.arrival),
                     least(coalesce(p.to_date, n.departure), n.departure)
                FROM neu n JOIN reservation_room_part p ON p.reservation_id = n.id
               WHERE n.status IN ('Optional','Confirmed','InHouse') AND n.room_moved) t
        JOIN resource s ON s.id = t.resource_id
       CROSS JOIN LATERAL (VALUES (t.category_id, -1), (s.category_id, 1)) c(cat, sgn)
       CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
       WHERE s.category_id <> t.category_id) z;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(z) INTO zeilen FROM (
      SELECT t.property_id, c.cat AS category_id, d::date AS date, c.sgn AS n
        FROM (SELECT a.property_id, a.category_id, a.resource_id, a.arrival AS von,
                     a.departure AS bis
                FROM alt a
               WHERE a.status IN ('Optional','Confirmed','InHouse') AND NOT a.room_moved
              UNION ALL
              SELECT a.property_id, a.category_id, p.resource_id,
                     greatest(p.from_date, a.arrival),
                     least(coalesce(p.to_date, a.departure), a.departure)
                FROM alt a JOIN reservation_room_part p ON p.reservation_id = a.id
               WHERE a.status IN ('Optional','Confirmed','InHouse') AND a.room_moved) t
        JOIN resource s ON s.id = t.resource_id
       CROSS JOIN LATERAL (VALUES (t.category_id, 1), (s.category_id, -1)) c(cat, sgn)
       CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
       WHERE s.category_id <> t.category_id) z;
  ELSE
    SELECT jsonb_agg(z) INTO zeilen FROM (
      SELECT t.property_id, c.cat AS category_id, d::date AS date, c.sgn * t.vz AS n
        FROM (SELECT n.property_id, n.category_id, n.resource_id, n.arrival AS von,
                     n.departure AS bis, 1 AS vz
                FROM neu n
               WHERE n.status IN ('Optional','Confirmed','InHouse') AND NOT n.room_moved
              UNION ALL
              SELECT n.property_id, n.category_id, p.resource_id,
                     greatest(p.from_date, n.arrival),
                     least(coalesce(p.to_date, n.departure), n.departure), 1
                FROM neu n JOIN reservation_room_part p ON p.reservation_id = n.id
               WHERE n.status IN ('Optional','Confirmed','InHouse') AND n.room_moved
              UNION ALL
              SELECT a.property_id, a.category_id, a.resource_id, a.arrival,
                     a.departure, -1
                FROM alt a
               WHERE a.status IN ('Optional','Confirmed','InHouse') AND NOT a.room_moved
              UNION ALL
              SELECT a.property_id, a.category_id, p.resource_id,
                     greatest(p.from_date, a.arrival),
                     least(coalesce(p.to_date, a.departure), a.departure), -1
                FROM alt a JOIN reservation_room_part p ON p.reservation_id = a.id
               WHERE a.status IN ('Optional','Confirmed','InHouse') AND a.room_moved) t
        JOIN resource s ON s.id = t.resource_id
       CROSS JOIN LATERAL (VALUES (t.category_id, -1), (s.category_id, 1)) c(cat, sgn)
       CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
       WHERE s.category_id <> t.category_id) z;
  END IF;

  IF zeilen IS NOT NULL THEN
    PERFORM inventory_room_shift_apply(zeilen);
  END IF;
  RETURN NULL;
END $$;

/*
 * Wechselt ein Zimmer die Gruppe, wandern die Naechte darin mit -- jetzt
 * auch die eines Abschnitts, nicht nur die ganzer Aufenthalte.
 */
CREATE OR REPLACE FUNCTION inventory_room_shift_resource_stmt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE zeilen jsonb;
BEGIN
  SELECT jsonb_agg(z) INTO zeilen FROM (
    SELECT t.property_id, x.cat AS category_id, d::date AS date, x.sgn AS n
      FROM betroffen b
      JOIN vorher v ON v.id = b.id AND v.category_id <> b.category_id
      JOIN LATERAL (
             SELECT r.property_id, r.category_id AS gebucht, r.arrival AS von,
                    r.departure AS bis
               FROM reservation r
              WHERE r.resource_id = b.id AND NOT r.room_moved
                AND r.status IN ('Optional','Confirmed','InHouse')
             UNION ALL
             SELECT r.property_id, r.category_id,
                    greatest(p.from_date, r.arrival),
                    least(coalesce(p.to_date, r.departure), r.departure)
               FROM reservation_room_part p
               JOIN reservation r ON r.id = p.reservation_id
              WHERE p.resource_id = b.id AND r.room_moved
                AND r.status IN ('Optional','Confirmed','InHouse')) t ON true
     CROSS JOIN LATERAL (VALUES
             -- alter Stand zurueck, neuer Stand hin; je nur, wenn fremd
             (t.gebucht, CASE WHEN v.category_id <> t.gebucht THEN 1 ELSE 0 END),
             (v.category_id, CASE WHEN v.category_id <> t.gebucht THEN -1 ELSE 0 END),
             (t.gebucht, CASE WHEN b.category_id <> t.gebucht THEN -1 ELSE 0 END),
             (b.category_id, CASE WHEN b.category_id <> t.gebucht THEN 1 ELSE 0 END)
           ) x(cat, sgn)
     CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
     WHERE x.sgn <> 0) z;
  IF zeilen IS NOT NULL THEN
    PERFORM inventory_room_shift_apply(zeilen);
  END IF;
  RETURN NULL;
END $$;

/*
 * Umgruppieren (0080) nimmt die Buchungen im Zimmer mit in die neue Gruppe.
 * Eine Reservierung mit Zimmerwechsel liegt nur einen Teil ihres
 * Aufenthalts in diesem Zimmer; ihre gebuchte Gruppe bleibt, und den Platz
 * fuer die Naechte im Zimmer zieht der Trigger am Zimmer.
 */
CREATE OR REPLACE FUNCTION inventory_carry_room(
  p_property bigint, p_resource bigint, p_from_category bigint, p_to_category bigint
) RETURNS TABLE (reservation_id bigint, public_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF p_from_category = p_to_category THEN RETURN; END IF;

  RETURN QUERY
  WITH mit AS (
    UPDATE reservation r
       SET category_id = p_to_category, updated_at = now()
     WHERE r.property_id = p_property AND r.resource_id = p_resource
       AND r.category_id = p_from_category
       AND r.status IN ('Optional','Confirmed','InHouse')
       AND r.departure > current_date
       AND r.block_id IS NULL
       AND NOT r.room_moved
    RETURNING r.id, r.public_ref, greatest(r.arrival, current_date) AS von, r.departure AS bis
  ), naechte AS (
    SELECT d::date AS date, count(*)::integer AS n
      FROM mit, generate_series(mit.von, mit.bis - 1, interval '1 day') AS d
     GROUP BY 1
  ), je_gruppe AS (
    SELECT p_from_category AS category_id, date, -n AS delta FROM naechte
    UNION ALL
    SELECT p_to_category, date, n FROM naechte
  ), bestand AS (
    UPDATE inventory_day inv
       SET sold = inv.sold + g.delta, updated_at = now()
      FROM je_gruppe g
     WHERE inv.property_id = p_property AND inv.category_id = g.category_id
       AND inv.date = g.date
    RETURNING 1
  )
  SELECT mit.id, mit.public_ref FROM mit;
END $$;

/*
 * Was der Zaehler je Gruppe und Tag sagen muss (0120, 0140), je Abschnitt.
 */
CREATE OR REPLACE FUNCTION inventory_sold_expected(p_property bigint, p_from date)
RETURNS TABLE (category_id bigint, date date, n integer)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(u.category_id, s.category_id), d::date, count(*)::integer
    FROM reservation_room_stay s
    LEFT JOIN resource u ON u.id = s.resource_id
   CROSS JOIN LATERAL generate_series(GREATEST(s.arrival, COALESCE(p_from, s.arrival)),
                                      s.departure - 1, interval '1 day') d
   WHERE s.property_id = p_property
     AND s.stay_status IN ('Optional','Confirmed','InHouse')
     AND (p_from IS NULL OR s.departure > p_from)
   GROUP BY 1, 2
$$;

/*
 * Das Zimmer eines geteilten Aufenthalts an einem Tag: der Abschnitt, der
 * zuletzt davor begonnen hat. Vor dem ersten Abschnitt der erste.
 */
CREATE OR REPLACE FUNCTION reservation_room_on(p_reservation bigint, p_day date)
RETURNS bigint LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT resource_id FROM reservation_room_part
   WHERE reservation_id = p_reservation
   ORDER BY from_date <= p_day DESC,
            CASE WHEN from_date <= p_day THEN from_date END DESC NULLS LAST,
            from_date
   LIMIT 1
$$;

/*
 * Benachbarte Abschnitte im selben Zimmer werden einer; bleibt nur einer
 * uebrig, ist der Aufenthalt nicht mehr geteilt und die Zeilen gehen. Danach
 * das Zimmer von heute an die Reservierung. Nur fuer die Funktionen unten,
 * die den Bestand selbst rechnen: der Trigger ist dabei ausgesetzt.
 */
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
    IF vorher_ab IS NOT NULL AND vorher_zimmer = p.resource_id THEN
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
    UPDATE reservation SET room_moved = true, resource_id = zimmer, updated_at = now()
     WHERE id = p_reservation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reservation_room_hk_set(
  p_property bigint, p_resource bigint, p_status text
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
  VALUES (p_property, p_resource, p_status, app_user_id())
  ON CONFLICT (resource_id) DO UPDATE
    SET status = p_status, updated_by = app_user_id(), updated_at = now()
$$;

/*
 * Den Gast ab `p_from` in `p_resource` legen, bis zur Abreise.
 *
 * Geprueft wird vorher in der Schnittstelle (Zustand, Tage, Zimmer frei),
 * hier nur, was ohne die Pruefung den Bestand verdrehen wuerde. Ein
 * spaeterer geplanter Wechsel faellt weg: wer ab heute in die Suite zieht,
 * hat den Umzug ins Doppelzimmer am Freitag nicht mehr vor.
 *
 * Ab der Anreise ist es kein Wechsel, sondern das Zimmer des ganzen
 * Aufenthalts.
 *
 * Liegt der Wechsel am Geschaeftstag und ist der Gast im Haus, ist er
 * sofort: das alte Zimmer wird schmutzig (Sven: "sofort beim Wechsel"),
 * das neue belegt. Ein spaeterer Tag zieht im Nachtlauf nach.
 */
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
    IF alt_zimmer IS NOT NULL AND alt_zimmer <> p_resource THEN
      PERFORM reservation_room_hk_set(r.property_id, alt_zimmer, 'dirty');
    END IF;
    PERFORM reservation_room_hk_set(r.property_id, p_resource, 'occupied');
  END IF;
END $$;

/*
 * Den letzten Wechsel zuruecknehmen: am Tag des Wechsels oder davor, also
 * solange der Gast nicht schon eine Nacht im neuen Zimmer geschlafen hat.
 * Ob das alte Zimmer bis zur Abreise noch frei ist, prueft die Schnittstelle.
 */
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
  IF r.status = 'InHouse' AND letzter.from_date <= p_business_day
     AND letzter.resource_id <> davor.resource_id THEN
    PERFORM reservation_room_hk_set(r.property_id, davor.resource_id, 'occupied');
    PERFORM reservation_room_hk_set(r.property_id, letzter.resource_id,
                                    coalesce(letzter.hk_before, 'dirty'));
  END IF;
END $$;

/*
 * Geplante Wechsel ab `p_departure` fallen weg, wenn der Aufenthalt vorher
 * endet -- der Gast reist ab, bevor die Suite frei wird. Nur geplante: ein
 * Wechsel am Geschaeftstag ist vollzogen, der Gast liegt im neuen Zimmer,
 * und das ist das Zimmer, das beim Check-out schmutzig wird.
 */
CREATE OR REPLACE FUNCTION reservation_room_trim(
  p_reservation bigint, p_departure date, p_business_day date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r reservation%ROWTYPE;
  vorher jsonb;
  ausdruck text := coalesce(current_setting('app.inventory_by_room', true), '');
BEGIN
  SELECT * INTO r FROM reservation WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR NOT r.room_moved THEN RETURN; END IF;
  PERFORM assert_property_in_context(r.property_id);
  IF NOT EXISTS (SELECT 1 FROM reservation_room_part
                  WHERE reservation_id = r.id AND from_date >= p_departure
                    AND from_date > p_business_day) THEN
    RETURN;
  END IF;

  vorher := reservation_room_shift_rows(ARRAY[r.id], -1);
  PERFORM set_config('app.inventory_by_room', 'on', true);
  DELETE FROM reservation_room_part
   WHERE reservation_id = r.id AND from_date >= p_departure AND from_date > p_business_day;
  UPDATE reservation_room_part SET to_date = NULL
   WHERE reservation_id = r.id
     AND from_date = (SELECT max(from_date) FROM reservation_room_part
                       WHERE reservation_id = r.id);
  PERFORM reservation_room_settle(r.id, p_business_day);
  PERFORM set_config('app.inventory_by_room', ausdruck, true);
  PERFORM inventory_room_shift_apply(vorher || reservation_room_shift_rows(ARRAY[r.id], 1));
END $$;

/*
 * Nachtlauf: der Geschaeftstag `p_day` hat begonnen. Wer heute laut Plan
 * umzieht, liegt ab jetzt im neuen Zimmer -- das Zimmer von heute an der
 * Reservierung wandert, das alte wird schmutzig, das neue belegt. Der
 * Bestand bleibt: er rechnet aus den Abschnitten, und die aendern sich nicht.
 *
 * Mengenbasiert, eine Anweisung je Schritt.
 */
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

REVOKE EXECUTE ON FUNCTION reservation_room_settle(bigint, date) FROM PUBLIC, hotelpms_app, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION reservation_room_hk_set(bigint, bigint, text) FROM PUBLIC, hotelpms_app, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION reservation_room_move(bigint, date, bigint, date) FROM PUBLIC, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION reservation_room_move_undo(bigint, date) FROM PUBLIC, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION reservation_room_trim(bigint, date, date) FROM PUBLIC, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION reservation_room_day_roll(bigint, date) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION reservation_room_move(bigint, date, bigint, date) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION reservation_room_move_undo(bigint, date) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION reservation_room_trim(bigint, date, date) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION reservation_room_day_roll(bigint, date) TO hotelpms_app;
