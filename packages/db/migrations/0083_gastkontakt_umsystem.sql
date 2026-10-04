-- ---------------------------------------------------------------------------
-- 0083 -- Kontaktdaten eines Gastes aus einem Umsystem.
--
-- Anforderung: Konzept "Gastdaten, Meldeschein und Gaestekarte" (04.10.2026,
-- Schritt 1). Von Hand angelegte Buchungen kennen Name, Zeitraum und Preis,
-- aber keine Mailadresse -- und ohne sie geht kein Link zum Online-Check-in
-- hinaus. Ein Umsystem des Hotels (beim ersten Kunden das Adminpanel, das
-- Buchungen aus Channelmanager und Hotelpost mit StayGrid abgleicht) kennt
-- sie und soll sie nachtragen koennen.
--
-- **Wer gewinnt.** Ein Umsystem rechnet mit einem Abgleich, und ein Abgleich
-- irrt. Was die Rezeption eingetragen oder der Gast selbst angegeben hat,
-- ueberschreibt es deshalb nie. Seine eigenen Werte darf es ersetzen und
-- zurueckziehen -- sonst bliebe nach einer korrigierten Zuordnung die Adresse
-- eines Fremden stehen, und der Check-in-Link ginge an ihn.
--
-- **Woher StayGrid das weiss.** `contact_origin` haelt je Feldgruppe (email,
-- phone, language, address), welches Umsystem sie zuletzt gesetzt hat. Den
-- Eintrag entfernt der Trigger unten, sobald sich der Wert auf einem anderen
-- Weg aendert. Das ist die eine Stelle, die jeden Weg sieht: Gastmaske,
-- Online-Check-in, Meldeschein, Anonymisierung. Eine Pflicht in jeder Route,
-- die Herkunft mitzuraeumen, waere eine, die die naechste Route vergisst.
-- ---------------------------------------------------------------------------

ALTER TABLE guest ADD COLUMN contact_origin jsonb NOT NULL DEFAULT '{}';

/*
 * Der Eintrag bleibt nur, solange der Wert der des Umsystems ist.
 *
 * Wer den Wert aendert und den Eintrag nicht mitschreibt, ist nicht das
 * Umsystem -- also faellt der Eintrag weg, und der Wert gehoert ab jetzt dem,
 * der ihn gesetzt hat. Die Route fuer Umsysteme schreibt Wert und Eintrag in
 * derselben Anweisung, und der Eintrag traegt einen Zeitpunkt, aendert sich
 * also immer mit.
 *
 * Ein anonymisiertes Profil behaelt keinen: der Verweis auf die Buchung im
 * Umsystem fuehrt zu genau dem Menschen, den die Loeschung entfernt hat.
 */
CREATE OR REPLACE FUNCTION guest_contact_origin_keep()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := NEW.contact_origin;
BEGIN
  IF NEW.status = 'anonymized' THEN
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

CREATE TRIGGER guest_contact_origin_keep
  BEFORE UPDATE ON guest
  FOR EACH ROW EXECUTE FUNCTION guest_contact_origin_keep();

/*
 * Ins Protokoll nicht im Klartext: der Eintrag nennt die Buchungsnummer im
 * Umsystem, und die fuehrt zu einem Menschen (CLAUDE.md, Migration 0044).
 */
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('guest', 'contact_origin', 'Verweis auf die Buchung im Umsystem');

/*
 * Ein eigenes Recht statt `guest:write`. Ein Umsystem soll Kontaktdaten
 * nachtragen koennen, nicht Namen aendern, Profile zusammenfuehren oder eine
 * Ausweisnummer setzen. Keiner Rolle zugeordnet: es ist fuer Maschinenzugaenge
 * gedacht, und die Rezeption hat mit `guest:write` ohnehin mehr.
 */
INSERT INTO permission (key, grp, description) VALUES
  ('guest:contact_write', 'Gaeste', 'Kontaktdaten aus einem Umsystem nachtragen')
ON CONFLICT DO NOTHING;
