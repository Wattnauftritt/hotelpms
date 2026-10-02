-- ---------------------------------------------------------------------------
-- Inhalte fuer das Gaesteterminal: Seiten des Hauses, Bilder dazu und eine
-- Freigabeliste externer Adressen (Dokument 31, Abschnitt 11).
--
-- Anforderung des Nutzers: "Die Pollingseite auf dem Touchscreen-PC sollte
-- so allgemein gehalten sein, dass sie jede Seite und jedes Formular, das
-- wir dort anzeigen und oeffnen wollen, pollen und oeffnen kann ... von
-- Werbung ueber Formulare bis Unterschriften, Informationen etc."
--
-- Allgemein heisst hier nicht: beliebig. Ein Rezeptionsrechner, der jede
-- Adresse und jedes HTML auf einen Gastbildschirm schicken kann, ist ein
-- Werkzeug fuer Phishing und fuer eingeschleustes Skript. Deshalb drei
-- Dinge, die das Haus vorher pflegt und die Rezeption nur auswaehlt:
--
--   terminal_content        eine Seite: Titel, Text in einem einfachen
--                           Format (Absaetze, Aufzaehlung, fett -- kein
--                           HTML), wahlweise ein Bild. Hausordnung,
--                           WLAN, Speisekarte, Werbung.
--   terminal_content_image  das Bild dazu. Nur PNG, JPEG, WebP, hoechstens
--                           ein Megabyte, und **kein SVG**: ein SVG ist ein
--                           Dokument mit Skript, kein Bild.
--   terminal_url            eine freigegebene externe Seite (https), die
--                           das Terminal in einem abgeschotteten Rahmen
--                           zeigt. Eine Adresse aus dem Auftrag selbst gibt
--                           es nicht.
--
-- Die Diashow im Ruhezustand ist eine Reihenfolge von Seiten mit einer
-- Dauer je Seite (`idle_position`, `idle_seconds`).
--
-- **Bilder in der Datenbank.** Das System hat keinen Dateispeicher, und die
-- Belege (0024) liegen aus demselben Grund als bytea darin: Sicherung,
-- Zeilenrichtlinie und Mandantentrennung gelten dann ohne zweite Stelle.
-- Eine Seite hat hoechstens ein Bild von hoechstens einem Megabyte, und ein
-- Haus hat wenige Seiten; das ist eine Groesse, die die Datenbank traegt.
--
-- Diese Migration steht **vor** 0063 und haengt nicht von ihr ab: auf einer
-- frischen Datenbank laeuft sie zuerst. Die Verknuepfung mit den Auftraegen
-- folgt in 0067.
-- ---------------------------------------------------------------------------

CREATE TABLE terminal_content (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  title         text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  body          text NOT NULL DEFAULT '' CHECK (length(body) <= 5000),
  -- Platz in der Diashow des Ruhezustands und Dauer in Sekunden; beides
  -- leer heisst: nicht in der Diashow.
  idle_position smallint,
  idle_seconds  smallint CHECK (idle_seconds BETWEEN 3 AND 600),
  created_by    bigint REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Archiviert statt geloescht: ein Auftrag verweist darauf, und das
  -- Protokoll soll sagen koennen, was gezeigt wurde.
  archived_at   timestamptz,
  CONSTRAINT idle_complete CHECK ((idle_position IS NULL) = (idle_seconds IS NULL)),
  CONSTRAINT archived_not_idle CHECK (archived_at IS NULL OR idle_position IS NULL)
);
CREATE INDEX terminal_content_property ON terminal_content (property_id)
  WHERE archived_at IS NULL;

CREATE TABLE terminal_content_image (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  -- Ein Bild je Seite. Wer ein neues hochlaedt, ersetzt das alte.
  content_id  bigint NOT NULL UNIQUE REFERENCES terminal_content(id) ON DELETE CASCADE,
  public_ref  text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  -- Die Art steht hier, wie die Schnittstelle sie an den ersten Bytes
  -- erkannt hat -- nicht, wie der Hochladende sie angegeben hat.
  mime        text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes       bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terminal_url (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  public_ref  text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  -- Nur https: ein Gast tippt hier womoeglich etwas ein, und ohne TLS
  -- liest das jeder im Hotelnetz mit. Die genaue Pruefung (keine
  -- Zugangsdaten, keine inneren Adressen) macht die Schnittstelle.
  url         text NOT NULL CHECK (url LIKE 'https://%' AND length(url) <= 2000),
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE INDEX terminal_url_property ON terminal_url (property_id) WHERE removed_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['terminal_content', 'terminal_content_image', 'terminal_url'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('terminal_content');
SELECT attach_audit('terminal_content_image');
SELECT attach_audit('terminal_url');

-- Die Bilddaten gehoeren nicht ins Protokoll: ein Megabyte je Aenderung in
-- einer Tabelle ohne Frist, und gesagt ist damit nichts, was nicht schon
-- "Bild ersetzt" sagt.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('terminal_content_image', 'bytes', 'Bilddaten: gross, ohne Aussage fuer das Protokoll');
