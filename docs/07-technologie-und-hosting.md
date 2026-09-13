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

Die Infrastruktur ist vorhanden: ein eigener **Proxmox-Host**, auf dem bereits eine VM mit Plesk für andere Projekte läuft. Das PMS bekommt eine **eigene VM ohne Plesk**.

```
                         Internet
                            │
                    ┌───────┴────────┐
                    │  Proxmox-Host  │  vorhanden
                    └───┬────────┬───┘
          ┌─────────────┘        └──────────────┐
          ▼                                     ▼
┌────────────────────┐              ┌────────────────────────┐
│  VM: Plesk         │   Firewall   │  VM: hotelpms          │
│  andere Projekte   │◀─ verweigern▶│  ├─ Caddy (TLS, Proxy) │
│  unberührt         │              │  ├─ API + Worker       │
└────────────────────┘              │  ├─ PgBouncer          │
                                    │  └─ PostgreSQL         │
                                    └───────────┬────────────┘
                                                │
                          ┌─────────────────────┴──────────────┐
                          ▼                                    ▼
              ┌────────────────────┐              ┌────────────────────┐
              │  Objektspeicher    │              │  Zweiter Standort  │
              │  PDFs, Exporte     │              │  Sicherung + später│
              └────────────────────┘              │  Replikat          │
                                                  └────────────────────┘
```

**Der entscheidende Punkt bleibt: Anwendung und Datenbank in derselben VM.** Der Round Trip ist ein Unix-Socket und kostet 0,1 Millisekunden. Das ist die billigste Performance-Optimierung, die es gibt, und sie kostet nichts außer der Entscheidung.

Die VM-Auslegung im Detail steht in Abschnitt 7 von [10-systemarchitektur.md](10-systemarchitektur.md).

### Kosten

| Position | Monatlich |
|---|---|
| PMS-VM auf dem vorhandenen Proxmox-Host | **0 €**, nur Ressourcen |
| Objektspeicher für PDFs und Exporte | 5 bis 20 € |
| **Ausgelagerte verschlüsselte Sicherung** | 10 bis 30 € |
| Monitoring, Logs, Fehlertracking | 0 bis 50 € |
| **Summe zum Start** | **etwa 15 bis 100 €** |
| Später: Replikat an einem zweiten Standort | 80 bis 120 € |

Zur Einordnung: Bei 500 Betrieben mit 20.000 Zimmern und 8 Euro je Zimmer liegt der Monatsumsatz bei etwa 160.000 Euro. Die Infrastruktur ist damit weit unter einem Prozent. Zum Vergleich kostet ein gleichwertiger Aufbau mit verwalteter Datenbank bei einem großen Cloud-Anbieter 800 bis 2.500 Euro monatlich, bei schlechterer Latenz.

**Die Sorge vor unbezahlbarer Hardware ist damit erledigt. Der reale Kostenblock sind Personal und später die ISO-27001-Zertifizierung, nicht Server.**

### Was die eigene Hardware nicht löst

Zwei Punkte, die später Geld kosten und in [12-security-und-performance-review.md](12-security-und-performance-review.md) als P4b und P4c stehen:

1. **Beide VMs teilen sich die Hardware.** Eine Lastspitze auf der Plesk-VM kann die Rezeption ausbremsen. Steuerbar über `cpuunits` und Ein-/Ausgabe-Grenzen, aber nicht beseitigt.
2. **Der Proxmox-Host ist gemeinsamer Ausfallpunkt.** Gegen Hardwaredefekt, Brand oder Diebstahl hilft nur eine Kopie außer Haus. **Das ist die Bedingung für die Aufnahme von Fremdkunden**, nicht die zweite VM.

### Serverstandort

**Deutschland**, durch die eigene Hardware ohnehin erfüllt. Das ist kein technisches, sondern ein Vertriebsargument: „Daten in Deutschland, auf eigener Hardware" ist bei dieser Zielgruppe ein Kaufargument, und SoftTec wirbt mit deutlich weniger. Für die ausgelagerte Sicherung und das spätere Replikat gilt dasselbe, also ein deutscher Anbieter.

### Wann brauchen wir mehr?

Erst wenn eine einzelne VM nicht mehr reicht, und das ist weit weg. Der Weg dahin, in dieser Reihenfolge:

1. Mehr Kerne und Speicher für die VM zuteilen. Eine Konfigurationsänderung, keine Architekturänderung.
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

1. Eigene VM auf dem Proxmox-Host anlegen, nach der Auslegung in Dokument 10. PostgreSQL und Anwendung darin, Caddy davor.
2. Die OpenAPI-Spezifikation für die Kernressourcen schreiben, bevor Code entsteht.
3. Das Seed-Skript für realistische Datenmengen bauen: 250 Zimmer, 15 Kategorien, drei Jahre Historie, 200.000 Reservierungen.
4. Den Abfragezähler-Test und das Latenzbudget als CI-Schritt aufsetzen.
5. Erst dann den ersten Endpunkt bauen.

Punkt 3 und 4 vor Punkt 5 ist unbequem und der einzige Weg, wie Performance dauerhaft erhalten bleibt.
