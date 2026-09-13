#!/bin/bash
# PostgreSQL fuer die Tests bereitstellen.
#
# Die Tests laufen gegen eine echte Datenbank, nie gegen Mocks: eine gemockte
# Datenbank prueft weder Zeilenrichtlinien noch Trigger noch Sperren, und
# genau dort liegt die Fachlichkeit dieses Systems.
#
# Idempotent. Mehrfaches Ausfuehren ist unschaedlich.
set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"

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
als_postgres -c "\"DO \\\$\\\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hotelpms_owner') THEN
    CREATE ROLE hotelpms_owner LOGIN PASSWORD 'devowner' BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hotelpms_app') THEN
    CREATE ROLE hotelpms_app LOGIN PASSWORD 'devapp';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hotelpms_readonly') THEN
    CREATE ROLE hotelpms_readonly LOGIN PASSWORD 'devro';
  END IF;
END \\\$\\\$;\""

for db in hotelpms_test hotelpms_dev; do
  vorhanden=$(su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"")
  if [ "$vorhanden" != "1" ]; then
    su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE $db OWNER hotelpms_owner\""
  fi
  # pg_trgm fuer die Namenssuche, pgcrypto fuer Zufallswerte.
  su postgres -c "psql -v ON_ERROR_STOP=1 -d $db -c \
    'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;'"
done

echo "PostgreSQL bereit: hotelpms_test und hotelpms_dev, drei Rollen angelegt."
