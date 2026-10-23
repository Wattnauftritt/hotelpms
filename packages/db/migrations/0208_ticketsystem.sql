-- ---------------------------------------------------------------------------
-- 0208 -- Ticketsystem fuer unsere Kunden (Sven, 23.10.2026, Thread
-- "Ticketsystem fuer Kunden", Konzept ticketsystem/konzept.md).
--
-- **Warum gebaut und nicht angebunden.** Dokument 16, Aufgabe 13c, sah ein
-- fremdes Ticketsystem vor, und die Support-Sitzung sollte dessen Nummer als
-- Anlass tragen. Angebunden war am Ende nichts. Ein fremdes System kennt
-- weder Konto noch Haus noch Benutzer -- wir raten aus einer Absenderadresse,
-- welcher Kunde schreibt --, und die Freigabe einer Support-Sitzung waere
-- eine abgetippte Nummer in einem Freitextfeld. Dazu kaeme ein weiterer
-- Auftragsverarbeiter, bei dem die Bildschirmfotos der Rezeption liegen, auf
-- denen trotz jedes Hinweises Gastnamen stehen.
--
-- **Schmal, mit Absicht.** Kein Postfach, keine Antwort per Mail, keine
-- Makros und Fristen. Eine Mail sagt nur, dass es etwas Neues gibt, und
-- verweist auf StayGrid. So steht kein Ticketinhalt in einem Postfach, und
-- die teure Haelfte eines Helpdesks entfaellt.
--
-- Drei Tabellen:
--
--   support_ticket             Kopf: Kunde, Haus, Betreff, Art, Zustand
--   support_ticket_message     Faden; Kunde und Plattform, dazu interne Notizen
--   support_ticket_attachment  Bild oder PDF, in der Datenbank wie die
--                              Belege (Svens Entscheidung vom 15.10.2026)
--
-- **Zwei Seiten, zwei Wege.** Der Kunde schreibt und liest unter seinem
-- Mandantenkontext, die Zeilenrichtlinie haelt ihn in seinem Account. Die
-- Plattform hat ohne Support-Sitzung einen leeren Kontext und kaeme so an
-- nichts heran; sie liest und schreibt deshalb ueber SECURITY-DEFINER-
-- Funktionen mit platform_can() **in** der Funktion, wie das uebrige
-- Adminpanel (0038).
--
-- **Interne Notizen** schliesst die Zeilenrichtlinie selbst aus, nicht die
-- Abfrage der Route. Ein Kunde sieht sie aus Bauart nicht -- auch dann
-- nicht, wenn eine kuenftige Route vergisst, danach zu filtern.
-- ---------------------------------------------------------------------------

-- ------------------------------------------------------------------ Rechte

INSERT INTO permission (key, grp, description) VALUES
  ('support:ticket',   'Support',   'Anfragen an den StayGrid-Support stellen und die eigenen lesen'),
  ('platform:tickets', 'Plattform', 'Anfragen aller Kunden bearbeiten');

-- Jede Rolle eines Kunden darf fragen. Wer an einem Rechner sitzt und nicht
-- weiterkommt, soll nicht erst die Inhaberin suchen muessen. Was ein Ticket
-- des ganzen Betriebs sieht, entscheidet `settings:account` (Route).
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'support:ticket'
  FROM role r
 WHERE r.account_id IS NULL AND r.level <> 'platform'
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'platform:tickets'
  FROM role r
 WHERE r.account_id IS NULL AND r.level = 'platform'
   AND r.key IN ('platform_admin', 'platform_support')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------ Tabellen

CREATE TABLE support_ticket (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  -- Das Haus, in dem jemand sass, als er fragte. Nur ein Hinweis fuer den
  -- Support; der Mandant ist der Account.
  property_id      bigint REFERENCES property(id) ON DELETE SET NULL,
  created_by       bigint NOT NULL REFERENCES app_user(id),
  subject          text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  category         text NOT NULL CHECK (category IN ('question', 'bug', 'wish', 'billing')),
  -- "down": der Betrieb steht. Die eine Unterscheidung, die am Eingang
  -- wirklich etwas aendert.
  urgency          text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'down')),
  status           text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'waiting_customer', 'closed')),
  assigned_to      bigint REFERENCES app_user(id),
  -- Wo es geschah: Bildschirm und Stand der Oberflaeche. Keine Adresse mit
  -- Abfrageteil -- darin stuende ein Suchbegriff, also ein Gastname.
  screen           text CHECK (length(screen) <= 60),
  client_version   text CHECK (length(client_version) <= 80),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_customer_at timestamptz NOT NULL DEFAULT now(),
  last_staff_at    timestamptz,
  closed_at        timestamptz,
  UNIQUE (id, account_id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX support_ticket_konto ON support_ticket (account_id, status, updated_at DESC);
CREATE INDEX support_ticket_eingang ON support_ticket (status, updated_at DESC);

ALTER TABLE support_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON support_ticket USING (account_id = ANY (app_account_ids()));

CREATE TABLE support_ticket_message (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   bigint NOT NULL,
  -- Doppelt zum Ticket, damit die Zeilenrichtlinie ohne Verbund greift. Der
  -- zusammengesetzte Fremdschluessel haelt beide gleich.
  account_id  bigint NOT NULL,
  author_id   bigint REFERENCES app_user(id),
  author_side text NOT NULL CHECK (author_side IN ('customer', 'platform')),
  internal    boolean NOT NULL DEFAULT false,
  body        text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (ticket_id, account_id)
    REFERENCES support_ticket (id, account_id) ON DELETE CASCADE,
  -- Eine interne Notiz schreibt nur die Plattform.
  CHECK (NOT internal OR author_side = 'platform')
);

CREATE INDEX support_ticket_message_faden ON support_ticket_message (ticket_id, id);

ALTER TABLE support_ticket_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_message FORCE  ROW LEVEL SECURITY;
-- `NOT internal` gilt fuer Lesen **und** Schreiben (ohne eigenes WITH CHECK
-- nimmt PostgreSQL USING fuer beides): der Kunde sieht keine Notiz und legt
-- keine an.
CREATE POLICY tenant ON support_ticket_message
  USING (account_id = ANY (app_account_ids()) AND NOT internal);

CREATE TABLE support_ticket_attachment (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   bigint NOT NULL,
  account_id  bigint NOT NULL,
  message_id  bigint NOT NULL REFERENCES support_ticket_message(id) ON DELETE CASCADE,
  file_name   text CHECK (length(file_name) <= 255),
  -- Aus den ersten Bytes erkannt, nie aus der Angabe des Browsers. Kein SVG.
  mime        text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_count  integer NOT NULL CHECK (byte_count > 0),
  bytes       bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (ticket_id, account_id)
    REFERENCES support_ticket (id, account_id) ON DELETE CASCADE
);

CREATE INDEX support_ticket_attachment_ticket ON support_ticket_attachment (ticket_id);

ALTER TABLE support_ticket_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_attachment FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON support_ticket_attachment USING (account_id = ANY (app_account_ids()));

/*
 * Der Kunde legt an, antwortet, schliesst und oeffnet wieder. Kein DELETE:
 * geloescht wird nur nach Frist im Worker (Eigentuemerrolle). Nachrichten
 * und Anhaenge ohne UPDATE -- was gesagt ist, ist gesagt; eine Korrektur ist
 * eine weitere Nachricht.
 */
GRANT SELECT, INSERT, UPDATE ON support_ticket TO hotelpms_app;
GRANT SELECT, INSERT ON support_ticket_message, support_ticket_attachment TO hotelpms_app;

/*
 * Kopf eines Tickets: wer es angelegt hat, wo und worueber, steht fest. Der
 * Kunde braucht UPDATE fuer den Zustand, und eine Rechteordnung trennt das
 * nicht je Spalte -- derselbe Grund wie bei support_session (0032).
 */
CREATE OR REPLACE FUNCTION support_ticket_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.property_id IS DISTINCT FROM OLD.property_id AND NEW.property_id IS NOT NULL
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Kunde, Verfasser und Betreff eines Tickets stehen fest'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_support_ticket_immutable
  BEFORE UPDATE ON support_ticket
  FOR EACH ROW EXECUTE FUNCTION support_ticket_immutable();

SELECT attach_audit('support_ticket');
SELECT attach_audit('support_ticket_message');
SELECT attach_audit('support_ticket_attachment');

-- Ein Kunde schreibt in Betreff und Text, was ihn gerade beschaeftigt, und
-- das ist an einer Rezeption oft ein Gast. Ein Bildschirmfoto erst recht.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('support_ticket',            'subject',   'Freitext, kann einen Gastnamen tragen'),
  ('support_ticket_message',    'body',      'Freitext, kann einen Gastnamen tragen'),
  ('support_ticket_attachment', 'file_name', 'Dateiname, kann einen Gastnamen tragen'),
  ('support_ticket_attachment', 'bytes',     'Bildschirmfoto oder Dokument')
ON CONFLICT DO NOTHING;

-- -------------------------------------------- Verknuepfung zur Support-Sitzung

/*
 * Aus welchem Ticket eine Sitzung angefragt wurde. Der Kunde sieht die
 * Anfrage dann im Faden und gibt dort frei, statt eine Nummer im Anlass
 * wiederzuerkennen. SET NULL, weil die Sitzung ein Nachweis ist und das
 * Ticket nach Frist geht.
 */
ALTER TABLE support_session
  ADD COLUMN ticket_id bigint REFERENCES support_ticket(id) ON DELETE SET NULL;
CREATE INDEX support_session_ticket ON support_session (ticket_id) WHERE ticket_id IS NOT NULL;

-- ------------------------------------------------------------ Plattformpost

/*
 * Zwei neue Arten. `ticket_notice` geht an unser Postfach (support@) und
 * hat deshalb keinen Benutzer, wie der Hinweis auf Absenderdomains (0052).
 * `ticket_reply` geht an den, der das Ticket gestellt hat.
 *
 * Beide ohne Inhalt des Tickets: nur Nummer und Link. Was im Ticket steht,
 * gehoert nicht in ein Postfach, das wir nicht absichern.
 */
ALTER TABLE platform_email DROP CONSTRAINT platform_email_kind_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_kind_check
  CHECK (kind IN ('invite', 'password_reset', 'support_request',
                  'domain_request', 'email_change', 'email_change_notice',
                  'ticket_notice', 'ticket_reply'));

ALTER TABLE platform_email DROP CONSTRAINT platform_email_empfaenger_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_empfaenger_check
  CHECK (user_id IS NOT NULL OR kind IN ('domain_request', 'ticket_notice'));

-- ------------------------------------------------------- Plattformseite

/*
 * Der Eingang. `p_status`: 'active' (alles ausser geschlossen), ein
 * einzelner Zustand, oder NULL fuer alles. `p_id` fuer den einen Kopf.
 *
 * Reihenfolge: "Betrieb steht" vor allem anderen, dann wer am laengsten auf
 * uns wartet. Geschlossene zuletzt und hoechstens die juengsten 200 -- die
 * Liste waechst mit der Zeit, nicht mit der Arbeit.
 */
CREATE OR REPLACE FUNCTION platform_tickets(p_status text DEFAULT 'active', p_id bigint DEFAULT NULL)
RETURNS TABLE (
  id bigint, account_id bigint, account_name text, property_name text,
  created_by bigint, created_by_name text, subject text, category text,
  urgency text, status text, assigned_to bigint, assigned_name text,
  screen text, client_version text,
  created_at timestamptz, updated_at timestamptz, last_customer_at timestamptz,
  last_staff_at timestamptz, closed_at timestamptz, messages bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.account_id, a.name, p.name, t.created_by, cu.display_name,
         t.subject, t.category, t.urgency, t.status, t.assigned_to, au.display_name,
         t.screen, t.client_version,
         t.created_at, t.updated_at, t.last_customer_at, t.last_staff_at, t.closed_at,
         (SELECT count(*) FROM support_ticket_message m WHERE m.ticket_id = t.id)
    FROM support_ticket t
    JOIN account a        ON a.id = t.account_id
    LEFT JOIN property p  ON p.id = t.property_id
    JOIN app_user cu      ON cu.id = t.created_by
    LEFT JOIN app_user au ON au.id = t.assigned_to
   WHERE platform_can('platform:tickets')
     AND (p_id IS NULL OR t.id = p_id)
     AND (p_id IS NOT NULL OR p_status IS NULL
          OR (p_status = 'active' AND t.status <> 'closed')
          OR t.status = p_status)
   ORDER BY (t.status = 'closed'), (t.urgency = 'down') DESC,
            (t.status = 'open') DESC, t.last_customer_at
   LIMIT 200
$$;

REVOKE ALL ON FUNCTION platform_tickets(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tickets(text, bigint) TO hotelpms_app;

/* Der Faden, mit den internen Notizen. */
CREATE OR REPLACE FUNCTION platform_ticket_messages(p_ticket bigint)
RETURNS TABLE (
  id bigint, author_side text, author_name text, internal boolean,
  body text, created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.author_side, u.display_name, m.internal, m.body, m.created_at
    FROM support_ticket_message m
    LEFT JOIN app_user u ON u.id = m.author_id
   WHERE m.ticket_id = p_ticket
     AND platform_can('platform:tickets')
   ORDER BY m.id
$$;

REVOKE ALL ON FUNCTION platform_ticket_messages(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ticket_messages(bigint) TO hotelpms_app;

/* Die Anhaenge, ohne Inhalt. */
CREATE OR REPLACE FUNCTION platform_ticket_attachments(p_ticket bigint)
RETURNS TABLE (id bigint, message_id bigint, file_name text, mime text, byte_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.id, x.message_id, x.file_name, x.mime, x.byte_count
    FROM support_ticket_attachment x
   WHERE x.ticket_id = p_ticket
     AND platform_can('platform:tickets')
   ORDER BY x.id
$$;

REVOKE ALL ON FUNCTION platform_ticket_attachments(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ticket_attachments(bigint) TO hotelpms_app;

/* Ein Anhang mit Inhalt. Das Ticket steht mit in der Bedingung: eine
 * fremde Anhangnummer unter einem fremden Ticket liefert nichts. */
CREATE OR REPLACE FUNCTION platform_ticket_attachment(p_ticket bigint, p_id bigint)
RETURNS TABLE (file_name text, mime text, bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.file_name, x.mime, x.bytes
    FROM support_ticket_attachment x
   WHERE x.id = p_id AND x.ticket_id = p_ticket
     AND platform_can('platform:tickets')
$$;

REVOKE ALL ON FUNCTION platform_ticket_attachment(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ticket_attachment(bigint, bigint) TO hotelpms_app;

/*
 * Antworten oder notieren. Der Verfasser kommt aus app_user_id(), nicht aus
 * einem Parameter.
 *
 * Eine Antwort setzt das Ticket auf "wartet auf Kunde" -- auch ein
 * geschlossenes: wer einem Kunden schreibt, erwartet, dass er es liest und
 * antworten kann. Eine Notiz aendert am Zustand nichts; sie ist fuer uns.
 */
CREATE OR REPLACE FUNCTION platform_ticket_reply(p_ticket bigint, p_body text, p_internal boolean)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account bigint;
  v_id      bigint;
BEGIN
  IF NOT platform_can('platform:tickets') THEN
    RAISE EXCEPTION 'Recht platform:tickets fehlt' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.account_id INTO v_account FROM support_ticket t WHERE t.id = p_ticket FOR UPDATE;
  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO support_ticket_message (ticket_id, account_id, author_id, author_side, internal, body)
  VALUES (p_ticket, v_account, app_user_id(), 'platform', p_internal, p_body)
  RETURNING id INTO v_id;
  IF p_internal THEN
    UPDATE support_ticket SET updated_at = now() WHERE id = p_ticket;
  ELSE
    UPDATE support_ticket
       SET status = 'waiting_customer', closed_at = NULL,
           last_staff_at = now(), updated_at = now(),
           -- Wer antwortet, hat es in der Hand, solange niemand sonst es hat.
           assigned_to = COALESCE(assigned_to, app_user_id())
     WHERE id = p_ticket;
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION platform_ticket_reply(bigint, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ticket_reply(bigint, text, boolean) TO hotelpms_app;

/*
 * Zustand setzen und zuweisen. Zuweisen nur an sich selbst oder an
 * niemanden: eine Liste der Kollegen braucht platform:staff, und "ich
 * nehme das" ist am Eingang der Handgriff, den es braucht.
 *
 * `p_status` NULL laesst den Zustand stehen, `p_assign` 'me', 'none' oder
 * NULL ebenso die Zuweisung. Gibt false zurueck, wenn es das Ticket nicht gibt.
 */
CREATE OR REPLACE FUNCTION platform_ticket_set(p_ticket bigint, p_status text, p_assign text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT platform_can('platform:tickets') THEN
    RAISE EXCEPTION 'Recht platform:tickets fehlt' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'waiting_customer', 'closed') THEN
    RAISE EXCEPTION 'Unbekannter Zustand %', p_status USING ERRCODE = 'check_violation';
  END IF;
  IF p_assign IS NOT NULL AND p_assign NOT IN ('me', 'none') THEN
    RAISE EXCEPTION 'Unbekannte Zuweisung %', p_assign USING ERRCODE = 'check_violation';
  END IF;
  UPDATE support_ticket
     SET status = COALESCE(p_status, status),
         closed_at = CASE
           WHEN p_status IS NULL THEN closed_at
           WHEN p_status = 'closed' THEN COALESCE(closed_at, now())
           ELSE NULL END,
         assigned_to = CASE p_assign
           WHEN 'me' THEN app_user_id()
           WHEN 'none' THEN NULL
           ELSE assigned_to END,
         updated_at = now()
   WHERE id = p_ticket;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION platform_ticket_set(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ticket_set(bigint, text, text) TO hotelpms_app;

/*
 * Die Support-Sitzungen eines Tickets, fuer den Faden auf beiden Seiten.
 * Plattformseite; der Kunde liest support_session direkt (keine
 * Zeilenrichtlinie, die Route begrenzt auf den eigenen Account).
 */
CREATE OR REPLACE FUNCTION platform_ticket_sessions(p_ticket bigint)
RETURNS TABLE (
  id bigint, staff_name text, level text, requested_at timestamptz,
  granted_at timestamptz, expires_at timestamptz, revoked_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, u.display_name, s.level, s.requested_at, s.granted_at,
         s.expires_at, s.revoked_at
    FROM support_session s
    JOIN app_user u ON u.id = s.platform_user_id
   WHERE s.ticket_id = p_ticket
     AND platform_can('platform:tickets')
   ORDER BY s.id
$$;

REVOKE ALL ON FUNCTION platform_ticket_sessions(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_ticket_sessions(bigint) TO hotelpms_app;
