-- ---------------------------------------------------------------------------
-- 0107 -- Eine Reservierung von einem geteilten Gastprofil abtrennen.
--
-- Anforderung: Sven, 07.10.2026, ueber das Adminpanel (Thread "falsche
-- Vornamen"). In der Anreiseliste standen Vornamen aus fremden Buchungen.
--
-- Ursache: Der KWHotel-Import legt ein Profil je KWHotel-Gast an, nicht je
-- Reservierung (kwhotelImport.ts). In KWHotel steht unter einem Gastsatz
-- aber oft mehr als ein Mensch. Seit dem 04.10. schreiben der Meldeschein
-- aus dem Adminpanel (0087) und der Gastkontakt (0086) Namen ins Profil
-- des Hauptgastes -- und damit in jede Reservierung, die an demselben
-- Profil haengt. Der Meldeschein selbst traegt keinen Namen, er zeigt das
-- Profil: ein spaeterer Schein schrieb so auch den Namen auf einem frueheren
-- um.
--
-- Zwei Funktionen, beide SECURITY DEFINER:
--
-- * `guest_is_shared` muss ueber alle Haeuser des Accounts sehen. Ein
--   Maschinenzugang mit nur einem Haus saehe die Reservierung im anderen
--   nicht und hielte das Profil fuer seines.
-- * `guest_split_reservations` setzt auch `guest_agreement.guest_id` um.
--   Die Anwendungsrolle hat darauf kein UPDATE (0036), und das bleibt so:
--   die Zustimmung wechselt hier nicht den Inhalt, nur das Profil, an dem
--   sie haengt -- und die Reservierung, zu der sie gehoert, bleibt dieselbe.
-- ---------------------------------------------------------------------------

/*
 * Haengt das Profil noch an etwas anderem als dieser Reservierung?
 *
 * Gezaehlt wird, was einen Namen zeigt: der Hauptgast einer anderen
 * Reservierung, ein Mitreisender oder ein Meldeschein dort. Eine Notiz des
 * Hauses und die Buchung als Bucher zeigen keinen Aufenthalt.
 *
 * Nur fuer ein Profil im eigenen Account; sonst sagte die Antwort einem
 * fremden Mandanten, ob eine Kennung irgendwo belegt ist.
 */
CREATE OR REPLACE FUNCTION guest_is_shared(p_guest bigint, p_reservation bigint)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM guest WHERE id = p_guest
                    AND account_id = ANY (app_account_ids())) THEN
    RAISE EXCEPTION 'guest_is_shared: Profil ausserhalb des Kontexts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN EXISTS (SELECT 1 FROM reservation
                  WHERE primary_guest_id = p_guest AND id <> p_reservation)
      OR EXISTS (SELECT 1 FROM reservation_occupant
                  WHERE guest_id = p_guest AND reservation_id <> p_reservation)
      OR EXISTS (SELECT 1 FROM registration
                  WHERE guest_id = p_guest AND reservation_id <> p_reservation);
END $$;

/*
 * Jede genannte Reservierung bekommt ein eigenes Profil.
 *
 * **Was mitgeht:** Nachname, Land und Sprache -- das, was der KWHotel-Import
 * angelegt hat. Kein Vorname, keine Mailadresse, kein Telefon, keine
 * Anschrift: die stehen am geteilten Profil, ohne dass sich sagen laesst,
 * zu welchem Aufenthalt sie gehoeren. Eine Mailadresse des falschen
 * Menschen ist schlimmer als keine; an sie ginge der Link zum Online-Check-in.
 * Das Umsystem traegt die Kontaktdaten beim naechsten Abgleich je
 * Reservierung nach.
 *
 * **Was umzieht:** alles, was an dieser Reservierung auf das alte Profil
 * zeigt -- Hauptgast, Mitreisendenzeile, Folio, Meldeschein, Zustimmung.
 * Die Buchung nur, wenn keine ihrer Reservierungen mehr am alten Profil
 * haengt; sonst bleibt der Bucher, wer er war.
 *
 * **Ein offener Link zum Online-Check-in per Mail** ging an die Adresse des
 * geteilten Profils. Er wird zurueckgezogen wie bei einer korrigierten
 * Adresse (0084); der Worker laedt neu ein, sobald das Profil eine hat.
 *
 * In einer Schleife statt mengenbasiert: je Reservierung sind es sechs
 * Anweisungen ueber den Primaerschluessel, und die Zuordnung "neues Profil
 * zu dieser Reservierung" bleibt so ohne Hilfstabelle eindeutig.
 */
CREATE OR REPLACE FUNCTION guest_split_reservations(p_reservations bigint[])
RETURNS TABLE (out_reservation_id bigint, out_old_guest bigint, out_new_guest bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r     record;
  v_neu bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(p_reservations) AS x(id)
      LEFT JOIN reservation res ON res.id = x.id
     WHERE res.id IS NULL OR NOT (res.property_id = ANY (app_property_ids()))) THEN
    RAISE EXCEPTION 'guest_split_reservations: Reservierung ausserhalb des Kontexts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR r IN
    SELECT res.id, res.property_id, res.booking_id, res.primary_guest_id,
           g.account_id, g.last_name, g.country, g.language, g.status
      FROM reservation res
      JOIN guest g ON g.id = res.primary_guest_id
     WHERE res.id = ANY (p_reservations)
     ORDER BY res.id
       FOR UPDATE OF res
  LOOP
    -- Ein geloeschtes Profil wird nicht vervielfaeltigt; der Name darin
    -- ist ohnehin "Anonymisiert".
    IF r.status = 'anonymized' THEN
      CONTINUE;
    END IF;

    INSERT INTO guest (account_id, last_name, country, language)
    VALUES (r.account_id, r.last_name, r.country, r.language)
    RETURNING id INTO v_neu;

    UPDATE reservation SET primary_guest_id = v_neu WHERE id = r.id;
    UPDATE reservation_occupant SET guest_id = v_neu
     WHERE reservation_id = r.id AND guest_id = r.primary_guest_id;
    UPDATE folio SET guest_id = v_neu
     WHERE reservation_id = r.id AND guest_id = r.primary_guest_id;
    UPDATE registration SET guest_id = v_neu
     WHERE reservation_id = r.id AND guest_id = r.primary_guest_id;
    UPDATE guest_agreement SET guest_id = v_neu
     WHERE reservation_id = r.id AND guest_id = r.primary_guest_id;
    UPDATE booking SET booker_guest_id = v_neu
     WHERE id = r.booking_id AND booker_guest_id = r.primary_guest_id
       AND NOT EXISTS (SELECT 1 FROM reservation o
                        WHERE o.booking_id = r.booking_id
                          AND o.primary_guest_id = r.primary_guest_id);
    UPDATE checkin_token SET revoked_at = now(), revoke_reason = 'contact_changed'
     WHERE reservation_id = r.id AND channel = 'mail' AND revoked_at IS NULL;

    out_reservation_id := r.id;
    out_old_guest := r.primary_guest_id;
    out_new_guest := v_neu;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION guest_is_shared(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guest_is_shared(bigint, bigint) TO hotelpms_app;
REVOKE EXECUTE ON FUNCTION guest_split_reservations(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guest_split_reservations(bigint[]) TO hotelpms_app;
