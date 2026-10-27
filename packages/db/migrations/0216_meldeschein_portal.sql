-- ---------------------------------------------------------------------------
-- 0216 Meldeschein ueber einen festen Link je Haus (Booking.com)
--
-- Anlass (Sven, 27.10.2026): Booking.com stellt die Einladung zum
-- Online-Check-in an seine Weiterleitungsadressen nicht zu. Gaeste von
-- Booking.com bekommen deshalb ueber eine Nachrichtenvorlage von Booking.com
-- einen festen Link je Haus, geben dort Buchungsnummer und Anreisetag ein
-- und fuellen den Meldeschein aus.
--
-- **Die Seite nimmt nur entgegen, sie zeigt nichts.** Kein Name, kein
-- Zeitraum, keine Antwort darauf, ob es die Buchung gibt. Mit Nummer und
-- Anreisetag allein laesst sich deshalb nichts lesen, und Sven hat sich
-- bewusst gegen ein drittes Feld entschieden.
--
-- **Auch ohne passende Buchung.** Kennt StayGrid die Nummer noch nicht --
-- das Adminpanel hat sie nicht gemeldet oder die Buchung fehlt ganz --, liegt
-- der Meldeschein hier, bis die Nummer auftaucht oder die Rezeption ihn von
-- Hand zuordnet. Danach steht er wie jeder andere an der Reservierung, und
-- die Zeile hier verschwindet.
--
--   property.checkin_portal_ref   die Kennung im Link, je Haus
--   checkin_portal_submission     ein abgegebener, noch nicht zugeordneter
--                                 Meldeschein
--   checkin_portal_origin         Abgaben je Herkunft, gegen Massenabgaben
--
-- **Sieben Tage nach dem angegebenen Anreisetag wird verworfen** (Sven,
-- 27.10.2026). Bis dahin hat die Rezeption den Gast beim Check-in gesehen;
-- was dann noch hier liegt, gehoert zu keinem Aufenthalt, und ein Meldeschein
-- ohne Aufenthalt ist eine Sammlung von Ausweisdaten ohne Zweck.
-- ---------------------------------------------------------------------------

/*
 * Die Kennung im Link. Nicht die id: die waere aufzaehlbar und verriete,
 * wie viele Haeuser es gibt. Geheim ist sie nicht -- sie steht in einer
 * Vorlage, die jeder Gast bekommt --, deshalb im Klartext und nicht als Hash.
 */
ALTER TABLE property
  ADD COLUMN checkin_portal_ref text NOT NULL UNIQUE DEFAULT generate_public_ref(16);

COMMENT ON COLUMN property.checkin_portal_ref IS
  'Kennung im festen Link zum Meldeschein (/meldeschein/<ref>, 0216). Nicht geheim.';

CREATE TABLE checkin_portal_submission (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref     text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  property_id    bigint NOT NULL REFERENCES property(id),
  -- Wie booking.channel_booking_number (0215).
  booking_number text NOT NULL
    CHECK (booking_number ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- Ein Kalendertag, wie ihn der Gast angegeben hat.
  arrival        date NOT NULL,
  /*
   * Die Abgabe als JSON, verschluesselt wie die Ausweisnummer am Gast und mit
   * eigenem Zweck in der Ableitung: darin stehen Geburtsdatum, Anschrift und
   * bei auslaendischen Gaesten die Ausweisnummer. Eine Sicherung soll das
   * nicht im Klartext tragen, solange es zu keinem Gast gehoert.
   */
  payload_enc    bytea NOT NULL,
  -- Nur der Nachname, fuer die Liste der Rezeption und die Zuordnung von
  -- Hand. Mehr braucht dort niemand, um zu sehen, wessen Schein es ist.
  last_name      text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now(),
  /*
   * Warum die automatische Zuordnung nicht ging, fuer die Rezeption:
   *   NULL          noch keine Buchung mit dieser Nummer und diesem Anreisetag
   *   registered    die Buchung hat schon einen Meldeschein
   *   rejected      die Buchung passt, der Schein nicht (Hausbedingungen
   *                 geaendert, Befreiungsgrund nicht mehr angeboten ...)
   */
  hold_reason    text CHECK (hold_reason IN ('registered', 'rejected'))
);
CREATE INDEX checkin_portal_submission_number
  ON checkin_portal_submission (property_id, booking_number);
CREATE INDEX checkin_portal_submission_arrival
  ON checkin_portal_submission (arrival);

CREATE TABLE checkin_portal_origin (
  property_id   bigint NOT NULL REFERENCES property(id),
  -- SHA-256 der Adresse, nie die Adresse (wie 0186).
  origin_hash   text NOT NULL,
  submissions   integer NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, origin_hash)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checkin_portal_submission','checkin_portal_origin'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

/*
 * Kein Audit-Trigger: eine Zeile hier ist Durchgang, kein Beleg. Was
 * bleibt, steht danach im Meldeschein, und der hat seinen eigenen Verlauf.
 * Ein Trigger schriebe den Nachnamen ins Protokoll, wo ihn keine Loeschung
 * mehr erreicht (CLAUDE.md, 0044).
 *
 * Aendern darf die Anwendung nur den Grund des Wartens; Abgabe und Inhalt
 * bleiben, wie der Gast sie geschickt hat.
 */
REVOKE UPDATE ON checkin_portal_submission FROM hotelpms_app;
GRANT UPDATE (hold_reason) ON checkin_portal_submission TO hotelpms_app;

/*
 * Den Link einloesen: das Haus zur Kennung, mit leerem Kontext aufgerufen,
 * und den Kontext auf genau dieses Haus setzen -- wie
 * guest_folder_room_open (0143). Ein Schulungshaus nimmt an: es exportiert
 * nichts nach draussen, und ausprobieren soll man es koennen.
 */
CREATE OR REPLACE FUNCTION checkin_portal_open(p_ref text)
RETURNS TABLE (
  out_property_id bigint, out_account_id bigint, out_business_date date, out_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r       record;
  v_bd    date;
  v_state text;
BEGIN
  IF cardinality(app_property_ids()) > 0 OR cardinality(app_account_ids()) > 0 THEN
    RAISE EXCEPTION 'checkin_portal_open verlangt einen leeren Mandantenkontext'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.id, p.account_id, p.timezone, p.status AS property_status,
         a.status AS account_status
    INTO r
    FROM property p JOIN account a ON a.id = p.account_id
   WHERE p.checkin_portal_ref = p_ref;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT b.date INTO v_bd FROM business_day b
   WHERE b.property_id = r.id AND b.status = 'open'
   ORDER BY b.date DESC LIMIT 1;
  v_bd := COALESCE(v_bd, (now() AT TIME ZONE r.timezone)::date);

  v_state := CASE WHEN r.account_status <> 'active' OR r.property_status <> 'active'
                  THEN 'closed' ELSE 'valid' END;
  IF v_state = 'valid' THEN
    PERFORM set_config('app.account_ids',  r.account_id::text, true),
            set_config('app.property_ids', r.id::text,         true);
  END IF;

  out_property_id := r.id;
  out_account_id := r.account_id;
  out_business_date := v_bd;
  out_state := v_state;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION checkin_portal_open(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION checkin_portal_open(text) FROM hotelpms_readonly;
GRANT EXECUTE ON FUNCTION checkin_portal_open(text) TO hotelpms_app;

COMMENT ON FUNCTION checkin_portal_open(text) IS
  'Loest die Kennung des festen Meldeschein-Links ein und setzt den Kontext auf '
  'genau dieses Haus. Nur mit leerem Kontext aufrufbar.';
