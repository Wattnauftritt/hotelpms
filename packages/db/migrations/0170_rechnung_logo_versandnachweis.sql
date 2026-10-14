-- Rechnungslogo und Versandnachweis (Sven, 14.10.2026: "wenn wir Rechnungen
-- per Mail senden, muss StayGrid den Sendungsnachweis speichern" und
-- "Rechnungen sollen ein Logo haben, das wir in den Einstellungen hochladen").

-- ------------------------------------------------------------------ Logo
--
-- Ein Logo je Haus. Es steht auf jedem Beleg, der danach gezeichnet wird;
-- ein schon gezeichneter Beleg bleibt, wie er ist (Haertegrad 1 ueber
-- invoice_document). Nur PNG und JPEG: das sind die Formate, die ein
-- PDF/A-3 ohne Umwandlung einbettet, und ein SVG ist ein Dokument mit Skript
-- (siehe terminalBild.ts). Die Art erkennt die Schnittstelle an den Bytes.

CREATE TABLE property_invoice_logo (
  property_id bigint PRIMARY KEY REFERENCES property(id),
  mime        text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes       bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  sha256      text NOT NULL,
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE property_invoice_logo ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_invoice_logo FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON property_invoice_logo USING (property_id = ANY (app_property_ids()));

SELECT attach_audit('property_invoice_logo');

-- Wie bei den Terminalbildern: ein Megabyte je Aenderung gehoert nicht ins
-- Protokoll, "Logo ersetzt" und der Fingerabdruck sagen genug.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('property_invoice_logo', 'bytes', 'Bilddaten: gross, ohne Aussage fuer das Protokoll');

-- ------------------------------------------------------- Versandnachweis
--
-- Befund: email_redact_old() entfernte nach 90 Tagen auch bei einer
-- versandten Rechnung die Empfaengeradresse. Status, Zeitpunkt, Kennung des
-- Anbieters und Fingerabdruck des Anhangs blieben -- aber nicht, **an wen**
-- die Rechnung ging. Genau das ist die Frage, wenn ein Gast oder eine Firma
-- sagt, sie habe nichts bekommen, und die Antwort darauf ist der
-- Sendungsnachweis.
--
-- Neu: bei einer versandten Rechnungsmail bleiben Adresse, Name und Betreff
-- sechs Jahre stehen, die Frist fuer abgesandte Handels- und Geschaeftsbriefe
-- (§ 257 Abs. 1 Nr. 3, Abs. 4 HGB; § 147 Abs. 1 Nr. 3, Abs. 3 AO). Der Rumpf
-- faellt wie bisher nach 90 Tagen: er ist eine Vorlage mit dem Namen darin,
-- und was der Empfaenger bekam, belegt der Anhang ueber seinen Fingerabdruck.
-- Eine Buchungsbestaetigung und eine gescheiterte Rechnungsmail werden wie
-- bisher ganz geschwaerzt. Ein Loeschverlangen (guest_erase_one) entfernt
-- die Adresse weiterhin sofort (siehe guest_email_redact am Ende).

CREATE OR REPLACE FUNCTION email_redact_old(p_property_id bigint, p_days integer DEFAULT 90)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer; v_alt integer;
BEGIN
  PERFORM assert_property_in_context(p_property_id);

  WITH betroffen AS (
    UPDATE outbound_email
       SET to_email = CASE WHEN kind = 'invoice' AND status = 'sent'
                           THEN to_email ELSE 'entfernt@invalid' END,
           to_name  = CASE WHEN kind = 'invoice' AND status = 'sent'
                           THEN to_name END,
           body_text = '',
           body_html = NULL,
           last_error = NULL,
           redacted_at = now()
     WHERE property_id = p_property_id
       AND redacted_at IS NULL
       AND status <> 'pending'
       AND created_at < now() - make_interval(days => p_days)
    RETURNING id
  ), versuche AS (
    UPDATE outbound_email_attempt a SET error = NULL
      FROM betroffen b
     WHERE a.email_id = b.id AND a.error IS NOT NULL
  )
  SELECT count(*) INTO v_count FROM betroffen;

  -- Nach sechs Jahren auch die Adresse des Nachweises.
  UPDATE outbound_email
     SET to_email = 'entfernt@invalid', to_name = NULL
   WHERE property_id = p_property_id
     AND kind = 'invoice'
     AND redacted_at IS NOT NULL
     AND to_email <> 'entfernt@invalid'
     AND created_at < now() - interval '6 years';
  GET DIAGNOSTICS v_alt = ROW_COUNT;

  RETURN v_count + v_alt;
END $$;

-- Ein Loeschverlangen faellt auch auf den Nachweis. guest_email_redact()
-- (0129) uebersprang bisher jede schon gealterte Zeile -- richtig, solange
-- Altern alles entfernte. Jetzt behaelt eine gealterte Rechnungsmail ihre
-- Adresse, und ohne die dritte Bedingung ueberlebte sie die Loeschung.
CREATE OR REPLACE FUNCTION guest_email_redact(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH betroffen AS (
    UPDATE outbound_email e
       SET to_email = 'entfernt@invalid', to_name = NULL,
           body_text = '', body_html = NULL, last_error = NULL,
           redacted_at = COALESCE(e.redacted_at, now())
     WHERE (e.redacted_at IS NULL OR e.last_error IS NOT NULL
            OR e.to_email <> 'entfernt@invalid')
       AND (EXISTS (SELECT 1 FROM reservation r
                     WHERE r.id = e.reservation_id AND r.primary_guest_id = p_guest)
            OR EXISTS (SELECT 1 FROM invoice i
                         JOIN folio f ON f.id = i.folio_id
                         JOIN reservation r2 ON r2.id = f.reservation_id
                        WHERE i.id = e.invoice_id AND r2.primary_guest_id = p_guest))
    RETURNING e.id
  )
  UPDATE outbound_email_attempt a SET error = NULL
    FROM betroffen b
   WHERE a.email_id = b.id AND a.error IS NOT NULL;
$$;
