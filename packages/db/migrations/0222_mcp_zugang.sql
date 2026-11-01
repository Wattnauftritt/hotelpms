-- ---------------------------------------------------------------------------
-- Lesender Zugang fuer Claude zum Livesystem (MCP), Dokument 38.
--
-- Anforderung (Sven, 01.11.2026): Fehler im Livesystem suchen und es
-- analysieren, ohne dass jemand Abfragen von Hand abschreibt. Bedingungen:
-- nur lesen, Gastdaten standardmaessig geschwaerzt, Klartext je Haus fuer
-- eine Stunde und nur nach Freigabe mit Passkey, jede Abfrage protokolliert,
-- Notschalter, Meldung an das Sicherheitspostfach.
--
-- Bauform:
--
-- * Eine eigene Datenbankrolle `hotelpms_mcp` (scripts/setup-db.sh). Sie hat
--   **keine** Rechte auf `public`, nur auf das Schema `mcp` mit Sichten und
--   auf `mcp_dienst` mit Funktionen. Die vorhandene Leserolle kam nicht in
--   Frage: sie liest jede Tabelle, auch Kennworthashes und Tokens.
-- * Die Sichten erzeugt `mcp_views_refresh()` aus dem Katalog. Sie laeuft am
--   Ende jeder Migration (packages/db/src/migrate.ts), damit eine neue
--   Tabelle oder Spalte ohne Zutun dort steht -- und zwar geschwaerzt, wenn
--   sie freien Text traegt. Sichtbar ist freier Text nur, wenn sein Name
--   unten ausdruecklich als harmlos steht. Das ist eine Positivliste mit
--   Absicht: vergisst jemand einen Eintrag, fehlt eine Angabe, statt dass
--   ein Gastname durchrutscht.
-- * Geheimnisse (Hashes, Schluessel, Tokens, Unterschriften, Binaerdaten)
--   fehlen in den Sichten ganz, auch mit Freigabe.
-- * Klartext entscheidet die Sicht je Zeile ueber `mcp_dienst.klartext_*`:
--   gibt es fuer diese Verbindung eine erteilte, laufende Freigabe fuer das
--   Haus der Zeile? Die Verbindung steht transaktionslokal in
--   `mcp.verbindung`, gesetzt vom Dienst.
--
-- Umlaute in diesem Kommentar bewusst vermieden (CLAUDE.md).
-- ---------------------------------------------------------------------------

-- ------------------------------------------------------------------- Recht
INSERT INTO permission (key, grp, description) VALUES
  ('platform:mcp', 'Plattform',
   'Lesenden Zugang fuer Claude verbinden, sperren und Klartext freigeben');

-- Nur die Plattformleitung: wer das darf, gibt Gastdaten an einen
-- Unterauftragsverarbeiter heraus.
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'platform:mcp'
  FROM role r
 WHERE r.account_id IS NULL AND r.level = 'platform' AND r.key = 'platform_admin';

-- --------------------------------------------------------------- Tabellen
CREATE TABLE mcp_setting (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Der Notschalter. Gesetzt: keine Verbindung gilt, keine neue entsteht.
  locked      boolean NOT NULL DEFAULT false,
  locked_at   timestamptz,
  locked_by   bigint REFERENCES app_user(id),
  -- Wohin eine Klartext-Anfrage gemeldet wird. Schreibt die API beim Start
  -- aus PLATFORM_NOTICE_EMAIL; der Dienst selbst kennt keine Adresse.
  alarm_email text CHECK (alarm_email IS NULL OR char_length(alarm_email) <= 254)
);
INSERT INTO mcp_setting DEFAULT VALUES;

-- Autorisierungscode nach OAuth 2.1 mit PKCE. Zwei Minuten gueltig, einmal
-- einloesbar; gespeichert wird nur der Hash.
CREATE TABLE mcp_auth_code (
  code_hash      bytea PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES app_user(id),
  client_id      text NOT NULL CHECK (char_length(client_id) <= 200),
  redirect_uri   text NOT NULL CHECK (char_length(redirect_uri) <= 500),
  code_challenge text NOT NULL CHECK (char_length(code_challenge) BETWEEN 43 AND 128),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp_connection (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref     text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  -- Wer die Verbindung erlaubt hat. Freigaben gelten fuer diese Person.
  user_id        bigint NOT NULL REFERENCES app_user(id),
  client_id      text NOT NULL,
  token_hash     bytea NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Acht Stunden, nicht verlaengerbar: ein erbeutetes Token verfaellt am
  -- selben Tag, und neu verbinden kostet einen Passkey.
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('manual', 'locked')),
  last_used_at   timestamptz
);

CREATE TABLE mcp_release (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  connection_id bigint NOT NULL REFERENCES mcp_connection(id),
  property_id  bigint NOT NULL REFERENCES property(id),
  reason       text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  -- Zwei Ziffern, die Claude im Thread nennt und die im Adminpanel stehen.
  -- Sie verhindert, dass eine fremde Anfrage aus Versehen freigegeben wird.
  match_code   text NOT NULL CHECK (match_code ~ '^[0-9]{2}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Die Herausforderung, die der Passkey fuer genau diese Anfrage
  -- unterschreibt (webauthn_challenge.id).
  challenge_id text,
  granted_at   timestamptz,
  granted_by   bigint REFERENCES app_user(id),
  expires_at   timestamptz,
  denied_at    timestamptz,
  ended_at     timestamptz,
  -- Wie viele Zeilen unter dieser Freigabe gelesen wurden. Ab 2000 ist sie
  -- erschoepft, auch wenn die Stunde noch laeuft.
  rows_used    integer NOT NULL DEFAULT 0
);
CREATE INDEX mcp_release_connection ON mcp_release (connection_id);

-- Jeder Aufruf. Unveraenderlich wie audit_log: wer hier etwas tilgen
-- koennte, koennte auch verbergen, was er gelesen hat.
CREATE TABLE mcp_call (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id bigint NOT NULL REFERENCES mcp_connection(id),
  at            timestamptz NOT NULL DEFAULT now(),
  tool          text NOT NULL CHECK (char_length(tool) <= 60),
  property_id   bigint,
  rows          integer NOT NULL DEFAULT 0,
  plaintext     boolean NOT NULL DEFAULT false,
  duration_ms   integer NOT NULL DEFAULT 0,
  ok            boolean NOT NULL,
  -- Die Abfrage mit ersetzten Zeichenketten: abzulesen ist, wonach gesucht
  -- wurde, nicht wer -- wie beim Protokoll der API (Befund B2, Dokument 25).
  detail        text CHECK (char_length(detail) <= 4000)
);
CREATE INDEX mcp_call_connection ON mcp_call (connection_id, at DESC);
CREATE INDEX mcp_call_at ON mcp_call (at DESC);

-- Welche Umgebungsvariablen in API und Worker gesetzt sind -- die Namen,
-- nie die Werte. Die Dienste schreiben das beim Start; der MCP-Dienst hat
-- eine eigene, kleine Umgebung und koennte es sonst nicht wissen.
CREATE TABLE service_config_presence (
  service     text NOT NULL CHECK (service IN ('api', 'worker')),
  name        text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  is_set      boolean NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, name)
);

-- Die Anwendungsrolle bekommt durch die Vorgaben aus 0001 alles auf neue
-- Tabellen. Hier nicht: sie arbeitet ueber die Funktionen unten, und ein
-- Token-Hash hat in einer Leserolle nichts zu suchen.
REVOKE ALL ON mcp_setting, mcp_auth_code, mcp_connection, mcp_release, mcp_call
  FROM hotelpms_app, hotelpms_readonly;
SELECT make_append_only('mcp_call');
-- API und Worker melden ihren Stand mit INSERT ... ON CONFLICT DO UPDATE.
REVOKE ALL ON service_config_presence FROM hotelpms_app, hotelpms_readonly;
GRANT SELECT, INSERT, UPDATE ON service_config_presence TO hotelpms_app;

-- Neue Arten fuer das Sicherheitsprotokoll und die Push-Meldung.
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
    'client_origin_denied',
    'mcp_connected', 'mcp_release_requested', 'mcp_release_granted',
    'mcp_locked'));

ALTER TABLE staff_push DROP CONSTRAINT staff_push_kind_check;
ALTER TABLE staff_push ADD CONSTRAINT staff_push_kind_check
  CHECK (kind IN ('plan','room_free','rework','waived','request','mcp_release'));

-- ------------------------------------------------------- Schemata, Helfer
CREATE SCHEMA IF NOT EXISTS mcp_dienst AUTHORIZATION hotelpms_owner;
CREATE SCHEMA IF NOT EXISTS mcp AUTHORIZATION hotelpms_owner;
REVOKE ALL ON SCHEMA mcp, mcp_dienst FROM PUBLIC;

/*
 * Die Verbindung dieser Transaktion. Kein SECURITY DEFINER: sie liest nur
 * eine Einstellung, und die setzt der Dienst.
 */
CREATE OR REPLACE FUNCTION mcp_dienst.verbindung_id() RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(current_setting('mcp.verbindung', true), '')::bigint
$$;

/*
 * Darf der Freigebende Klartext dieses Hauses sehen lassen? Im eigenen
 * Betrieb immer; in einem fremden nur, solange dessen Support-Freigabe
 * laeuft (Svens Entscheidung, 01.11.2026). Bei jeder Zeile neu geprueft,
 * damit eine abgelaufene Support-Freigabe den Klartext sofort beendet.
 */
CREATE OR REPLACE FUNCTION mcp_dienst.haus_erlaubt(p_user bigint, p_property bigint)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM user_property_role
                  WHERE user_id = p_user AND property_id = p_property)
      OR EXISTS (SELECT 1 FROM user_account_role uar
                   JOIN property p ON p.account_id = uar.account_id
                  WHERE uar.user_id = p_user AND p.id = p_property)
      OR EXISTS (SELECT 1 FROM support_session s
                   JOIN property p ON p.account_id = s.account_id
                  WHERE p.id = p_property AND s.granted_at IS NOT NULL
                    AND s.revoked_at IS NULL AND s.expires_at > now())
$$;

/* Die Haeuser, fuer die diese Verbindung gerade Klartext sehen darf. */
CREATE OR REPLACE FUNCTION mcp_dienst.klartext_haeuser() RETURNS SETOF bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.property_id
    FROM mcp_release r
    JOIN mcp_connection c ON c.id = r.connection_id
   WHERE r.connection_id = mcp_dienst.verbindung_id()
     AND r.granted_at IS NOT NULL AND r.ended_at IS NULL
     AND r.expires_at > now() AND r.rows_used < 2000
     AND c.revoked_at IS NULL AND c.expires_at > now()
     AND NOT COALESCE((SELECT locked FROM mcp_setting), false)
     AND mcp_dienst.haus_erlaubt(r.granted_by, r.property_id)
$$;

CREATE OR REPLACE FUNCTION mcp_dienst.klartext_haus(p_property bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_property IS NOT NULL
     AND mcp_dienst.verbindung_id() IS NOT NULL
     AND p_property IN (SELECT mcp_dienst.klartext_haeuser())
$$;

/* Profile eines Betriebs (Gast, Firma): sichtbar, wenn ein Haus des Betriebs frei ist. */
CREATE OR REPLACE FUNCTION mcp_dienst.klartext_konto(p_account bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_account IS NOT NULL
     AND mcp_dienst.verbindung_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM property p
                  WHERE p.account_id = p_account
                    AND p.id IN (SELECT mcp_dienst.klartext_haeuser()))
$$;

/* Benutzer: sichtbar, wenn er in einem freigegebenen Haus arbeitet. */
CREATE OR REPLACE FUNCTION mcp_dienst.klartext_benutzer(p_user bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_user IS NOT NULL
     AND mcp_dienst.verbindung_id() IS NOT NULL
     AND (EXISTS (SELECT 1 FROM user_property_role upr
                   WHERE upr.user_id = p_user
                     AND upr.property_id IN (SELECT mcp_dienst.klartext_haeuser()))
          OR EXISTS (SELECT 1 FROM user_account_role uar
                       JOIN property p ON p.account_id = uar.account_id
                      WHERE uar.user_id = p_user
                        AND p.id IN (SELECT mcp_dienst.klartext_haeuser())))
$$;

/* Haus einer Reservierung oder eines Gastes, fuer Tabellen ohne eigene Spalte. */
CREATE OR REPLACE FUNCTION mcp_dienst.klartext_reservierung(p_reservation bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT mcp_dienst.klartext_haus((SELECT property_id FROM reservation WHERE id = p_reservation))
$$;
CREATE OR REPLACE FUNCTION mcp_dienst.klartext_gast(p_guest bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT mcp_dienst.klartext_konto((SELECT account_id FROM guest WHERE id = p_guest))
$$;

/* Geschwaerzte Formen. */
CREATE OR REPLACE FUNCTION mcp_dienst.text_geschwaerzt(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p IS NULL THEN NULL
              WHEN p = '' THEN ''
              ELSE '[geschwaerzt]' END
$$;

/* Von einem JSON-Objekt bleiben die Schluessel, von einer Liste die Laenge. */
CREATE OR REPLACE FUNCTION mcp_dienst.json_geschwaerzt(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE jsonb_typeof(p)
           WHEN 'object' THEN jsonb_build_object('[geschwaerzt]',
             COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(p) k), '[]'::jsonb))
           WHEN 'array' THEN jsonb_build_object('[geschwaerzt]', jsonb_array_length(p))
           WHEN 'null' THEN p
           ELSE CASE WHEN p IS NULL THEN NULL ELSE '"[geschwaerzt]"'::jsonb END
         END
$$;

/*
 * Fehlertexte bleiben lesbar -- dafuer gibt es den Zugang --, aber eine
 * Mailadresse darin wird ersetzt. Anbieter schreiben sie gern hinein
 * ("invalid recipient anna@...").
 */
CREATE OR REPLACE FUNCTION mcp_dienst.ohne_mail(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT regexp_replace(p, '[^[:space:]@<>"'',;:()\[\]]+@[^[:space:]@<>"'',;:()\[\]]+', '[mail]', 'g')
$$;
CREATE OR REPLACE FUNCTION mcp_dienst.ohne_mail(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT mcp_dienst.ohne_mail(p::text)::jsonb
$$;

/* IPv4 auf /24, IPv6 auf /48: das Netz bleibt erkennbar, der Anschluss nicht. */
CREATE OR REPLACE FUNCTION mcp_dienst.netz(p inet) RETURNS inet
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p IS NULL THEN NULL
              ELSE network(set_masklen(p, CASE WHEN family(p) = 4 THEN 24 ELSE 48 END))::inet END
$$;

-- ------------------------------------------------------- Einordnung
/*
 * Wie jede Spalte in der Sicht erscheint. Neu gefuellt bei jedem Lauf von
 * mcp_views_refresh(); das Werkzeug `tabellen` liest sie.
 *
 *   sichtbar   wie in der Tabelle
 *   maskiert   lesbar, Mailadressen ersetzt (Fehlertexte, technische JSON)
 *   netz       IP gekuerzt, mit Freigabe voll
 *   person     geschwaerzt, mit Freigabe Klartext
 *   fehlt      nicht in der Sicht, auch nicht mit Freigabe
 */
CREATE TABLE mcp_column_class (
  table_name  text NOT NULL,
  column_name text NOT NULL,
  class       text NOT NULL CHECK (class IN ('sichtbar','maskiert','netz','person','fehlt')),
  PRIMARY KEY (table_name, column_name)
);
REVOKE ALL ON mcp_column_class FROM hotelpms_app, hotelpms_readonly;

/*
 * Freier Text, der harmlos ist. Spaltennamen, die in jeder Tabelle eine
 * Auswahl aus festen Werten oder eine Kennung tragen.
 */
CREATE OR REPLACE FUNCTION mcp_dienst.harmloser_name(p_column text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_column = ANY (ARRAY[
      'status','kind','code','key','public_ref','source','channel','provider','mode',
      'lang','locale','language','timezone','mime','sha256','step','outcome','action',
      'level','priority','category','urgency','trigger','grp','basis','derive_kind',
      'fee_kind','charge_mode','rounding','time_unit','match_kind','effect_kind',
      'occupancy_scope','state','delivery_status','delivery_reason','table_name',
      'column_name','grund','event_type','event_ref','permission_key','prefix',
      'invoice_prefix','commit','commit_before','commit_after','target_ref',
      'actor_kind','actor_ref','legacy_system','legacy_reference','external_system',
      'system','channel_code','channel_owner','market_segment','sync_mode',
      'author_side','screen','client_version','handler','submitted_via','hk_before',
      'building','floor','revenue_account','package_part','municipality_key',
      'unchecked_arrival','id_document_type','external_reference',
      'external_revision_id','external_property_id','external_rate_plan',
      'external_room_type','external_number','channel_booking_number',
      'booking_number','provider_reference','provider_account','provider_event_id',
      'provider_message_id','provider_id','error_key','last_error_key','sales_code',
      'number','currency','country','nationality','principal_key','client_key',
      'origin_reservation_ref','reference','pdf_path','attachment_sha256',
      'source_kind','source_lang','inspection','inspection_from','inspection_to',
      'outcome_from','outcome_to','status_from','status_to','wifi_security',
      'canceled_by','ended_reason','credentials_hint','secret_key_hint',
      'connect_client_id','chart_of_accounts','dedupe_key','client','purpose',
      'tool','client_id','revoked_reason','match_code'])
$$;

/* Harmlos nur in einer bestimmten Tabelle: Namen von Dingen, nicht von Menschen. */
CREATE OR REPLACE FUNCTION mcp_dienst.harmlose_spalte(p_table text, p_column text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (p_table || '.' || p_column) = ANY (ARRAY[
      'property.name','property.city','property.invoice_website','property.checkin_portal_ref',
      'resource.name','resource_category.name','resource_category.description',
      'rate_plan.name','product.name','tax_rule.name','cancellation_policy.name',
      'role.name','payment_method.name','channel_connection.name','oauth_client.name',
      'rate_steer_rule.name','terminal_device.name','permission.description',
      'release.subject','schema_migration.name','city_tax_exemption_reason.label',
      'property_terms.title','terminal_content.title','terminal_url.label',
      'terminal_url.url','property_email_domain.domain','property_email_domain.local_part',
      'property_email_setting.from_name','webhook_subscription.url','avs_setting.hotel_id',
      'avs_export.file_name','invoice_document_failure.last_error',
      'service_config_presence.service','service_config_presence.name',
      'cashbook_setting.account_bank_deposit','cashbook_setting.account_breakfast_drinks',
      'cashbook_setting.account_breakfast_food','cashbook_setting.account_cash_in',
      'cashbook_setting.account_city_tax','cashbook_setting.account_expense',
      'cashbook_setting.account_lodging','guest_request_item.offer',
      'routing_rule.match_value','inventory_error.description','mcp_release.reason',
      'mcp_call.detail',
      'cleaning_area.building','avs_setting.origin','support_ticket.category'])
$$;

/* Fehler- und Protokolltexte: lesbar mit ersetzten Mailadressen. */
CREATE OR REPLACE FUNCTION mcp_dienst.fehlertext(p_column text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_column = ANY (ARRAY['last_error','error','message','log'])
$$;

/* Technische JSON-Spalten, deren Inhalt fuer die Fehlersuche gebraucht wird. */
CREATE OR REPLACE FUNCTION mcp_dienst.technisches_json(p_table text, p_column text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (p_table || '.' || p_column) = ANY (ARRAY[
      'security_event.detail','night_audit_step.detail','staff_push.params',
      'room_sort_setting.weights','room_sort_run.moves','invoice.totals',
      'invoice_document.xml_findings','property_email_domain.dns_records',
      'rate_calendar_push.conflicts','rate_calendar_push.served',
      'rate_calendar_pull.plans','rate_calendar_pull.result',
      'reservation_external_price.nights','cashbook_entry.legacy_split'])
$$;

/* Geheimnisse am Namen. Fehlen in der Sicht, auch mit Freigabe. */
CREATE OR REPLACE FUNCTION mcp_dienst.geheimer_name(p_table text, p_column text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_column ~ '(hash|secret|token|_enc$|password|private_key|credential|challenge|signature|p256dh|endpoint)'
      OR p_column = 'auth'
      OR (p_table || '.' || p_column) = ANY (ARRAY[
           'user_session.id', 'idempotency_key.response_body', 'invoice_document.xml'])
$$;

-- Tabellen, die gar nicht erscheinen.
--   decoy               die Koederliste (0213). Wer sie kennt, erkennt die Koeder.
--   webauthn_challenge  offene Herausforderungen.
--   platform_vapid_key  der private Schluessel fuer Push.
--   mcp_auth_code       einloesbare Codes dieses Zugangs selbst.
--   mcp_column_class    steht im Werkzeug `tabellen`.
CREATE OR REPLACE FUNCTION mcp_dienst.ausgeschlossen(p_table text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_table = ANY (ARRAY['decoy','webauthn_challenge','platform_vapid_key',
                              'mcp_auth_code','mcp_column_class'])
$$;

/*
 * Die Sichten neu erzeugen. Idempotent; laeuft am Ende jeder Migration.
 *
 * Die Sichten gehoeren der Eigentuemerrolle und lesen mit ihren Rechten --
 * damit an der Zeilenrichtlinie vorbei, ueber alle Betriebe. Das ist der
 * Zweck: die Fehlersuche braucht den Blick ueber alle Haeuser. Die Grenze
 * ist hier die Schwaerzung, nicht der Mandant.
 */
CREATE OR REPLACE FUNCTION mcp_views_refresh() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t record;
  c record;
  v_cols text[];
  v_scope text;
  v_expr text;
  v_class text;
  v_has text[];
  v_count integer := 0;
  v_rolle boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotelpms_mcp');
BEGIN
  -- Alte Sichten weg; was es nicht mehr gibt, soll nicht stehen bleiben.
  FOR t IN SELECT c2.relname FROM pg_class c2
             JOIN pg_namespace n ON n.oid = c2.relnamespace
            WHERE n.nspname = 'mcp' AND c2.relkind = 'v' LOOP
    EXECUTE format('DROP VIEW mcp.%I', t.relname);
  END LOOP;
  DELETE FROM mcp_column_class;

  FOR t IN SELECT c2.oid, c2.relname
             FROM pg_class c2 JOIN pg_namespace n ON n.oid = c2.relnamespace
            WHERE n.nspname = 'public' AND c2.relkind IN ('r', 'p')
              AND NOT c2.relispartition
              AND NOT mcp_dienst.ausgeschlossen(c2.relname)
            ORDER BY c2.relname LOOP
    SELECT array_agg(a.attname::text) INTO v_has
      FROM pg_attribute a
     WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped;

    -- Zu welchem Haus gehoert die Zeile? Davon haengt der Klartext ab.
    v_scope := CASE
      WHEN 'property_id' = ANY (v_has) THEN 'mcp_dienst.klartext_haus(t.property_id)'
      WHEN t.relname = 'property' THEN 'mcp_dienst.klartext_haus(t.id)'
      WHEN 'account_id' = ANY (v_has) THEN 'mcp_dienst.klartext_konto(t.account_id)'
      WHEN t.relname = 'account' THEN 'mcp_dienst.klartext_konto(t.id)'
      WHEN t.relname = 'app_user' THEN 'mcp_dienst.klartext_benutzer(t.id)'
      WHEN 'reservation_id' = ANY (v_has) THEN 'mcp_dienst.klartext_reservierung(t.reservation_id)'
      WHEN 'guest_id' = ANY (v_has) THEN 'mcp_dienst.klartext_gast(t.guest_id)'
      ELSE 'false' END;

    v_cols := ARRAY[]::text[];
    FOR c IN SELECT a.attname::text AS name, format_type(a.atttypid, NULL) AS typ,
                    ar.grund
               FROM pg_attribute a
               LEFT JOIN audit_redaction ar
                 ON ar.table_name = t.relname AND ar.column_name = a.attname
              WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attnum LOOP
      v_class := CASE
        WHEN c.typ = 'bytea' THEN 'fehlt'
        -- Ein Zeitpunkt oder Schalter mit "token" im Namen ist kein Geheimnis.
        WHEN mcp_dienst.geheimer_name(t.relname, c.name)
             AND c.typ NOT IN ('boolean', 'bigint', 'integer', 'smallint', 'date',
                               'timestamp with time zone') THEN 'fehlt'
        WHEN c.grund IN ('Geheimnis', 'Unterschrift') THEN 'fehlt'
        WHEN c.grund IS NOT NULL AND NOT mcp_dienst.harmloser_name(c.name) THEN 'person'
        WHEN c.typ = 'inet' THEN 'netz'
        WHEN c.typ IN ('text', 'character varying', 'character', 'citext') THEN
          CASE WHEN mcp_dienst.harmloser_name(c.name)
                 OR mcp_dienst.harmlose_spalte(t.relname, c.name) THEN 'sichtbar'
               WHEN mcp_dienst.fehlertext(c.name) THEN 'maskiert'
               ELSE 'person' END
        WHEN c.typ IN ('jsonb', 'json') THEN
          CASE WHEN mcp_dienst.technisches_json(t.relname, c.name) THEN 'maskiert'
               ELSE 'person' END
        ELSE 'sichtbar' END;

      INSERT INTO mcp_column_class VALUES (t.relname, c.name, v_class);
      CONTINUE WHEN v_class = 'fehlt';

      v_expr := CASE v_class
        WHEN 'sichtbar' THEN format('t.%I', c.name)
        WHEN 'maskiert' THEN format('mcp_dienst.ohne_mail(t.%I%s)', c.name,
                                    CASE WHEN c.typ = 'json' THEN '::jsonb'
                                         WHEN c.typ IN ('character varying','character','citext')
                                           THEN '::text' ELSE '' END)
        WHEN 'netz' THEN format('CASE WHEN %s THEN t.%I ELSE mcp_dienst.netz(t.%I) END',
                                v_scope, c.name, c.name)
        ELSE CASE
          WHEN c.typ IN ('text', 'character varying', 'character', 'citext') THEN
            format('CASE WHEN %s THEN t.%I::text ELSE mcp_dienst.text_geschwaerzt(t.%I::text) END',
                   v_scope, c.name, c.name)
          WHEN c.typ IN ('jsonb', 'json') THEN
            format('CASE WHEN %s THEN t.%I::jsonb ELSE mcp_dienst.json_geschwaerzt(t.%I::jsonb) END',
                   v_scope, c.name, c.name)
          ELSE format('CASE WHEN %s THEN t.%I ELSE NULL END', v_scope, c.name)
        END
      END;
      v_cols := v_cols || format('%s AS %I', v_expr, c.name);
    END LOOP;

    CONTINUE WHEN cardinality(v_cols) = 0;
    EXECUTE format('CREATE VIEW mcp.%I AS SELECT %s FROM public.%I t',
                   t.relname, array_to_string(v_cols, ', '), t.relname);
    v_count := v_count + 1;
  END LOOP;

  IF v_rolle THEN
    EXECUTE 'GRANT USAGE ON SCHEMA mcp, mcp_dienst TO hotelpms_mcp';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA mcp TO hotelpms_mcp';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mcp_dienst TO hotelpms_mcp';
  END IF;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION mcp_views_refresh() FROM PUBLIC, hotelpms_app, hotelpms_readonly;

-- ------------------------------------------------- Funktionen des Dienstes
-- Aufgerufen vom MCP-Dienst unter hotelpms_mcp. Lesen und schreiben nur die
-- eigenen Tabellen; nichts davon erreicht Fachdaten.

/* Das Token pruefen. Gesperrt, abgelaufen oder widerrufen: keine Zeile. */
CREATE OR REPLACE FUNCTION mcp_dienst.anmelden(p_token_hash bytea)
RETURNS TABLE (verbindung bigint, verbindung_ref text, benutzer bigint, laeuft_ab timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE mcp_connection c SET last_used_at = now()
   WHERE c.token_hash = p_token_hash
     AND c.revoked_at IS NULL AND c.expires_at > now()
     AND NOT COALESCE((SELECT locked FROM mcp_setting), false)
     AND EXISTS (SELECT 1 FROM app_user u
                  JOIN user_platform_role upr ON upr.user_id = u.id
                  JOIN role_permission rp ON rp.role_id = upr.role_id
                 WHERE u.id = c.user_id AND u.is_platform_staff AND u.status = 'active'
                   AND rp.permission_key = 'platform:mcp')
  RETURNING c.id, c.public_ref, c.user_id, c.expires_at
$$;

/* Ist in dieser Transaktion Klartext moeglich? */
CREATE OR REPLACE FUNCTION mcp_dienst.klartext_aktiv() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM mcp_dienst.klartext_haeuser())
$$;

/*
 * Einen Aufruf festhalten. War Klartext moeglich, zaehlen die gelesenen
 * Zeilen gegen jede laufende Freigabe der Verbindung -- grob, aber nach
 * oben: lieber endet eine Freigabe zu frueh als zu spaet.
 */
CREATE OR REPLACE FUNCTION mcp_dienst.protokollieren(
  p_verbindung bigint, p_werkzeug text, p_haus bigint, p_zeilen integer,
  p_klartext boolean, p_dauer integer, p_ok boolean, p_detail text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO mcp_call (connection_id, tool, property_id, rows, plaintext,
                        duration_ms, ok, detail)
  VALUES (p_verbindung, left(p_werkzeug, 60), p_haus, GREATEST(p_zeilen, 0),
          p_klartext, GREATEST(p_dauer, 0), p_ok, left(p_detail, 4000));
  IF p_klartext AND p_zeilen > 0 THEN
    UPDATE mcp_release SET rows_used = rows_used + p_zeilen
     WHERE connection_id = p_verbindung AND granted_at IS NOT NULL
       AND ended_at IS NULL AND expires_at > now();
  END IF;
END $$;

/*
 * Klartext fuer ein Haus anfragen. Legt die Anfrage mit Abgleichszahl an,
 * meldet sie ins Sicherheitsprotokoll und an das Sicherheitspostfach und
 * schickt der Plattformleitung eine Push-Meldung.
 */
CREATE OR REPLACE FUNCTION mcp_dienst.freigabe_anfragen(
  p_verbindung bigint, p_haus bigint, p_grund text
) RETURNS TABLE (ref text, abgleich text, haus text, betrieb text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_conn mcp_connection%ROWTYPE;
  v_prop property%ROWTYPE;
  v_code text := lpad((floor(random() * 100))::int::text, 2, '0');
  v_ref text;
  v_alarm text;
BEGIN
  SELECT * INTO v_conn FROM mcp_connection WHERE id = p_verbindung;
  SELECT * INTO v_prop FROM property WHERE id = p_haus;
  IF v_prop.id IS NULL THEN
    RAISE EXCEPTION 'mcp_property_unknown' USING ERRCODE = 'P0002';
  END IF;
  IF char_length(btrim(COALESCE(p_grund, ''))) = 0 THEN
    RAISE EXCEPTION 'mcp_reason_missing' USING ERRCODE = '22023';
  END IF;
  -- Drei offene Anfragen genuegen. Mehr waere ein Weg, die Leitung mit
  -- Push-Meldungen zu fluten, bis sie aus Ueberdruss freigibt.
  IF (SELECT count(*) FROM mcp_release
       WHERE connection_id = p_verbindung AND granted_at IS NULL
         AND denied_at IS NULL AND ended_at IS NULL
         AND requested_at > now() - interval '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'mcp_too_many_requests' USING ERRCODE = '54000';
  END IF;

  INSERT INTO mcp_release (connection_id, property_id, reason, match_code)
  VALUES (p_verbindung, p_haus, left(btrim(p_grund), 300), v_code)
  RETURNING public_ref INTO v_ref;

  INSERT INTO security_event (account_id, property_id, kind, actor_kind,
                              actor_user_id, actor_ref, origin, detail)
  VALUES (v_prop.account_id, v_prop.id, 'mcp_release_requested', 'client',
          v_conn.user_id, 'mcp:' || v_conn.public_ref, NULL,
          jsonb_build_object('release', v_ref, 'match', v_code));

  SELECT alarm_email INTO v_alarm FROM mcp_setting;
  IF v_alarm IS NOT NULL THEN
    PERFORM platform_alert_enqueue(v_alarm,
      '[StayGrid] Claude bittet um Klartext',
      'Claude bittet um Klartext fuer Haus ' || v_prop.id || ' (' || v_prop.code || ').'
        || E'\nAbgleichszahl: ' || v_code
        || E'\nGrund: ' || left(btrim(p_grund), 300)
        || E'\nFreigeben oder ablehnen im Adminpanel, Reiter Claude-Zugang.'
        || E'\nWenn du das nicht erwartest: Zugang dort sperren.',
      'mcp_release:' || v_ref);
  END IF;

  -- Push an jede Person mit dem Recht; ohne eingeschaltete Meldungen am
  -- Telefon verfaellt die Zeile still, die Anfrage steht trotzdem im Panel.
  INSERT INTO staff_push (property_id, user_id, kind, params, dedupe_key)
  SELECT DISTINCT v_prop.id, u.id, 'mcp_release',
         jsonb_build_object('code', v_code, 'house', v_prop.code), v_ref
    FROM app_user u
    JOIN user_platform_role upr ON upr.user_id = u.id
    JOIN role_permission rp ON rp.role_id = upr.role_id
   WHERE u.is_platform_staff AND u.status = 'active'
     AND rp.permission_key = 'platform:mcp'
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_ref, v_code, v_prop.name, (SELECT a.public_ref FROM account a
                                                    WHERE a.id = v_prop.account_id);
END $$;

/* Die Freigaben dieser Verbindung, juengste zuerst. */
CREATE OR REPLACE FUNCTION mcp_dienst.freigaben(p_verbindung bigint)
RETURNS TABLE (ref text, haus bigint, haus_name text, grund text, abgleich text,
               zustand text, angefragt timestamptz, endet timestamptz, zeilen integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.public_ref, r.property_id, p.name, r.reason, r.match_code,
         CASE WHEN r.denied_at IS NOT NULL THEN 'abgelehnt'
              WHEN r.ended_at IS NOT NULL THEN 'beendet'
              WHEN r.granted_at IS NULL AND r.requested_at <= now() - interval '15 minutes'
                THEN 'verfallen'
              WHEN r.granted_at IS NULL THEN 'offen'
              WHEN r.expires_at <= now() THEN 'abgelaufen'
              WHEN r.rows_used >= 2000 THEN 'erschoepft'
              ELSE 'aktiv' END,
         r.requested_at, r.expires_at, r.rows_used
    FROM mcp_release r JOIN property p ON p.id = r.property_id
   WHERE r.connection_id = p_verbindung
   ORDER BY r.requested_at DESC
   LIMIT 20
$$;

/* Die Einordnung der Spalten fuer das Werkzeug `tabellen`. */
CREATE OR REPLACE FUNCTION mcp_dienst.spalten()
RETURNS TABLE (tabelle text, spalte text, klasse text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT table_name, column_name, class FROM mcp_column_class ORDER BY 1, 2
$$;

-- ----------------------------------------------------- Funktionen der API

/* Darf diese Person den Zugang bedienen? Ohne Sitzungskontext, fuer den Token-Tausch. */
CREATE OR REPLACE FUNCTION mcp_user_allowed(p_user bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app_user u
                   JOIN user_platform_role upr ON upr.user_id = u.id
                   JOIN role_permission rp ON rp.role_id = upr.role_id
                  WHERE u.id = p_user AND u.is_platform_staff AND u.status = 'active'
                    AND rp.permission_key = 'platform:mcp')
$$;
REVOKE ALL ON FUNCTION mcp_user_allowed(bigint) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_user_allowed(bigint) TO hotelpms_app;

/* Einen Autorisierungscode ausgeben, nach der Zustimmung im Browser. */
CREATE OR REPLACE FUNCTION mcp_code_issue(
  p_code_hash bytea, p_client text, p_redirect text, p_challenge text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  IF COALESCE((SELECT locked FROM mcp_setting), false) THEN
    RAISE EXCEPTION 'mcp_locked' USING ERRCODE = '55000';
  END IF;
  DELETE FROM mcp_auth_code WHERE expires_at < now() - interval '1 hour';
  INSERT INTO mcp_auth_code (code_hash, user_id, client_id, redirect_uri,
                             code_challenge, expires_at)
  VALUES (p_code_hash, app_user_id(), p_client, p_redirect, p_challenge,
          now() + interval '2 minutes');
END $$;
REVOKE ALL ON FUNCTION mcp_code_issue(bytea, text, text, text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_code_issue(bytea, text, text, text) TO hotelpms_app;

/*
 * Code gegen Token tauschen. Ohne Sitzung -- der Aufrufer ist claude.ai.
 * Prueft PKCE (der Aufrufer reicht den S256-Wert des Verifiers), die
 * Weiterleitungsadresse und ob die Person das Recht noch hat. Ein Code geht
 * genau einmal; ein zweiter Versuch mit demselben findet nichts mehr.
 */
CREATE OR REPLACE FUNCTION mcp_code_redeem(
  p_code_hash bytea, p_client text, p_redirect text, p_verifier_s256 text,
  p_token_hash bytea
) RETURNS TABLE (connection_ref text, user_id bigint, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code mcp_auth_code%ROWTYPE;
BEGIN
  DELETE FROM mcp_auth_code c WHERE c.code_hash = p_code_hash RETURNING * INTO v_code;
  IF v_code.code_hash IS NULL OR v_code.expires_at <= now()
     OR v_code.client_id <> p_client OR v_code.redirect_uri <> p_redirect
     OR v_code.code_challenge <> p_verifier_s256
     OR COALESCE((SELECT locked FROM mcp_setting), false)
     OR NOT mcp_user_allowed(v_code.user_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  INSERT INTO mcp_connection (user_id, client_id, token_hash, expires_at)
  VALUES (v_code.user_id, v_code.client_id, p_token_hash, now() + interval '8 hours')
  RETURNING mcp_connection.public_ref, mcp_connection.user_id, mcp_connection.expires_at;
END $$;
REVOKE ALL ON FUNCTION mcp_code_redeem(bytea, text, text, text, bytea) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_code_redeem(bytea, text, text, text, bytea) TO hotelpms_app;

/* Der Stand fuer den Reiter im Adminpanel, in einem Aufruf. */
CREATE OR REPLACE FUNCTION mcp_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'locked', COALESCE((SELECT locked FROM mcp_setting), false),
    'lockedAt', (SELECT locked_at FROM mcp_setting),
    'connections', COALESCE((SELECT jsonb_agg(x ORDER BY x->>'createdAt' DESC) FROM (
      SELECT jsonb_build_object(
               'ref', c.public_ref, 'userName', u.display_name,
               'createdAt', c.created_at, 'expiresAt', c.expires_at,
               'lastUsedAt', c.last_used_at,
               'active', c.revoked_at IS NULL AND c.expires_at > now()) AS x
        FROM mcp_connection c JOIN app_user u ON u.id = c.user_id
       WHERE c.created_at > now() - interval '7 days'
       ORDER BY c.created_at DESC LIMIT 20) s), '[]'::jsonb),
    'releases', COALESCE((SELECT jsonb_agg(x ORDER BY x->>'requestedAt' DESC) FROM (
      SELECT jsonb_build_object(
               'ref', r.public_ref, 'propertyId', r.property_id,
               'propertyName', p.name, 'accountName', a.name,
               'reason', r.reason, 'matchCode', r.match_code,
               'requestedAt', r.requested_at, 'expiresAt', r.expires_at,
               'rowsUsed', r.rows_used,
               'state', CASE WHEN r.denied_at IS NOT NULL THEN 'denied'
                             WHEN r.ended_at IS NOT NULL THEN 'ended'
                             WHEN r.granted_at IS NULL
                                  AND r.requested_at <= now() - interval '15 minutes' THEN 'expired'
                             WHEN r.granted_at IS NULL THEN 'pending'
                             WHEN r.expires_at <= now() OR r.rows_used >= 2000 THEN 'expired'
                             ELSE 'active' END,
               'allowed', mcp_dienst.haus_erlaubt(app_user_id(), r.property_id)) AS x
        FROM mcp_release r
        JOIN property p ON p.id = r.property_id
        JOIN account a ON a.id = p.account_id
       WHERE r.requested_at > now() - interval '7 days'
       ORDER BY r.requested_at DESC LIMIT 30) s), '[]'::jsonb),
    'calls', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'id')::bigint DESC) FROM (
      SELECT jsonb_build_object(
               'id', k.id, 'at', k.at, 'tool', k.tool, 'propertyId', k.property_id,
               'rows', k.rows, 'plaintext', k.plaintext, 'durationMs', k.duration_ms,
               'ok', k.ok, 'detail', k.detail) AS x
        FROM mcp_call k ORDER BY k.id DESC LIMIT 50) s), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION mcp_overview() FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_overview() TO hotelpms_app;

/* Ist eine Anfrage offen? Fuer den Hinweis oben im Adminpanel, billig genug fuer alle 15 s. */
CREATE OR REPLACE FUNCTION mcp_pending_count() RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT count(*) FROM mcp_release
           WHERE granted_at IS NULL AND denied_at IS NULL AND ended_at IS NULL
             AND requested_at > now() - interval '15 minutes');
END $$;
REVOKE ALL ON FUNCTION mcp_pending_count() FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_pending_count() TO hotelpms_app;

/*
 * Der Notschalter. Sperren beendet sofort jede Verbindung und Freigabe;
 * Loesen stellt nichts wieder her, es erlaubt nur ein neues Verbinden.
 */
CREATE OR REPLACE FUNCTION mcp_set_locked(p_locked boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO mcp_setting (id, locked, locked_at, locked_by)
  VALUES (true, p_locked, CASE WHEN p_locked THEN now() END,
          CASE WHEN p_locked THEN app_user_id() END)
  ON CONFLICT (id) DO UPDATE
     SET locked = EXCLUDED.locked, locked_at = EXCLUDED.locked_at,
         locked_by = EXCLUDED.locked_by;
  IF p_locked THEN
    UPDATE mcp_connection SET revoked_at = now(), revoked_reason = 'locked'
     WHERE revoked_at IS NULL;
    UPDATE mcp_release SET ended_at = now() WHERE ended_at IS NULL AND denied_at IS NULL;
    DELETE FROM mcp_auth_code;
  END IF;
END $$;
REVOKE ALL ON FUNCTION mcp_set_locked(boolean) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_set_locked(boolean) TO hotelpms_app;

CREATE OR REPLACE FUNCTION mcp_connection_revoke(p_ref text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE mcp_connection SET revoked_at = now(), revoked_reason = 'manual'
   WHERE public_ref = p_ref AND revoked_at IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;
  UPDATE mcp_release SET ended_at = now()
   WHERE connection_id = v_id AND ended_at IS NULL AND denied_at IS NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION mcp_connection_revoke(text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_connection_revoke(text) TO hotelpms_app;

/*
 * Eine offene Anfrage an eine Passkey-Herausforderung binden. Danach gilt
 * nur eine Antwort auf genau diese Herausforderung als Freigabe dieser
 * Anfrage -- nicht eine Bestaetigung der Sitzung, die fuer alles gaelte.
 */
CREATE OR REPLACE FUNCTION mcp_release_bind(p_ref text, p_challenge_id text)
RETURNS TABLE (property_id bigint, account_id bigint, match_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  UPDATE mcp_release r SET challenge_id = p_challenge_id
    FROM property p, mcp_connection c
   WHERE r.public_ref = p_ref AND p.id = r.property_id AND c.id = r.connection_id
     AND r.granted_at IS NULL AND r.denied_at IS NULL AND r.ended_at IS NULL
     AND r.requested_at > now() - interval '15 minutes'
     AND c.revoked_at IS NULL AND c.expires_at > now()
     AND mcp_dienst.haus_erlaubt(app_user_id(), r.property_id)
  RETURNING r.property_id, p.account_id, r.match_code;
END $$;
REVOKE ALL ON FUNCTION mcp_release_bind(text, text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_release_bind(text, text) TO hotelpms_app;

/* Freigeben, nachdem die API den Passkey gegen diese Herausforderung geprueft hat. */
CREATE OR REPLACE FUNCTION mcp_release_grant(p_ref text, p_challenge_id text)
RETURNS TABLE (property_id bigint, account_id bigint, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  IF COALESCE((SELECT locked FROM mcp_setting), false) THEN
    RAISE EXCEPTION 'mcp_locked' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
  UPDATE mcp_release r
     SET granted_at = now(), granted_by = app_user_id(),
         expires_at = now() + interval '60 minutes'
    FROM property p
   WHERE r.public_ref = p_ref AND p.id = r.property_id
     AND r.challenge_id = p_challenge_id
     AND r.granted_at IS NULL AND r.denied_at IS NULL AND r.ended_at IS NULL
     AND r.requested_at > now() - interval '15 minutes'
     AND mcp_dienst.haus_erlaubt(app_user_id(), r.property_id)
  RETURNING r.property_id, p.account_id, r.expires_at;
END $$;
REVOKE ALL ON FUNCTION mcp_release_grant(text, text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_release_grant(text, text) TO hotelpms_app;

/* Ablehnen (offen) oder vorzeitig beenden (laufend). */
CREATE OR REPLACE FUNCTION mcp_release_close(p_ref text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_state text;
BEGIN
  IF NOT platform_can('platform:mcp') THEN
    RAISE EXCEPTION 'mcp_forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE mcp_release
     SET denied_at = CASE WHEN granted_at IS NULL THEN now() END,
         ended_at  = CASE WHEN granted_at IS NOT NULL THEN now() END
   WHERE public_ref = p_ref AND denied_at IS NULL AND ended_at IS NULL
  RETURNING CASE WHEN granted_at IS NULL THEN 'denied' ELSE 'ended' END INTO v_state;
  RETURN v_state;
END $$;
REVOKE ALL ON FUNCTION mcp_release_close(text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_release_close(text) TO hotelpms_app;

/* Die Adresse fuer Meldungen, beim Start der API gesetzt. */
CREATE OR REPLACE FUNCTION mcp_alarm_email_set(p_email text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO mcp_setting (id, alarm_email) VALUES (true, nullif(btrim(p_email), ''))
  ON CONFLICT (id) DO UPDATE SET alarm_email = EXCLUDED.alarm_email
$$;
REVOKE ALL ON FUNCTION mcp_alarm_email_set(text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION mcp_alarm_email_set(text) TO hotelpms_app;

SELECT mcp_views_refresh();
