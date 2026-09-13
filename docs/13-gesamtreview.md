# Gesamtreview: Widersprüche, logische Fehler, Lücken

Zweites Review, diesmal über alle zwölf Dokumente im Zusammenhang. Das erste Review in [12-security-und-performance-review.md](12-security-und-performance-review.md) prüfte Architektur und Umsetzungsplan. Dieses prüft zusätzlich, ob die Dokumente einander widersprechen, ob der Entwurf logisch schließt, und **was einem Hotel fehlen würde**.

Schweregrade wie in Dokument 12: **kritisch** vor dem ersten Kunden, **hoch** vor Produktivgang, **mittel** vor Wachstum, **niedrig** beobachten. Zusätzlich **Entscheidung**, wo der Auftraggeber entscheiden muss, weil ein späterer Umbau teuer wäre.

---

# Teil A: Veralteter Text und Widersprüche zwischen Dokumenten

Alle Punkte in diesem Teil sind **in den betroffenen Dokumenten bereits korrigiert**. Sie stehen hier, damit nachvollziehbar bleibt, was sich geändert hat.

| Nr. | Wo | Was falsch war | Korrektur |
|---|---|---|---|
| A1 | 02 §1 Leitlinien | „TSE" als Kernpflicht | Entfernt, Entscheidung 9 |
| A2 | 02 §2, 02 §8, 08 §1.3 | Entität `Payment` mit „TSE-Signatur", Tabelle `tse_transaction` | Ersetzt durch `settlement`, TSE-Tabelle entfernt |
| A3 | 02 §6 | Modul „Compliance: TSE, DSFinV-K", extern „Cloud-TSE (fiskaly)" | Auf Meldeschein, GoBD-Export, Statistik, Löschkonzept reduziert |
| A4 | 04 §2.5 | „Wer pflegt die Zähler? Empfehlung: Trigger" | Widerspricht W1 in Dokument 12. Ersetzt durch die drei SQL-Funktionen als einziger Besitzer |
| A5 | 08 §1.5 | „Datenbanksequenz **oder** gesperrte Zählerzeile" | Sequenzen hinterlassen bei Rollback Lücken. Nur Zählerzeile |
| A6 | 08 §1.2 | „Nachtlauf ist Festschreibungszeitpunkt für den **Kassenbereich**" | Es gibt keinen Kassenbereich mehr. Der Nachtlauf schreibt die Charges des Geschäftstags fest |
| A7 | 10 §1 Zielbild | „Plesk-Nginx", „127.0.0.1" | Caddy, Unix-Socket |
| A8 | 10 §2 | „Zwei Server mit systemd" | Eine VM |
| A9 | 10 §7 | Satz über Plesk-Domain im Proxy-Modus, PostgreSQL „beziehungsweise 127.0.0.1", Umgebungstabelle mit Plesk-Subdomain und zwei Servern | Auf VM-Aufbau umgestellt |
| A10 | 10 §7 systemd-Einheit | API lauscht auf TCP, Caddy erwartet Unix-Socket, `ReadWritePaths` deckt `/run/hotelpms` nicht ab | `RuntimeDirectory=hotelpms`, API lauscht auf Socket |
| A11 | 11 §1, §5 | `ops/nginx/ Plesk-Zusatzdirektiven`, Sicherung „Plesk-Konfiguration" | `ops/caddy/`, Proxmox-Sicherung |
| A12 | 02 §8 | „Sprache/Framework: noch offen" | Entschieden, Verweis auf Dokument 10 |

---

# Teil B: Logische Fehler im Entwurf

## B1 — Nachtlauf schaltet das Geschäftsdatum als letzten Schritt (kritisch)

Dokument 02 §5 listet den Tageswechsel als Schritt 6 von 6. Das erzeugt zwei Fehler:

1. Während der Nachtlauf läuft, buchen Rezeption und Worker mit dem **alten** Geschäftsdatum weiter, obwohl der Lauf dieses Datum gerade abschließt. Bei einem Lauf von 30 Sekunden landen Charges im falschen Tag.
2. Bricht der Lauf bei Schritt 4 ab, ist das Datum nie umgeschaltet, aber Logis ist teilweise gebucht. Ein Wiederholungslauf kann nicht unterscheiden, was schon erledigt ist.

**Korrektur:** Der Tageswechsel ist **Schritt 1**, eine einzige atomare Zeilenänderung an `business_day`. Alle folgenden Schritte arbeiten ausdrücklich mit dem **geschlossenen** Datum als Parameter, nie mit „dem aktuellen". Idempotenz wird je `(property, business_date, schritt)` geführt: Jeder Schritt schreibt nach Abschluss eine Marke, ein Wiederholungslauf überspringt markierte Schritte.

## B2 — Hausweites Overbooking ist gefordert, aber nicht entworfen (hoch)

Dokument 02 §4 verlangt eine Property-Gesamtverfügbarkeit, damit Kategorien-Overbooking nicht zu Hausüberbuchung führt. `inventory_day` ist aber ausschließlich je Kategorie. Erlaubt jede von drei Kategorien zwei Zimmer Überbuchung, ist das Haus um sechs überbucht, ohne dass es irgendwo sichtbar wird.

**Korrektur:** Eine zusätzliche Zeile je Property und Tag mit `category_id = 0` als Haussumme, von denselben drei SQL-Funktionen mitgeführt. `inventory_reserve` prüft zuerst die Kategoriezeile, dann die Hauszeile, beide in derselben Anweisung über ein `UPDATE ... FROM`. Die Sperrreihenfolge bleibt aufsteigend nach `category_id`, die Hauszeile mit 0 kommt daher stets zuerst.

## B3 — Rechnung ist als „Folio festschreiben" modelliert, Zwischenrechnungen sind unmöglich (hoch)

Ein Langzeitgast bekommt wöchentlich eine Rechnung, das Folio bleibt offen. Eine Firma bekommt eine Rechnung für die Logis, der Gast eine für die Extras, beide aus demselben Aufenthalt. Das Modell „eine Rechnung schließt das Folio" kann beides nicht.

**Korrektur:** Eine Rechnung umfasst eine **Menge von Charges**, nicht ein Folio. `charge.invoice_id` ist nullable, wird beim Festschreiben gesetzt und danach nie geändert. Ein Folio kann beliebig viele Rechnungen haben. Eine Charge gehört zu höchstens einer Rechnung. Ein Storno der Rechnung erzeugt Gegenbuchungen für genau ihre Charges.

## B4 — Anzahlungen erzeugen in Deutschland eine Steuerpflicht, die das Modell nicht kennt (hoch)

Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Umsatzsteuer auf eine Anzahlung mit Vereinnahmung. Das Hotel muss eine **Anzahlungsrechnung** mit Steuerausweis stellen und später eine **Schlussrechnung**, in der die Anzahlung abgesetzt wird. Ein `settlement` ohne Charge ist im aktuellen Modell nur ein negativer Saldo, steuerlich unsichtbar.

**Korrektur:** Anzahlung als eigener Vorgang: `POST /folios/{id}/deposit-invoice` erzeugt eine Rechnung mit einer Charge vom Typ „Anzahlung" und passendem Steuersatz. Die Schlussrechnung zieht sie als negative Position ab. Muss vom Steuerberater abgenommen werden, die Zuordnung 7 zu 19 Prozent auf eine pauschale Anzahlung ist nicht trivial.

## B5 — Rundungsregel fehlt (hoch)

`charge` speichert `net_cent`, `tax_cent`, `gross_cent` je Zeile. Auf der Rechnung wird die Steuer aber **je Steuersatz auf die Summe** ausgewiesen. Zwanzig Frühstücke zu 8,40 Euro netto ergeben je Zeile gerundet einen anderen Steuerbetrag als 168,00 Euro mal 19 Prozent. Die Differenz sind Cents, und ein Betriebsprüfer findet sie.

**Korrektur:** Charges speichern Netto und Steuersatz. Die Rechnung berechnet die Steuer **je Satzgruppe aus der Nettosumme** und speichert ihre eigenen Summen unveränderlich. Der DATEV-Export nutzt die Rechnungssummen. `tax_cent` je Charge bleibt als Näherung für offene Folios, ist aber nie die Grundlage einer Rechnung.

## B6 — Rechnung ohne Aussteller-Momentaufnahme (hoch)

Ändert das Hotel Adresse, Steuernummer oder Firmierung, dürfen alte Rechnungen nicht mitwandern. `invoice` referenziert `property`, speichert die Ausstellerdaten aber nicht.

**Korrektur:** `invoice` speichert Aussteller und Empfänger als **Momentaufnahme** in eigenen Spalten, nicht als Referenz. Dasselbe gilt für Positionstexte.

## B7 — Kinderalter fehlen, Kurtaxe und Kinderpreise brauchen sie (mittel)

`reservation.children` ist eine Zahl. Kurtaxe-Satzungen staffeln nach Alter, Kinderpreise ebenso. Aus einer Anzahl lässt sich keine Ausnahme berechnen.

**Korrektur:** Tabelle `reservation_occupant` mit Alter zum Anreisetag statt Zähler. Das ist ohnehin die Struktur, die der Meldeschein für Mitreisende braucht.

## B8 — Gästeprofil ist je Property, Ketten brauchen es je Account (entschieden)

> **Entschieden als Entscheidung 13:** je Account. Datenmodell in Dokument 10 nachgezogen, Rollenmodell in Dokument 14.

Entscheidung 2 schließt Multi-Property ein. Ein Stammgast einer Kette mit fünf Häusern ist derzeit fünf verschiedene Datensätze. `guest.property_id NOT NULL` verhindert ein gemeinsames Profil, und RLS auf `property_id` würde es sowieso verbergen.

**Das ist die eine Strukturentscheidung, die nachträglich am teuersten ist.** Empfehlung: `guest.account_id NOT NULL`, `guest.property_id` entfällt. Sichtbarkeit per RLS auf `account_id`, feinere Steuerung über eine Tabelle `guest_property_visibility`, falls ein Account seine Häuser voneinander abschotten will. Muss **vor AP 6** entschieden sein.

## B9 — Nur-Nacht-Constraint blockiert Tagesnutzung später (niedrig)

`CHECK (departure > arrival)` verbietet Tagesbelegung. Entscheidung 8 verschiebt Zeiteinheiten, aber der Constraint muss dann fallen. Jetzt nur vermerken, damit niemand darauf aufbaut.

## B10 — No-Show-Regel ist eine feste Zeit (niedrig)

„Tageswechsel ohne Check-in" gilt für alle. Häuser unterscheiden zwischen garantierten Reservierungen, die bleiben, und ungarantierten, die um 18 Uhr verfallen. Gehört an `cancellation_policy` als `no_show_cutoff` und `guaranteed`.

## B11 — Späte Stornos und der DATEV-Export (niedrig)

Wird eine Rechnung storniert, nachdem ihr Zeitraum bereits exportiert wurde, muss das Storno im **Zeitraum des Stornos** erscheinen, nicht im ursprünglichen. Der Export ist nach `business_date` zu schneiden, nie nach Rechnungsdatum. Festhalten, bevor AP 11 beginnt.

---

# Teil C: Sicherheit, bisher nicht erfasst

## C1 — Öffentliche Kennungen sind fortlaufende Zahlen (kritisch)

Alle Primärschlüssel sind `bigint identity`. Sobald eine Gästeseite existiert, etwa Online-Check-in, Rechnungsdownload oder Buchungsbestätigung, lässt sich mit `reservation/1234` jede andere Reservierung durchprobieren. Mit Nachname als zweitem Faktor ist das nur eine Frage der Zeit.

**Korrektur:** Jede nach außen sichtbare Entität bekommt eine zufällige `public_ref`, etwa zehn Zeichen aus einem Alphabet ohne verwechselbare Zeichen, mit Unique-Index. Gästeseiten und Links kennen **nur** diese Referenz. Interne bigints bleiben intern. Zusätzlich Ratenbegrenzung auf allen unauthentifizierten Endpunkten.

## C2 — Der OAuth-Autorisierungsserver ist nirgends benannt (hoch)

Dokument 10 schreibt „OAuth 2.0 mit PKCE und Client Credentials", als wäre das eine Bibliotheksfunktion. Ein Autorisierungsserver mit Token-Ausgabe, Refresh-Rotation, Introspektion und PKCE ist ein eigenes Sicherheitsprodukt. Selbst gebaut ist er die häufigste Quelle für Authentifizierungsfehler.

**Korrektur:** Eine zertifizierte Bibliothek, eingebettet in den API-Prozess: `node-oidc-provider`. Kein zusätzlicher Dienst, keine Eigenentwicklung der Protokollteile. Keycloak oder Zitadel wären die Alternative, falls später ein Kunde SSO mit seinem Firmenverzeichnis will.

## C3 — Verschlüsselung der VM-Platte fehlt (hoch)

Eigene Hardware bedeutet: Ein ausgebauter Datenträger, ein weiterverkaufter Host, ein Einbruch. Ohne Verschlüsselung liegen alle Gästedaten im Klartext auf dem Blech.

**Korrektur:** LUKS auf dem VM-Datenträger oder native ZFS-Verschlüsselung auf dem Host. Der Schlüssel darf nicht auf demselben Datenträger liegen. Dasselbe gilt für jedes Sicherungsmedium.

## C4 — Schlüsselverwaltung und Rotation haben keinen Prozess (hoch)

Datenbankpasswort, Sitzungsgeheimnis, AES-Schlüssel für Ausweisnummern, Sicherungsschlüssel, Webhook-Geheimnisse. Alle in `shared/env`, keine Rotation.

**Korrektur:** Für den AES-Schlüssel eine `key_version`-Spalte neben jedem verschlüsselten Feld, damit Rotation als Umschlüsselung im Hintergrund möglich ist. Der Sicherungsschlüssel liegt **nicht** auf der VM, sondern nur dort, wo wiederhergestellt wird. Rotationsplan als Betriebsdokument, halbjährlich.

## C5 — Audit-Trigger kennt den Benutzer nicht (hoch)

Der Trigger schreibt `user_id`, aber ein Datenbank-Trigger weiß nichts vom HTTP-Benutzer. Ohne Übergabe steht dort immer `NULL`, und das Protokoll ist für die GoBD wertlos.

**Korrektur:** Zu Beginn jeder Transaktion `set_config('app.user_id', ..., true)`, genau wie der Mandantenkontext. Der Trigger liest es mit `current_setting('app.user_id', true)`. Ein Test weist nach, dass kein Audit-Eintrag mit leerem Benutzer entsteht.

## C6 — Sitzungen und Tabellen ohne `property_id` unter RLS (mittel)

Sitzungen liegen ohne Redis in PostgreSQL. Vor der Anmeldung gibt es keinen Mandantenkontext. `session`, `user`, `account`, `oauth_client` brauchen eigene Richtlinien, sonst blockiert RLS die Anmeldung, oder sie sind ungeschützt.

**Korrektur:** Für diese Tabellen Richtlinien auf `user_id` beziehungsweise `account_id`. Ein Aufräumjob für abgelaufene Sitzungen.

## C7 — Ratenbegrenzung hat keinen Ort (mittel)

Ohne Redis stellt sich die Frage, wo gezählt wird.

**Korrektur:** Zwei Ebenen. Caddy begrenzt je IP am Rand, vor allem für unauthentifizierte Pfade. Der API-Prozess begrenzt je Client-ID im Speicher. Bei wenigen Prozessen auf einer VM ist die Ungenauigkeit über Prozesse hinweg vertretbar.

## C8 — Protokolle und Fehlerberichte enthalten Gästedaten (mittel)

`pino` und Sentry sehen Anfragerümpfe. Ein Meldeschein-POST enthält Ausweisnummern.

**Korrektur:** Redaktionsliste für Logs und Fehlerberichte, Anfragerümpfe grundsätzlich nicht protokollieren, nur Metadaten.

## C9 — DSGVO-Auskunft fehlt, nur Löschung ist geplant (mittel)

Art. 15 verlangt eine Kopie aller Daten zu einer Person. AP 6 plant nur Anonymisierung.

**Korrektur:** Ein Job, der alle Daten zu einer Gast-ID über alle Properties eines Accounts als Archiv erzeugt, mit Frist von einem Monat.

## C10 — Migrationsrolle in der Auslieferung (mittel)

Die Eigentümerrolle ist das mächtigste Geheimnis. Der Deploy braucht es.

**Korrektur:** GitHub-Umgebung „production" mit Pflichtprüfer, Geheimnis nur dort, Migrationen als eigener Schritt mit Freigabe.

## C11 — Schulungs- und Testbetrieb auf Produktivdaten (niedrig)

Rezeptionisten üben. Ohne Trainingsmodus üben sie an echten Gästen.

**Korrektur:** Flag `property.is_training`. Solche Properties sind von Exporten, Statistik und Rechnungsnummernkreisen ausgeschlossen.

---

# Teil D: Performance, bisher nicht erfasst

## D1 — LISTEN/NOTIFY funktioniert nicht durch PgBouncer (hoch)

Graphile Worker und die in Dokument 04 §2.6 erwähnte Cache-Invalidierung nutzen `LISTEN/NOTIFY`. Im Transaction Mode von PgBouncer kommt eine Benachrichtigung nie an, weil die Sitzung nach jeder Transaktion wechselt. Der Worker fällt dann still auf reines Polling zurück, Jobs verzögern sich um Sekunden.

**Korrektur:** Der Worker und jeder `LISTEN`-Nutzer verbinden sich **direkt** mit PostgreSQL über den Unix-Socket, nicht über PgBouncer. Zwei Verbindungsziele in der Konfiguration, im Test geprüft.

## D2 — Gästesuche ohne Trigramm-Index (hoch)

Die Rezeption sucht nach Namensteilen. `ILIKE '%mül%'` ohne Index ist ein vollständiger Tabellenscan, bei einer Kette mit einer Million Gästen mehrere Sekunden bei jedem Tastendruck.

**Korrektur:** Erweiterung `pg_trgm`, GIN-Indizes auf `guest.last_name`, `guest.email`, `guest.phone`. Suche ab drei Zeichen, mit Verzögerung in der Oberfläche.

## D3 — Prozessanzahl auf der VM unbestimmt (mittel)

Node ist einkernig. Wie viele API-Prozesse, wie viele Kerne für PostgreSQL?

**Korrektur:** Bei 8 vCPU: 3 API-Prozesse, 1 Worker, Rest für PostgreSQL. PgBouncer `default_pool_size = 20`, `max_connections = 100`. Unter Last messen und anpassen.

## D4 — Kein Replikat zum Start, Berichte laufen auf dem Primärsystem (mittel)

P11 in Dokument 12 sah das Replikat vor, Entscheidung 11 startet mit einer VM.

**Korrektur:** `hotelpms_readonly` mit `statement_timeout = 30s` und `work_mem` begrenzt, damit ein schwerer Bericht die Rezeption nicht blockiert. Replikat, sobald der zweite Standort steht.

## D5 — Überlappungsabfrage kann besser (niedrig)

Der B-Baum auf `(property_id, departure, arrival)` filtert `arrival` nach dem Scan. Ein GiST-Index auf `daterange(arrival, departure)` mit `&&` ist selektiver. Erst bei Bedarf, mit `EXPLAIN` belegt.

---

# Teil E: Was einem Hotel fehlen würde

Das ist der Teil, für den die anderen Dokumente blind waren, weil sie von der Technik her dachten.

## E1 — Das Pilothaus kann ohne Import nicht starten (kritisch)

AP 14 „Datenimport" ist als „später" markiert. Aber das Pilothaus hat am Starttag bereits Reservierungen für die nächsten Monate. Ohne die geht es nicht produktiv.

**Korrektur:** Ein **minimaler CSV-Import** für künftige Reservierungen, Gäste und Kategorien rückt nach Stufe 1. Die Adapter für hotline, HS/3 und protel bleiben in AP 14.

## E2 — Beherbergungsstatistik ist eine monatliche Pflicht ab dem ersten Monat (hoch)

Betriebe ab zehn Betten melden monatlich. Stufe 3 plant die eSTATISTIK.core-Anbindung. Bis dahin muss das Pilothaus die Zahlen von Hand melden können.

**Korrektur:** Ein einfacher Monatsbericht mit Ankünften, Übernachtungen und Herkunftsländern nach Stufe 1. Die automatische Übermittlung bleibt Stufe 3.

## E3 — E-Rechnung braucht PDF/A-3, Chromium liefert das nicht (hoch)

Die B2B-Ausstellungspflicht kommt gestaffelt bis 2028. ZUGFeRD ist PDF/A-3 mit eingebettetem XML. Chromium erzeugt gewöhnliches PDF.

**Korrektur:** Nach der Chromium-Erzeugung ein Konvertierungsschritt nach PDF/A-3 und das Einbetten des XML, etwa über Ghostscript und eine ZUGFeRD-Bibliothek. Gehört als eigener Punkt in AP 7, weil er die PDF-Pipeline verändert.

## E4 — Rechnungspflichtangaben nach § 14 UStG (hoch)

Steuernummer oder USt-ID des Ausstellers, Leistungszeitraum, Rechnungsdatum, fortlaufende Nummer, Steuersätze mit Beträgen, bei Kleinbetragsrechnungen unter 250 Euro erleichterte Angaben.

**Korrektur:** Prüfliste in AP 7, ein Test je Pflichtangabe. Rechnungen in Deutsch und Englisch, weil ausländische Gäste sie für ihre Spesen brauchen.

## E5 — Kein Notbetrieb bei Internetausfall (mittel)

SaaS ohne Netz ist tot. SoftTec hat dieselbe Schwäche. Für die Rezeption ist der Ausfall am Anreisetag der schlimmste Moment.

**Korrektur:** Die Oberfläche hält Anreise- und Hausliste des Tages sowie Zimmerstatus in einem Service Worker als **lesbare** Kopie. Kein Offline-Schreiben, aber wissen, wer kommt und wo er hin soll.

## E6 — Sammelmeldeschein für Gruppen (mittel)

§ 29 BMG erlaubt für Reisegruppen eine Liste statt Einzelscheinen. Bei einem Reisebus mit 45 Personen ist das der Unterschied zwischen zehn Minuten und einer Stunde.

**Korrektur:** In AP 10 als Variante des Meldescheins vorsehen.

## E7 — Ausscheiden eines Betriebs (mittel)

Ein Hotel kündigt. Die Daten müssen acht bis zehn Jahre bleiben, der Betrieb darf nicht mehr buchen, das Hotel will seine Daten mitnehmen.

**Korrektur:** `property.status = archived`, Sperre aller schreibenden Operationen, ein **Mandantenexport** als Archiv. Das ist auch DSGVO-Portabilität.

## E8 — Reservierung mit Kartengarantie am Telefon (mittel)

Der klassische Fall: Gast ruft an, nennt seine Kartennummer als Garantie. Wer die Nummer notiert, verletzt PCI DSS.

**Korrektur:** Kein Feld für Kartendaten, nirgends. Garantie ausschließlich per Pay-by-Link oder virtuellem Terminal des Zahlungsdienstleisters. Die Oberfläche bietet das an Ort und Stelle an.

## E9 — Gästesperrliste (niedrig)

Hotels führen eine Liste von Personen, die sie nicht mehr beherbergen. Berechtigtes Interesse nach DSGVO, aber mit Begründungspflicht und Frist.

**Korrektur:** Später. Beim Datenmodell nur darauf achten, dass ein Vermerk am Gast mit Grund und Ablaufdatum möglich ist.

## E10 — Provisionen aus OTA-Buchungen (niedrig)

Für die Wirtschaftlichkeitsbetrachtung je Kanal braucht der Betrieb die Provision. `booking.source` reicht dafür nicht.

**Korrektur:** `booking.commission_bp` als Feld, vom Kanal befüllt. Auswertung in AP 11.

## E11 — Aufenthaltsverlängerung mit Kategoriewechsel (niedrig)

Gast bleibt länger, aber seine Kategorie ist ausgebucht, eine andere frei. Das ist eine Verlängerung plus Umzug in einer Transaktion.

**Korrektur:** In AP 5 als Fall des Zustandsautomaten aufnehmen, damit die Inventarfunktionen dafür einen atomaren Pfad haben.

---

# Teil F: Was vor Arbeitspaket 0 zu ändern ist

Punkte, die die Struktur betreffen. Nachträglich sind sie Datenmigrationen.

| Nr. | Änderung | Betrifft |
|---|---|---|
| B1 | Tageswechsel als Schritt 1, Schrittmarken je Lauf | AP 8, Entwurf jetzt |
| B2 | Haussummenzeile in `inventory_day`, Prüfung in `inventory_reserve` | AP 4 |
| B3 | `charge.invoice_id`, Rechnung als Charge-Menge | AP 7, Schema jetzt |
| B4 | Anzahlungsrechnung als Vorgang | AP 7, Steuerberater |
| B5 | Rundungsregel: Steuer je Satzgruppe auf der Rechnung | AP 7 |
| B6 | Aussteller- und Empfänger-Momentaufnahme auf `invoice` | AP 7, Schema jetzt |
| B7 | `reservation_occupant` statt Zähler | AP 5, Schema jetzt |
| B8 | Gästeprofil je Account statt je Property | **Entschieden**, Entscheidung 13 |
| C1 | `public_ref` auf allen nach außen sichtbaren Entitäten | AP 0, Schema jetzt |
| C2 | `node-oidc-provider` als Autorisierungsserver | AP 1 |
| C5 | `app.user_id` je Transaktion, vom Audit-Trigger gelesen | AP 0 |
| D1 | Worker verbindet direkt, nicht über PgBouncer | AP 0 |
| E1 | Minimaler CSV-Import nach Stufe 1 | Roadmap |
| E2 | Monatsstatistik nach Stufe 1 | Roadmap |

Alles Übrige sind Ergänzungen der Arbeitspakete und in [11-umsetzungsplan.md](11-umsetzungsplan.md) nachgetragen.

---

# Teil G: Was standhält

Damit das Bild nicht schief wird. Diese Entscheidungen haben auch dem zweiten Durchgang standgehalten:

- Zählertabelle mit atomarer Belegung. Mit der Haussummenzeile aus B2 ist sie vollständig.
- Drei Härtegrade statt append-only für alles. Kein Fund in diesem Review hat das infrage gestellt.
- Keine Kassenfunktion. Alle Kassenbefunde aus früheren Dokumenten sind damit gegenstandslos, und kein neuer kam hinzu.
- Jobs in derselben Transaktion. Mit D1 richtig angeschlossen, bleibt es die beste Einzelentscheidung im Hintergrundteil.
- Eigene VM mit Caddy. Die Sicherheitsbefunde C3 und C4 betreffen den Betrieb darauf, nicht die Entscheidung dafür.
- Abfragezähler und Berechtigungstest vor dem ersten Endpunkt. Beide fangen genau die Fehlerklassen ab, die in diesem Review am häufigsten auftauchten.
