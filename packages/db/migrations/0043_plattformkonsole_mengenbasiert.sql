-- Performanceaudit: platform_accounts() und platform_health() liefen je
-- Kontozeile ueber korrelierte Unterabfragen -- genau die Form, die dieses
-- System zweimal schon als Fehler gefunden und behoben hat (Migration 0013,
-- statement-level Trigger statt je Zimmer; Migration 0015, Abstandsoperator
-- statt Sortieren aller Treffer). `platform_accounts()` rechnete je Konto
-- sogar zweimal denselben Benutzerkreis aus (einmal fuer die Anzahl, einmal
-- fuer die letzte Anmeldung), macht rueckwirkend also vier bis fuenf
-- Unterabfragen je Zeile.
--
-- Gemessen mit 51 Konten und rund 5500 Benutzern (Bestand nur zu
-- Messzwecken angelegt, nicht Teil des Saatlaufs): `platform_accounts()`
-- brauchte 128 ms bei 14 102 Puffertreffern. Nach dieser Aenderung, mit
-- Mengenoperationen statt Unterabfrage je Zeile, sind es Bruchteile davon
-- -- siehe docs/24-performanceaudit.md.
--
-- Beide Funktionen bekommen dieselbe Form: eine CTE je Kennzahl, einmal
-- gruppiert nach Konto, dann ein LEFT JOIN auf `account`. Rueckgabetyp,
-- Reihenfolge und Berechtigungspruefung bleiben unveraendert -- nur wie die
-- Zahlen entstehen, aendert sich.

CREATE OR REPLACE FUNCTION platform_accounts()
RETURNS TABLE (
  id bigint, public_ref text, name text, legal_name text, status text,
  properties bigint, users bigint, created_at timestamptz,
  last_login_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH haeuser AS (
    SELECT account_id, count(*) AS n FROM property GROUP BY account_id
  ),
  -- Ein Benutzer gehoert zum Konto ueber eine Kontorolle oder eine
  -- Hausrolle; UNION statt UNION ALL, damit beides zusammen nicht doppelt
  -- zaehlt -- genau das leistete vorher `count(DISTINCT ...)`.
  konto_benutzer AS (
    SELECT uar.account_id, uar.user_id FROM user_account_role uar
    UNION
    SELECT p.account_id, upr.user_id
      FROM user_property_role upr JOIN property p ON p.id = upr.property_id
  ),
  benutzerzahl AS (
    SELECT kb.account_id, count(*) AS n, max(u.last_login_at) AS letzte_anmeldung
      FROM konto_benutzer kb JOIN app_user u ON u.id = kb.user_id
     GROUP BY kb.account_id
  )
  SELECT a.id, a.public_ref, a.name, a.legal_name, a.status,
         COALESCE(h.n, 0), COALESCE(b.n, 0), a.created_at, b.letzte_anmeldung
    FROM account a
    LEFT JOIN haeuser h ON h.account_id = a.id
    LEFT JOIN benutzerzahl b ON b.account_id = a.id
   WHERE platform_can('platform:accounts')
   ORDER BY a.name
$$;

CREATE OR REPLACE FUNCTION platform_health()
RETURNS TABLE (
  account_id bigint, account_name text, account_status text,
  emails_pending bigint, emails_failed bigint, emails_oldest timestamptz,
  webhooks_failed bigint, webhooks_oldest timestamptz,
  night_audit_last date
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH post AS (
    SELECT p.account_id,
           count(*) FILTER (WHERE e.status = 'pending') AS wartend,
           count(*) FILTER (WHERE e.status = 'failed') AS fehlgeschlagen,
           min(e.created_at) FILTER (WHERE e.status IN ('pending', 'failed')) AS aelteste
      FROM outbound_email e JOIN property p ON p.id = e.property_id
     GROUP BY p.account_id
  ),
  zustellungen AS (
    SELECT d.account_id,
           count(*) FILTER (WHERE d.status = 'failed') AS fehlgeschlagen,
           min(d.occurred_at) FILTER (WHERE d.status = 'failed') AS aelteste
      FROM webhook_delivery d
     GROUP BY d.account_id
  ),
  nachtlauf AS (
    SELECT p.account_id, max(b.date) AS letzter
      FROM business_day b JOIN property p ON p.id = b.property_id
     WHERE b.closed_at IS NOT NULL
     GROUP BY p.account_id
  )
  SELECT a.id, a.name, a.status,
         COALESCE(post.wartend, 0), COALESCE(post.fehlgeschlagen, 0), post.aelteste,
         COALESCE(zustellungen.fehlgeschlagen, 0), zustellungen.aelteste,
         nachtlauf.letzter
    FROM account a
    LEFT JOIN post ON post.account_id = a.id
    LEFT JOIN zustellungen ON zustellungen.account_id = a.id
    LEFT JOIN nachtlauf ON nachtlauf.account_id = a.id
   WHERE platform_can('platform:operations')
   ORDER BY a.name
$$;
