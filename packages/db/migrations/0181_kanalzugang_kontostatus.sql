-- ---------------------------------------------------------------------------
-- 0181 -- Kanalzugang prueft Account und Haus.
--
-- Befund M7 aus dem Sicherheitsaudit vom 19.10.2026
-- (security/audit-2026-10-19.md). 0133 hat die Kontosperre fuer die
-- OAuth-Zugaenge nachgezogen (M12 vom 11.10.), den Kanalzugang daneben aber
-- nicht. platform/channelAuth.ts las nur channel_connection.status: nach einer
-- Kontosperre (Kuendigung, Zahlungsverzug, Missbrauch) oder dem Archivieren
-- des Hauses holte der Channel Manager weiter Preise und legte weiter
-- Buchungen samt Gastprofilen an.
--
-- Die Pruefung braucht account und property, und property hat eine
-- Zeilenrichtlinie; die Anmeldung laeuft vor jedem Mandantenkontext. Ohne
-- Kontext gelesen, filterte die Richtlinie das Haus auf nichts (CLAUDE.md).
-- Deshalb eine SECURITY-DEFINER-Funktion wie oauth_client_for_auth: sie
-- liefert die Zeile zur oeffentlichen Kennung und faltet den Status von
-- Account und Haus in `status`. Der Aufrufer antwortet auf alles ausser
-- 'active' wie auf ein falsches Geheimnis -- ein gesperrter Kunde erfaehrt so
-- nicht, ob seine Kennung noch stimmt.
-- ---------------------------------------------------------------------------

CREATE FUNCTION channel_connection_for_auth(p_public_ref text)
RETURNS TABLE(id bigint, property_id bigint, account_id bigint, provider text,
              token_hash text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.property_id, c.account_id, c.provider, c.token_hash,
         CASE WHEN a.status <> 'active' THEN 'account_inactive'
              WHEN p.status <> 'active' THEN 'property_inactive'
              ELSE c.status END
    FROM channel_connection c
    JOIN account a ON a.id = c.account_id
    JOIN property p ON p.id = c.property_id
   WHERE c.public_ref = p_public_ref;
$$;

-- Gibt den Hash eines Geheimnisses heraus: nur fuer die Anwendung, die ihn
-- prueft, nicht fuer die Leserolle (M1).
REVOKE EXECUTE ON FUNCTION channel_connection_for_auth(text)
  FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION channel_connection_for_auth(text) TO hotelpms_app;
