-- ---------------------------------------------------------------------------
-- 0190 -- Einladungen, die Booking.com verschluckt hat, einmal neu senden.
--
-- Anlass: Sven, 19.10.2026 (Thread "Meldeformulare an Booking-Gaeste").
-- Booking.com leitet Mails an die Aliasadressen der Gaeste (@guest.booking.com)
-- nur weiter, wenn der Absender im Extranet des Hauses eingetragen ist. Der
-- Absender von StayGrid war es nicht. Der Server von Booking.com hat die Mail
-- trotzdem angenommen -- Brevo meldete "zugestellt" (0187) -- und sie dann
-- still verworfen. Seit der Uebernahme des Versands vom Adminpanel (04.10.)
-- hat damit kein Booking.com-Gast seinen Link bekommen.
--
-- Der Absender ist inzwischen eingetragen. Der Worker laedt aber jede
-- Reservierung nur einmal ein, und fuer ihn gelten diese Links als
-- verschickt. Sie werden deshalb mit einem eigenen Grund zurueckgezogen; ein
-- Link mit Grund zaehlt fuer "genau einmal" nicht mehr (0084), und der
-- naechste Lauf laedt neu ein -- mit allen Bedingungen, die sonst gelten:
-- Fenster vor Anreise, nicht am Anreisetag, Versand an, kein Uebungshaus.
--
-- Betroffen ist nur, was noch etwas nuetzt: die Einladung ging an eine
-- Adresse von guest.booking.com, die Anreise liegt nach dem Geschaeftstag des
-- Hauses, und es gibt noch keinen Meldeschein. Ein Link, den die Rezeption
-- von Hand zurueckgezogen hat, bleibt zurueckgezogen.
--
-- Der Grund ist ein eigener und nicht 'contact_changed': die Adresse war
-- richtig. Wer spaeter fragt, warum ein Gast zwei Einladungen bekam, soll es
-- an der Zeile ablesen koennen.
-- ---------------------------------------------------------------------------

ALTER TABLE checkin_token DROP CONSTRAINT checkin_token_revoke_reason_check;
ALTER TABLE checkin_token ADD CONSTRAINT checkin_token_revoke_reason_check
  CHECK (revoke_reason IN ('contact_changed', 'channel_dropped'));

UPDATE checkin_token t
   SET revoked_at = now(), revoke_reason = 'channel_dropped'
  FROM reservation r
 WHERE r.id = t.reservation_id
   AND t.channel = 'mail'
   AND t.revoked_at IS NULL
   AND t.completed_at IS NULL
   AND r.status = 'Confirmed'
   AND r.arrival > COALESCE(
         (SELECT max(b.date) FROM business_day b
           WHERE b.property_id = r.property_id AND b.status = 'open'),
         current_date)
   AND NOT EXISTS (SELECT 1 FROM registration reg WHERE reg.reservation_id = r.id)
   AND EXISTS (SELECT 1 FROM outbound_email e
                WHERE e.reservation_id = r.id
                  AND e.kind = 'checkin_invitation'
                  AND e.status = 'sent'
                  AND lower(e.to_email) LIKE '%@guest.booking.com');
