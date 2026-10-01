# Performance-Audit: StayGrid (`Wattnauftritt/hotelpms`)

**Ergebnis:** Es wurden keine Änderungen am Anwendungscode, an Konfigurationen oder an Migrationen vorgenommen. Der Audit erfolgte als statische Analyse von Quellcode, Migrations-Design, API-Endpunkt-Architektur, Caching-Strategie und Dokumentation des Repository-Stands auf `main` (`61616f373ca7e5183dda367a6d20df13a6d342a9`). Es wurde kein Lasttest, kein Profiling unter realen Bedingungen und kein Monitoring durchgeführt.

## Zusammenfassung

Das System zeigt ein durchdachtes Performance-Design mit Fokus auf Vermeidung häufiger Fehler:

- **Aggregate statt N+1:** Komplexe Endpunkte aggregieren Daten zu einer Antwort (Belegungsplan, Verfügbarkeit).
- **Indexierungsstrategie:** GiST-Trigramm-Index für Suche, partielle Indizes für aktive Reservierungen.
- **Trigger auf Anweisungsebene:** Verhindert quadratische Rechenzeit bei Massenänderungen.
- **SQL-Funktionen als alleiniger Schreibweg:** Erzwingt konsistente Logik.
- **Rate-Limiting mit Speicher-Cleanup:** Verhindert DoS durch Speicherlecks.
- **Seed-Daten für Messungen:** 214.000+ Reservierungen zur Validierung von Indizes.

Trotzdem gibt es mehrere Punkte, die in einer produktiven Umgebung zu Bottlenecks führen können.

---

## Befunde

| ID | Befund | Auswirkung | Bewertung |
|---|---|---:|---|
| P1 | Keine dokumentierten SLAs für API-Antwortzeiten | Keine Basis für Skalierungsentscheidungen | **Informativ** |
| P2 | PgBouncer im `transaction mode` bei mehreren API-Prozessen | Nicht genutzte Connection-Pooling-Effizienz | **Mittel** |
| P3 | In-Memory Rate-Limiter verdreifacht Schwellwerte bei 3 API-Prozessen | Bypass möglich ohne Scale-Out | **Mittel** |
| P4 | Verfügbarkeitsmaterialisierung über Nachtlauf | 24-Monats-Fenster könnte bei Spitzen leer sein | **Gering, abhängig von Betriebsplan** |
| P5 | Keine dokumentierte Connection-Pool-Größe für die API | Standardwert 10 könnte mit 250-Zimmer-Häusern eng werden | **Niedrig** |
| P6 | Worker-Prozess läuft unter `CPUQuota=150%` und `MemoryMax=4G` | Gut dimensioniert für typische Betriebe, aber hart begrenzt | **Niedrig, beobachtungsbedürftig** |
| P7 | Test-Suite läuft in einem Prozess gegen eine Datenbank | Keine Parallelisierung möglich | **Niedrig** |
| P8 | Keine dokumentierte Query-Timeouts in der Anwendung | Lange Queries können Verbindungen blockieren | **Niedrig** |
| P9 | Abfragezähler nur in Tests vorhanden | Keine Produktions-Observability für N+1 oder Querys-per-Request | **Niedrig–mittel** |

---

## P1 — Keine dokumentierten SLAs für API-Antwortzeiten

Die `docs/15-messungen-aus-dem-saatlauf.md` nennt Messungen auf einem Entwicklungsrechner mit warmem Cache, nicht unter Last:

| Abfrage | Zeit |
|---|---|
| Jahresverfügbarkeit, eine Abfrage | 4 ms |
| Verfügbarkeit alle Kategorien, 365 Tage | 17 ms |
| Belegungsplan 30 Tage, alle Zimmer | 7 ms |
| Anreiseliste eines Tages | 1 ms |
| Kennzahlen über ein Jahr, aufgezeichnet | 1 ms |
| Gästesuche über Namensteil | 14 ms |

Es gibt aber keine dokumentierte Zusage für:

- kalter vs. warmer Cache-Unterschied,
- Latenz unter Concurrency (mehrere Anfragen gleichzeitig),
- Dauerlast-Profil (Durchsatz statt Einzelanfrage),
- Antwortzeit-Perzentile (p50, p95, p99),
- Größenordnungen für große Hotels (500+ Zimmer),
- Worker-Verzögerung bei Job-Backlog.

**Empfehlung:** SLAs definieren (z. B. „p95 unter 100 ms für Standardabfragen"), mit echtem Lasttest validieren und mit Monitoring im Produktivbetrieb überwachen.

---

## P2 — PgBouncer im `transaction mode` bei mehreren API-Prozessen

Die Dokumentation erwähnt `database/src` mit PgBouncer im `transaction mode`, der Datenbankverbindungen nach jeder Transaktion zurückgibt.

Bei mehreren API-Prozessen (z. B. 3) ist die effektive Größe des Connection-Pools aber **nicht** additiv: Jeder Prozess nutzt seinen eigenen Pool aus dem gemeinsamen Bouncer-Pool. Das führt zu Contention bei gleichzeitigen Anfragen.

**Aktuell vermutete Konfiguration:**

```ini
[hotelpms]
host = localhost
port = 5432
user = hotelpms_app
pool_mode = transaction  # Verbindung nach Transaktion zurück
pool_size = 20           # je Bouncer-Client
```

Bei 3 API-Prozessen können 60 Transaktionen gleichzeitig laufen, aber nicht alle gegen den Backendpool. Idle-Verbindungen in einem Prozess blockieren Ressourcen für andere.

**Empfehlung:** 

- Tatsächliche Konfiguration prüfen und dokumentieren.
- Bei ≥2 API-Prozessen zu `session mode` evaluieren, falls Connection-Reuse relevant ist (ist es usually nicht in `transaction mode`).
- Bouncer-Pool-Größe explizit gegen Concurrency-Test validieren.

---

## P3 — In-Memory Rate-Limiter verdreifacht Schwellwerte

Der Rate-Limiter verwendet pro API-Prozess eine eigene `Map`. Bei drei Prozessen ist das effektive Limit **das Dreifache**:

```typescript
const LOGIN_LIMIT = {
  limit: 60,      // Anmeldungen
  windowMs: 5 * 60_000
}
```

Mit 3 Prozessen: 180 Anmeldungen pro 5 Minuten sind möglich, obwohl die Konfiguration 60 sagt.

Das ist dokumentiert, aber führt in einer Mehrprozess-Production zu:

- Laxerer Brute-Force-Schutz als erwartet,
- Fehlern bei Autoscaling (mehr Prozesse = höheres Limit),
- Verwirrung bei der Capacity-Planung.

Caddy sitzt davor und grenzt auf 300 Anmeldungen (lockerer), also greift Caddy zuerst. Aber die App-Grenze sollte als Fallback wirken, nicht als optionaler Durchsatz.

**Empfehlung:**

- Für `n` Prozesse angemessen konfigurieren oder verteilten Limiter nutzen (Redis, PostgreSQL-Basiert).
- Documentation aktualisieren: effektives Limit ist `pro Prozess * Prozessanzahl`.
- CI-Test hinzufügen, der das bestätigt.

---

## P4 — Verfügbarkeitsmaterialisierung über Nachtlauf

`inventory_day` wird über einen täglichen Job materialisiert mit einem rollierenden 24-Monats-Fenster. Das ist gut für Leseperformance.

Aber bei kurzfristig hohen Anfragen vor dem nächsten Nachtlauf:

- Zeilen könnten für einen bestimmten Zeitraum fehlen,
- `inventory_reserve` würde dann `NOT_MATERIALIZED` zurückgeben,
- Buchungen würden ablehnt.

Das ist als `maintenance_block` in CLAUDE.md dokumentiert, aber es gibt keine Dokumentation für:

- wie oft der Nachtlauf läuft (täglich um X Uhr in der Property-Zeitzone?),
- was passiert, wenn der Nachtlauf ausfällt,
- Backfill-Mechanismus bei großen Lücken.

**Empfehlung:**

- Nachtlauf-Ausfallzeit dokumentieren (z. B. „läuft täglich 02:00 UTC, Backfill bis 23:59 vorigen Tag").
- Monitoring für fehlende Materialiserungen ergänzen.
- Prüfen, ob On-Demand-Materialisierung beim ersten Zugriff sinnvoll ist (erzeugt aber Spike).

---

## P5 — Connection-Pool-Größe für die API nicht dokumentiert

`apps/api/src/platform/app.ts` erstellt den Pool mit `max: 10`:

```typescript
const pool = createPool({ kind: 'app', max: 10, applicationName: 'hotelpms-api' })
```

Bei 250 Zimmern und parallelen Checkout-Operationen könnten 10 Verbindungen eng werden. Ein einfaches Szenario:

- 10 gleichzeitige API-Anfragen erschöpfen den Pool,
- 11. Anfrage wartet auf eine Verbindung,
- Wenn eine lange Transaktion läuft, könnte es zu Timeouts kommen.

Es gibt keine dokumentierte Faustregel, wie groß der Pool sein sollte.

**Empfehlung:**

- Minimale Pool-Größe berechnen: `max(Anzahl CPU-Kerne, erwartete Concurrency)`.
- Beispiel: `max: 2 * os.cpus().length` oder hardcodiert nach Betriebsgröße.
- Umgebungsvariable hinzufügen mit einer vernünftigen Default-Größe.
- Monitoring für Pool-Exhaustion ergänzen.

---

## P6 — Worker-Prozess unter `CPUQuota=150%` und `MemoryMax=4G`

Die systemd-Konfiguration in `ops/systemd/hotelpms-worker.service` begrenzt:

```ini
CPUQuota=150%
MemoryMax=4G
IOWeight=50
```

Das ist eine gute Isolation, verhindert, dass der Worker die API verdrängt. Aber:

- `4G` ist hart — wenn der Worker mehr braucht, wird OOM-Killer aktiviert,
- `150%` CPU bedeutet: auf einem 2-Core-System darf er nur eine Core nutzen,
- keine Observability für tatsächliche Nutzung ist dokumentiert.

Bei großen Exporten oder vielen parallelen Webhook-Zustellungen könnte der Worker OOM gehen und starten müssen.

**Empfehlung:**

- Werte basierend auf Betriebsgröße konfigurieren (z. B. bei `pnpm db:seed` messen).
- Monitoring für Worker-OOM und Restarts einrichten.
- Alert bei `CPUQuota`-Auslösung (Worker wird gedrosselt).

---

## P7 — Test-Suite läuft sequenziell in einem Prozess

`vitest.config.ts` setzt:

```typescript
fileParallelism: false
pool: 'forks'
```

Das ist notwendig wegen der Rate-Limiter und des Audit-Log-Teilens. Aber es bedeutet:

- Ein Test-Lauf dauert länger als notwendig,
- 200+ Test-Dateien müssen in Reihe laufen,
- CI-Durchsatz ist begrenzt.

Das ist kein Produktions-Problem, aber es verlangsamt den Entwicklungszyklus.

**Empfehlung:**

- Unabhängige Testgruppen in separate DB-Instanzen isolieren (z. B. per Worker),
- Alternative: separate Datensätze und Resets pro Testdatei.
- CI-Zeit wird damit als Entwicklungs-Feedback kürzer.

---

## P8 — Keine Erwähnung von Query-Timeouts

Es gibt keine erkennbare Dokumentation von Query-Timeouts in der Anwendung. PostgreSQL kann einzelne Queries aufrollen, wenn sie zu lange dauern:

```sql
SET statement_timeout = '30s';
```

Ohne Timeouts könnten einzelne komplexe Queries oder schlecht optimierte Sequ-Scans Verbindungen unbegrenzt blockieren.

**Empfehlung:**

- `statement_timeout` in `packages/db` setzen (z. B. 30 Sekunden für normale Queries, 5 Minuten für Batch-Jobs).
- App-Fehlerbehandlung für Timeouts dokumentieren.
- Monitoring für häufige Timeouts.

---

## P9 — Keine Produktions-Observability für N+1-Queries

Der Abfragezähler ist nur in der Test-Konfiguration vorhanden (`packages/testing/src`). In der Produktion gibt es keine eingebaute Warnung für:

- N+1-Queries (selbe Query in einer Schleife),
- übermäßige Querys pro HTTP-Request,
- langsame Queries.

Das ist ein beobachtungswürdiger Punkt bei Skalierung.

**Empfehlung:**

- OpenTelemetry-Middleware zum Zählen von Queries pro Request einrichten,
- Schwellwert definieren (z. B. Alert wenn >50 Queries pro Request),
- langsamste Queries identifizieren und monitoren.

---

## Positiv geprüfte Performance-Aspekte

### Aggregat-Endpunkte

Die Architektur nutzt Aggregat-Endpunkte statt N+1:

- `/v1/properties/{id}/availability?from&to&category` — eine Abfrage für Verfügbarkeit,
- `/v1/properties/{id}/tape-chart?from&to` — ein Endpunkt für den ganzen Belegungsplan.

Das verhindert, dass Frontend 400 einzelne Abfragen schickt.

### Indexierungsstrategie

Migrationn 0015 führte GiST-Trigramm-Index für die Gästesuche ein:

| Variante | Plan | Zeit |
|---|---|---|
| `ORDER BY similarity(...) DESC` | Seq Scan + Sort | 147 ms |
| Index erzwungen | Bitmap Heap Scan + Sort | 25 ms |
| GiST `ORDER BY <->` | Index Scan, ohne Sort | 14 ms |

Die Zeit ist unabhängig von der Häufigkeit des Namens, was bei 60.000 Gästen entscheidend ist.

### Trigger auf Anweisungsebene

Migration 0013 änderte den Kapazitäts-Trigger von `FOR EACH ROW` zu `ON ANWEISUNG`:

| Operation | Zeit |
|---|---|
| 250 Zimmer vorher | 28.670 ms |
| 250 Zimmer nachher | 59 ms |

Das verhindert quadratische Rechenzeit.

### Materialisierte Kennzahlen

`business_day_stat` speichert historische Kennzahlen, statt sie zu berechnen:

| Variante | Zeit |
|---|---|
| aus der Aufzeichnung, 365 Zeilen | 1 ms |
| roh aggregiert über Übernachtungen | 73 ms |

Das ist 73× schneller und konsistent.

### Rate-Limiting mit Cleanup

Der Limiter räumt abgelaufene Einträge auf und hat eine harte Obergrenze:

```typescript
private aufraeumen(now: number): void {
  const max = this.opts.maxKeys ?? 10_000
  if (this.fenster.size >= max) {
    // Älteste Einträge entfernen
  }
}
```

Das verhindert Memory-Leaks durch massiven Adress-Scan.

### Datenmodell auf Konsistenz

- Kein Lazy Loading,
- Keine versteckten N+1-Queries durch ORM,
- Explizite SQL-Funktionen für Änderungen,
- Partitionierung für große Tabellen (`audit_log` monatlich).

### Seed-Daten für Messungen

`pnpm db:seed` erzeugt 214.528 Reservierungen über 4 Häuser. Das ist realistisch genug, um:

- Indizes zu testen,
- Trigger-Performance zu validieren,
- Mandanten-RLS unter Last zu prüfen.

---

## Nicht durch diesen Audit belegt

Ohne Lasttest und Profiling sind nicht abschließend verifiziert:

1. tatsächliche Antwortzeiten unter Concurrency (mehrere parallele Anfragen),
2. Durchsatz (Requests/Second) bei maximaler Last,
3. Connection-Pool-Exhaustion unter realem Traffic,
4. Worker-Performance bei großen Exporten oder Webhook-Backlogs,
5. Speichernutzung der API über längere Zeit (Memory Leaks),
6. Cache-Hit-Raten für Datenbank-Queries,
7. GC-Pausen unter hoher Last,
8. Disk-I/O bei großen Logdateien,
9. PostgreSQL-Vacuuming bei Insertions-Raten im Produktivbetrieb,
10. Auswirkung mehrerer Tenants im selben Cluster.

---

## Priorisierte nächste Schritte

1. **SLAs definieren** und mit realem Lasttest validieren (z. B. Apache JMeter, k6).
2. **Connection-Pool-Größe dokumentieren** und konfigurierbar machen.
3. **PgBouncer-Konfiguration** prüfen und gegen tatsächliche Concurrency testen.
4. **Rate-Limiter-Verhalten** bei mehreren Prozessen dokumentieren und ggf. zu verteiltem Limiter migrieren.
5. **Query-Timeouts** einführen und Fehlerbehandlung testen.
6. **Observability** aufbauen: Query-Count, langsame Queries, Worker-Load monitoren.
7. **Nachtlauf-SLA** dokumentieren: Ablaufzeit, Backfill, Ausfallbehandlung.
8. **Worker-Ressourcen-Limits** gegen Saatlauf validieren.
9. **Längerfristig:** OpenTelemetry-Integration für Tracing.

---

## Gesamturteil

Die Performance-Architektur ist bewusst und vermeidet klassische Fallen (N+1, ORM-Lazy-Loading, Row-Trigger). Der Seed-Daten-Lauf zeigt Aufmerksamkeit für Tests unter realistische Größen.

Für den Produktivbetrieb fehlen aber:

- **dokumentierte Zusagen** über Latenz und Durchsatz,
- **Messungen unter Last** mit mehreren gleichzeitigen Anfragen,
- **Observability** zum Erkennen von Bottlenecks,
- **dokumentierte Grenzwerte** bei Ressourcen (Connection-Pool, Worker-Memory).

Ohne diese ist es schwer, Skalierungsentscheidungen zu treffen und Probleme schnell zu diagnostizieren.
