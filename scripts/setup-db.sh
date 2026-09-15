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
# Dafuer kommen Kennwoerter und Datenbanknamen aus der Umgebung; die
# Vorgabewerte sind die der Entwicklung. Frueher standen die Kennwoerter fest
# im Skript, und die Anleitung behauptete trotzdem, sie wuerden "dabei
# ersetzt" -- wer ihr folgte, hatte devapp und devowner auf einer Maschine
# am Netz.
#
#   HOTELPMS_DB_OWNER_PASSWORD   Kennwort der Eigentuemerrolle
#   HOTELPMS_DB_APP_PASSWORD     Kennwort der Anwendungsrolle
#   HOTELPMS_DB_RO_PASSWORD      Kennwort der Leserolle
#   HOTELPMS_DATABASES           Datenbanken, durch Leerzeichen getrennt
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

OWNER_PW="${HOTELPMS_DB_OWNER_PASSWORD:-devowner}"
APP_PW="${HOTELPMS_DB_APP_PASSWORD:-devapp}"
RO_PW="${HOTELPMS_DB_RO_PASSWORD:-devro}"
DATENBANKEN="${HOTELPMS_DATABASES:-hotelpms_test hotelpms_dev}"

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

# Alles Weitere als Systembenutzer postgres, damit keine Rolle "root" gebraucht wird.
als_postgres() { su postgres -c "psql -v ON_ERROR_STOP=1 $*"; }

# Drei Rollen mit klarer Aufgabenteilung (Dokument 10):
#   owner     besitzt das Schema, macht Migrationen und Bereitstellung.
#             BYPASSRLS, weil beim Anlegen eines Accounts noch kein
#             Mandantenkontext existieren kann.
#   app       alle Anfragen. Kein Eigentum, kein BYPASSRLS.
#   readonly  Berichte und Replikat.
rolle() {   # name kennwort [zusatz]
  su postgres -c "psql -v ON_ERROR_STOP=1 -c \"DO \\\$\\\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$1') THEN
      CREATE ROLE $1 LOGIN PASSWORD '$2' ${3:-};
    END IF;
  END \\\$\\\$;\""
  # Das Kennwort wird bei jedem Lauf gesetzt, nicht nur beim Anlegen. Sonst
  # behielte eine Maschine, die einmal mit den Entwicklungsvorgaben
  # aufgesetzt wurde, diese fuer immer -- und niemand saehe es.
  su postgres -c "psql -v ON_ERROR_STOP=1 -c \"ALTER ROLE $1 PASSWORD '$2'\"" >/dev/null
}

rolle hotelpms_owner    "$OWNER_PW" BYPASSRLS
rolle hotelpms_app      "$APP_PW"
rolle hotelpms_readonly "$RO_PW"

for db in $DATENBANKEN; do
  vorhanden=$(su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"")
  if [ "$vorhanden" != "1" ]; then
    su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE $db OWNER hotelpms_owner\""
  fi
  # pg_trgm fuer die Namenssuche, pgcrypto fuer Zufallswerte.
  su postgres -c "psql -v ON_ERROR_STOP=1 -d $db -c \
    'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;'"
done

echo "PostgreSQL $PG_VERSION bereit: $DATENBANKEN, drei Rollen angelegt."
