#!/bin/bash
# Prueft die Dokumente unter docs/ auf doppelte Nummern.
#
# Der Grund: dieselbe Falle wie bei den Migrationen, nur ohne Netz. Am
# 19.09.2026 sind an einem Tag drei Berichte aus drei Sitzungen entstanden,
# und alle drei hiessen docs/24-*.md -- Sicherheitspruefung, Performanceaudit
# und DSGVO-Audit. Beim Mergen faellt das nicht auf, denn es sind
# verschiedene Dateien ohne Konflikt; auffallen tut es, wenn jemand "Dokument
# 24" sagt und drei Leute drei verschiedene Texte aufschlagen.
#
# Laeuft in CI. Wer die Meldung sieht, benennt sein Dokument um und zieht die
# Verweise nach (README, Dokument 16, Kopfkommentare). Die Reihenfolge
# zwischen unabhaengigen Dokumenten ist beliebig; entscheidend ist, dass
# jede Nummer einmal vorkommt.
set -euo pipefail

cd "$(dirname "$0")/.."
verzeichnis="docs"

doppelte=$(ls "$verzeichnis" | grep -E '^[0-9]{2}-' | cut -c1-2 | sort | uniq -d)
if [ -n "$doppelte" ]; then
  echo "Doppelte Dokumentnummern gefunden:" >&2
  for n in $doppelte; do
    echo "  $n:" >&2
    ls "$verzeichnis" | grep "^$n-" | sed 's/^/    /' >&2
  done
  echo >&2
  echo "Das spaetere umbenennen und die Verweise nachziehen (README, Dokument 16," >&2
  echo "Kopfkommentare). Jede Nummer kommt genau einmal vor." >&2
  exit 1
fi

anzahl=$(ls "$verzeichnis" | grep -cE '^[0-9]{2}-')
letzte=$(ls "$verzeichnis" | grep -E '^[0-9]{2}-' | cut -c1-2 | sort | tail -1)
echo "Dokumente in Ordnung: $anzahl nummerierte Dateien, hoechste Nummer $letzte."
