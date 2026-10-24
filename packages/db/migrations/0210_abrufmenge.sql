-- ---------------------------------------------------------------------------
-- 0210 -- Wie viele Gastdatensaetze wer abruft, je Stunde.
--
-- Bedrohungsanalyse 23.10.2026, E2
-- (/mnt/project-files/security/bedrohungsanalyse-2026-10-23.md). Der
-- Befund: Wer mit einem gueltigen Zugang -- einem gestohlenen Kennwort, dem
-- Token des Adminpanels, einer uebernommenen Sitzung -- die Gaestedatei
-- abzieht, hinterliess bisher keine Spur. Gelesenes schreibt der
-- Audit-Trigger nicht mit, und das Protokoll sagte nicht, wer fragte. Genau
-- so sind 2026 die Gastdaten bei HotelNetSolutions abgeflossen: ueber eine
-- Schnittstelle, mit gueltigen Zugangsdaten.
--
-- Gezaehlt wird je Aufrufer und Stunde: Anfragen und Datensaetze aus den
-- Routen, die Gaeste oder Reservierungen in Mengen liefern. Der Worker
-- vergleicht jede abgeschlossene Stunde mit den vierzehn Tagen davor und
-- meldet einen Ausreisser als Sicherheitsereignis `access_volume`.
--
-- Die Adresse steht ungekuerzt da (Sven, 23.10.2026), aber nur 30 Tage:
-- der Zaehler ist ein Arbeitsmittel fuer den Vergleich, kein Beleg. Was
-- auffaellt, wird ein Sicherheitsereignis und lebt dort nach dessen Fristen.
-- ---------------------------------------------------------------------------

CREATE TABLE access_volume (
  -- "user:<id>", "client:<ref>", "terminal:<id>". Kein Fremdschluessel: ein
  -- gesperrter Zugang bleibt als Aufrufer stehen.
  principal_key text NOT NULL CHECK (char_length(principal_key) <= 80),
  account_id    bigint,
  hour          timestamptz NOT NULL,
  requests      integer NOT NULL DEFAULT 0,
  rows_returned integer NOT NULL DEFAULT 0,
  -- Die zuletzt gesehene Adresse der Stunde. Eine zweite in derselben
  -- Stunde ist kein Grund fuer eine zweite Zeile; der Vergleich braucht sie
  -- nicht, und die Anzeige im Ereignis nennt die letzte.
  origin        inet,
  PRIMARY KEY (principal_key, hour)
);
CREATE INDEX access_volume_hour ON access_volume (hour);

-- Keine Zeilenrichtlinie, aber auch kein Zugriff fuer die Anwendung: sie
-- schreibt einzig ueber access_volume_add(), und gelesen wird nur im Worker
-- ueber access_volume_outliers(). Ein Mandant soll nicht sehen, wie viel ein
-- anderer abruft, und die Anwendung muss es nie lesen.
REVOKE ALL ON access_volume FROM hotelpms_app, hotelpms_readonly;

CREATE OR REPLACE FUNCTION access_volume_add(
  p_key text, p_account bigint, p_rows integer, p_origin inet
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO access_volume (principal_key, account_id, hour, requests,
                             rows_returned, origin)
  VALUES (p_key, p_account, date_trunc('hour', now()), 1,
          greatest(p_rows, 0), p_origin)
  ON CONFLICT (principal_key, hour) DO UPDATE
     SET requests      = access_volume.requests + 1,
         rows_returned = access_volume.rows_returned + EXCLUDED.rows_returned,
         origin        = EXCLUDED.origin,
         account_id    = COALESCE(access_volume.account_id, EXCLUDED.account_id)
$$;
REVOKE ALL ON FUNCTION access_volume_add(text, bigint, integer, inet)
  FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION access_volume_add(text, bigint, integer, inet) TO hotelpms_app;

/*
 * Die Ausreisser einer abgeschlossenen Stunde.
 *
 * **Menge:** mindestens p_min Datensaetze und mehr als das p_factor-fache
 * der groessten Stunde dieses Aufrufers in den vierzehn Tagen davor. Die
 * groesste Stunde und nicht der Durchschnitt: das Adminpanel holt nachts
 * einmal tausend Reservierungen und den Rest des Tages nichts; gegen den
 * Durchschnitt waere jede Nacht ein Alarm. Ein Aufrufer ohne Vorgeschichte
 * hat die Grenze null -- ein neuer Zugang, der sofort fuenfhundert Gaeste
 * zieht, ist genau der Fall, nach dem gesucht wird.
 *
 * **Nacht:** ein Mensch (user:...), der zwischen 0 und 5 Uhr Ortszeit des
 * Betriebs mindestens p_night_min Datensaetze liest und in den vierzehn
 * Naechten davor nie nachts gelesen hat. Maschinen arbeiten nachts; eine
 * Rezeptionistin um drei Uhr ist eine Frage wert.
 */
CREATE OR REPLACE FUNCTION access_volume_outliers(
  p_hour timestamptz, p_min integer, p_factor numeric, p_night_min integer
) RETURNS TABLE (principal_key text, account_id bigint, rows_returned integer,
                 requests integer, baseline integer, origin text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH jetzt AS (
    SELECT v.* FROM access_volume v WHERE v.hour = date_trunc('hour', p_hour)
  ), vorher AS (
    SELECT v.principal_key,
           max(v.rows_returned) AS spitze,
           bool_or(extract(hour FROM v.hour AT TIME ZONE 'Europe/Berlin') < 5
                   AND v.rows_returned > 0) AS nachts
      FROM access_volume v
     WHERE v.hour >= date_trunc('hour', p_hour) - interval '14 days'
       AND v.hour <  date_trunc('hour', p_hour)
     GROUP BY v.principal_key
  )
  SELECT j.principal_key, j.account_id, j.rows_returned, j.requests,
         COALESCE(b.spitze, 0), host(j.origin),
         CASE WHEN j.rows_returned >= p_min
                   AND j.rows_returned > p_factor * COALESCE(b.spitze, 0)
              THEN 'volume' ELSE 'night' END
    FROM jetzt j LEFT JOIN vorher b ON b.principal_key = j.principal_key
   WHERE (j.rows_returned >= p_min
          AND j.rows_returned > p_factor * COALESCE(b.spitze, 0))
      OR (j.principal_key LIKE 'user:%'
          AND extract(hour FROM j.hour AT TIME ZONE 'Europe/Berlin') < 5
          AND j.rows_returned >= p_night_min
          AND NOT COALESCE(b.nachts, false))
$$;
REVOKE ALL ON FUNCTION access_volume_outliers(timestamptz, integer, numeric, integer)
  FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION access_volume_outliers(timestamptz, integer, numeric, integer)
  TO hotelpms_app;

-- 30 Tage. Laenger braucht der Vergleich (14 Tage) nicht.
CREATE OR REPLACE FUNCTION access_volume_prune() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM access_volume WHERE hour < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION access_volume_prune() FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION access_volume_prune() TO hotelpms_app;
