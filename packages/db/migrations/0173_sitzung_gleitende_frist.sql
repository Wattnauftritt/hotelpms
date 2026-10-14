-- ---------------------------------------------------------------------------
-- 0173 -- Die Untaetigkeitsfrist einer Sitzung gleitet wirklich mit.
--
-- Anlass: Sven, 14.10.2026 -- "Das System loggt einen oft aus, vor allem auf
-- mobilen Geraeten."
--
-- auth.ts beschrieb `expires_at` als Untaetigkeitsfrist, die mit jeder
-- Anfrage mitwandert. Geschrieben wurde sie aber nur bei der Anmeldung; weder
-- der alte Nachschlag in app.ts noch session_principal (0142) zog sie nach.
-- Damit war die "Untaetigkeitsfrist" in Wahrheit eine feste Frist von zwoelf
-- Stunden ab Anmeldung: wer morgens um sieben anfing, flog abends um sieben
-- hinaus, mitten in der Arbeit. Am Telefon, das zwischendurch in der Tasche
-- liegt, fiel das jeden Tag auf.
--
-- Jetzt zieht session_principal `expires_at` mit, und zwar in derselben
-- Anweisung wie last_seen_at -- hoechstens einmal je Minute, also keine
-- zusaetzliche Zeile WAL. Nie ueber `absolute_expires_at` hinaus: die feste
-- Grenze bleibt die Antwort auf eine gestohlene Sitzung, die benutzt wird.
--
-- Die Laenge der Frist steht an der Sitzung (`idle_window`), nicht in dieser
-- Funktion: die Zahl gehoert zur Anmeldung in auth.ts, wo sie begruendet
-- ist, und eine zweite Fassung hier liefe mit der ersten auseinander. Der
-- Standard ist die bisherige Frist, damit eine Zeile ohne Angabe (Fixtures,
-- bestehende Sitzungen) nichts anderes bekommt, als sie bei der Anmeldung
-- zugesagt bekam.
-- ---------------------------------------------------------------------------

ALTER TABLE user_session
  ADD COLUMN idle_window interval NOT NULL DEFAULT interval '12 hours';

CREATE OR REPLACE FUNCTION session_principal(p_session text)
RETURNS TABLE (session_user_id bigint, effective_user_id bigint,
               principal jsonb, support jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user   bigint;
  v_active bigint;
BEGIN
  SELECT us.user_id, us.active_user_id INTO v_user, v_active
    FROM user_session us
   WHERE us.id = p_session AND us.revoked_at IS NULL
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

REVOKE ALL ON FUNCTION session_principal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_principal(text) TO hotelpms_app;
