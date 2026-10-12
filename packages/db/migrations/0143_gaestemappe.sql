-- ---------------------------------------------------------------------------
-- 0143 Digitale Gaestemappe, Bausteine 1 und 2: Hausinfos, WLAN, Zimmerkarte
--
-- Svens Wunsch vom 11.10.2026 (Plan: gaestemappe/plan.md im Projekt): ein
-- QR-Code im Zimmer oeffnet auf dem Telefon des Gastes die Mappe des Hauses
-- -- WLAN, Fruehstueck, Hausordnung. Handeln (Verzicht, Wuensche) kommt mit
-- der Freischaltung in einem spaeteren Schritt; hier steht nur, was ohnehin
-- auf der Karte im Zimmer liegt.
--
--   guest_folder_setting   je Haus: Mappe an/aus, das WLAN des Hauses
--   guest_folder_room      je Zimmer die Referenz im QR-Code
--   terminal_content       + folder_position: Seiten des Terminals in der Mappe
--
-- **Ein WLAN je Haus** (Sven, 11.10.2026), keine Ausnahme je Zimmer. Deshalb
-- an der Einstellung und nicht in einer eigenen Tabelle.
--
-- **Die Seiten sind die des Gaesteterminals** (0070). Zwei Pflegestellen fuer
-- dieselbe Fruehstueckszeit laufen auseinander, und dann steht am Terminal
-- 7 Uhr und auf dem Telefon 7:30.
-- ---------------------------------------------------------------------------

CREATE TABLE guest_folder_setting (
  property_id    bigint PRIMARY KEY REFERENCES property(id),
  -- Aus als Vorgabe: ein Haus soll nicht durch eine Auslieferung ploetzlich
  -- eine Seite fuer Gaeste haben, die es nie angesehen hat.
  enabled        boolean NOT NULL DEFAULT false,
  -- Netzname hoechstens 32 Byte (IEEE 802.11), Kennwort fuer WPA 8 bis 63
  -- Zeichen. Ein offenes Netz hat keins.
  wifi_ssid      text CHECK (wifi_ssid IS NULL OR octet_length(wifi_ssid) BETWEEN 1 AND 32),
  wifi_password  text CHECK (wifi_password IS NULL OR length(wifi_password) <= 63),
  wifi_security  text NOT NULL DEFAULT 'WPA' CHECK (wifi_security IN ('WPA','WEP','nopass')),
  wifi_hidden    boolean NOT NULL DEFAULT false,
  updated_by     bigint REFERENCES app_user(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wifi_password_passt CHECK (
    wifi_ssid IS NULL
    OR (wifi_security = 'nopass' AND wifi_password IS NULL)
    OR (wifi_security = 'WPA' AND length(wifi_password) BETWEEN 8 AND 63)
    OR (wifi_security = 'WEP' AND length(wifi_password) BETWEEN 5 AND 26))
);

-- Die Referenz im QR-Code. Zufaellig und nicht die Zimmernummer: sonst
-- zaehlte jeder die Mappen aller Zimmer durch, sobald er eine gesehen hat.
-- Neu erzeugbar, falls eine Karte fotografiert und weitergegeben wurde --
-- die alte Karte zeigt dann "unbekannt", nicht die Mappe.
CREATE TABLE guest_folder_room (
  resource_id   bigint PRIMARY KEY REFERENCES resource(id),
  property_id   bigint NOT NULL REFERENCES property(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(12),
  created_at    timestamptz NOT NULL DEFAULT now(),
  renewed_at    timestamptz,
  renewed_by    bigint REFERENCES app_user(id)
);
CREATE INDEX guest_folder_room_property ON guest_folder_room (property_id);

ALTER TABLE terminal_content ADD COLUMN folder_position smallint;
-- Eine archivierte Seite steht in keiner Mappe mehr, wie in keiner Diashow.
ALTER TABLE terminal_content ADD CONSTRAINT archived_not_folder
  CHECK (archived_at IS NULL OR folder_position IS NULL);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guest_folder_setting','guest_folder_room'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('guest_folder_setting');
SELECT attach_audit('guest_folder_room');

-- Das WLAN-Kennwort liegt ausgedruckt im Zimmer, ist aber trotzdem ein
-- Geheimnis des Hauses: im Protokoll stuende jede alte Fassung fuer immer.
-- Die Referenz oeffnet die Mappe eines Zimmers; nach dem Erneuern soll die
-- alte nicht im Protokoll nachzulesen sein.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('guest_folder_setting', 'wifi_password', 'WLAN-Kennwort des Hauses'),
  ('guest_folder_room', 'public_ref', 'Oeffnet die Gaestemappe eines Zimmers');

-- ---------------------------------------------------------------------------
-- Einloesen der Zimmer-Referenz
--
-- Wie checkin_token_open (0061) und aus demselben Grund SECURITY DEFINER:
-- die Seite des Gastes hat keinen Benutzer und damit keinen Kontext. Die
-- Funktion liest genau eine Zeile ueber die Referenz und setzt den Kontext
-- auf genau dieses Haus -- nur mit leerem Kontext, damit eine angemeldete
-- Sitzung ihren nicht ueber eine Referenz umbiegt.
--
-- Fuer eine unbekannte Referenz keine Zeile. Fuer eine bekannte der Zustand:
-- 'off', wenn das Haus die Mappe nicht anbietet, 'closed' fuer ein
-- stillgelegtes Zimmer, Haus oder Konto. Wer die Referenz kennt, hat die
-- Karte gesehen; ihm darf man sagen, dass es die Mappe gerade nicht gibt.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guest_folder_room_open(p_ref text)
RETURNS TABLE (
  out_property_id bigint, out_account_id bigint, out_resource_id bigint,
  out_business_date date, out_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r       record;
  v_bd    date;
  v_state text;
BEGIN
  IF cardinality(app_property_ids()) > 0 OR cardinality(app_account_ids()) > 0 THEN
    RAISE EXCEPTION 'guest_folder_room_open verlangt einen leeren Mandantenkontext'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT f.property_id, p.account_id, f.resource_id, p.timezone,
         p.status AS property_status, a.status AS account_status,
         res.active AS room_active, COALESCE(s.enabled, false) AS enabled
    INTO r
    FROM guest_folder_room f
    JOIN resource res ON res.id = f.resource_id
    JOIN property p   ON p.id = f.property_id
    JOIN account a    ON a.id = p.account_id
    LEFT JOIN guest_folder_setting s ON s.property_id = f.property_id
   WHERE f.public_ref = p_ref;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Der Geschaeftstag, nicht now(), wie ueberall; ohne offenen Tag der
  -- Kalendertag am Ort des Hauses.
  SELECT b.date INTO v_bd FROM business_day b
   WHERE b.property_id = r.property_id AND b.status = 'open'
   ORDER BY b.date DESC LIMIT 1;
  v_bd := COALESCE(v_bd, (now() AT TIME ZONE r.timezone)::date);

  v_state := CASE
    WHEN r.account_status <> 'active' OR r.property_status <> 'active'
      OR NOT r.room_active                     THEN 'closed'
    WHEN NOT r.enabled                         THEN 'off'
    ELSE 'valid'
  END;

  IF v_state = 'valid' THEN
    PERFORM set_config('app.account_ids',  r.account_id::text,  true),
            set_config('app.property_ids', r.property_id::text, true);
  END IF;

  out_property_id := r.property_id;
  out_account_id := r.account_id;
  out_resource_id := r.resource_id;
  out_business_date := v_bd;
  out_state := v_state;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION guest_folder_room_open(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION guest_folder_room_open(text) FROM hotelpms_readonly;
GRANT EXECUTE ON FUNCTION guest_folder_room_open(text) TO hotelpms_app;

COMMENT ON FUNCTION guest_folder_room_open(text) IS
  'Loest die Zimmer-Referenz der Gaestemappe ein und setzt den Kontext auf '
  'genau dieses Haus. Nur mit leerem Kontext aufrufbar.';
