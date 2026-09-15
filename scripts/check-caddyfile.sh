#!/bin/bash
# Prueft den Caddyfile auf Bloecke, die einzeilig geschrieben sind.
#
# Der Grund: der Caddyfile-Lexer verlangt, dass ein mit { geoeffneter Block
# die schliessende Klammer auf einer eigenen Zeile hat. Steht nach dem { noch
# etwas auf derselben Zeile, weist Caddy die ganze Datei ab:
#
#   Error: adapting config using caddyfile:
#   Unexpected next token after '{' on same line
#
# Das ist hier einmal passiert und war ein Blocker: der Block wurde aus
# Dokument 17 §4 abgeschrieben, wo er einzeilig stand, und der Reverse Proxy
# startete nicht mehr. Besonders tueckisch, weil `caddy fmt --overwrite` die
# Zeile stillschweigend umbricht -- wer erst formatiert und dann prueft, sieht
# den Fehler nie.
#
# Warum kein `caddy validate`: das braucht das Caddy-Binaerprogramm samt dem
# Modul caddy-ratelimit im CI-Bild. Diese Pruefung kostet nichts und faengt
# genau die Klasse ab, die zugeschlagen hat.
#
# Platzhalter wie {remote_host} loesen nicht aus: dort steht kein Leerzeichen
# hinter der Klammer, das { ist also kein eigenstaendiges Wort.
set -euo pipefail

datei="${1:-ops/caddy/Caddyfile}"

if [ ! -f "$datei" ]; then
  echo "Caddyfile nicht gefunden: $datei" >&2
  exit 1
fi

fehler=0
zeilennr=0
while IFS= read -r zeile; do
  zeilennr=$((zeilennr + 1))
  # Kommentare und alles dahinter weg, dann die Woerter zaehlen.
  ohne_kommentar="${zeile%%#*}"
  # shellcheck disable=SC2086
  set -- $ohne_kommentar
  # Ein eigenstaendiges { darf nur das letzte Wort der Zeile sein.
  position=0
  for wort in "$@"; do
    position=$((position + 1))
    if [ "$wort" = "{" ] && [ "$position" -ne "$#" ]; then
      echo "$datei:$zeilennr: Block einzeilig geoeffnet -- Caddy weist die Datei ab:" >&2
      echo "    $zeile" >&2
      fehler=1
    fi
  done
done < "$datei"

if [ "$fehler" -ne 0 ]; then
  echo >&2
  echo "Die schliessende Klammer gehoert auf eine eigene Zeile:" >&2
  echo "    match {" >&2
  echo "        path /v1/auth/*" >&2
  echo "    }" >&2
  exit 1
fi

echo "Caddyfile in Ordnung: $datei, keine einzeilig geoeffneten Bloecke."
