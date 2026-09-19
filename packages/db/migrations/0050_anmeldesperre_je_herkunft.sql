-- Anmeldesperre je Paar aus Konto und Herkunft.
--
-- Befund H3 (Dokument 25): zehn Fehlversuche sperren ein Konto, und gesperrt
-- wird **nach Adresse, nicht nach Herkunft**. Wer die Dienstadresse einer
-- Mitarbeiterin kennt, kann sie von aussen aussperren, ohne je ein Kennwort
-- zu treffen. Die Abwaegung dahinter war bewusst und in ihrer Richtung
-- richtig -- ausgesperrt zu sein ist der groessere Schaden als ein
-- Durchprobieren, das die Ratenbegrenzung ohnehin bremst --, nur war sie
-- einseitig: dass die Sperre selbst eine Waffe ist, stand nirgends.
--
-- Bemerkenswert war dabei, dass bei der **PIN**-Sperre genau diese Falle
-- gesehen und vermieden wurde: dort zaehlt ein Fehlversuch nur, wenn der PIN
-- wirklich falsch war, ausdruecklich damit niemand einen Kollegen aussperren
-- kann. Eine Ebene hoeher fehlte dieselbe Ueberlegung.
--
-- Diese Tabelle traegt den Zaehler je Paar. Die Rezeption, die sich
-- vertippt, sperrt damit ihren Arbeitsplatz, nicht das Konto: eine Kollegin
-- am Nebenplatz und das Mobiltelefon der Leitung kommen weiter herein. Ein
-- Angreifer bekommt weiter zehn Versuche je Adresse, und dahinter steht die
-- Ratenbegrenzung je Herkunft (`apps/api/src/platform/rateLimit.ts`).
--
-- Kein Mandantenbezug und keine Zeilenrichtlinie, wie bei `user_session` und
-- aus demselben Grund: die Zeile entsteht, **bevor** es einen Kontext gibt.
-- Sie traegt auch keine Gastdaten, nur Konto, Adresse und Zahlen.

CREATE TABLE login_failure (
  user_id          bigint      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- Die Herkunft als Text, nicht als inet: was hier hereinkommt, ist das,
  -- was Caddy als X-Forwarded-For weitergibt, und eine Adresse, die sich
  -- nicht als inet lesen laesst, soll die Anmeldung nicht abbrechen.
  origin           text        NOT NULL,
  failed_count     integer     NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  first_failure_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, origin)
);

-- Fuer das Aufraeumen im Pflegejob.
CREATE INDEX login_failure_alter ON login_failure (last_failure_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON login_failure TO hotelpms_app;
