-- ---------------------------------------------------------------------------
-- 0141 -- Kanal-Push ohne Jahressortierung, Ereignisse als Menge, Verlauf
--         einer Reservierung ueber einen Index.
--
-- Performance-Audit 11.10.2026, Befund 6 ("Kanal-Push sortiert synchron ein
-- ganzes Jahr") und Befund 14 ("Verlauf einer Reservierung"). Bericht unter
-- performance/audit-2026-10-11.md, gemessen gegen den Saatlauf.
--
-- 1. `room_sort_due`: "Sortieren faellig" je Haus. Der Push im Modus
--    `auto` sortierte bisher am Ende jedes Aufrufs ein ganzes Jahr, unter
--    Zeilensperre und als Rechenarbeit auf dem einen Faden der API. Jetzt
--    sortiert er nur noch die Umgebung der eigenen Buchung (die Antwort
--    nennt das Zimmer, das der Aufenthalt bekommen hat -- das braucht das
--    Umsystem sofort) und setzt diesen Vermerk; das Jahr sortiert der
--    Worker, gebuendelt, wenn eine Weile kein Push mehr kam. Zwei
--    Zeitpunkte: `due_since` (erster Vermerk) und `marked_at` (letzter).
--    Gebuendelt wird ueber den letzten, damit ein Abgleichlauf des
--    Adminpanels mit zwanzig Pushes einen Sortierlauf ausloest und nicht
--    zwanzig; der erste begrenzt das Warten, damit ein Haus, in das ohne
--    Pause gepusht wird, trotzdem drankommt.
--
--    Kein Audit: ein Arbeitsvermerk, der Minuten lebt, ist keine
--    Aenderung, nach der jemand fragt; was sortiert wurde, steht in
--    `room_sort_run`. Kein Eintrag in audit_redaction: keine Spalte
--    bezeichnet einen Menschen oder traegt ein Geheimnis.
--
-- 2. `webhook_enqueue_bulk`: viele Ereignisse einer Art in einer Anweisung.
--    Der Sortierer und der Push riefen `webhook_enqueue` je Zeile, ein
--    Sortierlauf mit vierzig Zuegen also vierzig Runden. Dasselbe Muster
--    wie `inventory_release_bulk` (0051). Die Ergaenzung, die die API
--    bisher selbst je Ereignis vornahm (Buchung und Cursorstand an
--    `reservation.*`, Migration 0075), steht jetzt hier, an einer Stelle:
--    auch der Worker reiht so ein, und er kann die API nicht importieren.
--
-- 3. Verlauf einer Reservierung. Die Naechte haben einen zusammengesetzten
--    Schluessel und damit keine `row_id`; der Verlauf fand sie bisher nur,
--    indem er das Protokoll des ganzen Hauses durchging (gemessen: 7 s fuer
--    eine Buchung im Saatlauf, 450 000 Zeilen gelesen). Ein Index auf
--    `row_key ->> 'reservation_id'` allein hilft unter der Zeilenrichtlinie
--    nicht: `->>` ist nicht LEAKPROOF, PostgreSQL darf die Bedingung also
--    nicht vor der Richtlinie pruefen und nimmt den Index nicht. Die
--    Funktion `audit_reservation_night_rows` liest deshalb als Eigentuemer
--    und prueft die Richtlinie selbst, wortgleich mit der Policy `tenant`
--    auf audit_log; sie gibt nur id und Zeitpunkt heraus, die Zeile selbst
--    liest der Aufrufer wieder unter der Richtlinie.
--
--    Der Index liegt auf dem partitionierten Eltern; PostgreSQL legt ihn
--    auf jeder Partition an und auf jeder kuenftigen mit
--    (`audit_log_ensure_partitions`).
-- ---------------------------------------------------------------------------

-- 1. Sortieren faellig ------------------------------------------------------

CREATE TABLE room_sort_due (
  property_id  bigint PRIMARY KEY REFERENCES property(id),
  due_since    timestamptz NOT NULL DEFAULT now(),
  marked_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE room_sort_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_sort_due FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON room_sort_due USING (property_id = ANY (app_property_ids()));

-- 2. Ereignisse als Menge ---------------------------------------------------
--
-- SECURITY INVOKER wie `webhook_enqueue` (0020): ohne Kontext auf die
-- Property sieht der Aufrufer keine Abonnements und reiht nichts ein.
-- Je Element ein eigener Umschlag mit eigener Referenz, in der Reihenfolge
-- des Feldes -- ein Empfaenger soll keinen Unterschied zum Einzelaufruf
-- sehen.

CREATE OR REPLACE FUNCTION webhook_enqueue_bulk(
  p_property_id bigint, p_event_type text, p_data jsonb[]
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_property_ref text;
  v_count        integer;
BEGIN
  SELECT p.public_ref INTO v_property_ref FROM property p WHERE p.id = p_property_id;
  IF v_property_ref IS NULL THEN
    RAISE EXCEPTION 'Property % liegt nicht im Kontext', p_property_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(cardinality(p_data), 0) = 0 THEN RETURN 0; END IF;

  -- MATERIALIZED: die Referenz entsteht genau einmal je Ereignis, nicht
  -- einmal je Abonnement, auch wenn der Planer den Verbund umstellt.
  WITH ereignis AS MATERIALIZED (
    SELECT x.i, generate_public_ref(16) AS event_ref,
           -- Ereignisse zu einer Reservierung tragen Buchung und
           -- Cursorstand (0075); was der Aufrufer mitgibt, gewinnt.
           CASE WHEN p_event_type LIKE 'reservation.%'
                THEN jsonb_strip_nulls(jsonb_build_object(
                       'bookingRef', (SELECT b.public_ref FROM reservation r
                                        JOIN booking b ON b.id = r.booking_id
                                       WHERE r.public_ref = x.d ->> 'reservationRef'),
                       'cursor', pg_current_xact_id()::text || '.0'))
                ELSE '{}'::jsonb END || x.d AS data
      FROM unnest(p_data) WITH ORDINALITY AS x(d, i)
  )
  INSERT INTO webhook_delivery (subscription_id, account_id, property_id,
                                event_type, event_ref, payload)
  SELECT s.id, s.account_id, p_property_id, p_event_type, e.event_ref,
         jsonb_build_object(
           'id',          e.event_ref,
           'type',        p_event_type,
           'occurredAt',  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'propertyRef', v_property_ref,
           'data',        e.data)
    FROM ereignis e
    CROSS JOIN webhook_subscription s
    JOIN property p ON p.id = p_property_id AND p.account_id = s.account_id
   WHERE s.status = 'active'
     AND (cardinality(s.event_types)  = 0 OR p_event_type  = ANY (s.event_types))
     AND (cardinality(s.property_ids) = 0 OR p_property_id = ANY (s.property_ids))
   ORDER BY e.i, s.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- 3. Verlauf: Protokollzeilen der Naechte einer Reservierung -----------------

CREATE INDEX audit_log_reservation_night ON audit_log ((row_key ->> 'reservation_id'))
  WHERE table_name = 'reservation_night';

CREATE OR REPLACE FUNCTION audit_reservation_night_rows(
  p_property bigint, p_reservation_ids bigint[]
) RETURNS TABLE (id bigint, occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.occurred_at
    FROM audit_log a
   WHERE a.table_name = 'reservation_night'
     AND a.row_key ->> 'reservation_id' = ANY (p_reservation_ids::text[])
     AND a.property_id = p_property
     -- Die Policy `tenant` auf audit_log, wortgleich: als Eigentuemer
     -- greift sie hier nicht von selbst.
     AND (a.property_id = ANY (app_property_ids())
          OR a.account_id = ANY (app_account_ids()))
$$;
