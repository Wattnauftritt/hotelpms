-- ---------------------------------------------------------------------------
-- 0211 -- Plattformrechte nur in einer Sitzung, die mit Passkey begann.
--
-- Bedrohungsanalyse 23.10.2026, A3
-- (/mnt/project-files/security/bedrohungsanalyse-2026-10-23.md). Ein
-- Plattformkonto erreicht jeden Kunden: Adminpanel, Ausrollen,
-- Support-Sitzungen. Bisher genuegte dafuer ein Kennwort, und ein Kennwort
-- ist genau das, was eine KI-gestuetzte Phishing-Mail abfaengt. Ein Passkey
-- laesst sich nicht abfangen: er antwortet nur der echten Herkunft
-- app.staygrid.cloud, eine nachgebaute Seite bekommt nichts.
--
-- **Die Sitzung merkt sich, wie sie begann.** Die Anmeldung mit Kennwort
-- bleibt fuer Plattformpersonal moeglich -- sonst kaeme niemand an seinen
-- ersten Passkey --, traegt aber keine Plattformrechte und keine
-- Support-Sitzung. Ein Wechsel per Arbeitsplatz-PIN (active_user_id) gilt
-- nicht als Passkey der handelnden Person: angemeldet hat sich jemand
-- anderes.
--
-- Dazu eine eigene Art im Sicherheitsprotokoll: ein Passkey an einem
-- Plattformkonto, angelegt oder entfernt. Das ist der Schritt, den ein
-- Angreifer mit erbeutetem Kennwort als erstes taete.
-- ---------------------------------------------------------------------------

ALTER TABLE user_session
  ADD COLUMN via_passkey boolean NOT NULL DEFAULT false;

DROP FUNCTION session_principal(text, text);

CREATE FUNCTION session_principal(p_session text, p_client text)
RETURNS TABLE (session_user_id bigint, effective_user_id bigint,
               principal jsonb, support jsonb, via_passkey boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user    bigint;
  v_active  bigint;
  v_passkey boolean;
BEGIN
  SELECT us.user_id, us.active_user_id, us.via_passkey
    INTO v_user, v_active, v_passkey
    FROM user_session us
   WHERE us.id = p_session AND us.client = p_client AND us.revoked_at IS NULL
     AND us.expires_at > now() AND us.absolute_expires_at > now();
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE user_session
     SET last_seen_at = now(),
         expires_at   = LEAST(absolute_expires_at, now() + idle_window)
   WHERE id = p_session AND last_seen_at < now() - interval '60 seconds';

  session_user_id   := v_user;
  effective_user_id := COALESCE(v_active, v_user);
  via_passkey       := v_passkey AND effective_user_id = v_user;
  principal         := principal_user_data(effective_user_id);
  -- Ohne Passkey keine Support-Sitzung: sie ist der Weg in fremde Daten.
  support           := CASE WHEN (principal ->> 'platformStaff')::boolean
                             AND via_passkey
                            THEN principal_support_data(effective_user_id) END;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION session_principal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_principal(text, text) TO hotelpms_app;

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
    'access_volume', 'honeytoken', 'platform_passkey_changed'));
