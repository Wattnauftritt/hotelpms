#!/usr/bin/env bash
# Rueckspielprobe (Dokument 17 §9, vierteljaehrlich; Plan §7). Als root.
#
#   rueckspielprobe.sh <satz> <age-identitaet> [zieldatenbank]
#
# <satz> ist ein Verzeichnis aus Schicht 2 (taeglich/<Datum> auf dem
# zweiten Ziel, oder /var/backups/hotelpms/<Datum>). Die Identitaet ist der
# PRIVATE age-Schluessel aus dem Passwortspeicher; er wird nur fuer diesen
# Lauf gebraucht und gehoert danach wieder weg von der Maschine.
#
# Spielt den Dump in eine eigene Datenbank (Vorgabe hotelpms_restore), nie
# in die Produktion, und prueft, ob man mit dem Ergebnis arbeiten koennte:
#
#   - jedes Rechnungs-PDF und jeder Kassenbeleg gegen seine SHA-256,
#   - Anzahl und Summe der Rechnungen und des Kassenbuchs je Haus,
#   - dass die Umgebungsdatei mit ID_DOCUMENT_KEY im Satz steckt (ohne sie
#     sind die Ausweisnummern einer Rueckspielung unlesbar).
#
# Die Summen gehoeren mit der Produktion zum Sicherungstag verglichen: das
# Skript druckt sie, der Mensch vergleicht. Das Ergebnis haengt es mit Datum
# an das Protokoll an, das die Verfahrensdokumentation (§4) verlangt.
#
# Eine Sicherung, aus der nie zurueckgespielt wurde, ist eine Vermutung.
set -euo pipefail
umask 077

SATZ="${1:?Satzverzeichnis fehlt}"
IDENTITAET="${2:?age-Identitaet fehlt}"
ZIELDB="${3:-hotelpms_restore}"
PRODUKTION="${PRODUKTION:-hotelpms}"
PROTOKOLL="${PROTOKOLL:-/var/log/hotelpms-rueckspielprobe.log}"
EIGENTUEMER="${EIGENTUEMER:-hotelpms_owner}"

if [ "$ZIELDB" = "$PRODUKTION" ]; then
  echo "Zieldatenbank ist die Produktion ($PRODUKTION). Abgebrochen." >&2
  exit 1
fi
[ -f "$SATZ/FERTIG" ] || { echo "$SATZ ist kein fertiger Satz." >&2; exit 1; }
(cd "$SATZ" && sha256sum --quiet -c SHA256SUMS)

entschluesseln() { age --decrypt --identity "$IDENTITAET" "$SATZ/$1"; }

psql_pg() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 "$@"; }

beginn=$(date +%s)
psql_pg -q -d postgres -c "DROP DATABASE IF EXISTS \"$ZIELDB\" WITH (FORCE)"
psql_pg -q -d postgres -c "CREATE DATABASE \"$ZIELDB\" OWNER $EIGENTUEMER"
# Der Klartext geht ueber die Leitung, nie auf die Platte (Audit 19.10.,
# N6): vorher lag er fuer die Dauer der Probe als 644 in einem 755-
# Verzeichnis, lesbar fuer jeden Benutzer der Maschine, auch fuer den
# Dienstbenutzer der API. pg_restore liest das Custom-Format auch aus einem
# Strom; was dabei wegfaellt, ist nur -j, und das benutzt die Probe nicht.
# pipefail macht einen Fehler beim Entschluesseln zum Fehler der Probe.
entschluesseln datenbank.dump.age \
  | runuser -u postgres -- pg_restore --exit-on-error --dbname="$ZIELDB"
dauer=$(( $(date +%s) - beginn ))

# Als postgres: die Zeilenrichtlinien gelten fuer den Superuser nicht, die
# Probe sieht also jedes Haus.
abfrage() { psql_pg -At -F ' | ' -d "$ZIELDB" -c "$1"; }

pdf_falsch=$(abfrage "SELECT count(*) FROM invoice_document
                       WHERE encode(digest(pdf, 'sha256'), 'hex') <> sha256")
beleg_falsch=$(abfrage "SELECT count(*) FROM cashbook_receipt
                         WHERE encode(digest(bytes, 'sha256'), 'hex') <> sha256
                            OR octet_length(bytes) <> byte_count")
pdf_anzahl=$(abfrage "SELECT count(*) FROM invoice_document")
beleg_anzahl=$(abfrage "SELECT count(*) FROM cashbook_receipt")

schluessel=nein
if entschluesseln konfiguration.tar.age | tar -xOf - --wildcards '*/shared/env' 2>/dev/null \
     | grep -q '^ID_DOCUMENT_KEY=..'; then
  schluessel=ja
fi

echo
echo "Haus | Rechnungen | Brutto (Cent) | Kassenbuchzeilen | Kassensaldo (Cent)"
abfrage "SELECT p.id || ' ' || p.name,
                (SELECT count(*) FROM invoice i WHERE i.property_id = p.id),
                (SELECT coalesce(sum((i.totals->>'grossCent')::bigint), 0)
                   FROM invoice i WHERE i.property_id = p.id),
                (SELECT count(*) FROM cashbook_entry e WHERE e.property_id = p.id),
                (SELECT coalesce(sum(e.amount_cent), 0)
                   FROM cashbook_entry e WHERE e.property_id = p.id)
           FROM property p ORDER BY p.id"
echo
echo "Rechnungs-PDF:   $pdf_anzahl, davon falsch: $pdf_falsch"
echo "Kassenbelege:    $beleg_anzahl, davon falsch: $beleg_falsch"
echo "ID_DOCUMENT_KEY: $schluessel"
echo "Rueckspielung:   $dauer s"

ergebnis=bestanden
if [ "$pdf_falsch" != 0 ] || [ "$beleg_falsch" != 0 ] || [ "$schluessel" != ja ]; then
  ergebnis=NICHT_BESTANDEN
fi
printf '%s satz=%s ergebnis=%s dauer=%ss pdf=%s/%s belege=%s/%s schluessel=%s\n' \
  "$(date -u +%FT%TZ)" "$(basename "$SATZ")" "$ergebnis" "$dauer" \
  "$pdf_falsch" "$pdf_anzahl" "$beleg_falsch" "$beleg_anzahl" "$schluessel" >> "$PROTOKOLL"
echo
echo "Ergebnis: $ergebnis (eingetragen in $PROTOKOLL)"
echo "Die Datenbank $ZIELDB enthaelt Gastdaten. Nach dem Vergleich loeschen:"
echo "  runuser -u postgres -- dropdb $ZIELDB"
[ "$ergebnis" = bestanden ]
