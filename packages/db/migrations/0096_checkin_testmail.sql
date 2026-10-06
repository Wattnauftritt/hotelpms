-- ---------------------------------------------------------------------------
-- 0096 -- Testmail fuer die Einladung zum Online-Check-in.
--
-- Anforderung aus dem Betrieb (Sven, 06.10.2026): den Vorabversand des
-- Meldeformulars vorbereiten und vorher pruefen koennen, ob Versand und
-- Aussehen stimmen -- mit einer Testmail an eine Adresse nach Wahl, ohne
-- einen echten Gast anzuschreiben.
--
-- Eine eigene Art und nicht 'checkin_invitation': die Einladung haengt an
-- einer Reservierung (0061), damit guest_erase_one() sie findet. Eine
-- Testmail hat keinen Gast und keine Reservierung; sie unter der Gastart
-- zu fuehren hiesse, eine Reservierung zu erfinden oder die Bezugsregel
-- fuer echte Einladungen aufzuweichen. Hier ist der Bezug ausdruecklich
-- leer -- auch das haelt die Bedingung fest, damit niemand eine Testmail
-- an eine echte Buchung haengt.
--
-- Durch email_enqueue geht sie trotzdem: Uebungshaus, eingeschalteter
-- Versand und freigeschaltete Absenderdomain gelten fuer sie wie fuer jede
-- Gastpost. Genau das soll der Test ja zeigen.
-- ---------------------------------------------------------------------------

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_kind_check;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_kind_check
  CHECK (kind IN ('invoice','reservation_confirmation','payment_link',
                  'checkin_invitation','checkin_invitation_test'));

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_bezug;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_bezug CHECK (
  (kind = 'invoice' AND invoice_id IS NOT NULL) OR
  (kind IN ('reservation_confirmation','payment_link','checkin_invitation')
     AND reservation_id IS NOT NULL) OR
  (kind = 'checkin_invitation_test'
     AND invoice_id IS NULL AND reservation_id IS NULL));
