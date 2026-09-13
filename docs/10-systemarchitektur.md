# Systemarchitektur und Tech-Stack

Gesamtentwurf für die Umsetzung. Baut auf den Entscheidungen 1 bis 10 in [02-planungsgrundlage.md](02-planungsgrundlage.md) auf.

---

## 1. Zielbild

```
┌───────────────────────────────────────────────────────────────────┐
│  Clients                                                          │
│  Rezeption (SPA) · Housekeeping (mobil) · Booking Engine          │
│  Partner-Integrationen · Channel Manager · Kassen                 │
└─────────────────────────────┬─────────────────────────────────────┘
                              │ HTTPS, OAuth 2.0
┌─────────────────────────────┴─────────────────────────────────────┐
│  Plesk-Nginx (TLS, Reverse Proxy, statische Dateien)              │
└─────────────────────────────┬─────────────────────────────────────┘
                              │ 127.0.0.1
┌─────────────────────────────┴─────────────────────────────────────┐
│  API-Prozess (systemd, Node/Fastify)   ×N                         │
│  ├─ Auth & Mandantenkontext                                       │
│  ├─ Domänenmodule                                                 │
│  └─ Datenzugriff (Drizzle + SQL)                                  │
├───────────────────────────────────────────────────────────────────┤
│  Worker-Prozess (systemd, Graphile Worker)                        │
│  ├─ Nachtlauf   ├─ Webhooks   ├─ E-Mail   ├─ PDF   ├─ Exporte     │
└─────────────────────────────┬─────────────────────────────────────┘
                              │ Unix-Socket, 0,1 ms
┌─────────────────────────────┴─────────────────────────────────────┐
│  PgBouncer → PostgreSQL (primär)      ──Replikation──▶ Replikat    │
└───────────────────────────────────────────────────────────────────┘
```

Der entscheidende Punkt bleibt aus [04-api-first-und-performance.md](04-api-first-und-performance.md): **Anwendung und Datenbank auf derselben Maschine.** Der Client macht eine teure Netzrunde, der Server viele billige.

---

## 2. Tech-Stack

| Schicht | Wahl | Begründung |
|---|---|---|
| Sprache | **TypeScript**, strict | Eine Sprache für Backend und Oberfläche, Typen aus einer Quelle |
| Laufzeit | **Node.js, jeweils aktuelles LTS** | Konservativ, beste Betriebsreife unter systemd. Kein Bun, weil die Ökosystemreife für ein Finanzsystem nicht gegeben ist |
| HTTP | **Fastify** | Schnellster der etablierten Rahmen, JSON-Schema-Validierung eingebaut, daraus fällt die OpenAPI-Spezifikation ab |
| Schemata | **TypeBox** | Ist buchstäblich JSON Schema, dient gleichzeitig Validierung, OpenAPI und TypeScript-Typen |
| Datenbank | **PostgreSQL 17 oder neuer** | Zeilensperren, partielle Indizes, RLS, JSONB, LISTEN/NOTIFY |
| Datenzugriff | **Drizzle** für Schema, Migrationen und einfache Abfragen, **handgeschriebenes SQL** für heiße Pfade | Kein Lazy Loading, keine versteckten Abfragen |
| Verbindungen | **node-postgres** hinter **PgBouncer** (transaction mode) | Persistente Verbindungen, kein Handshake je Anfrage |
| Jobs | **Graphile Worker** | Läuft in PostgreSQL. Dadurch kann ein Job **in derselben Transaktion** wie die Fachbuchung eingereiht werden. Kein Redis nötig |
| Auth | **OAuth 2.0**, Authorization Code + PKCE für die Oberfläche, Client Credentials für Maschinen | Ein Berechtigungsmodell für alle |
| Passwörter | **Argon2id** | Stand der Technik |
| Logs | **pino**, strukturiert als JSON | Maschinenlesbar, schnell |
| Tracing | **OpenTelemetry** | Zeigt bei einer langsamen Anfrage, welche Abfrage schuld war |
| Fehler | **Sentry (EU-Region) oder GlitchTip** | GlitchTip selbst gehostet, wenn Datenabfluss vermieden werden soll |
| Tests | **Vitest**, **Testcontainers** für echtes PostgreSQL | Keine Mocks für die Datenbank, sonst testet man nichts |
| CI | **GitHub Actions** | Repository liegt dort |
| Oberfläche | **React + Vite + TanStack Query + TanStack Router**, Tailwind | Später, siehe [11-umsetzungsplan.md](11-umsetzungsplan.md) |

### Bewusst nicht gewählt

- **Kein schwergewichtiges ORM** (TypeORM, Prisma mit Relations-Laden). Lazy Loading ist der Hauptweg, wie N+1-Probleme entstehen.
- **Kein Redis** zu Beginn. Ein weiterer Dienst mit eigenem Ausfallverhalten für Funktionen, die PostgreSQL genauso erfüllt.
- **Kein Kubernetes.** Zwei Server mit systemd sind für diese Last richtig und debugbar.
- **Kein Microservice-Schnitt.** Ein Monolith mit klaren Modulgrenzen. Verteilte Transaktionen über Verfügbarkeit und Folio wären ein selbstgemachtes Problem.

---

## 3. Modulschnitt im Code

Ein Deployment, klar getrennte Module. Module sprechen nur über ihre öffentliche Schnittstelle miteinander, nie über fremde Tabellen.

```
src/
  platform/        Querschnitt: Konfiguration, Logging, Fehler, DB, Auth, Audit
  modules/
    tenancy/       Account, Property, User, Rollen, Rechte
    inventory/     Kategorien, Zimmer, Attribute, Sperrungen
    rates/         Ratenpläne, Tagespreise, Restriktionen, Steuerregeln
    availability/  inventory_day, Berechnung, Reservierung von Kontingent
    booking/       Booking, Reservation, Zustandsautomat, Blocks
    guests/        Gast, Firma, Dubletten, Meldeschein
    billing/       Folio, Charge, Settlement, Rechnung, Nummernkreise
    operations/    Housekeeping, Aufgaben, Nachtlauf
    reporting/     Kennzahlen, Listen, DATEV- und GoBD-Export
    integrations/  Webhooks, ARI, Payment-Adapter, Kassenschnittstelle
  api/
    v1/            Routen, Schemata, Fehlerabbildung
  workers/         Job-Definitionen
```

**Abhängigkeitsregel:** `api` → `modules` → `platform`. Niemals rückwärts, niemals quer zwischen Modulen ohne öffentliche Schnittstelle. Durchgesetzt per ESLint-Regel, nicht per Absprache.

---

## 4. Datenmodell

Auszug der tragenden Tabellen. Vollständige Definition entsteht in Arbeitspaket 0 bis 6.

### Konventionen

- Jede Tabelle trägt `property_id` (Ausnahme: `account`, `property`, `user`).
- Geldbeträge als `bigint` in Cent, dazu `currency char(3)`.
- Aufenthaltsdaten als `date`, Zeitpunkte als `timestamptz` in UTC.
- Primärschlüssel als `bigint generated always as identity`.
- Keine `ON DELETE CASCADE` in Finanztabellen.

### Verfügbarkeit, das Kernstück

```sql
CREATE TABLE inventory_day (
  property_id   bigint  NOT NULL REFERENCES property(id),
  category_id   bigint  NOT NULL REFERENCES resource_category(id),
  date          date    NOT NULL,
  capacity      integer NOT NULL,
  sold          integer NOT NULL DEFAULT 0,
  blocked       integer NOT NULL DEFAULT 0,
  overbooking   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (property_id, category_id, date),
  CONSTRAINT sold_nonneg    CHECK (sold >= 0),
  CONSTRAINT blocked_nonneg CHECK (blocked >= 0)
);
```

**Belegung in einer Anweisung, atomar und ohne Doppelverkauf:**

```sql
UPDATE inventory_day
   SET sold = sold + $5
 WHERE property_id = $1 AND category_id = $2
   AND date >= $3 AND date < $4
   AND sold + blocked + $5 <= capacity + overbooking
RETURNING date;
```

Die Anwendung vergleicht die Zahl zurückgegebener Zeilen mit der Zahl der Nächte. Weniger bedeutet: eine Nacht war voll oder nicht vorhanden, also Rollback.

PostgreSQL bewertet die `WHERE`-Bedingung nach dem Erwerb der Zeilensperre neu. Zwei gleichzeitige Buchungen derselben Kategorie serialisieren sich damit korrekt, Buchungen verschiedener Kategorien laufen parallel.

**Genau ein Besitzer der Tabelle.** Alle Änderungen laufen durch drei SQL-Funktionen, kein Pfad schreibt direkt:

```sql
inventory_reserve(property, category, from, to, count)  -- mit Kapazitaetspruefung
inventory_release(property, category, from, to, count)
inventory_set_capacity(property, category, from, to, capacity)
```

Der Buchungspfad ruft `inventory_reserve`. Trigger auf `maintenance_block` und `resource` rufen `inventory_set_capacity`. Storno und No-Show rufen `inventory_release`. Durchgesetzt über Rechte: die Anwendungsrolle bekommt **kein `UPDATE` auf `inventory_day`**, nur `EXECUTE` auf die Funktionen. Ohne diese Regel zählen Buchungspfad und Trigger doppelt, siehe W1 in [12-security-und-performance-review.md](12-security-und-performance-review.md).

**Materialisierung:** Ein täglicher Job hält für jede Kategorie einen rollierenden Horizont von 24 Monaten vor. Fehlt eine Zeile, liefert der `UPDATE` weniger Zeilen zurück und die Buchung schlägt fehl. Die Fehlerbehandlung muss „Kapazität erschöpft" und „Zeitraum nicht materialisiert" unterscheiden, Letzteres löst einen Alarm aus.

### Reservierung

```sql
CREATE TYPE reservation_status AS ENUM
  ('Inquired','Optional','Confirmed','InHouse','CheckedOut','Canceled','NoShow');

CREATE TABLE reservation (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id      bigint NOT NULL,
  booking_id       bigint NOT NULL REFERENCES booking(id),
  category_id      bigint NOT NULL,
  resource_id      bigint,
  arrival          date   NOT NULL,
  departure        date   NOT NULL,
  status           reservation_status NOT NULL,
  adults           smallint NOT NULL,
  children         smallint NOT NULL DEFAULT 0,
  rate_plan_id     bigint,
  primary_guest_id bigint,
  option_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_valid CHECK (departure > arrival)
);

-- Nur aktive Reservierungen im Index. Stornierte und abgereiste
-- machen nach Jahren den Grossteil der Tabelle aus.
CREATE INDEX reservation_active_range
  ON reservation (property_id, departure, arrival)
  WHERE status IN ('Optional','Confirmed','InHouse');
```

### Geld

```sql
CREATE TABLE charge (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     bigint NOT NULL,
  folio_id        bigint NOT NULL REFERENCES folio(id),
  business_date   date   NOT NULL,
  net_cent        bigint NOT NULL,
  tax_cent        bigint NOT NULL,
  gross_cent      bigint NOT NULL,
  tax_rate_bp     integer NOT NULL,          -- Basispunkte, 700 = 7 %
  revenue_account text   NOT NULL,
  reverses_id     bigint REFERENCES charge(id),
  created_by      bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settlement (               -- Zahlungsvermerk, Entscheidung 9
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id       bigint NOT NULL,
  folio_id          bigint NOT NULL REFERENCES folio(id),
  business_date     date   NOT NULL,
  amount_cent       bigint NOT NULL,
  payment_method_id bigint NOT NULL REFERENCES payment_method(id),
  external_reference text,
  reverses_id       bigint REFERENCES settlement(id),
  created_by        bigint NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

`charge`, `settlement`, `invoice` und `audit_log` sind Härtegrad 1 nach [08-compliance-in-der-praxis.md](08-compliance-in-der-praxis.md). Der Rechteentzug wirkt allerdings nur, wenn die Anwendungsrolle **nicht Eigentümerin** der Tabellen ist, denn ein Eigentümer kann sich Rechte jederzeit zurückgeben. Daher drei getrennte Rollen:

| Rolle | Zweck |
|---|---|
| `hotelpms_owner` | Besitzt Schema und Tabellen, wird **ausschließlich** von Migrationen benutzt |
| `hotelpms_app` | Die Anwendung. Kein Eigentum, kein `UPDATE`/`DELETE` auf Finanztabellen, kein `UPDATE` auf `inventory_day` |
| `hotelpms_readonly` | Berichte und Replikat |

```sql
REVOKE UPDATE, DELETE ON charge, settlement, invoice, audit_log FROM hotelpms_app;
REVOKE UPDATE           ON inventory_day                        FROM hotelpms_app;
ALTER TABLE reservation FORCE ROW LEVEL SECURITY;  -- sonst umgeht der Eigentuemer die Richtlinie
```

### Lückenlose Rechnungsnummern

**Keine PostgreSQL-Sequenz.** Sequenzen sind absichtlich nicht transaktional und hinterlassen bei jedem Rollback eine Lücke. Eine Rechnungsnummer muss lückenlos sein. Stattdessen eine gesperrte Zählerzeile in derselben Transaktion:

```sql
CREATE TABLE invoice_counter (
  property_id bigint  NOT NULL,
  year        integer NOT NULL,
  next_number bigint  NOT NULL,
  PRIMARY KEY (property_id, year)
);

UPDATE invoice_counter
   SET next_number = next_number + 1
 WHERE property_id = $1 AND year = $2
RETURNING next_number - 1 AS assigned;
```

Das serialisiert die Rechnungserstellung je Property, was bei wenigen Rechnungen pro Minute kein Problem ist. Die Nummer wird **erst beim Festschreiben** vergeben, nie beim Entwurf.

### Audit-Log

Generischer Trigger auf allen Tabellen des Härtegrads 3, nicht in der Anwendung:

```sql
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  property_id bigint,
  table_name  text        NOT NULL,
  row_id      bigint      NOT NULL,
  action      text        NOT NULL,
  old_values  jsonb,
  new_values  jsonb,
  user_id     bigint,
  occurred_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);
```

Partitioniert nach Monat, weil diese Tabelle die größte im System wird.

---

## 5. API-Entwurf

### Grundlagen

| Thema | Festlegung |
|---|---|
| Basis | `https://api.<domain>/v1` |
| Format | JSON, UTF-8 |
| Fehler | **RFC 9457 Problem Details**, mit `type`, `title`, `status`, `detail`, `instance` und feldbezogenen Fehlern |
| Idempotenz | `Idempotency-Key` auf jedem POST, der Geld oder Bestand berührt. Antwort wird gespeichert und bei Wiederholung erneut ausgeliefert |
| Paginierung | Cursor auf `(created_at, id)`, nie OFFSET |
| Nebenläufigkeit | `ETag` und `If-Match` auf änderbaren Ressourcen |
| Zeit | Alle Zeitpunkte ISO 8601 mit Zeitzone, Aufenthaltsdaten als reines Datum |
| Versionierung | Im Pfad. Additive Änderungen erlaubt, alles andere neue Version |

### Ressourcen, Auszug

```
GET    /v1/properties/{id}/availability?from&to&category
GET    /v1/properties/{id}/tape-chart?from&to          Aggregat für einen Bildschirm
POST   /v1/bookings                                     Idempotency-Key
GET    /v1/reservations?property&status&arrival_from
POST   /v1/reservations/{id}/confirm
POST   /v1/reservations/{id}/check-in
POST   /v1/reservations/{id}/check-out
POST   /v1/reservations/{id}/cancel
POST   /v1/reservations/{id}/assign-unit
GET    /v1/folios/{id}
POST   /v1/folios/{id}/charges                          Idempotency-Key
POST   /v1/folios/{id}/settlements                      Idempotency-Key
POST   /v1/folios/{id}/invoice                          Idempotency-Key, schreibt fest
PUT    /v1/rate-plans/{id}/rates                        Massenpflege je Tag
PUT    /v1/rate-plans/{id}/restrictions
```

**Operationen der Domäne statt Feldänderungen.** `POST /check-in` validiert, weist zu, prüft den Meldeschein, löst Ereignisse aus. `PATCH {"status":"InHouse"}` täte nichts davon.

### Aggregat-Endpunkte

Der Zimmerplan ist ein eigener Endpunkt, der intern drei Abfragen macht, statt den Client 400 Aufrufe machen zu lassen. Das ist die Auflösung der Falle aus Abschnitt 1.5 von [04-api-first-und-performance.md](04-api-first-und-performance.md).

### Vertrag und Spezifikation

Abweichend von der ersten Fassung in Dokument 04, mit Begründung:

- Der API-Entwurf wird **vor der Implementierung als Dokument festgelegt**: Ressourcen, Operationen, Felder, Fehlerfälle.
- Implementiert wird mit typisierten Routen-Schemata, aus denen die OpenAPI-Spezifikation **generiert** wird.
- Ein **Vertragstest** vergleicht die generierte Spezifikation mit der veröffentlichten und schlägt bei brechenden Änderungen fehl.

Damit bleibt der Entwurf bewusst, die Spezifikation kann nicht von der Implementierung abweichen, und Brüche fallen in der CI auf. Handgepflegtes YAML plus generierte Rümpfe wäre strenger, driftet in der Praxis aber auseinander.

### Authentifizierung

Ein Autorisierungsmodell, unterschiedlicher Transport der Anmeldedaten:

| Client | Verfahren |
|---|---|
| Rezeptions-Oberfläche | Authorization Code + PKCE. Die Token liegen serverseitig in der Sitzung, der Browser bekommt nur ein `HttpOnly`, `Secure`, `SameSite=Strict` Cookie als Sitzungsschlüssel |
| Channel Manager, Partner, Kasse | Client Credentials, Bearer-Token |
| Kiosk, Gäste-Self-Service | Eigener Client mit eng gefassten Scopes |

**Es gibt keine privilegierten Endpunkte für die eigene Oberfläche.** Dieselben Routen, dieselben Scopes, dasselbe Audit. Nur der Transport unterscheidet sich, weil ein Browser andere Angriffsflächen hat als ein Server.

### Webhooks

Ereignisse: `reservation.created`, `reservation.updated`, `reservation.checked_in`, `reservation.checked_out`, `reservation.canceled`, `folio.closed`, `invoice.issued`, `rate.changed`, `availability.changed`.

Zustellung mit HMAC-SHA256-Signatur über den Rohtext, Zeitstempel gegen Wiedereinspielung, exponentielles Wiederholen, Abschaltung nach dauerhaftem Fehlschlag.

---

## 6. Hintergrundverarbeitung

Alles, was die Antwort nicht blockieren muss, läuft im Worker: Nachtlauf, Webhook-Zustellung, E-Mail, PDF-Erzeugung, Exporte, Materialisierung von `inventory_day`, Löschjobs.

**Der entscheidende Vorteil von Graphile Worker:** Der Job wird in derselben Transaktion eingereiht wie die Fachbuchung. Entweder beides oder nichts. Damit entfällt der klassische Fehler, dass eine Reservierung gespeichert, die Bestätigungsmail aber nie verschickt wird.

Der Nachtlauf ist ein Job je Property, ausgelöst zur konfigurierten Tageswechselzeit in der Zeitzone der Property. Er muss **idempotent** sein, weil er wiederholt werden kann.

---

## 7. Betrieb auf Linux mit Plesk

Plesk ist ein Hosting-Panel, kein Anwendungslaufzeit-Werkzeug. Die Aufgabenteilung sollte entsprechend sein.

### Aufteilung

| Aufgabe | Wer |
|---|---|
| TLS-Zertifikate, Erneuerung | **Plesk**, Let's Encrypt |
| DNS | **Plesk** |
| Nginx als Reverse Proxy und für statische Dateien | **Plesk** |
| Firewall, fail2ban | **Plesk** |
| Systemsicherung | **Plesk**, ergänzt um eigene Datenbanksicherung |
| **Anwendungsprozesse** | **systemd**, nicht Plesk |
| **PostgreSQL** | **direkt installiert**, nicht über Plesk verwaltet |

### Warum nicht die Node.js-Erweiterung von Plesk

Plesk führt Node-Anwendungen über **Phusion Passenger** aus. Das ist bequem für eine einfache Webanwendung, für uns aber nachteilig:

- Das Prozessmodell ist kaum steuerbar, Anzahl und Lebenszyklus liegen bei Passenger.
- **Ein dauerhafter Worker-Prozess lässt sich damit nicht sauber betreiben.** Wir brauchen aber einen.
- Sanftes Herunterfahren und Bereitstellung ohne Ausfall sind umständlich.
- Umgebungsvariablen sind im Plesk-Panel sichtbar. **Das Datenbankpasswort wäre für jeden mit Panel-Zugang lesbar.**

### Empfohlener Aufbau

```
/opt/hotelpms/
  releases/2026-09-13-1430/     Ausgelieferter Build
  current -> releases/...        Symlink
  shared/env                     0600, root:hotelpms
```

Zwei systemd-Einheiten:

```ini
# /etc/systemd/system/hotelpms-api.service
[Service]
User=hotelpms
EnvironmentFile=/opt/hotelpms/shared/env
ExecStart=/usr/bin/node /opt/hotelpms/current/dist/api.js
Restart=always
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/hotelpms
```

Dazu `hotelpms-worker.service` analog.

Die Plesk-Domain wird auf **Proxy-Modus** gestellt und über zusätzliche Nginx-Direktiven auf `127.0.0.1:3000` geleitet, mit `proxy_http_version 1.1` und Keepalive zum Upstream.

### Eigener Server oder geteilt? Die entscheidende Vorfrage

Plesk auf demselben Server wie die Anwendung ist richtig, **sofern dieser Server allein dem PMS gehört**.

**Hostet derselbe Plesk-Server auch andere Websites, gehört das PMS auf einen eigenen Server.** Grund: Eine verwundbare PHP-Anwendung auf dem Rechner bedeutet lokalen Zugriff, und von dort ist PostgreSQL über den Socket auf `127.0.0.1` erreichbar. Ein veraltetes CMS neben einer Datenbank mit Gästedaten und Rechnungen ist eine Konstellation, die man nicht eingeht.

| Lage | Empfehlung |
|---|---|
| Plesk-Server gehört allein dem PMS | Plesk bleibt, Anwendung unter systemd auf derselben Maschine |
| Plesk-Server hostet auch Kundenseiten | **Eigener Server für das PMS.** Plesk dort gern wieder, aber ohne fremde Anwendungen |

Ein zusätzlicher dedizierter Server kostet rund 80 bis 100 Euro im Monat. Gemessen an der Umsatzrechnung in [07-technologie-und-hosting.md](07-technologie-und-hosting.md) ist das kein Argument.

Muss der Server aus anderen Gründen geteilt werden, sind dies die Mindestmaßnahmen: PostgreSQL mit `scram-sha-256` auch auf localhost und niemals `trust`, eigener Systembenutzer für die Anwendung, Anwendungsdateien und Umgebungsdatei nicht lesbar für die Plesk-Webbenutzer, und getrennte Datenbankinstanz statt einer geteilten.

### Fallstrick: Plesk überschreibt die Nginx-Konfiguration

Plesk erzeugt seine Nginx-Konfiguration neu, sobald im Panel etwas an der Domain geändert wird. **Von Hand bearbeitete generierte Dateien gehen dabei verloren.**

Unsere Proxy-Direktiven gehören deshalb ausschließlich in das Panel-Feld für zusätzliche Nginx-Direktiven, nie in die generierten Dateien. Ebenso wichtig: Port 3000 ist nur an `127.0.0.1` gebunden und in der Firewall nicht nach außen geöffnet.

### Plesk abrüsten

Plesk installiert viel, was wir nicht brauchen und was Angriffsfläche ist. Zu deaktivieren:

- FTP und FTPS
- Webmail, Roundcube
- Eingehender Mailserver, wir versenden über einen Dienstleister
- phpMyAdmin, phpPgAdmin
- PHP-Handler auf der API-Domain

Das Panel selbst auf Port 8443 wird per Firewall auf feste Adressen begrenzt und bekommt Zwei-Faktor-Anmeldung.

### PostgreSQL

Direkt installiert, nicht über Plesk. Verbindungen nur über Unix-Socket beziehungsweise `127.0.0.1`. Grundeinstellungen bei 64 GB RAM, unter Berücksichtigung dessen, dass Plesk selbst Dienste betreibt:

| Parameter | Wert |
|---|---|
| `shared_buffers` | 12 GB |
| `effective_cache_size` | 32 GB |
| `work_mem` | 32 MB |
| `max_connections` | 100, davor PgBouncer |
| `wal_level` | `replica` |
| `checkpoint_timeout` | 15min |

### Umgebungen

| Umgebung | Zweck |
|---|---|
| lokal | Entwicklung, PostgreSQL in Docker |
| staging | Eigene Plesk-Subdomain, gleiche Konfiguration wie Produktion, anonymisierte Daten |
| produktion | Zwei Server, primär und Replikat |

---

## 8. Beobachtbarkeit

- **Logs** strukturiert als JSON mit `request_id`, `property_id`, `user_id`, Dauer und Abfragezahl je Anfrage.
- **Metriken** je Endpunkt: p50, p95, p99, Fehlerrate, Abfragezahl.
- **Traces** über OpenTelemetry, damit bei einer langsamen Anfrage die schuldige Abfrage sichtbar ist.
- **Alarme** bei Überschreitung des Latenzbudgets, bei Fehlerrate über Schwelle, bei nicht gelaufenem Nachtlauf, bei Abweichung im täglichen Bestandsabgleich.

Der letzte Punkt ist der wichtigste: Ein Abgleichjob rechnet `inventory_day` nachts gegen die Reservierungstabelle nach. **Ein stiller Zählerfehler ist das Schlimmste, was einem Bestandssystem passieren kann.**
