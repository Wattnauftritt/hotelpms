#!/bin/bash
# Bereitet eine frische Sitzung so vor, dass `pnpm test` sofort laeuft.
#
# Ohne diesen Schritt scheitern die Tests mit ECONNREFUSED auf Port 5432,
# und der naechstliegende Schluss waere, sie seien kaputt. Sie sind es nicht:
# sie brauchen eine echte Datenbank.
set -euo pipefail

# Nur in der entfernten Umgebung. Lokal richtet sich jeder selbst ein.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

echo "Abhaengigkeiten installieren..."
pnpm install --frozen-lockfile 2>&1 | tail -5

echo "PostgreSQL bereitstellen..."
./scripts/setup-db.sh

# Die Tests lesen ihre Verbindungen aus .env. In CI stehen sie in der
# Umgebung, hier gibt es die Datei noch nicht.
if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env aus .env.example angelegt."
fi

echo "Schema aufbauen..."
set -a; . ./.env; set +a
export DATABASE_URL_OWNER="${TEST_DATABASE_URL_OWNER}"
pnpm --filter @hotelpms/db reset 2>&1 | tail -3

echo "Bereit. pnpm typecheck && pnpm lint && pnpm test && pnpm build"
