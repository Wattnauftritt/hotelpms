-- ---------------------------------------------------------------------------
-- 0086 -- Vorname des Gastes aus einem Umsystem.
--
-- Anforderung: Sven, 04.10.2026. Der KWHotel-Import legt Gaeste mit
-- Nachname und Land an; der Vorname fehlt, und der Meldeschein braucht ihn.
-- Das Adminpanel kennt ihn aus der RoomCloud-Buchung und soll ihn nachtragen
-- koennen -- nach derselben Regel wie Mail und Telefon (0083): nur ein leeres
-- Feld fuellen, nur den eigenen Wert ersetzen oder zurueckziehen.
--
-- Der Nachname kommt nicht dazu. An ihm haengt der Abgleich selbst; ein
-- abweichender Nachname heisst, die Zuordnung ist falsch, nicht der Name.
--
-- Hier nur der Trigger: er muss den Eintrag `firstName` genauso wegnehmen,
-- sobald jemand den Vornamen auf einem anderen Weg aendert. `first_name`
-- steht seit 0044 in `audit_redaction`.
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
  IF NEW.first_name IS DISTINCT FROM OLD.first_name
     AND o -> 'firstName' IS NOT DISTINCT FROM OLD.contact_origin -> 'firstName' THEN
    o := o - 'firstName';
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
