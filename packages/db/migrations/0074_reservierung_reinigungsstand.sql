-- ---------------------------------------------------------------------------
-- Die Rolle "Reservierung" bekommt `housekeeping:read`.
--
-- Anforderung (02.10.2026): wer Zimmer zuteilt, muss im Belegungsplan sehen,
-- ob ein Zimmer sauber ist und belegt werden kann. Rezeption, Empfangsleitung
-- und Nachtaudit hatten das Recht seit 0003; die Rolle "Reservierung" bucht
-- und verschiebt im selben Plan und sah den Reinigungsstand nicht.
--
-- Nur lesen. Setzen (`housekeeping:write`) bleibt bei Rezeption und
-- Housekeeping: wer am Schreibtisch bucht, steht nicht im Zimmer.
--
-- Nebenwirkung, gewollt: das Recht oeffnet auch den Housekeeping-Bildschirm
-- und die Liste der Wartungsmeldungen, beide nur lesend. Dieselben Daten
-- hinter zwei Rechten zu verteilen, waere die zweite Tuer, die
-- `routes/availability.ts` ausdruecklich vermeidet.
--
-- Revenue bleibt ohne: die Rolle sieht den Plan fuer die Auslastung.
-- ---------------------------------------------------------------------------

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'housekeeping:read'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key = 'reservations'
ON CONFLICT DO NOTHING;
