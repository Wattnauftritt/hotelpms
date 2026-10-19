-- ---------------------------------------------------------------------------
-- Das Zahlungsziel einer Firma folgt der Vorgabe des Hauses, solange die
-- Firma kein eigenes hat.
--
-- Sven, 19.10.2026: "natuerlich muss die Voreinstellung aus den
-- Einstellungen genommen werden und nicht dreierlei Standardwerte".
--
-- Bisher stand die 14 an drei Stellen: als Vorgabe der Spalte hier (0008),
-- als COALESCE in `POST /v1/companies` und vorbelegt in der Maske. Jede
-- Firma trug damit ein eigenes Ziel, und weil die Rechnung das der Firma
-- vor dem des Hauses nimmt (billing.ts, Faelligkeit), wirkte die
-- Einstellung unter Rechnungen fuer keinen Firmengast.
--
-- Jetzt heisst NULL: Vorgabe des Hauses, das die Rechnung ausstellt. Die
-- Firma gehoert dem Account, nicht einem Haus; bei zwei Haeusern mit
-- verschiedener Vorgabe gilt so die des jeweiligen Hauses.
--
-- Bestehende 14 werden NULL. Eine 14 laesst sich von der alten Vorgabe
-- nicht unterscheiden, und die Maske zeigte das Feld ohne sichtbare
-- Beschriftung; dass jemand sie bewusst gesetzt hat, ist die unwahr-
-- scheinlichere Lesart. Ausgestellte Rechnungen aendert das nicht, ihre
-- Faelligkeit steht seit 0159 an der Rechnung.
ALTER TABLE company ALTER COLUMN payment_terms_days DROP NOT NULL;
ALTER TABLE company ALTER COLUMN payment_terms_days DROP DEFAULT;
UPDATE company SET payment_terms_days = NULL WHERE payment_terms_days = 14;
ALTER TABLE company ADD CONSTRAINT company_payment_terms_days_range
  CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365);
