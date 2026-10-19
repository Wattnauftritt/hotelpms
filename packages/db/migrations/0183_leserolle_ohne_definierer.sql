-- ---------------------------------------------------------------------------
-- 0183 -- Die Leserolle fuehrt keine SECURITY-DEFINER-Funktion mehr aus.
--
-- Befund M1 aus dem Sicherheitsaudit vom 19.10.2026
-- (security/audit-2026-10-19.md). 0001 gab per Standardrecht jeder Funktion
-- EXECUTE fuer hotelpms_readonly, und PostgreSQL gibt es ohnehin PUBLIC. Eine
-- SECURITY-DEFINER-Funktion laeuft mit den Rechten der Eigentuemerin, und den
-- Kontext (`app.*`) setzt jede Rolle mit set_config selbst: die Rolle fuer
-- "Auswertungen, Steuerberater" (Dokument 21) konnte so Gaeste anonymisieren
-- (guest_erase_one), Kassenbuchzeilen loeschen, Kurtaxe buchen,
-- Rechnungsnummern verbrauchen (Luecken im Nummernkreis, GoBD) und mit einer
-- gesetzten Plattform-Benutzer-ID Kunden sperren.
--
-- Was die Leserolle braucht, sind die Hilfen der Zeilenrichtlinien
-- (app_account_ids, app_property_ids). Die sind keine SECURITY-DEFINER-
-- Funktionen und bleiben, wie sie sind. Keine SECURITY-DEFINER-Funktion
-- wird von einer Richtlinie oder einer Sicht gerufen; die Leserolle braucht
-- deshalb keine einzige.
--
-- Bewusst die hoechste Nummer dieser Reihe: die Schleife erfasst jede
-- Funktion, die es bis hierhin gibt, auch channel_connection_for_auth aus
-- 0181. Eine spaetere Migration, die eine SECURITY-DEFINER-Funktion anlegt,
-- muss sie selbst von PUBLIC und hotelpms_readonly nehmen;
-- packages/db/src/__tests__/sicherheitsdefinierer.test.ts faellt sonst mit
-- ihrem Namen.
-- ---------------------------------------------------------------------------

-- Kuenftige Funktionen: kein ausdrueckliches Recht mehr fuer die Leserolle.
-- Das Recht ueber PUBLIC bleibt fuer gewoehnliche Funktionen bestehen, denn
-- eine neue Hilfe einer Zeilenrichtlinie muss die Leserolle ausfuehren
-- koennen; fuer SECURITY-DEFINER-Funktionen haelt es der Test fest.
ALTER DEFAULT PRIVILEGES FOR ROLE hotelpms_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM hotelpms_readonly;

/*
 * Bestehende Funktionen. Das Recht kommt auf zwei Wegen, ueber PUBLIC und
 * ausdruecklich; beide fallen. Die Anwendung hatte es fast immer
 * ausdruecklich (Standardrecht aus 0001), aber nicht ueberall: wo sie es nur
 * ueber PUBLIC hatte, wird es ihr hier ausdruecklich gegeben, damit sich fuer
 * sie nichts aendert. Was ihr frueher entzogen wurde (0129, 0133 ...), hat
 * sie auch ueber PUBLIC nicht mehr und bekommt es nicht zurueck.
 */
DO $$
DECLARE
  f regprocedure;
  app_darf boolean;
BEGIN
  FOR f IN SELECT p.oid::regprocedure
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef LOOP
    app_darf := has_function_privilege('hotelpms_app', f, 'EXECUTE');
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, hotelpms_readonly', f);
    IF app_darf THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hotelpms_app', f);
    END IF;
  END LOOP;
END $$;
