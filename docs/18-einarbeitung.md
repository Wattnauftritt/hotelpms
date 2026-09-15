# Einarbeitung

Für jemanden, der dieses Repository zum ersten Mal öffnet. Nach diesem Dokument weißt du, **was** das System tut, **wo** es das tut und **warum** es an den entscheidenden Stellen so und nicht anders gebaut ist.

Lesezeit etwa zwanzig Minuten. Es ersetzt nicht [`CLAUDE.md`](../CLAUDE.md) — das sind die Regeln, die beim Schreiben von Code gelten — sondern führt dorthin hin.

---

## 1. Was das System ist

Ein **Property-Management-System für Hotels**: die Software, mit der eine Rezeption arbeitet. Sie hält Zimmer und Verfügbarkeit, nimmt Reservierungen an, checkt Gäste ein und aus, führt das Gastkonto, schreibt Rechnungen, rechnet nachts den Tag ab und meldet an Behörden.

Der Markt ist Deutschland, und das ist keine Lokalisierung, sondern die Bauart. Drei Beispiele, die das ganze Modell prägen:

- **Eine festgeschriebene Rechnung ist unveränderlich** (GoBD). Eine Korrektur ist eine Gegenbuchung, nie eine Änderung. Das ist der Grund, warum `charge`, `settlement`, `invoice` und `audit_log` kein `UPDATE` und kein `DELETE` für die Anwendungsrolle haben — nicht als Vorsichtsmaßnahme, sondern weil die Datenbank die Regel durchsetzen soll und nicht der Programmierer.
- **Der Meldeschein** (§§ 29, 30 BMG) verlangt Daten, die seit dem 1.1.2025 nur noch ausländische Gäste unterschreiben, erlaubt die Ausweis**nummer** und verbietet die Ausweis**kopie**. Deshalb gibt es ein verschlüsseltes Nummernfeld und bewusst kein Feld für einen Datei-Upload.
- **Löschen heißt anonymisieren**, weil Buchungsbelege acht Jahre aufbewahrt werden müssen. Ein `DELETE` auf einen Gast wäre gleichzeitig ein Datenschutzverstoß in die eine und ein Aufbewahrungsverstoß in die andere Richtung.

Was das System bewusst **nicht** tut: kassieren. Keine Kassenlade, keine TSE, kein Bon. Ein Zimmerbon verschiebt die Abrechnung auf den Check-out, er wickelt sie nicht ab. Nähme das PMS Bargeld entgegen, wäre es das kassierende System mit allen Folgen aus § 146a AO. Die Begründung steht in [`09-kassenbuch.md`](09-kassenbuch.md).

---

## 2. Der Aufbau in einem Bild

```
                    ┌────────────────┐
  Rezeption ───────▶│  apps/web      │  React, Vite, TanStack Query
                    └───────┬────────┘
                            │ HTTP, Cookie-Sitzung
                    ┌───────▼────────┐
  Channel Manager ─▶│  apps/api      │  Fastify. Routen, Rechte, Fehlerformat
  Kasse, Portale    └───────┬────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
  ┌──────▼──────┐   ┌───────▼───────┐  ┌───────▼────────┐
  │ packages/   │   │ packages/db   │  │ packages/      │
  │ domain      │   │ Migrationen,  │  │ contracts      │
  │ Fachlogik   │   │ Transaktions- │  │ Schemata,      │
  │ ohne HTTP   │   │ kontext       │  │ OpenAPI        │
  └─────────────┘   └───────┬───────┘  └────────────────┘
                            │
                    ┌───────▼────────┐        ┌──────────────┐
                    │  PostgreSQL    │◀───────│ apps/worker  │
                    │  RLS, Trigger, │        │ Nachtlauf,   │
                    │  SQL-Funktionen│        │ Belege, Post │
                    └────────────────┘        └──────────────┘
```

Die Abhängigkeiten laufen **immer** `apps → packages`, nie rückwärts und nie quer zwischen Apps. ESLint setzt das durch; wer es versucht, bekommt einen Lint-Fehler statt eines Merges.

Warum das streng ist: `packages/domain` enthält die Fachlogik — Zustandsautomat der Reservierung, Steuerrechnung, Rechnungsregeln nach EN 16931 — und die muss ohne HTTP und ohne Framework testbar sein. Sobald dort ein `FastifyRequest` auftaucht, ist sie es nicht mehr.

---

## 3. Die vier Ideen, ohne die nichts zusammenpasst

Wer diese vier versteht, versteht neunzig Prozent der Entscheidungen im Code.

### 3.1 Mandantentrennung liegt in der Datenbank, nicht im Code

Jede Fachtabelle hat eine Zeilenrichtlinie (`ROW LEVEL SECURITY ... FORCE`). Der Mandantenkontext wird **transaktionslokal** gesetzt:

```sql
set_config('app.property_ids', '{1,2}', true)   -- true = nur in dieser Transaktion
```

Daraus folgt die wichtigste Regel des Repositories: **jede Anfrage läuft in einer Transaktion.** Ohne sie greift die Richtlinie nicht. In Routen also immer `tx(req.pool, req, ...)` und nie `req.pool.query` für Fachdaten.

Der Gewinn: eine vergessene `WHERE property_id = ...` ist kein Datenleck. Ein Test belegt das — er lässt die Bedingung absichtlich weg und prüft, dass trotzdem nichts Fremdes kommt.

Die Falle, die zweimal zugeschlagen hat: **ohne Kontext lesen liefert leise nichts.** Einmal sah ein Benutzer seine eigenen Häuser nicht, einmal wirkte eine Account-Rolle auf gar kein Haus. Beides ohne Fehlermeldung. Wenn eine Abfrage nichts liefert, obwohl Daten da sind, ist das die erste Frage: läuft sie in `tx(...)`?

### 3.2 Zähler und Aufzeichnung sind nicht dasselbe

`inventory_day.sold` sagt, **was gerade gebunden ist**. `business_day_stat` sagt, **wie es war**.

Wer das eine für das andere nimmt, bekommt keine Fehlermeldung, sondern eine plausibel aussehende falsche Zahl. Genau das ist passiert: die Auslastung der Vergangenheit wurde mit 0,3 % statt 63 % gemeldet, weil sie aus dem Live-Zähler kam — und der ist für vergangene Tage natürlich fast leer.

Verfügbarkeit wird ausschließlich über SQL-Funktionen verändert (`inventory_reserve`, `inventory_release`, `inventory_block`, `inventory_move`). Die Anwendungsrolle darf `inventory_day` lesen, nicht schreiben. Das ist nicht Bevormundung: die Funktionen halten die Sperrreihenfolge ein und verhindern Überbuchung unter Nebenläufigkeit. 50 gleichzeitige Buchungen auf das letzte Zimmer — genau eine gewinnt, und ein Test beweist es.

### 3.3 Geld ist ganzzahlig, Datum ist ein Kalendertag

**Geld** ist immer eine ganze Zahl in Cent, nie Fließkomma. Steuer wird **je Satzgruppe aus der Nettosumme** gerechnet, nicht als Summe je Zeile gerundeter Beträge — sonst weicht die Rechnung um Cent ab, und ein Prüfer sieht das.

**Aufenthaltsdaten sind Kalenderdaten.** `new Date('2026-03-29')` ist Mitternacht UTC und in Europa/Berlin an dem Tag eine Stunde vor der Zeitumstellung. Wer damit rechnet, verschiebt eine Reservierung lautlos um einen Tag. Deshalb rechnet `packages/domain/src/dates.ts` auf Zeichenketten, und deshalb hat jede Datumsspalte in einer Abfrage ein `::text`. Genau das hat einmal gefehlt und den ganzen Zimmerplan um einen Tag verschoben — mit sichtbaren, gefärbten, plausiblen Balken am falschen Tag.

**Fristen** werden gegen den **Geschäftstag** geprüft, nicht gegen `now()`. Sonst findet ein Wiederholungslauf des Nachtlaufs andere Zeilen als der erste.

### 3.4 Ein Aufruf je Bildschirm, nicht je Zeile

Die Endpunkte sind Aggregate: der Zimmerplan kommt in **einer** Anfrage, das Tagesgeschäft in einer, der Zimmerstatus in einer. Wer das im Frontend wieder auflöst und je Zeile nachlädt, macht aus einer Runde vierhundert.

Dieselbe Regel gilt in SQL: keine korrelierte Unterabfrage je Zeile. Ein `SELECT ... OFFSET (i % n) LIMIT 1` in einer Schleife über 200 000 Zeilen läuft nicht zu Ende — das ist im Saatlauf passiert und musste abgebrochen werden.

Und: **jeder Zeitraumparameter hat eine Obergrenze.** Ohne sie ist jeder Endpunkt ein Selbstangriff.

---

## 4. Wo was liegt

| Verzeichnis | Was darin steht | Wann du hierher kommst |
|---|---|---|
| `apps/api/src/routes/` | Ein Modul je Fachbereich. Jede Route über `registerRoute` mit **Pflicht**-Berechtigung | Ein Endpunkt fehlt oder verhält sich falsch |
| `apps/api/src/platform/` | Anmeldung, Rechte, Transaktionskontext, Fehlerformat, Ratenbegrenzung, Idempotenz, Schulungsbetrieb | Etwas Querschnittliches |
| `apps/worker/src/jobs/` | Nachtlauf, Pflege, Rechnungsbelege, Webhooks, Gastpost | Etwas läuft zeitgesteuert oder im Hintergrund |
| `apps/web/src/routes/` | Ein Bildschirm je Datei | Oberfläche |
| `apps/web/src/screens.tsx` | Das Verzeichnis der Bildschirme, mit Berechtigung je Eintrag | Ein neuer Bildschirm |
| `packages/domain/src/` | Fachlogik ohne HTTP: Zustände, Geld, Datum, Raten, Rechnungsregeln, Vorlagen | Eine Regel, die API **und** Worker brauchen |
| `packages/db/migrations/` | Fortlaufend nummeriert, nie eine bestehende ändern | Schemaänderung |
| `packages/contracts/src/` | Geteilte Schemata, OpenAPI-Erzeugung | Ein Typ, den Front- und Backend teilen |
| `packages/testing/src/` | Fixtures, Schemaaufbau, `truncateAll()` | Ein Test braucht Aufbau |

### Die Migrationen als Erzählung

Sie in Reihenfolge zu überfliegen ist der schnellste Weg zum Datenmodell. Jede trägt im Kopfkommentar den Befund oder die Anforderung, die sie ausgelöst hat.

| | |
|---|---|
| `0001`–`0003` | Plattform, Mandanten, Rechte. Hier entstehen `make_append_only` und die Rollen |
| `0004`–`0006` | Zimmer, Verfügbarkeit, Einrichtung |
| `0007`–`0009` | Raten, Gäste, Buchung |
| `0010`–`0012` | Folio, Rechnung, Rechnungsverknüpfung |
| `0013`–`0015` | **Drei Leistungsbefunde**: Massenänderung, Tagesstatistik, Gastsuche. Lies [`15-messungen-aus-dem-saatlauf.md`](15-messungen-aus-dem-saatlauf.md) dazu |
| `0016`–`0019` | Kurtaxe, Leistungszeitraum, Zugriffsbereich, Aufenthaltsänderung |
| `0020`–`0023` | Webhooks, Zahlungen, Kontingentabruf, Channel-Schnittstelle |
| `0024`–`0029` | Rechnungsbeleg (ZUGFeRD), OAuth, Kasse, Anzahlungen, Gastpost |

---

## 5. Ein Vorgang von Anfang bis Ende

Am besten versteht man das System an einem Aufenthalt. Ein Gast bucht, reist an, trinkt etwas an der Bar, reist ab.

1. **Buchen.** `POST /v1/bookings` bindet zuerst das Kontingent über `inventory_reserve` und legt erst danach Buchung, Reservierung, Nächte und Folio an — alles in **einer** Transaktion. Schlägt die Bindung fehl, entsteht nichts. Eine `Idempotency-Key`-Kopfzeile ist Pflicht, damit ein wiederholter Klick keine zweite Buchung erzeugt.
2. **Bestätigen.** Optional geht eine Buchungsbestätigung per Mail hinaus — eingereiht in derselben Transaktion, zugestellt vom Worker.
3. **Anreise.** `assign-unit` weist ein Zimmer zu, `check-in` setzt den Zustand auf `InHouse`. Ob Bestand gebunden wird, entscheidet dabei der **Zustand**, nicht die Handlung (`occupiesInventory`) — sonst fehlt ein Fall, und genau das ist passiert: ein No-Show, der doch noch anreist, belegte ein Zimmer, das der Zähler als frei führte.
4. **Meldeschein.** Ausländische Gäste unterschreiben, inländische nicht mehr. Eine trotzdem mitgeschickte Unterschrift wird **verworfen**, nicht gespeichert. Nach einem Jahr vernichtet der Pflegejob den Schein.
5. **Nacht.** Der Nachtlauf bucht die Logis auf das Folio, wendet Umleitungsregeln an, wertet No-Shows aus, lässt Optionen verfallen, gibt abgelaufene Kontingente frei und **zeichnet den Tag auf**. Er entscheidet selbst, ob er fällig ist, und ist wiederholbar: zweimal für denselben Tag ergibt dasselbe Ergebnis über alle berührten Tabellen.
6. **Bar.** Die Kasse bucht über `POST .../pos/charges` auf das Zimmer. Es entsteht eine Position und **kein** Zahlungsvermerk — ein Zimmerbon ist die Verschiebung der Abrechnung, nicht ihre Abwicklung.
7. **Abreise.** `POST /v1/folios/:ref/invoice` prüft die Pflichtangaben nach § 14 UStG **vor** dem Festschreiben, zieht die Rechnungsnummer aus einer gesperrten Zählerzeile (lückenlos, auch bei zwanzig gleichzeitigen Check-outs) und schreibt fest. Danach ist nichts mehr änderbar.
8. **Beleg.** Der Worker erzeugt das PDF/A-3 mit eingebettetem CII-XML — **nach** dem Festschreiben, weil eine PDF-Erzeugung in der Zählertransaktion zwanzig Kassen anhielte.
9. **Post.** `POST /v1/invoices/:ref/send` reiht die Rechnungsmail ein. Der Worker holt sie erst, wenn der Beleg fertig ist, und hängt **die archivierten Bytes** an, nicht eine neu erzeugte Fassung.

---

## 6. Aufsetzen und loslegen

In einer Sitzung von Claude Code im Web passiert das automatisch. Von Hand:

```bash
pnpm install
./scripts/setup-db.sh         # PostgreSQL, drei Rollen, zwei Datenbanken
cp .env.example .env
pnpm db:reset                 # Schema neu aufbauen
pnpm db:seed                  # optional: 4 Häuser, 1000 Zimmer, 3 Jahre Daten
```

Die vier Tore, die **alle** grün sein müssen, bevor etwas gepusht wird:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Dazu `./scripts/check-migrations.sh`, das doppelte Migrationsnummern abfängt.

**Die Tests brauchen ein echtes PostgreSQL.** Keine Mocks — eine gemockte Datenbank prüft weder Zeilenrichtlinien noch Trigger noch Sperren, und genau dort liegt die Fachlichkeit. Sie laufen in **einem** Prozess gegen **eine** Datenbank; ein Test darf deshalb nicht annehmen, allein zu sein, und räumt über `truncateAll()` auf.

Der Saatlauf lohnt sich: mit 214 000 Reservierungen sieht man, welche Abfrage trägt und welche nicht. Die Zahlen stehen in [`15-messungen-aus-dem-saatlauf.md`](15-messungen-aus-dem-saatlauf.md).

---

## 7. Konventionen, die sofort auffallen

**Sprache.** Bezeichner englisch, Kommentare und Dokumentation deutsch. Umlaute in SQL vermeiden.

**Kommentare erklären warum, nicht was.** „Senkt die Kapazität" ist wertlos. „Senkt die Kapazität, weil Out of Order nicht verkäuflich ist, Out of Service schon" ist der Punkt. Wer das für Geschmack hält: die Hälfte der Fehler in diesem Repository entstand, weil jemand das Warum nicht kannte und eine Zeile für überflüssig hielt.

**Neue Route** immer über `registerRoute`. Die Berechtigung ist ein Pflichtfeld; ein Test läuft über die gesamte Routenliste. `permission: null` bedeutet ausdrücklich öffentlich und will begründet sein.

**Neue Migration** fortlaufend nummeriert, nie eine bestehende ändern.

**Commits** deutsch, erste Zeile eine Aussage, danach der Grund. Was nebenbei gefunden und behoben wurde, gehört hinein.

---

## 8. Was schon einmal zugeschlagen hat

Diese Liste ist die wertvollste Seite im Repository. Jeder Eintrag hat Zeit gekostet.

| Falle | Was passierte |
|---|---|
| Lesen ohne Mandantenkontext | Zweimal still kaputt: der Benutzer sah seine eigenen Häuser nicht; eine Account-Rolle wirkte auf gar kein Haus |
| Trigger je Zeile bei Massenänderung | 250 Zimmer anzulegen dauerte 28 Sekunden statt 59 Millisekunden |
| Zähler als Aufzeichnung benutzt | Die Auslastung der Vergangenheit wurde mit 0,3 statt 63 Prozent gemeldet |
| `ORDER BY similarity(...)` statt Abstandsoperator | Die Namenssuche las die ganze Tabelle: 147 statt 14 Millisekunden |
| Korrelierte Unterabfrage je Zeile | Der Saatlauf kam nicht über den Schritt hinaus |
| snake_case gelesen, camelCase geprüft | Die Anschrift verschwand lautlos, die Rechnung wurde grundlos abgewiesen |
| Frist gegen `now()` statt gegen den Geschäftstag | Ein Wiederholungslauf hätte andere Zeilen gefunden als der erste |
| Datumsspalte ohne `::text` | Der ganze Zimmerplan zeigte jede Belegung am falschen Tag — mit plausibel aussehenden Balken |
| Ratenbegrenzung prüfte, **ob** ein Cookie da ist | `hp_session=x` hob sie vollständig auf, auch auf `/auth/login` |
| Bestand am Handlungspaar statt am Zustand gebunden | Ein No-Show, der doch noch anreiste, belegte ein Zimmer, das der Zähler als frei führte |
| Testaufbau sät den Rechtekatalog aus einer festen Migration | Jedes später hinzugefügte Recht fehlte in **jedem** Test, und der Befund sah aus wie ein Fehler in der Route |
| Schlüsselzwischenspeicher nur nach Version | Bei einer Rotation hätte er Chiffrate erzeugt, die niemand mehr öffnen kann |

Sieben davon waren **stille** Fehler: keine Ausnahme, keine rote Zeile, nur eine falsche Zahl oder eine fehlende. Daher die Bauart dieses Systems — sie versucht, aus stillen Fehlern laute zu machen.

---

## 9. Wohin als Nächstes

| Frage | Dokument |
|---|---|
| Was ist fertig, was ist offen? | [`16-arbeitsstand.md`](16-arbeitsstand.md) |
| Welche Regeln gelten beim Programmieren? | [`../CLAUDE.md`](../CLAUDE.md) |
| Wie betreibe ich das System? | [`17-betrieb.md`](17-betrieb.md) |
| Wie setze ich die Maschine auf? | [`21-inbetriebnahme.md`](21-inbetriebnahme.md) |
| Wie sieht die Oberfläche aus und was fehlt ihr? | [`19-frontend.md`](19-frontend.md) |
| Woran arbeiten gerade mehrere parallel? | [`20-arbeitsteilung.md`](20-arbeitsteilung.md) |
| Warum ist das Datenmodell so? | [`10-systemarchitektur.md`](10-systemarchitektur.md), [`13-gesamtreview.md`](13-gesamtreview.md) |
| Warum keine Kasse? | [`09-kassenbuch.md`](09-kassenbuch.md) |
| Welche Rollen gibt es und warum so? | [`14-benutzerrollen.md`](14-benutzerrollen.md) |

Die Dokumente `01` bis `15` sind die Begründungen hinter dem Entwurf. Sie sind keine Zierde: sie sind der Grund, warum Dinge so und nicht anders gebaut sind, und wer eine Entscheidung umdrehen will, findet dort, was dagegen sprach.
