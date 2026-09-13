# Umsetzungsplan

Konkrete Reihenfolge der Arbeit. Backend und API zuerst, Oberfläche folgt ab Arbeitspaket 5.

---

## 1. Repository-Struktur

Ein Monorepo, weil Backend und Oberfläche Typen teilen.

```
hotelpms/
  apps/
    api/                 Fastify-Anwendung
    worker/              Graphile Worker
    web/                 Rezeptions-Oberfläche (ab AP 12)
  packages/
    db/                  Drizzle-Schema, Migrationen, Seed
    domain/              Fachlogik ohne HTTP und ohne Framework
    contracts/           TypeBox-Schemata, generierte OpenAPI, Client-Typen
    testing/             Testhelfer, Abfragezähler, Fixtures
  docs/                  Diese Dokumente
  ops/
    systemd/             Unit-Dateien
    nginx/               Plesk-Zusatzdirektiven
    deploy/              Auslieferungsskripte
  .github/workflows/     CI
```

Werkzeuge: **pnpm workspaces**, **Turborepo** oder einfache pnpm-Skripte, **ESLint** mit Modulgrenzen-Regel, **Prettier**, **TypeScript strict**.

---

## 2. Arbeitspakete

Jedes Paket ist abgeschlossen, wenn seine Definition of Done erfüllt ist. Kein Paket gilt als fertig ohne Tests und ohne Einhaltung des Latenzbudgets.

### AP 0 — Fundament

**Ohne dieses Paket beginnt keine Fachlichkeit.**

- Monorepo, Werkzeuge, TypeScript strict, ESLint mit Modulgrenzen
- PostgreSQL lokal in Docker, Migrationswerkzeug, Rollback geprüft
- Konfiguration aus Umgebungsvariablen, beim Start validiert, kein stiller Standardwert für Geheimnisse
- Strukturiertes Logging mit Anfrage-ID
- Zentrale Fehlerbehandlung nach RFC 9457
- **Testaufbau mit echtem PostgreSQL über Testcontainers**
- **Abfragezähler-Helfer**, siehe Abschnitt 4
- **Seed-Skript mit realistischer Datenmenge**: 250 Zimmer, 15 Kategorien, drei Jahre Historie, rund 200.000 Reservierungen
- CI: Lint, Typecheck, Test, Build
- Audit-Trigger als generische Funktion, an einer Beispieltabelle erprobt, **samt Partitionsjob für `audit_log`**
- **Drei Datenbankrollen**, Migrationen laufen unter der Eigentümerrolle
- **Generischer Berechtigungstest über alle registrierten Routen**, siehe S13 in [12-security-und-performance-review.md](12-security-und-performance-review.md)
- **systemd-Einheiten mit Ressourcenbegrenzung** in `ops/systemd/`

**Definition of Done:** Ein leerer Endpunkt ist erreichbar, die CI ist grün, der Abfragezähler schlägt bei einem absichtlich eingebauten N+1 fehl, eine Route ohne Berechtigungsangabe bricht den Build, der Seed läuft in unter fünf Minuten durch.

### AP 1 — Mandanten, Nutzer, Zugriff

- `account`, `property`, `user`, `role`, `permission`, `user_property_role`
- Argon2id, Anmeldung, Sitzungen, Sperrung nach Fehlversuchen
- OAuth 2.0: Authorization Code + PKCE und Client Credentials
- Scopes und Rechteprüfung als Middleware
- **Mandantenkontext aus dem Token**, nie aus einem Parameter des Clients
- **Row Level Security** auf allen Tabellen mit `property_id`, siehe [12-security-und-performance-review.md](12-security-und-performance-review.md)
- TOTP für Rollen mit Verwaltungsrechten

**Definition of Done:** Ein Test weist nach, dass ein Token für Property A auf keiner Route Daten von Property B erhält, auch nicht bei manipuliertem Pfadparameter. Ein zweiter Test weist nach, dass RLS auch bei einer absichtlich fehlenden `WHERE`-Bedingung greift.

### AP 2 — Inventar

- `resource_category`, `resource`, Attribute, Sortierung
- `maintenance_block` mit Out of Order und Out of Service
- Änderungen an Kapazität schreiben `inventory_day` fort

**Definition of Done:** Ein zusätzliches Zimmer erhöht die Kapazität aller künftigen Tage der Kategorie, eine Out-of-Order-Sperrung senkt sie im Zeitraum. Beides in einer Transaktion, beides mit Test.

### AP 3 — Raten und Steuern

- `rate_plan`, `rate_day`, `restriction_day`, `cancellation_policy`
- Abgeleitete Raten mit Betrag oder Prozent auf eine Basisrate
- `tax_rule`: Umsatzsteuer 7 und 19 Prozent, Kurtaxe je Gemeinde mit Ausnahmen
- Massenpflege über einen Aufruf für einen Zeitraum

**Definition of Done:** Ein Preis-Push für 365 Tage über alle Kategorien läuft in einer Datenbankrunde und unter 300 Millisekunden. Die Steueraufteilung eines Paketpreises ist testgedeckt.

### AP 4 — Verfügbarkeit

**Das wichtigste Paket. Hier entscheidet sich die Korrektheit des Systems.**

- `inventory_day` mit Zählern
- **Genau ein Besitzer:** die drei SQL-Funktionen `inventory_reserve`, `inventory_release`, `inventory_set_capacity`. Die Anwendungsrolle hat kein `UPDATE` auf die Tabelle
- Trigger auf `maintenance_block` und `resource` rufen `inventory_set_capacity`, sie schreiben nicht selbst
- Materialisierungsjob für einen rollierenden Horizont von 24 Monaten, plus Alarm bei zu wenig Vorlauf
- Belegung mit Kapazitätsprüfung in einer Anweisung, Fehlerfall unterscheidet „ausgebucht" von „nicht materialisiert"
- Sperrreihenfolge nach aufsteigender Kategorie-ID gegen Deadlocks
- Abgleichjob, der die Zähler gegen die Reservierungen nachrechnet
- Verfügbarkeits-API für Zeitraum und Kategorien, mit Obergrenze für den Zeitraum

**Definition of Done:** Ein Nebenläufigkeitstest startet 50 gleichzeitige Buchungen auf das letzte freie Zimmer. Genau eine gewinnt, 49 erhalten eine saubere Fehlermeldung, der Zähler stimmt. Eine Jahresabfrage über alle Kategorien braucht eine Abfrage und unter 20 Millisekunden.

### AP 5 — Reservierungen

- `booking`, `reservation`, `reservation_night`, `block`
- Zustandsautomat mit erlaubten Übergängen als Tabelle, nicht als verstreute `if`-Ketten
- Zimmerzuweisung, Umzug, Verlängerung, Verkürzung
- Gruppen und Kontingente
- Herkunft und externe Buchungsnummer
- Zimmerplan-Endpunkt mit höchstens drei Abfragen

**Definition of Done:** Jeder unerlaubte Zustandsübergang wird abgewiesen und ist getestet. Der Zimmerplan über 30 Tage und 250 Zimmer liefert in unter 80 Millisekunden mit drei Abfragen.

### AP 6 — Gäste und Firmen

- `guest`, `company`, Dublettenerkennung
- Suche über Name, E-Mail, Telefon, Buchungsnummer
- Historie eines Gastes
- Löschkonzept: Sperren und Anonymisieren statt Löschen

**Definition of Done:** Eine Löschanfrage nach DSGVO anonymisiert den Gast, lässt die Rechnungen mit historischem Namen bestehen und ist protokolliert.

### AP 7 — Folio, Rechnung, GoBD

- `folio`, `charge`, `settlement`, `payment_method`, `routing`
- Split Billing und Sammelrechnung
- **Lückenlose Rechnungsnummern über eine gesperrte Zählerzeile**, nicht über eine Sequenz
- Festschreiben, Storno als Gegenbuchung
- Rechnungs-PDF im Worker
- Entzug von UPDATE und DELETE auf den Finanztabellen für die Anwendungsrolle

**Definition of Done:** Ein Test weist nach, dass die Anwendungsrolle eine festgeschriebene Rechnung nicht ändern kann, dass ein Rollback keine Nummernlücke erzeugt, und dass 20 gleichzeitige Check-outs 20 aufeinanderfolgende Nummern ergeben.

### AP 8 — Nachtlauf und Jobs

- Graphile Worker, Job in derselben Transaktion wie die Fachbuchung
- Nachtlauf je Property: Logis und Kurtaxe buchen, No-Shows, abgelaufene Optionen, Blocks freigeben, Geschäftsdatum weiterschalten, Tagesbericht
- **Idempotent**, ein zweiter Lauf desselben Tages darf nichts doppelt buchen
- Prüfliste mit Auffälligkeiten
- Alarm bei ausgefallenem Lauf

**Definition of Done:** Der Nachtlauf läuft zweimal hintereinander für denselben Tag, das Ergebnis ist identisch.

### AP 9 — Housekeeping

- Zimmerstatus, automatischer Wechsel bei Check-out
- Aufgabenverteilung, Abreise- und Bleibezimmer
- Wartungstickets

### AP 10 — Meldeschein

- Datenfelder nach § 30 Abs. 2 BMG
- Elektronische Unterschrift, Pflicht nur für ausländische Gäste
- **Keine Ausweiskopien**, nur die Dokumentnummer, verschlüsselt
- Automatischer Löschjob nach einem Jahr

**Definition of Done:** Der Löschjob entfernt Meldescheine nach Ablauf zuverlässig und protokolliert das. Ein Test weist nach, dass kein Feld für einen Dokumenten-Upload existiert.

### AP 11 — Berichte und Exporte

- Belegung, ADR, RevPAR, Pickup
- Anreise-, Abreise-, Hausliste, Offene Posten
- **DATEV-Format-Datei**, Stufe 1 nach [09-kassenbuch.md](09-kassenbuch.md)
- GoBD-Export mit Strukturbeschreibung
- Vorlage für die Verfahrensdokumentation

### AP 12 — Rezeptions-Oberfläche

Startet, sobald AP 5 steht, und läuft parallel weiter.

- React, Vite, TanStack Query und Router, Tailwind
- Typen aus `packages/contracts`, keine handgeschriebenen API-Typen
- Zimmerplan, Reservierungsmaske, Check-in, Check-out, Folio, Listen
- Deutsch und Englisch von Anfang an

### AP 13 — Integrationen

- Webhooks mit Signatur und Wiederholung
- ARI-Schnittstelle für Channel Manager
- Payment-Adapter, Stripe zuerst
- Kassenschnittstelle in beide Richtungen
- Öffentliches Entwicklerportal mit Selbstbedienungs-Registrierung

### AP 14 — Datenimport aus Altsystemen

Aus [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md): Der Zielkunde ist der Migrationskandidat. Ohne Importer gewinnen wir keine Kunden.

- Generisches Importformat, dazu Adapter für hotline, HS/3 und protel
- Trockenlauf mit Bericht vor dem Übernehmen
- Stichtagsmigration mit Abgleich

---

## 3. Reihenfolge und Abhängigkeiten

```
AP0 ──┬─▶ AP1 ──┬─▶ AP2 ──▶ AP3 ──▶ AP4 ──▶ AP5 ──┬─▶ AP7 ──▶ AP8 ──▶ AP11
      │         │                                  ├─▶ AP9
      │         └─▶ AP6 ─────────────────────────  ┼─▶ AP10
      │                                            └─▶ AP12 (parallel)
      └────────────────────────────────────────────── AP13, AP14 (später)
```

**Stufe 1 der Roadmap ist erreicht mit AP 0 bis 12.** Das ist das erste verkaufbare Produkt.

---

## 4. Teststrategie

### Der Abfragezähler ist der wichtigste Test im Projekt

```ts
test('Zimmerplan macht konstant drei Abfragen', async () => {
  const z = await zaehleAbfragen(() =>
    client.get('/v1/properties/1/tape-chart?from=2026-10-01&to=2026-10-31')
  )
  expect(z.anzahl).toBeLessThanOrEqual(3)
})
```

Er fängt jedes versehentlich eingeführte N+1 in dem Moment ab, in dem es entsteht, statt drei Monate später beim ersten großen Kunden. Er existiert vor dem ersten echten Endpunkt.

### Weitere Ebenen

| Ebene | Inhalt |
|---|---|
| Fachlogik | Zustandsautomat, Preisberechnung, Steueraufteilung, Stornoregeln. Ohne Datenbank |
| Integration | Jeder Endpunkt gegen echtes PostgreSQL über Testcontainers. Keine Datenbank-Mocks |
| Nebenläufigkeit | Gleichzeitige Buchungen, gleichzeitige Rechnungserstellung, Deadlock-Freiheit |
| Berechtigung | Für jede Route: fremder Mandant, fehlender Scope, manipulierter Pfadparameter |
| Vertrag | Generierte OpenAPI gegen veröffentlichte, brechende Änderung bricht den Build |
| Last | Gegen den Seed-Datensatz, gegen das Latenzbudget aus Dokument 04 |

### Latenzbudget in der CI

Überschreitung bricht den Build. Die Werte stehen in Abschnitt 2.8 von [04-api-first-und-performance.md](04-api-first-und-performance.md).

---

## 5. Auslieferung

### CI-Pipeline

```
push → Lint → Typecheck → Unit → Integration (Testcontainers)
     → Vertragstest → Build → Lasttest gegen Budget → Artefakt
```

### Auslieferung nach Staging und Produktion

1. Artefakt nach `/opt/hotelpms/releases/<zeitstempel>/` entpacken
2. Migrationen einspielen, **nur additiv**
3. `current`-Symlink umlegen
4. `systemctl reload hotelpms-api`, gestaffelt über die Prozesse
5. Worker neu starten
6. Rauchtest gegen die Produktionsadresse

**Migrationen sind immer vorwärtskompatibel.** Erst Spalte hinzufügen, dann Code ausliefern, der sie nutzt, dann alte Spalte in einer späteren Migration entfernen. Nie Code und brechende Migration in einem Schritt, sonst gibt es kein Zurück.

### Sicherungen

| Was | Wie | Prüfung |
|---|---|---|
| PostgreSQL | Kontinuierliche WAL-Archivierung plus täglicher Basis-Dump, verschlüsselt, an einen zweiten Ort | **Monatliche Wiederherstellungsübung**, sonst ist es keine Sicherung |
| Dateien, PDFs | Objektspeicher mit Versionierung | |
| Plesk-Konfiguration | Plesk-eigene Sicherung | |

---

## 6. Was zuerst zu tun ist

1. Repository aufsetzen, AP 0 vollständig, inklusive Seed und Abfragezähler.
2. Den API-Entwurf als Dokument festlegen, bevor Endpunkte entstehen.
3. AP 1 und AP 4 sind die beiden Pakete mit dem höchsten Risiko. Sie sollten früh und gründlich gemacht werden, nicht nebenbei.
4. Erst danach in der Reihenfolge weiter.

Punkt 1 vor Punkt 4 ist unbequem und der einzige Weg, wie Performance und Mandantentrennung dauerhaft erhalten bleiben.
