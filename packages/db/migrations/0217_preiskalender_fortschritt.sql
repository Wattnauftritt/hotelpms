-- ---------------------------------------------------------------------------
-- 0217 -- Preiskalender-Abruf: Fortschritt vom Umsystem.
--
-- Anforderung: Sven, 27.10.2026 (Thread "Preisabruf vom Channelmanager
-- beschleunigen"). Ein Abruf ueber ein ganzes Jahr dauert Minuten, und die
-- Oberflaeche fragte nach zwei Minuten "Laeuft das Umsystem?", obwohl es
-- lief: sie sah nur den Auftrag und die fertige Lieferung, nichts dazwischen.
--
-- Das Umsystem meldet jetzt zwischendurch, wie viele Tage es schon geholt
-- hat (`PUT .../rate-calendar-pulls/:ref` mit `status: progress`). Gezaehlt
-- werden Tage, nicht ein "bis": holt das Umsystem mehrere Bloecke
-- nebeneinander, kommen sie nicht der Reihe nach fertig.
--
-- `progress_at` ist das letzte Lebenszeichen. Die Frage, ob das Umsystem
-- laeuft, stellt die Oberflaeche erst, wenn seitdem lange nichts kam --
-- nicht mehr, wenn der Auftrag alt ist.
--
-- Nichts davon ist personenbezogen; kein Eintrag in `audit_redaction`, und
-- die Tabelle hat keinen Audit-Trigger (0179).
-- ---------------------------------------------------------------------------

ALTER TABLE rate_calendar_pull
  ADD COLUMN progress_days integer CHECK (progress_days >= 0),
  ADD COLUMN progress_at   timestamptz;
