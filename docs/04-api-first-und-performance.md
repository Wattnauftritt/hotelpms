# API-first und Performance-Architektur

Zwei Themen, die zusammengehören. API-first ist nicht nur eine Frage des Ökosystems, es ist auch die Antwort auf genau das Latenzproblem, das Systeme wie KWHotel träge macht.

---

# Teil 1: Was API-first bedeutet

## 1.1 Die Kurzfassung

**API-first heißt: das API ist das Produkt, die Oberfläche ist nur ein Kunde davon.**

Das Backend weiß nicht, dass es eine Rezeptions-Oberfläche gibt. Es kennt nur Ressourcen und Operationen. Ob die ein Browser, eine Kiosk-App, ein Channel Manager oder ein Partner aufruft, ist ihm egal. Es gibt keinen Weg an dem API vorbei, auch nicht für unsere eigene Oberfläche.

Der Test dafür ist einfach: **Wenn ein Dritter mit reinem API-Zugriff jede Funktion nachbauen kann, die unsere Oberfläche hat, sind wir API-first. Wenn irgendwo eine Funktion nur über die UI geht, sind wir es nicht.**

## 1.2 Die vier Reifegrade

Man erkennt den Unterschied am besten in der Abstufung. Das ist keine Theorie, sondern die reale Entwicklungsgeschichte der Branche.

**Stufe 0: Fat Client auf der Datenbank.**
Ein Desktop-Programm spricht direkt SQL mit einer MySQL- oder Firebird-Datenbank. Es gibt keinen Server dazwischen. Die Geschäftslogik sitzt im Client. So funktionieren KWHotel, viele ältere DACH-Systeme und die On-Premises-Generation von protel und Fidelio.

- Es gibt kein API. Integrationen laufen über Dateiexporte, direkte DB-Zugriffe Dritter oder gar nicht.
- Jede Instanz des Clients hat vollen Datenbankzugriff. Sicherheitstechnisch untragbar für Cloud.
- **Und: jede Nutzerinteraktion ist ein Netzwerk-Roundtrip zur Datenbank.** Dazu gleich mehr, das ist der Kern des Performanceproblems.

**Stufe 1: Datenbank-first mit Webhülle.**
Die Datenbank existiert, jemand baut eine Weboberfläche darüber. Die Endpunkte spiegeln 1:1 die Tabellen. Jede Änderung am Schema bricht das API.

**Stufe 2: API als Nachgedanke.**
Es gibt ein Produkt mit Oberfläche, und später wird ein API angeflanscht, weil Kunden Integrationen wollen. Typisches Erkennungszeichen: das API kann 60 Prozent von dem, was die Oberfläche kann, und die restlichen 40 Prozent kommen nie. Die interne Oberfläche nutzt private Endpunkte, das öffentliche API ist ein zweiter, schlechterer Weg. So sind die meisten etablierten Systeme gebaut.

**Stufe 3: API-first, contract-first.**
Der Vertrag wird zuerst geschrieben, als OpenAPI-Spezifikation, bevor eine Zeile Implementierung existiert. Aus der Spezifikation werden Server-Gerüst, Client-Bibliotheken, Mock-Server und Dokumentation generiert. Das Frontend-Team kann gegen den Mock arbeiten, bevor das Backend fertig ist. Apaleo ist so gebaut, Mews weitgehend auch.

Wir wollen Stufe 3.

## 1.3 Was konkret dazugehört

**Ein Vertrag, maschinenlesbar.**
OpenAPI 3.1.

> **Präzisiert in [10-systemarchitektur.md](10-systemarchitektur.md):** Der API-Entwurf wird vorab als Dokument festgelegt, die Spezifikation aber aus typisierten Routen-Schemata **generiert**, und ein Vertragstest schlägt bei brechenden Änderungen fehl. Handgepflegtes YAML plus generierte Rümpfe wäre strenger, driftet in der Praxis jedoch auseinander. Der folgende Absatz beschreibt das Prinzip, Dokument 10 die verbindliche Umsetzung. Aus ihm entstehen: Server-Stubs, TypeScript-Typen für unsere Oberfläche, Client-SDKs für Partner, die Dokumentation und die Vertragstests.

**Ressourcen und Operationen, keine Tabellen.**
`POST /reservations/{id}/check-in` ist eine Operation der Domäne. `PATCH /reservations/{id}` mit `{"status": "InHouse"}` ist eine Tabellenzeile mit anderem Wert. Ersteres kann validieren, Meldeschein prüfen, Zimmer sperren, Ereignis auslösen. Letzteres lädt zu Zuständen ein, die es nicht geben darf.

**Ein Authentifizierungsmodell für alle.**
OAuth 2.0. Unsere Oberfläche ist ein Client mit einem Token, ein Partner ist ein Client mit einem Token. Unterschiedlich sind nur die Scopes. Kein Sonderweg mit Session-Cookies für die eigene UI und Tokens für alle anderen. Wer einen Sonderweg baut, hört auf, ihn zu testen.

**Ereignisse nach außen.**
Webhooks für jede Zustandsänderung: Reservierung angelegt, geändert, eingecheckt, storniert; Folio geschlossen; Rechnung erstellt; Preis geändert. Mit Signatur, garantierter Zustellung und Wiederholung. Ohne Ereignisse muss jeder Partner pollen, und Polling ist der zweitbeste Weg, ein System langsam zu machen.

**Versionierung von Tag eins.**
`/v1/` im Pfad. Additive Änderungen (neue optionale Felder) sind erlaubt, alles andere braucht eine neue Version. Sobald ein Partner produktiv ist, kann man Felder nicht mehr umbenennen.

**Idempotenz bei allem, was Geld oder Bestand anfasst.**
`Idempotency-Key` als Header bei jedem POST. Ein Channel Manager, der wegen Timeout eine Buchung zweimal schickt, darf nicht zwei Reservierungen erzeugen. Das ist kein Luxus, das ist der häufigste Supportfall bei Buchungsschnittstellen.

## 1.4 Was es bringt

| Nutzen | Warum |
|---|---|
| Mehrere Oberflächen ohne Mehraufwand | Rezeption, Housekeeping-Handy, Kiosk, Gäste-Self-Service und Booking Engine sind fünf Clients auf einem Backend |
| Partner-Ökosystem | Der Grund, warum Mews und Apaleo Marketplaces haben und die DACH-Anbieter nicht. Jede Integration, die ein Partner baut, ist Funktionalität, die wir nicht bauen |
| Testbarkeit | Die gesamte Geschäftslogik ist über HTTP testbar, ohne Browser, ohne UI-Automatisierung |
| Migrierbarkeit | Die Oberfläche kann komplett ersetzt werden, ohne das Backend anzufassen |
| Disziplin | Ein öffentlicher Vertrag zwingt dazu, das Domänenmodell sauber zu halten. Interne Abkürzungen fallen auf |

## 1.5 Was es kostet, und die eine große Falle

**Die Kosten:** Mehr Entwurfsaufwand vorab. Versionierungsdisziplin. Man kann nicht mehr eben schnell ein Feld umbenennen.

**Die Falle, und die ist ernst:** Naiv umgesetztes API-first macht Anwendungen **langsamer** als ein Fat Client.

Der Grund: Wenn man REST dogmatisch nimmt, bekommt man pro Ressource einen Endpunkt. Um einen Zimmerplan zu rendern, ruft die Oberfläche dann auf:

```
GET /properties/1/categories          →  15 Kategorien
GET /properties/1/units               →  200 Zimmer
GET /reservations?from=...&to=...     →  400 Reservierungen
GET /guests/{id}                      →  400 Mal, einmal pro Reservierung
GET /housekeeping/statuses            →  200 Zimmerstatus
GET /maintenance-blocks?from=...      →  12 Sperrungen
```

Das sind über 400 HTTP-Requests für einen Bildschirm. Bei 40 ms Latenz zwischen Browser und Server sind das 16 Sekunden, wenn sie seriell laufen, und ein überlastetes Backend, wenn sie parallel laufen. Genau daran scheitern viele „moderne" Neubauten.

**Die Lösung ist nicht, API-first aufzugeben, sondern Endpunkte für Bildschirme statt für Tabellen zu entwerfen.** Dazu Teil 2.

## 1.6 REST oder GraphQL?

GraphQL löst genau dieses Over- und Underfetching-Problem: der Client fragt, was er braucht, in einem Request. Der Preis ist, dass die Kosten einer Anfrage nicht mehr vorhersagbar sind. Ein Partner kann eine Abfrage stellen, die die Datenbank für Minuten beschäftigt. Man braucht Query-Tiefenbegrenzung, Komplexitätsanalyse und Persisted Queries, um das einzufangen, und dann hat man die Flexibilität wieder weggenommen, für die man GraphQL genommen hat.

**Empfehlung: REST mit bewusst entworfenen Aggregat-Endpunkten.** Wir kontrollieren beide Seiten, also können wir für jeden echten Bildschirm einen passenden Endpunkt bauen. Für Partner bleiben die granularen Ressourcen-Endpunkte. Das ist der Weg, den Apaleo und Mews gehen.

---

# Teil 2: Performance-Architektur

## 2.1 Zuerst: die 30 bis 50 ms einordnen

Das ist ein wichtiger Punkt, weil die Zahl verrät, wo das Problem sitzt.

| Verbindung | Round Trip zur Datenbank |
|---|---|
| Postgres auf demselben Host, Unix-Socket | 0,05 bis 0,2 ms |
| Postgres im selben Rechenzentrum, über TCP | 0,3 bis 1 ms |
| Postgres in einer anderen Region oder über das Internet | 20 bis 80 ms |
| Zusätzlich pro **neuer** Verbindung: TCP-Handshake plus TLS | 2 bis 3 weitere Round Trips |

**30 bis 50 ms sind keine Datenbankarbeit, das ist Netzwerkdistanz.** Eine Abfrage, die einen Index trifft, braucht in Postgres 0,05 bis 0,5 ms Rechenzeit. Wenn ein Zugriff 40 ms dauert, verbringt er 39,5 ms auf dem Kabel.

Bei KWHotel kommt das aus der Architektur: ein Desktop-Client spricht direkt mit einer MySQL-Instanz, die oft auf einem Server im Internet liegt. Jedes Aufklappen einer Liste, jeder Tastendruck in einem Suchfeld ist eine WAN-Runde. Dagegen hilft keine Query-Optimierung.

**Daraus folgen zwei getrennte Maßnahmen, die beide nötig sind:**

1. **Die Latenz senken.** Anwendungsserver und Datenbank im selben Netz, idealerweise in derselben Availability Zone. Persistente Verbindungen aus einem Pool, nie pro Anfrage neu aufbauen. Damit fällt der Round Trip von 40 ms auf unter 1 ms.
2. **Die Anzahl der Round Trips senken.** Denn wenn ein Bildschirm 400 Abfragen braucht, sind auch 0,5 ms pro Abfrage noch 200 ms.

Und hier schließt sich der Kreis zu Teil 1: **API-first ist die Architektur, die das erste Problem strukturell löst.**

```
Fat Client (KWHotel):
  Client ──40ms── DB     ×  400 Abfragen  =  16 Sekunden

API-first:
  Client ──40ms── API-Server ──0,3ms── DB
                   └─ 400 Abfragen × 0,3 ms = 120 ms
  Gesamt: 40 ms + 120 ms = 160 ms
```

Der Client macht **eine** teure Runde. Der Server macht die vielen billigen. Allein diese Verschiebung ist ein Faktor 100. Und wenn wir die 400 dann noch auf 3 reduzieren, sind wir bei 41 ms.

## 2.2 Das Grundgesetz

> **Antwortzeit ≈ Anzahl der Round Trips × Latenz pro Round Trip**

Rechenzeit spielt in einem PMS fast keine Rolle. Es gibt keine schweren Berechnungen. Alles, was langsam ist, ist Warten. Deshalb ist die einzige Kennzahl, die wir wirklich steuern müssen, die **Anzahl der Round Trips pro Anfrage** und die muss eine **feste Obergrenze** haben, die nicht mit der Datenmenge wächst.

**Die Regel: Die Anzahl der Datenbankabfragen pro API-Anfrage muss konstant sein, unabhängig von der Anzahl der zurückgegebenen Zeilen.**

Ein Endpunkt, der bei 10 Reservierungen 12 Abfragen macht und bei 400 Reservierungen 402, ist kaputt, auch wenn er sich in der Entwicklung mit Testdaten schnell anfühlt.

## 2.3 Das N+1-Problem und warum ORMs es erzeugen

Der häufigste Weg, das Grundgesetz zu verletzen:

```python
reservierungen = db.query(Reservation).filter(...).all()   # 1 Abfrage
for r in reservierungen:
    print(r.guest.name)          # 1 Abfrage pro Durchlauf
    print(r.category.name)       # noch eine
    print(r.rate_plan.name)      # und noch eine
```

Das sind bei 400 Reservierungen 1201 Abfragen. Der Code sieht harmlos aus. Das ist die Gefahr: **Lazy Loading macht Netzwerkzugriffe unsichtbar, sie sehen aus wie Attributzugriffe.**

**Unsere Regeln dagegen:**

1. **Lazy Loading global abschalten.** In SQLAlchemy `lazy="raise"` als Default, in Hibernate `FetchType.LAZY` plus Exception statt stillem Nachladen, in Prisma und Drizzle ist es ohnehin explizit. Ein Zugriff auf eine nicht geladene Beziehung muss einen **Fehler** werfen, nicht eine Abfrage. Dann fällt das Problem beim Entwickeln auf und nicht beim Kunden mit 200 Zimmern.
2. **Beziehungen explizit mitladen.** Ein Join oder ein zweiter Aufruf mit `WHERE id = ANY($1)`. Zwei Abfragen statt 401.
3. **Für die heißen Pfade handgeschriebenes SQL.** Ein ORM ist gut für Schreibvorgänge und einfache Abfragen. Für den Zimmerplan und die Verfügbarkeitssuche schreiben wir SQL und wissen, was passiert.

## 2.4 Beispiel: der Zimmerplan

Der anspruchsvollste Bildschirm im ganzen System. 30 Tage mal 200 Zimmer, mit Reservierungen, Gastnamen, Housekeeping-Status und Sperrungen.

**Naiv, wie oben:** über 1200 Abfragen, mehrere Sekunden.

**Richtig: drei Abfragen, in einem Endpunkt.**

```sql
-- 1. Zimmer und Kategorien (klein, cachebar)
SELECT u.id, u.number, u.floor, u.category_id, c.name AS category_name
  FROM unit u JOIN resource_category c ON c.id = u.category_id
 WHERE u.property_id = $1 AND u.active
 ORDER BY c.sort_order, u.number;

-- 2. Alle überlappenden Reservierungen mit allem, was angezeigt wird,
--    in einem Join. Kein Nachladen von Gast, Kategorie, Ratenplan.
SELECT r.id, r.unit_id, r.category_id, r.arrival, r.departure, r.status,
       r.adults, r.children,
       g.last_name, g.first_name,
       rp.code AS rate_code,
       b.source, b.external_reference
  FROM reservation r
  JOIN guest g   ON g.id = r.primary_guest_id
  JOIN booking b ON b.id = r.booking_id
  LEFT JOIN rate_plan rp ON rp.id = r.rate_plan_id
 WHERE r.property_id = $1
   AND r.arrival < $3 AND r.departure > $2      -- Überlappung
   AND r.status IN ('Optional','Confirmed','InHouse');

-- 3. Housekeeping-Status und Sperrungen
SELECT unit_id, status FROM housekeeping_status WHERE property_id = $1
UNION ALL ...
```

Das Zusammensetzen zum Raster passiert im Anwendungsserver im Speicher. 400 Reservierungen in eine Map nach `unit_id` zu sortieren kostet Mikrosekunden.

**Der entscheidende Index** für Abfrage 2:

```sql
CREATE INDEX ON reservation (property_id, departure, arrival)
  WHERE status IN ('Optional','Confirmed','InHouse');
```

Ein partieller Index, der nur die aktiven Reservierungen enthält. Stornierte und ausgecheckte machen nach ein paar Jahren 95 Prozent der Tabelle aus und dürfen den Index nicht aufblähen.

**Ergebnis:** 3 Abfragen, unabhängig davon, ob das Haus 20 oder 500 Zimmer hat. Bei 0,3 ms Datenbanklatenz und etwas Verarbeitung landet der Endpunkt bei 15 bis 40 ms.

## 2.5 Verfügbarkeit: der wichtigste Entwurf im ganzen System

Verfügbarkeit wird bei jeder Suche, jeder Buchung, jeder Preisabfrage und jedem ARI-Push an den Channel Manager gebraucht. Wenn das langsam ist, ist alles langsam.

**Der naive Weg, und warum er nicht funktioniert:**

```sql
-- Für jede Kategorie, für jeden Tag: zähle überlappende Reservierungen
SELECT count(*) FROM reservation
 WHERE category_id = $1 AND arrival <= $2 AND departure > $2;
```

Bei 15 Kategorien und 365 Tagen sind das 5475 Abfragen, jede ein Scan über die Reservierungstabelle. Selbst mit Index dauert das Sekunden und skaliert mit der Historie.

**Der richtige Weg: eine Zählertabelle je Kategorie und Tag, transaktional gepflegt.**

```sql
CREATE TABLE inventory_day (
  property_id   bigint  NOT NULL,
  category_id   bigint  NOT NULL,
  date          date    NOT NULL,
  capacity      integer NOT NULL,           -- Zimmer der Kategorie minus Out of Order
  sold          integer NOT NULL DEFAULT 0, -- Optional + Confirmed + InHouse
  blocked       integer NOT NULL DEFAULT 0, -- nicht abgerufenes Kontingent
  overbooking   integer NOT NULL DEFAULT 0, -- bewusst erlaubte Überbuchung
  PRIMARY KEY (property_id, category_id, date),
  CONSTRAINT sold_nonneg CHECK (sold >= 0)
);
```

Verfügbarkeit ist dann `capacity - sold - blocked + overbooking`, und die Abfrage für ein ganzes Jahr über alle Kategorien ist **eine einzige** Index-Range-Abfrage:

```sql
SELECT category_id, date,
       capacity - sold - blocked + overbooking AS available
  FROM inventory_day
 WHERE property_id = $1 AND date >= $2 AND date < $3;
```

5475 Zeilen, ein sequenzieller Scan über einen zusammenhängenden Indexbereich, unter einer Millisekunde. **Und die Laufzeit ist unabhängig davon, wie viele Reservierungen es je gab.**

### Buchen: Korrektheit und Geschwindigkeit in einer Anweisung

Der klassische Fehler ist, erst zu prüfen und dann zu schreiben. Zwischen Prüfung und Schreiben kann eine zweite Buchung dasselbe Zimmer nehmen. Klassische Lösung: `SELECT ... FOR UPDATE`, dann prüfen, dann `UPDATE`. Das sind drei Round Trips und eine Sperre, die über die ganze Anwendungslogik gehalten wird.

**Besser: prüfen und schreiben in einer Anweisung.**

```sql
UPDATE inventory_day
   SET sold = sold + 1
 WHERE property_id = $1
   AND category_id = $2
   AND date >= $3 AND date < $4                       -- Nächte des Aufenthalts
   AND sold + blocked + 1 <= capacity + overbooking   -- Kapazitätsprüfung
RETURNING date;
```

Die Anwendung zählt die zurückgegebenen Zeilen. Sind es genauso viele wie Nächte, ist gebucht. Ist es eine weniger, war eine Nacht voll, und die Transaktion wird zurückgerollt. **Ein Round Trip, atomar, kein Doppelverkauf möglich.**

Zwei Details, die sonst später wehtun:

- **Sperrreihenfolge.** Postgres sperrt die Zeilen in Indexreihenfolge, also nach Datum aufsteigend. Wenn eine Transaktion mehrere Kategorien anfasst (Gruppenbuchung), müssen die Kategorien in aufsteigender ID-Reihenfolge bearbeitet werden, sonst gibt es Deadlocks.
- **Nur gleiche Kategorie blockiert.** Zwei Buchungen in verschiedenen Kategorien berühren verschiedene Zeilen und laufen ohne Wartezeit parallel. Das ist der Grund, warum diese Tabelle nach `(property, category, date)` geschnitten ist und nicht gröber.

### Wer pflegt die Zähler?

Alles, was Bestand verändert, muss in derselben Transaktion die Zähler anpassen: Reservierung anlegen, ändern, stornieren, No-Show, Out-of-Order-Sperrung, Kontingent anlegen oder freigeben, Zimmer hinzufügen oder deaktivieren.

**Genau ein Besitzer, keine konkurrierenden Schreiber.** Alle Änderungen an `inventory_day` laufen durch drei SQL-Funktionen: `inventory_reserve`, `inventory_release`, `inventory_set_capacity`. Der Buchungspfad ruft `reserve` und `release`, Trigger auf Sperrungen und Zimmern rufen `set_capacity`. Die Anwendungsrolle bekommt kein `UPDATE` auf die Tabelle, nur `EXECUTE` auf die Funktionen. Damit kann kein Pfad die Zähler umgehen und keiner sie doppelt zählen. Eine frühere Fassung dieses Abschnitts empfahl Trigger auf der Reservierungstabelle; das kollidierte mit der atomaren Belegungsanweisung oben, siehe W1 in [12-security-und-performance-review.md](12-security-und-performance-review.md).

Dazu ein täglicher Abgleichjob, der die Zähler gegen die Reservierungstabelle nachrechnet und Abweichungen meldet. Nicht weil wir mit Fehlern rechnen, sondern weil ein stiller Zählerfehler das Schlimmste ist, was einem Bestandssystem passieren kann.

## 2.6 Caching, aber richtig

Die `inventory_day`-Tabelle ist bereits ein Cache. Der wichtige Unterschied zu einem Redis-Cache: **sie wird in derselben Transaktion aktualisiert wie die Daten, aus denen sie abgeleitet ist.** Sie kann nicht veralten. Ein externer Cache kann das nie garantieren, und ein veralteter Verfügbarkeitscache verkauft Zimmer doppelt.

**Die Faustregel: Abgeleitete Daten, die korrekt sein müssen, gehören transaktional in die Datenbank. Ein externer Cache ist nur für Daten zulässig, bei denen Veralten harmlos ist.**

Was wir sonst cachen, und wo:

| Daten | Wo | Invalidierung |
|---|---|---|
| Kategorien, Zimmer, Ratenpläne, Steuerregeln, Produkte | Im Prozessspeicher des Anwendungsservers | Versionszähler je Property in der DB, oder Postgres `LISTEN/NOTIFY`. Ändert sich selten, wird ständig gelesen |
| Verfügbarkeit und Preise | `inventory_day` und `rate_day` in der DB | Transaktional, siehe oben |
| Berechnete Tagesberichte, Kennzahlen | Materialisierte Tabelle, vom Nachtlauf geschrieben | Einmal täglich |
| Antworten auf öffentliche Leseabfragen | HTTP mit ETag und `Cache-Control` | Über die ETag-Prüfung |
| Sessions und Rate Limiting | Redis | Ablaufzeit |

**Keinen verteilten Cache für Bestandsdaten.** Das ist die Stelle, an der Systeme unerklärliche Überbuchungen produzieren.

## 2.7 Weitere Regeln

**Verbindungspool, immer.** Eine feste Anzahl persistenter Verbindungen, in Postgres zusätzlich PgBouncer im Transaction-Pooling-Modus. Ohne Pool kostet jede Anfrage einen TCP- und TLS-Handshake, also 2 bis 3 zusätzliche Round Trips plus den Aufwand, dass Postgres einen neuen Prozess startet.

**Prepared Statements.** Spart das Parsen und Planen bei jeder Abfrage. Bei Abfragen, die tausendfach pro Minute laufen, sind das spürbare Prozente.

**Schreiben bündeln.** Ein ARI-Push für 365 Tage ist ein `INSERT ... ON CONFLICT DO UPDATE` mit 365 Zeilen, nicht 365 Anweisungen. Postgres verarbeitet das in einer Runde.

**Paginierung mit Cursor, nicht mit OFFSET.** `OFFSET 10000` zwingt die Datenbank, 10000 Zeilen zu lesen und wegzuwerfen. Ein Cursor auf `(created_at, id)` springt direkt an die Stelle.

**Nur laden, was angezeigt wird.** Ein Reservierungsobjekt in der Liste braucht 8 Felder, nicht 40 plus vier verknüpfte Objekte. Getrennte Repräsentationen für Liste und Detail.

**Alles, was nicht die Antwort blockiert, kommt in eine Queue.** E-Mail-Versand, Webhook-Zustellung, PDF-Erzeugung, Statistikmeldung, Channel-Manager-Push. Der Nutzer wartet auf das Speichern der Reservierung, nicht auf den Mailserver.

**Zeitzonen einmal auflösen.** Aufenthaltsdaten sind Kalenderdaten in der Zeitzone der Property, keine Zeitstempel. Wenn man das nicht sauber trennt, konvertiert man in Schleifen hin und her, und Zeitzonenkonvertierung ist überraschend teuer.

## 2.8 Latenzbudget

Ohne Zielwerte ist Performance nur Meinung. Vorschlag für p95, gemessen serverseitig, ohne Netzwerk zum Client:

| Endpunkt | Ziel p95 | Erlaubte DB-Round-Trips |
|---|---|---|
| Verfügbarkeit, 30 Tage, alle Kategorien | 20 ms | 1 |
| Verfügbarkeit mit Preisen, 365 Tage | 60 ms | 2 |
| Zimmerplan, 30 Tage × 200 Zimmer | 80 ms | 3 |
| Reservierung anlegen | 60 ms | 4, eine Transaktion |
| Reservierung laden, Detailansicht | 30 ms | 2 |
| Folio öffnen mit allen Positionen | 30 ms | 2 |
| Check-in ausführen | 80 ms | 5 |
| Anreise- oder Abreiseliste | 30 ms | 1 |
| Rechnung festschreiben | 100 ms | 5 |
| ARI-Push, 365 Tage, alle Kategorien | 300 ms | 2 |
| Nachtlauf, 200 Zimmer | 10 s | Batch, unkritisch |

Diese Zahlen sind Vorschläge und müssen an echten Daten überprüft werden. Wichtig ist, dass sie **existieren** und dass eine Überschreitung ein Fehler ist und keine Beobachtung.

## 2.9 Wie wir das absichern

Performance verfällt, wenn man sie nicht misst. Drei Mechanismen, alle automatisch:

**1. Abfragezähler im Test.** Jeder Endpunkttest zählt die ausgeführten SQL-Anweisungen und schlägt fehl, wenn die Obergrenze überschritten wird.

```
def test_zimmerplan_macht_konstant_drei_abfragen():
    with zaehle_abfragen() as z:
        client.get("/v1/properties/1/tape-chart?from=2026-10-01&to=2026-10-31")
    assert z.anzahl <= 3
```

Das ist der wirksamste einzelne Test in einem solchen System. Er fängt jedes versehentlich eingeführte N+1 ab, in dem Moment, in dem es entsteht, und nicht drei Monate später beim ersten großen Kunden.

**2. Ein Datensatz in realistischer Größe.** Ein Seed-Skript, das ein Haus mit 250 Zimmern, 15 Kategorien, drei Jahren Historie und rund 200.000 Reservierungen erzeugt. Alle Performance-Tests laufen dagegen. Mit 20 Testreservierungen ist jede Architektur schnell.

**3. Lasttest in der CI-Pipeline**, gegen das Latenzbudget aus 2.8. Bei Überschreitung bricht der Build.

Dazu im Betrieb: `pg_stat_statements` für die teuersten Abfragen, ein Log für jede Abfrage über 50 ms, und OpenTelemetry-Traces, damit man bei einer langsamen Anfrage sieht, welche der drei Abfragen es war.

## 2.10 Zusammenfassung als Regelsatz

1. Der Anwendungsserver steht neben der Datenbank, nicht der Client. Der Client macht eine teure Runde, der Server viele billige.
2. Verbindungen kommen aus einem Pool und werden nie pro Anfrage aufgebaut.
3. Die Anzahl der Datenbankabfragen pro Endpunkt ist konstant und wächst nicht mit der Datenmenge.
4. Lazy Loading ist abgeschaltet und wirft einen Fehler.
5. Endpunkte werden für Bildschirme entworfen, nicht für Tabellen.
6. Verfügbarkeit ist eine transaktional gepflegte Zählertabelle, keine Aggregation über Reservierungen.
7. Bestandsänderungen prüfen und schreiben in einer Anweisung.
8. Abgeleitete Daten, die korrekt sein müssen, liegen transaktional in der Datenbank, nicht in einem externen Cache.
9. Alles, was nicht die Antwort blockiert, läuft asynchron.
10. Jeder Endpunkt hat ein Latenzbudget und einen Test auf die Abfragezahl.

---

## Was daraus für die Roadmap folgt

Die Punkte 1, 2, 4, 6, 7 und 10 sind **Architekturentscheidungen, die am Anfang nichts kosten und später kaum nachrüstbar sind.** Besonders die Zählertabelle für die Verfügbarkeit: wer erst mit Aggregation über Reservierungen startet, baut das halbe System darum herum und muss es später mit Migration der Bestandsdaten austauschen.

Die Punkte 3, 5, 8 und 9 sind laufende Disziplin und werden durch den Abfragezähler-Test aus 2.9 erzwungen. Dieser Test sollte zu den ersten Dingen gehören, die im Projekt existieren, noch vor dem ersten echten Endpunkt.
