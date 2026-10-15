#!/usr/bin/env bash
# Taegliche Sicherung, Schicht 2 der Backupstrategie. Laeuft als root ueber
# hotelpms-sicherung.timer; installiert als /usr/local/sbin/hotelpms-sicherung.
#
# Schreibt einen Satz nach $AUSGANG/<Datum>/ und schiebt ihn in den Eingang
# des zweiten Ziels (netcup-VPS, Sven 15.10.2026):
#
#   datenbank.dump.age      pg_dump --format=custom der Produktivdatenbank
#   rollen.sql.age          Rollen und Rechte, ohne Kennwoerter
#   konfiguration.tar.age   /etc (Auswahl) und die Umgebungsdatei
#   geloescht.txt.age       Konto und Gast-ID jeder Loeschung der letzten
#                           13 Monate, fuer den Loeschnachtrag (Plan §4)
#   SHA256SUMS              Pruefsummen der verschluesselten Dateien
#   FERTIG                  zuletzt geschrieben: erst dann ist der Satz ganz
#
# **Warum neben pgBackRest noch ein Dump.** Schicht 1 haengt an einem
# Werkzeug, einem Anbieter und einer Passphrase. Ein Fehler in einem davon
# trifft dann jede Sicherung. Ein Dump laesst sich mit jedem kuenftigen
# PostgreSQL zurueckspielen, und sein Schluessel liegt nicht auf dieser
# Maschine.
#
# **Warum age an einen oeffentlichen Schluessel.** Der private Schluessel
# liegt im Passwortspeicher und im Tresor, nie hier. Wer die Maschine
# uebernimmt, liest damit keine einzige Sicherung (Dokument 17 §3).
#
# **Warum geschoben und nicht geholt.** Die VM steht hinter dem Proxmox-Host
# und ist von aussen nicht erreichbar. Der VPS nimmt nur ueber `rrsync -wo
# -no-del` an: er kann von hier aus beschrieben, aber weder gelesen noch
# geleert werden, und er raeumt den Eingang selbst in ein Verzeichnis, an
# das diese Maschine nicht herankommt (einsortieren.sh).
set -euo pipefail
umask 077

KONFIG="${HOTELPMS_SICHERUNG_KONFIG:-/etc/hotelpms/sicherung.env}"
# shellcheck disable=SC1090
[ -f "$KONFIG" ] && . "$KONFIG"

DATENBANK="${DATENBANK:-hotelpms}"
UMGEBUNG="${UMGEBUNG:-/opt/hotelpms/shared/env}"
EMPFAENGER="${EMPFAENGER:-/etc/hotelpms/sicherung.age-empfaenger}"
AUSGANG="${AUSGANG:-/var/backups/hotelpms}"
# Lokal bleiben die letzten drei Saetze: genug, um nach einem gescheiterten
# Schieben nachzuholen, zu wenig, um eine zweite Ablage zu werden.
LOKAL_BEHALTEN="${LOKAL_BEHALTEN:-3}"
# Benutzer und Rechner des zweiten Ziels, etwa sicherung@vps.example.de.
# Leer: nur lokal schreiben (zum Erproben).
ZIEL="${ZIEL:-}"
SSH_SCHLUESSEL="${SSH_SCHLUESSEL:-/root/.ssh/hotelpms-sicherung}"
# Totmannschalter (z. B. healthchecks.io). Leer: keiner.
MELDEN="${MELDEN:-}"
# Was aus /etc mitgeht. SSH-Hostschluessel mit, damit eine neu aufgesetzte
# Maschine dieselbe ist und kein Client vor einem Angreifer warnt.
read -r -a ETC_AUSWAHL <<< "${ETC_AUSWAHL:-etc/caddy etc/postgresql etc/pgbouncer \
etc/pgbackrest etc/sudoers.d etc/systemd/system etc/ssh etc/hotelpms etc/ufw}"

melden() {
  [ -n "$MELDEN" ] || return 0
  curl -fsS -m 10 --retry 3 "$MELDEN$1" >/dev/null || true
}
trap 'melden /fail' ERR

[ -s "$EMPFAENGER" ] || { echo "Kein Empfaenger in $EMPFAENGER." >&2; exit 1; }
verschluesseln() { age --recipients-file "$EMPFAENGER" --output "$1"; }

STEMPEL="$(date +%F)"
SATZ="$AUSGANG/$STEMPEL"
rm -rf "$SATZ.teil"
mkdir -p "$SATZ.teil"
cd "$SATZ.teil"

# Ueber den Unix-Socket als postgres, nicht ueber PgBouncer: ein Dump haelt
# eine Transaktion ueber Minuten, und PgBouncer im Transaktionsmodus kann
# das nicht. --no-owner faellt bewusst weg: die Rueckspielung soll die
# Eigentuemer genau so herstellen, wie sie waren.
runuser -u postgres -- pg_dump --format=custom --compress=zstd:6 "$DATENBANK" \
  | verschluesseln datenbank.dump.age
runuser -u postgres -- pg_dumpall --roles-only --no-role-passwords \
  | verschluesseln rollen.sql.age

# Die Loeschliste: nur Kennungen, keine Namen. Nach einer Rueckspielung auf
# einen aelteren Stand holt loeschnachtrag.sh mit ihr die Loeschungen nach,
# die danach geschahen.
runuser -u postgres -- psql -X -At -v ON_ERROR_STOP=1 -d "$DATENBANK" -c \
  "SELECT account_id || ' ' || id FROM guest
    WHERE anonymized_at > now() - interval '13 months' ORDER BY id" \
  | verschluesseln geloescht.txt.age

vorhanden=()
for p in "${ETC_AUSWAHL[@]}"; do [ -e "/$p" ] && vorhanden+=("$p"); done
tar -C / -cf - "${vorhanden[@]}" "${UMGEBUNG#/}" | verschluesseln konfiguration.tar.age

sha256sum ./*.age > SHA256SUMS
date -u +%FT%TZ > FERTIG

cd "$AUSGANG"
rm -rf "$SATZ"
mv "$SATZ.teil" "$SATZ"

# Nur Saetze mit FERTIG zaehlen; ein halber von gestern wird mit aufgeraeumt.
find "$AUSGANG" -mindepth 1 -maxdepth 1 -type d -name '*.teil' -exec rm -rf {} +
# shellcheck disable=SC2012  # die Namen sind Daten, nichts anderes
ls -1d "$AUSGANG"/????-??-?? | head -n "-$LOKAL_BEHALTEN" | xargs -r rm -rf

if [ -n "$ZIEL" ]; then
  # Das Ziel nimmt nur in seinen Eingang an. FERTIG geht zuletzt, damit der
  # VPS nie einen halben Satz einsortiert.
  rsync -rt --exclude FERTIG -e "ssh -i $SSH_SCHLUESSEL -o BatchMode=yes" \
    "$SATZ/" "$ZIEL:$STEMPEL/"
  rsync -rt -e "ssh -i $SSH_SCHLUESSEL -o BatchMode=yes" \
    "$SATZ/FERTIG" "$ZIEL:$STEMPEL/FERTIG"
fi

echo "Sicherung $STEMPEL: $(du -sh "$SATZ" | cut -f1)"
melden ""
