-- ---------------------------------------------------------------------------
-- 0220 -- Preiskalender-Abruf verwerfen.
--
-- Anforderung: Sven, 30.10.2026 (Thread "Preisabruf vom Channel Manager
-- reparieren"). Ein Jahresabruf kam mit Verspaetung an, und die Preise darin
-- waren aelter als die in StayGrid gepflegten. Die Vorschau liess nur
-- "Uebernehmen" zu; wegklicken ging nicht, und die Lieferung stand bei jedem
-- Oeffnen der Preise wieder da.
--
-- `discarded`: ein Mensch hat den Abruf verworfen, es wurde nichts
-- uebernommen. Das gilt auch fuer einen noch wartenden Abruf: haengt das
-- Umsystem, war der Knopf "Abrufen" bis dahin gesperrt, ohne Weg heraus.
-- Ein Umsystem, das danach noch liefert oder einen Zwischenstand meldet,
-- bekommt 409 und hoert auf.
--
-- Kein Audit-Trigger (0179), nichts Personenbezogenes, kein Eintrag in
-- `audit_redaction`.
-- ---------------------------------------------------------------------------

ALTER TABLE rate_calendar_pull DROP CONSTRAINT rate_calendar_pull_status_check;
ALTER TABLE rate_calendar_pull ADD CONSTRAINT rate_calendar_pull_status_check
  CHECK (status IN ('requested','delivered','failed','applied','superseded','discarded'));

ALTER TABLE rate_calendar_pull
  ADD COLUMN discarded_by bigint REFERENCES app_user(id),
  ADD COLUMN discarded_at timestamptz;
