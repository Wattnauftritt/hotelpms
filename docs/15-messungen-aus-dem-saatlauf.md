# Messungen aus dem Saatlauf

Dieses Dokument hält fest, was ein Bestand in realistischer Größe über den Entwurf verraten hat. Es ist kein Planungsdokument, sondern ein Befundbericht: jeder Abschnitt nennt eine Messung, die Ursache dahinter und was daraufhin geändert wurde.

Der Saatlauf (`pnpm db:seed`) erzeugt vier Häuser zu je 250 Zimmern in 15 Kategorien über drei Jahre. Das sind 214 528 Reservierungen, 693 208 Übernachtungen, 230 632 Belegzeilen und 935 578 Zeilen Protokoll.

---

## Warum überhaupt ein Saatlauf

Ein Belegungsplan, der mit zwanzig Reservierungen in zwei Millisekunden antwortet, sagt nichts. Jeder Fehler, um den es hier geht, ist bei kleinen Datenmengen unsichtbar, und jeder einzelne davon hätte den Pilotbetrieb getroffen, nicht die Entwicklung.

Die drei Befunde unten sind in dieser Reihenfolge aufgetreten, und keiner davon stand im Review ([12-security-und-performance-review.md](12-security-und-performance-review.md), [13-gesamtreview.md](13-gesamtreview.md)). Reviews finden Denkfehler. Messungen finden Größenordnungsfehler.

---

## Befund 1 — Der Kapazitätstrigger war quadratisch in der Hausgröße

**Messung.** 250 Zimmer anzulegen dauerte 28 670 Millisekunden.

**Ursache.** Der Trigger auf `resource` lief `FOR EACH ROW` und rief `inventory_recalc_capacity(property, current_date, current_date + 750)` auf. Diese Funktion rechnet die Kapazität **aller** Kategorien der Property über 750 Tage neu. Bei n Zimmern und k Kategorien sind das n · k · 750 Zeilenberechnungen.

Das ist kein Problem des Saatlaufs. Es trifft jede Einrichtung eines Hauses, jeden Import und jede Sammeländerung — und es hält dabei Sperren auf `inventory_day`, während die Rezeption buchen will.

**Änderung** ([Migration 0013](../packages/db/migrations/0013_capacity_bulk.sql)). Trigger auf Anweisungsebene mit Übergangstabellen, und Berechnung je betroffener Kategorie statt je Property. Ein neues Zimmer betrifft eine Kategorie, nicht fünfzehn. Die Haussumme wird danach einmal je Property nachgezogen.

| | vorher | nachher |
|---|---|---|
| 250 Zimmer anlegen | 28 670 ms | 59 ms |

Eine Sperrung (`maintenance_block`) rechnet zusätzlich nur noch ihren eigenen Zeitraum: eine dreitägige Sperrung kostet drei Tage Rechenarbeit statt zwei Jahre.

---

## Befund 2 — Kennzahlen der Vergangenheit aus einem laufenden Zähler

**Messung.** Die Auslastung der Vergangenheit wurde mit 0,3 Prozent gemeldet, obwohl die Häuser zu knapp zwei Dritteln belegt waren.

**Ursache.** Kein Rechenfehler, sondern eine Verwechslung zweier verschiedener Dinge.

`inventory_day.sold` ist ein **laufender Zähler**: er sagt, wie viele Einheiten gerade gebunden sind. Eine abgereiste Reservierung bindet nichts mehr und wird darin zu Recht nicht gezählt. Für die Zukunft ist das genau die richtige Zahl — es ist der Stand auf den Büchern. Für die Vergangenheit ist sie strukturell null.

Der Kennzahlen-Endpunkt las beides aus derselben Spalte. Damit war jede Auswertung des vergangenen Jahres falsch, also genau der Zeitraum, den ein Betrieb tatsächlich ansieht.

**Änderung** ([Migration 0014](../packages/db/migrations/0014_day_statistics.sql)). `business_day_stat` als **Aufzeichnung**: was an diesem Tag tatsächlich verkauft war, festgehalten in dem Moment, in dem der Tag geschlossen wurde. Der Nachtlauf schreibt sie als Schritt 6, nach dem Buchen der Logis. Die Kennzahlen nehmen die Vergangenheit aus der Aufzeichnung und die Zukunft aus dem Zähler, und die Antwort benennt je Tag, aus welcher Quelle die Zahl stammt.

Das ist zugleich die schnellere Lösung:

| Jahresauswertung | Zeit |
|---|---|
| aus der Aufzeichnung, 365 Zeilen | 1 ms |
| roh aggregiert über die Übernachtungen | 73 ms |

**Die allgemeine Lehre.** Ein Zähler beantwortet „wie ist der Stand", eine Aufzeichnung beantwortet „wie war es". Wer das eine für das andere benutzt, bekommt keine Fehlermeldung, sondern eine plausibel aussehende falsche Zahl.

---

## Befund 3 — Die Namenssuche las die ganze Tabelle

**Messung.** Die Suche nach einem Namensteil über 60 000 Gäste brauchte 147 Millisekunden, als **Seq Scan**. Der Trigramm-Index wurde nicht benutzt.

**Ursache, zwei Schichten.**

Die obere Schicht ist eine Schätzung: PostgreSQL schätzt die Trefferzahl des Operators `%` schlecht ein und hält das Lesen der Tabelle für billiger. Erzwungen lief derselbe Plan in 25 ms.

Die tiefere Schicht ist die Form der Abfrage. `ORDER BY similarity(...) DESC LIMIT 20` muss **alle** Treffer holen und dann sortieren. Bei einem häufigen Namen sind das Tausende Zeilen für zwanzig Ausgaben — und ausgerechnet bei „Müller" wird es am langsamsten. Ein Index allein repariert das nicht.

**Änderung** ([Migration 0015](../packages/db/migrations/0015_guest_search.sql)). Ein **GiST**-Trigramm-Index kann den Abstandsoperator `<->` zur Sortierung benutzen. Der Index liefert die nächsten Nachbarn der Reihe nach, der Scan hört nach zwanzig Zeilen auf, es gibt keinen Sortierschritt.

| | Plan | Zeit |
|---|---|---|
| `ORDER BY similarity(...) DESC` | Seq Scan + Sort | 147 ms |
| dasselbe, Index erzwungen | Bitmap Heap Scan + Sort | 25 ms |
| `ORDER BY last_name <-> $1` | Index Scan, ohne Sort | 14 ms |

Entscheidend ist nicht nur die Zahl, sondern dass die Zeit **nicht mehr davon abhängt, wie verbreitet der Name ist**.

Die E-Mail wird nicht unscharf gesucht, sondern von vorn getippt. Dafür ist ein Btree mit Musteroperatorklasse der passende Index; sie läuft über einen eigenen, eigenständig begrenzten Zweig statt über ein ODER, das beide Indizes ausgeschlossen hätte.

**Der Preis.** Ein GiST-Index ist größer und beim Schreiben langsamer als ein GIN-Index. Für eine Gasttabelle, in der die Rezeption den ganzen Tag tippt und selten schreibt, ist das der richtige Tausch. Die GIN-Indizes sind damit ohne Aufgabe und wurden entfernt: sie stehen zu lassen kostet Schreibzeit und Platz für nichts.

---

## Befund 4 — Die geplante Datenmenge gibt es nicht

**Messung.** Der erste Saatlauf erzeugte 5137 überbuchte Kategorietage, mit bis zu 183 verkauften Einheiten bei 17 vorhandenen Zimmern.

**Ursache.** Der Plan sah 200 000 Reservierungen für ein Haus mit 250 Zimmern über drei Jahre vor. Diese Zahl gibt es nicht: 250 Zimmer mal 1095 Tage sind 273 750 Zimmernächte, 200 000 Reservierungen zu im Mittel vier Nächten wären 800 000. Die Planzahl war um den Faktor drei unmöglich.

Ein Bestand, den es so nicht geben kann, taugt nicht zum Messen. Er fällt in andere Ausführungspläne als der echte, und jede daraus abgeleitete Zahl ist wertlos.

**Änderung.** Dieselbe Zeilenzahl, verteilt auf eine kleine Kette aus vier Häusern. Das prüft nebenbei die Mandantentrennung unter Last, was mehr wert ist als ein unmögliches Einzelhaus.

Dazu die Erzeugungsregel: **je Zimmer statt je Reservierung**. Reservierungen unabhängig voneinander zu würfeln erzeugt immer Überbuchung an den Spitzen. Stattdessen belegt jedes Zimmer seine eigene Zeitachse — Aufenthalt, Lücke, Aufenthalt. Damit kann sich nichts überschneiden, und die Auslastung ergibt sich aus dem Verhältnis von Aufenthalt zu Lücke.

Ergebnis: **0 überbuchte Kategorietage**, 63,2 Prozent Auslastung in der Vergangenheit, 63,5 Prozent auf den Büchern.

---

## Befund 5 — Korrelierte Unterabfragen im Erzeugungsskript

Kein Produktionsbefund, aber dieselbe Fehlerklasse und deshalb erwähnenswert.

Die erste Fassung des Saatlaufs holte den Gast je Reservierung mit `SELECT ... OFFSET (i % 60000) LIMIT 1`. Bei 200 000 Zeilen ist das ein Scan über Milliarden Zeilen; der Lauf kam nach Minuten nicht über diesen Schritt hinaus und musste abgebrochen werden. Als Verbund über eine nummerierte Gastliste dauert derselbe Schritt 27 Sekunden.

Genau die Falle, die im Betrieb eine Liste zum Stillstand bringt, nur hier gut sichtbar. Sie ist der Grund, warum der Abfragezähler in [11-umsetzungsplan.md](11-umsetzungsplan.md) der wichtigste Test im Projekt ist.

---

## Die Zahlen, die stehen

Gemessen auf dem Entwicklungsrechner nach `ANALYZE`, mit warmem Cache, gegen ein Haus von 250 Zimmern innerhalb der Kette.

| Abfrage | Zeit | Zeilen |
|---|---|---|
| Jahresverfügbarkeit, eine Abfrage | 4 ms | 365 |
| Verfügbarkeit alle Kategorien, 365 Tage | 17 ms | 5840 |
| Belegungsplan 30 Tage, alle Zimmer | 7 ms | 250 |
| Anreiseliste eines Tages | 1 ms | 50 |
| Kennzahlen über ein Jahr, aufgezeichnet | 1 ms | 365 |
| Gästesuche über Namensteil | 14 ms | 20 |

Die Vorgabe aus [11-umsetzungsplan.md](11-umsetzungsplan.md) lautete: eine Jahresabfrage über alle Kategorien in einer Abfrage und unter 20 Millisekunden, ein Belegungsplan über 30 Tage und 250 Zimmer unter 80 Millisekunden. Beides ist erfüllt.

---

## Was der Saatlauf noch nicht misst

Ehrlichkeitshalber, damit die Zahlen oben nicht mehr tragen, als sie können:

- **Ein Entwicklungsrechner ist keine Produktionsmaschine.** Die Zahlen zeigen Größenordnungen und Verhältnisse, keine Zusagen.
- **Warmer Cache.** Der erste Zugriff nach einem Neustart ist langsamer. Die Verhältnisse zwischen den Varianten bleiben, die Absolutwerte nicht.
- **Keine Nebenläufigkeit.** Gemessen wurde eine Abfrage allein. Der Nebenläufigkeitsnachweis steckt im Test zu [AP 4](11-umsetzungsplan.md), nicht hier.
- **Vier Mandanten sind keine fünfhundert.** Die Zeilenrichtlinie wurde unter vier Properties gemessen. Bei vielen Mandanten je Datenbank ändert sich die Selektivität der Indizes.
- **Kein Schreiblastprofil.** Der Saatlauf schreibt in großen Anweisungen, der Betrieb in vielen kleinen Transaktionen. Das ist eine andere Belastung.
