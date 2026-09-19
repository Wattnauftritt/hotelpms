#!/usr/bin/env bash
# Ausrollen auf der Produktivmaschine. Als Benutzer hotelpms ausfuehren.
#
#   deploy.sh deploy   [marker]   baut den Stand am Marker und schaltet um
#   deploy.sh rollback <sha>      schaltet auf einen schon gebauten Stand
#
# **Warum hier und nicht nur in der Anleitung.** Dieses Skript stand bis zur
# Erstinbetriebnahme ausschliesslich in docs/21 §8 -- und lief damit
# zwangslaeufig auseinander: die Anleitung nannte /srv/hotelpms, die Units in
# ops/systemd/ /opt/hotelpms, und niemandem fiel es auf, weil beide Seiten
# fuer sich stimmig aussahen. Was auf der Maschine laeuft, gehoert ins
# Repository; die Anleitung verweist darauf, statt es zu wiederholen.
#
# **Gebaut wird neben dem laufenden Stand, nicht in ihm.**
#
# Hier wurde einmal im selben Verzeichnis gebaut, aus dem die Dienste laufen.
# Scheitert der Bau, steht der Quellbaum dann schon auf dem neuen Commit,
# waehrend dist/ halb alt und halb neu ist. Die laufenden Prozesse merken
# nichts -- ihr Code liegt im Speicher. Startet die Maschine aber aus einem
# anderen Grund neu, faehrt sie mit einem halben Bau hoch, und der Befund
# liegt Tage zurueck.
#
# Jetzt entsteht je Stand ein eigenes Verzeichnis unter releases/, und erst
# wenn es vollstaendig ist, zeigt der Symlink `current` darauf. Ein
# gescheiterter Bau laesst den laufenden Stand voellig unberuehrt -- und das
# Zurueckrollen faellt nebenbei ab.
set -euo pipefail

WURZEL="${HOTELPMS_ROOT:-/opt/hotelpms}"
REPO="$WURZEL/shared/repo"
RELEASES="$WURZEL/releases"
CURRENT="$WURZEL/current"
UMGEBUNG="$WURZEL/shared/env"

# So viele Staende bleiben stehen. Muss mindestens so gross sein wie das,
# was die Oberflaeche zum Zurueckrollen anbietet -- sonst zeigt sie einen
# Stand an, den es auf der Platte nicht mehr gibt.
BEHALTEN="${HOTELPMS_RELEASES_BEHALTEN:-5}"

MODUS="${1:-deploy}"

set -a; . "$UMGEBUNG"; set +a

# ---------------------------------------------------------------- umschalten
#
# Der Symlink wird ueber ein Zwischenziel gesetzt und dann verschoben:
# `ln -sfn` auf einen bestehenden Symlink ist NICHT atomar -- es loescht erst
# und legt dann neu an, und in der Luecke zeigt `current` ins Leere. `mv -T`
# ist ein rename(2) und damit unteilbar.
umschalten() {
  local ziel="$1"
  ln -sfn "$ziel" "$WURZEL/current.neu"
  mv -Tf "$WURZEL/current.neu" "$CURRENT"

  # Migrationen mit der Eigentuemerrolle, nie mit der Anwendungsrolle.
  #
  # Nach dem Umschalten und vor dem Neustart: das Schema ist dabei kurz neuer
  # als der laufende Code, und das ist die richtige Richtung. Eine
  # hinzugefuegte Spalte stoert den alten Code nicht, ein fehlendes Schema
  # den neuen schon.
  (cd "$CURRENT" && pnpm --filter @hotelpms/db migrate)

  # Braucht die Regel in /etc/sudoers.d/hotelpms -- genau diese beiden
  # Neustarts, nichts weiter.
  #
  # **Zwei Aufrufe, nicht einer.** sudoers vergleicht die ganze Kommandozeile
  # mit der Regel, Wort fuer Wort. `systemctl restart hotelpms-api
  # hotelpms-worker` ist ein drittes Kommando, das keine der beiden Regeln
  # kennt -- sudo fragt dann nach einem Kennwort, das es in einem Dienst
  # nicht gibt, und die Ausrollung endet nach umgelegtem Symlink und
  # angewandten Migrationen mit "a password is required". Genau so ist es
  # beim ersten Lauf ueber den Agenten passiert; von Hand als root fiel es
  # nie auf, weil root nicht gefragt wird. scripts/check-sudoers.sh haelt
  # Skript und Regel jetzt in CI aneinander.
  sudo systemctl restart hotelpms-api
  sudo systemctl restart hotelpms-worker

  # Nicht "gestartet", sondern "antwortet". Ein Dienst, der sofort wieder
  # stirbt, laeuft fuer systemd trotzdem kurz.
  sleep 2
  curl -fsS --unix-socket /run/hotelpms/api.sock http://localhost/health
  echo
}

# ----------------------------------------------------------------- zurueck
if [ "$MODUS" = "rollback" ]; then
  SHA="${2:?rollback braucht den Stand: deploy.sh rollback <sha>}"
  ZIEL="$RELEASES/$SHA"
  if [ ! -d "$ZIEL" ]; then
    echo "Stand $SHA liegt nicht mehr unter $RELEASES." >&2
    echo "Vorhanden: $(ls -1 "$RELEASES" 2>/dev/null | tr '\n' ' ')" >&2
    exit 1
  fi
  echo "Zurueck auf $SHA"
  # **Die Migrationen wandern NICHT mit zurueck.** Das Schema bleibt auf dem
  # Stand des neueren Codes. Fuer hinzufuegende Aenderungen ist das
  # unproblematisch -- der aeltere Code sieht eine Spalte mehr und benutzt
  # sie nicht. Wer eine Migration schreibt, die Bestehendes wegnimmt oder
  # umdeutet, nimmt dem Zurueckrollen genau diese Eigenschaft.
  umschalten "$ZIEL"
  exit 0
fi

# ------------------------------------------------------------------ bauen
MARKER="${2:-${HOTELPMS_DEPLOY_REF:-produktion}}"

# Ein eigener Klon, aus dem heraus geholt wird. Er ist nie der Stand, der
# laeuft: dort steht nur Geschichte, kein Arbeitsbaum, den ein halber Lauf
# beschaedigen koennte.
git -C "$REPO" fetch --prune --force --tags origin
SHA="$(git -C "$REPO" rev-parse "$MARKER^{commit}")"
ZIEL="$RELEASES/$SHA"

echo "Ausgerollt wird $MARKER = $SHA"

if [ -d "$ZIEL" ] && [ -e "$ZIEL/.fertig" ]; then
  echo "Stand $SHA ist schon gebaut, es wird nur umgeschaltet."
  umschalten "$ZIEL"
  exit 0
fi

# Ein Rest aus einem abgebrochenen Lauf wird weggeraeumt, nicht
# weiterbenutzt: er ist genau der halbe Bau, den diese Bauart verhindern soll.
rm -rf "$ZIEL"
mkdir -p "$ZIEL"

# git archive statt eines Klons je Stand: ein Release-Verzeichnis braucht
# keine Geschichte, und ohne .git kann kein spaeterer Lauf versehentlich
# darin arbeiten.
git -C "$REPO" archive "$SHA" | tar -x -C "$ZIEL"

cd "$ZIEL"
pnpm install --frozen-lockfile
pnpm build

# Die gebaute Oberflaeche dorthin, wo Caddy sie sucht. Ohne diesen Schritt
# zeigt Caddy nach einem frischen Bau ein leeres Verzeichnis: pnpm build legt
# sie in apps/web/dist, der Caddyfile bedient current/web. Fiel bei der
# Erstinbetriebnahme auf, weil beide Seiten fuer sich richtig waren.
cp -a "$ZIEL/apps/web/dist" "$ZIEL/web"

# Erst jetzt gilt der Stand als vollstaendig. Bricht irgendetwas davor ab,
# fehlt diese Marke, und der naechste Lauf baut neu statt umzuschalten.
touch "$ZIEL/.fertig"

umschalten "$ZIEL"

# Alte Staende wegraeumen -- aber nie den laufenden, auch wenn er alt ist.
# Ein Zurueckrollen auf einen Stand, dessen Verzeichnis gerade geloescht
# wurde, waere der teuerste Weg, Platz zu sparen.
LAEUFT="$(basename "$(readlink -f "$CURRENT")")"
# shellcheck disable=SC2012
ls -1t "$RELEASES" | tail -n +"$((BEHALTEN + 1))" | while read -r alt; do
  [ "$alt" = "$LAEUFT" ] && continue
  echo "raeume alten Stand $alt"
  rm -rf "${RELEASES:?}/$alt"
done
