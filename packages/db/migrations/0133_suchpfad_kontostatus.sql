-- ---------------------------------------------------------------------------
-- 0133 -- Suchpfad der SECURITY-DEFINER-Funktionen, Kontosperre fuer
-- Maschinenzugaenge, Ausfuehrungsrechte.
--
-- Befunde M11, M12 und N12 aus dem Sicherheitsaudit vom 11.10.2026
-- (security/audit-2026-10-11.md). Bewusst die hoechste Nummer der Reihe aus
-- diesem Audit: der Suchpfad wird hier fuer **alle** Funktionen gesetzt, die
-- es bis dahin gibt, auch fuer die aus 0129 bis 0132.
--
-- M11: Jede SECURITY-DEFINER-Funktion lief mit `search_path = public`. Ist
-- pg_temp nicht ausdruecklich genannt, sucht PostgreSQL dort **zuerst**. Wer
-- als Anwendungsrolle beliebiges SQL ausfuehren kann -- eine Einschleusung,
-- Code im API-Prozess --, legt eine temporaere Tabelle `app_user` an, und
-- platform_can() liest sie statt der echten: die Plattformfunktionen wirken
-- dann ueber alle Kunden. Zwei Riegel: pg_temp ans Ende des Suchpfads, und
-- die Anwendung darf gar keine temporaeren Tabellen mehr anlegen. Ein Test
-- (packages/db/src/__tests__/sicherheitsdefinierer.test.ts) haelt fest, dass
-- keine spaetere Migration den Suchpfad wieder auf `public` allein setzt.
--
-- M12: Eine Kontosperre stoppte die Menschen, nicht die Maschinen. Ein altes
-- Token lieferte weiter 200, und die Tokenausgabe gab sogar ein neues aus.
-- Das Terminal prueft den Status seit 0103; die Maschinenzugaenge jetzt auch.
--
-- N12: Drei SECURITY-DEFINER-Funktionen pruefen keinen Kontext und werden
-- nur aus anderen SECURITY-DEFINER-Funktionen gerufen. Fuer die Anwendung
-- waren sie trotzdem aufrufbar, ueber jeden Mandanten hinweg.
-- ---------------------------------------------------------------------------

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f);
  END LOOP;
END $$;

-- Die Datenbank gehoert der Eigentuemerrolle; sie behaelt TEMPORARY ueber
-- ihr eigenes Recht (Saatlauf und Testhotel brauchen es).
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- Gesperrter oder archivierter Account: der Client gilt als nicht aktiv. Der
-- Aufrufer prueft `status` schon (routes/oauth.ts) und antwortet dann wie auf
-- ein falsches Geheimnis -- ein gesperrter Kunde erfaehrt so nicht, ob seine
-- Kennung noch stimmt.
CREATE OR REPLACE FUNCTION oauth_client_for_auth(p_public_ref text)
RETURNS TABLE(id bigint, account_id bigint, secret_hash text, scopes text[],
              property_ids bigint[], status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.account_id, c.secret_hash, c.scopes, c.property_ids,
         CASE WHEN a.status = 'active' THEN c.status ELSE 'account_inactive' END
    FROM oauth_client c
    JOIN account a ON a.id = c.account_id
   WHERE c.public_ref = p_public_ref;
$$;

/*
 * Wie 0025, dazu Account und Haeuser. Ein ausdruecklich genanntes Haus, das
 * archiviert ist, faellt aus der Liste. Faellt dabei **jedes** heraus, gilt
 * der Client als nicht aktiv: eine leere Liste bedeutet "alle Haeuser des
 * Accounts" (platform/auth.ts), und ein auf ein Haus beschraenkter Zugang
 * bekaeme mit dessen Archivierung sonst alle anderen dazu.
 */
CREATE OR REPLACE FUNCTION oauth_token_principal(p_token_hash bytea)
RETURNS TABLE(account_id bigint, scopes text[], property_ids bigint[],
              public_ref text, client_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH gefunden AS (
    SELECT t.id, t.account_id, t.scopes,
           ARRAY(SELECT p.id FROM property p
                  WHERE p.id = ANY (t.property_ids) AND p.status = 'active'
                  ORDER BY p.id) AS aktive_haeuser,
           cardinality(t.property_ids) > 0 AS beschraenkt,
           c.public_ref, c.status AS client_status, a.status AS account_status
      FROM oauth_access_token t
      JOIN oauth_client c ON c.id = t.client_id
      JOIN account a ON a.id = t.account_id
     WHERE t.token_hash = p_token_hash
       AND t.revoked_at IS NULL
       AND t.expires_at > now()
  ), beruehrt AS (
    UPDATE oauth_access_token t SET last_used_at = now()
     WHERE t.id IN (SELECT g.id FROM gefunden g)
       AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 hour')
  )
  SELECT g.account_id, g.scopes, g.aktive_haeuser, g.public_ref,
         CASE WHEN g.account_status <> 'active' THEN 'account_inactive'
              WHEN g.beschraenkt AND cardinality(g.aktive_haeuser) = 0
                THEN 'property_inactive'
              ELSE g.client_status END
    FROM gefunden g;
END $$;

REVOKE EXECUTE ON FUNCTION payment_link_revoke_for_guest(bigint)
  FROM PUBLIC, hotelpms_app, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION inventory_room_shift_apply(jsonb)
  FROM PUBLIC, hotelpms_app, hotelpms_readonly;
REVOKE EXECUTE ON FUNCTION inventory_recalc_capacity(bigint, date, date)
  FROM PUBLIC, hotelpms_app, hotelpms_readonly;
