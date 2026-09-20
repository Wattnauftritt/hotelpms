-- ---------------------------------------------------------------------------
-- 0053 -- Das eigene Konto verwalten: Kennwort und Mailadresse aendern.
--
-- Befund aus dem Betrieb, zwei Haelften desselben Lochs:
--
--   1. Plattformpersonal kam im Adminpanel nirgends zum Abmelden. Der Knopf
--      sitzt in der Kopfleiste, und das Adminpanel wurde daneben gerendert,
--      nicht darin.
--   2. Niemand -- weder Plattformpersonal noch ein Hotelbenutzer -- konnte
--      sein eigenes Kennwort oder seine Mailadresse aendern. Es gab nur den
--      Weg "Kennwort vergessen", also einen Link an die Adresse, die man
--      gerade aendern wollte.
--
-- Die zweite Haelfte braucht Schema, und zwar wegen der Mailadresse. Die
-- Adresse **ist** die Anmeldung. Wer sie auf einen Tippfehler aendert, kommt
-- nicht mehr herein und auch nicht mehr an eine Ruecksetzung -- der Link
-- ginge an die falsche Adresse. Ein stiller, endgueltiger Verlust.
--
-- Deshalb wird sie nicht gesetzt, sondern **bestaetigt**: die neue Adresse
-- liegt am Token, und erst das Einloesen schreibt sie in app_user. Ein
-- Tippfehler wird damit einfach nie bestaetigt, und es geht nichts verloren.
--
-- Dazu ein Hinweis an die **alte** Adresse. Wer eine geliehene Sitzung
-- uebernimmt, wuerde sonst lautlos das Konto an sich ziehen; so faellt es
-- dem Betroffenen in dem Moment auf, in dem es passiert.
-- ---------------------------------------------------------------------------

ALTER TABLE auth_token DROP CONSTRAINT auth_token_kind_check;
ALTER TABLE auth_token ADD CONSTRAINT auth_token_kind_check
  CHECK (kind IN ('invite', 'password_reset', 'email_change'));

/*
 * Die gewuenschte Adresse. Nur hier und nicht in app_user, denn in app_user
 * steht, womit man sich anmeldet -- und das ist bis zur Bestaetigung die
 * alte. Ein zweites Feld dort ("pending_email") waere dieselbe Angabe an
 * einer Stelle, an der sie jede Abfrage mitliest, die nach Adressen sucht.
 */
ALTER TABLE auth_token ADD COLUMN new_email text;

COMMENT ON COLUMN auth_token.new_email IS
  'Die gewuenschte Mailadresse. Nur bei kind = email_change gesetzt.';

-- Ein Aenderungstoken ohne Zieladresse waere ein Token, das nichts tut; eine
-- Zieladresse an einem Einladungstoken waere eine Angabe, die niemand liest.
ALTER TABLE auth_token ADD CONSTRAINT auth_token_new_email_check CHECK (
  (kind = 'email_change' AND new_email IS NOT NULL)
  OR (kind <> 'email_change' AND new_email IS NULL)
);

/*
 * Bewusst auf die Redaktionsliste, obwohl auth_token heute gar nicht
 * auditiert wird (kein attach_audit in 0002 bis 0052). Der Eintrag ist
 * damit wirkungslos -- und genau deshalb richtig: wer die Tabelle spaeter
 * unter Audit stellt, soll nicht daran denken muessen, dass in ihr eine
 * Mailadresse liegt. Die Regel aus CLAUDE.md gilt fuer die Spalte, nicht
 * fuer den Zeitpunkt.
 */
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('auth_token', 'new_email', 'Kontaktdatum')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Zwei neue Arten Zugangspost.
--
-- `email_change`        -- der Bestaetigungslink an die **neue** Adresse.
-- `email_change_notice` -- der Hinweis an die **alte**. Ohne Link, und das
--                          ist Absicht: er meldet, er fordert nicht auf.
--                          Ein Link in einer Nachricht ueber eine Aenderung,
--                          die man nicht veranlasst hat, ist die Bauform
--                          jeder Phishing-Mail.
-- ---------------------------------------------------------------------------

ALTER TABLE platform_email DROP CONSTRAINT platform_email_kind_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_kind_check
  CHECK (kind IN ('invite', 'password_reset', 'support_request',
                  'domain_request', 'email_change', 'email_change_notice'));

-- Die Bedingung aus 0052 nennt die Arten, die ohne Benutzer auskommen.
-- Beide neuen gehoeren zu einem Benutzer, also bleibt sie, wie sie ist --
-- hier steht nur, dass das geprueft wurde und kein Versehen ist.
