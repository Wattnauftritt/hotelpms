-- ---------------------------------------------------------------------------
-- 0194 Standardhaus je Benutzer
--
-- Sven, 21.10.2026: "ein Standardhaus auswaehlen, mit dem man generell
-- starten will, eventuell pro Benutzer individuell". Bisher startete jede
-- Anmeldung im ersten Haus nach Kuerzel -- wer hauptsaechlich im Gaestehaus
-- arbeitet, wechselte bei jedem Start von Hand.
--
-- **Am Benutzer, nicht am Geraet.** Die App auf dem Telefon und der Rechner
-- an der Rezeption sollen gleich starten, und ein Rezeptionsrechner wird von
-- mehreren geteilt: eine Ablage im Browser gaelte fuer den, der zuletzt
-- davorsass.
--
-- **Kein Recht.** Die Spalte sagt nur, wo die Oberflaeche beginnt. Verliert
-- jemand den Zugriff auf das Haus, bleibt der Wert stehen und wird beim
-- Lesen uebergangen (`/v1/auth/me`) -- dann startet er wie bisher im ersten
-- Haus, auf das er Zugriff hat, und bekommt das Haus zurueck, sobald der
-- Zugriff zurueckkommt.
--
-- Die Hausnummer bezeichnet keinen Menschen und ist kein Geheimnis; sie
-- gehoert deshalb nicht in `audit_redaction`.
-- ---------------------------------------------------------------------------

ALTER TABLE app_user
  ADD COLUMN default_property_id bigint REFERENCES property(id) ON DELETE SET NULL;
