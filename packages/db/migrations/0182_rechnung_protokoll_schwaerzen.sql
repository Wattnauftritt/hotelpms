-- ---------------------------------------------------------------------------
-- 0182 -- Rechnungsfelder aus dem Pruefprotokoll: Aussteller dazu, Altbestand
-- geschwaerzt.
--
-- Befunde N4 und N5 aus dem Sicherheitsaudit vom 19.10.2026
-- (security/audit-2026-10-19.md).
--
-- N4: 0175 hat recipient_snapshot und line_guests in audit_redaction
-- eingetragen, die schon geschriebenen Protokollzeilen aber stehen lassen.
-- Name und Anschrift der Gaeste aus jeder Rechnung bis dahin blieben im
-- Protokoll, das keine Loeschung erreicht -- genau die Kopie, die die erste
-- Regel aus CLAUDE.md verhindern soll.
--
-- N5: issuer_snapshot haelt Ansprechpartner, Telefon, Mail und Kontoinhaber
-- des Hauses (billing.ts). Auf property sind dieselben Werte redigiert; als
-- Momentaufnahme an der Rechnung liefen sie am Protokoll vorbei. Die Rechnung
-- selbst behaelt sie, sie ist der Beleg, den die Frist meint.
-- ---------------------------------------------------------------------------

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('invoice', 'issuer_snapshot', 'Ansprechpartner, Telefon, Mail und Kontoinhaber des Hauses')
ON CONFLICT DO NOTHING;

-- Die bereits geschriebenen Kopien, wie in 0044 und 0129: der
-- Append-only-Trigger wird fuer genau diese Anweisung ausgesetzt, an der
-- Elterntabelle und an jeder Partition, und in derselben Transaktion wieder
-- scharf geschaltet. Alle redigierten Spalten der Rechnung auf einmal, damit
-- auch line_guests aus 0175 erfasst ist.
-- >>> altbestand
DO $$
DECLARE
  p regclass;
  cols text[];
BEGIN
  FOR p IN SELECT 'audit_log'::regclass
           UNION ALL
           SELECT inhrelid::regclass FROM pg_inherits
            WHERE inhparent = 'audit_log'::regclass LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER trg_append_only', p);
  END LOOP;

  SELECT array_agg(column_name) INTO cols FROM audit_redaction WHERE table_name = 'invoice';
  UPDATE audit_log SET changed = audit_redact(changed, cols)
   WHERE table_name = 'invoice' AND changed IS NOT NULL AND changed ?| cols;

  FOR p IN SELECT 'audit_log'::regclass
           UNION ALL
           SELECT inhrelid::regclass FROM pg_inherits
            WHERE inhparent = 'audit_log'::regclass LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER trg_append_only', p);
  END LOOP;
END $$;
-- <<< altbestand
