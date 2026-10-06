-- ---------------------------------------------------------------------------
-- 0095 -- Kassenbuch.
--
-- Anforderung: Sven, 06.10.2026 ("Wir integrieren das Kassenbuch"). Das
-- Adminpanel fuehrt seit April 2026 ein Kassenbuch fuer die Barkasse; es
-- zieht schrittweise nach StayGrid um. Dokument 09 hatte ein Kassenbuch
-- ausgeschlossen und ist mit dieser Migration ueberarbeitet: das Kassenbuch
-- ist ein Modul, je Haus einzuschalten, standardmaessig aus. Es zeichnet
-- Bargeld auf, das anderswo angenommen wurde; es oeffnet keine Lade, gibt
-- keinen Bon aus und braucht keine TSE.
--
-- Was hier anders ist als im Adminpanel, und warum:
--
--   * Geld in Cent. Das Adminpanel rechnet mit Dezimal und PHP-float.
--   * Unveraenderlich (Haertegrad 1). Im Adminpanel ist Storno ein Merker,
--     und solange nichts an DATEV ging, laesst sich eine Zeile hart
--     loeschen -- ohne Spur. Ein Kassenbuch, in dem Zeilen still
--     verschwinden koennen, ist bei einer Pruefung keines. Hier ist eine
--     Korrektur eine Gegenbuchung (`reverses_id`), wie bei `charge`.
--   * Lueckenlose Nummer je Haus (`entry_no`), vergeben in der Datenbank.
--     Das Adminpanel nimmt die Auto-Increment-ID, die durch Loeschen Luecken
--     bekommt.
--   * Je Haus. Das Adminpanel kennt eine Kasse ohne Haus.
--   * Belege in der Datenbank wie die Rechnungsbelege (0024): sie erben
--     Zeilenrichtlinie, Sicherung und Frist. Im Adminpanel liegen sie im
--     Dateisystem und sind (vermutlich) in keiner Datenbanksicherung.
--
-- Uebernahme aus dem Adminpanel: `external_system`/`external_reference`
-- tragen die dortige ID, `external_number` die Belegnummer `KB-{id}`, unter
-- der der Steuerberater die Zeile aus DATEV kennt.
--
-- Datenschutz: `guest_name` und `text` koennen einen Gast benennen. Das
-- Kassenbuch ist ein Handelsbuch (§ 147 Abs. 1 Nr. 1 AO, zehn Jahre); die
-- Gastloeschung (`guest_erase_one`) fasst es deshalb nicht an, so wenig wie
-- eine Rechnung. Ein Verweis auf `guest` gibt es bewusst nicht: der Name ist
-- Buchungstext, kein Profil. Ins Protokoll gehoert er nicht.
-- ---------------------------------------------------------------------------

CREATE TABLE cashbook_setting (
  property_id               bigint PRIMARY KEY REFERENCES property(id),
  -- Aus, bis das Haus es einschaltet: ein Kassenbuch ist eine Aufzeichnung
  -- mit Pflichten, und kein Haus soll eines fuehren, weil es da war.
  enabled                   boolean NOT NULL DEFAULT false,
  -- Der Startwert der Lade. Buchungen vor diesem Tag zaehlen fuer den
  -- Bestand nicht -- dieselbe Regel wie im Adminpanel, sonst stimmte nach
  -- der Uebernahme der Saldo nicht mit dem dortigen ueberein.
  opening_balance_cent      bigint NOT NULL DEFAULT 0,
  opening_date              date,
  -- Fruehstuecksaufteilung einer Gastbuchung: Preis je Person brutto, davon
  -- Speisen (7 %) in Basispunkten, der Rest Getraenke (19 %).
  breakfast_price_cent      integer NOT NULL DEFAULT 550
                              CHECK (breakfast_price_cent BETWEEN 0 AND 100000),
  breakfast_food_share_bp   integer NOT NULL DEFAULT 7000
                              CHECK (breakfast_food_share_bp BETWEEN 0 AND 10000),
  -- Konten fuer den DATEV-Export, SKR04 als Vorgabe wie im Adminpanel.
  chart_of_accounts         text NOT NULL DEFAULT 'SKR04'
                              CHECK (chart_of_accounts IN ('SKR03', 'SKR04')),
  account_lodging           text NOT NULL DEFAULT '4300',
  account_breakfast_food    text NOT NULL DEFAULT '4300',
  account_breakfast_drinks  text NOT NULL DEFAULT '4400',
  account_city_tax          text NOT NULL DEFAULT '4300',
  account_cash_in           text NOT NULL DEFAULT '1600',
  account_bank_deposit      text NOT NULL DEFAULT '1200',
  account_expense           text NOT NULL DEFAULT '6980',
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cashbook_accounts CHECK (
    account_lodging ~ '^[0-9]{4,8}$' AND account_breakfast_food ~ '^[0-9]{4,8}$'
    AND account_breakfast_drinks ~ '^[0-9]{4,8}$' AND account_city_tax ~ '^[0-9]{4,8}$'
    AND account_cash_in ~ '^[0-9]{4,8}$' AND account_bank_deposit ~ '^[0-9]{4,8}$'
    AND account_expense ~ '^[0-9]{4,8}$')
);

CREATE TABLE cashbook_counter (
  property_id bigint PRIMARY KEY REFERENCES property(id),
  last_no     bigint NOT NULL DEFAULT 0
);

CREATE TABLE cashbook_entry (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id       bigint NOT NULL REFERENCES property(id),
  -- Vergibt der Trigger unten. Eine Nummer, die die Anwendung vorschlaegt,
  -- waere eine, die zwei gleichzeitige Buchungen doppelt vorschlagen.
  entry_no          bigint NOT NULL,
  business_date     date   NOT NULL,
  -- lodging, breakfast_food, breakfast_drinks, city_tax: Einnahmen einer
  --   Gastbuchung (oder einzeln, Kurtaxe).
  -- cash_in: Bareinlage. bank_deposit: Geld zur Bank. expense: Barausgabe.
  -- other: frei, mit Vorzeichen.
  -- legacy_guest: Altdaten des Adminpanels (Typ "gast"), eine Zeile mit
  --   Gesamtpreis; die Aufteilung steht in `legacy_split`.
  kind              text   NOT NULL CHECK (kind IN (
                      'lodging', 'breakfast_food', 'breakfast_drinks', 'city_tax',
                      'cash_in', 'bank_deposit', 'expense', 'other', 'legacy_guest')),
  -- Was die Lade gewinnt (+) oder verliert (-). Im Adminpanel steht eine
  -- Bankeinzahlung positiv und wird beim Summieren umgedreht; hier traegt
  -- jede Zeile ihr Vorzeichen selbst, damit eine Summe eine Summe ist.
  amount_cent       bigint NOT NULL,
  -- Steuersatz in Basispunkten: 0, 7 % oder 19 %.
  tax_rate_bp       integer NOT NULL CHECK (tax_rate_bp IN (0, 700, 1900)),
  text              text CHECK (text IS NULL OR length(text) <= 255),
  guest_name        text CHECK (guest_name IS NULL OR length(guest_name) <= 100),
  -- Die Zeilen einer Gastbuchung zeigen auf die erste. Die erste zeigt auf
  -- sich selbst nicht; sie ist an `group_id IS NULL` und Mitgliedern, die
  -- auf sie zeigen, zu erkennen.
  group_id          bigint REFERENCES cashbook_entry(id),
  reverses_id       bigint UNIQUE REFERENCES cashbook_entry(id),
  legacy_split      jsonb,
  external_system   text,
  external_reference text,
  external_number   text,
  created_by        bigint REFERENCES app_user(id),
  -- Bei Altdaten der Name aus dem Adminpanel, das nur Namen speichert.
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Bei Altdaten: wann im Adminpanel gebucht wurde.
  origin_created_at timestamptz,
  CONSTRAINT cashbook_entry_no UNIQUE (property_id, entry_no),
  CONSTRAINT cashbook_external_pair
    CHECK ((external_system IS NULL) = (external_reference IS NULL)),
  CONSTRAINT cashbook_legacy_split
    CHECK ((kind = 'legacy_guest') = (legacy_split IS NOT NULL) OR reverses_id IS NOT NULL)
);
CREATE UNIQUE INDEX cashbook_external ON cashbook_entry
  (property_id, external_system, external_reference)
  WHERE external_system IS NOT NULL AND reverses_id IS NULL;
-- Die Monatsliste und der Bestand bis zu einem Tag lesen ueber diesen Index;
-- `amount_cent` liegt mit darin, damit der Startsaldo ohne Tabellenzugriff
-- summiert (Index-Only-Scan).
CREATE INDEX cashbook_entry_day ON cashbook_entry
  (property_id, business_date, entry_no) INCLUDE (amount_cent);
CREATE INDEX cashbook_entry_group ON cashbook_entry (group_id) WHERE group_id IS NOT NULL;

CREATE OR REPLACE FUNCTION cashbook_assign_no() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Sperrt die Zeile des Hauses bis zum Ende der Transaktion. Rollt sie
  -- zurueck, rollt die Nummer mit: lueckenlos, ohne Sequenz.
  INSERT INTO cashbook_counter (property_id, last_no) VALUES (NEW.property_id, 1)
  ON CONFLICT (property_id) DO UPDATE SET last_no = cashbook_counter.last_no + 1
  RETURNING last_no INTO NEW.entry_no;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_cashbook_no BEFORE INSERT ON cashbook_entry
  FOR EACH ROW EXECUTE FUNCTION cashbook_assign_no();

-- Belege. Ein Eintrag kann mehrere haben (mehrere Fotos, ein PDF und ein
-- Foto). Bei einer Gastbuchung haengen sie an der ersten Zeile.
CREATE TABLE cashbook_receipt (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  entry_id      bigint NOT NULL REFERENCES cashbook_entry(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  -- An den Bytes erkannt, nicht aus der Angabe des Hochladenden.
  mime          text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
  bytes         bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 10485760),
  byte_count    integer NOT NULL,
  sha256        text NOT NULL,
  -- Bei Altdaten der Pfad im Adminpanel, damit sich jede Datei dort
  -- wiederfinden laesst.
  original_name text CHECK (original_name IS NULL OR length(original_name) <= 255),
  created_by    bigint REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cashbook_receipt_entry ON cashbook_receipt (entry_id);
CREATE UNIQUE INDEX cashbook_receipt_hash ON cashbook_receipt (entry_id, sha256);

-- An DATEV uebergeben. Eine eigene Zeile, weil der Eintrag unveraenderlich
-- ist; und ein Merker aus dem Adminpanel kommt hier ebenso an.
CREATE TABLE cashbook_datev_mark (
  entry_id    bigint PRIMARY KEY REFERENCES cashbook_entry(id),
  property_id bigint NOT NULL REFERENCES property(id),
  source      text NOT NULL CHECK (source IN ('staygrid', 'import')),
  marked_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cashbook_setting', 'cashbook_counter', 'cashbook_entry',
                           'cashbook_receipt', 'cashbook_datev_mark'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT make_append_only('cashbook_entry');
SELECT make_append_only('cashbook_receipt');
SELECT make_append_only('cashbook_datev_mark');

SELECT attach_audit('cashbook_setting');
SELECT attach_audit('cashbook_entry');
SELECT attach_audit('cashbook_receipt');

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('cashbook_entry', 'guest_name', 'Name eines Gastes'),
  ('cashbook_entry', 'text', 'Buchungstext, nennt im Adminpanel den Gast'),
  ('cashbook_entry', 'created_by_name', 'Name einer Mitarbeiterin aus dem Umsystem'),
  ('cashbook_entry', 'external_reference', 'Verweis auf die Zeile im Umsystem'),
  ('cashbook_receipt', 'bytes', 'Belegdatei: gross, ohne Aussage fuer das Protokoll'),
  ('cashbook_receipt', 'original_name', 'Dateiname im Umsystem')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Rechte. Lesen und Buchen getrennt vom Stornieren: wer an der Rezeption
-- bucht, soll eine Buchung anderer nicht still aus dem Bestand nehmen.
-- Der Export geht ans Steuerbuero und kommt nicht zurueck. Die Uebernahme
-- ist fuer Maschinenzugaenge und keiner Rolle zugeordnet.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, grp, description) VALUES
  ('cashbook:read',   'Kassenbuch', 'Kassenbuch und Bestand sehen, Belege oeffnen'),
  ('cashbook:write',  'Kassenbuch', 'Einnahmen, Ausgaben und Belege erfassen'),
  ('cashbook:void',   'Kassenbuch', 'Buchungen stornieren (Gegenbuchung)'),
  ('cashbook:export', 'Kassenbuch', 'DATEV-Export, Einstellungen des Kassenbuchs'),
  ('cashbook:import', 'Kassenbuch', 'Kassenbuch aus einem Umsystem uebernehmen')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, k.key
  FROM role r
  JOIN (VALUES
    ('owner', 'cashbook:read'), ('owner', 'cashbook:write'),
    ('owner', 'cashbook:void'), ('owner', 'cashbook:export'),
    ('account_admin', 'cashbook:read'), ('account_admin', 'cashbook:write'),
    ('account_admin', 'cashbook:void'), ('account_admin', 'cashbook:export'),
    ('hotel_director', 'cashbook:read'), ('hotel_director', 'cashbook:write'),
    ('hotel_director', 'cashbook:void'), ('hotel_director', 'cashbook:export'),
    ('front_office_mgr', 'cashbook:read'), ('front_office_mgr', 'cashbook:write'),
    ('front_office_mgr', 'cashbook:void'),
    ('reception', 'cashbook:read'), ('reception', 'cashbook:write'),
    ('accounting', 'cashbook:read'), ('accounting', 'cashbook:export'),
    ('tax_advisor', 'cashbook:read')
  ) AS k(role_key, key) ON k.role_key = r.key
 WHERE r.account_id IS NULL
ON CONFLICT DO NOTHING;
