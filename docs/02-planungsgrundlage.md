# Planungsgrundlage für unser eigenes PMS

Abgeleitet aus der [Marktanalyse](01-marktanalyse-pms.md). Dieses Dokument ist ein Vorschlag als Diskussionsbasis, keine finale Entscheidung. Offene Punkte stehen am Ende.

## 1. Leitlinien

- **API-first.** Alles, was die Oberfläche kann, kann auch das API. Webhooks für alle Zustandsänderungen.
- **Mandantenfähig von Anfang an.** Ein Account kann mehrere Betriebe (Properties) haben; jede Tabelle trägt die Property-ID.
- **Ressourcen statt Zimmer.** Zimmer, Parkplätze, Tagungsräume, Tagesnutzung sind Ressourcen mit einer Zeiteinheit (Nacht, Stunde, Tag, Monat).
- **Append-only im Rechnungswesen.** Buchungen werden nie geändert oder gelöscht, nur storniert. Rechnungen werden festgeschrieben.
- **Deutsche Pflichten sind Kern**: Meldeschein, GoBD, TSE, Kurtaxe, Beherbergungsstatistik, DSGVO.
- **Nicht selbst bauen**: Channel Manager, Payment-Processing, Kartenspeicherung, TSE-Hardware. Dafür saubere Schnittstellen.

## 2. Domänenmodell (Entwurf)

### Stammdaten

| Entität | Felder (Auswahl) | Anmerkung |
|---------|------------------|-----------|
| `Account` | Name, Abrechnungsdaten | Der Kunde von uns; Klammer um Properties |
| `Property` | Name, Adresse, Zeitzone, Währung, Tageswechsel-Uhrzeit, Check-in/Check-out-Zeiten, Steuernummer, Gemeinde (für Kurtaxe) | Ein Hotel |
| `ResourceCategory` | Name, Beschreibung, Kapazität (Personen), Bilder, Sortierung | „Doppelzimmer Superior“, „Tiefgaragenplatz“ |
| `Resource` | Nummer, Etage, Kategorie, Attribute (Balkon, barrierefrei), Status | Ein konkretes Zimmer oder ein Parkplatz |
| `Service` | Name, Zeiteinheit (Nacht/Stunde/Tag/Monat), Steuersatz, Buchhaltungskonto | Übernachtung, Frühstück, Parken |
| `Product` | Name, Preis, Steuersatz, Abrechnungsmodus (pro Person / pro Nacht / einmalig), Konto | Zusatzleistung, an eine Reservierung buchbar |
| `RatePlan` | Code, Name, Kategorie, Stornobedingung, No-Show-Regel, inkludierte Produkte, Basis-Ratenplan (für Ableitung), Ableitungsregel (± Betrag oder %) | Eindeutig je Property + Kategorie |
| `RateDay` | RatePlan, Datum, Preis je Belegung (1 Pers., 2 Pers., ...) | Preise je Tag |
| `RestrictionDay` | RatePlan oder Kategorie, Datum, MinLOS, MaxLOS, CTA, CTD, geschlossen | Restriktionen je Tag |
| `TaxRule` | Name, Typ (USt, Kurtaxe, Bettensteuer), Satz oder Betrag, Basis (pro Person/Nacht, prozentual), Ausnahmen (Kinder bis Alter, Geschäftsreise) | Einmal definiert, an Service/Produkt gehängt |
| `CancellationPolicy` | Frist, Gebühr (Nächte, Prozent, Betrag) | An RatePlan gehängt |

### Personen

| Entität | Felder (Auswahl) | Anmerkung |
|---------|------------------|-----------|
| `Guest` | Name, Geburtsdatum, Anschrift, Staatsangehörigkeit, E-Mail, Telefon, Sprache, Präferenzen, Notizen, Ausweisdaten (Typ, Nummer, kein Scan) | Personenbezogen, Löschkonzept nötig |
| `Company` | Name, Anschrift, USt-ID, Zahlungsziel, Raten-Vereinbarungen, Rechnungs-E-Mail | City-Ledger-Kunde |
| `User` | Name, Rolle, Property-Zugriff | Mitarbeitende; jedes Ereignis trägt die User-ID |

### Buchung und Aufenthalt

| Entität | Felder (Auswahl) | Anmerkung |
|---------|------------------|-----------|
| `Booking` | Bucher (Guest oder Company), Herkunft (Direkt, Booking Engine, Channel, API, Walk-in), externe Buchungsnummer, Marktsegment | Klammer um Reservierungen |
| `Reservation` | Booking, Kategorie, zugewiesene Resource (optional), Anreise, Abreise, Erwachsene/Kinder, RatePlan, Status, Hauptgast, Begleitpersonen, Garantie, Wünsche | Ein Aufenthalt |
| `ReservationNight` | Reservation, Datum, Preis, Steuern, RatePlan | Preis je Nacht wird bei Buchung eingefroren |
| `Block` | Name, Kategorie, Zeitraum, Anzahl, Freigabedatum, Firma/Gruppe, RatePlan | Kontingent; gebuchte Reservierungen ziehen vom Block ab |
| `Registration` | Reservation, Guest, Meldedaten nach § 30 BMG, Unterschrift (Bild/Vektor, nur bei Ausländern Pflicht), Zeitstempel, Vernichtungsdatum | Meldeschein; Aufbewahrung 1 Jahr |

### Rechnungswesen

| Entität | Felder (Auswahl) | Anmerkung |
|---------|------------------|-----------|
| `Folio` | Property, Inhaber (Guest oder Company), Reservation (optional), Typ (Gast / Firma / Gruppe / Kasse), Status (offen / geschlossen) | Mehrere Folios je Reservierung möglich |
| `Charge` | Folio, Datum, Geschäftsdatum, Service/Produkt, Menge, Netto, Steuer, Brutto, Konto, Storno-von, erfasst von | Unveränderlich; Storno erzeugt Gegenbuchung |
| `Payment` | Folio, Datum, Geschäftsdatum, Art (Bar, Karte, Überweisung, Anzahlung, Gutschein), Betrag, Gateway-Referenz, TSE-Signatur (bei Bar) | Unveränderlich |
| `Routing` | Reservation, Regel (welche Services/Produkte), Ziel-Folio | Split Billing |
| `Invoice` | Folio, fortlaufende Nummer je Property, Datum, Empfängeradresse, Positionen (Snapshot), Steuerausweis, PDF, XRechnung/ZUGFeRD, Storno-von | Festgeschrieben |
| `BusinessDay` | Property, Datum, geöffnet, geschlossen um, Abschlussprüfungen | Nachtlauf-Ergebnis |
| `AuditLog` | Entität, ID, Aktion, Vorher, Nachher, User, Zeitstempel | GoBD-Änderungsprotokoll, auf allen Tabellen |

### Betrieb

| Entität | Felder (Auswahl) | Anmerkung |
|---------|------------------|-----------|
| `HousekeepingStatus` | Resource, Status (schmutzig / sauber / geprüft / bewohnt), zugewiesen an, zuletzt geändert | Wird bei Check-out automatisch auf schmutzig gesetzt |
| `HousekeepingTask` | Resource, Typ (Abreise, Bleibe, Zwischenreinigung), zugewiesen an, erledigt | Tagesplanung |
| `MaintenanceBlock` | Resource, Zeitraum, Grund, Typ (Out of Order = nicht im Bestand, Out of Service = im Bestand, aber gesperrt) | Reduziert Verfügbarkeit |

## 3. Zustandsautomat Reservierung

```
            ┌───────────┐
            │ Inquired  │  Anfrage, keine Zimmer gehalten
            └─────┬─────┘
                  ▼
            ┌───────────┐
            │ Optional  │  Hotel hält, Gast noch nicht bestätigt, Verfallsdatum
            └─────┬─────┘
                  ▼
            ┌───────────┐      ┌───────────┐
            │ Confirmed │─────▶│ Canceled  │  Stornogebühr nach Policy
            └─────┬─────┘      └───────────┘
                  │                  ▲
                  │  Tageswechsel    │
                  │  ohne Check-in   │
                  ├─────────────────▶│ NoShow  (Gebühr nach Policy)
                  ▼
            ┌───────────┐
            │  InHouse  │  eingecheckt, Resource zugewiesen, Meldeschein erfasst
            └─────┬─────┘
                  ▼
            ┌───────────┐
            │ CheckedOut│  Folio ausgeglichen oder auf City Ledger übertragen
            └───────────┘
```

Regeln:

- Check-in nur mit zugewiesener Resource, die nicht Out of Order ist. Bei ausländischen Gästen ohne Unterschrift auf dem Meldeschein Warnung, kein Block.
- Check-out nur mit Saldo 0 auf allen Gast-Folios; offene Firmen-Folios wandern in den City Ledger.
- Verkürzen/Verlängern erzeugt oder storniert `ReservationNight`-Zeilen und prüft Verfügbarkeit neu.

## 4. Verfügbarkeitsberechnung

Für jede Kategorie und jeden Tag:

```
verfügbar = Anzahl Resources der Kategorie
          − Resources mit MaintenanceBlock (Out of Order) an diesem Tag
          − Reservierungen (Optional, Confirmed, InHouse) mit dieser Kategorie an diesem Tag
          − nicht abgerufene Plätze aus Blocks an diesem Tag
          + Overbooking-Limit der Kategorie
```

Zusätzlich gibt es die Property-Gesamtverfügbarkeit, damit Upgrades in eine andere Kategorie kein Overbooking auf Hausebene erzeugen. Verfügbarkeit wird berechnet und nur als Cache gehalten; der Cache wird bei jeder Änderung an Reservierungen, Blocks oder Sperrungen invalidiert.

## 5. Nachtlauf als Job

Läuft automatisch zur Tageswechsel-Uhrzeit der Property (Standard 04:00 Uhr):

1. Für jede InHouse-Reservierung Logis, inkludierte Produkte und Kurtaxe für die vergangene Nacht auf das Folio buchen (Routing beachten).
2. Confirmed-Reservierungen mit Anreise gestern und ohne Check-in auf `NoShow` setzen und Gebühr nach Policy buchen.
3. Optional-Reservierungen mit abgelaufenem Verfallsdatum auf `Canceled` setzen.
4. Abgelaufene Blocks freigeben.
5. Prüfliste erzeugen: Folios mit hohem Saldo, Zimmer mit Belegung ohne Housekeeping-Status, Zahlungen ohne Zuordnung.
6. `BusinessDay` schließen, nächsten öffnen, Tagesbericht (Belegung, ADR, RevPAR, Umsatz je Konto) speichern.

Buchungen von Charges nach dem Tageswechsel tragen das neue Geschäftsdatum. Es gibt keinen Zustand, in dem die Rezeption „nicht buchen darf, weil der Nachtlauf läuft“.

## 6. Modulschnitt

```
┌────────────────────────────────────────────────────────────────┐
│  Clients: Rezeptions-Web-App · Housekeeping-Mobile · Kiosk     │
│           Booking Engine · Gäste-Self-Service                  │
└───────────────────────────┬────────────────────────────────────┘
                            │ REST + Webhooks (OAuth 2.0)
┌───────────────────────────┴────────────────────────────────────┐
│  Core API                                                      │
│  ├─ Inventory      Properties, Kategorien, Resources, Wartung  │
│  ├─ Rates          Ratenpläne, Tagespreise, Restriktionen      │
│  ├─ Availability   Berechnung, Cache, ARI-Export               │
│  ├─ Booking        Bookings, Reservierungen, Blocks, Statusmaschine │
│  ├─ Guests         Gäste, Firmen, Dubletten, Meldeschein       │
│  ├─ Finance        Folios, Charges, Payments, Rechnungen, Ledger │
│  ├─ Operations     Housekeeping, Aufgaben, Nachtlauf           │
│  ├─ Compliance     TSE, DSFinV-K, GoBD-Export, Statistik, Löschkonzept │
│  └─ Reporting      Kennzahlen, Listen, Exporte                 │
└───────────────────────────┬────────────────────────────────────┘
                            │ Adapter
┌───────────────────────────┴────────────────────────────────────┐
│  Extern: Channel Manager (ARI) · Payment (Adyen/Stripe/Mollie) │
│          Cloud-TSE (fiskaly) · eSTATISTIK.core · E-Mail        │
│          Schließsystem · POS · Buchhaltung (DATEV-Export)       │
└────────────────────────────────────────────────────────────────┘
```

## 7. Roadmap in Ausbaustufen

### Stufe 1: Ein Haus betreiben (MVP)

Ziel: Ein einzelnes Hotel kann Opera/Cloudbeds durch uns ersetzen, ohne OTA-Anbindung.

- Inventory, Kategorien, Zimmer, Out of Order
- Ratenpläne mit Tagespreisen, abgeleitete Raten, einfache Restriktionen
- Reservierungen mit Statusmaschine, Zimmerplan (Tape Chart), Anreise-/Abreise-/Hausliste
- Gäste und Firmen, Meldeschein mit elektronischer Unterschrift
- Folios, Charges, Payments (Bar, Karte extern erfasst, Überweisung), Routing, Rechnung mit fortlaufender Nummer, Storno
- USt-Aufteilung 7 % / 19 %, Kurtaxe-Regel
- Housekeeping-Status, automatischer Nachtlauf
- Audit-Log, Rollen, GoBD-Export (CSV mit Strukturbeschreibung)
- Rezeptions-Web-App

### Stufe 2: Verkaufen und kassieren

- ARI-Schnittstelle für Channel Manager (Verfügbarkeit, Preise, Restriktionen raus; Reservierungen rein)
- Payment-Gateway mit Token-Speicherung, Anzahlungen, Pre-Authorisierung, Pay-by-Link
- Cloud-TSE für Barzahlungen, DSFinV-K-Export
- E-Mail-Kommunikation (Bestätigung, Pre-Arrival, Rechnung)
- Eigene Booking Engine
- Blocks und Gruppen mit Sammelrechnung

### Stufe 3: Effizienz und Compliance vertiefen

- Housekeeping-Mobile-App, Wartungstickets
- eSTATISTIK.core-Meldung, DATEV-Export, XRechnung
- Kiosk und Online-Check-in mit Meldeschein
- Reporting-Dashboard (Belegung, ADR, RevPAR, Pickup, Forecast)
- Multi-Property-Ansichten

### Stufe 4: Plattform

- Stunden- und Monatsbuchungen für Nicht-Zimmer-Ressourcen
- Öffentliches API mit App-Registrierung und Webhooks für Partner
- Schließsystem- und POS-Adapter
- Revenue-Management-Anbindung (RMS)

## 8. Technische Leitplanken (Vorschlag)

- **Datenbank:** PostgreSQL. Alle Geld-Felder als Integer in Cent plus Währung, nie Float. Zeitstempel in UTC, Aufenthaltsdaten als Kalenderdatum in der Zeitzone der Property.
- **Rechnungswesen:** Tabellen `charge`, `payment`, `invoice` ohne UPDATE/DELETE-Rechte für die App-Rolle; Korrektur nur per neuer Zeile.
- **Audit-Log:** Datenbank-Trigger, nicht Anwendungslogik, damit nichts vergessen wird.
- **Nebenläufigkeit:** Verfügbarkeitsprüfung und Reservierungsanlage in einer Transaktion mit Sperre je Kategorie und Zeitraum, sonst Doppelverkauf bei gleichzeitigen Buchungen.
- **API:** REST mit OpenAPI-Spezifikation, Versionierung im Pfad, Webhooks mit Signatur und Retry.
- **Sprache/Framework:** noch offen, siehe unten.

## 9. Offene Fragen

1. **Zielgruppe:** Bauen wir für ein konkretes Haus (unser eigenes?) oder als Produkt für Dritte? Das entscheidet über Mandantenfähigkeit und Aufwand bei Konfigurierbarkeit.
2. **Größe der Häuser:** 20 Zimmer oder 200? Gruppen, Tagungen und Blocks sind erst ab mittlerer Größe wichtig.
3. **Technologie-Stack:** Vorschlag TypeScript (Backend und Web-App aus einer Sprache) mit PostgreSQL. Alternativen: Python/Django, .NET, Go. Gibt es Team-Präferenzen?
4. **Betrieb:** Cloud-Hosting durch uns (SaaS) oder Installation beim Kunden? Cloud-TSE setzt Internetanbindung voraus.
5. **Channel Manager:** Welchen Partner zertifizieren wir zuerst? Für DACH sind Dirs21, HotelSpider und SiteMinder verbreitet.
6. **Payments:** Adyen (Hotel-Fokus, teurer) vs. Stripe/Mollie (einfacher Einstieg).
7. **Buchhaltung:** Reicht ein DATEV-Export, oder brauchen wir Debitorenverwaltung mit Mahnwesen im PMS?
8. **Ressourcen-Modell:** Bauen wir das Mews-Modell (Zeiteinheiten) von Anfang an ein oder starten wir mit Nächten und erweitern später? Empfehlung: Zeiteinheit als Feld anlegen, aber im MVP nur „Nacht“ implementieren.
