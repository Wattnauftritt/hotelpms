-- ---------------------------------------------------------------------------
-- `idempotency_key` kommt in den Mandantenbereich (Befund 9, Dokument 26).
--
-- Befund. Die Tabelle speichert `response_body` -- die vollstaendige Antwort
-- der API -- ohne Zeilenrichtlinie, mit dem Client als Schluessel und nicht
-- dem Mandanten.
--
-- Was das Audit zu grob gesagt hat: der Rumpf sei entbehrlich. Er ist es
-- nicht. Idempotenz heisst gerade, dass ein wiederholter Aufruf **dieselbe**
-- Antwort bekommt statt einer zweiten Buchung; wer wiederholt, hat die erste
-- Antwort ja nicht erhalten. Die Spalte zu leeren haette den Zweck der
-- Tabelle beseitigt, nicht ihr Risiko.
--
-- Was tatsaechlich fehlt, ist die Grenze. Benutzt wird die Idempotenz von
-- den Zahlungs- und Kassenrouten; in den Antworten stehen Folios, Betraege
-- und Zahlungsadressen -- kein Gastprofil, aber Daten eines Hauses in einer
-- Tabelle, die kein Haus kennt. Sie bekommt deshalb eine Kennung und eine
-- Richtlinie wie jede andere.
--
-- Eine gezielte Loeschung je Gast gibt es bewusst nicht: die Rueckgaben
-- nennen keinen Gast, die Frist betraegt 24 Stunden, und ein Durchsuchen von
-- JSON nach Kennungen waere mehr Angriffsflaeche als Schutz.
-- ---------------------------------------------------------------------------

ALTER TABLE idempotency_key ADD COLUMN account_id bigint REFERENCES account(id);

-- Der Altbestand laeuft ohnehin binnen 24 Stunden ab. Ihn zu erraten waere
-- Rateschritt ohne Nutzen; er faellt aus der Richtlinie heraus und wird vom
-- Pflegejob entfernt.
COMMENT ON COLUMN idempotency_key.account_id IS
  'Mandant, fuer den der Schluessel gilt. NULL nur im Altbestand vor 0046.';

ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant ON idempotency_key
  USING (account_id = ANY (app_account_ids()))
  WITH CHECK (account_id = ANY (app_account_ids()));

CREATE INDEX idempotency_account ON idempotency_key (account_id);
