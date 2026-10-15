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
set -euo pipefail
umask 077

WURZEL="${WURZEL:-/srv/sicherung}"
EINGANG="$WURZEL/eingang"
TAEGLICH="$WURZEL/taeglich"
MONATLICH="$WURZEL/monatlich"
DEFEKT="$WURZEL/defekt"
TAGE="${TAGE:-30}"
MONATE="${MONATE:-12}"
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
neu=0
for satz in "$EINGANG"/????-??-??; do
  [ -f "$satz/FERTIG" ] || continue
  name="$(basename "$satz")"
  if ! (cd "$satz" && sha256sum --quiet -c SHA256SUMS); then
    echo "Satz $name: Pruefsumme stimmt nicht, beiseitegelegt." >&2
    mv "$satz" "$DEFEKT/$name.$(date +%s)"
    melden /fail
    continue
  fi
  # Ein zweiter Satz desselben Tages (Nachholen) ersetzt den ersten.
  rm -rf "${TAEGLICH:?}/$name"
  mv "$satz" "$TAEGLICH/$name"
  monat="${name:0:7}"
  if [ ! -d "$MONATLICH/$monat" ]; then
    cp -al "$TAEGLICH/$name" "$MONATLICH/$monat"
  fi
  echo "Satz $name eingeordnet."
  neu=$((neu + 1))
done

# Die Namen sind Datumsangaben; lexikalisch ist chronologisch.
# shellcheck disable=SC2012
ls -1d "$TAEGLICH"/????-??-?? 2>/dev/null | head -n "-$TAGE" | xargs -r rm -rf
# shellcheck disable=SC2012
ls -1d "$MONATLICH"/????-?? 2>/dev/null | head -n "-$MONATE" | xargs -r rm -rf

[ "$neu" -gt 0 ] && melden ""
exit 0
