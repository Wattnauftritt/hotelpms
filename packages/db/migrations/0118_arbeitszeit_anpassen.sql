-- ---------------------------------------------------------------------------
-- 0118 Zusatzarbeit: die Leitung passt die Minuten an
--
-- Sven, 10.10.2026: in der alten App liess sich die Zeit einer Zusatzarbeit
-- bearbeiten, wenn die Kraft sie falsch eingetragen hatte, und "×" nahm sie
-- heraus. Mit 0111 ging das nur ueber eine Korrektur mit Vorzeichen und
-- Grund daneben -- fuer "40 statt 10 Minuten getippt" ein Umweg, und die
-- Tagesansicht zeigte danach zwei Zeilen fuer eine Arbeit.
--
-- Was von 0111 bleibt: die Abrechnung aendert sich nicht still. Die Kraft
-- sieht an ihrem Eintrag, dass die Leitung ihn angepasst hat und was sie
-- selbst eingetragen hatte. Dafuer steht der Wert der Kraft in
-- `original_minutes`, gesetzt bei der ersten Anpassung und danach nie
-- wieder ueberschrieben; wer angepasst hat, steht in `adjusted_by`.
--
-- Ein angepasster Eintrag gehoert der Leitung: die Kraft aendert ihn nicht
-- mehr und zieht ihn nicht zurueck (Route), sonst kippte sie die Anpassung
-- mit einem Tipp. Herausnehmen kann die Leitung mit `withdrawn_at` wie die
-- Kraft; `updated_by` sagt dann, wer es war.
--
-- **Datenschutz.** `original_minutes` ist Arbeitszeit wie `minutes` und
-- steht deshalb in `audit_redaction`.
-- ---------------------------------------------------------------------------

ALTER TABLE staff_work_entry
  ADD COLUMN original_minutes integer,
  ADD COLUMN adjusted_by      bigint REFERENCES app_user(id),
  ADD COLUMN adjusted_at      timestamptz,
  ADD CONSTRAINT staff_work_entry_anpassung CHECK (
    (original_minutes IS NULL AND adjusted_by IS NULL AND adjusted_at IS NULL)
    OR (kind = 'extra' AND original_minutes BETWEEN 1 AND 1440
        AND adjusted_at IS NOT NULL));

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('staff_work_entry', 'original_minutes', 'Arbeitszeit, Personaldatum');
