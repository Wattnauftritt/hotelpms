# Systemarchitektur und Tech-Stack

Gesamtentwurf für die Umsetzung. Baut auf den Entscheidungen 1 bis 12 in [02-planungsgrundlage.md](02-planungsgrundlage.md) auf.

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
│  Caddy (TLS automatisch, Reverse Proxy, statische Dateien)        │
└─────────────────────────────┬─────────────────────────────────────┘
                              │ Unix-Socket
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
- **Kein Kubernetes.** Eine VM mit systemd ist für diese Last richtig und debugbar.
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

- Jede Tabelle trägt `property_id`. Ausnahmen: `account`, `property`, `user` und die Rollentabellen, sowie **`guest` mit `account_id`** nach Entscheidung 13. RLS-Richtlinien entsprechend auf `account_id` beziehungsweise `user_id`.
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

**Haussumme.** Je Property und Tag existiert zusätzlich eine Zeile mit `category_id = 0`, die die Summen aller Kategorien führt. `inventory_reserve` prüft Kategoriezeile und Hauszeile in einer Anweisung, damit erlaubtes Overbooking je Kategorie nicht zu unbemerktem Overbooking des Hauses führt (B2 in Dokument 13). Die Hauszeile hat die kleinste `category_id` und wird daher in der Sperrreihenfolge immer zuerst gesperrt.

**Materialisierung:** Ein täglicher Job hält für jede Kategorie und die Hauszeile einen rollierenden Horizont von 24 Monaten vor. Fehlt eine Zeile, liefert der `UPDATE` weniger Zeilen zurück und die Buchung schlägt fehl. Die Fehlerbehandlung muss „Kapazität erschöpft" und „Zeitraum nicht materialisiert" unterscheiden, Letzteres löst einen Alarm aus.

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
  public_ref       text   NOT NULL UNIQUE,   -- zufaellig, nach aussen sichtbar, nie die id
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_valid CHECK (departure > arrival)  -- faellt spaeter fuer Tagesnutzung
);

-- Personen statt Zaehler: noetig fuer Kurtaxe-Staffeln, Kinderpreise, Meldeschein
CREATE TABLE reservation_occupant (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     bigint NOT NULL,
  reservation_id  bigint NOT NULL REFERENCES reservation(id),
  guest_id        bigint,
  age_at_arrival  smallint,
  is_primary      boolean NOT NULL DEFAULT false
);

-- Nur aktive Reservierungen im Index. Stornierte und abgereiste
-- machen nach Jahren den Grossteil der Tabelle aus.
CREATE INDEX reservation_active_range
  ON reservation (property_id, departure, arrival)
  WHERE status IN ('Optional','Confirmed','InHouse');
```

### Gast, je Account

```sql
CREATE TABLE guest (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id         bigint NOT NULL REFERENCES account(id),   -- nicht property_id
  public_ref         text   NOT NULL UNIQUE,
  last_name          text   NOT NULL,
  first_name         text,
  email              text,
  phone              text,
  birth_date         date,
  nationality        char(2),
  id_document_type   text,
  id_document_number_enc bytea,        -- AES-GCM, siehe C4 in Dokument 13
  id_document_key_version smallint,
  status             text NOT NULL DEFAULT 'active',   -- active, anonymized, blocked
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX guest_last_name_trgm ON guest USING gin (last_name gin_trgm_ops);
CREATE INDEX guest_email_trgm     ON guest USING gin (email gin_trgm_ops);

CREATE TABLE guest_property_note (      -- bleibt je Haus
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL,
  guest_id    bigint NOT NULL REFERENCES guest(id),
  note        text   NOT NULL,
  created_by  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

RLS auf `guest` prüft `account_id = ANY(app.account_ids)`, auf `guest_property_note` wie überall `property_id`. Dublettenerkennung und DSGVO-Löschung arbeiten accountweit.

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
| `hotelpms_owner` | Besitzt Schema und Tabellen. Migrationen **und** Bereitstellung neuer Accounts und Properties. Hat `BYPASSRLS`, weil beim Anlegen eines Accounts noch kein Mandantenkontext existieren kann. Nie für normale Anfragen |
| `hotelpms_app` | Die Anwendung. Kein Eigentum, kein `BYPASSRLS`, kein `UPDATE`/`DELETE` auf Finanztabellen, kein `UPDATE` auf `inventory_day` |
| `hotelpms_readonly` | Berichte und Replikat |

```sql
REVOKE UPDATE, DELETE ON charge, settlement, invoice, audit_log FROM hotelpms_app;
REVOKE UPDATE           ON inventory_day                        FROM hotelpms_app;
ALTER TABLE reservation FORCE ROW LEVEL SECURITY;  -- sonst umgeht der Eigentuemer die Richtlinie
```

Weil `hotelpms_owner` die Zeilenrichtlinie umgeht, müssen die `SECURITY DEFINER`-Funktionen des Bestands den Mandanten selbst prüfen. `assert_property_in_context()` tut das in jeder von ihnen; sonst könnte ein Aufruf fremdes Kontingent belegen.

#### Der Worker bekommt keine Sonderrechte

Naheliegend wäre, den Worker mit `BYPASSRLS` laufen zu lassen: er arbeitet ja für alle Mandanten. Genau das ist der Fehler. Der Worker ist der Prozess mit den weitreichendsten Schreibrechten im System, er läuft unbeaufsichtigt, und ein Programmfehler in ihm hätte mit `BYPASSRLS` keine zweite Verteidigungslinie mehr.

Stattdessen zwei Verbindungen mit klarer Aufgabenteilung:

| Verbindung | Rolle | Wofür |
|---|---|---|
| Arbeitsverbindung | `hotelpms_app` | Alle Fachdaten. Jede Arbeitseinheit läuft im Kontext **genau einer Property**, die Zeilenrichtlinie schränkt den Worker damit genauso ein wie die Rezeption |
| Verwaltungsverbindung | `hotelpms_owner` | Nur zwei Dinge: Partitionen des Audit-Logs anlegen und die Liste der aktiven Properties lesen. Beides ist mandantenübergreifend und lässt sich in keiner Zeilenrichtlinie ausdrücken. Bewusst klein, nie für Fachdaten |

Der praktische Nebeneffekt: Sitzungen und Idempotenzschlüssel gehören keinem Mandanten und haben keine Zeilenrichtlinie, für sie genügt die Anwendungsrolle mit leerem Kontext. Alles andere, auch das Vernichten abgelaufener Meldescheine, läuft je Property.

### Rechnung als Menge von Charges

Eine Rechnung schließt **nicht** das Folio. Sie umfasst eine Menge von Charges; ein Folio kann viele Rechnungen haben, etwa wöchentliche Zwischenrechnungen bei Langzeitgästen oder getrennte Rechnungen an Firma und Gast aus einem Aufenthalt.

```sql
CREATE TABLE invoice (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL,
  folio_id           bigint NOT NULL REFERENCES folio(id),
  number             text   NOT NULL,           -- aus invoice_counter, lueckenlos
  issued_on          date   NOT NULL,
  public_ref         text   NOT NULL UNIQUE,
  issuer_snapshot    jsonb  NOT NULL,           -- Name, Anschrift, Steuernummer zum Zeitpunkt
  recipient_snapshot jsonb  NOT NULL,
  totals             jsonb  NOT NULL,           -- je Steuersatz: Netto, Steuer, Brutto
  kind               text   NOT NULL,           -- final, interim, deposit, credit_note
  reverses_id        bigint REFERENCES invoice(id),
  UNIQUE (property_id, number)
);

ALTER TABLE charge ADD COLUMN invoice_id bigint REFERENCES invoice(id);  -- nullable, einmal gesetzt
```

Drei Regeln, die daraus folgen:

- **Rundung:** Charges speichern Netto und Steuersatz. Die Rechnung berechnet die Steuer **je Satzgruppe aus der Nettosumme** und speichert ihre Summen in `totals`. `tax_cent` je Charge ist nur eine Näherung für offene Folios (B5 in Dokument 13).
- **Momentaufnahme:** Aussteller und Empfänger werden als JSON eingefroren. Zieht das Hotel um, bleiben alte Rechnungen unverändert (B6).
- **Anzahlung:** `kind = deposit` erzeugt eine Anzahlungsrechnung mit Steuerausweis nach § 13 Abs. 1 Nr. 1a UStG. Die Schlussrechnung setzt sie als negative Position ab (B4). Steuerliche Aufteilung mit dem Steuerberater klären.

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

## 7. Betrieb: eigene VM auf dem Proxmox-Host

Plesk ist ein Hosting-Panel, kein Anwendungslaufzeit-Werkzeug. Die Aufgabenteilung sollte entsprechend sein.

### Aufteilung

Das PMS läuft auf einer **eigenen VM ohne Plesk**, siehe nächster Abschnitt. Der bestehende Plesk-Server bleibt unberührt und behält seine Projekte.

| Aufgabe | Wer |
|---|---|
| TLS-Zertifikate, Erneuerung | **Caddy**, automatisch |
| Reverse Proxy, statische Dateien | **Caddy** |
| Firewall | **nftables** auf der VM plus **Proxmox-Firewall** zwischen den VMs |
| VM-Sicherung | **Proxmox Backup Server** |
| Datenbanksicherung | **Eigene Basissicherung plus WAL-Archivierung**, ausgelagert |
| **Anwendungsprozesse** | **systemd** |
| **PostgreSQL** | **direkt installiert**, Unix-Socket |

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
Environment=LISTEN_SOCKET=/run/hotelpms/api.sock
RuntimeDirectory=hotelpms
RuntimeDirectoryMode=0750
Restart=always
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/hotelpms
```

Die API lauscht auf dem Unix-Socket, Caddy verbindet sich darauf. `RuntimeDirectory` legt `/run/hotelpms` beim Start an und räumt es beim Stopp weg. Caddy muss Mitglied der Gruppe `hotelpms` sein, um den Socket zu erreichen.

`hotelpms-worker.service` analog, zusätzlich mit `CPUQuota=150%`, `MemoryMax=4G` und `IOWeight=50`, damit der Worker die API nicht verdrängt (P5 in Dokument 12). **Der Worker verbindet sich direkt mit PostgreSQL, nicht über PgBouncer**, weil `LISTEN/NOTIFY` durch Transaction-Pooling nicht ankommt (D1 in [13-gesamtreview.md](13-gesamtreview.md)).

### Eigene VM auf dem Proxmox-Host

Der bestehende Plesk-Server ist eine VM auf einem eigenen Proxmox-Host. Damit ist die Frage einfach beantwortet: **Das PMS bekommt eine eigene VM, ohne Plesk.** Das kostet kein zusätzliches Geld, nur Ressourcen auf vorhandener Hardware, und räumt den größten Risikoposten sofort ab.

Was das löst:

| Problem | Gelöst? |
|---|---|
| Kompromittierte PHP-Anwendung erreicht unsere Datenbank | **Ja.** Andere VM, anderer Kernel. Ohne Netzfreigabe gibt es keinen Pfad |
| Plesk lässt sich nicht abrüsten | **Entfällt.** Auf der PMS-VM läuft kein Plesk, kein Mailserver, kein FTP, kein PHP |
| Betriebskopplung bei Neustart und Aktualisierung | **Ja.** Unabhängig voneinander |
| Konkurrenz um CPU, RAM und Ein-/Ausgabe | **Teilweise.** VMs teilen sich die Hardware. Steuerbar über Proxmox-Grenzen, siehe unten |
| Ausfall des Proxmox-Hosts | **Nein.** Bleibt gemeinsamer Ausfallpunkt, siehe Abschnitt zu Sicherungen |

### VM-Auslegung

| Einstellung | Wert | Begründung |
|---|---|---|
| Betriebssystem | Debian stable oder Ubuntu LTS, Minimalinstallation | Kein Panel, keine Oberfläche, nichts Überflüssiges |
| CPU-Typ | **`host`** | Gibt die CPU-Merkmale durch. Merklich schneller für PostgreSQL als der Standardtyp |
| Arbeitsspeicher | **Feste Zuteilung, Ballooning aus** (`balloon: 0`) | Ballooning und `shared_buffers` vertragen sich nicht. PostgreSQL rechnet mit festem Speicher |
| Plattencontroller | **VirtIO SCSI single mit `iothread=1`** | Eigener Ein-/Ausgabe-Thread je Platte, spürbar bei Schreiblast |
| Plattencache | **`cache=none`** | `writeback` ist schneller, verliert bei Stromausfall aber Daten. Für eine Datenbank nicht vertretbar, solange keine gepufferte Hardware dahintersteht |
| Speicherart | **LVM-thin oder ZFS zvol auf NVMe**, nicht qcow2 auf einem Dateisystem | Vermeidet eine zusätzliche Indirektionsschicht |
| Discard | `discard=on` | TRIM bis zur SSD durchreichen |
| Gast-Agent | `agent: 1` | Erlaubt dem Sicherungslauf ein Einfrieren des Dateisystems |

Bei **ZFS** zusätzlich: `recordsize=8K` auf dem Datensatz mit dem PostgreSQL-Datenverzeichnis, `atime=off`, und die ARC-Größe so wählen, dass sie nicht mit `shared_buffers` um denselben Speicher kämpft. Ohne diese Einstellungen schreibt ZFS für jeden 8-KB-Datenbankblock einen viel größeren Datensatz.

### Ressourcen gegen die Nachbar-VM absichern

VMs auf einem Host teilen sich weiterhin Hardware. Ein durchgehender PHP-Prozess auf der Plesk-VM kann die PMS-VM ausbremsen, wenn nichts begrenzt ist.

- **`cpuunits`** der PMS-VM höher setzen als die der Plesk-VM, damit sie bei Knappheit Vorrang bekommt.
- **Ein-/Ausgabe-Grenzen** an den Platten der Plesk-VM setzen (`mbps_rd`, `mbps_wr`, `iops_rd`, `iops_wr`), damit ein Sicherungslauf dort die Datenbank hier nicht ausbremst.
- Wenn möglich, die Platten der beiden VMs auf **verschiedene physische Datenträger** legen.
- Feste CPU-Kerne zuteilen statt zu überbuchen.

### Netzwerk

Die Proxmox-Firewall auf VM-Ebene setzt zwischen den beiden VMs **standardmäßig Verweigern**. Die Plesk-VM hat keinen Grund, den PostgreSQL-Port der PMS-VM zu erreichen, und darf es nicht können.

Nach außen offen ist ausschließlich 443 auf der PMS-VM. PostgreSQL lauscht dort nur auf einem Unix-Socket, siehe unten.

### Was sich am Aufbau innerhalb der VM ändert

Ohne Plesk übernimmt die VM selbst, was vorher Plesk erledigt hat:

| Aufgabe | Vorher Plesk | Jetzt |
|---|---|---|
| TLS-Zertifikate | Plesk, Let's Encrypt | **Caddy** oder `certbot` mit nginx |
| Reverse Proxy | Plesk-Nginx | **Caddy oder nginx**, eigene Konfiguration, keine Überschreibung mehr |
| Firewall | Plesk | **nftables** plus Proxmox-Firewall |
| Sicherung | Plesk | **Proxmox-Sicherung plus eigene PostgreSQL-Sicherung**, siehe unten |

**Reverse Proxy: Caddy.** Entschieden. Caddy holt und erneuert die Let's-Encrypt-Zertifikate selbst, ohne certbot, Cron-Job oder Neuladen-Hook. Genau die Aufgabe, die vorher Plesk übernommen hat. Die vollständige Konfiguration für unseren Fall:

```
api.hotelpms.de {
    reverse_proxy unix//run/hotelpms/api.sock
    encode zstd gzip
}

app.hotelpms.de {
    root * /opt/hotelpms/current/web
    try_files {path} /index.html
    file_server
    encode zstd gzip
}
```

HTTPS ist darin enthalten. Nginx wäre fachlich gleichwertig, braucht aber Zertifikatspfade, Protokolleinstellungen, einen zweiten Block für die Umleitung von Port 80 und certbot als eigenes Paket. Der Austausch bliebe jederzeit möglich, der Rest der Architektur merkt davon nichts.

Der Rest des Aufbaus bleibt wie beschrieben: API und Worker als systemd-Dienste, PostgreSQL direkt installiert, Verbindung über Unix-Socket.

```
unix_socket_directories = '/run/hotelpms'     # 0700, hotelpms:hotelpms
listen_addresses = ''                          # kein TCP, auch nicht auf localhost
```

Ohne Plesk auf der VM ist das weniger zwingend als vorher, aber es bleibt die einfachste sichere Voreinstellung und kostet nichts.

### Sicherungen: Proxmox allein genügt nicht

Proxmox-Sicherungen mit aktivem Gast-Agenten frieren das Dateisystem ein und sind damit konsistent. PostgreSQL stellt sich beim Start über das Write-Ahead-Log wieder her. Für das schnelle Zurückholen einer ganzen VM ist das ideal.

**Es ersetzt aber keine Datenbanksicherung**, aus einem konkreten Grund: Damit kann man auf den Stand eines Sicherungslaufs zurück, nicht auf den Zeitpunkt unmittelbar vor einem versehentlichen Löschbefehl. Punktgenaue Wiederherstellung braucht fortlaufende WAL-Archivierung.

| Ebene | Werkzeug | Wofür |
|---|---|---|
| VM | Proxmox Backup Server oder `vzdump` | Totalausfall, schnelles Zurückholen |
| Datenbank | Basissicherung plus **fortlaufende WAL-Archivierung** | Punktgenaue Wiederherstellung, etwa vor einem fehlerhaften Import |
| **Auslagerung** | Beides verschlüsselt an einen **zweiten Standort** | Der Proxmox-Host ist ein gemeinsamer Ausfallpunkt |

Der letzte Punkt ist der wichtige. Zwei VMs auf einem Host schützen gegen VM-Fehler, nicht gegen Hardwaredefekt, Brand oder Diebstahl. **Eine verschlüsselte Kopie außer Haus ist die Bedingung, unter der wir Fremdkunden aufnehmen können**, nicht die zweite VM.

Das Replikat aus [07-technologie-und-hosting.md](07-technologie-und-hosting.md) läuft sinnvollerweise nicht auf demselben Proxmox-Host, sonst schützt es gegen genau das nicht.

### Monatliche Wiederherstellungsübung

Eine Sicherung, die nie zurückgespielt wurde, ist keine Sicherung. Einmal im Monat: VM aus der Sicherung in ein Testnetz holen, Datenbank punktgenau auf einen Zeitpunkt zurückholen, Ergebnis protokollieren.

### Falls das PMS doch auf der Plesk-VM landet

Nur als Rückfallebene, etwa für Staging auf der bestehenden VM. Zwei Punkte, die dann gelten:

- **Plesk erzeugt seine Nginx-Konfiguration neu**, sobald im Panel etwas an der Domain geändert wird. Von Hand bearbeitete generierte Dateien gehen verloren. Proxy-Direktiven gehören ausschließlich in das Panel-Feld für zusätzliche Nginx-Direktiven.
- **Nicht die Node.js-Erweiterung von Plesk benutzen.** Sie führt Anwendungen über Passenger aus. Das Prozessmodell ist kaum steuerbar, ein dauerhafter Worker lässt sich nicht sauber betreiben, und Umgebungsvariablen sind im Panel sichtbar, womit das Datenbankpasswort für jeden mit Panel-Zugang lesbar wäre. Stattdessen auch dort systemd plus Proxy-Direktiven.

### Plesk abrüsten

Plesk installiert viel, was wir nicht brauchen und was Angriffsfläche ist. **Auf einem Server, der allein dem PMS gehört**, zu deaktivieren:

- FTP und FTPS
- Webmail, Roundcube
- Eingehender Mailserver, wir versenden über einen Dienstleister
- phpMyAdmin, phpPgAdmin
- PHP-Handler auf der API-Domain

**Teilt sich der Server mit anderen Projekten, ist das meiste davon nicht abschaltbar.** Dann gilt der vorige Abschnitt: Isolation über Socket-Rechte und Systembenutzer statt über Abrüsten. Möglich bleiben in jedem Fall die Begrenzung des Panels auf feste Adressen, Zwei-Faktor-Anmeldung und das Abschalten des PHP-Handlers auf der API-Domain.

### PostgreSQL

Direkt installiert. Verbindungen ausschließlich über den Unix-Socket in `/run/hotelpms`, kein TCP. Zwei Verbindungswege: die API über PgBouncer, der Worker direkt. Grundeinstellungen bei einer VM mit 32 GB RAM und 8 vCPU (3 API-Prozesse, 1 Worker, Rest für die Datenbank):

| Parameter | Wert |
|---|---|
| `shared_buffers` | 8 GB |
| `effective_cache_size` | 20 GB |
| `work_mem` | 32 MB |
| `max_connections` | 100, davor PgBouncer mit `default_pool_size = 20` |
| `wal_level` | `replica` |
| `checkpoint_timeout` | 15min |
| `statement_timeout` für `hotelpms_readonly` | 30s |

Erweiterungen: `pg_trgm` für die Gästesuche (D2 in Dokument 13), `pgcrypto` optional.

### Umgebungen

| Umgebung | Zweck |
|---|---|
| lokal | Entwicklung, PostgreSQL in Docker |
| staging | Zweite VM auf dem Proxmox-Host oder ein Container auf der Plesk-VM, gleiche Konfiguration wie Produktion, anonymisierte Daten |
| produktion | Eigene VM, später Replikat an einem zweiten Standort |

---

## 8. Beobachtbarkeit

- **Logs** strukturiert als JSON mit `request_id`, `property_id`, `user_id`, Dauer und Abfragezahl je Anfrage.
- **Metriken** je Endpunkt: p50, p95, p99, Fehlerrate, Abfragezahl.
- **Traces** über OpenTelemetry, damit bei einer langsamen Anfrage die schuldige Abfrage sichtbar ist.
- **Alarme** bei Überschreitung des Latenzbudgets, bei Fehlerrate über Schwelle, bei nicht gelaufenem Nachtlauf, bei Abweichung im täglichen Bestandsabgleich.

Der letzte Punkt ist der wichtigste: Ein Abgleichjob rechnet `inventory_day` nachts gegen die Reservierungstabelle nach. **Ein stiller Zählerfehler ist das Schlimmste, was einem Bestandssystem passieren kann.**
