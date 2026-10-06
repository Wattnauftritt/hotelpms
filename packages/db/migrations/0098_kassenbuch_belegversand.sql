-- ---------------------------------------------------------------------------
-- 0098 -- Kassenbuch: Belege an die DATEV-Uploadmail.
--
-- Anforderung: Sven, 06.10.2026 ("Baue auch den Belegversand"). Das
-- Adminpanel schickt jeden Beleg beim DATEV-Export an die Uploadmail-Adresse
-- der Barkasse; DATEV legt den Anhang in der Belegverwaltung ab. Ab dem
-- Stichtag (0097) exportiert StayGrid, also muss StayGrid auch die Belege
-- schicken -- sonst fehlen sie dem Steuerberater ab genau diesem Tag.
--
-- Zwei Dinge macht StayGrid anders als das Adminpanel:
--
-- * Ein gescheiterter Versand wird beim naechsten Markieren nachgeholt. Im
--   Adminpanel galt die Zeile nach dem Export als gesendet, auch wenn die
--   Mail scheiterte; der Beleg kam danach nie mehr an die Reihe.
-- * Ein Beleg, der erst nach dem Export an eine Buchung kommt, geht beim
--   naechsten Markieren mit. Faellig ist jeder Beleg einer Buchung, die
--   StayGrid an DATEV gegeben hat, und der noch nicht unterwegs ist.
-- ---------------------------------------------------------------------------

-- Die Adresse nimmt nur DATEV-Uploadmail an. Ein Feld, in das sich eine
-- beliebige Adresse schreiben liesse, waere ein Weg, saemtliche Belege des
-- Hauses an jemand anderen zu schicken -- mit dem Absender des Hotels.
ALTER TABLE cashbook_setting ADD COLUMN datev_upload_email text
  CHECK (datev_upload_email IS NULL OR
         (length(datev_upload_email) <= 200
          AND datev_upload_email ~ '^[A-Za-z0-9._+-]+@uploadmail\.datev\.de$'));

-- Wer die Adresse kennt, legt Belege in die Buchhaltung des Hauses. Sie
-- gehoert deshalb nicht ins Protokoll.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('cashbook_setting', 'datev_upload_email', 'Zugang zur Belegablage bei DATEV')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Die Mail haengt am Beleg, wie die Rechnungsmail an der Rechnung: der
-- Anhang steht als Verweis, nicht als Kopie (siehe 0028). Der Dateiname
-- steht dagegen an der Mail, weil er die Belegnummer der Buchung traegt,
-- und die kennt nur, wer einreiht.
-- ---------------------------------------------------------------------------

ALTER TABLE outbound_email
  ADD COLUMN cashbook_receipt_id bigint REFERENCES cashbook_receipt(id),
  ADD COLUMN attachment_name text
    CHECK (attachment_name IS NULL OR length(attachment_name) <= 120);

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_kind_check;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_kind_check
  CHECK (kind IN ('invoice','reservation_confirmation','payment_link',
                  'checkin_invitation','checkin_invitation_test','cashbook_receipt'));

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_bezug;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_bezug CHECK (
  (kind = 'invoice' AND invoice_id IS NOT NULL) OR
  (kind IN ('reservation_confirmation','payment_link','checkin_invitation')
     AND reservation_id IS NOT NULL) OR
  (kind = 'checkin_invitation_test'
     AND invoice_id IS NULL AND reservation_id IS NULL) OR
  (kind = 'cashbook_receipt' AND cashbook_receipt_id IS NOT NULL
     AND invoice_id IS NULL AND reservation_id IS NULL AND attachment_name IS NOT NULL));

-- Ein Beleg ist hoechstens einmal unterwegs oder angekommen. Zwei Exporte
-- kurz nacheinander sollen DATEV nicht denselben Beleg zweimal geben;
-- ein gescheiterter oder abgebrochener darf dagegen neu eingereiht werden.
CREATE UNIQUE INDEX outbound_email_cashbook_receipt ON outbound_email (cashbook_receipt_id)
  WHERE cashbook_receipt_id IS NOT NULL AND status IN ('pending', 'sent');

-- ---------------------------------------------------------------------------
-- Einreihen mit Beleg.
--
-- Die Pruefungen bleiben an einer Stelle: die bisherige Fassung ruft die
-- neue. Eine zweite Kopie von Uebungshaus, Schalter und Absenderdomain
-- waere die, die beim naechsten Befund nicht nachgezogen wird.
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
  p_requested_by bigint,
  p_cashbook_receipt_id bigint,
  p_attachment_name text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_ref      text;
  v_training boolean;
  v_enabled  boolean;
  v_from     text;
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

  SELECT s.enabled, s.from_email INTO v_enabled, v_from
    FROM property_email_setting s WHERE s.property_id = p_property_id;
  IF COALESCE(v_enabled, false) = false THEN
    RAISE EXCEPTION 'Der E-Mail-Versand ist fuer dieses Haus nicht eingeschaltet'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT email_sender_allowed(p_property_id, v_from) THEN
    RAISE EXCEPTION 'Die Absenderdomain % ist nicht freigeschaltet',
      split_part(COALESCE(v_from, ''), '@', 2)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO outbound_email (property_id, kind, to_email, to_name, subject,
                              body_text, body_html, invoice_id, reservation_id,
                              requested_by, cashbook_receipt_id, attachment_name)
  VALUES (p_property_id, p_kind, p_to_email, p_to_name, p_subject,
          p_body_text, p_body_html, p_invoice_id, p_reservation_id, p_requested_by,
          p_cashbook_receipt_id, p_attachment_name)
  RETURNING public_ref INTO v_ref;

  RETURN v_ref;
END $$;

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
) RETURNS text LANGUAGE sql AS $$
  SELECT email_enqueue(p_property_id, p_kind, p_to_email, p_to_name, p_subject,
                       p_body_text, p_body_html, p_invoice_id, p_reservation_id,
                       p_requested_by, NULL::bigint, NULL::text);
$$;
