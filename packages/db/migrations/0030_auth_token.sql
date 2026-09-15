-- Einmaltoken fuer Einladung und Kennwortruecksetzung, und die Warteschlange
-- fuer die Post, die sie verschickt (Aufgabe 13a, Dokument 16).
--
-- **Der Befund, der das ausloest.** app_user.status steht seit Migration 0002
-- auf 'invited' als Vorgabe -- das Modell erwartet also eine Einladung, die
-- nie gebaut wurde. Zugleich gibt es kein "Kennwort vergessen". Beides ist
-- derselbe Mechanismus: ein Einmaltoken, das per Mail zugeht und gegen das
-- ein neues Kennwort gesetzt wird. Sie unterscheiden sich in der
-- Gueltigkeitsdauer und im Text der Nachricht, sonst in nichts.
--
-- **Warum eine eigene Warteschlange neben outbound_email.** Die dortige ist
-- Gastpost, und zwar bis in die Pruefungen hinein: property_id NOT NULL, nur
-- die Arten 'invoice' und 'reservation_confirmation', und eine Bedingung, die
-- eine Rechnung oder eine Reservierung verlangt. email_enqueue weist
-- ausserdem Uebungshaeuser ab und haelt an, wenn der Versand am Haus nicht
-- eingeschaltet ist.
--
-- Fuer eine Anmeldemail waere jede dieser Regeln falsch. Sie gehoert zu einem
-- **Benutzer**, nicht zu einem Haus -- ein Benutzer kann in mehreren Haeusern
-- arbeiten oder, beim Onboarding, noch in keinem. Und ein Kunde, der den
-- Gastversand nie eingeschaltet hat, koennte sonst sein Kennwort nie
-- zuruecksetzen; das Uebungshaus aus db:testhotel ebenso wenig. Die Regel,
-- die den Gast schuetzt, wuerde hier den Zugang verhindern.

CREATE TABLE auth_token (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('invite', 'password_reset')),

  /*
   * Nur der Hash, nie das Token selbst. Wer die Datenbank liest -- eine
   * Sicherung, ein Auszug fuer den Steuerberater, ein Angreifer mit
   * Leserecht -- bekommt damit keinen Zugang. Das ist derselbe Grund, aus
   * dem app_user.password_hash kein Kennwort enthaelt.
   *
   * SHA-256 genuegt hier, wo bei einem Kennwort Argon2 stehen muss: das
   * Token hat 256 Bit Zufall und ist nicht zu erraten, ein Kennwort hat oft
   * zwanzig und muss deshalb teuer zu pruefen sein.
   */
  token_hash  text NOT NULL UNIQUE,

  expires_at  timestamptz NOT NULL,
  -- Einmal heisst einmal. Ein benutztes Token bleibt stehen, damit ein
  -- zweiter Versuch als solcher erkennbar ist, statt wie ein unbekanntes
  -- Token auszusehen.
  used_at     timestamptz,
  -- Wer eingeladen hat. Bei einer Ruecksetzung durch den Benutzer selbst
  -- leer: dort gibt es niemanden, der sie veranlasst haette.
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auth_token_window CHECK (expires_at > created_at)
);

-- Der Abrufpfad: ein Token wird ueber seinen Hash gesucht, sonst nie.
CREATE INDEX auth_token_offen ON auth_token (user_id, kind)
  WHERE used_at IS NULL;

/*
 * Post der Plattform an einen Benutzer.
 *
 * Absichtlich klein: Betreff und Rumpf fertig gerendert, kein Anhang, kein
 * Bezug zu einem Haus. Was hier liegt, ist nie Gastpost -- und was in
 * outbound_email liegt, ist nie Zugangspost. Die Trennung ist der Zweck der
 * Tabelle, nicht ihr Nebeneffekt.
 */
CREATE TABLE platform_email (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref  text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  user_id     bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('invite', 'password_reset')),

  to_email    text NOT NULL,
  to_name     text,
  subject     text NOT NULL,
  body_text   text NOT NULL,
  body_html   text,

  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE INDEX platform_email_faellig ON platform_email (next_attempt_at)
  WHERE status = 'pending';

/*
 * Keine Zeilenrichtlinie, und das ist Absicht: diese beiden Tabellen gehoeren
 * keinem Mandanten. Die Anwendungsrolle bekommt deshalb gezielte Rechte statt
 * eines Zugangs ueber eine Richtlinie.
 *
 * SELECT auf platform_email muss sein -- der Worker laeuft unter derselben
 * Rolle und muss lesen, was er verschicken soll. Das ist die unangenehme
 * Seite dieser Tabelle: solange eine Nachricht auf ihren Versand wartet,
 * steht das Token im Klartext in body_text, waehrend auth_token bewusst nur
 * dessen Hash haelt. Der Worker raeumt den Rumpf deshalb weg, sobald die
 * Nachricht durch ist (platformEmail.ts); das Fenster ist die Wartezeit in
 * der Warteschlange, nicht die Lebensdauer des Tokens.
 */
GRANT SELECT, INSERT, UPDATE ON auth_token TO hotelpms_app;
GRANT SELECT, INSERT, UPDATE ON platform_email TO hotelpms_app;

/*
 * Abgelaufene und benutzte Token raeumen. Sie sind nach ihrer Frist wertlos,
 * und eine Tabelle, die nur waechst, ist eine Tabelle, die irgendwann
 * gelesen wird.
 *
 * Nicht sofort nach der Benutzung: eine Woche Nachlauf laesst die Frage
 * "wurde die Einladung angenommen" noch beantworten.
 */
CREATE OR REPLACE FUNCTION auth_token_cleanup() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM auth_token
   WHERE (used_at IS NOT NULL AND used_at < now() - interval '7 days')
      OR (used_at IS NULL AND expires_at < now() - interval '7 days');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION auth_token_cleanup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_token_cleanup() TO hotelpms_app;
