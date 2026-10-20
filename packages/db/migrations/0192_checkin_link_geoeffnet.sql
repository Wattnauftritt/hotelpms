-- ---------------------------------------------------------------------------
-- Online-Check-in: vermerken, wann der Gast den Link zum ersten Mal oeffnet.
--
-- Anlass (20.10.2026): Booking.com-Gaeste bekamen das Meldeformular nicht,
-- obwohl Brevo "zugestellt" meldete (0187) und der Absender im Extranet
-- freigegeben war. Zugestellt heisst bei Booking.com nur: deren Server hat
-- angenommen. Ob die Nachricht im Verlauf des Gastes ankam, sagt kein
-- Anbieter. Ob der Gast den Link geoeffnet hat, wissen wir dagegen selbst --
-- der Link fuehrt auf unsere Seite.
--
-- **Kein Klick-Tracking beim Anbieter.** Brevos Tracking leitet den Link ueber
-- eine eigene Domain um: Booking.com entfernt solche Links, und das Token des
-- Gastes laege dabei bei einem Dritten. Ein Oeffnungspixel gibt es ebenfalls
-- nicht; vermerkt wird nur, was der Gast auf unserer Seite ohnehin tut.
--
-- Geschrieben wird beim ersten Abruf des Formulars durch die Seite, nicht beim
-- Laden der Adresse: ein Linkpruefer im Postfach ruft die Adresse ab, fuehrt
-- aber kein Skript aus. Ein Zeitpunkt ist kein Gastdatum; die Loeschung muss
-- die Spalte nicht kennen, und auf checkin_token liegt kein Audit-Trigger.
-- ---------------------------------------------------------------------------

ALTER TABLE checkin_token ADD COLUMN opened_at timestamptz;

COMMENT ON COLUMN checkin_token.opened_at IS
  'Erster Abruf des Formulars durch den Gast, ohne Anmeldung. NULL: nie geoeffnet.';

GRANT UPDATE (opened_at) ON checkin_token TO hotelpms_app;
