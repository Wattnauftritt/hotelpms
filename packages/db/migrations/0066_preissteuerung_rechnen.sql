-- ---------------------------------------------------------------------------
-- 0066 -- Ein Schreibweg fuer Verkaufspreise, und die Preissteuerung darauf
-- (Dokument 32).
--
-- Anforderung: eine von der Steuerung uebernommene Aenderung soll denselben
-- Weg gehen wie eine von Hand gepflegte, damit abgeleitete Raten, die
-- Aenderungsmeldung an den Channel Manager und die Webhooks ihr folgen.
--
-- **Befund beim Nachsehen: diesen Weg gab es nicht.** Die Preispflege
-- (`PUT /v1/rates/bulk`) schrieb `rate_day` und sonst nichts:
--
--   1. Abgeleitete Raten folgten erst, wenn jemand "neu rechnen" drueckte.
--      Bis dahin verkaufte der Channel Manager die Nicht-Stornierbare zum
--      alten Abstand -- je nach Richtung teurer als die Flexible.
--   2. `updated_at` wurde beim Einfuegen gesetzt, beim Aendern nicht. Die
--      Aenderungsmeldung (`/v1/channel/ari/rates?since=`) sah eine
--      Preisaenderung an einem schon gepflegten Tag deshalb **nie**; nur ein
--      Vollabgleich holte sie. Still, und mit Ansage in 0023, deren Kommentar
--      genau das Gegenteil behauptet. Dasselbe beim Neurechnen der
--      abgeleiteten Raten und bei den Restriktionen (dort in rates.ts
--      behoben).
--   3. Ein Ereignis `rate.changed` gab es nicht, obwohl Dokument 04 es zu den
--      Grundereignissen zaehlt.
--
-- Deshalb zuerst der Weg -- `rate_prices_write` --, und die Preispflege,
-- das Neurechnen und die Steuerung benutzen ihn alle drei. Er liegt in der
-- Datenbank und nicht in der API, weil sein zweiter Aufrufer der Worker ist
-- und der von apps/api nichts importieren darf.
--
-- Mengenbasiert durchgehend: kein Schreiben je Tag, keine Unterabfrage je
-- Zeile gegen eine Tabelle. Ein Lauf ueber ein Jahr und zehn Plaene ist eine
-- Handvoll Anweisungen, gleich wie viele Tage er umfasst.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Abgeleitete Raten neu rechnen, Ebene fuer Ebene.
--
-- Vorher eine Schleife in rates.ts mit einer Anweisung **je abgeleitetem
-- Plan**. Jetzt eine je Ableitungsstufe -- bei den ueblichen ein, zwei Stufen
-- also eine oder zwei, gleich wie viele Plaene darauf sitzen. Die Rundung ist
-- dieselbe wie bisher und wie `derivePrice` im Domaenenkern; ein Test haelt
-- beide zusammen.
--
-- `p_roots`: nur die Nachfahren dieser Plaene. NULL heisst alle, und nur dann
-- ist ein unerreichter Plan ein Zyklus -- mit Wurzeln ist er schlicht ein
-- anderer Ast.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rate_derived_rebuild(
  p_property bigint, p_from date, p_to date, p_roots bigint[] DEFAULT NULL
) RETURNS TABLE (plans integer, days integer, cycle boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_ids    bigint[];
  v_depths integer[];
  v_max    integer;
  v_active integer;
  v_rows   integer;
  v_days   integer := 0;
BEGIN
  PERFORM assert_property_in_context(p_property);

  WITH RECURSIVE abgeleitet AS (
    SELECT id, base_rate_plan_id FROM rate_plan
     WHERE property_id = p_property AND base_rate_plan_id IS NOT NULL AND active
  ), stufe (id, tiefe) AS (
    SELECT a.id, 1 FROM abgeleitet a
     WHERE CASE WHEN p_roots IS NULL
                -- Wurzel: die Basis ist keine aktive abgeleitete Rate. Eine
                -- stillgelegte zaehlt als fester Preis, wie bisher.
                THEN NOT EXISTS (SELECT 1 FROM abgeleitet b WHERE b.id = a.base_rate_plan_id)
                ELSE a.base_rate_plan_id = ANY (p_roots) END
    UNION ALL
    SELECT a.id, s.tiefe + 1 FROM abgeleitet a JOIN stufe s ON a.base_rate_plan_id = s.id
     WHERE s.tiefe < 32
  ), eben AS (
    SELECT id, max(tiefe) AS tiefe FROM stufe GROUP BY id
  )
  SELECT array_agg(id), array_agg(tiefe), max(tiefe),
         (SELECT count(*)::integer FROM abgeleitet)
    INTO v_ids, v_depths, v_max, v_active
    FROM eben;

  IF p_roots IS NULL AND coalesce(cardinality(v_ids), 0) <> v_active THEN
    RETURN QUERY SELECT coalesce(cardinality(v_ids), 0), 0, true;
    RETURN;
  END IF;

  FOR v_level IN 1 .. coalesce(v_max, 0) LOOP
    INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent, updated_at)
    SELECT p_property, rp.id, b.date,
           ARRAY(SELECT greatest(
                          CASE WHEN rp.derive_kind = 'amount' THEN u.e + rp.derive_value
                               ELSE round(u.e * (10000 + rp.derive_value * 100) / 10000.0)::bigint
                          END, 0)
                   FROM unnest(b.price_cent) WITH ORDINALITY AS u(e, i) ORDER BY u.i),
           now()
      FROM unnest(v_ids, v_depths) AS l(id, tiefe)
      JOIN rate_plan rp ON rp.id = l.id
      JOIN rate_day b ON b.rate_plan_id = rp.base_rate_plan_id
                     AND b.date BETWEEN p_from AND p_to
     WHERE l.tiefe = v_level
    ON CONFLICT (rate_plan_id, date) DO UPDATE
       SET price_cent = EXCLUDED.price_cent, updated_at = now()
     -- Nur was sich aendert. Sonst meldete die Aenderungsmeldung nach jedem
     -- Neurechnen das ganze Jahr als geaendert.
     WHERE rate_day.price_cent IS DISTINCT FROM EXCLUDED.price_cent;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_days := v_days + v_rows;
  END LOOP;

  RETURN QUERY SELECT coalesce(cardinality(v_ids), 0), v_days, false;
END $$;

-- ---------------------------------------------------------------------------
-- Der Schreibweg fuer Verkaufspreise.
--
-- Je Zeile Plan, Tag, Preis je Belegung. Der Preis kommt als Text ('{9000,
-- 12000}'), weil ein zweidimensionales Feld in PostgreSQL rechteckig sein
-- muss und zwei Plaene verschiedener Kategorien verschieden viele
-- Belegungsstufen haben.
--
-- `p_origin` sagt, wer schreibt: manual (ein Mensch), external (eine
-- Schnittstelle), rules (die Steuerung). Zwei Folgen:
--
--   - Was nicht von der Steuerung kommt, setzt den Grundpreis neu: der
--     Gedaechtnisstand der Steuerung fuer diese Tage faellt weg (0065, Kopf).
--     Ohne das hielte eine Preisaenderung, die zufaellig den gesteuerten
--     Betrag trifft, den alten Grundpreis fest.
--   - Eine Schnittstelle darf einen von den Regeln gesteuerten Plan nicht
--     beschreiben. Die Route weist das vorher lesbar ab; hier steht es, damit
--     es auch fuer den naechsten Aufrufer gilt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rate_prices_write(
  p_property bigint, p_plans bigint[], p_dates date[], p_prices text[], p_origin text
) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_changed integer;
  v_derived integer;
  v_from    date;
  v_to      date;
  v_refs    text[];
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF p_plans IS NULL OR cardinality(p_plans) = 0 THEN RETURN 0; END IF;

  -- Haustrennung. Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus:
  -- ein Plan eines anderen Hauses desselben Accounts kaeme sonst durch.
  IF EXISTS (SELECT 1 FROM unnest(p_plans) AS x(id)
              WHERE NOT EXISTS (SELECT 1 FROM rate_plan rp
                                 WHERE rp.id = x.id AND rp.property_id = p_property)) THEN
    RAISE EXCEPTION 'Ratenplan gehoert nicht zu Property %', p_property
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_origin = 'external' AND EXISTS (
       SELECT 1 FROM rate_plan_steering s
        WHERE s.rate_plan_id = ANY (p_plans) AND s.source = 'rules') THEN
    RAISE EXCEPTION 'Ratenplan wird von den Regeln gesteuert'
      USING ERRCODE = 'check_violation';
  END IF;

  WITH neu AS (
    SELECT x.plan, x.date, x.price::bigint[] AS price
      FROM unnest(p_plans, p_dates, p_prices) AS x(plan, date, price)
  ), geschrieben AS (
    INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent, updated_at)
    SELECT p_property, plan, date, price, now() FROM neu
    ON CONFLICT (rate_plan_id, date) DO UPDATE
       SET price_cent = EXCLUDED.price_cent, updated_at = now()
     -- updated_at gehoert zur Aenderung, nicht nur zum Einfuegen: daran
     -- erkennt der Channel Manager, was er neu holen muss (Befund 2 oben).
     WHERE rate_day.price_cent IS DISTINCT FROM EXCLUDED.price_cent
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM geschrieben;

  IF p_origin <> 'rules' THEN
    DELETE FROM rate_steer_state s
     USING unnest(p_plans, p_dates) AS x(plan, date)
     WHERE s.rate_plan_id = x.plan AND s.date = x.date;
  END IF;

  SELECT min(d), max(d) INTO v_from, v_to FROM unnest(p_dates) AS d;
  SELECT r.days INTO v_derived FROM rate_derived_rebuild(p_property, v_from, v_to, p_plans) r;

  IF v_changed + coalesce(v_derived, 0) > 0 THEN
    SELECT array_agg(public_ref ORDER BY public_ref) INTO v_refs
      FROM rate_plan WHERE id IN (SELECT DISTINCT unnest(p_plans));
    -- Ein Ereignis je Schreibvorgang, nicht je Tag: ein Jahr Preise sind
    -- sonst 365 Zustellungen, und der Empfaenger holt die Werte ohnehin
    -- ueber ARI. Das Ereignis sagt, **dass** und **wo**; ARI sagt, was.
    PERFORM webhook_enqueue(p_property, 'rate.changed', jsonb_build_object(
      'origin', p_origin, 'ratePlanRefs', to_jsonb(v_refs),
      'from', v_from::text, 'to', v_to::text,
      'days', v_changed, 'derivedDays', coalesce(v_derived, 0)));
  END IF;

  RETURN v_changed;
END $$;

-- ---------------------------------------------------------------------------
-- Rasterwerte der Rundung. Alles in Cent, ganzzahlig.
--
--   none    jeder Cent
--   euro    volle Euro
--   ninety  ,90 -- 9,90 / 19,90 / 109,90
--
-- `p_dir`: nearest (kaufmaennisch), up, down. Negative Werte gibt es hier
-- nicht: ein Preis unter null ist kein Preis, er wird vorher auf null
-- gesetzt, und die Ganzzahldivision rundet so richtig ab.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rate_steer_grid(p_x bigint, p_rounding text, p_dir text)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rounding
    WHEN 'euro' THEN
      CASE p_dir WHEN 'up'   THEN ((greatest(p_x, 0) + 99) / 100) * 100
                 WHEN 'down' THEN (greatest(p_x, 0) / 100) * 100
                 ELSE             ((greatest(p_x, 0) + 50) / 100) * 100 END
    WHEN 'ninety' THEN
      -- Dasselbe Raster wie bei vollen Euro, um zehn Cent verschoben.
      greatest(CASE p_dir WHEN 'up'   THEN ((greatest(p_x, 0) + 109) / 100) * 100 - 10
                          WHEN 'down' THEN ((greatest(p_x, 0) + 10) / 100) * 100 - 10
                          ELSE             ((greatest(p_x, 0) + 60) / 100) * 100 - 10 END, 0)
    ELSE greatest(p_x, 0)
  END
$$;

/*
 * In die Leitplanken holen, moeglichst auf einen Rasterwert. Laesst das Band
 * keinen Rasterwert zu (Mindestpreis 120,10, Hoechstpreis 120,50, volle
 * Euro), gewinnt die Leitplanke vor der Rundung: ein Preis mit krummer
 * Endung ist ein Schoenheitsfehler, einer unter dem Mindestpreis ein Schaden.
 */
CREATE OR REPLACE FUNCTION rate_steer_clamp(
  p_t bigint, p_lo bigint, p_hi bigint, p_rounding text
) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE u bigint; t bigint := p_t;
BEGIN
  IF t < p_lo THEN
    u := rate_steer_grid(p_lo, p_rounding, 'up');
    t := CASE WHEN p_hi IS NULL OR u <= p_hi THEN u ELSE p_lo END;
  END IF;
  IF p_hi IS NOT NULL AND t > p_hi THEN
    u := rate_steer_grid(p_hi, p_rounding, 'down');
    t := CASE WHEN u >= p_lo THEN u ELSE p_hi END;
  END IF;
  RETURN t;
END $$;

/*
 * Der gesteuerte Preis fuer **eine** Belegungsstufe. Dieselbe Rechnung steht
 * als `steerPrice` im Domaenenkern; ein Test vergleicht beide.
 *
 *   p_base  Grundpreis (nie der zuletzt gesteuerte, siehe 0065)
 *   p_cur   aktueller Verkaufspreis, nur fuer die Schrittgrenze
 *   p_pct   Summe der Prozentwirkungen in Basispunkten
 *   p_amt   Summe der Betragswirkungen in Cent
 *
 * Reihenfolge, und warum:
 *   1. Wirkung auf den Grundpreis, kaufmaennisch auf den Cent, dann auf das
 *      Raster. Ohne Wirkung bleibt der Grundpreis, wie er ist -- auch
 *      ungerundet: ihn hat ein Mensch so gewollt.
 *   2. Leitplanken. Sie begrenzen die Wirkung, nicht den Grundpreis: liegt
 *      der schon unter dem Mindestpreis, wird nicht weiter rabattiert, aber
 *      auch nicht angehoben.
 *   3. Schrittgrenze gegen den aktuellen Preis, auf das Raster nach innen.
 *      Rueckt das Raster keinen Schritt vor, geht es um genau einen
 *      Rasterwert weiter -- sonst bliebe ein Preis, dessen Schritt kleiner
 *      als ein Euro ist, fuer immer stehen.
 *   4. Noch einmal Leitplanken: sie sind hart, die Schrittgrenze ist es nicht.
 */
CREATE OR REPLACE FUNCTION rate_steer_price(
  p_base bigint, p_cur bigint, p_pct integer, p_amt bigint,
  p_min bigint, p_max bigint, p_rounding text, p_step_bp integer
) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  t  bigint;
  lo bigint;
  hi bigint;
  d  bigint;
  s  bigint;
BEGIN
  IF p_base IS NULL THEN RETURN NULL; END IF;

  IF coalesce(p_pct, 0) <> 0 OR coalesce(p_amt, 0) <> 0 THEN
    t := p_base + round(p_base * coalesce(p_pct, 0) / 10000.0)::bigint + coalesce(p_amt, 0);
    t := rate_steer_grid(greatest(t, 0), p_rounding, 'nearest');
  ELSE
    t := p_base;
  END IF;

  lo := CASE WHEN p_min IS NULL THEN 0 ELSE least(p_base, p_min) END;
  hi := CASE WHEN p_max IS NULL THEN NULL ELSE greatest(p_base, p_max) END;
  t := rate_steer_clamp(t, lo, hi, p_rounding);

  IF p_step_bp IS NOT NULL AND p_cur IS NOT NULL AND p_cur > 0 AND t <> p_cur THEN
    d := (p_cur * p_step_bp) / 10000;
    IF t > p_cur + d THEN
      s := rate_steer_grid(p_cur + d, p_rounding, 'down');
      IF s <= p_cur THEN s := rate_steer_grid(p_cur + 1, p_rounding, 'up'); END IF;
      t := least(s, t);
    ELSIF t < p_cur - d THEN
      s := rate_steer_grid(p_cur - d, p_rounding, 'up');
      IF s >= p_cur THEN s := rate_steer_grid(p_cur - 1, p_rounding, 'down'); END IF;
      t := greatest(s, t);
    END IF;
    t := rate_steer_clamp(t, lo, hi, p_rounding);
  END IF;

  RETURN t;
END $$;

-- ---------------------------------------------------------------------------
-- Die Vorschau: je gesteuertem Plan und Tag Grundpreis, aktueller Preis,
-- Vorschlag, wirkende Regeln, Belegung. Eine Anweisung fuer den ganzen
-- Zeitraum -- ein Verbund aus Tagen, Belegung und Regeln, keine Schleife.
--
-- **Belegung aus `inventory_day`, nicht aus `business_day_stat`.** Der Zaehler
-- sagt, was gerade gebunden ist, und genau das will die Steuerung wissen;
-- die Tagesstatistik sagt, wie es war, und ist fuer einen kuenftigen Tag
-- leer (0014). Gebunden heisst verkauft **oder** fuer ein Kontingent
-- gehalten: beides steht nicht mehr zum Verkauf. Die Kapazitaet ist schon
-- ohne Out-of-Order gerechnet (0005) -- ein gesperrtes Zimmer ist nicht
-- verkaeuflich, eines ausser Dienst schon --, also stimmt die Quote ohne
-- weiteres Zutun. Ohne Kapazitaet gibt es keine Quote, und eine
-- Belegungsregel wirkt dann nicht: lieber kein Aufschlag als einer auf
-- eine Division durch null.
--
-- Nur Tage mit Preis: was keinen Grundpreis hat, kann nicht gesteuert
-- werden. Nur ab dem Geschaeftstag: die Vergangenheit verkauft niemand mehr.
--
-- `token` ist ein Fingerabdruck aller vorgeschlagenen Aenderungen. Wer
-- uebernimmt, schickt ihn mit; hat sich seither etwas bewegt -- eine
-- Buchung, ein Preis --, passt er nicht mehr, und es wird nichts
-- uebernommen, was niemand gesehen hat.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rate_steer_preview(
  p_property bigint, p_from date, p_to date, p_business_date date
) RETURNS TABLE (
  rate_plan_id bigint, category_id bigint, date date, lead_days integer,
  occupancy_bp integer, house_occupancy_bp integer,
  current_cent bigint[], base_cent bigint[], new_cent bigint[],
  rule_ids bigint[], changed boolean, token text
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH plaene AS (
    SELECT rp.id, rp.category_id, s.min_cent, s.max_cent, s.rounding, s.max_step_bp
      FROM rate_plan rp
      JOIN rate_plan_steering s ON s.rate_plan_id = rp.id
     WHERE rp.property_id = p_property AND rp.active AND s.source = 'rules'
       -- Eine abgeleitete Rate folgt ihrer Basis, sie wird nicht selbst
       -- gesteuert: sonst wirkten die Regeln zweimal.
       AND rp.base_rate_plan_id IS NULL
  ), tage AS (
    SELECT p.id, p.category_id, p.min_cent, p.max_cent, p.rounding, p.max_step_bp,
           rd.date, rd.price_cent AS current_cent,
           -- Der Kern der Bauart: steht noch der Preis da, den die Steuerung
           -- geschrieben hat, gilt ihr gemerkter Grundpreis; sonst ist der
           -- stehende Preis der neue Grundpreis.
           CASE WHEN st.applied_cent = rd.price_cent THEN st.base_cent
                ELSE rd.price_cent END AS base_cent,
           (rd.date - p_business_date) AS lead_days,
           (EXTRACT(isodow FROM rd.date)::integer - 1)::smallint AS weekday
      FROM plaene p
      JOIN rate_day rd ON rd.rate_plan_id = p.id
                      AND rd.date BETWEEN greatest(p_from, p_business_date) AND p_to
      LEFT JOIN rate_steer_state st ON st.rate_plan_id = rd.rate_plan_id AND st.date = rd.date
  ), belegung AS (
    SELECT i.category_id, i.date,
           CASE WHEN i.capacity > 0
                THEN ((i.sold + i.blocked) * 10000 / i.capacity)::integer END AS bp
      FROM inventory_day i
     WHERE i.property_id = p_property
       AND i.date BETWEEN greatest(p_from, p_business_date) AND p_to
  ), mit_belegung AS (
    SELECT t.*, bk.bp AS occ_cat, bh.bp AS occ_house
      FROM tage t
      LEFT JOIN belegung bk ON bk.category_id = t.category_id AND bk.date = t.date
      LEFT JOIN belegung bh ON bh.category_id = 0 AND bh.date = t.date
  ), treffer AS (
    -- Je Plan, Tag und Ausloeser die staerkste Regel: gemessen an ihrer
    -- Wirkung auf den Grundpreis der ersten Belegungsstufe, bei Gleichstand
    -- die aeltere.
    SELECT DISTINCT ON (m.id, m.date, r.kind)
           m.id AS plan_id, m.date, r.id AS rule_id, r.effect_kind, r.effect_value
      FROM mit_belegung m
      JOIN rate_steer_rule r
        ON r.property_id = p_property AND r.active AND r.archived_at IS NULL
       AND (r.rate_plan_id IS NULL OR r.rate_plan_id = m.id)
       AND (r.category_id IS NULL OR r.category_id = m.category_id)
     WHERE (r.occupancy_min_bp IS NULL OR
            (CASE r.occupancy_scope WHEN 'house' THEN m.occ_house ELSE m.occ_cat END)
              >= r.occupancy_min_bp)
       AND (r.occupancy_below_bp IS NULL OR
            (CASE r.occupancy_scope WHEN 'house' THEN m.occ_house ELSE m.occ_cat END)
              < r.occupancy_below_bp)
       AND (r.lead_min_days IS NULL OR m.lead_days >= r.lead_min_days)
       AND (r.lead_below_days IS NULL OR m.lead_days < r.lead_below_days)
       AND (r.weekdays IS NULL OR m.weekday = ANY (r.weekdays))
       AND (r.period_from IS NULL OR m.date BETWEEN r.period_from AND r.period_to)
     ORDER BY m.id, m.date, r.kind,
              abs(CASE r.effect_kind WHEN 'percent' THEN m.base_cent[1] * r.effect_value
                                     ELSE r.effect_value::bigint * 10000 END) DESC,
              r.id
  ), summe AS (
    SELECT plan_id, date,
           coalesce(sum(effect_value) FILTER (WHERE effect_kind = 'percent'), 0)::integer AS pct,
           coalesce(sum(effect_value) FILTER (WHERE effect_kind = 'amount'), 0)::bigint AS amt,
           array_agg(rule_id ORDER BY rule_id) AS rule_ids
      FROM treffer GROUP BY plan_id, date
  ), ergebnis AS (
    SELECT m.id AS rate_plan_id, m.category_id, m.date, m.lead_days,
           m.occ_cat AS occupancy_bp, m.occ_house AS house_occupancy_bp,
           m.current_cent, m.base_cent,
           ARRAY(SELECT rate_steer_price(u.e, m.current_cent[u.i]::bigint, s.pct, s.amt,
                                         m.min_cent, m.max_cent, m.rounding, m.max_step_bp)
                   FROM unnest(m.base_cent) WITH ORDINALITY AS u(e, i)
                  ORDER BY u.i) AS new_cent,
           coalesce(s.rule_ids, '{}'::bigint[]) AS rule_ids
      FROM mit_belegung m
      LEFT JOIN summe s ON s.plan_id = m.id AND s.date = m.date
  )
  SELECT e.rate_plan_id, e.category_id, e.date, e.lead_days,
         e.occupancy_bp, e.house_occupancy_bp,
         e.current_cent, e.base_cent, e.new_cent, e.rule_ids,
         e.new_cent IS DISTINCT FROM e.current_cent AS changed,
         md5(coalesce(string_agg(
               e.rate_plan_id::text || ':' || e.date::text || ':'
               || coalesce(e.current_cent::text, '-') || '>' || e.new_cent::text, ';')
             FILTER (WHERE e.new_cent IS DISTINCT FROM e.current_cent)
             OVER (ORDER BY e.rate_plan_id, e.date
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING), '')) AS token
    FROM ergebnis e
   ORDER BY e.rate_plan_id, e.date
$$;

-- ---------------------------------------------------------------------------
-- Uebernehmen. Ein Aufruf, eine Momentaufnahme: Vorschau, Pruefung des
-- Fingerabdrucks, Lauf, Verlauf, Gedaechtnis und Preise in **einer**
-- Anweisung. Zwei Anweisungen saehen unter READ COMMITTED zwei verschiedene
-- Staende, und dazwischen koennte eine Buchung die Belegung verschoben haben.
--
-- p_kind auto:  der Worker. Laeuft nur im automatischen Modus und nur einmal
--               je Geschaeftstag (eindeutiger Index am Lauf); ein zweiter
--               Aufruf findet den Lauf vor und tut nichts.
-- p_kind apply: eine Uebernahme aus der Vorschau, mit Fingerabdruck und
--               wahlweise einer Auswahl aus Plan und Tag.
--
-- Fristen gegen den Geschaeftstag, nicht gegen now(): sonst faende ein
-- Wiederholungslauf nach Mitternacht andere Tage als der erste.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rate_steer_apply(
  p_property bigint, p_kind text, p_from date, p_to date,
  p_expected_token text, p_plans bigint[], p_dates date[]
) RETURNS TABLE (run_id bigint, changed integer, token text, business_date date)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
-- Die Rueckgabespalten heissen wie Spalten von rate_steer_run; gemeint ist
-- in den Anweisungen unten immer die Spalte.
#variable_conflict use_column
DECLARE
  v_bd      date;
  v_mode    text;
  v_horizon integer;
  v_from    date;
  v_to      date;
BEGIN
  PERFORM assert_property_in_context(p_property);
  -- Zwei Uebernahmen fuer dasselbe Haus nacheinander, nicht ineinander:
  -- beide laesen sonst denselben Grundpreis und schrieben ihr Gedaechtnis
  -- uebereinander.
  PERFORM pg_advisory_xact_lock(hashtext('rate_steer'), p_property::integer);

  SELECT bd.date INTO v_bd FROM business_day bd
   WHERE bd.property_id = p_property AND bd.status = 'open'
   ORDER BY bd.date LIMIT 1;
  IF v_bd IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, 0, NULL::text, NULL::date;
    RETURN;
  END IF;

  SELECT s.mode, s.horizon_days INTO v_mode, v_horizon
    FROM rate_steer_setting s WHERE s.property_id = p_property;
  v_mode := coalesce(v_mode, 'suggest');
  v_horizon := coalesce(v_horizon, 365);

  -- Der Worker tickt alle fuenf Minuten. Ein schon erledigter Tag kostet
  -- deshalb nur diese Abfrage und nicht die Rechnung ueber ein Jahr; der
  -- eindeutige Index unten bleibt die eigentliche Sicherung.
  IF p_kind = 'auto' AND (v_mode <> 'auto' OR EXISTS (
       SELECT 1 FROM rate_steer_run r
        WHERE r.property_id = p_property AND r.business_date = v_bd AND r.kind = 'auto')) THEN
    RETURN QUERY SELECT NULL::bigint, 0, NULL::text, v_bd;
    RETURN;
  END IF;

  v_from := CASE WHEN p_kind = 'auto' THEN v_bd ELSE greatest(p_from, v_bd) END;
  v_to   := CASE WHEN p_kind = 'auto' THEN v_bd + v_horizon - 1
                 ELSE least(p_to, v_bd + v_horizon - 1) END;

  RETURN QUERY
  WITH v AS MATERIALIZED (
    SELECT * FROM rate_steer_preview(p_property, v_from, v_to, v_bd)
  ), fingerabdruck AS (
    SELECT coalesce((SELECT v.token FROM v LIMIT 1), md5('')) AS t
  ), auswahl AS (
    SELECT v.* FROM v, fingerabdruck f
     WHERE v.changed
       AND (p_expected_token IS NULL OR f.t = p_expected_token)
       AND (p_plans IS NULL OR (v.rate_plan_id, v.date) IN (
              SELECT x.plan, x.day FROM unnest(p_plans, p_dates) AS x(plan, day)))
  ), lauf AS (
    INSERT INTO rate_steer_run (property_id, business_date, kind, mode, date_from, date_to,
                                user_id, changed_days)
    SELECT p_property, v_bd, p_kind, v_mode, v_from, v_to, app_user_id(),
           (SELECT count(*)::integer FROM auswahl)
     -- Ein automatischer Lauf wird auch ohne Aenderung vermerkt: er markiert
     -- den Tag als erledigt. Eine Uebernahme ohne Aenderung ist keine.
     WHERE p_kind = 'auto' OR EXISTS (SELECT 1 FROM auswahl)
    ON CONFLICT (property_id, business_date) WHERE kind = 'auto' DO NOTHING
    RETURNING id
  ), verlauf AS (
    INSERT INTO rate_steer_change (run_id, property_id, rate_plan_id, date, old_cent,
                                   new_cent, base_cent, rule_ids, occupancy_bp)
    SELECT l.id, p_property, a.rate_plan_id, a.date, a.current_cent, a.new_cent,
           a.base_cent, a.rule_ids, a.occupancy_bp
      FROM auswahl a CROSS JOIN lauf l
    RETURNING 1
  ), gedaechtnis AS (
    INSERT INTO rate_steer_state (rate_plan_id, date, property_id, base_cent, applied_cent)
    SELECT a.rate_plan_id, a.date, p_property, a.base_cent, a.new_cent
      FROM auswahl a CROSS JOIN lauf l
    ON CONFLICT (rate_plan_id, date) DO UPDATE
       SET base_cent = EXCLUDED.base_cent, applied_cent = EXCLUDED.applied_cent
    RETURNING 1
  )
  -- `verlauf` und `gedaechtnis` liest niemand; ausgefuehrt werden sie
  -- trotzdem, vollstaendig und genau einmal (so verhaelt sich WITH mit
  -- schreibenden Anweisungen).
  SELECT (SELECT l.id FROM lauf l),
         -- Dieselbe Funktion wie die Preispflege von Hand: abgeleitete
         -- Raten, Aenderungsmeldung und Ereignis folgen von selbst.
         CASE WHEN EXISTS (SELECT 1 FROM lauf) THEN
           rate_prices_write(p_property,
             (SELECT array_agg(a.rate_plan_id ORDER BY a.rate_plan_id, a.date) FROM auswahl a),
             (SELECT array_agg(a.date ORDER BY a.rate_plan_id, a.date) FROM auswahl a),
             (SELECT array_agg(a.new_cent::text ORDER BY a.rate_plan_id, a.date)
                FROM auswahl a),
             'rules')
         ELSE 0 END,
         (SELECT f.t FROM fingerabdruck f),
         v_bd;
END $$;
