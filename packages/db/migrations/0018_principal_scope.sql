-- Auflösung des Zugriffsbereichs eines Nutzers.
--
-- Befund: `loadPrincipal` las zweimal aus `property`, um herzuleiten, welche
-- Häuser ein Nutzer sieht und zu welchem Account sie gehören. Beide Abfragen
-- liefen mit **leerem Mandantenkontext** — was zu diesem Zeitpunkt auch gar
-- nicht anders geht, denn der Kontext ist ja gerade das Ergebnis. Die
-- Zeilenrichtlinie auf `property` lautet `id = ANY (app_property_ids())` und
-- liefert bei leerem Kontext nichts.
--
-- Die Folgen waren zwei, und die zweite ist die schlimmere:
--
-- 1. Eine Property-Rolle brachte ihren Account nicht mit. Der Gast hängt am
--    Account (Entscheidung 13), also sah eine Rezeptionskraft **keine
--    Gastprofile** — und eine Rechnung ohne Empfänger wird nach § 14 UStG
--    zu Recht abgewiesen.
-- 2. Eine **Account-Rolle wirkte auf gar keine Property**. Genau das ist aber
--    ihr ganzer Zweck: „Direktion sieht alle Häuser der Kette" war damit
--    wirkungslos. In den Tests fiel es nicht auf, weil dort zusätzlich immer
--    eine Property-Rolle vergeben wurde.
--
-- Die Auflösung ist ein Henne-Ei-Problem und lässt sich mit einer
-- Zeilenrichtlinie nicht lösen: um zu wissen, was jemand sehen darf, muss
-- man einmal etwas lesen, das die Richtlinie noch nicht freigibt. Genau
-- dafür ist SECURITY DEFINER da.
--
-- Die Funktion ist eng gebaut, damit sie nichts weiter öffnet als nötig:
-- sie antwortet **nur für einen Nutzer**, nicht auf eine Liste von Accounts
-- oder Properties, und sie gibt ausschließlich Kennungen zurück, keine
-- Inhalte. Damit lässt sich damit nichts aufzählen, was nicht ohnehin schon
-- in den Rollen dieses Nutzers steht.

CREATE OR REPLACE FUNCTION user_property_scope(p_user bigint)
RETURNS TABLE (property_id bigint, account_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Häuser aus Property-Rollen, mit ihrem Account: die Rolle hängt am Haus,
  -- das Gastprofil am Account, und ohne diese Zeile sähe die Rezeption keinen
  -- einzigen Gast.
  SELECT p.id, p.account_id
    FROM user_property_role upr
    JOIN property p ON p.id = upr.property_id
   WHERE upr.user_id = p_user AND p.status = 'active'
  UNION
  -- Häuser, die über eine Account-Rolle erreichbar sind. Eine Account-Rolle
  -- gilt für alle Häuser des Accounts, auch für solche, die es beim Vergeben
  -- der Rolle noch nicht gab.
  SELECT p.id, p.account_id
    FROM user_account_role uar
    JOIN property p ON p.account_id = uar.account_id
   WHERE uar.user_id = p_user AND p.status = 'active';
$$;

COMMENT ON FUNCTION user_property_scope(bigint) IS
  'Löst den Zugriffsbereich eines Nutzers auf. SECURITY DEFINER, weil der Mandantenkontext zu diesem Zeitpunkt erst entsteht. Antwortet nur für einen Nutzer und gibt nur Kennungen zurück.';
