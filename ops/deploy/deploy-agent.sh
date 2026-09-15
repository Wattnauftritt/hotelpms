#!/usr/bin/env bash
# Fuehrt eine angeforderte Ausrollung aus. Als Benutzer hotelpms, per Timer.
#
# **Warum ein eigener Prozess und nicht die API.** Die API laeuft unter
# NoNewPrivileges=true; sudo ist aus ihr heraus gesperrt, und der Neustart
# der Dienste braucht genau das. Das ist der Grund, warum ein Einbruch in
# die Anwendung nicht gleich die Maschine ist -- und deshalb schreibt die
# API nur eine Zeile in deploy_request, statt selbst auszurollen.
#
# Dieses Skript holt die aelteste offene Anforderung, fuehrt deploy.sh aus
# und vermerkt den Ausgang. Es laeuft minuetlich; findet es nichts, endet es
# sofort.
set -uo pipefail

WURZEL="${HOTELPMS_ROOT:-/opt/hotelpms}"
CURRENT="$WURZEL/current"
UMGEBUNG="$WURZEL/shared/env"

set -a; . "$UMGEBUNG"; set +a
: "${DATABASE_URL:?DATABASE_URL fehlt in der Umgebungsdatei}"

psql_() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAq "$@"; }

# Beanspruchen: aelteste offene Anforderung, unter Sperre und ohne Warten.
# SKIP LOCKED, damit zwei Timerlaeufe sich nicht gegenseitig blockieren --
# der zweite findet dann nichts und endet, was richtig ist.
GEHOLT="$(psql_ -c "
  UPDATE deploy_request SET status = 'running', started_at = now()
   WHERE id = (SELECT id FROM deploy_request
                WHERE status = 'pending'
                ORDER BY id LIMIT 1
                FOR UPDATE SKIP LOCKED)
  RETURNING id || E'\t' || kind || E'\t' || target_ref")"

[ -z "$GEHOLT" ] && exit 0

IFS=$'\t' read -r ID ART REF <<< "$GEHOLT"
# Der laufende Stand ist der Name des Verzeichnisses, auf das current zeigt.
# Ein `git rev-parse` im Release-Verzeichnis ginge nicht: dort liegt keine
# Geschichte, und das ist Absicht (git archive statt Klon).
laufender() { basename "$(readlink -f "$CURRENT" 2>/dev/null || echo unbekannt)"; }
VORHER="$(laufender)"

AUSGABE="$(mktemp)"

# Der Ausgang wird ueber psql-Variablen gesetzt, nicht in die Abfrage
# eingesetzt. Ein Bauprotokoll enthaelt beliebigen Text -- ein $$ darin
# zerlegte ein dollar-quoting, und Anfuehrungszeichen den Rest. :'name'
# laesst psql selbst quoten, samt Zeilenumbruechen.
vermerken() {
  local status="$1" nachher
  nachher="$(laufender)"
  # Ueber stdin, NICHT ueber -c: psql ersetzt :'name' nur in gelesenem
  # Text, bei -c schickt es die Zeichenkette unveraendert weiter. Hier stand
  # einmal -c, und die Folge war eine Anforderung, die auf 'running' haengen
  # blieb -- waehrend das Skript "durch" meldete.
  if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAq \
       -v status="$status" -v vorher="$VORHER" -v nachher="$nachher" \
       -v log="$(tail -c 4000 "$AUSGABE" 2>/dev/null || true)" \
       -v id="$ID" <<'SQL' >/dev/null
UPDATE deploy_request
   SET status = :'status', finished_at = now(),
       commit_before = :'vorher', commit_after = :'nachher',
       log = :'log'
 WHERE id = :id;
SQL
  then
    # Laut werden. Bleibt die Zeile auf 'running', blockiert sie ueber den
    # eindeutigen Teilindex jede weitere Anforderung, und am Knopf ist nur
    # zu sehen, dass er nicht mehr geht.
    echo "ALARM: Ausgang der Ausrollung $ID liess sich nicht vermerken." >&2
    return 1
  fi
}

# Auch bei einem Abbruch vermerken: eine Anforderung, die auf 'running'
# stehen bleibt, blockiert ueber den eindeutigen Teilindex jede weitere --
# und niemand sieht, warum der Knopf nicht mehr geht.
trap 'vermerken failed; rm -f "$AUSGABE"' EXIT

# HOTELPMS_DEPLOY_REQUEST sagt deploy.sh, dass der Lauf schon verbucht ist.
# deploy.sh wird aus dem LAUFENDEN Stand genommen, nicht aus dem, der
# gerade gebaut wird -- sonst tauschte sich das Skript mitten im Lauf unter
# sich selbst aus. Wer deploy.sh aendert, dessen Aenderung wirkt also erst
# beim uebernaechsten Ausrollen; das ist der Preis dafuer, dass ein Lauf
# nicht auf halber Strecke die Bauart wechselt.
if HOTELPMS_DEPLOY_REQUEST="$ID" "$CURRENT/ops/deploy/deploy.sh" "$ART" "$REF" \
     > "$AUSGABE" 2>&1; then
  trap - EXIT
  vermerken done
  rm -f "$AUSGABE"
  echo "Ausrollung $ID ($ART $REF) durch."
else
  trap - EXIT
  vermerken failed
  echo "Ausrollung $ID ($ART $REF) gescheitert. Letzte Zeilen:" >&2
  tail -20 "$AUSGABE" >&2 2>/dev/null || true
  rm -f "$AUSGABE"
  exit 1
fi
