-- ---------------------------------------------------------------------------
-- 0061 -- Online-Check-in: Meldeschein vorab per Link, am Terminal vor Ort.
--
-- Anforderung aus dem Betrieb: Gaeste bekommen das Meldeformular vorab per
-- Mail; wer es nicht ausfuellt, tut es vor Ort an einem Touchscreen. Beides
-- soll StayGrid uebernehmen. Begruendungen und Rechtslage in Dokument 30.
--
-- Was hier entsteht:
--
--   checkin_token            Ein Link je Ausgabe, in der Datenbank nur als
--                            Hash, befristet bis spaetestens Abreisetag,
--                            widerrufbar. Kanal 'mail' (Vorab-Erfassung,
--                            ohne Unterschrift) oder 'terminal' (vor Ort).
--   property_checkin_setting Ob und wie viele Tage vor Anreise der Link
--                            automatisch hinausgeht. Aus, bis jemand ihn
--                            bewusst einschaltet.
--   registration.source      Wo der Meldeschein entstand: Tresen, online,
--                            Terminal. Die Rezeption sieht "ausgefuellt am".
--   registration.signature_required
--                            Ob dieser Schein eine Unterschrift braucht.
--                            Bisher hiess das "is_foreign" -- und das reicht
--                            nicht mehr, seit eine Unterschrift auch erst am
--                            Anreisetag kommen darf (siehe unten).
--
-- **Warum die Unterschrift nicht im Mailweg geleistet wird.** § 29 Abs. 2
-- BMG verlangt sie "am Tag der Ankunft", und zwar handschriftlich. Ein Link
-- drei Tage vor Anreise erfuellt das erste nicht, und eine mit dem Finger
-- auf dem eigenen Telefon gezogene Linie ist nicht eines der Verfahren aus
-- Absatz 5, die die Unterschrift ersetzen duerfen. Vorab erfasst wird
-- deshalb alles **ausser** der Unterschrift; sie folgt am Anreisetag am
-- Terminal oder am Tresen. Der Schein steht bis dahin mit
-- signature_required = true und signed_at IS NULL da, und genau diesen
-- Zustand zeigt die Rezeption an.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------- Einstellung

CREATE TABLE property_checkin_setting (
  property_id  bigint PRIMARY KEY REFERENCES property(id),
  -- Aus als Vorgabe, aus demselben Grund wie beim Gastversand (0028): ein
  -- Haus soll nicht durch eine Auslieferung ploetzlich Gaeste anschreiben.
  enabled      boolean NOT NULL DEFAULT false,
  -- Drei Tage: frueh genug, dass der Gast es zu Hause erledigt, spaet genug,
  -- dass die Buchung nicht mehr wackelt. Mehr als vierzehn fuehrt nur dazu,
  -- dass der Link in einem Postfach liegt, bis er vergessen ist.
  days_before  smallint NOT NULL DEFAULT 3 CHECK (days_before BETWEEN 1 AND 14),
  updated_by   bigint REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE property_checkin_setting IS
  'Automatischer Versand des Online-Check-in-Links vor Anreise, je Haus.';

ALTER TABLE property_checkin_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_checkin_setting FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON property_checkin_setting
  USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('property_checkin_setting');

-- --------------------------------------------------------------------- Token

CREATE TABLE checkin_token (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  reservation_id bigint NOT NULL REFERENCES reservation(id),
  /*
   * SHA-256 des Tokens, nie das Token. Dieselbe Bauart wie auth_token
   * (0030): wer eine Sicherung liest, bekommt damit keinen Zugang zu einem
   * Meldeschein. 256 Bit Zufall brauchen keinen teuren Hash.
   */
  token_hash     text NOT NULL UNIQUE,
  /*
   * mail     Vorab-Erfassung ueber einen Link, auch vom Tresen kopiert.
   *          Nimmt keine Unterschrift an (§ 29 Abs. 2 BMG: am Tag der
   *          Ankunft).
   * terminal Vor Ort, ausgegeben von der Station im Haus. Nimmt die
   *          Unterschrift an, wenn der Geschaeftstag die Anreise erreicht hat.
   */
  channel        text NOT NULL CHECK (channel IN ('mail','terminal')),
  -- Ein Kalendertag, kein Zeitpunkt: geprueft wird gegen den Geschaeftstag
  -- des Hauses, nicht gegen now(). Spaetestens der Abreisetag -- danach gibt
  -- es keinen Meldeschein mehr zu erfassen.
  expires_on     date NOT NULL,
  -- Leer heisst: der Worker hat ihn vor Anreise ausgegeben.
  created_by     bigint REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  -- Wann mit diesem Link der Meldeschein eingereicht wurde.
  completed_at   timestamptz
);

CREATE INDEX checkin_token_reservation ON checkin_token (reservation_id);

/*
 * Der automatische Versand geschieht genau einmal je Reservierung.
 *
 * Der Worker prueft das vorher, aber zwei gleichzeitige Laeufe saehen beide
 * "noch keiner da". Die Bedingung hier ist die, die haelt; die Abfrage davor
 * ist nur die, die Arbeit spart. Ein von Hand ausgegebener Link (created_by
 * gesetzt) zaehlt nicht mit -- "erneut senden" soll gehen.
 */
CREATE UNIQUE INDEX checkin_token_auto_einmal ON checkin_token (reservation_id)
  WHERE channel = 'mail' AND created_by IS NULL;

ALTER TABLE checkin_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkin_token FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON checkin_token
  USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('checkin_token');

/*
 * Die Anwendung darf widerrufen und als erledigt vermerken, sonst nichts.
 *
 * Ein UPDATE auf token_hash oder expires_on waere ein Weg, einen alten Link
 * wiederzubeleben oder zu verlaengern; ein DELETE einer, die Spur einer
 * Ausgabe zu verwischen. Geloescht wird ausschliesslich ueber die
 * Loeschfunktionen des Gastes (unten), und die laufen als Eigentuemerin.
 */
REVOKE UPDATE, DELETE ON checkin_token FROM hotelpms_app;
GRANT UPDATE (revoked_at, completed_at) ON checkin_token TO hotelpms_app;

/*
 * Auf die Redaktionsliste, obwohl ein Hash kein Klartext ist: er ist der
 * Schluessel, unter dem ein Link nachgeschlagen wird, und ein Protokoll ohne
 * Zeilenrichtlinie und ohne Frist ist nicht der Ort dafuer (CLAUDE.md,
 * Migration 0044).
 */
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('checkin_token', 'token_hash', 'Geheimnis: Hash eines Zugangslinks')
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------- Meldeschein

ALTER TABLE registration
  ADD COLUMN source text NOT NULL DEFAULT 'desk'
    CHECK (source IN ('desk','online','terminal'));

ALTER TABLE registration
  ADD COLUMN signature_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN registration.signature_required IS
  'Braucht dieser Schein eine Unterschrift (auslaendische Person darauf, '
  '§ 29 Abs. 2 BMG)? Mit signed_at IS NULL heisst das: steht noch aus.';

-- Bestand: bisher entschied is_foreign des Hauptscheins allein, und genau so
-- wurde erfasst. Mitreisende Scheine haben nie eine eigene Unterschrift
-- getragen; sie bleiben false.
UPDATE registration SET signature_required = true
 WHERE is_foreign AND group_registration_id IS NULL;

-- ------------------------------------------------------------- Gastpost

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_kind_check;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_kind_check
  CHECK (kind IN ('invoice','reservation_confirmation','checkin_invitation'));

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_bezug;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_bezug CHECK (
  (kind = 'invoice' AND invoice_id IS NOT NULL) OR
  (kind IN ('reservation_confirmation','checkin_invitation')
     AND reservation_id IS NOT NULL));

-- ------------------------------------------------------- Ausgeben

/**
 * Einen Link fuer eine Reservierung ausgeben.
 *
 * SECURITY INVOKER: die Zeilenrichtlinie greift. Wer die Reservierung nicht
 * im Kontext hat, gibt nichts aus -- Route und Worker kommen hier mit dem
 * Kontext genau ihres Hauses an.
 *
 * Der Hash kommt vom Aufrufer, nicht das Token: die Datenbank sieht den
 * Klartext nie, auch nicht als Parameter in einem Anweisungsprotokoll.
 *
 * Gibt keine Zeile zurueck, wenn der automatische Versand fuer diese
 * Reservierung schon einmal stattgefunden hat. Das ist kein Fehler, sondern
 * die Zusage "genau einmal" -- der Worker geht dann zur naechsten.
 */
CREATE OR REPLACE FUNCTION checkin_token_issue(
  p_reservation bigint, p_channel text, p_hash text,
  p_expires_on date, p_created_by bigint
) RETURNS TABLE (issued_id bigint, issued_until date)
LANGUAGE plpgsql AS $$
DECLARE
  v_res   record;
  v_bis   date;
  v_id    bigint;
BEGIN
  SELECT r.id, r.property_id, r.departure, r.primary_guest_id
    INTO v_res FROM reservation r WHERE r.id = p_reservation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservierung % liegt nicht im Kontext', p_reservation
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Ohne Hauptgast gibt es niemanden, dessen Meldeschein erfasst wuerde.
  IF v_res.primary_guest_id IS NULL THEN
    RAISE EXCEPTION 'Reservierung % hat keinen Hauptgast', p_reservation
      USING ERRCODE = 'check_violation';
  END IF;

  -- Spaetestens der Abreisetag, auch wenn der Aufrufer mehr verlangt.
  v_bis := LEAST(COALESCE(p_expires_on, v_res.departure), v_res.departure);

  INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel,
                             expires_on, created_by)
  VALUES (v_res.property_id, v_res.id, p_hash, p_channel, v_bis, p_created_by)
  ON CONFLICT (reservation_id) WHERE channel = 'mail' AND created_by IS NULL
  DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN;
  END IF;
  issued_id := v_id;
  issued_until := v_bis;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION checkin_token_issue(bigint, text, text, date, bigint) IS
  'Gibt einen Online-Check-in-Link aus (nur Hash). Der automatische Versand '
  'geschieht hoechstens einmal je Reservierung.';

-- ------------------------------------------------------- Oeffnen

/**
 * Einen Link einloesen -- der einzige Weg, auf dem eine Anfrage ohne
 * Anmeldung an Fachdaten kommt.
 *
 * **Warum SECURITY DEFINER.** Die oeffentliche Route hat keinen Benutzer und
 * damit keinen Mandantenkontext. Ohne ihn liefert jede Tabelle mit
 * Zeilenrichtlinie leise nichts -- der Fehler, der hier zweimal still
 * passiert ist (0014, 0018). Eine Eigentuemerverbindung in der API waere ein
 * stehender BYPASSRLS im Anfrageprozess. Statt dessen dieses eine, schmale
 * Loch nach dem Muster von account_provision (0031): es liest genau eine
 * Zeile ueber den Hash und sonst nichts.
 *
 * **Der Kontext kommt aus dem Token.** Ist der Link gueltig, setzt die
 * Funktion den Kontext der Transaktion auf genau dieses eine Haus und
 * diesen einen Account -- dieselbe Regel wie ueberall ("der Kontext kommt
 * aus dem Token, nie aus Pfad, Query oder Rumpf"), nur dass das Token hier
 * ein Link ist und kein Sitzungscookie. Die Route schraenkt danach auf die
 * eine Reservierung ein; die Zeilenrichtlinie haelt alle anderen Haeuser
 * heraus, auch wenn die Route sich irrt.
 *
 * **Nur mit leerem Kontext.** Wer schon einen hat -- eine angemeldete
 * Sitzung, der Worker --, soll ihn nicht ueber einen Link umbiegen. Die
 * Pruefung ist die, die haelt, wenn die Route beim naechsten Umbau falsch
 * verdrahtet wird.
 *
 * Gibt fuer einen unbekannten Hash keine Zeile zurueck. Fuer einen bekannten
 * nennt sie den Zustand: wer den Hash kennt, kennt das Token, und dem darf
 * man sagen, dass sein Link abgelaufen ist, statt "gibt es nicht".
 */
CREATE OR REPLACE FUNCTION checkin_token_open(p_hash text)
RETURNS TABLE (
  out_token_id bigint, out_property_id bigint, out_account_id bigint,
  out_reservation_id bigint, out_channel text, out_expires_on date,
  out_business_date date, out_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r       record;
  v_bd    date;
  v_state text;
BEGIN
  IF cardinality(app_property_ids()) > 0 OR cardinality(app_account_ids()) > 0 THEN
    RAISE EXCEPTION 'checkin_token_open verlangt einen leeren Mandantenkontext'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT t.id, t.property_id, p.account_id, t.reservation_id, t.channel,
         t.expires_on, t.revoked_at, res.status::text AS res_status,
         p.timezone, p.status AS property_status, a.status AS account_status,
         g.status AS guest_status
    INTO r
    FROM checkin_token t
    JOIN reservation res ON res.id = t.reservation_id
    JOIN property p      ON p.id = t.property_id
    JOIN account a       ON a.id = p.account_id
    LEFT JOIN guest g    ON g.id = res.primary_guest_id
   WHERE t.token_hash = p_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Der Geschaeftstag, nicht now(): sonst gilt ein Link in der Nacht nach
  -- der Abreise noch oder schon nicht mehr, je nachdem, ob der Nachtlauf
  -- schon gelaufen ist. Ohne offenen Tag (ein Haus im Aufbau) der
  -- Kalendertag am Ort des Hauses.
  SELECT b.date INTO v_bd FROM business_day b
   WHERE b.property_id = r.property_id AND b.status = 'open'
   ORDER BY b.date DESC LIMIT 1;
  v_bd := COALESCE(v_bd, (now() AT TIME ZONE r.timezone)::date);

  v_state := CASE
    WHEN r.revoked_at IS NOT NULL                       THEN 'revoked'
    WHEN r.expires_on < v_bd                            THEN 'expired'
    WHEN r.account_status <> 'active'
      OR r.property_status <> 'active'                  THEN 'closed'
    WHEN r.res_status NOT IN ('Optional','Confirmed','InHouse') THEN 'closed'
    -- Ein geloeschter Gast hat keinen Meldeschein mehr, den er ausfuellen
    -- koennte; die Loeschung soll nicht ueber einen alten Link umgangen werden.
    WHEN r.guest_status IS DISTINCT FROM 'active'       THEN 'closed'
    ELSE 'valid'
  END;

  IF v_state = 'valid' THEN
    PERFORM set_config('app.account_ids',  r.account_id::text,  true),
            set_config('app.property_ids', r.property_id::text, true);
  END IF;

  out_token_id := r.id;
  out_property_id := r.property_id;
  out_account_id := r.account_id;
  out_reservation_id := r.reservation_id;
  out_channel := r.channel;
  out_expires_on := r.expires_on;
  out_business_date := v_bd;
  out_state := v_state;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION checkin_token_open(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION checkin_token_open(text) FROM hotelpms_readonly;
GRANT EXECUTE ON FUNCTION checkin_token_open(text) TO hotelpms_app;

COMMENT ON FUNCTION checkin_token_open(text) IS
  'Loest einen Online-Check-in-Link ein und setzt den Kontext auf genau '
  'dieses Haus. Nur mit leerem Kontext aufrufbar.';

-- ---------------------------------------------------------------------------
-- Loeschung: die Links gehoeren zum Gast.
--
-- An einer Stelle, nicht in der Route und nicht im Nachtlauf (CLAUDE.md).
-- Beide Funktionen stehen hier vollstaendig, weil PostgreSQL eine Funktion
-- nicht teilweise ersetzen kann; gegenueber 0046 kommt in jeder genau ein
-- DELETE hinzu. Ein Link zu einer Reservierung, deren Gast geloescht ist,
-- ist ein Weg, Angaben ueber diesen Gast erneut abzulegen -- er faellt mit.
--
-- Die Gastpost mit dem Link darin faengt der bestehende Block ueber
-- outbound_email.reservation_id ab; sie traegt ohnehin keinen Rumpf mehr,
-- sobald sie zugestellt ist (Worker).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guest_erase_one(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM guest
                  WHERE id = p_guest AND account_id = ANY (app_account_ids())) THEN
    RETURN;
  END IF;

  DELETE FROM guest_property_note WHERE guest_id = p_guest;
  DELETE FROM registration        WHERE guest_id = p_guest;
  -- Neu in 0061.
  DELETE FROM checkin_token t
   USING reservation r
   WHERE r.id = t.reservation_id AND r.primary_guest_id = p_guest;

  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  UPDATE outbound_email e
     SET to_email = 'entfernt@invalid', to_name = NULL,
         body_text = '', body_html = NULL, redacted_at = now()
   WHERE e.redacted_at IS NULL
     AND (EXISTS (SELECT 1 FROM reservation r
                   WHERE r.id = e.reservation_id AND r.primary_guest_id = p_guest)
          OR EXISTS (SELECT 1 FROM invoice i
                       JOIN folio f ON f.id = i.folio_id
                       JOIN reservation r2 ON r2.id = f.reservation_id
                      WHERE i.id = e.invoice_id AND r2.primary_guest_id = p_guest));

  UPDATE guest
     SET last_name = 'Anonymisiert', first_name = NULL, email = NULL, phone = NULL,
         birth_date = NULL, nationality = NULL, address_line1 = NULL,
         postal_code = NULL, city = NULL, country = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         status = 'anonymized', anonymized_at = now(), updated_at = now()
   WHERE id = p_guest;
END $$;

CREATE OR REPLACE FUNCTION guest_erase_partial(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM guest
                  WHERE id = p_guest AND account_id = ANY (app_account_ids())) THEN
    RETURN;
  END IF;

  DELETE FROM guest_property_note WHERE guest_id = p_guest;
  DELETE FROM registration        WHERE guest_id = p_guest;
  -- Neu in 0061. Auch hier und nicht erst im Nachtlauf: der Link fuehrt zu
  -- einer Maske, die genau das wieder abfragt, was gerade entfernt wurde.
  DELETE FROM checkin_token t
   USING reservation r
   WHERE r.id = t.reservation_id AND r.primary_guest_id = p_guest;
  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  UPDATE guest
     SET email = NULL, phone = NULL, birth_date = NULL, nationality = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         erasure_requested_at = COALESCE(erasure_requested_at, now()),
         updated_at = now()
   WHERE id = p_guest;
END $$;
