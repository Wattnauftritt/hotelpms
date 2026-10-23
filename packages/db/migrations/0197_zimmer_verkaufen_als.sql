-- ---------------------------------------------------------------------------
-- 0197 -- Ein Zimmer an einzelnen Tagen als andere Kategorie verkaufen.
--
-- Anforderung: Sven, 23.10.2026: "Wenn nun aber z.b. fuer morgen kein
-- Doppelzimmer mehr frei ist aber noch ein Vierbettzimmer dann verkaufen wir
-- das Vierbettzimmer direkt als Doppelzimmer. [...] Das System weiss das
-- natuerlich nicht und wuerde das weiter als VZ verkaufen." Bisher sperrte
-- das Haus dafuer im Adminpanel die Verfuegbarkeitspruefung und stellte
-- RoomCloud von Hand ein, oder es legte ein Doppelzimmer fuer eine Nacht ins
-- Vierbettzimmer, damit der Zaehler es sah. Sven: "das muss man im Kalender
-- natuerlich auf einen Blick sehen koennen".
--
-- Gewaehlt (Vorschlag A im Faden "Zimmer in anderer Kategorie verkaufen"):
-- je Zimmer und Tag eine Kategorie, als die es verkauft wird. Das Zimmer
-- bleibt in seiner Gruppe -- geplant, gereinigt und abgerechnet wird wie
-- bisher --, nur an diesen Tagen zaehlt es im Bestand der anderen:
-- Kapazitaet dort +1, in der eigenen -1. Wer an einem solchen Tag darin
-- liegt, zaehlt ebenfalls dort. Das ist die Regel aus 0120 ("eine Buchung
-- bindet die Gruppe des Zimmers") mit einer Gruppe je Tag statt je Zimmer.
--
-- Eine Zeile je Tag statt eines Zeitraums: Ueberschneidungen gibt es damit
-- nicht, und jede Stelle, die je Nacht rechnet, findet ihre Zeile ueber den
-- Primaerschluessel. Ohne Eintrag gilt die Gruppe des Zimmers, wie bisher.
--
-- Die Haussumme aendert sich nie: ein Zimmer wandert nur zwischen Gruppen.
-- ---------------------------------------------------------------------------

CREATE TABLE room_sell_as (
  resource_id bigint NOT NULL REFERENCES resource(id),
  date        date   NOT NULL,
  property_id bigint NOT NULL REFERENCES property(id),
  -- Die Gruppe, in der das Zimmer an diesem Tag zaehlt. Nie die eigene: die
  -- Route loescht statt dessen den Eintrag.
  category_id bigint NOT NULL REFERENCES resource_category(id),
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, date)
);
-- Die Kapazitaetsrechnung fragt je Haus und Tag, welche Zimmer hinzukommen.
CREATE INDEX room_sell_as_property_date ON room_sell_as (property_id, date);

ALTER TABLE room_sell_as ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_sell_as FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON room_sell_as USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('room_sell_as');

-- Einfuegen und Loeschen, nicht Aendern: eine andere Kategorie ist ein neuer
-- Eintrag, und die Trigger unten rechnen nur diese beiden Faelle.
REVOKE UPDATE ON room_sell_as FROM hotelpms_app;

/*
 * Kapazitaet einer Gruppe (0013), jetzt je Tag: die eigenen Zimmer ohne die,
 * die an diesem Tag anderswo verkauft werden, und die fremden, die an diesem
 * Tag hier verkauft werden.
 */
CREATE OR REPLACE FUNCTION inventory_recalc_category_capacity(
  p_property bigint, p_category bigint, p_from date, p_to date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE inventory_day i
     SET capacity = c.cap
    FROM (
      SELECT d.day,
             count(x.id) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM maintenance_block m
                  WHERE m.resource_id = x.id
                    AND m.kind = 'out_of_order'
                    AND d.day >= m.from_date AND d.day < m.to_date))::integer AS cap
        FROM (
          SELECT generate_series(p_from, p_to - 1, interval '1 day')::date AS day
        ) d
        LEFT JOIN LATERAL (
          SELECT r.id FROM resource r
           WHERE r.category_id = p_category AND r.active AND r.property_id = p_property
             AND NOT EXISTS (SELECT 1 FROM room_sell_as a
                              WHERE a.resource_id = r.id AND a.date = d.day)
          UNION ALL
          SELECT r.id FROM room_sell_as a JOIN resource r ON r.id = a.resource_id
           WHERE a.property_id = p_property AND a.category_id = p_category
             AND a.date = d.day AND r.active
        ) x ON true
       GROUP BY d.day
    ) c
   WHERE i.property_id = p_property
     AND i.category_id = p_category
     AND i.date = c.day
     AND i.capacity IS DISTINCT FROM c.cap;
END $$;

/** Dasselbe fuer alle Gruppen des Hauses (0005), mit der Haussumme danach. */
CREATE OR REPLACE FUNCTION inventory_recalc_capacity(
  p_property bigint, p_from date, p_to date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE inventory_day i
     SET capacity = c.cap
    FROM (
      SELECT cat.id AS category_id, d.day,
             count(x.id) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM maintenance_block m
                  WHERE m.resource_id = x.id
                    AND m.kind = 'out_of_order'
                    AND d.day >= m.from_date AND d.day < m.to_date))::integer AS cap
        FROM resource_category cat
        CROSS JOIN LATERAL (
          SELECT generate_series(p_from, p_to - 1, interval '1 day')::date AS day
        ) d
        LEFT JOIN LATERAL (
          SELECT r.id FROM resource r
           WHERE r.category_id = cat.id AND r.active AND r.property_id = p_property
             AND NOT EXISTS (SELECT 1 FROM room_sell_as a
                              WHERE a.resource_id = r.id AND a.date = d.day)
          UNION ALL
          SELECT r.id FROM room_sell_as a JOIN resource r ON r.id = a.resource_id
           WHERE a.property_id = p_property AND a.category_id = cat.id
             AND a.date = d.day AND r.active
        ) x ON true
       WHERE cat.property_id = p_property AND cat.active
       GROUP BY cat.id, d.day
    ) c
   WHERE i.property_id = p_property
     AND i.category_id = c.category_id
     AND i.date = c.day
     AND i.capacity IS DISTINCT FROM c.cap;

  UPDATE inventory_day h
     SET capacity = s.cap
    FROM (
      SELECT date, sum(capacity)::integer AS cap
        FROM inventory_day
       WHERE property_id = p_property AND category_id <> 0
         AND date >= p_from AND date < p_to
       GROUP BY date
    ) s
   WHERE h.property_id = p_property AND h.category_id = 0
     AND h.date = s.date AND h.capacity IS DISTINCT FROM s.cap;
END $$;

/*
 * Eine Sperrung (Out of Order) an einem Tag, an dem das Zimmer anderswo
 * verkauft wird, nimmt die Kapazitaet dort weg, nicht in der eigenen Gruppe.
 * Gerechnet werden deshalb beide.
 */
CREATE OR REPLACE FUNCTION inventory_capacity_block_stmt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT b.property_id, k.category_id,
           min(b.from_date) AS f, max(b.to_date) AS t
      FROM betroffen b JOIN resource res ON res.id = b.resource_id
     CROSS JOIN LATERAL (
             SELECT res.category_id
             UNION
             SELECT a.category_id FROM room_sell_as a
              WHERE a.resource_id = b.resource_id
                AND a.date >= b.from_date AND a.date < b.to_date) k(category_id)
     GROUP BY b.property_id, k.category_id
  LOOP
    PERFORM inventory_recalc_category_capacity(r.property_id, r.category_id, r.f, r.t);
  END LOOP;
  FOR r IN
    SELECT property_id, min(from_date) AS f, max(to_date) AS t
      FROM betroffen GROUP BY property_id
  LOOP
    PERFORM inventory_recalc_house_capacity(r.property_id, r.f, r.t);
  END LOOP;
  RETURN NULL;
END $$;

/*
 * Ein Zimmer stilllegen oder wieder aufnehmen aendert auch die Gruppen, als
 * die es an einzelnen Tagen verkauft wird.
 */
CREATE OR REPLACE FUNCTION inventory_capacity_resource_upd_stmt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT property_id, category_id FROM betroffen
    UNION
    SELECT DISTINCT property_id, category_id FROM vorher
    UNION
    SELECT DISTINCT a.property_id, a.category_id
      FROM room_sell_as a JOIN betroffen b ON b.id = a.resource_id
     WHERE a.date >= current_date
  LOOP
    PERFORM inventory_recalc_category_capacity(
      r.property_id, r.category_id, current_date, current_date + 750);
  END LOOP;
  FOR r IN
    SELECT DISTINCT property_id FROM betroffen
    UNION SELECT DISTINCT property_id FROM vorher
  LOOP
    PERFORM inventory_recalc_house_capacity(
      r.property_id, current_date, current_date + 750);
  END LOOP;
  RETURN NULL;
END $$;

/*
 * Der Trigger aus 0120/0195, mit der Gruppe des Zimmers **an diesem Tag**.
 * Sonst unveraendert: je Nacht in einem Zimmer, das an diesem Tag zu einer
 * fremden Gruppe zaehlt, -1 in der gebuchten und +1 in der des Zimmers.
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
       CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
        LEFT JOIN room_sell_as a ON a.resource_id = t.resource_id AND a.date = d::date
       CROSS JOIN LATERAL (VALUES (t.category_id, -1),
                                  (coalesce(a.category_id, s.category_id), 1)) c(cat, sgn)
       WHERE coalesce(a.category_id, s.category_id) <> t.category_id) z;
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
       CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
        LEFT JOIN room_sell_as v ON v.resource_id = t.resource_id AND v.date = d::date
       CROSS JOIN LATERAL (VALUES (t.category_id, 1),
                                  (coalesce(v.category_id, s.category_id), -1)) c(cat, sgn)
       WHERE coalesce(v.category_id, s.category_id) <> t.category_id) z;
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
       CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
        LEFT JOIN room_sell_as a ON a.resource_id = t.resource_id AND a.date = d::date
       CROSS JOIN LATERAL (VALUES (t.category_id, -1),
                                  (coalesce(a.category_id, s.category_id), 1)) c(cat, sgn)
       WHERE coalesce(a.category_id, s.category_id) <> t.category_id) z;
  END IF;

  IF zeilen IS NOT NULL THEN
    PERFORM inventory_room_shift_apply(zeilen);
  END IF;
  RETURN NULL;
END $$;

/*
 * Umgruppieren (0080, 0195): an Tagen, an denen das Zimmer anderswo
 * verkauft wird, aendert sich fuer seine Gaeste nichts -- sie zaehlen vorher
 * wie nachher dort. Diese Tage fallen deshalb heraus.
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
             (t.gebucht, CASE WHEN v.category_id <> t.gebucht THEN 1 ELSE 0 END),
             (v.category_id, CASE WHEN v.category_id <> t.gebucht THEN -1 ELSE 0 END),
             (t.gebucht, CASE WHEN b.category_id <> t.gebucht THEN -1 ELSE 0 END),
             (b.category_id, CASE WHEN b.category_id <> t.gebucht THEN 1 ELSE 0 END)
           ) x(cat, sgn)
     CROSS JOIN LATERAL generate_series(t.von, t.bis - 1, interval '1 day') d
     WHERE x.sgn <> 0
       AND NOT EXISTS (SELECT 1 FROM room_sell_as a
                        WHERE a.resource_id = b.id AND a.date = d::date)) z;
  IF zeilen IS NOT NULL THEN
    PERFORM inventory_room_shift_apply(zeilen);
  END IF;
  RETURN NULL;
END $$;

/* Der Beitrag einer Reservierung zur Verschiebung (0195), je Tag. */
CREATE OR REPLACE FUNCTION reservation_room_shift_rows(p_ids bigint[], p_sign integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(z), '[]'::jsonb) FROM (
    SELECT s.property_id, c.cat AS category_id, d::date AS date, c.sgn * p_sign AS n
      FROM reservation_room_stay s
      JOIN resource u ON u.id = s.resource_id
     CROSS JOIN LATERAL generate_series(s.arrival, s.departure - 1, interval '1 day') d
      LEFT JOIN room_sell_as a ON a.resource_id = s.resource_id AND a.date = d::date
     CROSS JOIN LATERAL (VALUES (s.category_id, -1),
                                (coalesce(a.category_id, u.category_id), 1)) c(cat, sgn)
     WHERE s.id = ANY (p_ids)
       AND s.stay_status IN ('Optional','Confirmed','InHouse')
       AND coalesce(a.category_id, u.category_id) <> s.category_id) z
$$;

/* Was der Zaehler je Gruppe und Tag sagen muss (0120, 0140, 0195), je Tag. */
CREATE OR REPLACE FUNCTION inventory_sold_expected(p_property bigint, p_from date)
RETURNS TABLE (category_id bigint, date date, n integer)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(a.category_id, u.category_id, s.category_id), d::date, count(*)::integer
    FROM reservation_room_stay s
    LEFT JOIN resource u ON u.id = s.resource_id
   CROSS JOIN LATERAL generate_series(GREATEST(s.arrival, COALESCE(p_from, s.arrival)),
                                      s.departure - 1, interval '1 day') d
    LEFT JOIN room_sell_as a ON a.resource_id = s.resource_id AND a.date = d::date
   WHERE s.property_id = p_property
     AND s.stay_status IN ('Optional','Confirmed','InHouse')
     AND (p_from IS NULL OR s.departure > p_from)
   GROUP BY 1, 2
$$;

/*
 * Ein Eintrag kommt oder geht: Kapazitaet beider Gruppen an diesen Tagen
 * neu, und wer an einem solchen Tag schon im Zimmer liegt, zieht mit -- von
 * der Gruppe des Zimmers in die verkaufte und zurueck. Die Route laesst das
 * nur zu, wenn dieser Gast genau in der Gruppe gebucht ist, in der er danach
 * zaehlt; gerechnet wird es trotzdem hier, damit kein Weg am Zaehler
 * vorbeifuehrt.
 */
CREATE OR REPLACE FUNCTION room_sell_as_stmt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  zeilen jsonb;
  r record;
  vz integer := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END;
BEGIN
  SELECT jsonb_agg(z) INTO zeilen FROM (
    SELECT e.property_id, c.cat AS category_id, e.date, c.sgn * vz AS n
      FROM geaendert e
      JOIN resource u ON u.id = e.resource_id
      JOIN reservation_room_stay s ON s.resource_id = e.resource_id
                                  AND e.date >= s.arrival AND e.date < s.departure
                                  AND s.stay_status IN ('Optional','Confirmed','InHouse')
     CROSS JOIN LATERAL (VALUES (u.category_id, -1), (e.category_id, 1)) c(cat, sgn)) z;
  IF zeilen IS NOT NULL THEN
    PERFORM inventory_room_shift_apply(zeilen);
  END IF;

  FOR r IN
    SELECT e.property_id, k.category_id, min(e.date) AS f, max(e.date) + 1 AS t
      FROM geaendert e JOIN resource u ON u.id = e.resource_id
     CROSS JOIN LATERAL (VALUES (u.category_id), (e.category_id)) k(category_id)
     GROUP BY e.property_id, k.category_id
     ORDER BY e.property_id, k.category_id
  LOOP
    PERFORM inventory_recalc_category_capacity(r.property_id, r.category_id, r.f, r.t);
  END LOOP;
  FOR r IN
    SELECT property_id, min(date) AS f, max(date) + 1 AS t
      FROM geaendert GROUP BY property_id
  LOOP
    PERFORM inventory_recalc_house_capacity(r.property_id, r.f, r.t);
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_room_sell_as_ins AFTER INSERT ON room_sell_as
  REFERENCING NEW TABLE AS geaendert
  FOR EACH STATEMENT EXECUTE FUNCTION room_sell_as_stmt();
CREATE TRIGGER trg_room_sell_as_del AFTER DELETE ON room_sell_as
  REFERENCING OLD TABLE AS geaendert
  FOR EACH STATEMENT EXECUTE FUNCTION room_sell_as_stmt();

/*
 * Die Tage, an denen sich die Gruppe eines Aufenthalts aendert: vorher in
 * `alt`, danach in `neu`, leer, wo der Tag nicht zum Aufenthalt gehoert.
 */
CREATE OR REPLACE FUNCTION inventory_move_by_room_days(
  p_from_category bigint, p_from_room bigint, p_from_arrival date, p_from_departure date,
  p_to_category   bigint, p_to_room   bigint, p_to_arrival   date, p_to_departure   date
) RETURNS TABLE (date date, alt bigint, neu bigint)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(o.date, n.date), o.cat, n.cat
    FROM (SELECT d::date AS date, coalesce(a.category_id, p_from_category) AS cat
            FROM generate_series(p_from_arrival, p_from_departure - 1, interval '1 day') d
            LEFT JOIN room_sell_as a ON a.resource_id = p_from_room AND a.date = d::date) o
    FULL JOIN
         (SELECT d::date AS date, coalesce(a.category_id, p_to_category) AS cat
            FROM generate_series(p_to_arrival, p_to_departure - 1, interval '1 day') d
            LEFT JOIN room_sell_as a ON a.resource_id = p_to_room AND a.date = d::date) n
      ON n.date = o.date
   WHERE o.cat IS DISTINCT FROM n.cat
$$;

/*
 * `inventory_move` (0019), je Tag in der Gruppe, in der das Zimmer an
 * diesem Tag zaehlt.
 *
 * `change-stay` bewegt den Bestand selbst und laesst den Trigger aus
 * (`app.inventory_by_room`), mit einer Gruppe fuer den ganzen Aufenthalt.
 * Liegt einer der Tage in einem Zimmer, das dann anderswo verkauft wird,
 * stimmt das nicht mehr: eine Verlaengerung im als Doppelzimmer verkauften
 * Vierbettzimmer muss den ersten Tag im Doppelzimmer pruefen und den
 * zweiten im Vierbettzimmer.
 *
 * Ohne einen solchen Tag ist es `inventory_move` selbst -- derselbe Weg wie
 * bisher, damit sich fuer jedes Haus ohne diese Eintraege nichts aendert.
 * Mit einem solchen Tag: erst alle neuen Naechte binden, dann die alten
 * freigeben, jeweils nur, wo sich die Gruppe des Tages aendert. Scheitert
 * eine Bindung, wirft der Aufrufer, und die Transaktion nimmt alles zurueck.
 */
CREATE OR REPLACE FUNCTION inventory_move_by_room(
  p_property bigint,
  p_from_category bigint, p_from_room bigint, p_from_arrival date, p_from_departure date,
  p_to_category   bigint, p_to_room   bigint, p_to_arrival   date, p_to_departure   date
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  fehler text;
  t record;
BEGIN
  PERFORM assert_property_in_context(p_property);

  IF NOT EXISTS (
       SELECT 1 FROM room_sell_as a
        WHERE (a.resource_id = p_from_room
               AND a.date >= p_from_arrival AND a.date < p_from_departure)
           OR (a.resource_id = p_to_room
               AND a.date >= p_to_arrival AND a.date < p_to_departure)) THEN
    RETURN inventory_move(p_property, p_from_category, p_from_arrival, p_from_departure,
                          p_to_category, p_to_arrival, p_to_departure);
  END IF;

  -- Haussumme zuerst und nach Datum, wie `inventory_reserve` sperrt (0005).
  PERFORM 1 FROM inventory_day
   WHERE property_id = p_property AND category_id = 0
     AND date >= least(p_from_arrival, p_to_arrival)
     AND date < greatest(p_from_departure, p_to_departure)
   ORDER BY date FOR UPDATE;

  /*
   * Zweimal dieselbe Frage statt einer Zwischentabelle: die Anwendung darf
   * keine temporaere Tabelle anlegen (0133), und es sind eine Handvoll Tage.
   */
  FOR t IN SELECT * FROM inventory_move_by_room_days(
             p_from_category, p_from_room, p_from_arrival, p_from_departure,
             p_to_category, p_to_room, p_to_arrival, p_to_departure)
            WHERE neu IS NOT NULL ORDER BY date LOOP
    fehler := inventory_reserve(p_property, t.neu, t.date, t.date + 1, 1);
    IF fehler IS NOT NULL THEN RETURN fehler; END IF;
  END LOOP;
  FOR t IN SELECT * FROM inventory_move_by_room_days(
             p_from_category, p_from_room, p_from_arrival, p_from_departure,
             p_to_category, p_to_room, p_to_arrival, p_to_departure)
            WHERE alt IS NOT NULL ORDER BY date LOOP
    PERFORM inventory_release(p_property, t.alt, t.date, t.date + 1, 1);
  END LOOP;
  RETURN NULL;
END $$;

REVOKE EXECUTE ON FUNCTION room_sell_as_stmt() FROM PUBLIC, hotelpms_app, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION inventory_move_by_room(bigint, bigint, bigint, date, date,
                                                  bigint, bigint, date, date)
  FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION inventory_move_by_room(bigint, bigint, bigint, date, date,
                                                 bigint, bigint, date, date) TO hotelpms_app;
