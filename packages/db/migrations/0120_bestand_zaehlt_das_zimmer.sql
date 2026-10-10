-- ---------------------------------------------------------------------------
-- 0120 -- Eine Buchung bindet die Zimmergruppe des Zimmers, in dem sie liegt.
--
-- Anforderung: Sven, 10.10.2026: "wenn ich fuer diesen zeitraum etwas
-- eintragen will sagt StayGrid es waere eine Ueberbuchung. aber du konntest
-- sehen das dort eine Luecke ist". Zimmer 34 (Doppelzimmer) war am 23.10.
-- frei, der Plan zeigte die Luecke, und die Maske warnte trotzdem, die
-- Gruppe sei ausgebucht.
--
-- Die Ursache war ein Upgrade. Eine als Doppelzimmer gebuchte Reservierung
-- lag in einem Vierbettzimmer. Gezaehlt wurde bisher je **gebuchter** Gruppe:
-- die Reservierung hielt einen Doppelzimmerplatz, waehrend sie ein
-- Vierbettzimmer belegte. Das Doppelzimmer galt als voll, obwohl eines leer
-- stand; das Vierbettzimmer galt als frei, obwohl jemand darin lag -- und
-- genau diese Zahl geht an den Kanal. Aus Bestandsdaten (Import, Umsystem)
-- ist das der Normalfall: zwei Personen im Vierbettzimmer, gebucht als
-- Doppelzimmer.
--
-- Ab jetzt zaehlt eine Buchung **mit Zimmer** in der Gruppe dieses Zimmers,
-- eine ohne Zimmer (Ablage) weiter in ihrer gebuchten. Die gebuchte Gruppe
-- bleibt an der Reservierung stehen: abgerechnet wird, was gebucht wurde
-- (Dokument 16, Upgrade).
--
-- Wie: Alle Aufrufer binden und geben frei wie bisher in der gebuchten
-- Gruppe. Liegt eine bindende Reservierung in einem Zimmer einer anderen
-- Gruppe, verschiebt dieser Trigger ihren Platz an jedem ihrer Tage von der
-- gebuchten Gruppe in die des Zimmers -- und nimmt das zurueck, sobald sie
-- es nicht mehr tut (anderes Zimmer, andere Tage, Storno, geloescht). So
-- bleibt jeder bestehende Weg richtig, auch die, die es noch nicht gibt,
-- ohne dass ein Dutzend Aufrufer die Gruppe des Zimmers kennen muss.
-- Die Haussumme (Gruppe 0) aendert sich dabei nicht.
--
-- `change-stay` rechnet seinen Bestand selbst in der Gruppe des Zimmers --
-- es soll ja vorher sagen, ob genau dort Platz ist -- und setzt dafuer
-- `app.inventory_by_room`; der Trigger laesst diese Anweisung dann aus.
--
-- Auf Anweisungsebene, nicht je Zeile: der Sortierer und Importe aendern
-- viele Reservierungen in einer Anweisung (Migration 0013).
-- ---------------------------------------------------------------------------

/*
 * `sold >= 0` gilt am Ende der Transaktion, nicht nach jeder Anweisung.
 *
 * Mit dem Trigger unten haelt die gebuchte Gruppe den Platz einer
 * Reservierung im fremden Zimmer nicht mehr. Wer sie storniert, gibt ihn
 * aber zuerst dort frei (`inventory_release`) und aendert danach den
 * Zustand, worauf der Trigger ihn zurueckgibt. Dazwischen steht die Gruppe
 * kurz auf -1, wenn die Reservierung ihre einzige war -- eine Gruppe mit
 * einem Zimmer, deren Gast im Apartment liegt.
 *
 * Bisher schnitt die Freigabe bei 0 ab (`greatest(sold - n, 0)`). Das
 * verschluckte genau diese -1, und nach dem Zuruecknehmen stand die Gruppe
 * auf 1 -- ein Platz, den keine Reservierung erklaert. Die Freigabe zieht
 * deshalb jetzt ehrlich ab, und abgeschnitten wird erst beim Abschluss der
 * Transaktion, wenn alle Schritte gelaufen sind. Was dann noch unter 0
 * steht, ist ein Fehler wie bisher; er wird wie bisher auf 0 gesetzt statt
 * eine Buchung an der Rezeption scheitern zu lassen, und der taegliche
 * Abgleich meldet ihn.
 */
ALTER TABLE inventory_day DROP CONSTRAINT sold_nonneg;

CREATE OR REPLACE FUNCTION inventory_day_sold_floor()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE inventory_day SET sold = 0
   WHERE property_id = NEW.property_id AND category_id = NEW.category_id
     AND date = NEW.date AND sold < 0;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_inventory_sold_floor
  AFTER INSERT OR UPDATE OF sold ON inventory_day
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.sold < 0)
  EXECUTE FUNCTION inventory_day_sold_floor();

CREATE OR REPLACE FUNCTION inventory_release(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);
  UPDATE inventory_day SET sold = sold - p_count, updated_at = now()
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
END $$;

CREATE OR REPLACE FUNCTION inventory_release_bulk(
  p_property bigint, p_categories bigint[], p_froms date[], p_tos date[], p_counts integer[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF array_length(p_categories, 1) IS NULL THEN RETURN; END IF;

  WITH items AS (
    SELECT unnest(p_categories) AS category_id, unnest(p_froms) AS from_date,
           unnest(p_tos) AS to_date, unnest(p_counts) AS cnt
  ), naechte AS (
    SELECT i.category_id, d.date, i.cnt
      FROM items i, LATERAL generate_series(i.from_date, i.to_date - 1, interval '1 day') AS d(date)
  ), je_zeile AS (
    SELECT category_id, date, cnt FROM naechte
    UNION ALL
    SELECT 0, date, cnt FROM naechte
  ), summe AS (
    SELECT category_id, date, sum(cnt) AS gesamt FROM je_zeile GROUP BY category_id, date
  )
  UPDATE inventory_day inv SET sold = inv.sold - s.gesamt, updated_at = now()
    FROM summe s
   WHERE inv.property_id = p_property AND inv.category_id = s.category_id
     AND inv.date = s.date;
END $$;

/*
 * Wendet Zeilen (Haus, Gruppe, Tag, Anzahl) auf `sold` an. Tage ohne
 * Bestandszeile werden uebergangen; Anwenden und Zuruecknehmen uebergehen
 * dieselben.
 */
CREATE OR REPLACE FUNCTION inventory_room_shift_apply(p_rows jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  /*
   * Sperrreihenfolge wie ueberall (0005): Haussumme zuerst, dann die
   * Gruppen aufsteigend. Ein UPDATE ... FROM sperrt in beliebiger Folge und
   * liefe gegen eine gleichzeitige Buchung in eine Verklemmung.
   */
  PERFORM 1 FROM inventory_day i
    JOIN (SELECT DISTINCT x.property_id, x.date
            FROM jsonb_to_recordset(p_rows) AS x(property_id bigint, date date)) d
      ON i.property_id = d.property_id AND i.date = d.date
   WHERE i.category_id = 0
   ORDER BY i.property_id, i.date
     FOR UPDATE OF i;
  PERFORM 1 FROM inventory_day i
    JOIN (SELECT DISTINCT x.property_id, x.category_id, x.date
            FROM jsonb_to_recordset(p_rows)
                 AS x(property_id bigint, category_id bigint, date date)) d
      ON i.property_id = d.property_id AND i.category_id = d.category_id
     AND i.date = d.date
   ORDER BY i.property_id, i.category_id, i.date
     FOR UPDATE OF i;

  UPDATE inventory_day i
     SET sold = i.sold + d.n, updated_at = now()
    FROM (
      SELECT x.property_id, x.category_id, x.date, sum(x.n)::integer AS n
        FROM jsonb_to_recordset(p_rows)
             AS x(property_id bigint, category_id bigint, date date, n integer)
       GROUP BY 1, 2, 3
      HAVING sum(x.n) <> 0
    ) d
   WHERE i.property_id = d.property_id AND i.category_id = d.category_id
     AND i.date = d.date;
END $$;

CREATE OR REPLACE FUNCTION inventory_room_shift_stmt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE zeilen jsonb;
BEGIN
  IF coalesce(current_setting('app.inventory_by_room', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

  /*
   * Je Reservierung, die in einem fremden Zimmer bindet, und je Tag zwei
   * Zeilen: -1 in der gebuchten Gruppe, +1 in der des Zimmers. Fuer den
   * alten Stand mit umgekehrtem Vorzeichen. Eine Aenderung, die daran
   * nichts aendert, hebt sich in der Summe auf.
   */
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(z) INTO zeilen FROM (
      SELECT n.property_id, c.cat AS category_id, d::date AS date, c.sgn AS n
        FROM neu n JOIN resource s ON s.id = n.resource_id
       CROSS JOIN LATERAL (VALUES (n.category_id, -1), (s.category_id, 1)) c(cat, sgn)
       CROSS JOIN LATERAL generate_series(n.arrival, n.departure - 1, interval '1 day') d
       WHERE n.status IN ('Optional','Confirmed','InHouse')
         AND s.category_id <> n.category_id) z;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(z) INTO zeilen FROM (
      SELECT a.property_id, c.cat AS category_id, d::date AS date, c.sgn AS n
        FROM alt a JOIN resource s ON s.id = a.resource_id
       CROSS JOIN LATERAL (VALUES (a.category_id, 1), (s.category_id, -1)) c(cat, sgn)
       CROSS JOIN LATERAL generate_series(a.arrival, a.departure - 1, interval '1 day') d
       WHERE a.status IN ('Optional','Confirmed','InHouse')
         AND s.category_id <> a.category_id) z;
  ELSE
    SELECT jsonb_agg(z) INTO zeilen FROM (
      SELECT n.property_id, c.cat AS category_id, d::date AS date, c.sgn AS n
        FROM neu n JOIN resource s ON s.id = n.resource_id
       CROSS JOIN LATERAL (VALUES (n.category_id, -1), (s.category_id, 1)) c(cat, sgn)
       CROSS JOIN LATERAL generate_series(n.arrival, n.departure - 1, interval '1 day') d
       WHERE n.status IN ('Optional','Confirmed','InHouse')
         AND s.category_id <> n.category_id
      UNION ALL
      SELECT a.property_id, c.cat, d::date, c.sgn
        FROM alt a JOIN resource s ON s.id = a.resource_id
       CROSS JOIN LATERAL (VALUES (a.category_id, 1), (s.category_id, -1)) c(cat, sgn)
       CROSS JOIN LATERAL generate_series(a.arrival, a.departure - 1, interval '1 day') d
       WHERE a.status IN ('Optional','Confirmed','InHouse')
         AND s.category_id <> a.category_id) z;
  END IF;

  IF zeilen IS NOT NULL THEN
    PERFORM inventory_room_shift_apply(zeilen);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_inventory_room_shift_ins AFTER INSERT ON reservation
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_room_shift_stmt();
CREATE TRIGGER trg_inventory_room_shift_upd AFTER UPDATE ON reservation
  REFERENCING NEW TABLE AS neu OLD TABLE AS alt
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_room_shift_stmt();
CREATE TRIGGER trg_inventory_room_shift_del AFTER DELETE ON reservation
  REFERENCING OLD TABLE AS alt
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_room_shift_stmt();

/*
 * Wechselt ein Zimmer die Gruppe, wandern die Buchungen darin mit. Die
 * Kapazitaet rechnet schon 0013 nach; ohne das hier zoege die Gruppe ein
 * Zimmer ab und behielte die Buchung darin.
 */
CREATE OR REPLACE FUNCTION inventory_room_shift_resource_stmt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE zeilen jsonb;
BEGIN
  SELECT jsonb_agg(z) INTO zeilen FROM (
    SELECT r.property_id, x.cat AS category_id, d::date AS date, x.sgn AS n
      FROM betroffen b
      JOIN vorher v ON v.id = b.id AND v.category_id <> b.category_id
      JOIN reservation r ON r.resource_id = b.id
       AND r.status IN ('Optional','Confirmed','InHouse')
     CROSS JOIN LATERAL (VALUES
             -- alter Stand zurueck, neuer Stand hin; je nur, wenn fremd
             (r.category_id, CASE WHEN v.category_id <> r.category_id THEN 1 ELSE 0 END),
             (v.category_id, CASE WHEN v.category_id <> r.category_id THEN -1 ELSE 0 END),
             (r.category_id, CASE WHEN b.category_id <> r.category_id THEN -1 ELSE 0 END),
             (b.category_id, CASE WHEN b.category_id <> r.category_id THEN 1 ELSE 0 END)
           ) x(cat, sgn)
     CROSS JOIN LATERAL generate_series(r.arrival, r.departure - 1, interval '1 day') d
     WHERE x.sgn <> 0) z;
  IF zeilen IS NOT NULL THEN
    PERFORM inventory_room_shift_apply(zeilen);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_inventory_room_shift_resource AFTER UPDATE ON resource
  REFERENCING NEW TABLE AS betroffen OLD TABLE AS vorher
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_room_shift_resource_stmt();

/*
 * Was der Zaehler je Gruppe und Tag sagen muss -- an einer Stelle, damit
 * der taegliche Abgleich, der Saatlauf und das Testhotel dasselbe rechnen
 * wie der Trigger.
 */
CREATE OR REPLACE FUNCTION inventory_sold_expected(p_property bigint, p_from date)
RETURNS TABLE (category_id bigint, date date, n integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(s.category_id, r.category_id), d::date, count(*)::integer
    FROM reservation r
    LEFT JOIN resource s ON s.id = r.resource_id
   CROSS JOIN LATERAL generate_series(GREATEST(r.arrival, COALESCE(p_from, r.arrival)),
                                      r.departure - 1, interval '1 day') d
   WHERE r.property_id = p_property
     AND r.status IN ('Optional','Confirmed','InHouse')
   GROUP BY 1, 2
$$;

/*
 * Den Bestand einmal nachziehen: jede bindende Reservierung, die heute in
 * einem fremden Zimmer liegt, wandert in dessen Gruppe. Ueber alle Haeuser,
 * deshalb ohne Mandantenkontext -- die Migration laeuft als Eigentuemer.
 */
SELECT inventory_room_shift_apply(z) FROM (
  SELECT jsonb_agg(y) AS z FROM (
    SELECT r.property_id, c.cat AS category_id, d::date AS date, c.sgn AS n
      FROM reservation r JOIN resource s ON s.id = r.resource_id
     CROSS JOIN LATERAL (VALUES (r.category_id, -1), (s.category_id, 1)) c(cat, sgn)
     CROSS JOIN LATERAL generate_series(r.arrival, r.departure - 1, interval '1 day') d
     WHERE r.status IN ('Optional','Confirmed','InHouse')
       AND s.category_id <> r.category_id) y
) w WHERE z IS NOT NULL;
