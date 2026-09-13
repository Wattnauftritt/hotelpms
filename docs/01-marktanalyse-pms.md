# Marktanalyse: Wie funktionieren bestehende Hotel-PMS?

Stand: September 2026. Grundlage für die Planung unseres eigenen Property Management Systems (PMS).

## 1. Was ein PMS im Kern tut

Ein PMS ist das Betriebssystem eines Hotels. Es hält die eine Wahrheit über Zimmer, Preise, Verfügbarkeit,
Gäste und Geld und sorgt dafür, dass „das letzte Zimmer genau einmal, zum gewünschten Preis verkauft wird“.
Über alle Anbieter hinweg finden sich dieselben Kernfunktionen:

| # | Funktion | Was sie leistet |
|---|----------|-----------------|
| 1 | Reservierungsverwaltung | Einzel-, Firmen- und Gruppenbuchungen gegen den Live-Bestand anlegen und ändern; Overbooking verhindern |
| 2 | Front Desk / Rezeption | Check-in, Check-out, Zimmerzuweisung, Walk-ins, Upgrades; Zimmerplan (Tape Chart) als zentrale Ansicht |
| 3 | Gästeprofile / CRM | Kontaktdaten, Aufenthaltshistorie, Präferenzen, Firmenzugehörigkeit; Dubletten-Zusammenführung |
| 4 | Folio / Rechnungswesen | Leistungen buchen (Posting), Splitten, Routen auf andere Konten, Rechnungen erzeugen |
| 5 | Zahlungen | Autorisieren, Belasten, Erstatten, Anzahlungen; Anbindung von Terminals und Payment-Gateways |
| 6 | Housekeeping | Zimmerstatus (schmutzig / sauber / geprüft), Aufgabenverteilung, Rückmeldung an die Rezeption |
| 7 | Wartung | Störungen erfassen, Zimmer „Out of Order“ nehmen und erst nach Erledigung zurück in den Bestand |
| 8 | Nachtlauf (Night Audit) | Tagesabschluss: Logis und Steuern buchen, No-Shows verarbeiten, Zahlungen abstimmen, Geschäftsdatum weiterschalten |
| 9 | Channel Management | Preise und Verfügbarkeit an OTAs (Booking.com, Expedia), GDS und eigene Buchungsmaschine synchronisieren |
| 10 | Rate Management | Ratenpläne, Saisons, abgeleitete Raten, Restriktionen (Mindestaufenthalt, Closed to Arrival) |
| 11 | Reporting | Belegung, ADR (Average Daily Rate), RevPAR, Anreise-/Abreiselisten, Hausliste, Umsatz je Abteilung |
| 12 | Schnittstellen | POS (Restaurant, Bar), Schließsysteme, Kiosk, Buchhaltung, Meldewesen, Statistik |

## 2. Die relevanten Systeme im Vergleich

| System | Zielgruppe | Architektur | Besonderheiten |
|--------|-----------|-------------|----------------|
| **Oracle Opera Cloud** | Große Häuser, Ketten, mit eigener IT | Enterprise-Suite, eng verzahnt mit Oracle CRS, Channel Manager und POS | Größte Funktionstiefe, traditionelle Oberfläche, Implementierung sehr teuer |
| **Mews** | Boutique bis Upper-Midscale, Hybrid-Konzepte | Cloud-native, API-first, großer Marketplace für Integrationen | Generalisiertes Modell: nicht nur Zimmer, sondern beliebige „Resources“ (Parkplatz, Meetingraum, Coworking) stunden-, tage- oder monatsweise buchbar. Rechnungslegung hängt am Kundenprofil, nicht an der Reservierung |
| **Apaleo** | Betreiber, die ihr Frontend selbst bauen oder zusammenstellen wollen | Reines API-first-PMS („headless“): jede Funktion nur über REST, OAuth 2.0, OpenAPI, Webhooks | Sehr sauberes Domänenmodell, Marketplace für Apps, kaum eigene Oberflächen-Tiefe |
| **Cloudbeds** | Unabhängige Hotels mit 20 bis 100 Zimmern | All-in-One-Bundle: PMS, Channel Manager, Booking Engine, Payments in einem Abo | Einfach zu bedienen, starker Support, weniger Flexibilität |
| **QloApps** (Open Source) | Kleine Häuser, die selbst hosten wollen | PHP / MySQL, Fork von PrestaShop | Website, Booking Engine und PMS in einem, größtes Open-Source-Projekt im Hotelbereich |
| **HotelDruid** (Open Source) | Sehr kleine Betriebe | PHP, seit über 20 Jahren gepflegt | Schnell installiert, flexible Zimmerzuteilung, altmodische Oberfläche |
| **DACH-Anbieter** (3RPMS, Hestia, softtec hotline, Lodgit, zimrly) | Kleine bis mittlere deutsche Hotels | Meist Cloud, teilweise Desktop | Vorsprung bei deutschen Pflichten: TSE, DSFinV-K, GoBD, Meldeschein, Kurtaxe, Beherbergungsstatistik |

Zwei Grundhaltungen stehen sich gegenüber:

- **All-in-One** (Cloudbeds, Opera): ein Anbieter liefert alles, Integration ist Sache des Anbieters.
- **API-first / Plattform** (Apaleo, Mews): das PMS ist der Kern, alles andere kommt aus einem Marketplace. Das ist der Trend der letzten Jahre und die richtige Basis für ein eigenes System.

## 3. Das Domänenmodell der modernen Systeme

Die Modelle von Mews und Apaleo sind sich sehr ähnlich. Unten die Begriffe beider Systeme nebeneinander, damit wir uns eine eigene Sprache aussuchen können.

| Konzept | Apaleo | Mews | Bedeutung |
|---------|--------|------|-----------|
| Betrieb | Property | Enterprise | Ein Hotel; ein Account kann mehrere haben |
| Zimmerkategorie | Unit Group | Resource Category | Verkaufte Einheit („Doppelzimmer Superior“); hat eine Kapazität |
| Zimmer | Unit | Resource | Physisches Zimmer (oder Parkplatz, Meetingraum bei Mews) |
| Leistungsart | Service | Service | Bei Mews: Übernachtung, aber auch Parken, Frühstück, Spa; jede mit Zeiteinheit (Stunde, Tag, Monat) |
| Ratenplan | Rate Plan | Rate / Rate Group | Preisregel je Unit Group; bei Apaleo eindeutig als `Property-Rate-UnitGroup` |
| Restriktionen | Restrictions | Restrictions | Min-/Max-Aufenthalt, Closed to Arrival / Departure, Buchungsfenster |
| Buchung | Booking | Reservation Group | Klammer um mehrere Reservierungen (z. B. 3 Zimmer, eine Bestellung) |
| Reservierung | Reservation | Reservation | Ein Aufenthalt in einer Kategorie für einen Zeitraum |
| Kontingent | Block | Availability Block | Gehaltene Zimmer für Gruppe, Firma, Reiseveranstalter |
| Zusatzleistung | Service (auf Reservierung) | Product / Order Item | Frühstück, Parken, Haustier, City Tax |
| Konto | Folio | Bill / Account | Sammelt Charges und Payments; mehrere Folios je Reservierung möglich |
| Buchung einer Leistung | Charge | Order Item / Accounting Item | Einzelne Umsatzzeile mit Steuer |
| Zahlung | Payment / Refund | Payment | Kartenzahlung, Bar, Überweisung, Anzahlung |
| Umleitung | Routing | Routing Rule | „Logis auf Firmenkonto, Extras auf Gastkonto“ |
| Rechnung | Invoice | Bill (closed) | Festgeschriebenes, nummeriertes Dokument |
| Gast / Firma | Guest / Company | Customer / Company | Profil mit Adresse, Dokument, Präferenzen |
| Wartung | Maintenance | Out of Order / Out of Service | Sperrt ein Zimmer für einen Zeitraum |

### Reservierungs-Zustände (Mews)

`Inquired` (angefragt) → `Optional` (Hotel hält, Gast noch nicht bestätigt) → `Confirmed` (beide bestätigt) → `Started` (eingecheckt) → `Processed` (ausgecheckt), jederzeit `Canceled`. Apaleo kennt das gleiche Muster: `Tentative`, `Confirmed`, `InHouse`, `CheckedOut`, `Canceled`, `NoShow`.

### Wichtige Modell-Entscheidungen bei den Vorbildern

- **Herkunft (Origin / Channel)** wird an jeder Reservierung gespeichert: Direkt, Booking Engine, Channel Manager, Import, API. Dazu die externe Buchungsnummer des OTA.
- **Verfügbarkeit** wird nie gespeichert, sondern berechnet: Kapazität der Kategorie minus Belegung minus Blocks minus Out-of-Order plus erlaubtes Overbooking, je Tag.
- **Preise sind je Tag** (Rate × Unit Group × Datum), Restriktionen ebenfalls. Abgeleitete Raten (Basisrate ± Betrag oder Prozent) sparen Pflegeaufwand und verhindern Fehler.
- **Steuern und Gebühren** werden einmal am Ratenplan bzw. Produkt definiert, nie pro Reservierung.
- **Geld hängt am Konto, nicht am Zimmer.** Mews hängt Rechnungen an den Kunden, Apaleo an das Folio. Beides erlaubt Split Billing und Sammelrechnungen für Gruppen.
- **Kanonische IDs statt Spitznamen** für Kategorien und Raten, sonst driftet das Channel-Mapping auseinander. Apaleo speichert keine externen Raten-IDs, das Mapping liegt beim Channel-Manager.
- **Audit-Log** für alles: wer hat was wann geändert.
- **Webhooks** für Reservierungs-, Folio-, Rechnungs-, Raten- und Zimmer-Ereignisse sind die Basis des Integrations-Ökosystems.

## 4. Klassische Hotelbuchhaltung (Ledger-Struktur)

Die Buchhaltungslogik ist bei allen Systemen gleich und stammt aus der Vor-Software-Zeit:

- **Guest Ledger**: Forderungen gegenüber Gästen im Haus (offene Folios).
- **City Ledger**: Forderungen gegenüber Nicht-Anwesenden, vor allem Firmen und Reisebüros, die nach Abreise per Rechnung zahlen.
- **Deposit Ledger**: Anzahlungen vor Anreise; Verbindlichkeit des Hotels, wird beim Check-in auf das Folio übertragen.

Der **Nachtlauf** schließt jeden Tag ab:

1. Logis und Steuern für alle Gäste im Haus buchen.
2. No-Shows verarbeiten: je nach Stornobedingung belasten oder freigeben, OTA informieren.
3. Nicht eingecheckte Anreisen klären, Housekeeping-Status mit Belegung abgleichen.
4. Zahlungen und Kassen abstimmen, hohe Salden prüfen.
5. Tagesberichte erzeugen (Manager Flash, Belegung, ADR, RevPAR).
6. Geschäftsdatum weiterschalten.

Moderne Systeme (Mews, Apaleo) automatisieren das vollständig; es gibt keinen manuell ausgelösten Nachtlauf mehr, sondern laufende Buchung und eine feste Tageswechsel-Uhrzeit.

## 5. Pflichten in Deutschland

Hier scheitern internationale Systeme regelmäßig, und hier liegt der Wettbewerbsvorteil eines eigenen Systems.

### Meldeschein (Bundesmeldegesetz §§ 29, 30)

- Seit 1. Januar 2025 müssen nur noch **ausländische Gäste** den Meldeschein unterschreiben. Für deutsche Gäste entfällt die Unterschrift; die Daten sind weiterhin zu erfassen.
- Datenfelder sind in § 30 Abs. 2 BMG abschließend festgelegt: Name, Anschrift, Anreise- und geplantes Abreisedatum, Zahl der Mitreisenden, Staatsangehörigkeit, bei Ausländern die Nummer des Ausweisdokuments.
- Bei Ausländern muss das Dokument **geprüft**, aber **nicht kopiert** werden. Kopien sind unzulässig.
- Elektronische Erfassung (Kiosk, Mobile Check-in, PMS-Formular) ist zulässig, sofern die Beherbergungsmeldedatenverordnung (BeherbMeldV) eingehalten wird.
- **Aufbewahrung ein Jahr**, danach Vernichtung innerhalb von drei Monaten.

### GoBD (Grundsätze ordnungsmäßiger Buchführung)

- Festgeschriebene Belege sind unveränderbar. Eine Korrektur ist Storno plus Neuausstellung, beide mit fortlaufender Nummer.
- Jede Änderung mit Zeitstempel und Benutzer im Änderungsprotokoll, exportierbar.
- Datenzugriff Z3: maschinenlesbarer Export mit Strukturbeschreibung. PDF oder Excel reichen nicht.
- Aufbewahrung acht Jahre für Buchungsbelege, im maschinenlesbaren Originalformat, auch nach Anbieterwechsel.
- Eine **Verfahrensdokumentation** vom Buchungsportal über das PMS bis zur Steuerberatung ist Pflicht; gute Anbieter liefern Vorlagen.

### Kassensicherungsverordnung (KassenSichV) und TSE

- Sobald das PMS Barzahlungen erfasst, gilt der betroffene Teil als elektronisches Aufzeichnungssystem.
- Jede Kassenbuchung wird von einer zertifizierten **Technischen Sicherheitseinrichtung (TSE)** signiert (Hardware oder Cloud), die Signatur inklusive Vorgängersignatur erscheint auf dem Beleg, meist als QR-Code.
- Export im Format **DSFinV-K** für die Betriebsprüfung.
- Meldepflicht der Systeme beim Finanzamt über ELSTER innerhalb eines Monats nach Anschaffung oder Außerbetriebnahme.

### Steuern und Abgaben

- Umsatzsteuer: 7 % auf die Übernachtung, 19 % auf nicht unmittelbar der Vermietung dienende Leistungen (Frühstück, Parken, Wellness). Pauschalpreise müssen also **aufgeteilt** werden.
- **Kurtaxe / Bettensteuer / Tourismusabgabe**: kommunal unterschiedlich, pro Person und Nacht oder prozentual, mit Ausnahmen (Geschäftsreisende, Kinder). Muss als eigene Position mit eigener Regel je Ort abbildbar sein.
- **E-Rechnung**: Seit 2025 müssen B2B-Empfänger E-Rechnungen (XRechnung, ZUGFeRD) annehmen können, die Ausstellungspflicht wird bis 2028 gestaffelt eingeführt. Firmenrechnungen sollten also strukturiert (nicht nur PDF) erzeugbar sein.

### Beherbergungsstatistik

- Betriebe ab zehn Betten melden monatlich an das Statistische Landesamt (Beherbergungsstatistikgesetz).
- Das einheitliche Verfahren **eSTATISTIK.core** erlaubt die automatische Übermittlung direkt aus dem PMS. Mews bietet das für DACH bereits an.

### Datenschutz (DSGVO)

- Gästedaten sind personenbezogen; Löschkonzepte, Auskunftsrecht und Zweckbindung sind einzuplanen.
- Widerspruch zu GoBD-Aufbewahrung wird über Sperren statt Löschen gelöst.

## 6. Erkenntnisse für unser eigenes System

1. **API-first wie Apaleo bauen, aber eine eigene Oberfläche wie Mews liefern.** Das Backend ist ein sauber dokumentiertes API mit Webhooks; die Rezeptions-UI ist nur ein Client davon. So bleiben Kiosk, Gäste-App und Partner-Integrationen möglich.
2. **Das Mews-Modell „Resource statt Zimmer“ übernehmen.** Zimmer, Parkplätze, Tagungsräume und Tagesnutzung sind dieselbe Abstraktion mit unterschiedlicher Zeiteinheit. Das kostet zu Beginn wenig und öffnet später neue Umsatzquellen.
3. **Verfügbarkeit berechnen, nicht speichern.** Ein Tagesraster aus Kapazität, Reservierungen, Blocks und Sperrungen; Overbooking als bewusstes Limit je Kategorie.
4. **Rechnungswesen von Anfang an GoBD-fest.** Unveränderliche Buchungen (append-only), Storno als Gegenbuchung, fortlaufende Rechnungsnummern je Betrieb, Audit-Log auf jeder Tabelle. Das nachträglich einzubauen ist der teuerste Fehler, den man machen kann.
5. **Deutsche Pflichten als Kernmodule, nicht als Add-on:** Meldeschein mit elektronischer Unterschrift, TSE-Anbindung (Cloud-TSE, z. B. fiskaly oder Swissbit Cloud), DSFinV-K-Export, Kurtaxe-Regeln, eSTATISTIK.core.
6. **Klassische Kassenzeit abschaffen.** Wie Mews und Apaleo laufend buchen, Tageswechsel als konfigurierte Uhrzeit, Nachtlauf als automatischer Job mit Prüfliste statt als manuelles Ritual.
7. **Channel Manager nicht selbst bauen.** Die Anbindung an Booking.com, Expedia und Co. ist ein eigenes Geschäft (Zertifizierung, Mapping-Pflege). Stattdessen eine ARI-Schnittstelle (Availability, Rates, Inventory) anbieten, an die etablierte Channel Manager (SiteMinder, Dirs21, HotelSpider, Cubilis) andocken.
8. **Payments über einen Anbieter** (Adyen, Stripe, Mollie) mit Token-basierter Kartenspeicherung. Kartendaten nie selbst halten (PCI DSS).

Die konkrete Ableitung für unser Domänenmodell, Modulschnitt und die MVP-Roadmap steht in [02-planungsgrundlage.md](02-planungsgrundlage.md).

## Quellen

- [AltexSoft: Hotel Property Management Systems, Products and Features](https://www.altexsoft.com/blog/hotel-property-management-systems-products-and-features/)
- [roomMaster: 12 Core Functions of a Hotel PMS](https://www.roommaster.com/blog/functions-of-property-management-system)
- [Hotelspeak: PMS for Hotels Explained and the Path to Multi-Property Control](https://www.hotelspeak.com/2025/11/pms-for-hotels-explained-and-the-path-to-multi-property-control/)
- [Mews Connector API: Reservations](https://docs.mews.com/connector-api/operations/reservations)
- [Mews: Reservation Management](https://www.mews.com/en-gb/products/reservation-management)
- [Mews: Space Management](https://www.mews.com/en/products/hotel-space-management)
- [Mews: Lokalsteuern und Tourismusabgaben](https://www.mews.com/de/blog/lokalsteuern-tourismusabgaben-fur-hoteliers)
- [Mews Community: Beherbergungsstatistik mit eSTATISTIK.core](https://community.mews.com/dach-based-customers-42/beherbergungsstatistik-mit-estatistik-core-2385)
- [apaleo API-Profil (api-evangelist)](https://github.com/api-evangelist/apaleo)
- [apaleo Developer Docs: Map rate plans](https://apaleo.dev/guides/business-cases/channel-integration/rates.html)
- [apaleo Help Center: Rate Plans and Rate Management](https://apaleo.zendesk.com/hc/en-us/articles/360010175080-Rate-Plans-and-Rate-Management)
- [Hotel Tech Report: Cloudbeds vs Mews](https://hoteltechreport.com/compare/cloudbeds-myfrontdesk-vs-mews)
- [Hotel Tech Report: Cloudbeds vs Opera](https://hoteltechreport.com/compare/cloudbeds-myfrontdesk-vs-opera)
- [HotelTech Review: Oracle Opera Cloud PMS Review 2026](https://hoteltech.review/opera-cloud-pms-review-2026)
- [QloApps auf GitHub](https://github.com/Qloapps/QloApps)
- [HotelMinder: Free and Open Source Hotel Software](https://www.hotelminder.com/list-of-the-best-free-and-open-source-hotel-software)
- [Rateboard: Restrictions in Hotel Revenue Management](https://www.rateboard.io/en/blog/restrictions-in-hotel-revenue-management)
- [Avon Data Systems: Derived rates](https://rezcontrol.com/should-you-use-derived-rates-for-your-hotel/)
- [SetupMyHotel: 3 Types of Front Office Ledger](https://setupmyhotel.com/hotel-staff-training/front-office-training/3-types-of-front-office-ledger-in-hotels/)
- [Wikipedia: City ledger](https://en.wikipedia.org/wiki/City_ledger)
- [GuruHotel: What is night audit](https://guruhotel.com/blog/what-is-night-audit-hotel)
- [RoomKeyPMS: Addressing No Show Reservations](https://support.roomkeypms.com/a/435754-addressing-no-show-reservations-mandatory-task)
- [zimrly: GoBD und Hotelsoftware](https://zimr.ly/blog/gobd-hotelsoftware)
- [Lodgit: KassenSichV und TSE](https://www.lodgit-hotelsoftware.de/kassensichv-tse.html)
- [softtec: TSE-Meldepflicht ab 2025](https://softtec.de/tse-meldepflicht/)
- [§ 29 BMG](https://www.juraforum.de/gesetze/bmg/29-besondere-meldepflicht-in-beherbergungsstaetten), [§ 30 BMG](https://www.gesetze-im-internet.de/bmg/__30.html)
- [Chekin: Der Meldeschein im Hotel](https://chekin.com/de/blog/meldeschein-im-hotel/)
- [Projekt 29: Meldescheine im Hotel](https://projekt29.de/meldescheine-im-hotel/)
- [Deutscher Tourismusverband: FAQ Elektronischer Meldeschein (PDF)](https://www.deutschertourismusverband.de/fileadmin/user_upload/Themen/Politik/FAQ_Elektronischer_Meldeschein.pdf)
- [Destatis: Tourismusstatistiken](https://www.destatis.de/DE/Themen/Branchen-Unternehmen/Gastgewerbe-Tourismus/Methoden/tourismus.html)
