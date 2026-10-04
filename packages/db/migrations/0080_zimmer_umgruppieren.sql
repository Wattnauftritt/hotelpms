-- ---------------------------------------------------------------------------
-- 0080 -- Ein Zimmer nimmt beim Umgruppieren seine Reservierungen mit.
--
-- Befund: Sven, 04.10.2026. Die Gruppe "Ferienwohnung" hatte kein aktives
-- Zimmer mehr und liess sich trotzdem nicht stilllegen: "noch 11 kuenftige
-- Reservierungen". Die Reservierungen lagen in Zimmern, die inzwischen zu
-- einer anderen Gruppe gehoerten.
--
-- Ursache: eine Reservierung traegt zwei Angaben, die gebuchte Gruppe
-- (`category_id`, danach zaehlt der Bestand) und das zugewiesene Zimmer
-- (`resource_id`). `PATCH /v1/rooms/:id` verschob das Zimmer in eine andere
-- Gruppe und liess die gebuchte Gruppe seiner Reservierungen stehen. Danach
-- war der Bestand auf beiden Seiten falsch: die alte Gruppe zaehlte Gaeste
-- ohne Kapazitaet (ueberbucht), die neue Kapazitaet ohne ihre Gaeste -- sie
-- haette dasselbe Zimmer an denselben Tagen ein zweites Mal verkauft.
--
-- Was mitgeht: kuenftige Reservierungen, die auf genau diesem Zimmer liegen
-- **und** in der alten Gruppe des Zimmers gebucht sind. Ein Upgrade -- als
-- Doppelzimmer gebucht, in der Suite untergebracht -- bleibt beim Gebuchten,
-- es zaehlte nie im Bestand der Suite. Ein Abruf aus einem Kontingent bleibt
-- ebenfalls: seine Naechte gehoeren dem Kontingent seiner Gruppe.
--
-- Ohne Kapazitaetspruefung, mit Absicht: der Gast liegt schon in diesem
-- Zimmer, und das Zimmer bringt seine Kapazitaet in die neue Gruppe mit.
-- Abzuweisen gaebe es nichts, was nicht vorher schon so belegt war.
--
-- Gezaehlt wird ab heute; vergangene Naechte sind Geschichte und stehen in
-- `business_day_stat`, nicht im Zaehler (Migration 0014).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION inventory_carry_room(
  p_property bigint, p_resource bigint, p_from_category bigint, p_to_category bigint
) RETURNS TABLE (reservation_id bigint, public_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
    RETURNING r.id, r.public_ref, greatest(r.arrival, current_date) AS von, r.departure AS bis
  ), naechte AS (
    SELECT d::date AS date, count(*)::integer AS n
      FROM mit, generate_series(mit.von, mit.bis - 1, interval '1 day') AS d
     GROUP BY 1
  ), je_gruppe AS (
    -- Die Haussumme bleibt: der Gast zieht nur von einer Gruppe in die andere.
    SELECT p_from_category AS category_id, date, -n AS delta FROM naechte
    UNION ALL
    SELECT p_to_category, date, n FROM naechte
  ), bestand AS (
    UPDATE inventory_day inv
       SET sold = greatest(inv.sold + g.delta, 0), updated_at = now()
      FROM je_gruppe g
     WHERE inv.property_id = p_property AND inv.category_id = g.category_id
       AND inv.date = g.date
    RETURNING 1
  )
  SELECT mit.id, mit.public_ref FROM mit;
END $$;

COMMENT ON FUNCTION inventory_carry_room(bigint,bigint,bigint,bigint) IS
  'Verlegt die kuenftigen Reservierungen eines Zimmers mit dem Zimmer in dessen neue Gruppe, Bestand eingeschlossen.';

-- ---------------------------------------------------------------------------
-- Nachtrag fuer den Bestand, der vor dieser Migration entstanden ist.
--
-- Eng gefasst: nur Reservierungen, deren gebuchte Gruppe **kein einziges
-- aktives Zimmer** mehr hat. Dort kann die Buchung nicht mehr erfuellt
-- werden, und das zugewiesene Zimmer ist die einzige Angabe, die noch
-- stimmt. Wo die alte Gruppe noch Zimmer hat, laesst sich ein Upgrade nicht
-- von einem vergessenen Umzug unterscheiden; das bleibt der Rezeption.
--
-- Laeuft als Eigentuemer (BYPASSRLS), deshalb direkt und nicht ueber die
-- Funktion oben, die einen Mandantenkontext verlangt.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE nachtrag_0080 ON COMMIT DROP AS
SELECT r.id, r.property_id, r.category_id AS von_gruppe, z.category_id AS nach_gruppe,
       greatest(r.arrival, current_date) AS von, r.departure AS bis
  FROM reservation r
  JOIN resource z ON z.id = r.resource_id AND z.active
 WHERE r.status IN ('Optional','Confirmed','InHouse')
   AND r.departure > current_date
   AND r.block_id IS NULL
   AND z.category_id <> r.category_id
   AND z.property_id = r.property_id
   AND NOT EXISTS (SELECT 1 FROM resource a
                    WHERE a.category_id = r.category_id AND a.active);

WITH naechte AS (
  SELECT n.property_id, n.von_gruppe, n.nach_gruppe, d::date AS date
    FROM nachtrag_0080 n, generate_series(n.von, n.bis - 1, interval '1 day') AS d
), je_gruppe AS (
  SELECT property_id, von_gruppe AS category_id, date, -count(*)::integer AS delta
    FROM naechte GROUP BY 1, 2, 3
  UNION ALL
  SELECT property_id, nach_gruppe, date, count(*)::integer
    FROM naechte GROUP BY 1, 2, 3
), summe AS (
  SELECT property_id, category_id, date, sum(delta)::integer AS delta
    FROM je_gruppe GROUP BY 1, 2, 3
)
UPDATE inventory_day inv
   SET sold = greatest(inv.sold + s.delta, 0), updated_at = now()
  FROM summe s
 WHERE inv.property_id = s.property_id AND inv.category_id = s.category_id
   AND inv.date = s.date;

UPDATE reservation r
   SET category_id = n.nach_gruppe, updated_at = now()
  FROM nachtrag_0080 n
 WHERE r.id = n.id;
