#!/usr/bin/env bash
# Loeschnachtrag nach einer Rueckspielung (Plan §4). Als root.
#
#   loeschnachtrag.sh <geloescht.txt.age aus dem NEUESTEN Satz> <age-identitaet> [datenbank]
#
# Eine Rueckspielung auf einen aelteren Stand holt Gaeste zurueck, die
# danach nach Art. 17 DSGVO geloescht wurden. Jeder Satz der Schicht 2
# traegt deshalb die Liste der Loeschungen der letzten 13 Monate, als
# Konto und Gast-ID, ohne Namen. Dieses Skript ruft fuer jede Zeile erneut
# guest_erase_one() auf, die eine Stelle, an der zu einem Gast geloescht
# wird (CLAUDE.md). Die Liste kommt aus dem neuesten Satz, nicht aus dem
# zurueckgespielten: nur der kennt die spaeteren Loeschungen.
#
# Teilloeschungen (guest_erase_partial) holt es nicht nach; sie sind
# selten und stehen im Protokoll der Produktion. Nach einer Rueckspielung
# aus Schicht 1 bis auf die Minute ist die Liste fast immer schon erledigt.
set -euo pipefail

LISTE="${1:?geloescht.txt.age fehlt}"
IDENTITAET="${2:?age-Identitaet fehlt}"
DATENBANK="${3:-hotelpms}"

zeilen=0
nachgeholt=0
while read -r konto gast; do
  [ -n "${gast:-}" ] || continue
  [[ "$konto" =~ ^[0-9]+$ && "$gast" =~ ^[0-9]+$ ]] \
    || { echo "Unlesbare Zeile: $konto $gast" >&2; exit 1; }
  zeilen=$((zeilen + 1))
  # guest_erase_one() wirkt nur im Kontext des Kontos, dem der Gast
  # gehoert; ohne ihn tut sie still nichts. Je Gast eine Transaktion,
  # damit ein Fehler nicht die vorigen Loeschungen zurueckrollt.
  r=$(runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -d "$DATENBANK" \
        -v konto="$konto" -v gast="$gast" <<'SQL'
BEGIN;
SELECT set_config('app.account_ids', :'konto', true);
SELECT count(*) FROM guest WHERE id = :'gast'::bigint AND status <> 'anonymized' \gset
SELECT guest_erase_one(:'gast'::bigint);
COMMIT;
SELECT :'count';
SQL
)
  [ "$(tail -n1 <<< "$r")" = 1 ] && nachgeholt=$((nachgeholt + 1))
done < <(age --decrypt --identity "$IDENTITAET" "$LISTE")

echo "Loeschliste: $zeilen Gaeste, davon $nachgeholt nachgeholt."
