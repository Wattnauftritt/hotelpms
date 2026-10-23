-- ---------------------------------------------------------------------------
-- 0208 -- Kritische Handlungen bestaetigen und als Sicherheitsereignis melden.
--
-- Bedrohungsanalyse 23.10.2026, T3 und E3
-- (/mnt/project-files/security/bedrohungsanalyse-2026-10-23.md). Sven: "setz
-- alles um bis jeder punkt abgesichert ist".
--
-- Der Befund: Wer eine Sitzung uebernimmt -- per nachgebauter Anmeldeseite
-- oder Infostealer am Rezeptionsrechner --, kann ohne weitere Huerde die IBAN
-- auf den Rechnungen tauschen, das Stripe-Konto des Hauses umhaengen, einen
-- Maschinenzugang als Hintertuer anlegen und die ganze Gaestedatei
-- exportieren. Keiner dieser Schritte fragte das Kennwort, keiner sagte
-- jemandem Bescheid.
--
-- Drei Teile:
--
-- 1. **Bestaetigung an der Sitzung.** `confirmed_at` setzt die Route
--    POST /v1/auth/confirm nach dem Kennwort, spaeter auch ein Passkey
--    (Thread "Passkeys und Passwort vergessen"). Kritische Handlungen
--    verlangen eine Bestaetigung von hoechstens fuenf Minuten. Sie gilt fuer
--    die Person, die bestaetigt hat (`confirmed_user_id`): wechselt die
--    Tresensitzung per PIN auf jemand anderen, gilt sie nicht weiter.
--
-- 2. **security_event**, unveraenderlich wie audit_log. Das Pruefprotokoll
--    sagt, welche Zeile sich wie geaendert hat; dieses sagt, was jemand
--    getan hat, das ein Angreifer tun wuerde -- auch dort, wo sich keine
--    Zeile aendert (ein Export).
--
-- 3. **Hinweis per Mail** an alle mit settings:account im Betrieb, ohne
--    Link, nach dem Muster der Mailaenderung (0053), und an das
--    Sicherheitspostfach der Plattform.
--
-- **Volle IP-Adresse, mit Frist** (Sven, 23.10.2026: "IPs sollten wir aber
-- ungekuerzt loggen sonst bringen die uns nichts fuer strafanzeigen / ip
-- bans"). Nach 180 Tagen kuerzt security_event_prune() sie auf das Netz
-- (/24, bei IPv6 /48); das Ereignis selbst bleibt zwei Jahre.
-- Rechtsgrundlage Art. 6 Abs. 1 lit. f DSGVO, im Verarbeitungsverzeichnis.
-- ---------------------------------------------------------------------------

ALTER TABLE user_session
  ADD COLUMN confirmed_at timestamptz,
  -- Ohne Fremdschluessel: die Sitzung faellt mit dem Benutzer (CASCADE),
  -- ein zweiter Verweis bremste nur das Loeschen.
  ADD COLUMN confirmed_user_id bigint;

CREATE TABLE security_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Leer bei Handlungen der Plattform selbst (Ausrollen, Plattformrollen).
  account_id    bigint REFERENCES account(id),
  property_id   bigint REFERENCES property(id),
  kind          text NOT NULL CHECK (kind IN (
                  'bank_details_changed', 'payment_account_connected',
                  'payment_account_disconnected', 'oauth_client_created',
                  'oauth_client_changed', 'webhook_created', 'webhook_changed',
                  'channel_connection_created', 'role_granted',
                  'support_granted', 'export', 'deployment',
                  'platform_role_changed', 'payment_provider_changed',
                  'confirmation_failed', 'login_new_device',
                  'access_volume', 'honeytoken')),
  -- Wer: ein Mensch (user), ein Maschinenzugang (client), ein Kanal
  -- (channel) oder der Worker (system). Kein Fremdschluessel auf app_user:
  -- ein stillgelegter Benutzer bleibt als Taeter eines Ereignisses stehen.
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user','client','channel','system')),
  actor_user_id bigint,
  actor_ref     text CHECK (char_length(actor_ref) <= 64),
  origin        inet,
  origin_truncated boolean NOT NULL DEFAULT false,
  -- Nie ein Gastname, nie eine volle IBAN: nur Kennungen, Zahlen und
  -- gekuerzte Werte. Die Ansicht zeigt dieses Feld.
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_event_account ON security_event (account_id, created_at DESC);
CREATE INDEX security_event_zeit    ON security_event (created_at);

ALTER TABLE security_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_event FORCE  ROW LEVEL SECURITY;
CREATE POLICY lesen ON security_event FOR SELECT
  USING (account_id = ANY (app_account_ids()));

-- Haertegrad 1, und strenger als audit_log: die Anwendung liest nur. Es
-- schreibt einzig security_event_record(), kuerzt und loescht einzig
-- security_event_prune().
REVOKE ALL ON security_event FROM hotelpms_app, hotelpms_readonly;
GRANT SELECT ON security_event TO hotelpms_app, hotelpms_readonly;

/*
 * Ein Ereignis festhalten. Als Funktion, weil eine Plattformsitzung keinen
 * Mandantenkontext hat (0032) und ein Ereignis an einem Kundenbetrieb --
 * eine Rolle, die das Plattformpersonal dort vergibt -- sonst an der
 * Zeilenrichtlinie scheiterte. Die Pruefung steht deshalb hier: in einen
 * Betrieb schreibt nur, wer in ihm arbeitet oder Plattformrechte hat.
 */
CREATE OR REPLACE FUNCTION security_event_record(
  p_account bigint, p_property bigint, p_kind text, p_actor_kind text,
  p_actor_user bigint, p_actor_ref text, p_origin inet, p_detail jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  IF p_account IS NOT NULL AND NOT (p_account = ANY (app_account_ids()))
     AND NOT platform_can('platform:accounts') THEN
    RAISE EXCEPTION 'security_event_foreign_account' USING ERRCODE = '42501';
  END IF;
  INSERT INTO security_event (account_id, property_id, kind, actor_kind,
                              actor_user_id, actor_ref, origin, detail)
  VALUES (p_account, p_property, p_kind, p_actor_kind, p_actor_user,
          p_actor_ref, p_origin, COALESCE(p_detail, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION security_event_record(bigint, bigint, text, text, bigint,
  text, inet, jsonb) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION security_event_record(bigint, bigint, text, text, bigint,
  text, inet, jsonb) TO hotelpms_app;

CREATE OR REPLACE FUNCTION security_event_prune() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE security_event
     SET origin = network(set_masklen(origin,
                    CASE WHEN family(origin) = 4 THEN 24 ELSE 48 END)),
         origin_truncated = true
   WHERE NOT origin_truncated AND origin IS NOT NULL
     AND created_at < now() - interval '180 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM security_event WHERE created_at < now() - interval '2 years';
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION security_event_prune() FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION security_event_prune() TO hotelpms_app;

-- ---------------------------------------------------------------------------
-- Wer den Hinweis bekommt: alle aktiven Benutzer mit Mailadresse, die im
-- Betrieb settings:account haben, auf Account- oder auf Hausebene, und die
-- Hausleitung (user:manage in einem Haus des Betriebs). Die Direktion hat
-- settings:account nicht, kann aber die IBAN ihres Hauses aendern -- ohne
-- sie erfuehre gerade die Person nichts, deren Haus es betrifft.
--
-- SECURITY DEFINER, weil role_permission und die Rollentabellen der
-- Anwendung nicht ueber den Betrieb hinweg offenstehen. Mit Kontextpruefung:
-- nur fuer einen Account, in dem der Aufrufer selbst arbeitet, oder fuer
-- Plattformpersonal, das dort eine Rolle vergibt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security_notice_recipients(p_account bigint)
RETURNS TABLE (user_id bigint, email text, display_name text, locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.id, u.email, u.display_name, u.locale
    FROM app_user u
   WHERE (p_account = ANY (app_account_ids()) OR platform_can('platform:accounts'))
     AND u.status = 'active' AND u.email IS NOT NULL
     AND (EXISTS (SELECT 1 FROM user_account_role ur
                    JOIN role_permission rp ON rp.role_id = ur.role_id
                   WHERE ur.user_id = u.id AND ur.account_id = p_account
                     AND rp.permission_key = 'settings:account')
       OR EXISTS (SELECT 1 FROM user_property_role ur
                    JOIN property p ON p.id = ur.property_id
                    JOIN role_permission rp ON rp.role_id = ur.role_id
                   WHERE ur.user_id = u.id AND p.account_id = p_account
                     AND rp.permission_key IN ('settings:account', 'user:manage')))
$$;
REVOKE ALL ON FUNCTION security_notice_recipients(bigint) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION security_notice_recipients(bigint) TO hotelpms_app;

-- ---------------------------------------------------------------------------
-- Post: der Hinweis an die Berechtigten (an einen Benutzer) und die Meldung
-- an das Sicherheitspostfach der Plattform (ohne Benutzer, wie
-- domain_request). Die Meldung an uns traegt einen Schluessel, damit ein
-- Andrang gleicher Meldungen eine Mail je Stunde ergibt und keine Flut.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_email ADD COLUMN dedupe_key text;

ALTER TABLE platform_email DROP CONSTRAINT platform_email_kind_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_kind_check
  CHECK (kind IN ('invite', 'password_reset', 'support_request',
                  'domain_request', 'email_change', 'email_change_notice',
                  'passkey_added', 'security_notice', 'security_alert'));

ALTER TABLE platform_email DROP CONSTRAINT platform_email_empfaenger_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_empfaenger_check
  CHECK (user_id IS NOT NULL OR kind IN ('domain_request', 'security_alert'));

CREATE INDEX platform_email_dedupe ON platform_email (dedupe_key, created_at)
  WHERE dedupe_key IS NOT NULL;

/*
 * Eine Meldung an das Sicherheitspostfach einreihen. Gleicher Schluessel
 * binnen einer Stunde: keine zweite Mail. SECURITY DEFINER wie
 * platform_notice_enqueue (0052), weil der Aufrufer eine Kundensitzung oder
 * der Worker ist: er bestimmt die Zieladresse aus der Konfiguration, liest
 * aber keine fremde Post.
 */
CREATE OR REPLACE FUNCTION platform_alert_enqueue(
  p_to_email text, p_subject text, p_body_text text, p_dedupe_key text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_email
              WHERE kind = 'security_alert' AND dedupe_key = p_dedupe_key
                AND created_at > now() - interval '1 hour') THEN
    RETURN false;
  END IF;
  INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                              body_text, dedupe_key)
  VALUES (NULL, 'security_alert', p_to_email, NULL, p_subject, p_body_text,
          p_dedupe_key);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION platform_alert_enqueue(text, text, text, text)
  FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION platform_alert_enqueue(text, text, text, text) TO hotelpms_app;

-- ---------------------------------------------------------------------------
-- Die Plattformsicht. Eine Plattformsitzung hat keinen Mandantenkontext, ein
-- SELECT saehe nichts (0032, 0052); also eine Funktion mit Rechtepruefung
-- in der Funktion.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_security_events(p_limit integer)
RETURNS TABLE (id bigint, account_id bigint, account_name text,
               property_id bigint, kind text, actor_kind text,
               actor_user_id bigint, actor_name text, actor_ref text,
               origin text, origin_truncated boolean, detail jsonb,
               created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_can('platform:accounts') THEN
    RAISE EXCEPTION 'platform_permission_denied' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id, e.account_id, a.name, e.property_id, e.kind, e.actor_kind,
         e.actor_user_id, u.display_name, e.actor_ref, host(e.origin),
         e.origin_truncated, e.detail, e.created_at
    FROM security_event e
    LEFT JOIN account a  ON a.id = e.account_id
    LEFT JOIN app_user u ON u.id = e.actor_user_id
   ORDER BY e.created_at DESC
   LIMIT least(greatest(p_limit, 1), 500);
END $$;
REVOKE ALL ON FUNCTION platform_security_events(integer) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION platform_security_events(integer) TO hotelpms_app;
