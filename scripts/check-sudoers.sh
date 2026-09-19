#!/bin/bash
# Prueft, dass jeder sudo-Aufruf im Ausrollskript von einer Regel in
# ops/deploy/hotelpms.sudoers abgedeckt ist -- Wort fuer Wort.
#
# Der Grund: sudoers vergleicht die ganze Kommandozeile mit der Regel. Die
# Regel erlaubte `systemctl restart hotelpms-api` und `systemctl restart
# hotelpms-worker`; das Skript rief `systemctl restart hotelpms-api
# hotelpms-worker` auf -- ein drittes Kommando, das keine Regel kannte. sudo
# fragte nach einem Kennwort, das es in einem Dienst nicht gibt, und die
# erste Ausrollung ueber den Agenten endete nach umgelegtem Symlink und
# angewandten Migrationen mit "a password is required". Von Hand als root
# war es nie aufgefallen: root wird nicht gefragt.
#
# Beide Dateien liegen im Repository, also laesst sich der Abgleich hier
# machen statt auf der Maschine. Ein Test kann kein sudo ausfuehren; diese
# Pruefung kostet nichts und faengt genau die Klasse ab, die zugeschlagen
# hat. Wer ein neues sudo-Kommando ins Skript schreibt, schreibt die Regel
# dazu -- und umgekehrt.
set -euo pipefail

skript="${1:-ops/deploy/deploy.sh}"
regeln="${2:-ops/deploy/hotelpms.sudoers}"

# Erlaubte Kommandos: alles hinter "NOPASSWD:", mit vollem Pfad.
mapfile -t erlaubt < <(grep -E '^[a-z]+ ' "$regeln" | sed -E 's/.*NOPASSWD:[[:space:]]*//')

fehler=0
while IFS= read -r zeile; do
  # Der Aufruf im Skript nennt das Programm ohne Pfad; die Regel mit Pfad.
  aufruf="$(sed -E 's/^[[:space:]]*sudo[[:space:]]+//' <<< "$zeile")"
  programm="${aufruf%% *}"
  rest="${aufruf#"$programm"}"
  passt=0
  for regel in "${erlaubt[@]}"; do
    [ "$regel" = "/usr/bin/$programm$rest" ] && passt=1 && break
  done
  if [ "$passt" -eq 0 ]; then
    echo "$skript: 'sudo $aufruf' ist von keiner Regel in $regeln gedeckt." >&2
    echo "  Erlaubt sind nur:" >&2
    printf '    %s\n' "${erlaubt[@]}" >&2
    fehler=1
  fi
done < <(grep -E '^[[:space:]]*sudo[[:space:]]' "$skript")

if [ "$fehler" -ne 0 ]; then
  echo "sudo-Aufruf und sudoers-Regel muessen Wort fuer Wort uebereinstimmen." >&2
  exit 1
fi
echo "sudoers in Ordnung: jeder sudo-Aufruf in $skript ist gedeckt."
