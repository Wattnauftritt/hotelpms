# Planungsgrundlage für unser eigenes PMS

Abgeleitet aus der [Marktanalyse](01-marktanalyse-pms.md). Dieses Dokument ist ein Vorschlag als Diskussionsbasis, keine finale Entscheidung. Offene Punkte stehen am Ende.

## 1. Leitlinien

- **API-first.** Alles, was die Oberfläche kann, kann auch das API. Webhooks für alle Zustandsänderungen.
- **Mandantenfähig von Anfang an.** Ein Account kann mehrere Betriebe (Properties) haben; jede Tabelle trägt die Property-ID.
- **Ressourcen statt Zimmer.** Zimmer, Parkplätze, Tagungsräume, Tagesnutzung sind Ressourcen mit einer Zeiteinheit (Nacht, Stunde, Tag, Monat).
- **Append-only im Rechnungswesen.** Buchungen werden nie geändert oder gelöscht, nur storniert. Rechnungen werden festgeschrieben.
- **Deutsche Pflichten sind Kern**: Meldeschein, GoBD, Kurtaxe, Beherbergungsstatistik, DSGVO. Keine Kassenfunktion und damit keine TSE, siehe Entscheidung 9.
- **Nicht selbst bauen**: Channel Manager, Payment-Processing, Kartenspeicherung, TSE-Hardware. Dafür saubere Schnittstellen.
- **Was der Betrieb schon führt, bauen wir nicht. Wir schließen an.** Kassenbuch und Kasse gar nicht, Buchungsmaschine und Channel Manager anbindbar, Restaurantkasse und Schließsystem per Schnittstelle, Buchhaltung als DATEV-Export. Ein Umstieg darf nie erzwungen werden. Siehe [09-kassenbuch.md](09-kassenbuch.md)

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
| `Reservation` | Booking, Kategorie, zugewiesene Resource (optional), Anreise, Abreise, RatePlan, Status, Hauptgast, Garantie, Wünsche, `public_ref` | Ein Aufenthalt |
| `ReservationOccupant` | Reservation, Gast (optional), Alter zum Anreisetag, Rolle | Ersetzt reine Zähler. Nötig für Kurtaxe-Staffeln, Kinderpreise und Meldeschein |
| `ReservationNight` | Reservation, Datum, Preis, Steuern, RatePlan | Preis je Nacht wird bei Buchung eingefroren |
| `Block` | Name, Kategorie, Zeitraum, Anzahl, Freigabedatum, Firma/Gruppe, RatePlan | Kontingent; gebuchte Reservierungen ziehen vom Block ab |
| `Registration` | Reservation, Guest, Meldedaten nach § 30 BMG, Unterschrift (Bild/Vektor, nur bei Ausländern Pflicht), Zeitstempel, Vernichtungsdatum | Meldeschein; Aufbewahrung 1 Jahr |

### Rechnungswesen

| Entität | Felder (Auswahl) | Anmerkung |
|---------|------------------|-----------|
| `Folio` | Property, Inhaber (Guest oder Company), Reservation (optional), Typ (Gast / Firma / Gruppe / Kasse), Status (offen / geschlossen) | Mehrere Folios je Reservierung möglich |
| `Charge` | Folio, Datum, Geschäftsdatum, Service/Produkt, Menge, Netto, Steuer, Brutto, Konto, Storno-von, erfasst von | Unveränderlich; Storno erzeugt Gegenbuchung |
| `Settlement` | Folio, Geschäftsdatum, Zahlart aus Katalog, Betrag, externe Referenz (Beleg der Ladenkasse, Portal-ID, Gateway-Referenz), Storno-von | Zahlungsvermerk, unveränderlich. Kein Kassenbestand, siehe [09-kassenbuch.md](09-kassenbuch.md) |
| `Routing` | Reservation, Regel (welche Services/Produkte), Ziel-Folio | Split Billing |
| `Invoice` | Menge von Charges, fortlaufende Nummer je Property und Jahr, Datum, **Aussteller und Empfänger als Momentaufnahme**, Steuer je Satzgruppe aus der Nettosumme, PDF/A-3 mit ZUGFeRD, Storno-von | Festgeschrieben. Ein Folio kann mehrere Rechnungen haben, siehe B3 bis B6 in [13-gesamtreview.md](13-gesamtreview.md) |
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

Zusätzlich gibt es die Property-Gesamtverfügbarkeit, damit Kategorien-Overbooking kein Overbooking auf Hausebene erzeugt. Umgesetzt als **Haussummenzeile** in `inventory_day` mit `category_id = 0`, die von denselben drei SQL-Funktionen mitgeführt und bei jeder Belegung in derselben Anweisung geprüft wird. Siehe B2 in [13-gesamtreview.md](13-gesamtreview.md) und Abschnitt 4 von [10-systemarchitektur.md](10-systemarchitektur.md).

## 5. Nachtlauf als Job

Läuft automatisch zur Tageswechsel-Uhrzeit der Property (Standard 04:00 Uhr), gestreut über ein Zeitfenster, damit nicht alle Betriebe gleichzeitig starten.

**Der Tageswechsel ist Schritt 1, nicht der letzte.** Alle folgenden Schritte arbeiten ausdrücklich mit dem **geschlossenen** Datum als Parameter, nie mit „dem aktuellen". Jeder Schritt hinterlässt nach Abschluss eine Marke je `(property, business_date, schritt)`, ein Wiederholungslauf überspringt markierte Schritte. Begründung in B1 von [13-gesamtreview.md](13-gesamtreview.md).

1. `BusinessDay` des abgelaufenen Tages schließen und den nächsten öffnen. Eine atomare Zeilenänderung. Ab jetzt tragen neue Charges das neue Datum.
2. Für jede InHouse-Reservierung Logis, inkludierte Produkte und Kurtaxe für die geschlossene Nacht auf das Folio buchen, mit dem geschlossenen Datum (Routing beachten).
3. Confirmed-Reservierungen mit Anreise am geschlossenen Tag und ohne Check-in auf `NoShow` setzen, Gebühr nach Policy buchen, Bestand freigeben.
4. Optional-Reservierungen mit abgelaufenem Verfallsdatum auf `Canceled` setzen, Bestand freigeben.
5. Abgelaufene Blocks freigeben.
6. Prüfliste erzeugen: Folios mit hohem Saldo, Zimmer mit Belegung ohne Housekeeping-Status, Zahlungsvermerke ohne Zuordnung.
7. Tagesbericht (Belegung, ADR, RevPAR, Umsatz je Konto) für den geschlossenen Tag speichern.

Es gibt keinen Zustand, in dem die Rezeption „nicht buchen darf, weil der Nachtlauf läuft". Eine Charge, die während des Laufs erfasst wird, trägt bereits das neue Datum.

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
│  ├─ Compliance     Meldeschein, GoBD-Export, Statistik, Löschkonzept │
│  └─ Reporting      Kennzahlen, Listen, Exporte                 │
└───────────────────────────┬────────────────────────────────────┘
                            │ Adapter
┌───────────────────────────┴────────────────────────────────────┐
│  Extern: Channel Manager (ARI) · Payment (Adyen/Stripe/Mollie) │
│          Kassenschnittstelle · eSTATISTIK.core · E-Mail        │
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
- **Keine Kassenfunktion, keine TSE.** Zahlungen nur als strukturierter Vermerk mit externer Referenz. Das Kassenbuch bleibt beim Betrieb, siehe [09-kassenbuch.md](09-kassenbuch.md)
- USt-Aufteilung 7 % / 19 %, Kurtaxe-Regel
- Housekeeping-Status, automatischer Nachtlauf
- Audit-Log, Rollen, GoBD-Export (CSV mit Strukturbeschreibung)
- Rezeptions-Web-App

### Stufe 2: Verkaufen und anbinden

- ARI-Schnittstelle für Channel Manager (Verfügbarkeit, Preise, Restriktionen raus; Reservierungen rein)
- Payment-Gateway mit Token-Speicherung, Anzahlungen, Pre-Authorisierung, Pay-by-Link
- **Kassenschnittstelle in beide Richtungen**: Ladenkasse und Restaurantkasse buchen Umsätze auf Zimmer und Folio, das PMS liefert offene Folios zurück. Sollte stehen, bevor die Betriebe wegen der geplanten Registrierkassenpflicht ab 2028 auf elektronische Kassen umstellen
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
- **Rechnungswesen:** Tabellen `charge`, `settlement`, `invoice` ohne UPDATE/DELETE-Rechte für die Anwendungsrolle; Korrektur nur per neuer Zeile.
- **Audit-Log:** Datenbank-Trigger, nicht Anwendungslogik, damit nichts vergessen wird.
- **Nebenläufigkeit:** Verfügbarkeitsprüfung und Reservierungsanlage in einer Transaktion mit Sperre je Kategorie und Zeitraum, sonst Doppelverkauf bei gleichzeitigen Buchungen.
- **API:** REST mit OpenAPI-Spezifikation, Versionierung im Pfad, Webhooks mit Signatur und Retry.
- **Sprache/Framework:** TypeScript, Fastify, PostgreSQL. Entschieden in [10-systemarchitektur.md](10-systemarchitektur.md).

## 9. Getroffene Entscheidungen

Stand September 2026, beantwortet vom Auftraggeber.

| # | Frage | Entscheidung |
|---|---|---|
| 1 | Zielgruppe | **Eigenes Produkt zur Vermarktung an Dritte.** Das Hotel, in dem der Auftraggeber arbeitet, dient als Testobjekt und Pilotkunde |
| 2 | Größe der Häuser | **Alle.** Von Ferienwohnung und Pension bis zu Häusern mit mehreren hundert Zimmern, inklusive Gruppen und Multi-Property |
| 3 | Technologie-Stack | Offen, Kriterium ist praktikabel plus performant plus kostenbewusst. Ausgearbeitet in [07-technologie-und-hosting.md](07-technologie-und-hosting.md) |
| 4 | Betrieb | **SaaS**, gehostet von uns |
| 5 | Channel Manager | Später **alle in Deutschland verbreiteten Anbieter**, ausdrücklich inklusive Roomcloud |
| 6 | Payments | **Alle drei**: Adyen, Stripe, Mollie |
| 7 | Buchhaltung | **DATEV-Export genügt.** Keine Debitorenverwaltung mit Mahnwesen im PMS |
| 8 | Ressourcen-Modell | Wie empfohlen: **Zeiteinheit als Feld von Anfang an**, im MVP nur „Nacht" implementiert |
| 9 | Kassenfunktion | **Keine.** Kein Kassenbuch, keine TSE, kein DSFinV-K. Nur Fakturierung plus Zahlungsvermerk, dazu eine Kassenschnittstelle. Siehe [09-kassenbuch.md](09-kassenbuch.md) |
| 10 | Nachrüstbarkeit des Kassenbuchs | **Offen halten, nicht vorbauen.** Das Backend muss ein Kassenbuch später additiv aufnehmen können, ohne Umbau. Kein ungenutztes Gerüst. Siehe unten |
| 11 | Betrieb | **Eigene VM auf dem vorhandenen Proxmox-Host**, ohne Plesk. Der bestehende Plesk-Server behält seine Projekte und bleibt unberührt. Siehe [10-systemarchitektur.md](10-systemarchitektur.md) |
| 12 | Reverse Proxy und TLS | **Caddy.** Automatische Zertifikate ersetzen, was vorher Plesk übernommen hat |

### Was daraus folgt

**Zu 1: Pilotkunde ist ein großer Vorteil, aber eine Falle.**
Ein echtes Haus als Testobjekt ist Gold wert: echte Daten, echte Abläufe, sofortiges Feedback. Das Risiko ist, dass das Produkt zur Speziallösung für genau dieses Haus wird. Gegenmittel: Jede Anforderung aus dem Pilothaus wird bewusst danach bewertet, ob sie allgemein ist oder hausspezifisch. Hausspezifisches wird konfigurierbar gebaut oder gar nicht.

**Zu 2: Die Spannweite ist die härteste Anforderung im ganzen Projekt.**
Eine Ferienwohnung und ein Haus mit 400 Zimmern und Tagungsbetrieb sind unterschiedliche Produkte. Die Ferienwohnung braucht drei Bildschirme und darf nichts kosten. Das große Haus braucht Blocks, Gruppenrechnungen, Rollenrechte, Schichtabschlüsse und Multi-Property.

Das ist machbar, aber nur unter zwei Bedingungen:
- **Das Datenmodell muss von Anfang an das große Haus können.** Blocks, mehrere Folios je Reservierung, Routing, Mandantenfähigkeit, Rollen. Diese Dinge nachzurüsten bedeutet Migration von Bestandsdaten und ist der teuerste denkbare Umbau. Sie kosten jetzt wenig, weil sie nur Struktur sind.
- **Die Oberfläche muss mitwachsen, nicht alles zeigen.** Funktionen werden je nach Betriebsgröße ein- und ausgeblendet. Eine Pension darf nie ein Feld für Marktsegment oder ein Menü für Kontingente sehen.

**Vertrieblich bleibt es trotzdem eine Reihenfolge.** Wir bauen die Struktur für alle, gehen aber mit dem Mittelbau in den Markt, also 20 bis 150 Zimmer. Das ist der Bereich mit dem besten Verhältnis aus Zahlungsbereitschaft und Betreuungsaufwand, siehe [03-marktfuehrer-deutschland.md](03-marktfuehrer-deutschland.md).

**Zu 5: „Alle Channel Manager" heißt, dass wir keinen einzeln bauen.**
Wir bauen **eine** ARI-Schnittstelle (Availability, Rates, Inventory) nach Branchenstandard und lassen die Anbieter andocken. Dirs21, HotelSpider, SiteMinder, Roomcloud und Cultuzz sprechen alle Varianten desselben Musters. Eine saubere Standardschnittstelle plus eine gute Dokumentation ist billiger als fünf Einzelintegrationen und skaliert auf den sechsten Anbieter ohne Arbeit.

**Zu 6: „Alle drei Payment-Anbieter" bedeutet zwingend eine Abstraktionsschicht.**
Wie bei der Fiskalisierung: eine eigene interne Schnittstelle `PaymentAdapter` mit Autorisieren, Belasten, Erstatten, Token speichern, Pay-by-Link. Adyen, Stripe und Mollie sind Implementierungen dahinter. **Kartendaten fassen wir nie selbst an**, nur Tokens, sonst greift PCI DSS in voller Härte.
Reihenfolge: Stripe zuerst, weil am schnellsten integriert und für den Start ausreichend. Mollie danach, weil im DACH-Raum bei kleinen Betrieben beliebt und günstiger. Adyen zuletzt, weil es sich erst ab Volumen und bei größeren Häusern lohnt.

**Zu 11: Die eigene VM löst drei Probleme, zwei bleiben.**

Gelöst sind Isolation von den PHP-Projekten auf der Plesk-VM, das Abrüstproblem (auf der PMS-VM läuft schlicht kein Plesk) und die Betriebskopplung bei Neustarts. **Nicht gelöst sind zwei Punkte**, die als P4b und P4c in [12-security-und-performance-review.md](12-security-und-performance-review.md) stehen: Beide VMs teilen sich die Hardware, und der Proxmox-Host bleibt gemeinsamer Ausfallpunkt. Daraus folgt die Bedingung für Fremdkunden: **eine verschlüsselte Sicherung außer Haus, nicht die zweite VM.**

**Zu 10: Nachrüstbarkeit ist eine Entwurfsauflage, kein Arbeitspaket.**

Es wird jetzt nichts für ein Kassenbuch gebaut. Es wird nur sichergestellt, dass ein späterer Einbau rein additiv bleibt. Verbindlich sind dafür zwei Punkte:

1. **Der Zahlungsvermerk ist eine eigene Tabelle `settlement` mit einem Zahlartenkatalog `payment_method` als Stammdaten**, kein Statusfeld am Folio und kein Enum im Code. Ein späteres Kassenbuch ergänzt dann drei Tabellen und drei Spalten, ohne einen bestehenden Datensatz anzufassen.
2. **Jede Erfassung eines Zahlungsvermerks läuft durch genau eine Dienstfunktion**, nicht verteilt über Check-out, Rechnungserstellung und Import. Damit gibt es später einen einzigen Ort für einen Fiskal-Hook.

Beides ist ohnehin sauberer Aufbau und kostet keinen Zusatzaufwand. Alles Weitere, was Nachrüstbarkeit begünstigt, folgt bereits aus den GoBD-Entscheidungen in [08-compliance-in-der-praxis.md](08-compliance-in-der-praxis.md).

**Ausdrücklich nicht erlaubt:** leere Tabellen auf Vorrat, eine Fiskal-Schnittstelle ohne Implementierung, `tse_`-Spalten für später, Schalter für ein Modul, das es nicht gibt. Details und Begründung in Abschnitt 10 von [09-kassenbuch.md](09-kassenbuch.md).

**Zu 7: DATEV-Export vereinfacht Stufe 1 spürbar.**
Kein Mahnwesen, keine Offene-Posten-Verwaltung, keine Zahlungsavise. Wir brauchen: sauber kontierte Buchungen, einen Export im DATEV-Format und die Firmen-Folios im City Ledger als Forderung. Was danach passiert, macht der Steuerberater.

### Neu aufgeworfene Fragen

1. **Preisgestaltung über die Spannweite.** Bei 7 bis 12 Euro je Zimmer zahlt eine Ferienwohnung mit vier Einheiten unter 50 Euro im Monat und verursacht denselben Supportaufwand wie ein Haus mit 40 Zimmern. Brauchen wir einen Mindestpreis je Betrieb, und wie hoch?
2. ~~**Fiskalisierungskosten bei Kleinstbetrieben.**~~ **Erledigt** durch Entscheidung 9: Ohne Kassenfunktion entstehen keine Fiskalisierungskosten je Kunde.
3. **Verkaufen wir Payment mit Marge?** Bei Mews ist das der wesentliche Ertragshebel, es widerspricht aber unserer Positionierung „kein Zwang zur Bündelung".
4. **Datenimport aus Altsystemen.** Aus [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md): Unser Zielkunde ist der Migrationskandidat. Welche Altsysteme unterstützen wir zuerst? Vorschlag: hotline, HS/3, protel.
