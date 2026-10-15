-- ---------------------------------------------------------------------------
-- 0174 -- Der Betreff einer Rechnungsmail ist frei, also faellt er unter die
-- Loeschung.
--
-- Anlass: Sven, 15.10.2026 -- "manchmal wollen portale wie hrs mit seinem
-- rechnungssystem die buchungsnummer im emailbetreff. wir muessten den
-- emailbetreff also aendern koennen". POST /v1/invoices/{ref}/send nimmt
-- deshalb einen eigenen Betreff an.
--
-- Bisher war jeder Betreff aus einer Vorlage und trug hoechstens die
-- Rechnungsnummer und den Namen des Hauses. Ein frei getippter Betreff kann
-- dagegen eine Buchungsnummer des Portals oder den Namen des Gastes tragen,
-- und guest_email_redact() liess `subject` stehen. Jetzt leert es ihn mit
-- Adresse und Rumpf. Der Versandnachweis behaelt Zeitpunkt, Kennung des
-- Anbieters und Pruefsumme des Belegs; der Betreff war nie der Nachweis.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guest_email_redact(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH betroffen AS (
    UPDATE outbound_email e
       SET to_email = 'entfernt@invalid', to_name = NULL,
           subject = 'entfernt',
           body_text = '', body_html = NULL, last_error = NULL,
           redacted_at = COALESCE(e.redacted_at, now())
     WHERE (e.redacted_at IS NULL OR e.last_error IS NOT NULL
            OR e.to_email <> 'entfernt@invalid' OR e.subject <> 'entfernt')
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
