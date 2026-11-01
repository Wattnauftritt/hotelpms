-- ---------------------------------------------------------------------------
-- 0223 -- Den Namen eines Kunden aendern; der Mengenalarm kennt die Haeuser.
--
-- Anlass: Sicherheitshinweis vom 01.11.2026 (Thread "Ungewoehnlicher
-- Gastdatenabruf pruefen"). Die Mail sagte "im Betrieb Hasna Khodeir", weil
-- beim Anlegen im Adminpanel in "Name des Kunden" die Inhaberin stand. Der
-- Name liess sich danach nirgends mehr aendern; account.name schrieb einzig
-- account_provision (0031).
--
-- Wie platform_account_set_status (0038) durch eine Funktion, weil
-- Plattformpersonal ohne Support-Sitzung einen leeren Mandantenkontext hat
-- und ein UPDATE an der Zeilenrichtlinie still nichts traefe.
--
-- account.name bleibt ausserhalb von audit_redaction: es ist der Name des
-- Vertragspartners, kein Gast, und die Spur "von X in Y umbenannt" ist genau
-- das, was das Protokoll hier halten soll.
-- ---------------------------------------------------------------------------

CREATE FUNCTION platform_account_rename(p_account_id bigint, p_name text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_alt  text;
  v_name text := btrim(coalesce(p_name, ''));
BEGIN
  IF NOT platform_can('platform:accounts') THEN
    RAISE EXCEPTION 'Kein Recht, den Namen eines Kunden zu aendern'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Name des Kunden leer oder zu lang'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT name INTO v_alt FROM account WHERE id = p_account_id;
  -- NULL statt Ausnahme: die Route macht daraus ein 404.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE account SET name = v_name, updated_at = now() WHERE id = p_account_id;
  RETURN v_alt;
END $$;

REVOKE ALL ON FUNCTION platform_account_rename(bigint, text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION platform_account_rename(bigint, text) TO hotelpms_app;

-- ---------------------------------------------------------------------------
-- Der Hinweis zum Mengenalarm nennt die Haeuser des Betriebs statt des
-- Kundennamens (sicherheitsereignis.ts). Der Worker meldet im Kontext des
-- Betriebs, und property filtert nach Haus, nicht nach Mandant: ohne die
-- Haeuser im Kontext laese er still keines. Die Ausreisser bringen sie
-- deshalb mit -- die Funktion ist SECURITY DEFINER und sieht sie.
-- ---------------------------------------------------------------------------
DROP FUNCTION access_volume_outliers(timestamptz, integer, numeric, integer);
CREATE FUNCTION access_volume_outliers(
  p_hour timestamptz, p_min integer, p_factor numeric, p_night_min integer
) RETURNS TABLE (principal_key text, account_id bigint, rows_returned integer,
                 requests integer, baseline integer, origin text, reason text,
                 property_ids bigint[])
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
              THEN 'volume' ELSE 'night' END,
         COALESCE((SELECT array_agg(p.id ORDER BY p.id) FROM property p
                    WHERE p.account_id = j.account_id), '{}')
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
