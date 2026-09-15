#!/usr/bin/env bash
# Ausrollen auf der Produktivmaschine. Als Benutzer hotelpms ausfuehren.
#
# **Warum hier und nicht nur in der Anleitung.** Dieses Skript stand bis zur
# Erstinbetriebnahme ausschliesslich in docs/21 §8 -- und lief damit
# zwangslaeufig auseinander: die Anleitung nannte /srv/hotelpms, die Units in
# ops/systemd/ /opt/hotelpms, und niemandem fiel es auf, weil beide Seiten
# fuer sich stimmig aussahen. Was auf der Maschine laeuft, gehoert ins
# Repository; die Anleitung verweist darauf, statt es zu wiederholen.
#
# Immer dieselbe Reihenfolge, und die Reihenfolge ist der Punkt.
set -euo pipefail

WURZEL="${HOTELPMS_ROOT:-/opt/hotelpms}"
STAND="$WURZEL/current"
UMGEBUNG="$WURZEL/shared/env"

# Was ausgerollt wird: der Marker, nicht main.
#
# **Der Unterschied ist der Punkt.** main traegt, was zuletzt gemergt wurde --
# auch einen Stand, den niemand fuer die Produktion vorgesehen hat. Bei
# mehreren Bearbeitern ist das der Normalfall, nicht die Ausnahme. Der Tag
# `produktion` wird bewusst verschoben; nur er kommt auf die Maschine.
#
#   git tag -f produktion <commit> && git push -f origin produktion
MARKER="${1:-${HOTELPMS_DEPLOY_REF:-produktion}}"

cd "$STAND"

# git reset --hard und nicht git pull. Die Maschine ist kein Arbeitsplatz:
# sie soll genau den Stand tragen, der am Marker haengt. Ein pull kann in
# einen Konflikt laufen und stehen bleiben -- und dann laeuft ein halber
# Stand.
#
# --force bei den Tags, weil `produktion` wandert: ohne das behielte die
# Maschine den ersten Stand, den sie je gesehen hat, und niemand saehe warum.
git fetch --prune --force --tags origin
git checkout --detach "$MARKER"
git reset --hard "$MARKER"

echo "Ausgerollt wird $MARKER = $(git rev-parse HEAD)" 

set -a; . "$UMGEBUNG"; set +a

pnpm install --frozen-lockfile
pnpm build

# Die gebaute Oberflaeche dorthin, wo Caddy sie sucht. Ohne diesen Schritt
# zeigt Caddy nach einem frischen Bau ein leeres Verzeichnis: pnpm build legt
# sie in apps/web/dist, der Caddyfile bedient $STAND/web. Fiel bei der
# Erstinbetriebnahme auf, weil beide Seiten fuer sich richtig waren.
rm -rf "$STAND/web"
cp -a "$STAND/apps/web/dist" "$STAND/web"

# Migrationen mit der Eigentuemerrolle, nie mit der Anwendungsrolle. Das
# Skript liest DATABASE_URL_OWNER aus der Umgebung, die oben schon steht.
#
# Vor dem Neustart: das Schema ist dabei kurz neuer als der laufende Code,
# und das ist die richtige Richtung. Eine hinzugefuegte Spalte stoert den
# alten Code nicht, ein fehlendes Schema den neuen schon.
pnpm --filter @hotelpms/db migrate

# Braucht die Regel in /etc/sudoers.d/hotelpms -- genau diese beiden
# Neustarts, nichts weiter.
sudo systemctl restart hotelpms-api hotelpms-worker

# Nicht "gestartet", sondern "antwortet". Ein Dienst, der sofort wieder
# stirbt, laeuft fuer systemd trotzdem kurz.
sleep 2
curl -fsS --unix-socket /run/hotelpms/api.sock http://localhost/health
echo
