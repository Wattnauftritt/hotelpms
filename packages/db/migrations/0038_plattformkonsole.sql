-- Das Adminpanel: Kundenliste, Plattformbenutzer, Betriebszustand -- und die
-- Sperre, die es bisher nur dem Namen nach gab.
--
-- **Der Anlass.** Die Plattformkonsole kann heute zwei Dinge: eine
-- Support-Sitzung anfragen und ausrollen. Fuer die Anfrage tippt man die
-- **numerische** Konto-Kennung von Hand ein, weil es keine Route gibt, die
-- Kunden aufzaehlt. Wer einen Kunden anlegen will, nimmt curl. Wer einen
-- weiteren Plattformbenutzer braucht, ruft ein Skript auf der Maschine auf.
-- Das ist kein Panel, das ist ein Formular neben einem Knopf.
--
-- **Warum das ueberhaupt Funktionen braucht.** `account` und `property`
-- tragen eine erzwungene Zeilenrichtlinie ueber `app_account_ids()` bzw.
-- `app_property_ids()`. Plattformpersonal hat ohne freigegebene
-- Support-Sitzung einen **leeren** Mandantenkontext -- das ist der Kern des
-- Entwurfs und kein Versehen. Eine Kundenliste laesst sich damit nicht
-- einfach abfragen: sie kaeme still leer zurueck. Genau diese Falle ist in
-- diesem System schon dreimal zugeschlagen (Migrationen 0014, 0018, 0032).
--
-- Der Weg ist derselbe wie dort: SECURITY DEFINER mit festem `search_path`,
-- und die Pruefung steht **in** der Funktion. Sie fragt `app_user_id()`
-- selbst und nimmt keinen Benutzer entgegen; wer sie aufruft, kann sie also
-- nicht auf jemand anderen richten. Die Route prueft das Recht ein zweites
-- Mal -- eine vergessene Berechtigung an einer Route waere sonst der ganze
-- Datenbestand.
--
-- **Was diese Funktionen bewusst NICHT liefern:** keine Gastdaten, keine
-- Buchungen, keinen Umsatz. Ein Adminpanel ist kein Zugang zu Kundendaten;
-- der laeuft ueber eine vom Kunden freigegebene Support-Sitzung und
-- ausschliesslich darueber. Was hier steht, sind Kennungen, Namen von
-- Haeusern und Mitarbeitern des Kunden, Zustaende und Zahlen.

-- --------------------------------------------------------------- Berechtigung
--
-- Plattformbenutzer anzulegen und ihnen Rollen zu geben ist die eine
-- Handlung, mit der sich der Kreis der Berechtigten selbst erweitert. Sie
-- bekommt deshalb ein eigenes Recht und nicht platform:accounts mit dazu:
-- wer Kunden anlegt, muss nicht auch Kollegen mit Vollzugriff anlegen
-- duerfen.
INSERT INTO permission (key, grp, description) VALUES
  ('platform:staff', 'Plattform', 'Plattformbenutzer anlegen, Rollen vergeben');

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'platform:staff'
  FROM role r
 WHERE r.account_id IS NULL AND r.level = 'platform' AND r.key = 'platform_admin';

-- ------------------------------------------------------------------- Waechter
/*
 * Darf der Benutzer dieser Sitzung das?
 *
 * Ohne Parameter fuer den Benutzer: `app_user_id()` kommt aus dem
 * transaktionslokalen Kontext, und der stammt aus dem Token. Ein Aufrufer
 * kann die Frage damit nur ueber sich selbst stellen.
 *
 * `status = 'active'` gehoert dazu: ein stillgelegter Plattformbenutzer
 * behaelt seine Rollenzeilen, und ohne diese Bedingung waere Stilllegen eine
 * Empfehlung.
 */
CREATE OR REPLACE FUNCTION platform_can(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app_user u
      JOIN user_platform_role upr ON upr.user_id = u.id
      JOIN role_permission rp ON rp.role_id = upr.role_id
     WHERE u.id = app_user_id()
       AND u.is_platform_staff
       AND u.status = 'active'
       AND rp.permission_key = p_permission)
$$;

REVOKE ALL ON FUNCTION platform_can(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_can(text) TO hotelpms_app;

COMMENT ON FUNCTION platform_can(text) IS
  'Prueft das Plattformrecht der laufenden Sitzung. Nimmt bewusst keinen '
  'Benutzer entgegen, damit die Frage nur ueber sich selbst gestellt werden kann.';

-- ------------------------------------------------------------------- Kunden
/*
 * Die Kundenliste.
 *
 * Die Zahlen daneben sind der Grund, warum das eine Funktion ist und nicht
 * drei Abfragen in der Route: wer eine Liste von Kunden ansieht, will
 * wissen, wie viele Haeuser und wie viele Benutzer dranhaengen, und die
 * beiden Tabellen tragen dieselbe Zeilenrichtlinie wie `account` selbst.
 *
 * `LIMIT` steht hier absichtlich nicht: die Zahl der Kunden ist die eine
 * Groesse in diesem System, die nicht mit dem Betrieb waechst, sondern mit
 * dem Vertrieb. Waechst sie doch, gehoert hier eine Seitenverwaltung hin und
 * nicht eine stillschweigend abgeschnittene Liste.
 */
CREATE OR REPLACE FUNCTION platform_accounts()
RETURNS TABLE (
  id bigint, public_ref text, name text, legal_name text, status text,
  properties bigint, users bigint, created_at timestamptz,
  last_login_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.public_ref, a.name, a.legal_name, a.status,
         (SELECT count(*) FROM property p WHERE p.account_id = a.id),
         (SELECT count(DISTINCT u.id) FROM app_user u
           WHERE u.id IN (SELECT uar.user_id FROM user_account_role uar
                           WHERE uar.account_id = a.id)
              OR u.id IN (SELECT upr.user_id FROM user_property_role upr
                           JOIN property p2 ON p2.id = upr.property_id
                          WHERE p2.account_id = a.id)),
         a.created_at,
         -- Wann zuletzt jemand dieses Kunden angemeldet war. Die eine Zahl,
         -- an der ein Konto auffaellt, das niemand benutzt -- und die
         -- erste Frage vor jedem Anruf beim Kunden.
         (SELECT max(u.last_login_at) FROM app_user u
           WHERE u.id IN (SELECT uar.user_id FROM user_account_role uar
                           WHERE uar.account_id = a.id)
              OR u.id IN (SELECT upr.user_id FROM user_property_role upr
                           JOIN property p3 ON p3.id = upr.property_id
                          WHERE p3.account_id = a.id))
    FROM account a
   WHERE platform_can('platform:accounts')
   ORDER BY a.name
$$;

REVOKE ALL ON FUNCTION platform_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_accounts() TO hotelpms_app;

/*
 * Die Haeuser eines Kunden.
 *
 * `is_training` steht mit in der Liste, und zwar weit vorn: ein Schulungshaus
 * exportiert nichts nach draussen und verschickt keine Gastpost. Wer einem
 * Kunden hilft, dessen DATEV-Export "nichts tut", muss das als Erstes sehen
 * koennen -- sonst sucht er im Export.
 */
CREATE OR REPLACE FUNCTION platform_account_properties(p_account_id bigint)
RETURNS TABLE (
  id bigint, public_ref text, code text, name text, status text,
  is_training boolean, timezone text, rooms bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.public_ref, p.code, p.name, p.status, p.is_training,
         p.timezone,
         (SELECT count(*) FROM resource r
           WHERE r.property_id = p.id AND r.active)
    FROM property p
   WHERE p.account_id = p_account_id
     AND platform_can('platform:accounts')
   ORDER BY p.code
$$;

REVOKE ALL ON FUNCTION platform_account_properties(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_account_properties(bigint) TO hotelpms_app;

/*
 * Die Benutzer eines Kunden -- Name, Adresse, Zustand, Rollen.
 *
 * **Warum das kein Kundendatenzugriff ist.** Es sind Mitarbeiter des Kunden,
 * keine Gaeste, und ohne sie laesst sich der haeufigste Supportfall nicht
 * bearbeiten: "Frau X kommt nicht mehr rein." Kennwort, PIN-Hash und
 * TOTP-Geheimnis stehen nicht in der Liste und haben dort auch nichts zu
 * suchen.
 */
CREATE OR REPLACE FUNCTION platform_account_users(p_account_id bigint)
RETURNS TABLE (
  id bigint, public_ref text, email text, display_name text, status text,
  locked_until timestamptz, last_login_at timestamptz, roles text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.public_ref, u.email, u.display_name, u.status,
         u.locked_until, u.last_login_at,
         (SELECT string_agg(DISTINCT bez, ', ' ORDER BY bez) FROM (
            SELECT r.name AS bez
              FROM user_account_role uar
              JOIN role r ON r.id = uar.role_id
             WHERE uar.user_id = u.id AND uar.account_id = p_account_id
            UNION ALL
            SELECT r.name || ' (' || p.code || ')'
              FROM user_property_role upr
              JOIN role r ON r.id = upr.role_id
              JOIN property p ON p.id = upr.property_id
             WHERE upr.user_id = u.id AND p.account_id = p_account_id) q)
    FROM app_user u
   WHERE platform_can('platform:accounts')
     AND (u.id IN (SELECT uar.user_id FROM user_account_role uar
                    WHERE uar.account_id = p_account_id)
       OR u.id IN (SELECT upr.user_id FROM user_property_role upr
                    JOIN property p ON p.id = upr.property_id
                   WHERE p.account_id = p_account_id))
   ORDER BY u.display_name
$$;

REVOKE ALL ON FUNCTION platform_account_users(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_account_users(bigint) TO hotelpms_app;

/*
 * Sperren und entsperren.
 *
 * **Der Befund dahinter.** `account.status` gibt es seit Migration 0002 mit
 * den drei Werten active, suspended, archived, und das Recht heisst seit
 * Migration 0003 "Accounts anlegen, **sperren**". Gelesen wurde die Spalte
 * an keiner einzigen Stelle: weder beim Anmelden noch beim Aufbau des
 * Zugriffsbereichs. Eine Sperre haette also nichts gesperrt -- ein Knopf,
 * der luegt, ist schlimmer als ein fehlender. Was sie wirklich bewirkt,
 * steht weiter unten bei user_property_scope.
 *
 * `archived` ist nicht das Ende der Daten. Aufbewahrungsfristen laufen
 * weiter (§ 147 AO, acht Jahre), und Loeschen heisst in diesem System
 * ohnehin anonymisieren. Archiviert heisst: kein Zugang mehr, nicht "weg".
 */
CREATE OR REPLACE FUNCTION platform_account_set_status(
  p_account_id bigint, p_status text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_alt text;
BEGIN
  IF NOT platform_can('platform:accounts') THEN
    RAISE EXCEPTION 'Kein Recht, den Zustand eines Kunden zu aendern'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status NOT IN ('active', 'suspended', 'archived') THEN
    RAISE EXCEPTION 'Unbekannter Zustand: %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO v_alt FROM account WHERE id = p_account_id;
  IF v_alt IS NULL THEN
    RAISE EXCEPTION 'Kein Kunde mit der Kennung %', p_account_id
      USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE account SET status = p_status, updated_at = now()
   WHERE id = p_account_id;

  RETURN v_alt;
END $$;

REVOKE ALL ON FUNCTION platform_account_set_status(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_account_set_status(bigint, text) TO hotelpms_app;

-- ----------------------------------------------------- Die Sperre wirksam machen
/*
 * Der Zugriffsbereich endet am Zustand des Kunden.
 *
 * Bisher stand hier nur `p.status = 'active'` -- das Haus musste aktiv sein,
 * der Kunde nicht. Ein gesperrter Kunde arbeitete deshalb weiter, als waere
 * nichts.
 *
 * **Support bleibt davon unberuehrt**, und das ist Absicht: die Sitzung
 * laeuft ueber `account_active_properties()`, eine andere Funktion. Wer
 * gesperrt ist, ist meist gerade der, dem geholfen werden muss -- eine
 * Sperre, die auch den Support aussperrt, macht aus einer offenen Rechnung
 * einen Totalausfall.
 */
CREATE OR REPLACE FUNCTION user_property_scope(p_user bigint)
RETURNS TABLE (property_id bigint, account_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.account_id
    FROM user_property_role upr
    JOIN property p ON p.id = upr.property_id
    JOIN account a ON a.id = p.account_id
   WHERE upr.user_id = p_user AND p.status = 'active' AND a.status = 'active'
  UNION
  SELECT p.id, p.account_id
    FROM user_account_role uar
    JOIN property p ON p.account_id = uar.account_id
    JOIN account a ON a.id = p.account_id
   WHERE uar.user_id = p_user AND p.status = 'active' AND a.status = 'active';
$$;

/*
 * Dieselbe Sperre fuer Account-Rollen ohne Haus.
 *
 * Der Zugriffsbereich oben zaehlt Haeuser. Eine Account-Rolle bringt aber im
 * Aufbau des Principals ihren Account **direkt** mit -- auch dann, wenn der
 * Kunde noch gar kein Haus hat. Ohne diese Funktion haette ein gesperrter
 * Kunde ueber seine Account-Rolle weiterhin Gaeste und Firmen gesehen, und
 * die Sperre waere wieder nur halb.
 */
CREATE OR REPLACE FUNCTION user_account_scope(p_user bigint)
RETURNS TABLE (account_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT uar.account_id
    FROM user_account_role uar
    JOIN account a ON a.id = uar.account_id
   WHERE uar.user_id = p_user AND a.status = 'active';
$$;

REVOKE ALL ON FUNCTION user_account_scope(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_account_scope(bigint) TO hotelpms_app;

/*
 * Alle Accounts eines Benutzers **mit** ihrem Zustand -- auch die gesperrten.
 *
 * `user_account_scope` oben liefert nur die offenen; das ist richtig fuer
 * den Zugriff und falsch fuer die Auskunft. Ein gesperrter Kunde meldet sich
 * naemlich weiterhin an -- gesperrt ist der Account, nicht der Benutzer --
 * und bekaeme sonst "diesem Benutzer ist kein Haus zugeordnet" zu lesen. Das
 * ist der Satz, nach dem an einem Montagmorgen um sieben jemand anruft und
 * niemand weiss, warum.
 *
 * Nur Kennung und Zustand, kein Name: mehr braucht die Auskunft nicht.
 */
CREATE OR REPLACE FUNCTION user_account_states(p_user bigint)
RETURNS TABLE (account_id bigint, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT a.id, a.status
    FROM account a
   WHERE a.id IN (SELECT uar.account_id FROM user_account_role uar
                   WHERE uar.user_id = p_user)
      OR a.id IN (SELECT p.account_id FROM user_property_role upr
                   JOIN property p ON p.id = upr.property_id
                  WHERE upr.user_id = p_user);
$$;

REVOKE ALL ON FUNCTION user_account_states(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_account_states(bigint) TO hotelpms_app;

-- ------------------------------------------------------ Plattformpersonal
/*
 * Wer zum Betrieb gehoert -- mit Rolle, Zustand und letzter Anmeldung.
 *
 * Bisher gab es dafuer ueberhaupt keinen Weg ausser psql auf der Maschine.
 * Wer die Plattform betreibt, muss sehen koennen, wer Zugang hat; ein
 * Zugang, den niemand aufzaehlen kann, wird auch nicht entzogen.
 */
CREATE OR REPLACE FUNCTION platform_staff()
RETURNS TABLE (
  id bigint, public_ref text, email text, display_name text, status text,
  role_key text, role_name text, last_login_at timestamptz,
  created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.public_ref, u.email, u.display_name, u.status,
         r.key, r.name, u.last_login_at, u.created_at
    FROM app_user u
    LEFT JOIN user_platform_role upr ON upr.user_id = u.id
    LEFT JOIN role r ON r.id = upr.role_id
   WHERE u.is_platform_staff
     AND platform_can('platform:staff')
   ORDER BY u.display_name
$$;

REVOKE ALL ON FUNCTION platform_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_staff() TO hotelpms_app;

-- ------------------------------------------------------------ Betriebszustand
/*
 * Was haengt, je Kunde.
 *
 * **Nur Zahlen, keine Inhalte.** Eine Post an einen Gast traegt dessen Namen
 * und Adresse; ein Webhook traegt den Rumpf einer Buchung. Beides gehoert
 * nicht in ein Panel, das ohne Freigabe des Kunden offensteht. Was hier
 * steht, ist: wie viele haengen, seit wann die aelteste. Das genuegt, um zu
 * merken, dass etwas klemmt -- und fuer alles Weitere gibt es die
 * Support-Sitzung.
 *
 * Der Nachtlauf steht mit dabei, weil er der eine Vorgang ist, dessen
 * Ausbleiben niemand bemerkt: er laeuft nachts, und wenn er nicht laeuft,
 * sieht am naechsten Morgen alles normal aus -- bis die Zahlen fehlen.
 */
CREATE OR REPLACE FUNCTION platform_health()
RETURNS TABLE (
  account_id bigint, account_name text, account_status text,
  emails_pending bigint, emails_failed bigint, emails_oldest timestamptz,
  webhooks_failed bigint, webhooks_oldest timestamptz,
  night_audit_last date
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.name, a.status,
         (SELECT count(*) FROM outbound_email e
            JOIN property p ON p.id = e.property_id
           WHERE p.account_id = a.id AND e.status = 'pending'),
         (SELECT count(*) FROM outbound_email e
            JOIN property p ON p.id = e.property_id
           WHERE p.account_id = a.id AND e.status = 'failed'),
         (SELECT min(e.created_at) FROM outbound_email e
            JOIN property p ON p.id = e.property_id
           WHERE p.account_id = a.id AND e.status IN ('pending','failed')),
         (SELECT count(*) FROM webhook_delivery d
           WHERE d.account_id = a.id AND d.status = 'failed'),
         -- `occurred_at`, nicht `created_at`: die Zeile traegt den Zeitpunkt
         -- des Ereignisses, nicht den des Zustellversuchs.
         (SELECT min(d.occurred_at) FROM webhook_delivery d
           WHERE d.account_id = a.id AND d.status = 'failed'),
         -- Der juengste Geschaeftstag, der wirklich abgeschlossen ist. Steht
         -- er zwei Tage zurueck, ist der Nachtlauf stehengeblieben.
         (SELECT max(b.date) FROM business_day b
            JOIN property p ON p.id = b.property_id
           WHERE p.account_id = a.id AND b.closed_at IS NOT NULL)
    FROM account a
   WHERE platform_can('platform:operations')
   ORDER BY a.name
$$;

REVOKE ALL ON FUNCTION platform_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_health() TO hotelpms_app;
