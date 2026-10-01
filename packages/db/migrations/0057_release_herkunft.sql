-- ---------------------------------------------------------------------------
-- Woher der laufende Stand kommt: Zeitpunkt und Betreff des Commits.
--
-- **Der Befund.** Das Adminpanel zeigt unter Betrieb den laufenden Stand als
-- Hash und daneben die Bauzeit (0042). Das beantwortet "welches Verzeichnis
-- laeuft", nicht die Frage, die tatsaechlich gestellt wird: *welcher Stand
-- ist das, und von wann?* Ein Hash sagt niemandem etwas, und die Bauzeit ist
-- die Zeit der Maschine, nicht die der Aenderung -- zwischen Commit und
-- Ausrollen koennen Tage liegen.
--
-- **Warum es bisher nicht ging.** `releases/<sha>` ist ein `git archive`,
-- also ein Verzeichnis ohne Geschichte -- mit Absicht (0042 nennt das als
-- Grund, warum die Commit-Zeit dort fehlt). Die Zeit kennt nur der Klon
-- unter `shared/repo`, und der steht dem Agenten beim Tick nicht als
-- Arbeitsbaum zur Verfuegung.
--
-- **Was sich aendert.** `deploy.sh` hat beides im Moment des Baus: es legt
-- neben `.fertig` eine Zeile mit Zeit und Betreff ab (`.stand`). Der Agent
-- liest sie fuer den laufenden Stand mit. Ein Verzeichnis ohne diese Datei
-- -- alles, was vor dieser Aenderung gebaut wurde -- bleibt wie bisher: NULL,
-- und das Panel zeigt dann Hash und Bauzeit.
-- ---------------------------------------------------------------------------

ALTER TABLE release ADD COLUMN committed_at timestamptz;
ALTER TABLE release ADD COLUMN subject text;

COMMENT ON COLUMN release.committed_at IS
  'Zeitpunkt des Commits, aus git beim Bau mitgeschrieben. Nicht die '
  'Bauzeit: zwischen beiden koennen Tage liegen.';
COMMENT ON COLUMN release.subject IS
  'Erste Zeile der Commit-Nachricht. Ein Hash sagt niemandem, was laeuft.';
