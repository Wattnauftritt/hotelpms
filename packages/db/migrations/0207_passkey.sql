-- ---------------------------------------------------------------------------
-- 0207 -- Anmelden mit Passkey (WebAuthn).
--
-- Anlass: Sven, 23.10.2026 -- „integriere die Moeglichkeit Passkeys zu
-- nutzen". Die Bedrohungsanalyse vom selben Tag (security/
-- bedrohungsanalyse-2026-10-23.md) fand keinen zweiten Faktor, nirgends;
-- ein Passkey mit Pruefung des Benutzers (Fingerabdruck, Gesicht, Geraete-
-- PIN) ist Besitz und Wissen oder Koerper in einem Schritt und laesst sich
-- nicht auf eine nachgebaute Anmeldeseite locken: er ist an die Domain
-- gebunden.
--
-- **Gespeichert wird nur der oeffentliche Schluessel.** Der private bleibt im
-- Geraet bzw. im Schluesselbund des Betriebssystems. Wer diese Tabelle
-- liest, kann sich damit nicht anmelden; sie ist deshalb kein Geheimnis wie
-- `password_hash`. Auf die Redaktionsliste kommt nur die Bezeichnung, weil
-- sie frei getippt wird und dort erfahrungsgemaess ein Name steht
-- („Svens iPhone").
--
-- **Keine Zeilenrichtlinie**, wie `login_failure` und `auth_token`: ein
-- Passkey gehoert einem Benutzer, nicht einem Mandanten, und die Anmeldung
-- liest ihn, bevor es einen Kontext gibt. Die Routen fragen immer mit der
-- eigenen Benutzerkennung aus der Sitzung.
-- ---------------------------------------------------------------------------

CREATE TABLE user_passkey (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- Kennung des Schluessels, wie der Browser sie liefert (base64url). Ueber
  -- alle Benutzer eindeutig: dasselbe Schluesselpaar an zwei Zugaengen
  -- liesse offen, als wer sich jemand anmeldet.
  credential_id text        NOT NULL UNIQUE,
  public_key    bytea       NOT NULL,
  -- Signaturzaehler. Viele Passkeys, die zwischen Geraeten synchronisiert
  -- werden, melden immer 0; dann prueft die Bibliothek nichts. Ein Zaehler,
  -- der zurueckspringt, verraet einen geklonten Schluessel.
  sign_count    bigint      NOT NULL DEFAULT 0,
  transports    text[]      NOT NULL DEFAULT '{}',
  -- Synchronisiert (iCloud, Google) oder an ein Geraet gebunden. Nur zur
  -- Anzeige: die Leitung soll sehen koennen, ob ein Passkey das Telefon
  -- verlassen kann.
  backed_up     boolean     NOT NULL DEFAULT false,
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX user_passkey_user ON user_passkey (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_passkey TO hotelpms_app;

-- Anlegen und Entfernen gehoeren ins Protokoll: ein fremder Passkey an einem
-- Konto ist genau das, was man spaeter nachweisen koennen will. Das
-- Fortschreiben von Zaehler und letzter Benutzung bei jeder Anmeldung nicht
-- -- es wuerde das Protokoll mit einer Zeile je Anmeldung fuellen und sagt
-- nichts, was `user_session` nicht schon sagt.
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE ON user_passkey
  FOR EACH ROW EXECUTE FUNCTION audit_trigger();

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('user_passkey', 'name', 'Freitext, enthaelt oft einen Namen');

-- ---------------------------------------------------------------------------
-- Die Herausforderung, die der Schluessel unterschreibt.
--
-- Einmal verwendbar und fuenf Minuten gueltig. Einmal, weil eine
-- mitgeschnittene Antwort sonst ein zweites Mal traegt; die Bibliothek
-- prueft nur, ob die Herausforderung passt, nicht, ob sie schon benutzt
-- wurde. Deshalb wird sie beim Einloesen in derselben Anweisung geloescht,
-- in der sie gelesen wird.
--
-- Beim Anlegen gehoert sie einem Benutzer **und** einer Sitzung: wer im
-- eigenen Konto einen Passkey anlegt, hat dafuer sein Kennwort gezeigt, und
-- die Bestaetigung soll nicht aus einer anderen Sitzung heraus gelingen.
-- Bei der Anmeldung gehoert sie niemandem -- wer sich anmeldet, ist noch
-- nicht bekannt, der Passkey sagt es erst.
-- ---------------------------------------------------------------------------

CREATE TABLE webauthn_challenge (
  id          text        PRIMARY KEY,
  purpose     text        NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge   text        NOT NULL,
  user_id     bigint      REFERENCES app_user(id) ON DELETE CASCADE,
  session_id  text,
  expires_at  timestamptz NOT NULL,
  CHECK ((purpose = 'register') = (user_id IS NOT NULL))
);

CREATE INDEX webauthn_challenge_ablauf ON webauthn_challenge (expires_at);

GRANT SELECT, INSERT, DELETE ON webauthn_challenge TO hotelpms_app;

-- Der Hinweis an die eigene Adresse, dass ein Passkey dazugekommen ist. Ohne
-- Link, wie der Hinweis bei der Adressaenderung (0053).
ALTER TABLE platform_email DROP CONSTRAINT platform_email_kind_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_kind_check
  CHECK (kind IN ('invite', 'password_reset', 'support_request',
                  'domain_request', 'email_change', 'email_change_notice',
                  'passkey_added'));
