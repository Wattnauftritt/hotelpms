-- Performanceaudit (docs/24-performanceaudit.md, "Dringend", erster Punkt):
-- der Nachtlauf rief `inventory_release`/`inventory_unblock` je Reservierung/
-- Sperrung einzeln auf -- bei No-Shows, verfallenen Optionen und ablaufenden
-- Kontingenten zwei bis drei Abfragen je Zeile, jede Nacht ueber den ganzen
-- Bestand des Hauses. Exakt die Form, die dieses System zweimal schon als
-- Fehler gefunden hat (Migration 0013, 0015), hier im empfindlichsten Pfad
-- (Bestand, Nachtlauf) nie nachgezogen.
--
-- Diese beiden Funktionen sind das mengenbasierte Gegenstueck zu
-- `inventory_release`/`inventory_unblock`: statt eines einzelnen
-- (Kategorie, Zeitraum, Anzahl) nehmen sie parallele Arrays entgegen, ein
-- Eintrag je Zeile des Aufrufers, und wirken in einer einzigen Anweisung.
--
-- Die Semantik bleibt bewusst identisch zur Einzelfunktion: eine Freigabe
-- wirkt auf Kategorie *und* Haussumme (category_id 0), taggenau ueber den
-- halboffenen Zeitraum [from, to), und `updated_at` rueckt mit -- wie in
-- inventory_release/inventory_unblock, damit die Zeile weiter sagt, wann
-- sie sich zuletzt geaendert hat. Bei mehreren Eintraegen fuer denselben
-- Tag -- zwei No-Shows derselben Kategorie am selben Anreisetag etwa --
-- addieren sich die Mengen vor dem Schreiben, statt die Zeile zweimal
-- (und damit potenziell mit einer Zwischenlesung) zu treffen.

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
    -- Wirkung auf die eigene Kategorie und auf die Haussumme (0) -- wie
    -- `inventory_release`, nur als Menge statt als Einzelaufruf.
    SELECT category_id, date, cnt FROM naechte
    UNION ALL
    SELECT 0, date, cnt FROM naechte
  ), summe AS (
    SELECT category_id, date, sum(cnt) AS gesamt FROM je_zeile GROUP BY category_id, date
  )
  UPDATE inventory_day inv SET sold = greatest(inv.sold - s.gesamt, 0), updated_at = now()
    FROM summe s
   WHERE inv.property_id = p_property AND inv.category_id = s.category_id
     AND inv.date = s.date;
END $$;

CREATE OR REPLACE FUNCTION inventory_unblock_bulk(
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
  UPDATE inventory_day inv SET blocked = greatest(inv.blocked - s.gesamt, 0), updated_at = now()
    FROM summe s
   WHERE inv.property_id = p_property AND inv.category_id = s.category_id
     AND inv.date = s.date;
END $$;
