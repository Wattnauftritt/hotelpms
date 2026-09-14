-- Ausgehender E-Mail-Versand ueber Brevo.
--
-- Befund: das System erzeugte den Rechnungsbeleg nach EN 16931, legte ihn
-- ab -- und beim Gast kam er nie an. Jede Rechnung musste von Hand
-- heruntergeladen und aus einem zweiten Programm verschickt werden. Damit
-- war der ganze Weg vom Check-out bis zum Beleg an genau einer Stelle
-- unterbrochen, und zwar an der letzten.
--
-- Der Aufbau ist derselbe wie bei den Webhooks (0020), und zwar absichtlich:
-- eingereiht wird in der Transaktion der Fachbuchung, zugestellt wird vom
-- Worker ausserhalb davon. Wer beides in einem Schritt taete, haette die
-- Wahl zwischen einer Rechnung ohne Mail (Absturz nach dem Commit) und einer
-- Mail ohne Rechnung (Absturz vor dem Commit). Beides ist teuer, das zweite
-- ist peinlich.
--
-- Wo der Versand sich von einem Webhook unterscheidet, steht es an der
-- betreffenden Stelle. Die drei wesentlichen Unterschiede: der Empfaenger
-- ist ein Mensch und keine Maschine, der Anhang ist ein aufbewahrungs-
-- pflichtiger Beleg, und eine falsch zugestellte Nachricht laesst sich nicht
-- zurueckholen.

-- ---------------------------------------------------------------------------
-- Absenderangaben je Haus.
--
-- Je Property und nicht je Account: zwei Haeuser desselben Betreibers treten
-- unter ihrem eigenen Namen auf, und der Gast erwartet den Namen des Hauses,
-- in dem er geschlafen hat, im Absender. Der Zugang zu Brevo dagegen liegt
-- in der Umgebung und nicht hier -- ein API-Schluessel in einer Fachtabelle
-- waere ein Geheimnis, das jede Sicherung und jeder Mandantenexport
-- mitnimmt.
-- ---------------------------------------------------------------------------

CREATE TABLE property_email_setting (
  property_id  bigint PRIMARY KEY REFERENCES property(id),
  -- Was im Postfach des Gastes als Absender steht.
  from_name    text NOT NULL,
  -- Muss bei Brevo als Absender verifiziert sein, sonst weist der Anbieter
  -- die Nachricht ab. Die Pruefung liegt bei ihm; hier steht nur die Angabe.
  from_email   text NOT NULL,
  -- Antworten gehen an die Rezeption, nicht an den technischen Absender.
  -- Ohne Angabe antwortet der Gast an from_email, was oft ein unbeachtetes
  -- Postfach ist.
  reply_to     text,
  -- Blindkopie ins eigene Haus. Manche Betriebe wollen jede ausgehende
  -- Rechnung im eigenen Postfach sehen; andere wollen genau das nicht,
  -- weil es Gastdaten ein zweites Mal ablegt. Deshalb leer als Vorgabe.
  bcc_email    text,
  -- Aus bleibt der Versand, bis jemand ihn bewusst einschaltet. Ein Haus,
  -- das gerade eingerichtet wird, soll keine Post an echte Gaeste schicken,
  -- nur weil eine Testrechnung entstanden ist.
  enabled      boolean NOT NULL DEFAULT false,
  updated_by   bigint REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE property_email_setting IS
  'Absenderangaben je Haus. Der Zugang zum Anbieter steht in der Umgebung.';

-- ---------------------------------------------------------------------------
-- Die Warteschlange.
--
-- Rumpf und Betreff stehen fertig gerendert in der Zeile, nicht als Verweis
-- auf eine Vorlage. Das kostet Platz und ist trotzdem richtig: eine Vorlage
-- aendert sich, und dann liesse sich ein halbes Jahr spaeter nicht mehr
-- sagen, was dem Gast tatsaechlich zugegangen ist. Bei einer Rechnung ist
-- genau das die Frage, die gestellt wird.
-- ---------------------------------------------------------------------------

CREATE TABLE outbound_email (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  kind         text NOT NULL CHECK (kind IN ('invoice','reservation_confirmation')),

  to_email     text NOT NULL,
  to_name      text,
  subject      text NOT NULL,
  body_text    text NOT NULL,
  -- Ohne HTML-Teil landet die Nachricht bei manchen Empfaengern als
  -- Textwueste; ohne Textteil halten andere Filter sie fuer verdaechtig.
  -- Beide Teile, wie es sich gehoert.
  body_html    text,

  /*
   * Der Anhang steht als Verweis, nicht als Kopie. Der Beleg liegt bereits
   * in invoice_document und ist dort haertegrad-geschuetzt; ihn hier noch
   * einmal abzulegen hiesse, zwei Fassungen desselben Dokuments zu haben,
   * die auseinanderlaufen koennen. Verschickt wird damit nachweislich
   * dieselbe Datei, die im Archiv liegt.
   *
   * Der Verweis hat einen zweiten Zweck: die Mail darf eingereiht werden,
   * bevor der Beleg erzeugt ist. Der Worker holt sie erst, wenn der Anhang
   * bereitsteht (siehe Abholindex weiter unten).
   */
  invoice_id   bigint REFERENCES invoice(id),
  reservation_id bigint REFERENCES reservation(id),

  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','sent','failed','canceled')),
  attempts     integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- Die Kennung des Anbieters. Ohne sie laesst sich eine Nachricht in
  -- dessen Protokoll nicht wiederfinden, und genau dorthin fuehrt die
  -- Frage "der Gast sagt, er habe nichts bekommen".
  provider_message_id text,
  last_error   text,
  -- Fingerabdruck des mitgeschickten Anhangs, uebernommen aus
  -- invoice_document.sha256. Damit ist belegbar, welche Fassung der Gast
  -- erhalten hat, auch wenn er sie nicht mehr hat.
  attachment_sha256 text,
  requested_by bigint REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  -- Zeitpunkt, an dem Empfaenger und Rumpf entfernt wurden (siehe
  -- email_redact_old weiter unten).
  redacted_at  timestamptz,

  -- Eine Rechnungsmail ohne Rechnung waere ein leerer Anhang, und eine
  -- Bestaetigung ohne Reservierung haette keinen Inhalt. Die Pruefung hier
  -- ist billiger als der Befund im Postfach des Gastes.
  CONSTRAINT outbound_email_bezug CHECK (
    (kind = 'invoice' AND invoice_id IS NOT NULL) OR
    (kind = 'reservation_confirmation' AND reservation_id IS NOT NULL))
);

/*
 * Der Abholpfad des Workers. Partiell auf die offenen Zeilen, weil
 * zugestellte die Mehrheit werden und dort nichts zu suchen haben.
 */
CREATE INDEX outbound_email_due ON outbound_email (property_id, next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX outbound_email_invoice ON outbound_email (invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX outbound_email_reservation ON outbound_email (reservation_id)
  WHERE reservation_id IS NOT NULL;
-- Fuer das Entfernen alter Gastdaten: nur, was noch Daten traegt.
CREATE INDEX outbound_email_redact ON outbound_email (created_at)
  WHERE redacted_at IS NULL;

COMMENT ON COLUMN outbound_email.status IS
  'pending faellig, sent vom Anbieter angenommen, failed aufgegeben, canceled von Hand zurueckgezogen. sent heisst angenommen, nicht zugestellt.';

CREATE TABLE outbound_email_attempt (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id     bigint NOT NULL REFERENCES outbound_email(id) ON DELETE CASCADE,
  property_id  bigint NOT NULL REFERENCES property(id),
  attempt      integer NOT NULL,
  status_code  integer,
  error        text,
  duration_ms  integer,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email_id, attempt)
);

-- ---------------------------------------------------------------------------
-- Zeilenrichtlinien. FORCE, sonst umgeht der Eigentuemer sie.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['property_email_setting','outbound_email',
                           'outbound_email_attempt'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('property_email_setting');

-- ---------------------------------------------------------------------------
-- Einreihen, in der Transaktion des Aufrufers.
--
-- SECURITY INVOKER wie webhook_enqueue: die Zeilenrichtlinie soll auch hier
-- greifen. Wer keinen Kontext auf die Property hat, reiht nichts ein,
-- statt im falschen Mandanten zu landen.
--
-- Die Funktion prueft drei Dinge, und jedes einzelne hat schon anderswo
-- Schaden angerichtet:
--
--   1. Ein Uebungshaus verschickt nichts. Schulungsdaten tragen echte
--      Adressen, weil jemand seine eigene eingetragen hat, um zu sehen wie
--      es aussieht -- und dann geht eine erfundene Rechnung an einen echten
--      Empfaenger. Dieselbe Linie wie bei DATEV und Statistik (C11).
--   2. Ein anonymisierter Gast bekommt keine Post mehr. Nach einer
--      Loeschung ist die Adresse entfernt oder ueberschrieben; sie
--      trotzdem zu benutzen hiesse, eine Loeschung zu unterlaufen.
--   3. Ohne eingeschalteten Versand passiert nichts. Sonst genuegte das
--      Anlegen eines Hauses, um Post zu erzeugen.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION email_enqueue(
  p_property_id bigint,
  p_kind        text,
  p_to_email    text,
  p_to_name     text,
  p_subject     text,
  p_body_text   text,
  p_body_html   text,
  p_invoice_id  bigint,
  p_reservation_id bigint,
  p_requested_by bigint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_ref      text;
  v_training boolean;
  v_enabled  boolean;
BEGIN
  SELECT p.is_training INTO v_training FROM property p WHERE p.id = p_property_id;
  IF v_training IS NULL THEN
    RAISE EXCEPTION 'Property % liegt nicht im Kontext', p_property_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_training THEN
    RAISE EXCEPTION 'Ein Uebungshaus verschickt keine E-Mail'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.enabled INTO v_enabled
    FROM property_email_setting s WHERE s.property_id = p_property_id;
  IF COALESCE(v_enabled, false) = false THEN
    RAISE EXCEPTION 'Der E-Mail-Versand ist fuer dieses Haus nicht eingeschaltet'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO outbound_email (property_id, kind, to_email, to_name, subject,
                              body_text, body_html, invoice_id, reservation_id,
                              requested_by)
  VALUES (p_property_id, p_kind, p_to_email, p_to_name, p_subject,
          p_body_text, p_body_html, p_invoice_id, p_reservation_id, p_requested_by)
  RETURNING public_ref INTO v_ref;

  RETURN v_ref;
END $$;

-- ---------------------------------------------------------------------------
-- Gastdaten in der Warteschlange altern lassen.
--
-- Eine Zustellung ist kein Buchungsbeleg: die Rechnung selbst liegt in
-- invoice und invoice_document und unterliegt dort der achtjaehrigen
-- Aufbewahrung. Was hier steht, ist eine Adresse und ein Anschreiben, und
-- beides braucht nach ein paar Wochen niemand mehr.
--
-- Entfernt werden deshalb Empfaenger und Rumpf, nicht die Zeile. Der Rest --
-- wann, welche Art, welcher Ausgang, welcher Fingerabdruck des Anhangs --
-- ist die Antwort auf "ist die Rechnung rausgegangen", und die kann noch
-- Jahre spaeter kommen.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION email_redact_old(p_property_id bigint, p_days integer DEFAULT 90)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  PERFORM assert_property_in_context(p_property_id);

  UPDATE outbound_email
     SET to_email = 'entfernt@invalid',
         to_name = NULL,
         body_text = '',
         body_html = NULL,
         redacted_at = now()
   WHERE property_id = p_property_id
     AND redacted_at IS NULL
     AND status <> 'pending'
     AND created_at < now() - make_interval(days => p_days);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION email_redact_old IS
  'Entfernt Empfaenger und Rumpf alter Zustellungen, behaelt den Nachweis des Versands.';

-- ---------------------------------------------------------------------------
-- Berechtigung.
--
-- Eine eigene, keine geliehene. `invoice:issue` waere das naechstliegende
-- vorhandene Recht, meint aber das Festschreiben -- ein Vorgang in der
-- eigenen Buchhaltung. Etwas an einen Gast hinauszuschicken ist ein anderer
-- Vorgang: er verlaesst das Haus und laesst sich nicht zurueckholen.
--
-- Das Lesen des Postausgangs haengt am selben Recht. Dort stehen
-- Gastadressen und Anschreiben; wer nicht versenden darf, hat auch in der
-- fremden Korrespondenz nichts zu suchen.
--
-- Die Absenderangaben dagegen liegen unter `integration:manage`, bei den
-- uebrigen Schnittstellen: sie einzurichten ist Einrichtung, nicht Tagesbetrieb.
-- ---------------------------------------------------------------------------

INSERT INTO permission (key, grp, description) VALUES
  ('email:send', 'Gastpost', 'Rechnungen und Bestaetigungen an den Gast schicken')
ON CONFLICT DO NOTHING;

-- Die Sammelvergabe an Inhaber und Hausleitung lief in 0003 einmalig ueber
-- alle damals vorhandenen Rechte. Ein spaeter hinzugekommenes muss deshalb
-- ausdruecklich nachgetragen werden, sonst fehlt es ausgerechnet denen, die
-- alles duerfen sollen.
--
-- Ohne den Helfer aus 0003: der wird dort am Ende wieder entfernt, weil er
-- nur fuer jene Migration gedacht war.
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'email:send'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key IN (
     'owner', 'hotel_director', 'front_office_mgr',
     -- Rezeption und Nachtlauf: Rechnungsversand ist ihr Tagesgeschaeft.
     'reception', 'night_audit',
     -- Reservierung: Bestaetigungen.
     'reservations',
     -- Buchhaltung: eine Rechnung nachschicken, wenn die Firma sie nicht findet.
     'accounting')
ON CONFLICT DO NOTHING;
