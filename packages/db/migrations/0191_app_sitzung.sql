-- ---------------------------------------------------------------------------
-- 0191 -- Sitzungen der eigenen App (Baustein 2, Plan app/plan.md).
--
-- Anlass: Sven, 19.10.2026 -- eigene App fuer iOS und Android, mit Capacitor
-- um dieselbe Oberflaeche.
--
-- In der App liegen die Seiten unter `capacitor://localhost` bzw.
-- `https://localhost`, die Schnittstelle unter app.staygrid.cloud. Das
-- Sitzungscookie ist `SameSite=Strict` und kommt dort nicht mit, und das
-- soll so bleiben (H6, Dokument 25). Die App weist sich deshalb mit einem
-- Token in `Authorization` aus.
--
-- **Dieselbe Sitzung, kein zweites Anmeldesystem.** Das Token ist die
-- Kennung einer Zeile in `user_session`, wie das Cookie. Untaetigkeitsfrist,
-- feste Frist, Abmelden, Widerruf bei Kennwortwechsel oder Stilllegen, das
-- Push-Abo an der Sitzung (0113): alles gilt unveraendert, weil es dieselbe
-- Tabelle ist.
--
-- **Die Art steht an der Sitzung und wird beim Nachschlagen geprueft.** Eine
-- App-Sitzung traegt nicht als Cookie und eine Browsersitzung nicht als
-- Token. Ein Cookie, das jemand aus einem Browser kopiert, wird damit nicht
-- zu einem Token, das sich ohne Herkunftspruefung von ueberall benutzen
-- laesst -- und umgekehrt bleibt ein Token aus der App eines, das der
-- Browser nicht als Sitzung annimmt.
-- ---------------------------------------------------------------------------

ALTER TABLE user_session
  ADD COLUMN client text NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'app'));

DROP FUNCTION session_principal(text);

CREATE FUNCTION session_principal(p_session text, p_client text)
RETURNS TABLE (session_user_id bigint, effective_user_id bigint,
               principal jsonb, support jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user   bigint;
  v_active bigint;
BEGIN
  SELECT us.user_id, us.active_user_id INTO v_user, v_active
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
  principal         := principal_user_data(effective_user_id);
  support           := CASE WHEN (principal ->> 'platformStaff')::boolean
                            THEN principal_support_data(effective_user_id) END;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION session_principal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_principal(text, text) TO hotelpms_app;
