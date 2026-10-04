-- ---------------------------------------------------------------------------
-- 0084 -- Ein Check-in-Link, der an eine falsche Adresse ging, wird ersetzt.
--
-- Anforderung: Sven, 04.10.2026 (Konzept "Gastdaten, Meldeschein und
-- Gaestekarte"). Ein Umsystem traegt die Mailadresse aus seinem Abgleich ein
-- (0083), und der Abgleich wird spaeter korrigiert. War der Link bis dahin
-- schon hinaus, liegt er bei einem Fremden -- und der richtige Gast bekommt
-- keinen, weil der Worker jede Reservierung nur einmal einlaedt.
--
-- Korrigiert das Umsystem seine eigene Adresse, zieht StayGrid die offenen
-- Mail-Links deshalb zurueck und vermerkt den Grund. Ein so zurueckgezogener
-- Link zaehlt fuer "genau einmal" nicht mehr: der naechste Lauf laedt an die
-- neue Adresse ein, mit allen Bedingungen, die sonst auch gelten (Fenster vor
-- Anreise, Versand eingeschaltet, kein Uebungshaus).
--
-- Ein Widerruf der Rezeption bleibt ohne Grund und damit endgueltig: wer
-- einen Link von Hand zurueckzieht, will nicht, dass der naechste Lauf einen
-- neuen schickt.
-- ---------------------------------------------------------------------------

ALTER TABLE checkin_token ADD COLUMN revoke_reason text
  CHECK (revoke_reason IN ('contact_changed'));

GRANT UPDATE (revoke_reason) ON checkin_token TO hotelpms_app;

-- Die Bedingung, die zwei gleichzeitige Laeufe abhaelt, kennt den Grund mit:
-- ein wegen Adresswechsels zurueckgezogener Link verlaesst den Index.
DROP INDEX checkin_token_auto_einmal;
CREATE UNIQUE INDEX checkin_token_auto_einmal ON checkin_token (reservation_id)
  WHERE channel = 'mail' AND created_by IS NULL AND revoke_reason IS NULL;


-- Die Ausgabe nennt den Index in ihrem ON CONFLICT; die Bedingung muss
-- dieselbe sein, sonst findet PostgreSQL ihn nicht. Unveraendert bis auf
-- diese eine Zeile.
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
  ON CONFLICT (reservation_id)
    WHERE channel = 'mail' AND created_by IS NULL AND revoke_reason IS NULL
  DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN;
  END IF;
  issued_id := v_id;
  issued_until := v_bis;
  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------
-- Mitbehoben an 0083: die Herkunft der Kontaktdaten fiel nur bei voller
-- Anonymisierung weg. `guest_erase_partial` leert Mail und Telefon (der
-- Trigger nimmt deren Eintrag mit), behaelt aber die Anschrift fuer den
-- Gaestebeitragsnachweis -- und mit ihr den Verweis auf die Buchung im
-- Umsystem, der fuer diesen Nachweis nichts traegt. Ab dem Loeschantrag
-- haelt das Profil deshalb keine Herkunft mehr.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guest_contact_origin_keep()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := NEW.contact_origin;
BEGIN
  IF NEW.status = 'anonymized' OR NEW.erasure_requested_at IS NOT NULL THEN
    NEW.contact_origin := '{}';
    RETURN NEW;
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email
     AND o -> 'email' IS NOT DISTINCT FROM OLD.contact_origin -> 'email' THEN
    o := o - 'email';
  END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone
     AND o -> 'phone' IS NOT DISTINCT FROM OLD.contact_origin -> 'phone' THEN
    o := o - 'phone';
  END IF;
  IF NEW.language IS DISTINCT FROM OLD.language
     AND o -> 'language' IS NOT DISTINCT FROM OLD.contact_origin -> 'language' THEN
    o := o - 'language';
  END IF;
  IF (NEW.address_line1, NEW.postal_code, NEW.city, NEW.country)
       IS DISTINCT FROM (OLD.address_line1, OLD.postal_code, OLD.city, OLD.country)
     AND o -> 'address' IS NOT DISTINCT FROM OLD.contact_origin -> 'address' THEN
    o := o - 'address';
  END IF;
  NEW.contact_origin := o;
  RETURN NEW;
END $$;
