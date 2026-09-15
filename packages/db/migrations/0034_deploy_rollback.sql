-- Zurueckrollen als eigener Vorgang (Ergaenzung zu Migration 0033).
--
-- **Der Befund.** deploy.sh baute im selben Verzeichnis, aus dem die Dienste
-- laufen. Scheitert der Bau, steht der Quellbaum schon auf dem neuen Commit,
-- waehrend dist/ halb alt und halb neu ist -- die laufenden Prozesse merken
-- nichts, weil sie ihren Code im Speicher haben. Startet die Maschine aber
-- aus einem anderen Grund neu, faehrt sie mit einem halben Bau hoch.
--
-- Gebaut wird deshalb jetzt **neben** dem laufenden Stand, nach
-- releases/<sha>, und erst am Ende schaltet ein Symlink um. Ein gescheiterter
-- Bau laesst den laufenden Stand voellig unberuehrt.
--
-- Damit faellt das Zurueckrollen nebenbei ab: den Symlink auf einen aelteren
-- Stand zeigen lassen, Dienste neu starten, fertig. Es braucht nur eine
-- Unterscheidung, welcher Art eine Anforderung ist -- sonst muesste der
-- ausfuehrende Dienst am Wert von target_ref raten, ob er bauen soll oder
-- nicht. Raten ist an dieser Stelle die schlechteste aller Moeglichkeiten.

ALTER TABLE deploy_request
  ADD COLUMN kind text NOT NULL DEFAULT 'deploy'
    CHECK (kind IN ('deploy', 'rollback'));

/*
 * Was zurueckgerollt werden kann, steht nicht in einer eigenen Tabelle.
 *
 * Die Wahrheit darueber liegt auf der Platte: welche Verzeichnisse unter
 * releases/ noch da sind. Eine Tabelle daneben waere eine zweite Wahrheit,
 * die auseinanderlaeuft, sobald jemand von Hand aufraeumt -- und dann boete
 * die Oberflaeche einen Stand an, den es nicht mehr gibt.
 *
 * Angeboten werden deshalb die commit_after der letzten geglueckten Laeufe;
 * der ausfuehrende Dienst prueft, ob das Verzeichnis wirklich steht, und
 * sagt es deutlich, wenn nicht. Er behaelt so viele Staende, wie die
 * Oberflaeche anbietet.
 */
