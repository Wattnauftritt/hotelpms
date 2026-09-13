-- Mandanten, Nutzer, Rollen. Nach Dokument 14.

CREATE TABLE account (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref  text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  name        text NOT NULL,
  legal_name  text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE property (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        bigint NOT NULL REFERENCES account(id),
  public_ref        text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  code              text NOT NULL,
  name              text NOT NULL,
  timezone          text NOT NULL DEFAULT 'Europe/Berlin',
  currency          char(3) NOT NULL DEFAULT 'EUR',
  -- Tageswechsel. Gestreut ueber ein Fenster, damit nicht alle Betriebe
  -- gleichzeitig starten (P4, Dok 12).
  rollover_time     time NOT NULL DEFAULT '04:00',
  checkin_time      time NOT NULL DEFAULT '15:00',
  checkout_time     time NOT NULL DEFAULT '11:00',
  address_line1     text,
  postal_code       text,
  city              text,
  country           char(2) NOT NULL DEFAULT 'DE',
  tax_number        text,
  vat_id            text,
  municipality_key  text,                      -- fuer Kurtaxe
  void_own_window_minutes integer NOT NULL DEFAULT 15,
  discount_limit_percent  integer NOT NULL DEFAULT 10,
  is_training       boolean NOT NULL DEFAULT false,   -- C11, Dok 13
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code)
);

CREATE TABLE permission (
  key         text PRIMARY KEY,
  grp         text NOT NULL,
  description text NOT NULL
);

CREATE TABLE role (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint REFERENCES account(id),        -- NULL = Systemrolle
  level      text NOT NULL CHECK (level IN ('platform','account','property')),
  key        text NOT NULL,
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX role_system_key ON role (key) WHERE account_id IS NULL;
CREATE UNIQUE INDEX role_account_key ON role (account_id, key) WHERE account_id IS NOT NULL;

CREATE TABLE role_permission (
  role_id        bigint NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key text   NOT NULL REFERENCES permission(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE app_user (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref           text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  email                text NOT NULL,            -- immer lower() gespeichert
  display_name         text NOT NULL,
  password_hash        text,
  totp_secret_enc      bytea,
  totp_key_version     smallint,
  workstation_pin_hash text,
  is_platform_staff    boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'invited'
                       CHECK (status IN ('invited','active','disabled')),
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX app_user_email ON app_user (lower(email));

CREATE TABLE user_account_role (
  user_id    bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES account(id),
  role_id    bigint NOT NULL REFERENCES role(id),
  granted_by bigint REFERENCES app_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id, role_id)
);

CREATE TABLE user_property_role (
  user_id     bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  property_id bigint NOT NULL REFERENCES property(id),
  role_id     bigint NOT NULL REFERENCES role(id),
  granted_by  bigint REFERENCES app_user(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, property_id, role_id)
);

CREATE TABLE user_platform_role (
  user_id    bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id    bigint NOT NULL REFERENCES role(id),
  PRIMARY KEY (user_id, role_id)
);

-- Der einzige Weg, auf dem Plattformpersonal Kundendaten sieht (Dok 14).
CREATE TABLE support_session (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       bigint NOT NULL REFERENCES account(id),
  platform_user_id bigint NOT NULL REFERENCES app_user(id),
  granted_by       bigint REFERENCES app_user(id),   -- NULL nur im Notfallpfad
  is_emergency     boolean NOT NULL DEFAULT false,
  reason           text NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  granted_at       timestamptz,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  CONSTRAINT support_session_window CHECK (expires_at > requested_at)
);
CREATE INDEX support_session_active
  ON support_session (platform_user_id, account_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE user_session (
  id           text PRIMARY KEY,                     -- zufaellig, 32 Byte base64url
  user_id      bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  active_user_id bigint REFERENCES app_user(id),     -- Arbeitsplatz-PIN wechselt die Person
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);
CREATE INDEX user_session_user ON user_session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_session_expiry ON user_session (expires_at);

CREATE TABLE oauth_client (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES account(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  name         text NOT NULL,
  secret_hash  text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  property_ids bigint[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Idempotenzschluessel je Client, nicht global (S2, Dok 12).
CREATE TABLE idempotency_key (
  client_key   text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       text NOT NULL DEFAULT 'in_flight'
               CHECK (status IN ('in_flight','completed')),
  response_status integer,
  response_body   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (client_key, key)
);
CREATE INDEX idempotency_expiry ON idempotency_key (expires_at);

-- ---------------------------------------------------------------------------
-- Row Level Security. Zweite Verteidigungslinie hinter der Anwendung (S1).
-- FORCE, sonst umgeht der Eigentuemer die Richtlinie.
-- ---------------------------------------------------------------------------

ALTER TABLE account  ENABLE ROW LEVEL SECURITY;
ALTER TABLE account  FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON account USING (id = ANY (app_account_ids()));

ALTER TABLE property ENABLE ROW LEVEL SECURITY;
ALTER TABLE property FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON property USING (id = ANY (app_property_ids()));

ALTER TABLE oauth_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_client FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON oauth_client USING (account_id = ANY (app_account_ids()));

-- Anmeldung braucht Zugriff vor jedem Mandantenkontext (C6, Dok 13).
-- Diese Tabellen sind daher nicht ueber property_id gefiltert; ihr Schutz
-- liegt in der Anwendung und darin, dass sie keine Gastdaten enthalten.

SELECT attach_audit('account');
SELECT attach_audit('property');
SELECT attach_audit('app_user');
SELECT attach_audit('role');
SELECT attach_audit('role_permission');
SELECT attach_audit('user_account_role');
SELECT attach_audit('user_property_role');
SELECT attach_audit('user_platform_role');
SELECT attach_audit('support_session');
SELECT attach_audit('oauth_client');
