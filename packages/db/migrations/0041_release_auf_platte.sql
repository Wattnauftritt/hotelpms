-- Was unter releases/ wirklich liegt -- damit das Zurueckrollen die Platte
-- kennt und nicht nur die Geschichte des Agenten.
--
-- **Der Befund.** Das Panel bot "kein frueherer Stand" an, waehrend auf der
-- Maschine drei gebaute Staende lagen. Die Liste kam aus deploy_request:
-- nur Staende gegluecketer Laeufe des Agenten (status = 'done') galten als
-- Ziel. Ein von Hand ausgerollter Stand hat keine Zeile; ein Lauf, der nach
-- umgelegtem Symlink am Neustart scheiterte (0040-Ausrollung, sudoers),
-- steht auf 'failed' -- gebaut, umgeschaltet, gelaufen, und trotzdem
-- unsichtbar. Der Kommentar in der Route nannte die Platte "eine zweite
-- Wahrheit". Sie ist die erste: zurueckgerollt wird auf ein Verzeichnis,
-- nicht auf eine Zeile.
--
-- Die API kommt an die Platte nicht heran und soll es nicht; der Agent
-- schon. Er traegt bei jedem Tick ein, welche Staende mit .fertig dort
-- liegen und worauf `current` zeigt. Eine Minute alt ist die Liste
-- hoechstens, und das genuegt: Staende kommen und gehen nur durch ihn.

CREATE TABLE release (
  commit      text PRIMARY KEY,
  -- Wann der Agent das Verzeichnis zuletzt gesehen hat. Bleibt es aus,
  -- wurde es weggeraeumt (deploy.sh behaelt fuenf).
  seen_at     timestamptz NOT NULL DEFAULT now(),
  present     boolean NOT NULL DEFAULT true,
  -- Genau eine Zeile traegt es: der Stand, auf den `current` zeigt.
  is_current  boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX release_current ON release ((true)) WHERE is_current;

COMMENT ON TABLE release IS
  'Staende unter releases/, wie der Ausrollagent sie beim letzten Tick sah. '
  'Quelle fuer das Zurueckrollen und fuer "laeuft gerade".';

-- Der Agent schreibt mit der Anwendungsrolle (DATABASE_URL in shared/env),
-- die API liest mit derselben. Kein DELETE: ein verschwundener Stand wird
-- als present = false vermerkt, nicht geloescht -- die Geschichte bleibt.
GRANT SELECT, INSERT, UPDATE ON release TO hotelpms_app;
