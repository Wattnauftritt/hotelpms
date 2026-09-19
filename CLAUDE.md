# Arbeiten in diesem Repository

Hotel-Property-Management-System. Deutsches Recht ist Kern, nicht Lokalisierung.

**Zum Einlesen:** [`docs/18-einarbeitung.md`](docs/18-einarbeitung.md) sagt in zwanzig Minuten, was das System tut, wo es das tut und warum. Wer die Oberfläche anfasst, liest danach [`docs/19-frontend.md`](docs/19-frontend.md) und [`docs/20-arbeitsteilung.md`](docs/20-arbeitsteilung.md).

**Wer die Produktivmaschine aufsetzt:** [`docs/23-erstinbetriebnahme-checkliste.md`](docs/23-erstinbetriebnahme-checkliste.md) gibt die Reihenfolge fürs erste Mal, [`docs/21-inbetriebnahme.md`](docs/21-inbetriebnahme.md) die Begründungen dahinter.

**Vor jeder Änderung:** [`docs/16-arbeitsstand.md`](docs/16-arbeitsstand.md) sagt, was fertig ist und welche Aufgaben offen und abgegrenzt sind. Die Begründungen hinter dem Entwurf stehen in `docs/01` bis `docs/15`; sie sind keine Ziererei, sondern der Grund, warum Dinge so und nicht anders gebaut sind.

---

## Aufsetzen

In einer Sitzung von Claude Code im Web geschieht das automatisch: `.claude/hooks/session-start.sh` installiert die Abhängigkeiten, startet PostgreSQL, legt Rollen und Datenbanken an und baut das Schema auf. Von Hand:

```bash
pnpm install
./scripts/setup-db.sh         # PostgreSQL, drei Rollen, zwei Datenbanken
cp .env.example .env
pnpm db:reset                 # Schema neu aufbauen
pnpm db:seed                  # optional: 4 Häuser, 1000 Zimmer, 3 Jahre — zum **Messen**
pnpm db:testhotel             # optional: ein benutzbares Haus — zum **Ausprobieren**
```

Die beiden Datensätze haben verschiedene Zwecke und sind nicht austauschbar. `db:seed` erzeugt 180 000 Reservierungen, damit sich zeigt, ob ein Index greift; überblicken kann man das nicht. `db:testhotel` legt **ein** Haus mit 24 Zimmern und rund vierzig Reservierungen um den heutigen Tag an, in dem ein Mensch jede Zeile nachrechnet. Es ist ein **Übungshaus** (`is_training`), exportiert also nichts nach draußen und verschickt keine Gastpost — ein Testhaus ohne dieses Kennzeichen schiebt früher oder später eine Übungsrechnung in die echte Buchhaltung.

**Ausprobieren.** Das Testhotel ist Datenbankinhalt, kein laufender Dienst — es sichtbar zu machen, braucht zwei Prozesse:

```bash
TESTHOTEL_PASSWORD='…' pnpm db:testhotel   # Haus anlegen, Kennwort selbst setzen
pnpm dev:api                               # Terminal 1: API auf :3000
pnpm dev:web                               # Terminal 2: Oberfläche auf :5173
```

Dann `http://localhost:5173` öffnen und mit `test@hotelpms.local` und dem gesetzten Kennwort anmelden. Vite reicht `/v1` an die API weiter; im Betrieb tut das Caddy unter **einer** Herkunft, damit die Sitzung im Cookie ohne Sonderregeln funktioniert.

Ohne `TESTHOTEL_PASSWORD` erzeugt das Skript eines und gibt es **einmal** aus — fest im Skript wäre es in jedem Klon dasselbe, und dieses Haus steht am Ende auf einer Maschine, die aus dem Netz erreichbar ist.

Die Tests brauchen ein **echtes PostgreSQL** (17 in CI, 16 genügt lokal) mit den Erweiterungen `pg_trgm` und `pgcrypto` sowie drei Rollen. `.github/workflows/ci.yml` zeigt dasselbe für CI.

```bash
pnpm typecheck      # tsc -b über alle Pakete
pnpm lint           # eslint, setzt auch die Modulgrenzen durch
pnpm test           # vitest, gegen echtes PostgreSQL
pnpm build          # alle Pakete und beide Apps
```

Alle vier müssen grün sein, bevor etwas gepusht wird. `pnpm test` läuft in **einem** Prozess gegen **eine** Datenbank; Tests dürfen deshalb nicht davon ausgehen, dass sie allein sind, und räumen über `truncateAll()` auf.

---

## Struktur

```
apps/api        Fastify. Routen, Berechtigungen, Fehlerformat
apps/worker     Nachtlauf und Pflegejobs
apps/web        Rezeptions-Oberfläche, React und Vite
packages/db     Migrationen, Verbindungen, Transaktionskontext
packages/domain Fachlogik ohne HTTP und ohne Framework
packages/contracts  Geteilte Schemata, OpenAPI-Erzeugung
packages/testing    Fixtures, Abfragezähler
```

Richtung der Abhängigkeiten: `apps → packages`, niemals rückwärts, niemals quer zwischen Apps. ESLint setzt das durch.

---

## Regeln, die nicht verhandelbar sind

Jede einzelne steht hier, weil ihr Bruch still passiert und teuer auffällt.

### Mandantentrennung

- **Jede Anfrage läuft in einer Transaktion.** Der Mandantenkontext wird transaktionslokal gesetzt (`set_config(..., true)`); ohne Transaktion greift die Zeilenrichtlinie nicht. In Routen immer `tx(req.pool, req, ...)`, nie `req.pool.query` für Fachdaten.
- **Der Kontext kommt aus dem Token, nie aus Pfad, Query oder Rumpf.** Eine Route darf eine Property-ID entgegennehmen, muss sie aber gegen den Kontext prüfen. `registerRoute` tut das über `propertyParam`.
- **Bei mehreren Häusern im Account reicht die Zeilenrichtlinie nicht.** Sie filtert nach Mandant, nicht nach Haus. Wer eine Kategorie, ein Zimmer oder einen Ratenplan entgegennimmt, prüft zusätzlich `property_id`.
- **Nie ohne Kontext aus einer Tabelle mit Zeilenrichtlinie lesen.** Das ist hier zweimal passiert und beide Male still: einmal sah der Benutzer seine eigenen Häuser nicht, einmal wirkte eine Account-Rolle auf gar kein Haus (Migrationen 0014, 0018).

### Unveränderlichkeit

- `charge`, `settlement`, `invoice` und `audit_log` sind Härtegrad 1. Die Anwendungsrolle hat darauf **kein** `UPDATE` und **kein** `DELETE`. Eine Korrektur ist eine Gegenbuchung, nie eine Änderung.
- Die einzige Ausnahme ist `charge.invoice_id` und `settlement.invoice_id`, und nur der Übergang von `NULL` auf einen Wert (Migration 0012).
- `inventory_day` wird ausschließlich über die SQL-Funktionen verändert. Die Anwendungsrolle darf lesen, nicht schreiben.

### Ratenbegrenzung

- **Die Ratenbegrenzung greift nur bei anonymen Anfragen** (`platform/rateLimit.ts`). Das ist Absicht: eine Rezeption im Andrang zu bremsen ist Schaden ohne Gegenwert, und Missbrauch durch einen Angemeldeten ist ein Rollenproblem.
- **Deshalb bringt jede empfindliche Handlung hinter einer Sitzung ihren eigenen Zähler mit.** Wer ein Geheimnis prüft — einen PIN, ein Kennwort, ein Token — und die Anfrage trägt schon ein gültiges Sitzungscookie, den erreicht die allgemeine Grenze **nicht**. Genau das ist einmal passiert: `workstation-switch` stand auf der strengen Liste und wurde von ihr nie erreicht, weil die Anfrage angemeldet war — ein vierstelliger PIN ließ sich in Sekunden durchprobieren. Behoben mit einem eigenen Zähler an der Route; die Ausnahme selbst ist strukturell und bleibt (H4, Dokument 25).

### Datenschutz und deutsches Recht

- **Nie Kartendaten speichern.** Es gibt kein Feld dafür, und es kommt keines dazu. Eine Garantie läuft über Pay-by-Link oder das virtuelle Terminal des Zahlungsdienstleisters.
- **Nie eine Ausweiskopie speichern.** § 30 BMG erlaubt die Nummer und verbietet die Kopie. Es gibt kein Feld für einen Upload.
- **Seit dem 1.1.2025 unterschreiben nur noch ausländische Gäste den Meldeschein.** Für inländische wird eine mitgeschickte Unterschrift verworfen, nicht gespeichert.
- **Löschen heißt anonymisieren.** Buchungsbelege unterliegen der achtjährigen Aufbewahrungsfrist.
- **Keine Gastdaten in Protokollen.** `pino` ist entsprechend eingerichtet; wer ein Feld hinzufügt, prüft die Redaktionsliste. Die Liste deckt Felder ab, **nicht die Adresse**: ein Suchbegriff in der Abfragezeichenfolge ist ein Gastname und gehört nicht ins Protokoll. Deshalb filtert der `req`-Serialisierer in `platform/app.ts` die Abfrage gegen eine Positivliste; wer einen neuen harmlosen Parameter protokolliert haben will, trägt ihn dort ein (Befund B2, Dokument 25).
- **Keine Kassenfunktion.** Kein Kassenbestand, keine TSE, kein Bon. Das ist eine Produktentscheidung (Dokument 09), keine Lücke.
- **Ein Schulungshaus exportiert nicht nach draußen.** `is_training` weist DATEV-, GoBD- und Statistikexport hart ab. Eine Warnung wird geklickt; ein Stapel aus Übungsdaten in der echten Buchhaltung ist schwerer zu entfernen als zu verhindern.

### Leistung

- **Ein Aufruf je Bildschirm, nicht je Zeile.** Die Endpunkte sind Aggregate. Wer sie im Frontend wieder auflöst und je Zeile nachlädt, macht aus einer Runde vierhundert.
- **Keine korrelierte Unterabfrage je Zeile.** Ein `SELECT ... OFFSET (i % n) LIMIT 1` in einer Schleife über 200 000 Zeilen läuft nicht zu Ende. Verbund statt Schleife.
- **Jeder Zeitraumparameter hat eine Obergrenze.** Ohne sie ist jeder Endpunkt ein Selbstangriff.
- **Trigger auf Anweisungsebene, wo eine Massenänderung vorkommt.** Ein Trigger je Zeile, der die ganze Property neu rechnet, ist quadratisch (Migration 0013).
- **Zähler und Aufzeichnung nicht verwechseln.** `inventory_day.sold` sagt, was gerade gebunden ist; `business_day_stat` sagt, wie es war. Wer das eine für das andere nimmt, bekommt keine Fehlermeldung, sondern eine plausibel aussehende falsche Zahl (Migration 0014).

### Geld und Datum

- Geld ist **immer** eine ganze Zahl in Cent. Nie Fließkomma.
- Steuer wird **je Satzgruppe aus der Nettosumme** gerechnet, nicht als Summe je Zeile gerundeter Beträge.
- Aufenthaltsdaten sind **Kalenderdaten**, keine Zeitpunkte. Nie durch `new Date(iso)` in Ortszeit schicken; das verschiebt sie je nach Zeitzone um einen Tag.
- Fristen werden gegen den **Geschäftstag** geprüft, nicht gegen `now()`. Sonst findet ein Wiederholungslauf andere Zeilen als der erste.

---

## Konventionen

**Sprache.** Code-Bezeichner englisch, Kommentare und Dokumentation deutsch. Kommentare erklären **warum**, nicht was: „senkt die Kapazität" ist wertlos, „senkt die Kapazität, weil Out of Order nicht verkäuflich ist, Out of Service schon" ist der Punkt. Umlaute in SQL-Kommentaren und Bezeichnern vermeiden.

**Neue Route.** Immer über `registerRoute`. Die Berechtigung ist ein Pflichtfeld; es gibt keinen anderen Weg, eine Route anzulegen, und ein Test läuft über die gesamte Routenliste. `permission: null` bedeutet ausdrücklich öffentlich und will begründet sein.

**Neue Meldung.** Jeder Satz, den ein Mensch zu sehen bekommt, ist ein
Schlüssel, kein Text im Code. Fehlermeldungen und Hinweise der Schnittstelle
stehen in [`packages/contracts/src/messages.ts`](packages/contracts/src/messages.ts),
Beschriftungen der Oberfläche in `apps/web/src/lib/i18n/`, eine Datei je
Bereich. In beiden stehen die Sprachen **je Schlüssel nebeneinander**, nicht
in getrennten Blöcken; jede Datei trägt `satisfies Record<string,
LocalizedText>`, und eine vergessene Sprache ist damit ein Typfehler an
genau dem Schlüssel. Die API antwortet **deutsch** und legt den Schlüssel
daneben — ein Protokoll soll ohne Katalog lesbar bleiben, die Rezeption den
Satz in ihrer Sprache sehen.

Angeboten wird eine Sprache erst, wenn sie **vollständig** ist: `LOCALES` in
`messages.ts` ist die Zusage, und halb übersetzt anzubieten hieße, dem
Benutzer die Hälfte in einer Sprache zu zeigen, die er nicht gewählt hat.
Deutsche Rechtsbegriffe bleiben dabei stehen — `Meldeschein`, `GoBD`,
`DATEV`, `USt-IdNr.`, `§ 30 BMG` sind Namen, keine beschreibenden Wörter:
wer den Bildschirm dem Papier zuordnen soll, das vor ihm liegt, braucht
dasselbe Wort auf beiden.

Werte kommen als Platzhalter (`{max}`), nie durch Zusammensetzen: „Die Gruppe
hat noch " + n + " Reservierungen" ergibt in jeder Sprache mit anderer
Wortstellung Unsinn. Zwei Tests halten das fest —
`apps/api/src/__tests__/meldungen.test.ts` liest die Quelle und findet jeden
deutschen Satz, der noch in einem `Errors.*`-Aufruf steht;
`apps/web/src/__tests__/i18n.test.ts` prüft den Katalog der Oberfläche.

**Betriebsdateien.** Was auf der Maschine läuft, steht in `ops/` und wird in der Dokumentation **verwiesen, nicht abgeschrieben**. Zwei Fassungen derselben Datei laufen auseinander, und beide sehen für sich stimmig aus: `ops/` sagte `/opt/hotelpms`, Dokument 21 sagte `/srv/hotelpms`, und aufgefallen ist es erst beim Aufsetzen der echten Maschine.

Jede Zeile darin gehört an einem echten System nachgerechnet, bevor sie eingecheckt wird. Bei Code fängt der Test den Irrtum; bei einem Runbook gibt es keinen. Bisher gefunden: eine systemd-Unit, die Node nie hätte starten können (`MemoryDenyWriteExecute`), ein Caddyfile, den der Lexer abweist (`match { … }` einzeilig — `scripts/check-caddyfile.sh` prüft das jetzt in CI), und ein `blkdiscard`, das den ganzen Host verworfen hätte.

**Neue Migration.** Fortlaufend nummeriert, nie eine bestehende ändern. Der Kopfkommentar nennt den Befund oder die Anforderung, die sie auslöst.

Arbeiten mehrere parallel, ist die Nummer die einzige Stelle, an der sie sich zuverlässig in die Quere kommen: zwei Zweige von `main` legen beide `0020_` an, und beim Mergen fällt das nicht auf, weil es verschiedene Dateien ohne Konflikt sind. Auffallen würde es erst beim nächsten frischen Schemaaufbau, als Fehler, dessen Ursache Tage zurückliegt. `scripts/check-migrations.sh` prüft das in CI. Wer die Meldung sieht, benennt die spätere um; zwischen unabhängigen Migrationen ist die Reihenfolge ohnehin beliebig.

**Neuer Test.** Gegen echtes PostgreSQL, keine Mocks: eine gemockte Datenbank prüft weder Zeilenrichtlinien noch Trigger noch Sperren, und genau dort liegt die Fachlichkeit. Getestet wird Verhalten, nicht Darstellung.

**Commits.** Deutsch, erste Zeile eine Aussage, danach der Grund. Was gefunden und mitbehoben wurde, gehört hinein.

---

## Wenn etwas nicht läuft

| Symptom | Ursache |
|---|---|
| Tests: `connect ECONNREFUSED 127.0.0.1:5432` | PostgreSQL läuft nicht, `scripts/setup-db.sh` |
| `permission denied for table charge` | Richtig so. Härtegrad 1, Korrektur als Gegenbuchung |
| Abfrage liefert nichts, obwohl Daten da sind | Kein Mandantenkontext. Läuft die Abfrage in `tx(...)`? |
| `not_materialized` bei einer Buchung | `inventory_day` fehlt für den Zeitraum, `inventory_materialize` |
| `inconsistent types deduced for parameter $n` | Derselbe Parameter in zwei Typen benutzt. Explizit casten oder zweimal übergeben |
| Tests bekommen unerwartet `429` | Die Ratenbegrenzung. Wer viele Anmeldungen erzeugt, ruft `limiters.reset()` im `beforeEach` |
