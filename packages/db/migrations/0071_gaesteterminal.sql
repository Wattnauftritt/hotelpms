-- ---------------------------------------------------------------------------
-- Gaesteterminal: ein Touchscreen an der Rezeption, an dem ein Gast den
-- Meldeschein unterschreibt (Dokument 31).
--
-- Anforderung. Die Haeuser haben heute einen zweiten Rechner mit
-- Touchscreen neben dem Tresen; die Rezeption klickt, und dort oeffnet sich
-- das Formular. Am Touchscreen steht ein **Gast**. Eine Mitarbeitersitzung
-- darf dort nicht liegen -- sie oeffnete ihm das ganze Haus, sobald er die
-- Adresszeile anfasst.
--
-- Deshalb ein **Geraet** statt einer Sitzung: es wird einmal mit einem
-- kurzlebigen Code gekoppelt und weist sich danach mit einem eigenen,
-- langlebigen Geheimnis aus. Es gehoert genau einem Haus, darf nur seinen
-- eigenen Auftrag lesen und genau die Gasthandlung dieses Auftrags
-- ausfuehren.
--
-- Das Recht `terminal:device` steht im Katalog, weil `registerRoute` nur
-- Rechte aus dem Katalog kennt -- es gibt keinen zweiten Rechteweg, und
-- eine Geraeteroute wird damit vom selben Test ueber die ganze Routenliste
-- erfasst wie jede andere. Es ist **keiner Rolle** zugeordnet und als
-- Zugriffsbereich eines Maschinenzugangs ausgeschlossen (routes/oauth.ts):
-- die einzige Quelle ist ein gekoppeltes Geraet.
--
-- **Zur Nummer.** Geschrieben als 0063, umbenannt, weil 0068 (dauerhafter
-- Zahlungslink) zuerst auf main kam. Der Migrator wendet die Dateien in der
-- Reihenfolge ihrer Namen an und uebernimmt, was fehlt: als 0063 liefe sie
-- auf einer frischen Datenbank vor 0068, auf einer bestehenden danach. Jetzt
-- laeuft sie ueberall nach 0070 und vor 0072 und 0073.
-- ---------------------------------------------------------------------------

INSERT INTO permission (key, grp, description) VALUES
  ('terminal:device', 'Geraet',
   'Nur gekoppelte Gaesteterminals: eigenen Auftrag lesen und ausfuehren. Keiner Rolle zuweisbar');

-- ---------------------------------------------------------------------------
-- Das Geraet.
--
-- Kopplungscode und Geheimnis liegen nur als SHA-256. Beide sind zufaellig
-- und nicht von einem Menschen gewaehlt; eine langsame Ableitung braeuchte
-- es nur fuer ratbare Werte (dieselbe Abwaegung wie beim Maschinentoken,
-- platform/auth.ts). Beide stehen in `audit_redaction`: das Protokoll hat
-- weder Frist noch Zeilenrichtlinie, und ein Geheimnis gehoert nicht hinein.
--
-- Kein `account_id`: das Haus bestimmt den Mandanten, und eine zweite
-- Spalte, die dasselbe sagt, kann eines Tages etwas anderes sagen.
-- ---------------------------------------------------------------------------

CREATE TABLE terminal_device (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  public_ref         text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  pairing_code_hash  bytea UNIQUE,
  pairing_expires_at timestamptz,
  secret_hash        bytea UNIQUE,
  paired_at          timestamptz,
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_by         bigint REFERENCES app_user(id),
  CONSTRAINT pairing_has_expiry
    CHECK (pairing_code_hash IS NULL OR pairing_expires_at IS NOT NULL),
  -- Ein widerrufenes Geraet traegt kein Geheimnis und keinen Code mehr.
  -- Nicht nur, weil sie wirkungslos sind: was nicht mehr da ist, kann
  -- auch aus keiner Sicherung zurueckkommen.
  CONSTRAINT revoked_without_secret
    CHECK (revoked_at IS NULL OR (secret_hash IS NULL AND pairing_code_hash IS NULL))
);
CREATE INDEX terminal_device_property ON terminal_device (property_id)
  WHERE revoked_at IS NULL;

/*
 * Wann ein Geraet zuletzt gefragt hat -- in einer eigenen Tabelle.
 *
 * Ein Terminal fragt alle zwei Sekunden. Stuende der Zeitpunkt am Geraet,
 * schriebe der Audit-Trigger bei jeder Fortschreibung eine Zeile ins
 * Protokoll: tausende am Tag je Geraet, ohne dass darin etwas geschehen
 * waere. Diese Tabelle hat deshalb bewusst keinen Audit-Trigger.
 */
CREATE TABLE terminal_device_seen (
  device_id    bigint PRIMARY KEY REFERENCES terminal_device(id),
  property_id  bigint NOT NULL REFERENCES property(id),
  last_seen_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- Der Auftrag an ein Geraet.
--
-- Eine Art ist ein Eintrag hier und einer in der Tabelle der Arten im Code
-- (platform/terminalArten.ts) -- dazu eine Ansicht am Terminal. Hier stehen
-- die beiden des Meldescheins; 0073 fuegt Hausbedingung, Seite und Adresse
-- hinzu und bindet `registration_fill` an den Online-Check-in an.
--
-- Kein Gastbezug ausser ueber Reservierung und Meldeschein. Ein Auftrag
-- traegt keinen personenbezogenen Wert und muss deshalb in der Loeschung
-- (`guest_erase_one`) nicht vorkommen. Der Meldeschein wird nach einem
-- Jahr vernichtet; der Verweis darauf faellt dann auf NULL, statt die
-- Vernichtung aufzuhalten.
--
-- Zustaende: pending -> opened -> done | canceled | expired. Ein Auftrag,
-- dessen Frist abgelaufen ist, gilt als abgelaufen, auch wenn ihn noch
-- niemand umgeschrieben hat: das Terminal fragt ihn ueber dieselbe
-- Bedingung ab, und der naechste Auftrag an dasselbe Geraet raeumt ihn
-- weg. Ein Nachtlauf fuer drei Minuten alte Zeilen waere Aufwand ohne
-- Gegenwert.
-- ---------------------------------------------------------------------------

CREATE TABLE terminal_job (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     bigint NOT NULL REFERENCES property(id),
  device_id       bigint NOT NULL REFERENCES terminal_device(id),
  public_ref      text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  kind            text NOT NULL
                  CHECK (kind IN ('registration_sign', 'registration_fill')),
  reservation_id  bigint REFERENCES reservation(id),
  registration_id bigint REFERENCES registration(id) ON DELETE SET NULL,
  state           text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'opened', 'done', 'canceled', 'expired')),
  canceled_by     text CHECK (canceled_by IN ('reception', 'terminal', 'timeout', 'revoked')),
  created_by      bigint REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  opened_at       timestamptz,
  finished_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  CONSTRAINT canceled_has_reason
    CHECK ((state = 'canceled') = (canceled_by IS NOT NULL))
);

-- Hoechstens ein offener Auftrag je Geraet. Am Touchscreen steht ein Gast;
-- zwei Auftraege hiessen, dass der zweite Gast die Daten des ersten sieht.
-- Zugleich der Index, ueber den das Terminal alle zwei Sekunden fragt.
CREATE UNIQUE INDEX terminal_job_one_open ON terminal_job (device_id)
  WHERE state IN ('pending', 'opened');
CREATE INDEX terminal_job_reservation ON terminal_job (reservation_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['terminal_device', 'terminal_device_seen', 'terminal_job'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('terminal_device');
SELECT attach_audit('terminal_job');

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('terminal_device', 'secret_hash',       'Geheimnis'),
  ('terminal_device', 'pairing_code_hash', 'Geheimnis');

-- ---------------------------------------------------------------------------
-- Aufloesung und Kopplung.
--
-- Ueber SECURITY-DEFINER-Funktionen, weil das Haus erst aus dem Geheimnis
-- folgt und die Tabelle eine Zeilenrichtlinie traegt -- dieselbe Lage wie
-- beim Maschinentoken (0025) und beim Zugriffsbereich (0018). Ohne Kontext
-- zu lesen haette hier still nichts geliefert.
--
-- Ein gesperrter Kunde und ein stillgelegtes Haus nehmen ihre Terminals
-- mit: dieselbe Bedingung wie in `user_property_scope`.
-- ---------------------------------------------------------------------------

/*
 * Geraet aus dem Geheimnis. Schreibt den Zeitpunkt der letzten Frage mit,
 * hoechstens alle zwanzig Sekunden: das Terminal fragt alle zwei, und fuer
 * "ist es erreichbar" genuegt eine Aufloesung auf Viertelminuten.
 */
CREATE OR REPLACE FUNCTION terminal_device_principal(p_secret_hash bytea)
RETURNS TABLE (device_id bigint, device_ref text, property_id bigint, account_id bigint)
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
  SELECT g.id, g.public_ref, g.property_id, g.account_id FROM gefunden g;
$$;

/*
 * Einen Code einloesen. Genau einmal: der Code faellt in derselben
 * Anweisung, in der das Geheimnis entsteht, und zwei gleichzeitige
 * Einloesungen treffen dieselbe Zeile -- nur eine findet sie noch.
 */
CREATE OR REPLACE FUNCTION terminal_device_pair(p_code_hash bytea, p_secret_hash bytea)
RETURNS TABLE (device_ref text, device_name text, property_name text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE terminal_device d
     SET secret_hash = p_secret_hash, paired_at = now(),
         pairing_code_hash = NULL, pairing_expires_at = NULL
    FROM property p, account a
   WHERE d.pairing_code_hash = p_code_hash
     AND d.pairing_expires_at > now()
     AND d.revoked_at IS NULL
     AND p.id = d.property_id AND a.id = p.account_id
     AND p.status = 'active' AND a.status = 'active'
  RETURNING d.public_ref, d.name, p.name;
$$;

-- Die Leserolle bekaeme sie ueber die Standardrechte aus 0001 mit. Eine
-- Funktion, die ein Geraet koppelt, ist aber ein Schreibweg.
REVOKE ALL ON FUNCTION terminal_device_principal(bytea) FROM PUBLIC, hotelpms_readonly;
REVOKE ALL ON FUNCTION terminal_device_pair(bytea, bytea) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION terminal_device_principal(bytea) TO hotelpms_app;
GRANT EXECUTE ON FUNCTION terminal_device_pair(bytea, bytea) TO hotelpms_app;
