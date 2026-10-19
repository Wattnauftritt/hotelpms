#!/usr/bin/env bash
# Laeuft auf dem ZWEITEN ZIEL (netcup-VPS), nicht auf der Produktivmaschine.
# Installiert als /usr/local/sbin/hotelpms-einsortieren, alle 15 Minuten
# ueber hotelpms-einsortieren.timer, als root.
#
# Holt fertige Saetze aus dem Eingang, prueft ihre Pruefsummen und legt sie
# dort ab, wohin die Produktivmaschine nicht schreiben kann. Der Eingang ist
# das einzige Verzeichnis, das ihr Schluessel erreicht (`rrsync -wo -no-del`
# in authorized_keys). Ein Angreifer auf der Produktivmaschine kann also
# neue Saetze schicken, aber keinen alten ueberschreiben oder loeschen.
#
# Aufbewahrung (Dokument 17 §3): 30 Tagessaetze, 12 Monatssaetze. Der
# Monatssatz ist der erste Satz eines Monats, als harte Verknuepfung: er
# kostet keinen Platz, solange der Tagessatz noch da ist.
#
# **Der Name kommt vom Angreifer** (Audit 19.10.2026, M8). Die Aufbewahrung
# sortiert nach dem Namen; wer root auf der Produktion hat, konnte 30 Saetze
# `9999-01-01` ff. mit gueltigen Pruefsummen schicken, und der naechste Lauf
# hielt sie fuer die neuesten und loeschte jeden echten. Deshalb:
#   - der Name muss ein echtes Datum sein, hoechstens morgen (Zeitzone der
#     Produktion gegen die dieses Rechners);
#   - ein vorhandener Satz wird nie ersetzt, ein zweiter gleichen Namens
#     geht nach defekt/;
#   - kommen in einem Lauf mehr als NEU_HOECHSTENS Saetze an, wird nicht
#     aufgeraeumt, sondern gemeldet und mit Fehler beendet. Die Produktion
#     schickt einen am Tag; ein Schwall ist ein Angriff oder ein Fehler, und
#     beides soll ein Mensch ansehen, bevor etwas geloescht wird. Die Sperre
#     bleibt ueber den Lauf hinaus stehen (Datei AUFRAEUMEN_GESPERRT), sonst
#     raeumte der naechste Lauf eine Viertelstunde spaeter doch auf. Nach
#     dem Ansehen von Hand loeschen.
set -euo pipefail
umask 077

WURZEL="${WURZEL:-/srv/sicherung}"
EINGANG="$WURZEL/eingang"
TAEGLICH="$WURZEL/taeglich"
MONATLICH="$WURZEL/monatlich"
DEFEKT="$WURZEL/defekt"
SPERRE="$WURZEL/AUFRAEUMEN_GESPERRT"
TAGE="${TAGE:-30}"
MONATE="${MONATE:-12}"
NEU_HOECHSTENS="${NEU_HOECHSTENS:-3}"
# Totmannschalter. Er bekommt nur bei einem neuen, geprueften Satz ein
# Lebenszeichen; bleibt es ueber einen Tag aus, schickt er eine Mail. So
# faellt auch auf, wenn die Produktivmaschine gar nicht mehr sendet.
MELDEN="${MELDEN:-}"
KONFIG="${HOTELPMS_EINSORTIEREN_KONFIG:-/etc/hotelpms/einsortieren.env}"
# shellcheck disable=SC1090
[ -f "$KONFIG" ] && . "$KONFIG"

melden() {
  [ -n "$MELDEN" ] || return 0
  curl -fsS -m 10 --retry 3 "$MELDEN$1" >/dev/null || true
}

mkdir -p "$EINGANG" "$TAEGLICH" "$MONATLICH" "$DEFEKT"

# Beiseitelegen statt loeschen: was hier landet, will ein Mensch ansehen.
# Die Nanosekunden machen den Namen eindeutig, auch bei zweien je Sekunde.
beiseite() {
  echo "Satz $2: $3, beiseitegelegt." >&2
  mv -T "$1" "$DEFEKT/$2.$(date +%s%N)"
  melden /fail
}

morgen="$(date -d tomorrow +%F)"
neu=0
for satz in "$EINGANG"/????-??-??; do
  [ -f "$satz/FERTIG" ] || continue
  name="$(basename "$satz")"
  # Ein echtes Kalenderdatum: `date -d` nimmt auch 2026-02-30 nicht an,
  # und der Rueckweg muss genau den Namen ergeben (keine Leerzeichen,
  # keine anderen Schreibweisen).
  if ! [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
     || [ "$(date -d "$name" +%F 2>/dev/null)" != "$name" ]; then
    beiseite "$satz" "$name" "kein gueltiges Datum"
    continue
  fi
  if [[ "$name" > "$morgen" ]]; then
    beiseite "$satz" "$name" "Datum liegt in der Zukunft"
    continue
  fi
  # Eine Verknuepfung koennte auf einen echten Satz zeigen und dessen
  # Pruefsummen borgen; was die Produktion schickt, sind gewoehnliche Dateien.
  if [ -L "$satz" ] || [ ! -d "$satz" ] || [ -n "$(find "$satz" -type l -print -quit)" ]; then
    beiseite "$satz" "$name" "enthaelt eine Verknuepfung"
    continue
  fi
  if ! (cd "$satz" && sha256sum --quiet -c SHA256SUMS); then
    beiseite "$satz" "$name" "Pruefsumme stimmt nicht"
    continue
  fi
  # Nie ersetzen: sonst ueberschreibt die Produktion einen echten Satz mit
  # einem leeren, der dieselben gueltigen Pruefsummen traegt. Ein Nachholen
  # desselben Tages landet ebenso in defekt/ und wird dort von Hand
  # angesehen.
  if [ -e "$TAEGLICH/$name" ]; then
    beiseite "$satz" "$name" "Satz dieses Tages ist schon da"
    continue
  fi
  mv -T "$satz" "$TAEGLICH/$name"
  monat="${name:0:7}"
  if [ ! -e "$MONATLICH/$monat" ]; then
    cp -al "$TAEGLICH/$name" "$MONATLICH/$monat"
  fi
  echo "Satz $name eingeordnet."
  neu=$((neu + 1))
done

if [ "$neu" -gt "$NEU_HOECHSTENS" ]; then
  echo "$(date -u +%FT%TZ) $neu neue Saetze in einem Lauf" >> "$SPERRE"
fi
if [ -e "$SPERRE" ]; then
  echo "ALARM: Aufraeumen gesperrt ($(tail -n 1 "$SPERRE"), erwartet hoechstens" \
       "$NEU_HOECHSTENS). Bitte $TAEGLICH ansehen und danach $SPERRE loeschen." >&2
  melden /fail
  exit 1
fi

# Die Namen sind geprueft Datumsangaben bis morgen; lexikalisch ist damit
# chronologisch, und ein gefaelschter Name kann nicht mehr hinter allen
# echten stehen. Die Globs sortieren selbst.
aufraeumen() {
  local behalten="$1"; shift
  local anzahl=$#
  while [ "$anzahl" -gt "$behalten" ]; do
    rm -rf -- "$1"
    shift
    anzahl=$((anzahl - 1))
  done
}
shopt -s nullglob
aufraeumen "$TAGE" "$TAEGLICH"/????-??-??
aufraeumen "$MONATE" "$MONATLICH"/????-??

[ "$neu" -gt 0 ] && melden ""
exit 0
