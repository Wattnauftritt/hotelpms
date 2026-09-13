# Technologie und Hosting

Antwort auf die offene Frage 3 aus [02-planungsgrundlage.md](02-planungsgrundlage.md): praktikabel, performant, kostenbewusst. Die Sorge war, dass Selbsthosting entweder zu langsam wird oder unbezahlbare Hardware mit Loadbalancer braucht, während gehostete Datenbanken zu teuer sind.

**Kurzantwort: Die Sorge ist bei diesem Workload unbegründet. Ein PMS ist für heutige Hardware eine sehr kleine Anwendung. Der teuerste Fehler wäre nicht zu schwache Hardware, sondern eine verteilte Architektur, die Netzwerkrunden erzeugt.**

---

## 1. Wie groß ist die Last wirklich?

Bevor man über Hardware redet, sollte man rechnen. Nehmen wir ein erfolgreiches Jahr drei:

| Kennzahl | Annahme |
|---|---|
| Betriebe | 500 |
| Zimmer im Schnitt | 40 |
| Zimmer gesamt | 20.000 |
| Reservierungen pro Jahr | etwa 1,5 Millionen |
| Gleichzeitig aktive Nutzer, Tagesspitze | 300 bis 600 |
| Schreibvorgänge pro Sekunde, Spitze | etwa 20 bis 50 |
| Leseanfragen pro Sekunde, Spitze | etwa 200 bis 500 |

**Das ist für PostgreSQL nichts.** Ein einzelner moderner Server verarbeitet fünf- bis zehntausend einfache Transaktionen pro Sekunde. Wir liegen zwei Größenordnungen darunter.

Auch die Datenmenge ist klein. 1,5 Millionen Reservierungen mit allen Nächten, Folios, Charges und Audit-Log liegen bei grob 20 bis 50 GB pro Jahr. Das passt vollständig in den Arbeitsspeicher eines Servers für unter 100 Euro im Monat, und eine Datenbank, die im RAM liegt, ist konkurrenzlos schnell.

**Ein PMS ist kein Skalierungsproblem. Es ist ein Latenzproblem.** Genau das ist die Aussage von [04-api-first-und-performance.md](04-api-first-und-performance.md).

---

## 2. Warum gehostete Serverless-Datenbanken hier die falsche Wahl sind

Das ist der wichtigste Punkt, und er ist nicht in erster Linie eine Kostenfrage.

Cloudflare D1, Neon, PlanetScale und ähnliche Dienste trennen Rechenleistung und Speicher über das Netzwerk. Genau dadurch bekommen sie ihre Elastizität. Der Preis dafür ist **Latenz pro Abfrage**, und zwar strukturell, nicht durch schlechte Konfiguration.

| Aufbau | Round Trip zur Datenbank |
|---|---|
| Postgres auf demselben Host, Unix-Socket | 0,05 bis 0,2 ms |
| Postgres im selben Rechenzentrum | 0,3 bis 1 ms |
| Serverless-Datenbank über HTTP, gleiche Region | 5 bis 25 ms |
| Serverless-Datenbank, andere Region | 30 bis 100 ms |

**Das ist exakt das Problem, das wir bei KWHotel diagnostiziert haben, nur an anderer Stelle.** Wenn der Zimmerplan drei Abfragen macht, kostet das bei 0,3 ms zusammen eine Millisekunde und bei 20 ms sechzig Millisekunden. Und beim Buchungsvorgang, der in einer Transaktion mehrere Anweisungen braucht, wird es schlimmer, weil eine offene Transaktion über HTTP die Verbindung blockiert.

Dazu kommt: **die Zählertabelle `inventory_day` mit Zeilensperren, auf der unsere gesamte Verfügbarkeitslogik beruht, braucht echte Transaktionen mit `SELECT FOR UPDATE` und Isolationsgarantien.** Serverless-Datenbanken mit HTTP-Protokoll können das nur eingeschränkt oder mit erheblichen Einschränkungen.

**Fazit: kein Serverless. Klassisches PostgreSQL, so nah wie möglich am Anwendungsserver.** Der Kostenvorteil kommt dabei obendrauf, ist aber nicht der Hauptgrund.

---

## 3. Empfohlener Aufbau

```
                         Internet
                            │
                   ┌────────┴────────┐
                   │   Loadbalancer   │   Hetzner Cloud LB, ca. 6 €/Monat
                   └────────┬────────┘
              ┌─────────────┴─────────────┐
              ▼                           ▼
   ┌────────────────────┐      ┌────────────────────┐
   │  Server 1          │      │  Server 2          │
   │  ├─ App-Instanzen  │      │  ├─ App-Instanzen  │
   │  ├─ PgBouncer      │      │  ├─ PgBouncer      │
   │  └─ PostgreSQL     │◄────►│  └─ PostgreSQL     │
   │     (primär)       │ Repl.│     (Replikat)     │
   └────────────────────┘      └────────────────────┘
              │                           │
              └──────────┬────────────────┘
                         ▼
              ┌────────────────────┐
              │  Objektspeicher    │  Backups, PDFs, Belege
              └────────────────────┘
```

**Der entscheidende Punkt: Anwendung und Datenbank laufen auf derselben Maschine.** Damit ist der Round Trip ein Unix-Socket und kostet 0,1 Millisekunden. Das ist die billigste Performance-Optimierung, die es gibt, und sie kostet nichts außer der Entscheidung.

Das Replikat auf Server 2 dient zwei Zwecken: Ausfallsicherheit und Leselast für Berichte und Exporte, die den Primärserver nicht stören sollen.

### Kosten

| Position | Monatlich |
|---|---|
| 2 × dedizierter Server (etwa Hetzner AX-Linie, 64 GB RAM, NVMe) | 160 bis 200 € |
| Loadbalancer | 6 € |
| Objektspeicher und Backup-Ziel | 10 bis 20 € |
| Monitoring, Logs, Fehlertracking | 0 bis 50 € |
| **Summe** | **etwa 200 bis 280 €** |

Zur Einordnung: Bei 500 Betrieben mit 20.000 Zimmern und 8 Euro je Zimmer liegt der Monatsumsatz bei etwa 160.000 Euro. **Die Infrastruktur ist damit weit unter einem Prozent des Umsatzes.** Selbst bei 20 Betrieben in der Anfangsphase, also rund 6.000 Euro Umsatz, sind 250 Euro Infrastruktur unkritisch.

Zum Vergleich: Ein gleichwertiger Aufbau mit verwalteter Datenbank und Anwendungshosting bei einem der großen Cloud-Anbieter liegt bei 800 bis 2.500 Euro monatlich, bei schlechterer Latenz.

**Die Sorge vor unbezahlbarer Hardware ist damit erledigt. Der reale Kostenblock in diesem Projekt sind Personal und die ISO-27001-Zertifizierung, nicht Server.**

### Serverstandort

**Deutschland.** Nicht aus technischen Gründen, sondern aus Vertriebsgründen. „Daten in Deutschland" ist bei dieser Zielgruppe ein Kaufargument, und SoftTec wirbt genau damit. Hetzner in Nürnberg oder Falkenstein erfüllt das und ist zugleich der günstigste Anbieter im Markt.

### Wann brauchen wir mehr?

Erst wenn ein einzelner Server nicht mehr reicht, und das ist weit weg. Der Weg dahin, in dieser Reihenfolge:

1. Größerer Server. Von 64 auf 256 GB RAM ist ein Preissprung von etwa 100 Euro, keine Architekturänderung.
2. Leseanfragen auf das Replikat verlagern.
3. Mehr Anwendungsserver hinter den Loadbalancer, Datenbank bleibt eine.
4. Erst ganz zuletzt: Mandanten auf mehrere Datenbanken aufteilen (Sharding nach `property_id`).

**Schritt 4 kommt realistisch nie.** Aber weil jede Tabelle ohnehin `property_id` trägt, ist der Weg offen, falls doch.

---

## 4. Sprache und Framework

Ehrliche Einordnung vorab: **Die Sprachwahl ist für die Performance dieses Systems zweitrangig.** Die Antwortzeit wird von Datenbankrunden bestimmt, nicht von Rechenzeit. Der Unterschied zwischen einer schnellen und einer langsamen Sprache liegt hier bei wenigen Millisekunden, während ein einziges übersehenes N+1-Problem hunderte kostet. Die Regeln aus [04-api-first-und-performance.md](04-api-first-und-performance.md) sind um Größenordnungen wichtiger als die Sprache.

Deshalb sollte die Wahl nach Entwicklungsgeschwindigkeit und Wartbarkeit fallen.

| Option | Für | Gegen |
|---|---|---|
| **TypeScript** (Node oder Bun) | Eine Sprache für Backend und Oberfläche. Typen aus der OpenAPI-Spezifikation auf beiden Seiten, dadurch keine Vertragsbrüche. Größtes Ökosystem. Einfachste Personalsuche | Höherer Speicherverbrauch als Go. Sorgfalt nötig bei Geldbeträgen und Datumslogik |
| **Go** | Sehr geringer Speicher- und CPU-Bedarf, schnelle Startzeit, robuste Nebenläufigkeit | Zweite Sprache neben dem Frontend. Mehr Schreibarbeit. Kleineres Ökosystem für Hotelthemen |
| **C# / .NET** | Sehr gute Performance, exzellente Werkzeuge, stark im deutschen Mittelstand | Zweite Sprache. Entity Framework verführt zu genau den N+1-Mustern, die wir vermeiden wollen |
| **Python / Django** | Schnellste Entwicklung am Anfang | Langsamste Option, und Djangos ORM macht Lazy Loading zum Standardverhalten. Für unsere Performanceziele die schlechteste Wahl |

**Empfehlung: TypeScript für Backend und Oberfläche, PostgreSQL als Datenbank.**

Begründung: Bei einem kleinen Team ist eine gemeinsame Sprache mit gemeinsamen Typen der größte Produktivitätshebel. Der Performance-Nachteil gegenüber Go ist bei diesem Workload nicht messbar, solange die Architekturregeln eingehalten werden. Und die eingesparte Zeit fließt in Funktionen, mit denen wir gegen SoftTec und Mews antreten müssen.

### Bindende Randbedingungen, unabhängig von der Sprache

- **Kein schwergewichtiges ORM mit Lazy Loading.** Ein schlanker Query Builder mit Typsicherheit, für die heißen Pfade handgeschriebenes SQL. Konkret in TypeScript: Drizzle oder Kysely, nicht TypeORM.
- **Geldbeträge als ganze Zahlen in Cent**, nie als Fließkommazahl.
- **Aufenthaltsdaten als Kalenderdatum** in der Zeitzone der Property, Zeitstempel getrennt davon in UTC.
- **Migrationen versioniert und vorwärtsgerichtet**, keine automatische Schema-Synchronisierung.
- **Der Abfragezähler-Test aus Abschnitt 2.9 von Dokument 04 existiert, bevor der erste echte Endpunkt existiert.**

---

## 5. Was jetzt zu tun ist

1. Zwei Server bei Hetzner nehmen, PostgreSQL und Anwendung auf derselben Maschine, Replikation einrichten.
2. Die OpenAPI-Spezifikation für die Kernressourcen schreiben, bevor Code entsteht.
3. Das Seed-Skript für realistische Datenmengen bauen: 250 Zimmer, 15 Kategorien, drei Jahre Historie, 200.000 Reservierungen.
4. Den Abfragezähler-Test und das Latenzbudget als CI-Schritt aufsetzen.
5. Erst dann den ersten Endpunkt bauen.

Punkt 3 und 4 vor Punkt 5 ist unbequem und der einzige Weg, wie Performance dauerhaft erhalten bleibt.
