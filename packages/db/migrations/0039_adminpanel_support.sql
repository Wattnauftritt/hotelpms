-- Das Adminpanel, zweiter Teil: was der Support am Telefon wirklich braucht.
--
-- **Der Befund nach dem ersten Durchgang (0038).** Das Panel zeigte Kunden,
-- Haeuser und Benutzer -- und konnte mit dem haeufigsten Anruf nichts
-- anfangen: "Frau X kommt nicht mehr rein." Zu sehen war, dass sie gesperrt
-- ist; zu tun war nichts. Ebenso wenig liess sich ein zweiter Benutzer
-- anlegen (der Kunde kann das heute selbst auch nicht: es gibt keine Route
-- dafuer, nur die Rollenvergabe fuer schon bekannte Benutzer), kein zweites
-- Haus, und niemand konnte sehen, wer von uns wann in wessen Daten war.
--
-- Was hier dazukommt, sind vier Funktionen, alle nach der Bauart von 0038:
-- SECURITY DEFINER mit festem search_path, die Pruefung des Rechts **in**
-- der Funktion ueber platform_can(), kein Benutzer als Parameter.

-- ---------------------------------------------------------- Zweites Haus
/*
 * Ein weiteres Haus an einem bestehenden Kunden.
 *
 * account_provision (0031) legt Account, Haus und ersten Benutzer in einem
 * Zug an -- fuer den zweiten Standort desselben Kunden ist das der falsche
 * Schnitt. Dieselben Pflichtangaben, derselbe offene Geschaeftstag,
 * derselbe Riegel: ohne Anschrift und Steuernummer ist das Haus nach
 * § 14 UStG nicht rechnungsfaehig, und das faellt sonst erst beim ersten
 * Check-out auf.
 *
 * Das Kuerzel ist je Kunde eindeutig, nicht weltweit: "HAUPTHAUS" darf es
 * bei zwei Kunden geben. Der Index dazu steht seit 0004.
 */
CREATE OR REPLACE FUNCTION platform_property_add(
  p_account_id    bigint,
  p_code          text,
  p_name          text,
  p_address_line1 text,
  p_postal_code   text,
  p_city          text,
  p_country       text,
  p_tax_number    text,
  p_vat_id        text,
  p_timezone      text,
  p_currency      text,
  p_is_training   boolean,
  p_business_date date
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_property bigint;
BEGIN
  IF NOT platform_can('platform:accounts') THEN
    RAISE EXCEPTION 'Kein Recht, ein Haus anzulegen'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'Kein Kunde mit der Kennung %', p_account_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce(btrim(p_address_line1), '') = ''
     OR coalesce(btrim(p_postal_code), '') = ''
     OR coalesce(btrim(p_city), '') = ''
     OR coalesce(btrim(p_tax_number), '') = '' THEN
    RAISE EXCEPTION 'Pflichtangaben nach § 14 UStG fehlen'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO property (account_id, code, name, address_line1, postal_code,
                        city, country, tax_number, vat_id, timezone, currency,
                        is_training)
  VALUES (p_account_id, p_code, p_name, btrim(p_address_line1),
          btrim(p_postal_code), btrim(p_city), p_country, btrim(p_tax_number),
          nullif(btrim(p_vat_id), ''), p_timezone, p_currency, p_is_training)
  RETURNING id INTO v_property;

  -- Ohne offenen Geschaeftstag laeuft kein Nachtlauf, und das faellt erst
  -- beim Check-out auf -- bemerkt vom Gast (0031).
  INSERT INTO business_day (property_id, date) VALUES (v_property, p_business_date);

  RETURN v_property;
END $$;

REVOKE ALL ON FUNCTION platform_property_add(bigint,text,text,text,text,text,text,
  text,text,text,text,boolean,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_property_add(bigint,text,text,text,text,text,text,
  text,text,text,text,boolean,date) TO hotelpms_app;

-- ------------------------------------------------ Support-Sitzungen, Aufsicht
/*
 * Alle Support-Sitzungen -- wer von uns war wann in wessen Daten.
 *
 * support_session_mine() (0032) zeigt jedem nur seine eigenen, und das
 * bleibt fuer den Alltag richtig. Aber jemand muss das Ganze sehen: Art. 5
 * Abs. 2 DSGVO verlangt, dass der Auftragsverarbeiter nachweisen kann, was
 * er getan hat -- und ein Nachweis, den nur der Handelnde selbst einsehen
 * kann, ist keiner. Deshalb hinter platform:staff, dem Recht des Admins,
 * nicht hinter platform:support_session.
 *
 * `LIMIT 500`: die Liste ist eine Aufsicht, kein Archiv. Wer weiter zurueck
 * muss, hat einen Anlass und geht an die Tabelle.
 */
CREATE OR REPLACE FUNCTION platform_support_sessions()
RETURNS TABLE (
  id bigint, account_id bigint, account_name text, platform_user_id bigint,
  staff_name text, granted_by_name text, level text, reason text,
  is_emergency boolean, requested_at timestamptz, granted_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.account_id, a.name, s.platform_user_id,
         u.display_name, g.display_name, s.level, s.reason, s.is_emergency,
         s.requested_at, s.granted_at, s.expires_at, s.revoked_at
    FROM support_session s
    JOIN account a  ON a.id = s.account_id
    JOIN app_user u ON u.id = s.platform_user_id
    LEFT JOIN app_user g ON g.id = s.granted_by
   WHERE platform_can('platform:staff')
   ORDER BY s.requested_at DESC
   LIMIT 500
$$;

REVOKE ALL ON FUNCTION platform_support_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_support_sessions() TO hotelpms_app;

/*
 * Die Sitzungen **eines** Kunden -- fuer die Kundenkarte im Panel.
 *
 * Wer einen Anruf annimmt, will als Erstes wissen: laeuft schon eine
 * Sitzung, wartet eine auf Freigabe, war gestern jemand von uns drin?
 * Hinter platform:support_session, weil das die Frage dessen ist, der
 * gleich eine anfragen will.
 */
CREATE OR REPLACE FUNCTION platform_account_support_sessions(p_account_id bigint)
RETURNS TABLE (
  id bigint, account_id bigint, account_name text, platform_user_id bigint,
  staff_name text, granted_by_name text, level text, reason text,
  is_emergency boolean, requested_at timestamptz, granted_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.account_id, a.name, s.platform_user_id,
         u.display_name, g.display_name, s.level, s.reason, s.is_emergency,
         s.requested_at, s.granted_at, s.expires_at, s.revoked_at
    FROM support_session s
    JOIN account a  ON a.id = s.account_id
    JOIN app_user u ON u.id = s.platform_user_id
    LEFT JOIN app_user g ON g.id = s.granted_by
   WHERE s.account_id = p_account_id
     AND platform_can('platform:support_session')
   ORDER BY s.requested_at DESC
   LIMIT 50
$$;

REVOKE ALL ON FUNCTION platform_account_support_sessions(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_account_support_sessions(bigint) TO hotelpms_app;

/*
 * Was in einer Sitzung geschrieben wurde -- als Zahlen je Tabelle.
 *
 * Jede Handlung unter einer Support-Sitzung traegt im Protokoll ihre
 * support_session_id (0002). Das ist der Nachweis, den Art. 28 DSGVO
 * verlangt; nur konnte ihn bisher niemand lesen ausser an der Tabelle.
 *
 * **Warum nur Zahlen.** audit_log.changed traegt die Zeile selbst -- bei
 * `guest` also Name, Anschrift, Geburtsdatum. Das Panel steht ohne Freigabe
 * des Kunden offen; was dort erscheint, sind Tabellenname, Art und Anzahl.
 * "3 Aenderungen an reservation, 1 an folio" beantwortet die Frage "was
 * hat der Support gemacht" fuer die Aufsicht; die Zeilen selbst sieht, wer
 * dazu berechtigt ist, im Haus des Kunden.
 *
 * Sehen darf das der Admin (Aufsicht) und der, dessen Sitzung es ist (der
 * eigene Nachweis). Beides steht in der Funktion.
 */
CREATE OR REPLACE FUNCTION platform_session_activity(p_session_id bigint)
RETURNS TABLE (table_name text, action text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.table_name, l.action, count(*)
    FROM audit_log l
   WHERE l.support_session_id = p_session_id
     AND (platform_can('platform:staff')
          OR (platform_can('platform:support_session')
              AND EXISTS (SELECT 1 FROM support_session s
                           WHERE s.id = p_session_id
                             AND s.platform_user_id = app_user_id())))
   GROUP BY l.table_name, l.action
   ORDER BY l.table_name, l.action
$$;

REVOKE ALL ON FUNCTION platform_session_activity(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_session_activity(bigint) TO hotelpms_app;
