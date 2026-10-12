-- ---------------------------------------------------------------------------
-- 0148 Digitale Gaestemappe: auf die Zwischenreinigung verzichten
--
-- Plan gaestemappe/plan.md, Baustein 5: der Verzicht aus 0115 bekommt eine
-- dritte Tuer. Bisher setzte ihn der Gast ueber den Link zum
-- Online-Check-in ('guest') oder die Rezeption ('reception'); jetzt auch die
-- freigeschaltete Mappe im Zimmer (0147).
--
-- Ein eigener Wert und nicht 'guest': die Hausdame soll nachlesen koennen,
-- ueber welche Tuer verzichtet wurde. Kommt ein Wunsch, den niemand
-- erklaeren kann, ist "ueber die Karte im Zimmer" eine andere Spur als
-- "ueber den Link in der Mail".
--
-- Sonst aendert sich nichts: welche Tage gehen, bis wann, und wer davon
-- erfaehrt, regelt weiter `setzeVerzicht` an einer Stelle.
-- ---------------------------------------------------------------------------

ALTER TABLE cleaning_waiver DROP CONSTRAINT cleaning_waiver_source_check;
ALTER TABLE cleaning_waiver ADD CONSTRAINT cleaning_waiver_source_check
  CHECK (source IN ('guest','reception','folder'));
