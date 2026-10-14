-- ---------------------------------------------------------------------------
-- 0168 -- Den Stripe-Zugang der Plattform im Adminpanel eintragen.
--
-- Anforderung von Sven, 14.10.2026: der Zugang zu Stripe Connect (0167) stand
-- nur in der Umgebungsdatei der Maschine, und wer die Plattform betreibt, hat
-- nicht zwingend ein Terminal. Ohne Terminal liesse sich der Zahlungslink
-- nie einschalten.
--
-- Eine Zeile, die Plattform hat genau einen Zugang. Steht der Schluessel in
-- der Umgebungsdatei, gilt der; diese Zeile ist der Weg ohne Terminal.
--
-- Die beiden Geheimnisse liegen verschluesselt (AES-256-GCM, Schluessel aus
-- ID_DOCUMENT_KEY abgeleitet, anderer Zweck, anderer Salt). Ein Abzug der
-- Datenbank allein gibt damit keinen Zugang zum Stripe-Konto. Ohne
-- Zeilenrichtlinie: sie gehoert keinem Mandanten, und der Webhook liest sie
-- ohne Sitzung. Die Anwendungsrolle darf schreiben, ein Recht
-- (`platform:billing`) entscheidet in der Route.
-- ---------------------------------------------------------------------------

CREATE TABLE platform_payment_provider (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider           text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  -- Kennung der Plattform bei Connect (ca_...). Nicht geheim.
  connect_client_id  text,
  secret_key_enc     bytea,
  -- Anfang und die letzten vier Zeichen, damit das Panel zeigen kann,
  -- welcher Schluessel eingetragen ist, ohne ihn herzugeben.
  secret_key_hint    text,
  webhook_secret_enc bytea,
  updated_by         bigint REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

SELECT attach_audit('platform_payment_provider');

-- Auch verschluesselt nicht ins Protokoll (CLAUDE.md, Migration 0044): das
-- Protokoll ist unveraenderlich, und ein spaeter Schluesselwechsel bekaeme
-- die alten Chiffrate dort nie wieder heraus.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('platform_payment_provider', 'secret_key_enc',     'Geheimnis'),
  ('platform_payment_provider', 'webhook_secret_enc', 'Geheimnis');
