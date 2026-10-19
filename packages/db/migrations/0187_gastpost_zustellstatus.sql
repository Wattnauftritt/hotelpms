-- ---------------------------------------------------------------------------
-- Gastpost: Zustellstatus vom Anbieter nachfragen.
--
-- Anlass (19.10.2026): Booking.com-Gaeste bekamen den Link zum Meldeformular
-- nicht, StayGrid zeigte "Link verschickt". `status = 'sent'` heisst aber nur,
-- dass Brevo die Nachricht angenommen hat (siehe Kommentar an der Spalte).
-- Ob der Server des Empfaengers sie nahm, abwies oder Brevo sie gar nicht
-- erst zustellte, stand nirgends -- und genau das war die Frage.
--
-- Der Worker fragt Brevo deshalb nach dem Senden in wachsenden Abstaenden
-- nach den Ereignissen der Nachricht, bis ein endgueltiger Stand da ist oder
-- die Versuche aufgebraucht sind. Nachfragen statt Webhook: keine neue
-- oeffentliche Adresse, kein Geheimnis, das bei Brevo eingetragen werden
-- muss, und bei der Menge eines Hotels ist die Verzoegerung gleichgueltig.
--
-- **Kein Gastdatum in den neuen Spalten.** Ein Abweisungsgrund nennt oft die
-- Empfaengeradresse ("550 5.1.1 <x@y>: unknown user"). Der Worker ersetzt
-- jede Adresse darin, bevor er schreibt; damit muessen weder die Loeschung
-- noch email_redact_old() die Spalte kennen. Kein Audit-Trigger auf
-- outbound_email, also auch kein Eintrag in `audit_redaction`.
-- ---------------------------------------------------------------------------

ALTER TABLE outbound_email
  ADD COLUMN delivery_status text
    CHECK (delivery_status IN ('accepted','delivered','deferred','soft_bounce',
                               'hard_bounce','invalid','blocked','spam','error')),
  ADD COLUMN delivery_reason text,
  ADD COLUMN delivery_event_at timestamptz,
  ADD COLUMN delivery_checks smallint NOT NULL DEFAULT 0,
  ADD COLUMN delivery_next_check_at timestamptz;

COMMENT ON COLUMN outbound_email.delivery_status IS
  'Letzter Stand beim Anbieter nach dem Senden. NULL: noch nicht nachgefragt. accepted: angenommen, noch kein Ergebnis beim Empfaenger.';
COMMENT ON COLUMN outbound_email.delivery_next_check_at IS
  'Wann der Worker wieder nachfragt. NULL: nichts mehr nachzufragen.';

-- Der Abholpfad der Nachfrage, partiell wie outbound_email_due: die meisten
-- Zeilen sind erledigt und haben hier nichts zu suchen.
CREATE INDEX outbound_email_delivery_due
  ON outbound_email (property_id, delivery_next_check_at)
  WHERE delivery_next_check_at IS NOT NULL;

-- Was in den letzten zwei Wochen hinausging, wird einmal nachgefragt. So
-- beantwortet sich die Frage nach den Booking.com-Gaesten auch fuer die
-- Einladungen, die schon draussen sind. Aelteres haelt Brevo je nach Vertrag
-- nicht mehr vor.
UPDATE outbound_email
   SET delivery_next_check_at = now()
 WHERE status = 'sent'
   AND provider_message_id IS NOT NULL
   AND sent_at > now() - interval '14 days';
