-- ---------------------------------------------------------------------------
-- 0198 -- Kanaladapter: StayGrid spricht einen Channel Manager selbst an.
--
-- Anforderung von Sven, 23.10.2026 (Thread "Anbindung weiterer
-- Channelmanager"): RoomCloud direkt und Channex anbinden, statt nur ueber
-- das Adminpanel. Die Pruefung der Anbieter hat ergeben, dass die Annahme aus
-- Dokument 02 (Entscheidung 5: eine Standardschnittstelle, die Anbieter
-- docken an) nicht traegt -- fast jeder Channel Manager erwartet, dass das
-- PMS **seine** Schnittstelle spricht: Verfuegbarkeit senden, Buchungen
-- abholen und bestaetigen.
--
-- Drei Dinge entstehen hier:
--
-- 1. **Zwei Arten von Zugang in einer Tabelle.** `inbound`: ein Umsystem
--    ruft StayGrid mit einem Token (bisher alles, was es gab). `adapter`:
--    StayGrid ruft den Channel Manager, mit dessen Zugangsdaten. Beide in
--    `channel_connection`, weil eine Buchung dem Zugang gehoert, der sie
--    gebracht hat (`booking.channel_connection_id`, 0092), und der Abgleich
--    mit seinen Schutzregeln fuer beide derselbe ist.
--
-- 2. **"roomcloud" heisst jetzt "adminpanel".** Sven: die bisherige
--    Verbindung ist nicht RoomCloud nativ, sondern das Adminpanel, das mit
--    RoomCloud spricht. Der Name `roomcloud` gehoert ab jetzt dem Adapter,
--    der RoomCloud wirklich anspricht. Bestehende Buchungen behalten ihren
--    `channel_code`; er sagt, was damals galt.
--
-- 3. **Probebetrieb.** Im eigenen Hotel bleibt die Verbindung ueber das
--    Adminpanel bestehen (Sven, 23.10.2026). Zwei Systeme, die Verfuegbarkeit
--    an dasselbe RoomCloud-Haus senden, ueberschreiben sich gegenseitig. Ein
--    Adapter im Modus `shadow` sendet deshalb nichts, holt Buchungen nur zum
--    Vergleich und bestaetigt sie nicht; er schreibt nur ins Protokoll, was
--    er getan haette.
--
-- Verfuegbarkeit geht automatisch hinaus, Preise nur per Knopf (Sven,
-- 23.10.2026: "die verfuegbarkeit darf natuerlich immer automatisch
-- rausgehen ... preise die manuell geaendert werden sind ja etwas anderes").
-- ---------------------------------------------------------------------------

ALTER TABLE channel_connection DROP CONSTRAINT channel_connection_provider_check;

UPDATE channel_connection SET provider = 'adminpanel' WHERE provider = 'roomcloud';

ALTER TABLE channel_connection
  ADD COLUMN kind text NOT NULL DEFAULT 'inbound' CHECK (kind IN ('inbound','adapter')),
  ALTER COLUMN token_hash DROP NOT NULL,
  -- Nur beim Adapter. shadow: vergleicht, sendet nichts. active: fuehrt.
  ADD COLUMN sync_mode text CHECK (sync_mode IN ('shadow','active')),
  -- Zugangsdaten beim Anbieter, verschluesselt wie der Stripe-Schluessel
  -- (0168): StayGrid muss sie im Klartext wieder benutzen, ein Hash wie beim
  -- Token reicht deshalb nicht.
  ADD COLUMN credentials_enc bytea,
  -- Anfang und Ende des Schluessels fuer die Anzeige, nie der Schluessel.
  ADD COLUMN credentials_hint text,
  -- Kennung des Hauses beim Anbieter (RoomCloud-Hotel, Channex-Property).
  ADD COLUMN external_property_id text CHECK (char_length(external_property_id) <= 100),
  -- Bis wohin die Verfuegbarkeit gesendet ist: `inventory_day.updated_at`
  -- der neuesten gesendeten Zeile. Leer heisst: noch nie, also alles.
  ADD COLUMN availability_sent_until timestamptz,
  -- "Alles neu senden" am Knopf; der Worker sendet das ganze Jahr und
  -- loescht den Vermerk danach.
  ADD COLUMN full_sync_requested_at timestamptz,
  ADD COLUMN last_sync_at timestamptz,
  -- Schluessel der letzten Meldung, kein Text des Anbieters: der kann
  -- Gastnamen enthalten.
  ADD COLUMN last_error_key text,
  ADD CONSTRAINT channel_connection_provider_check CHECK (
    (kind = 'inbound' AND provider IN ('adminpanel','generic') AND token_hash IS NOT NULL
       AND sync_mode IS NULL AND credentials_enc IS NULL)
    OR (kind = 'adapter' AND provider IN ('roomcloud','channex') AND token_hash IS NULL
       AND sync_mode IS NOT NULL AND credentials_enc IS NOT NULL
       AND external_property_id IS NOT NULL));

-- Ein Haus hat genau einen Adapter je Anbieter. Zwei, die beide senden,
-- ueberschrieben sich gegenseitig beim selben Anbieter.
CREATE UNIQUE INDEX channel_connection_adapter_one
  ON channel_connection (property_id, provider)
  WHERE kind = 'adapter' AND status = 'active';

-- Verschluesselt, aber nicht ins Protokoll (CLAUDE.md, Migration 0044): das
-- Protokoll ist unveraenderlich, und ein spaeterer Schluesselwechsel bekaeme
-- die alten Chiffrate dort nie wieder heraus.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('channel_connection', 'credentials_enc', 'Geheimnis');

-- ---------------------------------------------------------------------------
-- Zuordnung. Bisher stand sie im Adminpanel (Standard 90159, Mehrtages
-- 91166, FZ/APT); mit dem Adapter wandert sie her, je Zugang.
--
-- property_id steht in jeder Zeile, obwohl sie aus dem Zugang folgt: die
-- Zeilenrichtlinie braucht sie, und eine Zuordnung auf die Gruppe eines
-- anderen Hauses im selben Account faengt sie nicht -- das prueft die Route
-- (CLAUDE.md, "Bei mehreren Haeusern im Account").
-- ---------------------------------------------------------------------------

CREATE TABLE channel_room_map (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id         bigint NOT NULL REFERENCES property(id),
  connection_id       bigint NOT NULL REFERENCES channel_connection(id),
  category_id         bigint NOT NULL REFERENCES resource_category(id),
  external_room_type  text NOT NULL CHECK (char_length(external_room_type) BETWEEN 1 AND 100),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, category_id),
  UNIQUE (connection_id, external_room_type)
);
SELECT attach_audit('channel_room_map');
ALTER TABLE channel_room_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_room_map FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON channel_room_map USING (property_id = ANY (app_property_ids()));

CREATE TABLE channel_rate_map (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id         bigint NOT NULL REFERENCES property(id),
  connection_id       bigint NOT NULL REFERENCES channel_connection(id),
  rate_plan_id        bigint NOT NULL REFERENCES rate_plan(id),
  external_rate_plan  text NOT NULL CHECK (char_length(external_rate_plan) BETWEEN 1 AND 100),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, rate_plan_id),
  UNIQUE (connection_id, external_rate_plan)
);
SELECT attach_audit('channel_rate_map');
ALTER TABLE channel_rate_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_rate_map FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON channel_rate_map USING (property_id = ANY (app_property_ids()));

-- ---------------------------------------------------------------------------
-- Abgeholte Buchungsstaende. Eine Revision, die zweimal kommt -- weil die
-- Bestaetigung beim Anbieter verloren ging --, wird nicht zweimal
-- verarbeitet, sondern nur noch einmal bestaetigt.
--
-- Bewusst ohne den Inhalt der Buchung: der traegt Gastdaten, und eine Kopie
-- hier muesste `guest_erase_one()` mitloeschen. Was daraus wurde, steht an
-- der Buchung selbst.
-- ---------------------------------------------------------------------------

CREATE TABLE channel_booking_revision (
  connection_id        bigint NOT NULL REFERENCES channel_connection(id),
  external_revision_id text NOT NULL CHECK (char_length(external_revision_id) <= 100),
  property_id          bigint NOT NULL REFERENCES property(id),
  external_reference   text NOT NULL CHECK (char_length(external_reference) <= 64),
  -- Was der Abgleich sagte (created, updated, kept_local, ...) oder im
  -- Probebetrieb, wie StayGrid zur Quelle steht (shadow_match,
  -- shadow_missing, shadow_differs).
  outcome              text NOT NULL CHECK (char_length(outcome) <= 40),
  acknowledged         boolean NOT NULL DEFAULT false,
  received_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_revision_id)
);
CREATE INDEX channel_booking_revision_property
  ON channel_booking_revision (property_id, received_at DESC);
ALTER TABLE channel_booking_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_booking_revision FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON channel_booking_revision
  USING (property_id = ANY (app_property_ids()));

-- ---------------------------------------------------------------------------
-- Kanalprotokoll: was gesendet und abgeholt wurde, je Lauf eine Zeile.
-- "Warum steht bei Booking.com etwas anderes" soll ohne Serverprotokoll zu
-- beantworten sein. Keine Gastdaten, nur Zahlen und Schluessel.
-- ---------------------------------------------------------------------------

CREATE TABLE channel_sync_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  connection_id bigint NOT NULL REFERENCES channel_connection(id),
  kind          text NOT NULL CHECK (kind IN ('availability','rates','bookings','full')),
  mode          text NOT NULL CHECK (mode IN ('shadow','active')),
  status        text NOT NULL CHECK (status IN ('ok','failed')),
  -- Gesendete Tage oder abgeholte Buchungsstaende.
  items         integer NOT NULL DEFAULT 0,
  -- Im Probebetrieb: wie viele Buchungen StayGrid anders kennt als die Quelle.
  differences   integer,
  error_key     text,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_sync_log_connection ON channel_sync_log (connection_id, finished_at DESC);
ALTER TABLE channel_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_sync_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON channel_sync_log USING (property_id = ANY (app_property_ids()));
