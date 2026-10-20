#!/usr/bin/env bash
# Ausrollen auf der Produktivmaschine. Als Benutzer hotelpms ausfuehren.
#
#   deploy.sh deploy   [marker]   baut den Stand am Marker und schaltet um
#   deploy.sh rollback <sha>      schaltet auf einen schon gebauten Stand
#   deploy.sh app-schluessel      legt den Schluessel fuer App-Pakete an
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

  # Wiederherstellungspunkt vor den Migrationen (Backupstrategie,
  # 15.10.2026). Die Migrationen wandern beim Zurueckrollen nicht mit
  # (unten); geht eine schief, ist dieser Punkt der Weg zurueck:
  # `pgbackrest restore --type=name --target=vor-<sha>` spielt die Datenbank
  # genau bis vor diese Ausrollung zurueck (Dokument 37).
  #
  # Ein fehlender Punkt haelt die Ausrollung nicht auf: ohne eingerichtete
  # Sicherung oder ohne das GRANT auf pg_create_restore_point gaebe es sonst
  # gar keine Ausrollung mehr. Er steht dann als Warnung im Journal.
  if ! psql "$DATABASE_URL_OWNER" -X -q -At -v ON_ERROR_STOP=1 \
         -c "SELECT pg_create_restore_point('vor-$(basename "$ziel")')" >/dev/null; then
    echo "WARNUNG: kein Wiederherstellungspunkt vor $(basename "$ziel") gesetzt." >&2
  fi

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

# ---------------------------------------------------------- app-schluessel
#
# Der Schluessel, mit dem jedes Ausrollen das Paket fuer die App signiert
# (Plan app/plan.md §4, apps/mobile/scripts/paket.mjs). Er entsteht hier und
# verlaesst die Maschine nie; ausgegeben wird nur die oeffentliche Haelfte,
# die als apps/mobile/paket-schluessel.pem in die App kommt.
#
# **Einmal, nie ersetzen.** Jede App im Store kennt genau diesen
# Schluessel. Ein neuer hiesse: keine App nimmt mehr ein Paket an, bis alle
# eine neue Fassung aus dem Store haben. Deshalb legt der Befehl nichts an,
# wenn schon einer da ist, und zeigt nur dessen oeffentliche Haelfte.
#
# Die Units von API und Worker sperren die Datei aus (InaccessiblePaths):
# wer sie hat, legt Code in jede App, der dort auch bleibt, wenn der Server
# laengst wieder sauber ist.
APP_SCHLUESSEL="$WURZEL/shared/app-paket.key"
if [ "$MODUS" = "app-schluessel" ]; then
  if [ ! -e "$APP_SCHLUESSEL" ]; then
    APP_SCHLUESSEL="$APP_SCHLUESSEL" node -e '
      const { generateKeyPairSync } = require("node:crypto")
      const { writeFileSync } = require("node:fs")
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 })
      writeFileSync(process.env.APP_SCHLUESSEL,
        privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" })'
    echo "Schluessel angelegt: $APP_SCHLUESSEL" >&2
  else
    echo "Schluessel liegt schon unter $APP_SCHLUESSEL und bleibt." >&2
  fi
  echo "Oeffentliche Haelfte, fuer apps/mobile/paket-schluessel.pem:" >&2
  APP_SCHLUESSEL="$APP_SCHLUESSEL" node -e '
    const { createPublicKey } = require("node:crypto")
    const { readFileSync } = require("node:fs")
    process.stdout.write(createPublicKey(readFileSync(process.env.APP_SCHLUESSEL))
      .export({ type: "spki", format: "pem" }))'
  exit 0
fi

# ----------------------------------------------------------------- zurueck
if [ "$MODUS" = "rollback" ]; then
  SHA="${2:?rollback braucht den Stand: deploy.sh rollback <sha>}"
  # Dieselbe Form, die die API prueft -- und hier noch einmal, weil der Wert
  # aus deploy_request kommt, in das die Anwendungsrolle schreiben darf
  # (0033). Ein `../` darin fuehrte aus releases/ hinaus, und wer Code in der
  # API ausfuehrt, kaeme ueber diesen Agenten aus ihrer Sandbox heraus
  # (N9, Audit 11.10.2026). Das Skript vertraut der API nicht, es prueft.
  if ! [[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "Kein Commit-Hash: '$SHA'. Erwartet werden 7 bis 40 Hexziffern." >&2
    exit 1
  fi
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

# Auch der Marker kommt ueber deploy_request (N9). Die API schreibt dort
# nur `produktion`, aber die Spalte nimmt jeden Text an: ein Wert mit
# Bindestrich vorn waere fuer git eine Option, kein Name. Erlaubt ist, was
# als Zweig, Tag oder Hash vorkommt -- und keine `..`, die git als Bereich
# laese.
if ! [[ "$MARKER" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || [[ "$MARKER" == *..* ]]; then
  echo "Ungueltiger Marker: '$MARKER'." >&2
  exit 1
fi

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

# Dieselbe Oberflaeche als signiertes Paket fuer die App (Plan app/plan.md
# §4). Caddy bedient es unter /app-paket/ aus current/web; die App holt dort
# paket.json, laedt das Zip und prueft die Signatur selbst. Liegt es im
# Stand und nicht daneben, rollt es mit ihm zurueck: die App folgt dem
# Server, nicht dem neuesten Bau.
#
# **Scheitert das Paket, rollt der Stand trotzdem aus.** Ohne Paket bleiben
# die Apps beim letzten -- der Browser soll deswegen nicht auf eine
# Behebung warten. Die Warnung steht im Protokoll der Ausrollung.
if [ -r "$APP_SCHLUESSEL" ]; then
  if ! ( STAYGRID_STAND="$SHA" pnpm --filter @hotelpms/mobile www \
         && HOTELPMS_APP_PAKET_SCHLUESSEL="$APP_SCHLUESSEL" \
              node apps/mobile/scripts/paket.mjs "$ZIEL/web/app-paket" ); then
    echo "WARNUNG: kein App-Paket fuer $SHA, die Apps bleiben beim vorigen Stand." >&2
    rm -rf "$ZIEL/web/app-paket"
  fi
else
  echo "Hinweis: kein $APP_SCHLUESSEL, also kein App-Paket (deploy.sh app-schluessel)." >&2
fi

# Woher dieser Stand kommt -- Zeitpunkt und Betreff des Commits.
#
# Hier und nicht im Agenten, weil es nur hier geht: `releases/<sha>` ist ein
# `git archive` ohne Geschichte, und der Klon unter shared/repo steht dem
# Agenten beim Tick nicht zur Verfuegung. Im Moment des Baus liegt beides
# vor. Ohne diese Datei zeigt das Panel einen Hash und eine Bauzeit, und
# welcher Stand das ist, weiss dann niemand (Migration 0057).
#
# Zwei Zeilen, Zeit zuerst: der Betreff darf alles enthalten, die Zeit
# nicht. Waere es umgekehrt, zerliese ein Doppelpunkt im Betreff das Format.
{
  git -C "$REPO" show -s --format=%cI "$SHA"
  git -C "$REPO" show -s --format=%s "$SHA"
} > "$ZIEL/.stand"

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
