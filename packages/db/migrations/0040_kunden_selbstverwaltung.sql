-- Der Kunde verwaltet sein Personal selbst: anlegen, aendern, sperren,
-- entfernen.
--
-- **Der Befund.** users.ts konnte Rollen aendern -- fuer Menschen, die es im
-- Account schon gab. Bekannt wurde man aber nur durch das Onboarding oder,
-- seit 0039, ueber unser Adminpanel. Jede neue Rezeptionistin war damit ein
-- Anruf bei uns. Bei hundert Haeusern sind wir dann keine Plattform mehr,
-- sondern deren Personalabteilung. Der Kunde muss so autark wie moeglich
-- sein und so eingeschraenkt wie noetig.
--
-- **Was "sperren" beim Kunden heisst, und warum es eine eigene Tabelle
-- braucht.** app_user.status ist eine Eigenschaft des Menschen, nicht seiner
-- Rolle bei einem Kunden. Eine Aushilfe, die in zwei Betrieben arbeitet,
-- darf vom einen gesperrt werden, ohne dass der andere sie verliert -- und
-- der eine darf vom anderen nicht einmal erfahren. Deshalb steht die Sperre
-- am Paar (Kunde, Benutzer) und nicht am Benutzer. Der Zugriffsbereich
-- (user_property_scope, user_account_scope) endet an ihr genauso wie am
-- Zustand des Kunden selbst (0038).

CREATE TABLE account_user_block (
  account_id  bigint NOT NULL REFERENCES account(id),
  user_id     bigint NOT NULL REFERENCES app_user(id),
  blocked_at  timestamptz NOT NULL DEFAULT now(),
  blocked_by  bigint REFERENCES app_user(id),
  PRIMARY KEY (account_id, user_id)
);

COMMENT ON TABLE account_user_block IS
  'Ein Benutzer ist bei diesem Kunden gesperrt. Seine Rollen bleiben stehen; '
  'der Zugriffsbereich endet an dieser Zeile. Die Sperre haengt am Paar, '
  'damit ein Kunde nicht den Zugang des anderen mitnimmt.';

/*
 * Keine Zeilenrichtlinie, wie bei user_account_role und user_property_role:
 * Benutzer gehoeren keinem Haus. Die Grenze zieht die Route von Hand --
 * jede Abfrage haengt an account_id aus dem Kontext, nie an einem Wert aus
 * dem Rumpf (users.ts, Kopfkommentar). Kein DELETE-Verbot: Entsperren ist
 * das Loeschen der Zeile, und ein Nachweis steht im Protokoll.
 */
GRANT SELECT, INSERT, DELETE ON account_user_block TO hotelpms_app;

CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON account_user_block
  FOR EACH ROW EXECUTE FUNCTION audit_trigger();

-- ------------------------------------------------ Der Zugriffsbereich endet
CREATE OR REPLACE FUNCTION user_property_scope(p_user bigint)
RETURNS TABLE (property_id bigint, account_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.account_id
    FROM user_property_role upr
    JOIN property p ON p.id = upr.property_id
    JOIN account a ON a.id = p.account_id
   WHERE upr.user_id = p_user AND p.status = 'active' AND a.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM account_user_block b
                      WHERE b.account_id = a.id AND b.user_id = p_user)
  UNION
  SELECT p.id, p.account_id
    FROM user_account_role uar
    JOIN property p ON p.account_id = uar.account_id
    JOIN account a ON a.id = p.account_id
   WHERE uar.user_id = p_user AND p.status = 'active' AND a.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM account_user_block b
                      WHERE b.account_id = a.id AND b.user_id = p_user);
$$;

CREATE OR REPLACE FUNCTION user_account_scope(p_user bigint)
RETURNS TABLE (account_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT uar.account_id
    FROM user_account_role uar
    JOIN account a ON a.id = uar.account_id
   WHERE uar.user_id = p_user AND a.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM account_user_block b
                      WHERE b.account_id = a.id AND b.user_id = p_user);
$$;

-- --------------------------------------- Das Adminpanel sieht die Sperre mit
/*
 * Neue Spalte im Rueckgabetyp, deshalb DROP statt REPLACE: PostgreSQL
 * laesst RETURNS TABLE nicht nachtraeglich erweitern.
 */
DROP FUNCTION IF EXISTS platform_account_users(bigint);
CREATE FUNCTION platform_account_users(p_account_id bigint)
RETURNS TABLE (
  id bigint, public_ref text, email text, display_name text, status text,
  locked_until timestamptz, last_login_at timestamptz, roles text,
  blocked boolean
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
             WHERE upr.user_id = u.id AND p.account_id = p_account_id) q),
         EXISTS (SELECT 1 FROM account_user_block b
                  WHERE b.account_id = p_account_id AND b.user_id = u.id)
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
