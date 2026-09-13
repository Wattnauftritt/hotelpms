#!/bin/bash
# Prueft die Migrationen auf doppelte Nummern.
#
# Der Grund: Migrationen sind fortlaufend nummeriert, und zwei Bearbeiter,
# die gleichzeitig von main abzweigen, legen beide 0020_ an. Beim Mergen
# faellt das nicht auf, denn es sind verschiedene Dateien ohne Konflikt.
# Auffallen wuerde es erst beim naechsten frischen Schemaaufbau, und dort
# als Fehler, dessen Ursache Tage zurueckliegt.
#
# Laeuft in CI. Wer die Meldung sieht, benennt seine Migration um; die
# Reihenfolge zwischen zwei unabhaengigen Migrationen ist ohnehin beliebig.
set -euo pipefail

cd "$(dirname "$0")/.."
verzeichnis="packages/db/migrations"

doppelte=$(ls "$verzeichnis" | grep -oE '^[0-9]{4}' | sort | uniq -d)
if [ -n "$doppelte" ]; then
  echo "Doppelte Migrationsnummern gefunden:" >&2
  for n in $doppelte; do
    echo "  $n:" >&2
    ls "$verzeichnis" | grep "^$n" | sed 's/^/    /' >&2
  done
  echo >&2
  echo "Die spaetere umbenennen. Zwischen unabhaengigen Migrationen ist die" >&2
  echo "Reihenfolge beliebig; entscheidend ist, dass jede Nummer einmal vorkommt." >&2
  exit 1
fi

# Luecken sind erlaubt, aber ein Hinweis wert: sie entstehen, wenn jemand
# eine Migration verwirft, ohne die naechste nachzuziehen.
erste=$(ls "$verzeichnis" | grep -oE '^[0-9]{4}' | sort | head -1)
letzte=$(ls "$verzeichnis" | grep -oE '^[0-9]{4}' | sort | tail -1)
anzahl=$(ls "$verzeichnis" | grep -cE '^[0-9]{4}')
erwartet=$((10#$letzte - 10#$erste + 1))
if [ "$anzahl" -ne "$erwartet" ]; then
  echo "Hinweis: $anzahl Migrationen zwischen $erste und $letzte, erwartet $erwartet."
fi

echo "Migrationen in Ordnung: $anzahl Dateien, hoechste Nummer $letzte."
