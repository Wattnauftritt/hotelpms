#!/bin/bash
# PostgreSQL fuer die Tests bereitstellen.
#
# Die Tests laufen gegen eine echte Datenbank, nie gegen Mocks: eine gemockte
# Datenbank prueft weder Zeilenrichtlinien noch Trigger noch Sperren, und
# genau dort liegt die Fachlichkeit dieses Systems.
#
# Idempotent. Mehrfaches Ausfuehren ist unschaedlich.
#
# **Auch auf einer Produktivmaschine benutzbar** (Dokument 21 §6 sagt das zu).
# Dafuer kommen Kennwoerter und Datenbanknamen aus der Umgebung:
#
#   HOTELPMS_DB_OWNER_PASSWORD   Kennwort der Eigentuemerrolle
#   HOTELPMS_DB_APP_PASSWORD     Kennwort der Anwendungsrolle
#   HOTELPMS_DB_RO_PASSWORD      Kennwort der Leserolle
#   HOTELPMS_DATABASES           Datenbanken, durch Leerzeichen getrennt
#
# **Ohne diese Kennwoerter laeuft es nicht mehr durch** (Befund S1).
# Vorher traten dann die Entwicklungsvorgaben devowner/devapp/devro in
# Kraft -- auf jeder Maschine, auch auf der am Netz, und ohne dass jemand
# etwas merkte. Ein vergessenes Produktionsgeheimnis endete damit nicht in
# einem Fehler, sondern in einem Erfolg mit oeffentlich bekannten
# Zugangsdaten. Das ist die schlimmste Bauform eines Fehlers: sie sieht aus
# wie das Gelingen.
#
# Wer die Vorgaben will -- Entwicklung, CI, eine Sitzung im Web --, sagt es
# ausdruecklich:
#
#   HOTELPMS_ALLOW_DEV_PASSWORDS=1 ./scripts/setup-db.sh
#
# Dieselben drei Woerter werden ohne diesen Schalter auch dann abgewiesen,
# wenn sie von Hand gesetzt sind: wer `devapp` in die Produktionsumgebung
# schreibt, hat sich vertan und nicht entschieden.
set -euo pipefail

# Ohne Angabe der neueste eingerichtete Cluster statt einer festen Zahl: die
# Entwicklung laeuft auf 16, die Maschine auf 17, und eine Vorgabe trifft
# immer nur eines von beiden.
erkenne_version() {
  if command -v pg_lsclusters >/dev/null 2>&1; then
    pg_lsclusters --no-header 2>/dev/null | awk '{print $1}' | sort -rV | head -1
  fi
}
PG_VERSION="${PG_VERSION:-$(erkenne_version)}"
PG_VERSION="${PG_VERSION:-17}"

DEV_VORGABEN="${HOTELPMS_ALLOW_DEV_PASSWORDS:-0}"

if [ "$DEV_VORGABEN" = "1" ]; then
  OWNER_PW="${HOTELPMS_DB_OWNER_PASSWORD:-devowner}"
  APP_PW="${HOTELPMS_DB_APP_PASSWORD:-devapp}"
  RO_PW="${HOTELPMS_DB_RO_PASSWORD:-devro}"
else
  fehlend=()
  for name in HOTELPMS_DB_OWNER_PASSWORD HOTELPMS_DB_APP_PASSWORD \
              HOTELPMS_DB_RO_PASSWORD; do
    [ -n "${!name:-}" ] || fehlend+=("$name")
  done
  if [ "${#fehlend[@]}" -gt 0 ]; then
    {
      echo "Abgebrochen: ${fehlend[*]} fehlt."
      echo
      echo "Auf einer Maschine am Netz muessen die Kennwoerter gesetzt sein."
      echo "Fuer Entwicklung und CI mit den bekannten Vorgaben:"
      echo "  HOTELPMS_ALLOW_DEV_PASSWORDS=1 $0"
    } >&2
    exit 1
  fi
  OWNER_PW="$HOTELPMS_DB_OWNER_PASSWORD"
  APP_PW="$HOTELPMS_DB_APP_PASSWORD"
  RO_PW="$HOTELPMS_DB_RO_PASSWORD"
  for pw in "$OWNER_PW" "$APP_PW" "$RO_PW"; do
    case "$pw" in
      devowner|devapp|devro)
        echo "Abgebrochen: ein Entwicklungskennwort ist gesetzt." >&2
        echo "Mit HOTELPMS_ALLOW_DEV_PASSWORDS=1 ist das erlaubt." >&2
        exit 1 ;;
    esac
  done
fi

DATENBANKEN="${HOTELPMS_DATABASES:-hotelpms_test hotelpms_dev}"

# Der Name geht als Bezeichner in CREATE DATABASE und als -d an psql. Beides
# sind Stellen, an denen aus einem Namen ein Befehl wird, und eine Liste aus
# der Umgebung ist genau die Art Eingabe, bei der das irgendwann passiert
# (Befund S2). Geprueft statt maskiert: ein Datenbankname mit Anfuehrungs-
# zeichen ist kein Fall, den dieses System je gebraucht hat.
for db in $DATENBANKEN; do
  if ! [[ "$db" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
    echo "Abgebrochen: '$db' ist kein zulaessiger Datenbankname." >&2
    echo "Erlaubt sind Kleinbuchstaben, Ziffern und Unterstrich." >&2
    exit 1
  fi
done

starte_postgres() {
  if pg_isready -q 2>/dev/null; then return 0; fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster "$PG_VERSION" main start 2>/dev/null || true
  fi
  if ! pg_isready -q 2>/dev/null && command -v service >/dev/null 2>&1; then
    service postgresql start >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 30); do
    pg_isready -q 2>/dev/null && return 0
    sleep 1
  done
  echo "PostgreSQL startet nicht." >&2
  return 1
}

starte_postgres

# ---------------------------------------------------------------------------
# SQL geht ueber die Standardeingabe, nie ueber die Befehlszeile.
#
# Vorher stand jedes Kommando als Zeichenkette in `su postgres -c "psql -c
# \"...\""`, mit dem Kennwort mittendrin. Das hat zwei Loecher, und beide
# sind an einer Produktivmaschine echt:
#
#   1. Ein Kennwort mit Anfuehrungszeichen, Dollarzeichen oder Backtick
#      aendert das erzeugte SQL oder die aeussere Befehlszeile -- und die
#      laeuft als root. Ein zufaellig erzeugtes Geheimnis enthaelt solche
#      Zeichen frueher oder spaeter (Befund S2).
#   2. Das Kennwort steht waehrend des Laufs in der Prozessliste. Jeder
#      Benutzer der Maschine kann es mit `ps` mitlesen; das steht in keinem
#      Protokoll und faellt nie auf.
#
# Beides faellt weg, wenn das SQL ueber eine Pipe kommt: in der Befehlszeile
# steht dann nur noch `psql -f -`.
# ---------------------------------------------------------------------------
psql_stdin() {   # [weitere psql-Argumente]
  su postgres -c "psql -v ON_ERROR_STOP=1 -X -q $* -f -"
}

# Ein Kennwort als SQL-Zeichenkette. Verdoppeltes Anfuehrungszeichen ist die
# Maskierung, die PostgreSQL versteht; Backslashes sind bei
# standard_conforming_strings (Vorgabe seit 9.1) keine.
sql_literal() { printf "'%s'" "${1//\'/\'\'}"; }

# Drei Rollen mit klarer Aufgabenteilung (Dokument 10):
#   owner     besitzt das Schema, macht Migrationen und Bereitstellung.
#             BYPASSRLS, weil beim Anlegen eines Accounts noch kein
#             Mandantenkontext existieren kann.
#   app       alle Anfragen. Kein Eigentum, kein BYPASSRLS.
#   readonly  Berichte und Replikat.
#
# Der Rollenname ist hier eine Konstante aus diesem Skript und kommt nicht
# von aussen -- deshalb steht er unmaskiert im SQL, das Kennwort nicht.
rolle() {   # name kennwort [zusatz]
  local name="$1" zusatz="${3:-}"
  local pw; pw="$(sql_literal "$2")"
  # Das Kennwort wird bei jedem Lauf gesetzt, nicht nur beim Anlegen. Sonst
  # behielte eine Maschine, die einmal mit den Entwicklungsvorgaben
  # aufgesetzt wurde, diese fuer immer -- und niemand saehe es.
  psql_stdin <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$name') THEN
    CREATE ROLE $name LOGIN $zusatz;
  END IF;
END \$\$;
ALTER ROLE $name PASSWORD $pw;
SQL
}

rolle hotelpms_owner    "$OWNER_PW" BYPASSRLS
rolle hotelpms_app      "$APP_PW"
rolle hotelpms_readonly "$RO_PW"

for db in $DATENBANKEN; do
  vorhanden=$(printf "SELECT 1 FROM pg_database WHERE datname = '%s';\n" "$db" \
    | su postgres -c "psql -tA -X -f -")
  if [ "$vorhanden" != "1" ]; then
    printf 'CREATE DATABASE %s OWNER hotelpms_owner;\n' "$db" | psql_stdin
  fi
  # pg_trgm fuer die Namenssuche, pgcrypto fuer Zufallswerte.
  psql_stdin "-d $db" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
done

echo "PostgreSQL $PG_VERSION bereit: $DATENBANKEN, drei Rollen angelegt."
