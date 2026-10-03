-- ---------------------------------------------------------------------------
-- 0077 -- Gastkorrektur und Anonymisierung melden sich per Webhook.
--
-- Anforderung: API-Entwurf fuers Adminpanel (03.10.2026), Abschnitt 3.2.
-- Aendert sich der Name oder die Mailadresse des Hauptgastes oder wird er
-- anonymisiert, steht das in der Reservierungsliste anders da -- aber kein
-- Ereignis sagte es. Ein Empfaenger, der sich auf Webhooks verlaesst, hielt
-- dann einen Namen, den es in StayGrid nicht mehr gibt, bis zum naechsten
-- Vollabzug. Bei einer Loeschung nach Art. 17 ist genau das der Fehler.
--
-- **Warum im Trigger und nicht in den Routen.** Ein Gast wird an drei
-- Stellen geaendert: in der Gastmaske, in der Anonymisierung und im
-- Nachtlauf, der aufgeschobene Loeschungen nach Fristende vollendet. Der
-- Nachtlauf hat keinen Zugang zu `emitEvent`, und drei Stellen, die
-- dasselbe melden muessen, sind zwei, an denen es vergessen wird
-- (CLAUDE.md: geloescht wird an einer Stelle). Der Trigger aus 0075 sieht
-- ohnehin genau die Zeilen, die sich in der Liste aendern; er meldet sie
-- jetzt auch.
--
-- **Was im Rumpf steht.** Keine Gastdaten: `reservationRef`, `bookingRef`,
-- Zustand, Cursorstand und welche Art Aenderung (`guest` oder
-- `guestAnonymized`). Das Ereignis heisst "jetzt nachfragen"; den Namen
-- holt der Empfaenger ueber die Liste, und nach einer Anonymisierung steht
-- dort keiner mehr.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservation_change_from_guest()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  z   record;
  ids bigint[] := ARRAY[]::bigint[];
BEGIN
  -- Ein Ereignis je Reservierung, wie bei jeder anderen Aenderung: das
  -- Abonnement filtert nach Haus, und ein Gast kann in mehreren wohnen.
  FOR z IN
    SELECT r.id, r.property_id, r.public_ref AS reservation_ref,
           b.public_ref AS booking_ref, r.status::text AS status,
           (n.status = 'anonymized' AND a.status IS DISTINCT FROM 'anonymized') AS anonymisiert
      FROM neu n
      JOIN alt a ON a.id = n.id
      JOIN reservation r ON r.primary_guest_id = n.id
      JOIN booking b ON b.id = r.booking_id
     WHERE n.last_name  IS DISTINCT FROM a.last_name
        OR n.first_name IS DISTINCT FROM a.first_name
        OR n.email      IS DISTINCT FROM a.email
        OR n.status     IS DISTINCT FROM a.status
     ORDER BY r.id
  LOOP
    ids := ids || z.id;
    PERFORM webhook_enqueue(z.property_id, 'reservation.changed', jsonb_build_object(
      'reservationRef', z.reservation_ref,
      'bookingRef',     z.booking_ref,
      'status',         z.status,
      'cursor',         pg_current_xact_id()::text || '.0',
      'changed',        jsonb_build_array(
                          CASE WHEN z.anonymisiert THEN 'guestAnonymized' ELSE 'guest' END)));
  END LOOP;

  PERFORM reservation_change_touch(ids);
  RETURN NULL;
END $$;
