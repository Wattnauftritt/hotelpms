-- ---------------------------------------------------------------------------
-- `audit_log` bekommt eine Zeilenrichtlinie und eine Frist
-- (Befund 2 und 3, Dokument 24).
--
-- Befund 2. Von den Tabellen mit Mandantenbezug trug `audit_log` als einzige
-- keine Richtlinie, bei gleichzeitigem SELECT-Recht fuer hotelpms_app. Sie
-- fuehrt property_id und account_id als Spalten, verliess sich zur Trennung
-- aber darauf, dass jede Abfrage von Hand filtert.
--
-- Heute liest keine Route daraus -- es wird nur geschrieben. Der Befund ist
-- deshalb keine offene Luecke, sondern eine gestellte Falle: die erste Route,
-- die ein Protokoll anzeigen will, faellt hinein. Genau dieser Fehler steht
-- in CLAUDE.md zweimal als bereits passiert (Migrationen 0014, 0018), beide
-- Male still bemerkt.
--
-- Befund 3. `audit_log_ensure_partitions` legt zwoelf Monate im Voraus an.
-- Ein Gegenstueck, das alte Partitionen entfernt, gab es nicht -- weder in
-- der Datenbank noch im Worker. Das Protokoll wuchs unbegrenzt. Art. 5 Abs. 1
-- lit. e verlangt eine Frist; "so lange wie die Platte reicht" ist keine.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

-- Lesen nur im eigenen Kontext. Zeilen ohne beide Kennungen sind
-- Plattformvorgaenge und bleiben damit unsichtbar -- das ist richtig: sie
-- gehoeren keinem Kunden.
CREATE POLICY tenant ON audit_log
  USING (property_id = ANY (app_property_ids())
         OR account_id = ANY (app_account_ids()));

-- Der Schreibpfad laeuft ueber audit_trigger() mit SECURITY DEFINER und ist
-- davon unberuehrt. Die Route, die einen Ausweisabruf vermerkt, schreibt
-- dagegen unmittelbar -- sie braucht eine eigene Erlaubnis, sonst wiese die
-- Richtlinie ihren INSERT ab.
CREATE POLICY tenant_insert ON audit_log FOR INSERT
  WITH CHECK (property_id = ANY (app_property_ids())
              OR account_id = ANY (app_account_ids())
              OR (property_id IS NULL AND account_id IS NULL));

-- ---------------------------------------------------------------------------
-- Aufbewahrung.
--
-- Zehn Jahre. Die Zahl ist nicht gegriffen: sie entspricht der laengsten
-- handels- und steuerrechtlichen Aufbewahrungsfrist (§ 147 AO, § 257 HGB).
-- Damit muss sie gegenueber einer Pruefung nicht gesondert verteidigt werden
-- -- und laenger als der Beleg, auf den sich ein Protokolleintrag bezieht,
-- muss das Protokoll nicht leben.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_drop_old_partitions(years integer DEFAULT 10)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  r record;
  grenze date := date_trunc('month', current_date - make_interval(years => years))::date;
  entfernt integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname,
           -- Die untere Grenze steht im Namen: audit_log_YYYY_MM.
           to_date(right(c.relname, 7), 'YYYY_MM') AS von
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname ~ '^audit_log_[0-9]{4}_[0-9]{2}$'
  LOOP
    IF r.von < grenze THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      entfernt := entfernt + 1;
    END IF;
  END LOOP;
  RETURN entfernt;
END $$;

COMMENT ON FUNCTION audit_log_drop_old_partitions IS
  'Entfernt Protokollpartitionen jenseits der Aufbewahrungsfrist (Befund 3).';

-- Die Auffangpartition bleibt unangetastet: sie darf nie Zeilen enthalten und
-- wird ueberwacht. Sie zu loeschen hiesse, den Alarm abzuschalten.
