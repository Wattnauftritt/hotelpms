-- Stufe der Support-Sitzung und die Post, die den Kunden davon unterrichtet
-- (Aufgabe 13c, Dokument 16).
--
-- **Der Befund.** Die Tabelle steht seit Migration 0002, applySupportSession
-- setzt den Mandantenkontext, und das Protokoll fuehrt die
-- support_session_id mit. Nur wirken konnte die Sitzung nie: sie vergibt
-- permissionsByProperty mit **leeren** Rechtemengen, waehrend der Kommentar
-- daneben "die Rechte einer Hoteldirektion" verspricht. Eine freigegebene
-- Sitzung bekam damit auf jeder Fachroute 403. Der Test dazu prueft
-- accountIds und supportSessionId -- also dass der Kontext gesetzt ist, nicht
-- dass jemand damit arbeiten kann.
--
-- **Warum eine Stufe und nicht ein festes Rechtebuendel.** Datenminimierung
-- (Art. 5 Abs. 1 lit. c DSGVO) heisst nicht "so wenig wie moeglich", sondern
-- "nicht mehr als noetig" -- und was noetig ist, haengt am Anlass. Eine
-- Fehlersuche braucht Lesen; eine Korrektur, um die der Kunde ausdruecklich
-- bittet, braucht Schreiben. Beides in einen Topf zu werfen hiesse,
-- entweder den haeufigen Fall zu ueberdehnen oder den seltenen unmoeglich zu
-- machen.
--
-- Der Kunde gibt die Stufe mit frei: er sieht beim Freigeben, was erlaubt
-- wird. Welche Rechte hinter einer Stufe stehen, steht im Code
-- (apps/api/src/platform/support.ts) und nicht hier -- wie der
-- Berechtigungskatalog selbst, den Migration 0003 als "fester Katalog im
-- Code, nicht vom Kunden aenderbar" fuehrt.

ALTER TABLE support_session
  ADD COLUMN level text NOT NULL DEFAULT 'read'
    CHECK (level IN ('read', 'write'));

/*
 * Die Stufe steht fest, sobald angefragt ist.
 *
 * Sonst liesse sich nach der Freigabe nachschieben: der Kunde gibt "lesen"
 * frei, und die Sitzung schreibt. Das ist keine theoretische Sorge -- es
 * waere genau die Art Fehler, die im Protokoll nicht auffaellt, weil dort
 * die Handlungen stehen und nicht die Rechte, unter denen sie geschahen.
 *
 * Aendern darf sich nur, was den Zugriff **beendet**: die Freigabe selbst,
 * der Widerruf. Ein Trigger, weil die Anwendungsrolle UPDATE auf der Tabelle
 * braucht (freigeben, widerrufen) und eine Rechteordnung das nicht je Spalte
 * trennen kann.
 */
CREATE OR REPLACE FUNCTION support_session_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.level IS DISTINCT FROM OLD.level
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.platform_user_id IS DISTINCT FROM OLD.platform_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'Stufe, Anlass und Beteiligte einer Support-Sitzung stehen fest'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Eine einmal widerrufene Sitzung bleibt widerrufen. Sonst waere der
  -- Widerruf eine Empfehlung.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Eine widerrufene Support-Sitzung laesst sich nicht wiederbeleben'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Ebenso die Frist: sie darf beim Freigeben nicht nach hinten wandern.
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'Die Frist einer Support-Sitzung laesst sich nicht verlaengern'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_support_session_immutable
  BEFORE UPDATE ON support_session
  FOR EACH ROW EXECUTE FUNCTION support_session_immutable();

/*
 * Die Anwendungsrolle darf anfragen, freigeben und widerrufen -- lesen
 * ohnehin. Kein DELETE: eine Support-Sitzung ist ein Nachweis darueber, wer
 * wann in fremde Daten gesehen hat, und der gehoert nicht geloescht.
 */
GRANT SELECT, INSERT, UPDATE ON support_session TO hotelpms_app;

/*
 * Der Kunde muss von einer Anfrage erfahren, sonst liegt sie unbemerkt da
 * und der Support wartet auf eine Freigabe, die niemand sieht.
 *
 * Ueber platform_email und nicht ueber die Gastpost: diese Nachricht gehoert
 * zu einem **Benutzer** -- dem, der freigeben darf --, nicht zu einem Haus,
 * und sie muss auch dann hinausgehen, wenn der Gastversand am Haus nie
 * eingeschaltet wurde (Migration 0030).
 */
ALTER TABLE platform_email DROP CONSTRAINT platform_email_kind_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_kind_check
  CHECK (kind IN ('invite', 'password_reset', 'support_request'));

/*
 * Die Plattformseite ihrer eigenen Sitzungen.
 *
 * **Warum eine Funktion.** support_session traegt keine Zeilenrichtlinie,
 * aber der Name des Kunden steht in `account`, und die traegt eine. Eine
 * Plattformsitzung hat naturgemaess keinen Mandantenkontext -- ein JOIN auf
 * account liefert dort also nichts, still und ohne Fehlermeldung. Genau der
 * Fehler, der in diesem System schon zweimal passiert ist (Migrationen 0014,
 * 0018).
 *
 * Der Filter steht deshalb **in** der Funktion und nicht in der Route: sie
 * fragt app_user_id() selbst und nimmt keinen Benutzer als Parameter
 * entgegen. Ein Plattformbenutzer kann damit ausschliesslich seine eigenen
 * Sitzungen sehen, und zwar aus Bauart, nicht aus Sorgfalt beim Schreiben
 * der Abfrage.
 */
CREATE OR REPLACE FUNCTION support_session_mine()
RETURNS TABLE (
  id bigint, account_id bigint, account_name text, platform_user_id bigint,
  staff_name text, granted_by_name text, level text, reason text,
  is_emergency boolean, requested_at timestamptz, granted_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT s.id, s.account_id, a.name, s.platform_user_id,
         u.display_name, g.display_name, s.level, s.reason, s.is_emergency,
         s.requested_at, s.granted_at, s.expires_at, s.revoked_at
    FROM support_session s
    JOIN account a  ON a.id = s.account_id
    JOIN app_user u ON u.id = s.platform_user_id
    LEFT JOIN app_user g ON g.id = s.granted_by
   WHERE s.platform_user_id = app_user_id()
   ORDER BY s.requested_at DESC
   LIMIT 100
$$;

REVOKE ALL ON FUNCTION support_session_mine() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_session_mine() TO hotelpms_app;

/*
 * Die aktiven Haeuser eines Accounts, ohne Mandantenkontext lesbar.
 *
 * **Der zweite Befund dieser Migration.** applySupportSession baute den
 * Zugriffsbereich aus
 *
 *     SELECT id FROM property WHERE account_id = $1 AND status = 'active'
 *
 * und zwar unter SYSTEM_CONTEXT -- also mit leeren app_property_ids().
 * `property` traegt aber eine erzwungene Zeilenrichtlinie ueber genau diese
 * Liste. Die Abfrage lieferte deshalb **null** Zeilen, und eine freigegebene
 * Support-Sitzung bekam gar kein Haus. Zusammen mit den leeren Rechtemengen
 * war die Sitzung damit doppelt wirkungslos.
 *
 * Aufgefallen ist es nicht, weil der Test dazu accountIds und
 * supportSessionId prueft -- beide werden gesetzt -- und nie, ob jemand mit
 * der Sitzung etwas lesen kann. Es ist dieselbe Falle wie in den
 * Migrationen 0014 und 0018 und steht in CLAUDE.md als Regel: nie ohne
 * Kontext aus einer Tabelle mit Zeilenrichtlinie lesen.
 *
 * Fuer OAuth ist dasselbe in Migration 0025 als oauth_account_properties()
 * geloest. Diese hier traegt den neutralen Namen, weil der Bedarf nicht an
 * OAuth haengt; die Verdopplung bleibt vorerst stehen, weil 0025 nicht mehr
 * geaendert wird und ein Umhaengen des OAuth-Pfads nicht in diese Aenderung
 * gehoert.
 */
CREATE OR REPLACE FUNCTION account_active_properties(p_account_id bigint)
RETURNS TABLE (id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id FROM property p
   WHERE p.account_id = p_account_id AND p.status = 'active';
$$;

REVOKE ALL ON FUNCTION account_active_properties(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_active_properties(bigint) TO hotelpms_app;
