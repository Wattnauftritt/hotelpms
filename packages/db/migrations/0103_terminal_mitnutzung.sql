-- ---------------------------------------------------------------------------
-- 0103 -- Gaesteterminal: ein Haus nutzt das Terminal eines anderen mit.
--
-- Anforderung: Sven, 07.10.2026. Hotel und Gaestehaus sind zwei Haeuser,
-- aber eine Rezeption mit einem Touchscreen. Ein Terminal gehoert genau
-- einem Haus (0071), und die Rezeption konnte deshalb fuer das Gaestehaus
-- keinen Meldeschein an das Terminal des Hotels schicken.
--
-- Gebaut, wie Sven es beschrieben hat: ein Haus ist **Master** des
-- Terminals. Es gibt fuer ein Geraet einen Freigabecode aus; wer ihn in den
-- Einstellungen des zweiten Hauses eintraegt, kann von dort Auftraege an
-- dasselbe Geraet schicken. Seiten, Diashow und Wachzeit kommen weiter nur
-- vom Master -- das Geraet gehoert ihm, das zweite Haus leiht es.
--
-- **Nur innerhalb eines Accounts.** Ein Betrieb mit zwei Haeusern ist ein
-- Account; ein Geraet, das Gastdaten eines fremden Mandanten zeigen
-- koennte, waere das Gegenteil der Mandantentrennung.
--
-- **Gastdaten bleiben im Haus.** Ein Auftrag des zweiten Hauses traegt
-- dessen `property_id`, und jede Art liest ihre Nutzlast nur aus dem Haus
-- des Auftrags (platform/terminalArten.ts). Das Geraet sieht die Daten des
-- zweiten Hauses nur, solange die Freigabe gilt: sein Principal nimmt die
-- Haeuser mit gueltiger Freigabe in den Kontext, und mit dem Widerruf
-- fallen sie heraus -- bei der naechsten Anfrage, nicht bei der naechsten
-- Kopplung.
--
-- **Widerrufbar von beiden Seiten.** Der Master zieht die Freigabe zurueck,
-- oder das zweite Haus hoert auf, das Geraet zu nutzen. Ein offener Auftrag
-- des zweiten Hauses faellt dabei mit, und sein Online-Check-in-Link auch.
-- ---------------------------------------------------------------------------

/*
 * Eine Freigabe: erst ein Code, der auf ein Haus wartet, nach dem
 * Einloesen die Bindung an dieses Haus.
 *
 * `property_id` ist das Haus des Geraets und steht hier, obwohl es aus
 * `device_id` folgt: die Zeilenrichtlinie braucht es, und eine Richtlinie,
 * die ueber `terminal_device` liefe, liefe im Kreis -- deren eigene
 * Richtlinie fragt unten diese Tabelle. Gesetzt wird es nur beim Anlegen,
 * aus der Zeile des Geraets.
 *
 * Der Code liegt wie jeder andere nur als SHA-256 und faellt beim
 * Einloesen: was nicht mehr da ist, kann aus keiner Sicherung zurueck.
 */
CREATE TABLE terminal_share (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id         bigint NOT NULL REFERENCES terminal_device(id),
  property_id       bigint NOT NULL REFERENCES property(id),
  public_ref        text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  token_hash        bytea UNIQUE,
  token_expires_at  timestamptz,
  guest_property_id bigint REFERENCES property(id),
  created_by        bigint REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  redeemed_at       timestamptz,
  redeemed_by       bigint REFERENCES app_user(id),
  revoked_at        timestamptz,
  revoked_by        bigint REFERENCES app_user(id),
  CONSTRAINT terminal_share_token_expiry
    CHECK (token_hash IS NULL OR token_expires_at IS NOT NULL),
  CONSTRAINT terminal_share_redeemed
    CHECK ((redeemed_at IS NULL) = (guest_property_id IS NULL)),
  CONSTRAINT terminal_share_not_self
    CHECK (guest_property_id IS NULL OR guest_property_id <> property_id),
  -- Ein eingeloester oder widerrufener Code traegt keinen Hash mehr.
  CONSTRAINT terminal_share_token_gone
    CHECK ((redeemed_at IS NULL AND revoked_at IS NULL) OR token_hash IS NULL)
);

-- Hoechstens eine gueltige Freigabe je Geraet und Haus.
CREATE UNIQUE INDEX terminal_share_once ON terminal_share (device_id, guest_property_id)
  WHERE revoked_at IS NULL AND guest_property_id IS NOT NULL;
CREATE INDEX terminal_share_guest ON terminal_share (guest_property_id)
  WHERE revoked_at IS NULL;
CREATE INDEX terminal_share_device ON terminal_share (device_id)
  WHERE revoked_at IS NULL;

ALTER TABLE terminal_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminal_share FORCE  ROW LEVEL SECURITY;
-- Beide Seiten sehen die Freigabe und duerfen sie widerrufen.
CREATE POLICY tenant ON terminal_share
  USING (property_id = ANY (app_property_ids())
         OR guest_property_id = ANY (app_property_ids()));

SELECT attach_audit('terminal_share');
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('terminal_share', 'token_hash', 'Geheimnis');

/*
 * Das zweite Haus sieht das Geraet und ob es erreichbar ist -- lesend.
 * Eine eigene Richtlinie nur fuer SELECT: Name, Wachzeit, Kopplung und
 * Widerruf bleiben Sache des Masters, und keine Route des zweiten Hauses
 * kann sie aendern, auch wenn sie sich einmal im Haus irrte.
 */
CREATE POLICY shared ON terminal_device FOR SELECT
  USING (EXISTS (SELECT 1 FROM terminal_share s
                  WHERE s.device_id = terminal_device.id
                    AND s.revoked_at IS NULL
                    AND s.guest_property_id = ANY (app_property_ids())));
CREATE POLICY shared ON terminal_device_seen FOR SELECT
  USING (EXISTS (SELECT 1 FROM terminal_share s
                  WHERE s.device_id = terminal_device_seen.device_id
                    AND s.revoked_at IS NULL
                    AND s.guest_property_id = ANY (app_property_ids())));

-- ---------------------------------------------------------------------------
-- Das Principal des Geraets: dazu die Haeuser, die es mitnutzen.
--
-- Nur Haeuser desselben Accounts, nur aktive, nur gueltige Freigaben -- in
-- derselben Anweisung wie bisher, denn das Terminal fragt alle zwei
-- Sekunden, und ein Test zaehlt die Anweisungen.
--
-- Der Rueckgabetyp aendert sich; CREATE OR REPLACE kann das nicht.
-- ---------------------------------------------------------------------------

DROP FUNCTION terminal_device_principal(bytea);
CREATE FUNCTION terminal_device_principal(p_secret_hash bytea)
RETURNS TABLE (device_id bigint, device_ref text, property_id bigint, account_id bigint,
               shared_property_ids bigint[])
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH gefunden AS (
    SELECT d.id, d.public_ref, d.property_id, p.account_id
      FROM terminal_device d
      JOIN property p ON p.id = d.property_id
      JOIN account a ON a.id = p.account_id
     WHERE d.secret_hash = p_secret_hash
       AND d.revoked_at IS NULL
       AND p.status = 'active' AND a.status = 'active'
  ), gesehen AS (
    INSERT INTO terminal_device_seen AS s (device_id, property_id, last_seen_at)
    SELECT g.id, g.property_id, now() FROM gefunden g
    ON CONFLICT (device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
     WHERE s.last_seen_at < now() - interval '20 seconds'
  )
  SELECT g.id, g.public_ref, g.property_id, g.account_id,
         ARRAY(SELECT s.guest_property_id
                 FROM terminal_share s
                 JOIN property gp ON gp.id = s.guest_property_id
                WHERE s.device_id = g.id AND s.revoked_at IS NULL
                  AND gp.account_id = g.account_id AND gp.status = 'active'
                ORDER BY s.guest_property_id)
    FROM gefunden g;
$$;

/*
 * Einen Freigabecode einloesen, fuer ein Haus des Aufrufers.
 *
 * SECURITY DEFINER, weil der Aufrufer das Haus des Geraets nicht sehen
 * muss -- er bekommt den Code von dort. Gebunden wird nur an ein Haus, das
 * im Kontext des Aufrufers steht, das im selben Account liegt wie das
 * Geraet und nicht dessen eigenes ist. Genau einmal: der Code faellt in
 * derselben Anweisung.
 */
CREATE FUNCTION terminal_share_redeem(p_token_hash bytea, p_property_id bigint,
                                      p_user_id bigint)
RETURNS TABLE (share_ref text, device_ref text, device_name text, property_name text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE terminal_share s
     SET guest_property_id = p_property_id, redeemed_at = now(), redeemed_by = p_user_id,
         token_hash = NULL, token_expires_at = NULL
    FROM terminal_device d, property p, account a, property gp
   WHERE s.token_hash = p_token_hash
     AND s.token_expires_at > now()
     AND s.redeemed_at IS NULL AND s.revoked_at IS NULL
     AND d.id = s.device_id AND d.revoked_at IS NULL
     AND p.id = d.property_id AND a.id = p.account_id
     AND p.status = 'active' AND a.status = 'active'
     AND gp.id = p_property_id AND gp.status = 'active'
     AND gp.account_id = p.account_id AND gp.id <> p.id
     AND p_property_id = ANY (app_property_ids())
  RETURNING s.public_ref, d.public_ref, d.name, p.name;
$$;

/*
 * Die Freigaben, die ein Haus betreffen -- als Master und als Mitnutzer --,
 * mit den Namen beider Haeuser. Der Name des anderen Hauses steht hinter
 * dessen Zeilenrichtlinie; beide liegen im selben Account, und wer eine
 * Freigabe widerrufen soll, muss wissen, an wen sie ging.
 */
CREATE FUNCTION terminal_share_list(p_property_id bigint)
RETURNS TABLE (share_ref text, device_ref text, device_name text, role text,
               owner_property text, guest_property text, redeemed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.public_ref, d.public_ref, d.name,
         CASE WHEN s.property_id = p_property_id THEN 'owner' ELSE 'guest' END,
         p.name, gp.name, s.redeemed_at
    FROM terminal_share s
    JOIN terminal_device d ON d.id = s.device_id AND d.revoked_at IS NULL
    JOIN property p  ON p.id = s.property_id
    JOIN property gp ON gp.id = s.guest_property_id
   WHERE s.revoked_at IS NULL
     AND (s.property_id = p_property_id OR s.guest_property_id = p_property_id)
     AND p_property_id = ANY (app_property_ids())
   ORDER BY d.name, gp.name, s.id;
$$;

/*
 * Offene Auftraege eines Geraets beenden, ueber die Grenze der Haeuser.
 *
 * Ein Geraet traegt Auftraege mehrerer Haeuser, die Zeilenrichtlinie zeigt
 * jedem nur die eigenen. Ohne diese Funktion liesse ein Widerruf durch den
 * Master den offenen Auftrag des zweiten Hauses stehen -- und mit ihm
 * dessen Online-Check-in-Link, der den Meldeschein eines Gastes oeffnet.
 * Und ein abgelaufener Auftrag des Masters, den das zweite Haus nicht
 * sieht, blockierte den Teilindex `terminal_job_one_open` fuer jeden neuen.
 *
 * `p_nur_abgelaufene`: nur, was ohnehin als abgelaufen gilt, wird
 * `expired` (vor einem neuen Auftrag). Sonst wird alles Offene
 * `canceled`/`revoked` (Widerruf von Geraet oder Freigabe). Mit
 * `p_property_id` nur die Auftraege dieses Hauses.
 *
 * Wer aufrufen darf: wem das Geraet gehoert, wer es ueber eine gueltige
 * Freigabe nutzt, oder wer nur die Auftraege eines eigenen Hauses beendet.
 */
CREATE FUNCTION terminal_device_jobs_end(p_device_id bigint, p_property_id bigint,
                                         p_nur_abgelaufene boolean)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ids bigint[];
BEGIN
  IF NOT (
       EXISTS (SELECT 1 FROM terminal_device d
                WHERE d.id = p_device_id
                  AND (d.property_id = ANY (app_property_ids())
                       OR EXISTS (SELECT 1 FROM terminal_share s
                                   WHERE s.device_id = d.id AND s.revoked_at IS NULL
                                     AND s.guest_property_id = ANY (app_property_ids()))))
       OR (p_property_id IS NOT NULL AND p_property_id = ANY (app_property_ids()))) THEN
    RETURN 0;
  END IF;

  WITH beendet AS (
    UPDATE terminal_job j
       SET state       = CASE WHEN p_nur_abgelaufene THEN 'expired' ELSE 'canceled' END,
           canceled_by = CASE WHEN p_nur_abgelaufene THEN NULL ELSE 'revoked' END,
           finished_at = now()
     WHERE j.device_id = p_device_id
       AND j.state IN ('pending', 'opened')
       AND (NOT p_nur_abgelaufene OR j.expires_at <= now())
       AND (p_property_id IS NULL OR j.property_id = p_property_id)
    RETURNING j.id
  )
  SELECT coalesce(array_agg(id), ARRAY[]::bigint[]) INTO ids FROM beendet;

  -- Der Link faellt mit dem Auftrag (zieheLinksZurueck in terminalArten.ts).
  UPDATE checkin_token SET revoked_at = now()
   WHERE revoked_at IS NULL
     AND id IN (SELECT checkin_token_id FROM terminal_job
                 WHERE id = ANY (ids) AND checkin_token_id IS NOT NULL);
  RETURN cardinality(ids);
END;
$$;

/*
 * Ist das Geraet gerade belegt -- von welchem Haus auch immer? Die
 * Rezeption des zweiten Hauses sieht die Auftraege des Masters nicht, soll
 * aber nicht auf ein Geraet schicken, an dem gerade ein Gast steht. Nur
 * ja oder nein, kein Auftrag.
 */
CREATE FUNCTION terminal_device_busy(p_device_id bigint)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM terminal_job j
                  WHERE j.device_id = p_device_id
                    AND j.state IN ('pending', 'opened') AND j.expires_at > now())
     AND EXISTS (SELECT 1 FROM terminal_device d
                  WHERE d.id = p_device_id
                    AND (d.property_id = ANY (app_property_ids())
                         OR EXISTS (SELECT 1 FROM terminal_share s
                                     WHERE s.device_id = d.id AND s.revoked_at IS NULL
                                       AND s.guest_property_id = ANY (app_property_ids()))));
$$;

-- Wie in 0071: die Leserolle bekaeme sie ueber die Standardrechte mit.
REVOKE ALL ON FUNCTION terminal_device_principal(bytea) FROM PUBLIC, hotelpms_readonly;
REVOKE ALL ON FUNCTION terminal_share_redeem(bytea, bigint, bigint) FROM PUBLIC, hotelpms_readonly;
REVOKE ALL ON FUNCTION terminal_share_list(bigint) FROM PUBLIC, hotelpms_readonly;
REVOKE ALL ON FUNCTION terminal_device_jobs_end(bigint, bigint, boolean)
  FROM PUBLIC, hotelpms_readonly;
REVOKE ALL ON FUNCTION terminal_device_busy(bigint) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION terminal_device_principal(bytea) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION terminal_share_redeem(bytea, bigint, bigint) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION terminal_share_list(bigint) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION terminal_device_jobs_end(bigint, bigint, boolean) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION terminal_device_busy(bigint) TO hotelpms_app;
