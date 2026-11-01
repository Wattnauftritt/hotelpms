-- ---------------------------------------------------------------------------
-- 0221 -- Der Mengenalarm zaehlt verschiedene Datensaetze, nicht Zeilen.
--
-- Anlass: Fehlalarm am 01.11.2026 um 11:03. Die Hotelanmeldung hatte in einer
-- Stunde 10 990 "Gastdatensaetze" abgerufen, sonst hoechstens 2105. Gezaehlt
-- hat 0210 jede uebertragene Zeile: wer dieselbe Meldescheinliste zehnmal
-- laedt -- und die Oberflaeche laedt sie neu, sobald das Fenster wieder vorn
-- ist --, zaehlte wie einer, der zehnmal so viele Gaeste sieht.
--
-- Ein Kennzeichen, das die eigene Oberflaeche mitschickt, waere die
-- naheliegende Abhilfe und die falsche: wer eine Sitzung uebernimmt, schickt
-- es mit, und der Alarm schwiege genau in dem Fall, fuer den er gebaut ist
-- (Thread "Ungewoehnlicher Gastdatenabruf pruefen"). Was ein Abfluss und eine
-- Rezeption wirklich unterscheidet, ist die Zahl der verschiedenen Gaeste.
--
-- Die API schickt je Antwort die Kennungen der Datensaetze (ein Hash je
-- Listenelement, eine Kennung je Einzelabruf). Gezaehlt wird, was in dieser
-- Stunde fuer diesen Aufrufer neu ist. Die Kennungen leben nur bis zur
-- naechsten Pflege; der Vergleich braucht sie innerhalb der Stunde.
-- ---------------------------------------------------------------------------

CREATE TABLE access_volume_seen (
  principal_key text NOT NULL,
  hour          timestamptz NOT NULL,
  record        bigint NOT NULL,
  PRIMARY KEY (principal_key, hour, record)
);
CREATE INDEX access_volume_seen_hour ON access_volume_seen (hour);

-- Wie access_volume: kein Zugriff fuer die Anwendung ausser ueber die Funktion.
REVOKE ALL ON access_volume_seen FROM hotelpms_app, hotelpms_readonly;

-- Die alte Fassung zaehlte eine Zahl, die die API selbst bestimmte. Sie
-- verschwindet, damit niemand an der Entdoppelung vorbei zaehlt.
DROP FUNCTION access_volume_add(text, bigint, integer, inet);

CREATE FUNCTION access_volume_add(
  p_key text, p_account bigint, p_records bigint[], p_origin inet
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
  v_neu  integer;
BEGIN
  WITH neu AS (
    INSERT INTO access_volume_seen (principal_key, hour, record)
    SELECT p_key, v_hour, r FROM unnest(coalesce(p_records, '{}')) AS r
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_neu FROM neu;

  INSERT INTO access_volume (principal_key, account_id, hour, requests,
                             rows_returned, origin)
  VALUES (p_key, p_account, v_hour, 1, v_neu, p_origin)
  ON CONFLICT (principal_key, hour) DO UPDATE
     SET requests      = access_volume.requests + 1,
         rows_returned = access_volume.rows_returned + EXCLUDED.rows_returned,
         origin        = EXCLUDED.origin,
         account_id    = COALESCE(access_volume.account_id, EXCLUDED.account_id);
  RETURN v_neu;
END $$;
REVOKE ALL ON FUNCTION access_volume_add(text, bigint, bigint[], inet)
  FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION access_volume_add(text, bigint, bigint[], inet) TO hotelpms_app;

-- Die Kennungen braucht nur die laufende Stunde; die Zaehler weiter 30 Tage.
CREATE OR REPLACE FUNCTION access_volume_prune() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer; m integer;
BEGIN
  DELETE FROM access_volume WHERE hour < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM access_volume_seen WHERE hour < date_trunc('hour', now());
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END $$;
