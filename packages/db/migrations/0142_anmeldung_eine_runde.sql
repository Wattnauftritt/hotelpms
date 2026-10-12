-- ---------------------------------------------------------------------------
-- 0142 -- Anmeldung in einer Runde, Checkout ohne offene Transaktion.
--
-- Performance-Audit 11.10.2026, Befund 8 und Befund 4
-- (performance/audit-2026-10-11.md).
--
-- Befund 8: Jede Anfrage mit Sitzungscookie kostete rund zehn Runden zur
-- Datenbank, bevor der Handler ueberhaupt anfing: die Sitzung lesen, dann
-- `loadPrincipal` als eigene Transaktion (BEGIN, Kontext, Benutzer, Rollen,
-- Account-Bereich, Hausbereich, geteiltes Personal, COMMIT), fuer
-- Plattformpersonal zwei weitere Transaktionen fuer die Support-Sitzung,
-- zuletzt die Aktualisierung von last_seen_at. Nichts davon stand im
-- Abfragezaehler. Jetzt eine Funktion, eine Runde, ein Schnappschuss.
--
-- Die Regeln bleiben dieselben, sie stehen nur an einer Stelle: dieselben
-- Funktionen fuer Zugriffsbereich und Sperren (0018, 0038, 0040, 0116),
-- dieselbe Bedingung fuer eine gueltige Sitzung, derselbe Arbeitsplatz-
-- wechsel (active_user_id), dieselbe Support-Sitzung. Zusammengesetzt wird
-- das Principal weiter in auth.ts -- dort stehen die Begruendungen, und die
-- Rechnung (welche Rolle wirkt in welchem Account) bleibt pruefbar, ohne
-- SQL zu lesen.
--
-- Bewusst **kein** Zwischenspeicher im Prozess: eine Sperre, ein Widerruf,
-- eine entzogene Rolle sollen mit der naechsten Anfrage wirken, nicht nach
-- Ablauf eines Speichers. Eine Runde je Anfrage ist billig genug.
--
-- Befund 4: Der Weg zum Zahlungsanbieter lief in einer Transaktion mit
-- Zeilensperre auf dem Zahlungslink. Haengt der Anbieter, haelt jeder Gast,
-- der neu laedt, eine Verbindung aus dem Pool von zehn. Jetzt: kurz sperren
-- und entscheiden, festschreiben, den Anbieter fragen, das Ergebnis in einer
-- zweiten kurzen Transaktion schreiben. Was vorher die Zeilensperre ueber
-- den ganzen Weg sicherstellte -- zwei Tabs, ein Doppelklick legen nicht
-- zwei Checkouts an --, haelt jetzt ein Anspruch je Link (Tabelle unten).
-- ---------------------------------------------------------------------------

/*
 * Was ein Benutzer darf, roh: Rollen, offene Accounts, Hausbereich,
 * geteiltes Personal. NULL, wenn es ihn nicht gibt oder er nicht aktiv ist
 * -- dann ist er anonym, wie bisher.
 *
 * SECURITY DEFINER aus demselben Grund wie die Funktionen, die sie aufruft:
 * der Mandantenkontext entsteht erst aus dieser Antwort (0018).
 */
CREATE OR REPLACE FUNCTION principal_user_data(p_user bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'platformStaff', u.is_platform_staff,
    'roles', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('l', q.level, 'a', q.account_id,
                                          'p', q.property_id, 'k', q.permission_key))
        FROM (
          SELECT 'platform'::text AS level, NULL::bigint AS account_id,
                 NULL::bigint AS property_id, rp.permission_key
            FROM user_platform_role upr
            JOIN role_permission rp ON rp.role_id = upr.role_id
           WHERE upr.user_id = p_user
          UNION ALL
          SELECT 'account', uar.account_id, NULL, rp.permission_key
            FROM user_account_role uar
            JOIN role_permission rp ON rp.role_id = uar.role_id
           WHERE uar.user_id = p_user
          UNION ALL
          SELECT 'property', NULL, upr2.property_id, rp.permission_key
            FROM user_property_role upr2
            JOIN role_permission rp ON rp.role_id = upr2.role_id
           WHERE upr2.user_id = p_user) q), '[]'::jsonb),
    'openAccounts', COALESCE((
      SELECT jsonb_agg(s.account_id) FROM user_account_scope(p_user) s), '[]'::jsonb),
    'scope', COALESCE((
      SELECT jsonb_agg(jsonb_build_array(s.property_id, s.account_id))
        FROM user_property_scope(p_user) s), '[]'::jsonb),
    'shared', COALESCE((
      SELECT jsonb_agg(jsonb_build_array(s.property_id, s.account_id, s.permission_key))
        FROM user_shared_staff_permissions(p_user) s), '[]'::jsonb))
    FROM app_user u
   WHERE u.id = p_user AND u.status = 'active';
$$;

REVOKE ALL ON FUNCTION principal_user_data(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION principal_user_data(bigint) TO hotelpms_app;

/*
 * Die freigegebene Support-Sitzung eines Plattformmitarbeiters mit den
 * aktiven Haeusern ihres Kunden, oder NULL. Dieselbe Bedingung wie bisher
 * in applySupportSession: freigegeben, nicht widerrufen, nicht abgelaufen,
 * die zuletzt freigegebene. Die Haeuser ueber account_active_properties
 * (0032), nicht direkt aus `property` -- die Falle aus 0014 und 0018.
 */
CREATE OR REPLACE FUNCTION principal_support_data(p_user bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'accountId', s.account_id, 'level', s.level,
    'properties', COALESCE((SELECT jsonb_agg(p.id)
                              FROM account_active_properties(s.account_id) p),
                           '[]'::jsonb))
    FROM (SELECT id, account_id, level FROM support_session
           WHERE platform_user_id = p_user
             AND granted_at IS NOT NULL
             AND revoked_at IS NULL
             AND expires_at > now()
           ORDER BY granted_at DESC LIMIT 1) s;
$$;

REVOKE ALL ON FUNCTION principal_support_data(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION principal_support_data(bigint) TO hotelpms_app;

/*
 * Eine Sitzung aufloesen: alles, was die Anmeldung je Anfrage braucht, in
 * einer Runde. Keine Zeile, wenn die Sitzung unbekannt, widerrufen oder
 * abgelaufen ist.
 *
 * `principal` gehoert der handelnden Person (Arbeitsplatz-PIN), nicht
 * zwingend der angemeldeten; `support` nur fuer aktives Plattformpersonal,
 * wie bisher in applySupportSession.
 *
 * VOLATILE, weil sie last_seen_at nachzieht -- hoechstens einmal je Minute,
 * dieselbe Bedingung, die vorher als eigene Anweisung in app.ts stand.
 * Niemand liest die Spalte minutengenau, aber ein Schreiben je GET war eine
 * Zeile WAL bei jedem Aufruf.
 */
CREATE OR REPLACE FUNCTION session_principal(p_session text)
RETURNS TABLE (session_user_id bigint, effective_user_id bigint,
               principal jsonb, support jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user   bigint;
  v_active bigint;
BEGIN
  SELECT us.user_id, us.active_user_id INTO v_user, v_active
    FROM user_session us
   WHERE us.id = p_session AND us.revoked_at IS NULL
     AND us.expires_at > now() AND us.absolute_expires_at > now();
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE user_session SET last_seen_at = now()
   WHERE id = p_session AND last_seen_at < now() - interval '60 seconds';

  session_user_id   := v_user;
  effective_user_id := COALESCE(v_active, v_user);
  principal         := principal_user_data(effective_user_id);
  support           := CASE WHEN (principal ->> 'platformStaff')::boolean
                            THEN principal_support_data(effective_user_id) END;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION session_principal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_principal(text) TO hotelpms_app;

-- ---------------------------------------------------------------------------
-- Befund 4: Anspruch auf den Weg zum Anbieter, je Zahlungslink.
--
-- Wer einen Checkout anlegen, ersetzen oder beim Widerruf beenden will,
-- traegt sich hier ein, solange er die Zeile des Links gesperrt haelt, und
-- gibt die Sperre dann frei. Ein zweiter Aufruf findet den Anspruch, wartet
-- ohne Verbindung und sieht danach den fertigen Checkout -- statt einen
-- zweiten anzulegen, den der Gast ebenfalls bezahlen koennte. Der Webhook
-- nimmt jede echte Zahlung an; eine nicht verbuchte waere Geld ohne Folio.
--
-- Ein Anspruch verfaellt nach einer Minute: stirbt der Prozess mitten im
-- Weg, bleibt der Link sonst fuer immer blockiert. Die Minute liegt weit
-- ueber dem, was drei Aufrufe beim Anbieter mit je acht Sekunden Zeitgrenze
-- dauern koennen.
--
-- Eine eigene Tabelle und keine Spalte an payment_link: die traegt den
-- Audit-Trigger, und jeder Klick des Gastes wuerde zwei Zeilen im
-- unveraenderlichen Protokoll hinterlassen. Hier steht nichts, was einen
-- Menschen bezeichnet -- Link, Haus, Zufallskennung, Zeitpunkt.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_link_checkout_claim (
  payment_link_id bigint PRIMARY KEY REFERENCES payment_link(id) ON DELETE CASCADE,
  property_id     bigint NOT NULL REFERENCES property(id),
  claim_id        uuid   NOT NULL,
  claimed_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_link_checkout_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_link_checkout_claim FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON payment_link_checkout_claim
  USING (property_id = ANY (app_property_ids()));
