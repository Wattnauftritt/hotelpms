-- ---------------------------------------------------------------------------
-- 0212 -- Ein Maschinenzugang gilt nur aus den Netzen, die der Betrieb nennt.
--
-- Bedrohungsanalyse 23.10.2026, A4 und D2
-- (/mnt/project-files/security/bedrohungsanalyse-2026-10-23.md). Das
-- Geheimnis eines Maschinenzugangs liegt beim Umsystem: in einer .env auf
-- einem Webserver, in einem Laravel-Cache, in einem Backup. Wer es dort
-- abzieht, holte sich bisher von ueberall ein Token und zog damit die
-- Gaestedatei -- genau der Weg, auf dem 2026 bei HotelNetSolutions Gastdaten
-- abgeflossen sind. Das Adminpanel sitzt hinter einer festen Adresse; ein
-- Geheimnis, das nur von dort traegt, ist anderswo wertlos.
--
-- **Leer heisst ueberall**, wie bisher. Ein Zwang zur Liste braeche jeden
-- bestehenden Zugang mit dem naechsten Ausrollen, und ein Channel Manager
-- aus wechselnden Rechenzentren kann keine feste Adresse nennen.
--
-- Geprueft wird zweimal: bei der Ausgabe des Tokens und bei jeder Anfrage
-- mit dem Token. Nur das erste genuegte nicht -- ein Token, das jemand
-- unterwegs abgreift, truege sonst eine Stunde lang von ueberall.
--
-- Eine Anfrage aus einem fremden Netz mit gueltigem Geheimnis ist ein
-- abgeflossenes Geheimnis und wird Sicherheitsereignis `client_origin_denied`.
-- ---------------------------------------------------------------------------

ALTER TABLE oauth_client
  ADD COLUMN allowed_networks cidr[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(allowed_networks) <= 20);

CREATE OR REPLACE FUNCTION network_allows(p_networks cidr[], p_origin inet)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(p_networks) = 0
      OR (p_origin IS NOT NULL AND p_origin <<= ANY (p_networks))
$$;

DROP FUNCTION oauth_client_for_auth(text);
CREATE FUNCTION oauth_client_for_auth(p_public_ref text, p_origin inet)
RETURNS TABLE(id bigint, account_id bigint, secret_hash text, scopes text[],
              property_ids bigint[], status text, origin_ok boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.account_id, c.secret_hash, c.scopes, c.property_ids,
         CASE WHEN a.status = 'active' THEN c.status ELSE 'account_inactive' END,
         network_allows(c.allowed_networks, p_origin)
    FROM oauth_client c
    JOIN account a ON a.id = c.account_id
   WHERE c.public_ref = p_public_ref;
$$;
REVOKE ALL ON FUNCTION oauth_client_for_auth(text, inet) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION oauth_client_for_auth(text, inet) TO hotelpms_app;

/*
 * Wie 0133, dazu die Herkunft. Aus einem fremden Netz: Zustand
 * 'origin_denied', und das Token wird nicht als benutzt vermerkt.
 */
DROP FUNCTION oauth_token_principal(bytea);
CREATE FUNCTION oauth_token_principal(p_token_hash bytea, p_origin inet)
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
           c.public_ref, c.status AS client_status, a.status AS account_status,
           network_allows(c.allowed_networks, p_origin) AS netz_ok
      FROM oauth_access_token t
      JOIN oauth_client c ON c.id = t.client_id
      JOIN account a ON a.id = t.account_id
     WHERE t.token_hash = p_token_hash
       AND t.revoked_at IS NULL
       AND t.expires_at > now()
  ), beruehrt AS (
    UPDATE oauth_access_token t SET last_used_at = now()
     WHERE t.id IN (SELECT g.id FROM gefunden g WHERE g.netz_ok)
       AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 hour')
  )
  SELECT g.account_id, g.scopes, g.aktive_haeuser, g.public_ref,
         CASE WHEN g.account_status <> 'active' THEN 'account_inactive'
              WHEN NOT g.netz_ok THEN 'origin_denied'
              WHEN g.beschraenkt AND cardinality(g.aktive_haeuser) = 0
                THEN 'property_inactive'
              ELSE g.client_status END
    FROM gefunden g;
END $$;
REVOKE ALL ON FUNCTION oauth_token_principal(bytea, inet) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION oauth_token_principal(bytea, inet) TO hotelpms_app;

ALTER TABLE security_event DROP CONSTRAINT security_event_kind_check;
ALTER TABLE security_event ADD CONSTRAINT security_event_kind_check
  CHECK (kind IN (
    'bank_details_changed', 'payment_account_connected',
    'payment_account_disconnected', 'oauth_client_created',
    'oauth_client_changed', 'webhook_created', 'webhook_changed',
    'channel_connection_created', 'role_granted',
    'support_granted', 'export', 'deployment',
    'platform_role_changed', 'payment_provider_changed',
    'confirmation_failed', 'login_new_device',
    'access_volume', 'honeytoken', 'platform_passkey_changed',
    'client_origin_denied'));
