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
    caddy/               Caddyfile
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
- **`public_ref` als Konvention** auf jeder nach außen sichtbaren Entität (C1 in Dokument 13)
- **`app.user_id` je Transaktion**, vom Audit-Trigger gelesen, mit Test auf leeren Benutzer (C5)
- **Zwei Verbindungsziele:** API über PgBouncer, Worker direkt (D1)
- **`pg_trgm`** aktiviert

**Definition of Done:** Ein leerer Endpunkt ist erreichbar, die CI ist grün, der Abfragezähler schlägt bei einem absichtlich eingebauten N+1 fehl, eine Route ohne Berechtigungsangabe bricht den Build, der Seed läuft in unter fünf Minuten durch.

### AP 1 — Mandanten, Nutzer, Zugriff

- `account`, `property`, `user`, `role`, `permission`, `role_permission`, `user_account_role`, `user_property_role`, `support_session`, `oauth_client`, nach [14-benutzerrollen.md](14-benutzerrollen.md)
- Berechtigungskatalog als Seed, dreizehn Systemrollen für Hotels, vier für die Plattform
- Arbeitsplatz-Anmeldung mit persönlicher PIN für geteilte Rezeptions-PCs und Tablets
- Support-Sitzung mit Freigabe durch den Kunden, Ablauf und `support_session_id` im Audit-Log
- Einladungsfluss statt Nutzeranlage durch uns
- Argon2id, Anmeldung, Sitzungen, Sperrung nach Fehlversuchen
- OAuth 2.0: Authorization Code + PKCE und Client Credentials
- Scopes und Rechteprüfung als Middleware
- **Mandantenkontext aus dem Token**, nie aus einem Parameter des Clients
- **Row Level Security** auf allen Tabellen mit `property_id`, siehe [12-security-und-performance-review.md](12-security-und-performance-review.md)
- TOTP für Rollen mit Verwaltungsrechten
- **Autorisierungsserver: `node-oidc-provider`**, eingebettet, keine Eigenentwicklung der Protokollteile (C2)
- Sitzungen in PostgreSQL mit Aufräumjob, eigene RLS-Richtlinien für `session`, `user`, `account`, `oauth_client` (C6)
- Ratenbegrenzung: Caddy je IP am Rand, API je Client-ID im Prozess (C7)

**Definition of Done:** Ein Test weist nach, dass ein Token für Property A auf keiner Route Daten von Property B erhält, auch nicht bei manipuliertem Pfadparameter. Ein zweiter Test weist nach, dass RLS auch bei einer absichtlich fehlenden `WHERE`-Bedingung greift. Ein dritter weist nach, dass ein Plattform-Admin **ohne** aktive Support-Sitzung auf keiner Route eine einzige Kundenzeile erhält. Der generische Berechtigungstest läuft mit jeder Systemrolle gegen jede Route.

### AP 2 — Inventar

- `resource_category`, `resource`, Attribute, Sortierung
- `maintenance_block` mit Out of Order und Out of Service
- Änderungen an Kapazität schreiben `inventory_day` fort

**Definition of Done:** Ein zusätzliches Zimmer erhöht die Kapazität aller künftigen Tage der Kategorie, eine Out-of-Order-Sperrung senkt sie im Zeitraum. Beides in einer Transaktion, beides mit Test.

**Umgesetzt**, mit einem Ablauf für die Einrichtung, der in der ursprünglichen Planung fehlte. Jedes Hotel hat einen anderen Zuschnitt: ein Ferienhaus hat drei Wohnungen mit Namen, ein Stadthotel 180 Zimmer in sieben Kategorien nach Etagen, ein Gutshof hat Zimmer, Ferienwohnungen und Tagungsräume in einer Anlage. Es gibt keine Vorlage, die davon mehr als die Hälfte trifft. Vier Regeln folgen daraus:

1. **Zimmer werden nicht gelöscht, sondern stillgelegt.** An einem Zimmer hängen Reservierungen, Rechnungen und Meldescheine. Ein `DELETE` würde entweder am Fremdschlüssel scheitern oder Geschichte vernichten. Ein stillgelegtes Zimmer zählt nicht mehr zur Kapazität, seine Vergangenheit bleibt lesbar.
2. **Zimmer entstehen in Serie.** Niemand tippt 180 Zimmer einzeln. Die Eingabe ist „101 bis 130, erste Etage, alles Doppelzimmer": Vorsatz, Nummernbereich, führende Nullen, Nachsatz, und einzelne auszulassende Nummern für die 13 oder die 404. Der Vorsatz trägt auch Namen ohne Nummernlogik, etwa „Wohnung 1 Nord".
3. **Vorschau vor dem Anlegen.** Dieselbe Regel wie beim Import: ohne `commit` wird nichts geschrieben, aber alles geprüft, und der Bericht nennt je Nummer, ob sie entstünde oder schon vergeben ist. Eine Serie von 180 Zimmern mit einem Zahlendreher im Muster ist mühsam zurückzunehmen.
4. **Ein Prüfstand sagt, was noch fehlt.** Eine Einrichtung scheitert selten an einem schweren Fehler, sondern daran, dass ein Schritt vergessen wurde und die erste Buchung mit „nicht materialisiert" abgewiesen wird. `setup-status` nennt den nächsten fehlenden Schritt und unterscheidet **buchbar** (Gruppen, Zimmer, Inventar) von **vollständig** (dazu Steuern, Raten, Preise, Zahlungsarten, offener Geschäftstag).

Zwei Änderungen werden bewusst abgewiesen statt still zugelassen: eine Gruppe oder ein Zimmer mit künftigen Reservierungen stillzulegen. Beides zöge Kapazität unter gebuchten Aufenthalten weg, ohne dass es jemandem auffiele. Erst umbuchen, dann stilllegen.

Ein Umzug zwischen Gruppen verschiebt die Kapazität von der einen zur anderen; die Haussumme bleibt gleich. Der Trigger aus [Migration 0013](../packages/db/migrations/0013_capacity_bulk.sql) rechnet beide Seiten in einer Anweisung nach.

### AP 3 — Raten und Steuern

- `rate_plan`, `rate_day`, `restriction_day`, `cancellation_policy`
- Abgeleitete Raten mit Betrag oder Prozent auf eine Basisrate
- `tax_rule`: Umsatzsteuer 7 und 19 Prozent, Kurtaxe je Gemeinde mit Ausnahmen
- Massenpflege über einen Aufruf für einen Zeitraum

**Kurtaxe umgesetzt** ([Migration 0016](../packages/db/migrations/0016_city_tax.sql)). Kommunal geregelt und deshalb in jeder Gemeinde anders. Aus den Satzungen, die in der Praxis vorkommen, ergeben sich fünf Achsen, und jede einzelne fehlt irgendwo, wenn man sie nicht von Anfang an vorsieht:

| Achse | Warum sie nötig ist |
|---|---|
| Betrag je Person und Nacht, je Nacht, oder prozentual | Alle drei Formen kommen vor, letztere als Bettensteuer |
| Altersfreigrenze | Fast jede Satzung nimmt Kinder aus; die Grenze liegt je nach Ort bei 6, 14, 16 oder 18 Jahren |
| Geschäftsreisende | In vielen Städten ist die Übernachtungsteuer beruflich veranlasst nicht zu zahlen |
| Obergrenze der Nächte | Viele Satzungen enden nach der 21. oder 28. Übernachtung |
| Gültigkeitszeitraum | Sätze ändern sich zum Jahreswechsel, und eine Dezembernacht muss den alten Satz behalten |

Die Altersfreigrenze ist der Grund, warum `reservation_occupant` das Alter führt und nicht bloß eine Anzahl Kinder (B7). Aus einer Anzahl lässt sich keine Grenze rechnen.

Zwei Festlegungen, die nicht selbsterklärend sind: **ein Gast ohne Altersangabe gilt als erwachsen** — lieber zu viel erheben und auf Nachweis erlassen als zu wenig und bei der Prüfung nachzahlen. Und **ob die Abgabe selbst Umsatzsteuer trägt, ist ein Feld, keine Annahme im Code**: das ist Landesrecht und teils strittig.

Der erklärte Reisezweck hängt am Aufenthalt, nicht am Gastprofil: derselbe Mensch reist im März beruflich und im Juli mit der Familie. Das System hält fest, was erklärt wurde; den Nachweis führt das Haus in seiner Akte.

**Definition of Done:** Ein Preis-Push für 365 Tage über alle Kategorien läuft in einer Datenbankrunde und unter 300 Millisekunden. Die Steueraufteilung eines Paketpreises ist testgedeckt.

### AP 4 — Verfügbarkeit

**Das wichtigste Paket. Hier entscheidet sich die Korrektheit des Systems.**

- `inventory_day` mit Zählern
- **Genau ein Besitzer:** die drei SQL-Funktionen `inventory_reserve`, `inventory_release`, `inventory_set_capacity`. Die Anwendungsrolle hat kein `UPDATE` auf die Tabelle
- Trigger auf `maintenance_block` und `resource` rufen `inventory_set_capacity`, sie schreiben nicht selbst
- Materialisierungsjob für einen rollierenden Horizont von 24 Monaten, plus Alarm bei zu wenig Vorlauf
- Belegung mit Kapazitätsprüfung in einer Anweisung, Fehlerfall unterscheidet „ausgebucht" von „nicht materialisiert"
- **Haussummenzeile** `category_id = 0`, in derselben Anweisung geprüft (B2)
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
- `reservation_occupant` mit Alter statt Zähler (B7)
- Verlängerung mit Kategoriewechsel als atomarer Fall (E11)
- `no_show_cutoff` und `guaranteed` an `cancellation_policy` (B10)

**Definition of Done:** Jeder unerlaubte Zustandsübergang wird abgewiesen und ist getestet. Der Zimmerplan über 30 Tage und 250 Zimmer liefert in unter 80 Millisekunden mit drei Abfragen.

### AP 6 — Gäste und Firmen

- `guest`, `company`, Dublettenerkennung
- Suche über Name, E-Mail, Telefon, Buchungsnummer
- Historie eines Gastes
- Löschkonzept: Sperren und Anonymisieren statt Löschen
- **DSGVO-Auskunft** als Job, Archiv aller Daten zu einer Person (C9)
- Trigramm-Indizes auf Name, E-Mail, Telefon (D2)
- Gästeprofil je Account, hausbezogene Notizen je Property (Entscheidung 13)

**Definition of Done:** Eine Löschanfrage nach DSGVO anonymisiert den Gast, lässt die Rechnungen mit historischem Namen bestehen und ist protokolliert.

**Umgesetzt.** Zwei Präzisierungen aus der Umsetzung:

- **Die Dublettenerkennung warnt, sie blockiert nicht.** Ein System, das das Anlegen verweigert, wird an der Rezeption mit „Müller2" umgangen, und dann stehen zwei Profile da statt einer Warnung. Die Antwort auf das Anlegen enthält die möglichen Dubletten samt Grund; die Entscheidung bleibt beim Menschen.
- **Die Ausweisnummer liegt hinter einer eigenen Berechtigung und einer eigenen Anfrage.** Sie läuft nicht bei jeder Gastanzeige mit, wird standardmäßig maskiert geliefert, und jeder Abruf steht einzeln im Protokoll. Verschlüsselt mit AES-256-GCM und Schlüsselversion, damit eine Rotation ohne Stillstand möglich ist.

### AP 7 — Folio, Rechnung, GoBD

- `folio`, `charge`, `settlement`, `payment_method`, `routing`
- Split Billing und Sammelrechnung
- **Lückenlose Rechnungsnummern über eine gesperrte Zählerzeile**, nicht über eine Sequenz
- Festschreiben, Storno als Gegenbuchung
- Rechnungs-PDF im Worker, danach **Konvertierung nach PDF/A-3 und ZUGFeRD-Einbettung** (E3)
- Rechnung als Charge-Menge, Zwischen- und Anzahlungsrechnung, Momentaufnahmen, Steuer je Satzgruppe (B3 bis B6)
- Prüfliste der Pflichtangaben nach § 14 UStG, ein Test je Angabe, Deutsch und Englisch (E4)
- Entzug von UPDATE und DELETE auf den Finanztabellen für die Anwendungsrolle

**Definition of Done:** Ein Test weist nach, dass die Anwendungsrolle eine festgeschriebene Rechnung nicht ändern kann, dass ein Rollback keine Nummernlücke erzeugt, und dass 20 gleichzeitige Check-outs 20 aufeinanderfolgende Nummern ergeben.

**Umgesetzt.** Die Prüfliste der Pflichtangaben nach § 14 UStG läuft vor dem Festschreiben und weist die Rechnung ab, solange eine Angabe fehlt. Das ist billiger als jede Korrektur: eine fehlende Pflichtangabe macht die Rechnung nicht ungültig, sie kostet dem **Empfänger** den Vorsteuerabzug — und das merkt niemand beim Ausstellen, sondern der Firmenkunde drei Monate später bei seiner Buchhaltung.

Geprüft wird, was das System wissen kann. Ob eine Anschrift richtig ist, kann es nicht wissen; ob sie da ist, schon. Die Meldung nennt **alle** Mängel auf einmal samt Fundstelle im Gesetz: wer dreimal hintereinander abgewiesen wird, weil jedes Mal ein anderes Feld fehlt, hält das System für kaputt.

Zwei Punkte, die dabei auffielen:

- **Der Leistungszeitraum ist bei Beherbergung der Aufenthalt, nicht das Rechnungsdatum.** Diese Verwechslung ist der häufigste Mangel an Hotelrechnungen. Er wird aus den Geschäftsdaten der abgerechneten Positionen abgeleitet, nicht vom Aufrufer entgegengenommen: die Positionen wissen es, der Aufrufer könnte sich irren. Und er wird mitgeschrieben statt bei Bedarf nachgerechnet, denn eine festgeschriebene Rechnung darf sich nicht ändern, auch nicht, wenn später Positionen zum selben Folio kommen.
- **Kleinbetragsrechnungen nach § 33 UStDV** brauchen bis 250 Euro brutto weder Empfänger noch Nummer noch Steuernummer. Das ist der Fall der Laufkundschaft an der Bar, und ihn wie eine Firmenrechnung zu behandeln hielte die Rezeption ohne Rechtsgrund auf.

**Umgesetzt**, mit einem Entwurfskonflikt, der erst beim Schreiben auffiel: `charge` ist Härtegrad 1 und damit unveränderlich, aber die Fakturierung muss `invoice_id` setzen dürfen. Gelöst in Migration 0012, die genau den Übergang von NULL auf einen Wert erlaubt und nichts sonst, abgesichert durch Trigger **und** spaltenweises GRANT. Ein Feld freizugeben, ohne den Rest der Zeile freizugeben, ist der einzige Weg, der die Unveränderlichkeit erhält.

### AP 8 — Nachtlauf und Jobs

- Graphile Worker, Job in derselben Transaktion wie die Fachbuchung
- Nachtlauf je Property: Logis und Kurtaxe buchen, No-Shows, abgelaufene Optionen, Blocks freigeben, Geschäftsdatum weiterschalten, Tagesbericht
- **Tageswechsel als Schritt 1**, Schrittmarken je `(property, business_date, schritt)` (B1)
- **Idempotent**, ein zweiter Lauf desselben Tages darf nichts doppelt buchen
- Streuung der Startzeit über ein Zeitfenster (P4 in Dokument 12)
- Prüfliste mit Auffälligkeiten
- Alarm bei ausgefallenem Lauf

**Definition of Done:** Der Nachtlauf läuft zweimal hintereinander für denselben Tag, das Ergebnis ist identisch.

**Umgesetzt.** Drei Punkte haben sich bei der Umsetzung gegenüber der Planung präzisiert:

- **Jeder Schritt hat eine eigene Transaktion.** Ein Lauf über alle Schritte in einer Transaktion bräuchte keine Schrittmarken, würde aber bei 300 Zimmern minutenlang Zeilen sperren. Die Marke wird in derselben Transaktion geschrieben wie die Wirkung des Schritts, nie danach.
- **Der Lauf findet seinen Geschäftstag selbst**: den ältesten Tag mit unvollständigen Schrittmarken. Nach einem Abbruch nimmt er damit genau dort wieder auf, statt den bereits geschlossenen Tag zu überspringen und die Logis der Nacht zu verlieren. Ist dieser Tag noch offen und das Geschäftsdatum nicht weiter, ist der Lauf nicht fällig; ein Neustart des Workers schließt so nicht mitten am Nachmittag den Tag ab.
- **Fristen werden gegen den Geschäftstag geprüft, nicht gegen `now()`.** Eine abgelaufene Option, die mit der Uhr gesucht wird, findet beim Wiederholungslauf andere Zeilen als beim ersten. Die Grenze ist das Ende des geschlossenen Geschäftstags in der Zeitzone der Property.

### AP 9 — Housekeeping

- Zimmerstatus, automatischer Wechsel bei Check-out
- Aufgabenverteilung, Abreise- und Bleibezimmer
- Wartungstickets

### AP 10 — Meldeschein

- Datenfelder nach § 30 Abs. 2 BMG
- Elektronische Unterschrift, Pflicht nur für ausländische Gäste
- **Keine Ausweiskopien**, nur die Dokumentnummer, verschlüsselt mit `key_version` für Rotation (C4)
- Sammelmeldeschein für Gruppen (E6)
- Automatischer Löschjob nach einem Jahr

**Definition of Done:** Der Löschjob entfernt Meldescheine nach Ablauf zuverlässig und protokolliert das. Ein Test weist nach, dass kein Feld für einen Dokumenten-Upload existiert.

### AP 11 — Berichte und Exporte

- Belegung, ADR, RevPAR, Pickup
- Anreise-, Abreise-, Hausliste, Offene Posten
- **DATEV-Format-Datei**, Stufe 1 nach [09-kassenbuch.md](09-kassenbuch.md)
- GoBD-Export mit Strukturbeschreibung, geschnitten nach `business_date`, späte Stornos im Zeitraum des Stornos (B11)
- **Monatsbericht Beherbergungsstatistik** mit Ankünften, Übernachtungen, Herkunftsländern (E2)
- Provision je Kanal aus `booking.commission_bp` (E10)
- Vorlage für die Verfahrensdokumentation

### AP 12 — Rezeptions-Oberfläche

Startet, sobald AP 5 steht, und läuft parallel weiter.

- React, Vite, TanStack Query und Router, Tailwind
- Typen aus `packages/contracts`, keine handgeschriebenen API-Typen
- Zimmerplan, Reservierungsmaske, Check-in, Check-out, Folio, Listen
- Deutsch und Englisch von Anfang an
- **Lesbare Offline-Kopie** von Anreise-, Hausliste und Zimmerstatus im Service Worker (E5)
- Kein Feld für Kartendaten, Garantie nur per Pay-by-Link oder virtuellem Terminal (E8)

**Umgesetzt**, mit vier Entscheidungen, die in der Planung offen waren:

- **Eine Herkunft für Oberfläche und Schnittstelle.** Vorher lagen sie auf `app.` und `api.`. Das erzwingt CORS mit Anmeldedaten, `SameSite=None` am Sitzungscookie und eine gepflegte Liste erlaubter Herkünfte. Jede dieser drei Stellen ist eine Gelegenheit, sich zu vertun, und ein Fehler darin ist eine Sitzungsübernahme. Unter einer Herkunft entfällt das alles; der Preis ist eine Pfadregel in Caddy. Der Name `api.` bleibt für Maschinen: Channel Manager und Kassensysteme brauchen keine Oberfläche.
- **Sitzung im `HttpOnly`-Cookie, kein Token im JavaScript.** Ein Token, das die Oberfläche lesen kann, kann auch ein eingeschleustes Skript lesen. Dazu zwei Ablaufzeiten: eine Untätigkeitsfrist, die mitwandert, und eine absolute, die feststeht. Ohne die zweite bleibt eine gestohlene Sitzung unbegrenzt gültig, solange sie benutzt wird.
- **Die Anmeldung unterscheidet nicht zwischen unbekannter Adresse und falschem Kennwort**, und sie verbraucht auch für eine unbekannte Adresse Rechenzeit. Sonst antwortet sie für Unbekannte in zwei Millisekunden und für Bekannte in hundert, und damit lässt sich die Benutzerliste abfragen, ohne ein Kennwort zu kennen.
- **Offline nur lesend.** Anreise-, Hausliste und Zimmerstatus liegen lokal und sind bei Netzausfall lesbar. Ausdrücklich nicht offline: alles Schreibende. Eine Buchung, die im Browser wartet und später hochgeht, bindet Kontingent, das inzwischen jemand anders verkauft hat. Ein Kalender, der Doppelbelegungen erzeugt, ist schlimmer als eine Fehlermeldung.

Der Zimmerplan zeichnet **einen Balken je Reservierung**, nicht eine Zelle je Nacht: ein Aufenthalt ist eine Sache und wird als eine gelesen. Der Balken endet am Abreisetag, denn die Abreisenacht gibt es nicht, und ein Balken, der in den Abreisetag hineinreicht, lässt ein verkäufliches Zimmer belegt aussehen. Nicht zugewiesene Reservierungen stehen oben statt unsichtbar unten; sie sind die Arbeit des Tages.

Kein Feld für Kartendaten, nirgends (E8). Eine Garantie läuft über Pay-by-Link oder das virtuelle Terminal des Zahlungsdienstleisters.

### AP 13 — Integrationen

- Webhooks mit Signatur und Wiederholung
- ARI-Schnittstelle für Channel Manager
- Payment-Adapter, Stripe zuerst
- Kassenschnittstelle in beide Richtungen
- Öffentliches Entwicklerportal mit Selbstbedienungs-Registrierung

### AP 11b — Minimaler CSV-Import (Stufe 1)

Das Pilothaus hat am Starttag bereits Reservierungen für Monate. Ohne die geht es nicht produktiv (E1). Daher nach Stufe 1 vorgezogen:

- CSV-Import für künftige Reservierungen, Gäste und Kategorien
- Trockenlauf mit Bericht vor dem Übernehmen
- Läuft durch dieselben Dienstfunktionen wie die Oberfläche, damit Inventar und Audit stimmen

**Umgesetzt.** Drei Eigenschaften trennen einen Import von einem Datenunfall:

1. **Der Trockenlauf ist der Regelfall.** Ohne `commit: true` wird nichts geschrieben, aber alles geprüft, und der Bericht ist derselbe. Technisch trägt ein Fehlerwurf das Ergebnis aus der Transaktion heraus und rollt sie dabei zurück; ein Ende mit `if (commit) COMMIT` ließe zu leicht eine Abzweigung offen, die doch schreibt.
2. **Ganz oder gar nicht.** Eine einzige fehlerhafte Zeile rollt den gesamten Lauf zurück. Ein halb übernommener Bestand ist schlimmer als keiner, weil niemand weiß, welche Hälfte fehlt.
3. **Dieselben Funktionen wie die Oberfläche.** Das Kontingent wird über `inventory_reserve` gebunden, nicht danebengeschrieben. Sonst stimmen die Zähler ab dem ersten Tag nicht.

Dazu zwei Zugeständnisse an die Wirklichkeit: Datum als `TT.MM.JJJJ` **oder** ISO, Beträge als `1.234,50` **oder** `1234.50`. Das Altsystem liefert selten, was die Norm vorsieht.

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

### Stand der Umsetzung

| Paket | Stand |
|---|---|
| AP 0 Grundgerüst | fertig |
| AP 1 Mandanten und Rollen | fertig, Account-Rollen wirken (Migration 0018) |
| AP 2 Stammdaten und Einrichtung | fertig, Zimmerserie mit Vorschau und Prüfstand |
| AP 3 Raten, Restriktionen, Steuern | fertig, Kurtaxe je Gemeinde |
| AP 4 Verfügbarkeit | fertig, Nebenläufigkeitstest besteht |
| AP 5 Reservierungen | fertig |
| AP 6 Gäste und Firmen | fertig |
| AP 7 Folio und Rechnung | fertig, § 14 UStG geprüft; PDF/A-3 und ZUGFeRD offen |
| AP 8 Nachtlauf | fertig, Definition of Done nachgewiesen |
| AP 9 Housekeeping | fertig |
| AP 10 Meldeschein | fertig |
| AP 11 Berichte und Exporte | fertig |
| AP 11b CSV-Import | fertig |
| AP 12 Rezeptions-Oberfläche | **teilweise**, sieben Bildschirme; Reservierungsmaske, Gast und Check-in fehlen (siehe [`19-frontend.md`](19-frontend.md)) |
| AP 13 Integrationen | offen |
| AP 14 Import aus Altsystemen | offen |

Dazu quer über alle Pakete: die Schnittstellenbeschreibung nach OpenAPI 3.1 entsteht aus der Routenregistrierung, ein Vertragstest hält beide zusammen. Ein Saatlauf erzeugt vier Häuser zu je 250 Zimmern über drei Jahre und misst daran die Abfragen, die im Betrieb zählen.

**Stufe 1 ist backendseitig erreicht, als Produkt noch nicht.** Hier stand einmal, sie sei mit AP 0 bis 12 plus 11b erreicht und das erste verkaufbare Produkt. Das war falsch, und der Fehler ist lehrreich genug, um stehen zu bleiben: AP 12 nennt oben ausdrücklich die **Reservierungsmaske**, die Statuszeile zählte vier gebaute Bildschirme auf, und keiner davon war sie. Der Stand wurde also gegen das Gebaute geprüft statt gegen das Geplante — dieselbe Klasse stiller Fehler, gegen die dieses System sonst gebaut ist, nur in einer Tabelle statt in einer Abfrage.

Verkaufbar ist das Produkt, wenn die Oberfläche kann, was AP 12 nennt. Die Lücke ist in [`19-frontend.md`](19-frontend.md) gegen die vollständige Routenliste ausgemessen und in [`20-arbeitsteilung.md`](20-arbeitsteilung.md) auf drei Spuren verteilt. Dazu aus Dokument 13 die Betriebsvoraussetzungen: Plattenverschlüsselung (C3), Schlüsselrotation als Betriebsdokument (C4), Redaktionsliste für Logs (C8), Trainingsmodus je Property (C11), Archivierung ausscheidender Betriebe mit Mandantenexport (E7).

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
| VM | Proxmox Backup Server, verschlüsselt an einen zweiten Standort | Monatliche Wiederherstellungsübung |

---

## 6. Was zuerst zu tun ist

1. Repository aufsetzen, AP 0 vollständig, inklusive Seed und Abfragezähler.
2. Den API-Entwurf als Dokument festlegen, bevor Endpunkte entstehen.
3. AP 1 und AP 4 sind die beiden Pakete mit dem höchsten Risiko. Sie sollten früh und gründlich gemacht werden, nicht nebenbei.
4. Erst danach in der Reihenfolge weiter.

Punkt 1 vor Punkt 4 ist unbequem und der einzige Weg, wie Performance und Mandantentrennung dauerhaft erhalten bleiben.
