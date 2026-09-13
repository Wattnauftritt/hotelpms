# Arbeitsstand und offene Aufgaben

Stand: 13. September 2026. 164 Tests, 18 Migrationen.

Dieses Dokument ist die Übergabe. Es sagt, was steht, und zerlegt das Offene in Aufgaben, die **einzeln und ohne Rückfrage** bearbeitet werden können. Die Regeln, die dabei gelten, stehen in [`CLAUDE.md`](../CLAUDE.md).

---

## 1. Was steht

| Paket | Stand | Wo |
|---|---|---|
| AP 0 Grundgerüst | fertig | Monorepo, CI, Testaufbau |
| AP 1 Mandanten und Rollen | fertig | `0002`, `0003`, `0018`, `platform/auth.ts` |
| AP 2 Stammdaten und Einrichtung | fertig | `0004`, `0013`, `routes/setup.ts` |
| AP 3 Raten, Restriktionen, Steuern | fertig | `0007`, `0016`, `routes/rates.ts` |
| AP 4 Verfügbarkeit | fertig | `0005`, `0006`, `routes/availability.ts` |
| AP 5 Reservierungen | fertig | `0009`, `routes/reservations.ts` |
| AP 6 Gäste und Firmen | fertig | `0008`, `0015`, `routes/guests.ts` |
| AP 7 Folio und Rechnung | fertig bis auf ZUGFeRD | `0010`, `0012`, `0017`, `routes/billing.ts` |
| AP 8 Nachtlauf | fertig | `jobs/nightAudit.ts`, `0014` |
| AP 9 Housekeeping | fertig | `0011`, `routes/housekeeping.ts` |
| AP 10 Meldeschein | fertig | `routes/registrations.ts` |
| AP 11 Berichte und Exporte | fertig | `routes/reports.ts` |
| AP 11b CSV-Import | fertig | `routes/import.ts`, `platform/csv.ts` |
| AP 12 Rezeptions-Oberfläche | fertig | `apps/web` |
| AP 13 Integrationen | **offen** | Aufgaben 4 bis 7 |
| AP 14 Import aus Altsystemen | **offen** | Aufgabe 8 |

**52 Endpunkte**, alle mit deklarierter Berechtigung. Ein Vertragstest prüft, dass jeder in der OpenAPI-Beschreibung steht.

### Was das System nachweislich kann

Diese Eigenschaften sind durch Tests belegt, nicht behauptet:

- 50 gleichzeitige Buchungen auf das letzte freie Zimmer: genau eine gewinnt, der Zähler stimmt.
- 20 gleichzeitige Check-outs: 20 lückenlose Rechnungsnummern ohne Doppelvergabe.
- Ein Token für Haus A bekommt bei manipuliertem Pfadparameter Haus B nicht, und auch bei vergessener `WHERE`-Bedingung greift die Zeilenrichtlinie.
- Plattformpersonal sieht ohne kundenseitig freigegebene Supportsitzung nichts.
- Der Nachtlauf läuft zweimal für denselben Tag mit identischem Ergebnis über alle berührten Tabellen.
- Eine festgeschriebene Rechnung lässt sich nicht mehr ändern.
- Ein Import mit einer fehlerhaften Zeile schreibt gar nichts.

---

## 2. Offene Aufgaben

Jede ist so geschnitten, dass sie **allein** bearbeitet werden kann. Genannt sind Zweck, Umfang, Abnahmekriterium und was ausdrücklich **nicht** dazugehört.

---

### Aufgabe 1 — ZUGFeRD und PDF/A-3 für die Rechnung

**Warum.** Die B2B-Ausstellungspflicht kommt gestaffelt bis 2028. ZUGFeRD ist PDF/A-3 mit eingebettetem CII-XML nach EN 16931. Ohne das sind Firmenrechnungen ab dem Stichtag nicht mehr verkehrsfähig (E3 in Dokument 13).

**Umfang.**
- Erzeugung des CII-XML aus `invoice`, `charge` und den beiden Momentaufnahmen. Profil EN 16931, mindestens die Pflichtfelder BT-1 bis BT-155.
- PDF-Erzeugung im Worker, danach Konvertierung nach PDF/A-3 und Einbettung des XML.
- Ein Endpunkt, der die Rechnung als PDF liefert.

**Anhaltspunkte.** `packages/domain/src/invoiceRequirements.ts` prüft bereits die Pflichtangaben und hat die passende Feldstruktur. `invoice.service_from` und `service_to` liegen vor. Chromium erzeugt gewöhnliches PDF, nicht PDF/A-3; es braucht einen zweiten Schritt, etwa Ghostscript.

**Abnahme.** Eine erzeugte Rechnung besteht die Prüfung eines ZUGFeRD-Validators im Profil EN 16931. Ein Test vergleicht das erzeugte XML feldweise gegen eine erwartete Fassung.

**Nicht dazu.** Versand per E-Mail. Peppol.

---

### Aufgabe 2 — OAuth-Autorisierungsserver

**Warum.** Fremdsysteme, Channel Manager und ein späteres Entwicklerportal brauchen einen Zugang, der nicht das Sitzungscookie der Rezeption ist. Der Server ist in Dokument 10 benannt, aber nicht gebaut (C2 in Dokument 13).

**Umfang.**
- `node-oidc-provider`, Client Credentials für Maschinen, Authorization Code mit PKCE für Anwendungen im Namen eines Nutzers.
- Zugriffsbereiche (Scopes) auf den bestehenden Berechtigungskatalog abbilden.
- `oauth_client` ist bereits angelegt.
- `loadPrincipal` muss auch aus einem Token einen Principal bauen können, nicht nur aus einer Sitzung.

**Abnahme.** Ein Maschinentoken erreicht genau die Endpunkte seiner Zugriffsbereiche und keinen weiteren. Der generische Berechtigungstest läuft auch über den Tokenweg.

**Nicht dazu.** Das Entwicklerportal als Oberfläche.

---

### Aufgabe 3 — Anzahlungen und ihre Steuerpflicht

**Warum.** Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Steuer bei Anzahlungen mit der Vereinnahmung, nicht mit der Leistung. Das Modell kennt `invoice.kind = 'deposit'`, aber es gibt keinen Weg, eine Anzahlung zu fordern, zu vereinnahmen und später gegen die Schlussrechnung zu verrechnen (B4 in Dokument 13).

**Umfang.**
- Anzahlungsrechnung erstellen, mit eigener Nummer aus demselben Zähler.
- Verrechnung in der Schlussrechnung als eigene Position mit negativem Betrag und Verweis auf die Anzahlungsrechnung.
- `deposit_ledger` als eigener Saldo neben dem Gastkonto.

**Abnahme.** Eine Anzahlung von 200 Euro auf einen Aufenthalt von 500 Euro ergibt eine Schlussrechnung über 500 Euro mit ausgewiesener Anrechnung und 300 Euro offen. Die Steuer der Anzahlung ist im Monat der Vereinnahmung ausgewiesen.

**Vorher klären.** Die steuerliche Behandlung ist mit einem Steuerberater zu bestätigen; das steht als offener Punkt in Dokument 02.

---

### Aufgabe 4 — Webhooks

**Warum.** Ohne ausgehende Ereignisse muss jedes Fremdsystem fragen statt zu erfahren.

**Umfang.**
- Abonnements je Account, Ereignisarten aus dem Fachmodell (Reservierung angelegt, geändert, storniert, Check-in, Check-out, Rechnung festgeschrieben).
- Signatur über einen gemeinsamen Schlüssel, Zeitstempel gegen Wiedereinspielung.
- Wiederholung mit wachsendem Abstand, Stilllegung nach dauerhaftem Fehlschlag.
- Einreihen in **derselben Transaktion** wie die Fachbuchung. Das ist der Grund für Graphile Worker.

**Abnahme.** Ein Empfänger, der dreimal mit 500 antwortet, bekommt die Zustellung mit wachsendem Abstand erneut; nach der letzten Wiederholung ist das Abonnement stillgelegt und im Protokoll sichtbar. Eine zurückgerollte Fachbuchung stellt nichts zu.

---

### Aufgabe 5 — ARI-Schnittstelle für Channel Manager

**Warum.** Der Zielkunde verkauft über Portale. Ohne Verfügbarkeits-, Raten- und Restriktionsabgleich ist das System für ihn nicht benutzbar.

**Umfang.**
- Ausgehend: Verfügbarkeit, Raten und Restriktionen je Kategorie und Tag, als Änderungsmeldung und als Vollabgleich.
- Eingehend: Reservierungen des Portals, mit `booking.external_reference` als Schlüssel gegen Doppelanlage.
- Erste Anbindung an einen Channel Manager, laut Dokument 02 unter anderem Roomcloud.

**Abnahme.** Eine Reservierung des Portals bindet Kontingent über `inventory_reserve`, nicht über einen direkten Schreibzugriff. Ein zweiter Eingang derselben externen Nummer legt nichts doppelt an.

---

### Aufgabe 6 — Payment-Adapter

**Warum.** Pay-by-Link ist der einzige vorgesehene Weg, eine Buchung zu garantieren, ohne Kartendaten anzufassen.

**Umfang.** Adapter für Stripe zuerst, danach Adyen und Mollie. Zahlungsaufforderung erzeugen, Rückmeldung verarbeiten, Ergebnis als `settlement` mit `external_reference` vermerken.

**Abnahme.** Eine erfolgreiche Zahlung erzeugt genau einen Zahlungsvermerk. Eine doppelte Rückmeldung erzeugt keinen zweiten. Nirgends im System steht eine Kartennummer.

---

### Aufgabe 7 — Kassenschnittstelle

**Warum.** Das Haus hat eine Kasse mit TSE. Ihre Umsätze sollen auf das Gastkonto laufen, ohne dass dieses System zur Kasse wird.

**Umfang.** Eingehend: Buchung eines Kassenumsatzes auf ein Folio. Ausgehend: offene Folios für die Kasse sichtbar machen.

**Abnahme.** Ein Kassenumsatz erscheint als `charge` mit Herkunftsvermerk. Es entsteht **kein** Kassenbestand und **kein** Bon in diesem System.

---

### Aufgabe 8 — Import aus Altsystemen

**Warum.** Der Zielkunde ist Migrationskandidat. Ohne Importer gewinnt das Produkt keine Kunden (Dokument 05).

**Umfang.** Generisches Importformat mit Adaptern für hotline, HS/3 und protel. Trockenlauf mit Bericht. Stichtagsmigration mit Abgleich.

**Anhaltspunkte.** `routes/import.ts` hat die Mechanik bereits: Trockenlauf als Regelfall, ganz oder gar nicht, Bindung über dieselben Inventarfunktionen. Der Adapter muss nur auf dieses Format abbilden.

**Abnahme.** Ein Altbestand von 5000 Reservierungen läuft ohne überbuchte Kategorietage durch. Der Abgleich nennt jede nicht übernommene Zeile mit Grund.

---

### Aufgabe 9 — Betriebsvoraussetzungen für Fremdkunden

**Warum.** Für das Pilothaus im eigenen Betrieb tragbar, für zahlende Kunden nicht.

**Umfang.**
- Plattenverschlüsselung der VM (C3).
- Schlüsselrotation als Betriebsdokument mit erprobtem Ablauf (C4). Die Schlüsselversion liegt bereits an jedem verschlüsselten Feld.
- Verschlüsselte Sicherung außer Haus, mit erprobter Rückspielung.
- Ratenbegrenzung je IP am Rand (C7).
- Trainingsmodus je Property (C11). `property.is_training` ist angelegt, wird aber nirgends ausgewertet.
- Archivierung ausscheidender Betriebe mit vollständigem Mandantenexport (E7).

**Abnahme.** Eine Rückspielung aus der Sicherung ist einmal durchgeführt und protokolliert.

---

### Aufgabe 10 — Kleinere Lücken

Jede für sich klein, zusammen ein Nachmittag.

| Lücke | Wo |
|---|---|
| Verlängerung mit Kategoriewechsel als atomarer Fall (E11) | `routes/reservations.ts` |
| `no_show_cutoff` und `guaranteed` auswerten (B10) | `jobs/nightAudit.ts`, Schritt 4 |
| Routing-Regeln anwenden, wenn der Nachtlauf bucht | `jobs/nightAudit.ts`, Schritt 2 |
| Alarm bei ausgefallenem Nachtlauf | `apps/worker` |
| Gruppen und Kontingente in der Oberfläche | `apps/web` |
| Folio-Bildschirm in der Oberfläche | `apps/web` |

---

## 3. Fallstricke, die schon einmal zugeschlagen haben

Wer hier arbeitet, spart sich diese Wege ein zweites Mal.

| Falle | Was passierte |
|---|---|
| Lesen ohne Mandantenkontext | Zweimal still kaputt: der Benutzer sah seine eigenen Häuser nicht, und eine Account-Rolle wirkte auf gar kein Haus |
| Trigger je Zeile bei Massenänderung | 250 Zimmer anzulegen dauerte 28 Sekunden statt 59 Millisekunden |
| Zähler als Aufzeichnung benutzt | Die Auslastung der Vergangenheit wurde mit 0,3 Prozent statt 63 Prozent gemeldet |
| `ORDER BY similarity(...)` statt Abstandsoperator | Die Namenssuche las die ganze Tabelle, 147 statt 14 Millisekunden |
| Korrelierte Unterabfrage je Zeile | Der Saatlauf kam nicht über den Schritt hinaus und musste abgebrochen werden |
| snake_case gelesen, camelCase geprüft | Die Anschrift verschwand lautlos, die Rechnung wurde grundlos abgewiesen |
| Frist gegen `now()` statt gegen den Geschäftstag | Ein Wiederholungslauf hätte andere Zeilen gefunden als der erste |
| Zwei Testrollen zusammen vergeben | Verdeckte, dass jede einzeln nicht funktionierte |

Die drei Leistungsbefunde stehen ausführlich in [`15-messungen-aus-dem-saatlauf.md`](15-messungen-aus-dem-saatlauf.md).

---

## 4. Umgebung

`.claude/hooks/session-start.sh` richtet eine frische Sitzung vollständig ein: Abhängigkeiten, PostgreSQL, Rollen, Datenbanken, Schema. Von Hand tut `scripts/setup-db.sh` den Datenbankteil.

Scheitern die Tests mit `ECONNREFUSED` auf Port 5432, liegt es nicht an den Tests, sondern daran, dass die Datenbank nicht läuft.

---

## 5. Vor dem Pushen

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Alle vier grün. Der Saatlauf (`pnpm db:seed`) ist kein Teil der Prüfung, aber wer an Abfragen arbeitet, sollte einmal dagegen messen: kleine Datenmengen verbergen genau die Fehler, die im Betrieb zählen.
