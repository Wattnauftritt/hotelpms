-- ---------------------------------------------------------------------------
-- 0145 Selbstbedienung am Gaesteterminal (Dokument 31, Abschnitt 14)
--
-- Sven, 12.10.2026: Am Touchscreen der Rezeption waehlt ein Gast seine
-- Zimmernummer, das Terminal fragt "Sind Sie Herr/Frau <Nachname>?", und
-- nach "Ja" verzichtet er auf die Reinigung einzelner Tage. Mehr Schutz
-- als diese Rueckfrage gegen ein vertipptes Zimmer braucht es nicht: das
-- Geraet steht im Haus, ein frueherer Gast oder ein Fremder kommt nicht
-- heran.
--
-- **Kein Auftrag.** Die Selbstbedienung steht nicht in `terminal_job`. Dort
-- haelt der Teilindex "hoechstens ein offener Auftrag je Geraet" das
-- Geraet belegt, und waehrend ein Gast sich selbst bedient, soll die
-- Rezeption trotzdem einen Meldeschein schicken koennen. Ein Auftrag
-- gewinnt immer; er beendet eine offene Sitzung (`ended_reason = 'job'`).
--
-- **Kein zweiter Weg zum Verzicht.** Nach "Ja" bekommt das Terminal einen
-- Check-in-Link (Kanal `terminal`, Migration 0061) und ruft damit
-- denselben Endpunkt wie der Gast auf seinem Telefon. Der Link haengt an
-- der Sitzung und faellt mit ihr.
--
-- Kein personenbezogener Wert in der Sitzung, nur Verweise. Deshalb kein
-- Eintrag in `audit_redaction` und keiner in `guest_erase_one()`.
-- ---------------------------------------------------------------------------

-- Ein Schalter je Haus. Ohne Zeile aus: ein Haus soll nicht durch eine
-- Auslieferung ploetzlich Namen am Touchscreen zeigen.
CREATE TABLE property_terminal_self_setting (
  property_id  bigint PRIMARY KEY REFERENCES property(id),
  enabled      boolean NOT NULL DEFAULT false,
  updated_by   bigint REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Eine Sitzung: ein Gast tippt ein Zimmer an. Das Haus ist das des
-- Zimmers, nicht das des Geraets -- ein Terminal, das das Gaestehaus
-- mitnutzt (0103), zeigt auch dessen Zimmer, und die Zeile gehoert dann
-- dem Gaestehaus.
CREATE TABLE terminal_self_session (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref       text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  property_id      bigint NOT NULL REFERENCES property(id),
  device_id        bigint NOT NULL REFERENCES terminal_device(id),
  resource_id      bigint NOT NULL REFERENCES resource(id),
  reservation_id   bigint NOT NULL REFERENCES reservation(id),
  -- Die Loeschung eines Gastes entfernt seine Links (guest_erase_one); die
  -- Sitzung bleibt als Verweis ohne Link stehen, wie ein Auftrag (0073).
  checkin_token_id bigint REFERENCES checkin_token(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  confirmed_at     timestamptz,
  ended_at         timestamptz,
  ended_reason     text CHECK (ended_reason IN
                     ('done', 'canceled', 'timeout', 'declined', 'job', 'replaced')),
  CONSTRAINT ended_has_reason CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE INDEX terminal_self_session_device ON terminal_self_session (device_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['property_terminal_self_setting', 'terminal_self_session'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('property_terminal_self_setting');
SELECT attach_audit('terminal_self_session');

-- Fuer das Bedienfeld: bedient sich an diesem Geraet gerade ein Gast?
-- Wie `terminal_device_busy` (0103) ueber die Haeuser hinweg, die das Geraet
-- nutzen -- die Zeilenrichtlinie zeigte jedem Haus nur die eigenen
-- Sitzungen. Nur ja oder nein, kein Zimmer und kein Name.
CREATE FUNCTION terminal_device_self_busy(p_device_id bigint)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM terminal_self_session s
                  WHERE s.device_id = p_device_id
                    AND s.ended_at IS NULL AND s.expires_at > now())
     AND EXISTS (SELECT 1 FROM terminal_device d
                  WHERE d.id = p_device_id
                    AND (d.property_id = ANY (app_property_ids())
                         OR EXISTS (SELECT 1 FROM terminal_share s
                                     WHERE s.device_id = d.id AND s.revoked_at IS NULL
                                       AND s.guest_property_id = ANY (app_property_ids()))));
$$;

REVOKE ALL ON FUNCTION terminal_device_self_busy(bigint) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION terminal_device_self_busy(bigint) TO hotelpms_app;
