-- ---------------------------------------------------------------------------
-- 0132 -- Ein Zahlungslink loest nur bei aktivem Account und Haus auf.
--
-- Befund N4 (Nebenbefund) aus dem Sicherheitsaudit vom 11.10.2026
-- (security/audit-2026-10-11.md). payment_link_scope() aus 0068 nannte das
-- Haus zu jedem Token, gleich ob der Account gesperrt oder das Haus
-- stillgelegt war. Die Zahlungsseite legte dann weiter Checkouts beim
-- Anbieter an -- fuer einen Kunden, dessen Zugang die Plattform gerade
-- angehalten hat, und mit dem Stripe-Konto der Plattform.
--
-- Dieselbe Bedingung wie beim Geraet am Tresen (0103,
-- terminal_device_principal): was ohne Anmeldung hereinkommt, wirkt nur auf
-- ein aktives Haus eines aktiven Accounts. Ein gesperrter Kunde soll nicht
-- ueber einen Seiteneingang weiterarbeiten, den niemand mitsperrt.
--
-- Der Gast sieht dann "unbekannter Link", wie bei einem falschen Token. Eine
-- eigene Meldung "Haus gesperrt" wuerde einem Fremden mit einem alten Link
-- den Vertragsstand des Hotels verraten.
--
-- Der Webhook ist davon nicht beruehrt: er geht ueber den Checkout, nicht
-- ueber das Token, und eine Zahlung, die beim Anbieter schon eingegangen
-- ist, muss auch bei gesperrtem Account verbucht werden -- das Geld ist da.
--
-- search_path mit pg_temp am Ende, wie jede SECURITY-DEFINER-Funktion
-- (M11): sonst koennte eine temporaere Tabelle gleichen Namens die Abfrage
-- umlenken. Rueckgabetyp und Signatur bleiben; CREATE OR REPLACE behaelt
-- die Rechte aus 0068.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION payment_link_scope(p_hash text)
RETURNS TABLE (link_id bigint, property_id bigint, account_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.property_id, p.account_id
    FROM payment_link l
    JOIN property p ON p.id = l.property_id
    JOIN account a  ON a.id = p.account_id
   WHERE l.token_hash = p_hash
     AND p.status = 'active' AND a.status = 'active';
$$;

COMMENT ON FUNCTION payment_link_scope(text) IS
  'Loest einen Zahlungslink zu Haus und Account auf, nur bei aktivem Haus und Account (0132). SECURITY DEFINER, weil der Gast ohne Kontext kommt. Nur ein Hash, nur Kennungen.';
