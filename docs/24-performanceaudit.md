# Performanceaudit

Dieses Dokument hält fest, was eine systematische Durchsicht des ganzen Bestands gegen die Leistungsregeln aus [`CLAUDE.md`](../CLAUDE.md) ergeben hat: keine korrelierte Unterabfrage je Zeile, kein Aufruf je Zeile statt je Bildschirm, jeder Zeitraumparameter mit Obergrenze, Trigger auf Anweisungsebene wo eine Massenänderung vorkommt. Wie [`15-messungen-aus-dem-saatlauf.md`](15-messungen-aus-dem-saatlauf.md) ist es kein Planungsdokument, sondern ein Befundbericht — nur diesmal nicht aus einer einzelnen Messung entstanden, sondern aus einer vollständigen Durchsicht von Backend, Datenbank und Oberfläche.

**Vorgehen.** Fünf unabhängige Durchsichten (Backend-Routen, Datenbankmigrationen und Trigger, Oberfläche — jeweils Kernbestand und der seither gewachsene Rest) gegen dieselben Regeln, dazu eine eigene Prüfung auf Fremdschlüsselspalten ohne stützenden Index. Gemessen wurde anschließend gegen den echten Saatlauf (`pnpm db:seed`: vier Häuser, 1000 Zimmer, 60 000 Gäste, 214 528 Reservierungen, 693 208 Übernachtungen) und, wo der Saatlauf selbst zu klein war, gegen einen eigens dafür angelegten Bestand (unten benannt, nicht Teil des Saatlaufs).

**Ergebnis in Kürze.** Der Bestand ist überwiegend diszipliniert — Mengenoperationen statt Schleifen, `<->` statt `similarity()`, `LIMIT` fast überall, Zeiträume fast überall gedeckelt. Die Befunde unten sind deshalb konzentriert an wenigen Stellen, und zwei Muster wiederholen sich: eine neue Funktion, die dieselbe Unterabfrage-je-Zeile-Form annimmt, die dieses System zweimal schon als Fehler gefunden hatte (Migration 0013, 0015) — und eine Schleife mit einem `INSERT` je Nacht, wo eine Zeile weiter oben in derselben Datei schon die richtige Form zeigt.

Vier Befunde sind in diesem Durchgang behoben. Der Rest steht als offene Liste am Ende, nach Dringlichkeit geordnet, mit Fundstelle und Begründung, warum er nicht in diesem Durchgang mitgefixt wurde.

---

## Befund 1 — Die Kundenliste des Adminpanels lief über korrelierte Unterabfragen

**Messung.** `platform_accounts()` (Migration 0038) brauchte bei 51 Konten und rund 5 500 Benutzern 128 ms bei 14 102 Pufferzugriffen. Eigens angelegter Bestand nur zur Messung: ein Konto mit 4 000 Benutzern plus fünfzig weitere Konten mit je dreißig — der Saatlauf selbst legt nur **ein** Konto an und eignet sich für diese Frage nicht.

**Ursache.** Je Kontozeile liefen vier bis fünf Unterabfragen: eine für die Häuserzahl, zwei verschachtelte für die Benutzerzahl, dieselben zwei verschachtelt noch einmal für die letzte Anmeldung. `platform_health()` (dieselbe Migration) hatte dieselbe Form mit sechs Unterabfragen je Kontozeile für Postausgang, Zustellungen und Nachtlauf-Stand. Beides ist exakt die Form, die dieses System zweimal schon als Fehler gefunden hat — Migration 0013 beim Kapazitätstrigger, Migration 0015 bei der Gastsuche —, nur an einer neuen Stelle wieder eingeführt.

**Änderung** ([Migration 0043](../packages/db/migrations/0043_plattformkonsole_mengenbasiert.sql)). Je Kennzahl eine CTE, einmal nach Konto gruppiert, dann ein `LEFT JOIN` auf `account`. Rückgabetyp, Reihenfolge und Berechtigungsprüfung bleiben unverändert; geprüft mit einem zeilenweisen Vergleich der Ausgabe vor und nach der Änderung, byteidentisch.

| | vorher | nachher |
|---|---|---|
| `platform_accounts()`, 51 Konten | 128 ms, 14 102 Pufferzugriffe | 6 ms, 200 Pufferzugriffe |
| `platform_health()`, 51 Konten | 1,8 ms, 371 Pufferzugriffe | 1,0 ms, 33 Pufferzugriffe |

`platform_health()` war mit dem Mess-Bestand schon vorher schnell (die synthetischen Konten tragen keinen Postausgang), die Pufferzugriffe zeigen aber dieselbe strukturelle Verbesserung wie bei der Kundenliste.

---

## Befund 2 — Der Meldeschein-Export hatte keine Obergrenze für den Zeitraum

**Messung.** `GET /v1/properties/:propertyId/registrations` (`registrations.ts`) nahm `from`/`to` entgegen, ohne sie zu prüfen — weder auf ein gültiges ISO-Datum noch auf eine Höchstspanne. Jeder vergleichbare Endpunkt im Bestand (`availability.ts`, `rates.ts`, `reports.ts`, `channel.ts`) tut beides.

**Ursache.** Das `LIMIT 5000` in der Abfrage schützt nur die Antwortgröße, nicht die Breite des Bereichs, den die Datenbank durchsuchen muss — eine falsch getippte Jahreszahl in `from` durchsucht Jahrzehnte, bevor der erste Treffer überhaupt in Sicht kommt, und ein nicht-ISO-Wert führt zu einem rohen SQL-Fehler statt einer verständlichen Antwort.

**Änderung.** Dieselbe Prüfung wie überall sonst: `isIsoDate` auf beide Werte, dann eine Obergrenze von 800 Tagen (wie bei den vergleichbaren Berichten in `reports.ts`), vor der Abfrage statt danach.

---

## Befund 3 — Der Aufenthalt hatte keine Höchstdauer

**Messung.** `POST /v1/bookings` und die Verlängerung/Verkürzung eines Aufenthalts prüften nur `nightsBetween(...) <= 0` — eine Mindestdauer, aber keine Höchstdauer. In derselben Datei begrenzt `GRUPPE_MAX_ZIMMER = 50` die Gruppengröße ausdrücklich mit der Begründung, dass sonst "eine Anfrage, die minutenlang schreibt" entstünde; für die Dauer galt dieselbe Überlegung nicht.

**Ursache.** Jede Nacht einer Buchung wird als eigene Zeile in `reservation_night` angelegt, und zwar in einer Schleife mit einem `INSERT` je Nacht (siehe Offene Punkte, erster Eintrag). Ohne Obergrenze ergibt eine Buchung über fünfzig Zimmer und zehn Jahre rund 180 000 einzelne `INSERT`-Anweisungen in einer einzigen Transaktion — ein Selbstangriff genau der Art, die die Regel "jeder Zeitraumparameter hat eine Obergrenze" verhindern soll.

**Änderung.** `MAX_STAY_NIGHTS = 400` an beiden Stellen (Buchen, Verlängern/Verkürzen) — dieselbe Größenordnung wie beim Preisraster (`rates.ts`, `MAX_DAYS = 400`). Das behebt nicht die Schleife selbst (siehe unten), begrenzt aber den Schaden auf ein Zwanzigstel.

---

## Befund 4 — Der Zimmerplan zeichnete bei jedem Mausschritt alle Zimmerzeilen neu

**Messung.** Das Preisraster (`RateGrid.tsx`) hatte genau dieses Problem schon einmal, gemessen und behoben: ohne `memo` je Zeile zeichnete ein Zug mit der Maus bei 400 Tagen mal vier Plänen alle 1 600 Zellen neu, ein Zug über fünfzig Tage dauerte fünf Sekunden. Der Zimmerplan (`TapeChart.tsx`) hat dieselbe Zuggeste (`pointermove` bei praktisch jedem Pixel während Verschieben, Größenänderung und Gruppenauswahl) und eine größere Zellenzahl — bei 250 Zimmern und 60 Tagen mehrere tausend Zellen je Zug —, aber kein `memo` je Zeile.

**Ursache.** `data.units.map(u => ...)` erzeugte den ganzen Zeileninhalt jeder Zimmerzeile neu bei jedem `setDragState`-Aufruf, unabhängig davon, ob sich für diese Zeile überhaupt etwas geändert hatte.

**Änderung.** Die Zeile ist jetzt eine eigene, `memo`-umschlossene Komponente (`Zimmerzeile`), die nur einfache, über einen Zug hinweg stabile Merkmale entgegennimmt — eine Zahl, eine Zeichenkette oder `null`, nie das rohe `drag`-Objekt. Die drei Ereignisstarter (`beginneErstellen`, `beginneVerschieben`, `beginneGroesseAendern`) sind dafür von Fabriken, die je Zimmer einen neuen Ereignisverweis zurückgaben, zu stabilen `useCallback`-Aufrufen geworden, die die Kennung als Argument statt als Schließung entgegennehmen — sonst wäre jeder Verweis bei jedem Render neu gewesen und hätte das Merken wirkungslos gemacht, unabhängig von den übrigen Merkmalen.

Geprüft im Browser gegen den echten Saatlauf (250 Zimmer, Property 1): Aufziehen im leeren Bereich, Verschieben, Größenänderung und Gruppenauswahl (Strg-Zug über mehrere Zeilen) funktionieren alle unverändert, ohne Konsolenfehler.

---

## Was noch offen ist

Nach Dringlichkeit geordnet. Jeder Eintrag nennt die Fundstelle und den Grund, warum er nicht in diesem Durchgang behoben wurde — meist, weil er den Kernpfad einer Buchung oder des Nachtlaufs berührt und eine eigene, sorgfältig getestete Änderung verdient statt in einem Sammeldurchgang mitzulaufen.

### Dringend

| Fundstelle | Befund | Warum nicht jetzt |
|---|---|---|
| `apps/worker/src/jobs/nightAudit.ts`, `noShows`/`expireOptions`/`releaseBlocks` | Je Reservierung/Option/Sperrung zwei bis drei einzelne Abfragen statt einer Mengenoperation — exakt die Form, die `postCityTax` in derselben Datei mit Verweis auf Migration 0016 schon einmal behoben hat, hier aber nie nachgezogen wurde. Läuft **jede Nacht** über den ganzen Bestand des Hauses | Der Nachtlauf ist der empfindlichste Pfad im System (Bestand, Gebühren, Aufzeichnung); eine Änderung daran gehört in einen eigenen Durchgang mit der vollen Testabdeckung des Nachtlaufs, nicht in einen Sammeldurchgang |
| `apps/api/src/routes/reservations.ts` (Buchen, Verlängern), `channel.ts`, `apps/api/src/routes/import.ts` | `INSERT INTO reservation_night` in einer Schleife, eine Zeile je Nacht, statt eines `INSERT ... SELECT ... FROM unnest(...)`. `priceNights` in derselben Datei zeigt die richtige Form bereits, nur an dieser Stelle nicht angewendet. Befund 3 begrenzt den Schaden, behebt aber nicht die Schleife selbst | Berührt den Kernpfad jeder Buchung; verdient eine eigene Änderung mit der vollen Testabdeckung der Buchungsrouten |

### Mittel

| Fundstelle | Befund |
|---|---|
| `apps/api/src/routes/import.ts` | CSV-Import: pro Zeile sechs bis acht Abfragen (Dublettenprüfung, Bestandsabruf, Gast, Buchung, Reservierung, Nächte, Folio); bei `MAX_ZEILEN = 20 000` potenziell über 100 000 Abfragen in einer gehaltenen Transaktion. Teils unvermeidlich (`inventory_reserve()` je Zeile ist Fachlogik), aber die einfachen Upserts (Kategorien, Gäste) könnten auf `unnest()` umgestellt werden |
| `apps/api/src/routes/reports.ts`, Gästebeitrag-Export (Z. 731) und Beherbergungsstatistik (Z. 379) | Korrelierte Unterabfrage je Zeile in einer Gruppierung; bei bis zu 800 Tagen Zeitraum potenziell viele tausend Zeilen. Kandidat für `LEFT JOIN` plus Aggregat statt Unterabfrage |
| `apps/api/src/routes/support.ts` (Z. 158) | Eine `INSERT`-Anweisung je Empfänger einer Support-Sitzungs-Mail statt einer Mengenoperation. Niedrige Dringlichkeit, da die Empfängerzahl (Mitarbeiter mit `settings:account`) klein und fest ist |

### Gering, beobachten statt jetzt ändern

- `apps/api/src/routes/billing.ts` (Z. 885), Rechnungsliste: `mailStatus` als korrelierte Unterabfrage je Zeile, obwohl dieselbe Abfrage die Anzahlungssumme schon korrekt als `LEFT JOIN` mit Kommentar dazu führt — inkonsequent, aber durch das `LIMIT` der Liste ungefährlich.
- `apps/api/src/routes/housekeeping.ts` (Z. 49), `setup.ts` (Z. 252): korrelierte Zählung je Zimmer, durch die Zimmerzahl je Haus (Hunderte, nicht Tausende) begrenzt.
- `apps/api/src/routes/oauth.ts`, `GET /v1/oauth-clients`: kein `LIMIT`, und die verknüpfte Token-Aggregation waechst unbegrenzt mit dem Kontoalter — es gibt keinen Aufräumlauf für abgelaufene Token.
- `apps/api/src/routes/webhooks.ts` (Z. 125), `channel.ts` (Z. 148): Listen ohne `LIMIT`. Heute durch natürlich kleine Bestände (Abonnements, Kanalzugänge je Haus) ungefährlich.
- `outbound_email` (Migration 0028): kein Index, der die tatsächliche Abfrage in `email.ts` (`WHERE property_id = $1 ORDER BY id DESC`, alle Zustände) stützt — nur Teilindizes für einzelne Zustände.
- `channel_connection.property_id` (Migration 0023): kein Index; heute unbedenklich, da die Kanalzugänge je Haus eine Handvoll sind.
- `deploy_request.status = 'done'`: nur ein Teilindex für die laufenden Zustände; die Abfrage nach erledigten Ausrollungen (`deployments.ts`) hat keinen stützenden Index. Ausrollungen sind selten, daher gering.
- `platform_accounts()`/`platform_staff()` bleiben ohne `LIMIT` — **bewusst so**, siehe der Kommentar in Migration 0038: die Kundenzahl wächst mit dem Vertrieb, nicht mit dem Betrieb.
- `AvailabilityGrid.tsx` (bis 5 475 Zellen bei 365 Tagen × 15 Kategorien) und `RateGrid.tsx` (bis 6 000 Zellen bei 400 Tagen × 15 Plänen) bleiben unvirtualisiert — **bewusst so**, siehe [`19-frontend.md`](19-frontend.md) §9: "erst messen, dann holen". `RateGrid.tsx` hat bereits `memo` je Zeile (siehe Befund 4) und bleibt damit auch ohne Virtualisierung flüssig.
- `ChannelSicht.tsx`: derselbe Zellenumfang wie `RateGrid`, aber ohne `memo` je Zeile. Niedrigere Dringlichkeit als Befund 4, weil die Ansicht standardmäßig eingeklappt ist und keine Zuggeste hat.
- `apps/web/src/routes/Adminpanel.tsx`, `SupportKonsole.tsx`, `apps/web/src/components/SupportZugriff.tsx`, `Vorauszahlung.tsx`: bauen `Intl.DateTimeFormat` je Zeile über `toLocaleString`/`toLocaleDateString` statt des gemeinsamen, gemerkten Formatierers (`geldFormatierer`/`weekdayShort` in `lib/i18n/index.ts` — genau der Fund, der dort schon einmal behoben wurde). Heute unbedenklich, weil die betroffenen Listen (Konten, Support-Sitzungen, Personal) klein sind; ein Wachstum der Kundenzahl würde das ändern.
- `Adminpanel.tsx`, Kontenfilter (Z. 154): Filterung ohne `useMemo` bei jedem Tastendruck über eine Liste, die laut eigenem Kommentar "mit dem Vertrieb wächst, nicht mit dem Betrieb" — also gerade die Liste, die am ehesten groß wird.

---

## Wie geprüft wurde

Fünf unabhängige Durchsichten gegen dieselben fünf Regeln (kein Aufruf je Zeile, keine korrelierte Unterabfrage, Zeitraum mit Obergrenze, Liste mit `LIMIT`, `<->` statt `similarity()`), aufgeteilt nach Kernbestand und dem seither gewachsenen Rest, damit jede Durchsicht den ganzen Baum vollständig liest statt nur zu grep'en. Dazu eine eigene Abfrage über `pg_constraint`/`pg_index`, die jede Fremdschlüsselspalte ohne stützenden Index nennt — die meisten Treffer waren `created_by`/`granted_by`-artige Spalten ohne Filterbedarf, die drei tatsächlich fehlenden Indizes stehen oben in der offenen Liste.

Gemessen wurde gegen den echten Saatlauf für die Kernabfragen (der Saatlauf trägt seine eigene Messreihe schon, siehe unten) und gegen einen eigens angelegten, deutlich größeren Kontobestand für die Adminpanel-Funktionen, wo der Saatlauf mit einem einzigen Konto zu klein ist, um die Frage zu beantworten.

Der Saatlauf selbst misst nach jedem Lauf acht Kernabfragen (`packages/db/src/cli/seed.ts`, Abschnitt „Messungen"); alle acht lagen bei diesem Durchgang unter 20 ms außer der bewusst unindiziert gelassenen Vergleichsabfrage (79 ms, siehe [`15-messungen-aus-dem-saatlauf.md`](15-messungen-aus-dem-saatlauf.md), Befund 2) — keine Regression an den schon einmal geprüften Stellen.
