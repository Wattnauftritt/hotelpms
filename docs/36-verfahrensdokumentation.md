# Verfahrensdokumentation nach GoBD — Vorlage für ein Haus mit StayGrid

Die Prüfung des Rechnungssystems vom 13.10.2026 fand: angekündigt in den Dokumenten 01, 06, 09 und 11, liegt aber nicht vor. Hier ist sie.

**Wessen Dokument das ist.** Die Verfahrensdokumentation ist Pflicht des **Hauses** (Rz. 151 ff. GoBD), nicht des Softwareanbieters. Wir liefern den Teil, den nur wir beschreiben können — wie das System Belege erzeugt, schützt und herausgibt — und lassen die Stellen offen, die nur das Haus kennt. Sie sind mit **[Haus: …]** markiert. Ein Haus übernimmt das Dokument, füllt diese Stellen und lässt es von seinem Steuerberater abnehmen (Dokument 08: das Testat ist vor dem Produktivgang ohnehin vorgesehen).

**Was es nicht ist.** Keine steuerliche Beratung und keine Zertifizierung. „GoBD-zertifiziert" gibt es nicht als amtliches Siegel (Dokument 05).

Gegliedert nach der Musterverfahrensdokumentation von AWV und DStV: allgemeine Beschreibung, Anwenderdokumentation, technische Systemdokumentation, Betriebsdokumentation, internes Kontrollsystem.

---

## 1. Allgemeine Beschreibung

| | |
|---|---|
| Unternehmen | **[Haus: Name, Rechtsform, Anschrift, Steuernummer, USt-IdNr.]** |
| Betriebsstätten | **[Haus: je Haus Name und Rechnungskürzel]** — mehrere Häuser eines Unternehmens teilen sich einen Nummernraum über das Kürzel (Migration 0157) |
| Verantwortlich für das Verfahren | **[Haus: Name, Funktion]** |
| Steuerberatung | **[Haus: Kanzlei, Ansprechpartner; Zugang über die Rolle „Steuerberatung"]** |
| Eingesetzte Software | StayGrid (Hotel-PMS), betrieben unter `staygrid.cloud`; Stand je Auslieferung über den Git-Tag `produktion` (Dokument 21) |
| Vorgelagerte Systeme | **[Haus: Channel-Manager, Buchungsportale, eigenes Backoffice]** |
| Nachgelagerte Systeme | Finanzbuchhaltung über DATEV (Steuerberatung) |
| Kasse | **Keine Kassenfunktion in StayGrid** (Dokument 09). **[Haus: eingesetzte Kasse mit TSE, falls vorhanden]** |
| Kartenzahlung | Über den Zahlungsdienstleister **[Haus: Anbieter]**; StayGrid speichert keine Kartendaten |

**Gegenstand des Verfahrens.** Erfassung der Leistungen eines Aufenthalts (Übernachtung, Frühstück, Inklusivleistungen, Zusatzleistungen), Ausstellung der Rechnungen, Aufzeichnung der Zahlungen und Anzahlungen, Verfolgung offener Posten und Übergabe an die Buchhaltung.

---

## 2. Anwenderdokumentation: der Weg eines Belegs

```
Buchung ─► Reservierung ─► Nachtlauf bucht je Geschäftstag ─► Folio
                                                    ▲            │
             Zusatzleistung, Korrektur, Umbuchung ──┘            ▼
                                                       Rechnung (Nummer, Beleg)
                                                                 │
                       Zahlungsvermerk, Anzahlung, Mahnung ◄─────┤
                                                                 ▼
                                              DATEV-Stapel ─► Steuerberatung
```

### 2.1 Leistungen

- **Übernachtung.** Der Nachtlauf schließt den Geschäftstag und bucht jede belegte Nacht als Position (`charge`) mit dem Datum dieser Nacht, nie mit „heute". Beherbergung trägt den ermäßigten Satz.
- **Frühstück und Inklusivleistungen** im Ratenpreis werden in derselben Buchung herausgerechnet (Aufteilungsgebot, § 12 Abs. 2 Nr. 11 Satz 2 UStG): Frühstück als Speisen zu 7 % und Getränke zu 19 % nach der BMF-Pauschale von 30 % (Schreiben vom 22.12.2025; Migration 0158), weitere Leistungen wie Parken je zu ihrem Satz (Migration 0165). Was an der Rate enthalten ist, pflegt das Haus unter **Preise → Ratenpläne**.
- **Zusatzleistungen** bucht die Rezeption am Folio mit Satz 0, 7 oder 19 %, das Konto folgt dem Satz.
- **Korrektur** ist eine Gegenbuchung, die auf die ursprüngliche Position verweist. Eine Position wird nie geändert oder gelöscht.
- **Umbuchen** zwischen Folios einer Buchung (etwa Logis an die Firma, Extras an den Gast) ist eine Gegenbuchung am einen und eine neue Position am anderen Folio.

**[Haus: welche Leistungen über die Kasse laufen und welche über das Folio]**

### 2.2 Rechnungen

- Die Rechnung entsteht im **Rechnungsdialog**: Vorschau, Anschrift (Stammdaten oder abweichend für diese Rechnung), Auswahl der Positionen, Zahlungsziel oder „bereits bezahlt". Erst „Festschreiben" vergibt die Nummer.
- **Nummer:** fortlaufend je Kürzel und Jahr, ohne Lücke; vergeben unter einer gesperrten Zählerzeile, auch bei gleichzeitigen Check-outs.
- **Beleg:** ein PDF mit eingebettetem XML nach EN 16931 (ZUGFeRD/Factur-X; mit Leitweg-ID des Empfängers als XRechnung 3.0). Er wird **einmal** erzeugt und mit seinem SHA-256-Fingerabdruck abgelegt (`invoice_document`, Migration 0024). Jeder spätere Abruf liefert dieselben Bytes.
- **Aussteller und Empfänger** stehen als Momentaufnahme an der Rechnung: eine spätere Änderung der Stammdaten ändert keine ausgestellte Rechnung.
- **Arten:** Rechnung, Zwischenrechnung, Anzahlungsrechnung, Stornorechnung. Eine **Stornorechnung** hat eine eigene Nummer, verweist auf die Ausgangsrechnung und nimmt deren Positionen als Gegenbuchung zurück; die berichtigte Rechnung entsteht danach neu (Migration 0161).
- **Kleinbetragsrechnung** bis 250 € brutto nach § 33 UStDV.
- **Kurtaxe** steht auf keiner Rechnung des Hauses; Ausstellerin ist die Gemeinde, Beleg ist die Kurkarte.

### 2.3 Zahlungen und Anzahlungen

- Eine Zahlung ist ein **Zahlungsvermerk** (`settlement`) mit Zahlart. Er zeichnet auf, was anderswo maßgeblich geschehen ist — an der Kasse, beim Zahlungsdienstleister, auf dem Bankkonto. StayGrid nimmt kein Geld an (Dokument 09).
- **Anzahlungen** laufen über ein eigenes Journal (`deposit_ledger`) mit Anzahlungsrechnung, je Steuersatz aufgeteilt nach dem erwarteten Aufenthalt. Die Schlussrechnung verrechnet sie je Satz mit Nummer und Datum der Anzahlungsrechnung; eine Rückzahlung ist ein eigener Eintrag (Migration 0162).
- **Offene Posten und Mahnung:** Rechnungen mit Zahlungsziel erscheinen unter **Rechnungen → Offene Posten**; jede Mahnstufe ist ein Eintrag (`invoice_reminder`, Migration 0163).
- **Kassenbuch** (Modul je Haus, Migration 0095): zeichnet Bargeld nachträglich auf; Zeilen unveränderlich, Korrektur als Gegenbuchung. **[Haus: ob das Modul genutzt wird und wo das maßgebliche Kassenbuch liegt]**

### 2.4 Übergabe an die Buchhaltung

- **DATEV-Stapel** (EXTF, `Berichte → Exporte`), geschnitten nach dem Geschäftstag der Rechnung. Je Rechnung und Satz das Brutto der Satzgruppe, wie es auf dem Beleg steht. Kontenrahmen SKR03 mit Automatikkonten: 8300 (7 %), 8400 (19 %), 8200 (0 % und Rundung), verrechnete Anzahlungen über 1718, Debitor 10000. **[Haus: abweichende Konten mit der Steuerberatung abstimmen]**
- **Rhythmus:** **[Haus: monatlich bis zum …, durch …]**
- Ein **Übungshaus** (`is_training`) trägt ein eigenes Kürzel und exportiert nichts nach draußen; die Exporte weisen es ab.

---

## 3. Technische Systemdokumentation

### 3.1 Unveränderlichkeit (Rz. 58 ff., 107 ff. GoBD)

| Härtegrad | Tabellen | Schutz |
|---|---|---|
| 1 — unveränderlich | `charge`, `settlement`, `invoice`, `invoice_document`, `audit_log`, `deposit_ledger`, `invoice_reminder`, Kassenbuch (`cashbook_entry`) | Die Anwendungsrolle hat **kein** `UPDATE` und **kein** `DELETE`. Einzige Ausnahme: der einmalige Übergang `invoice_id` von leer auf einen Wert (Migration 0012) |
| 2 — festgeschrieben nach einem Ereignis | Reservierungsnächte nach dem Buchen | Gebuchte Nächte werden nicht neu verteilt |
| 3 — änderbar mit Protokoll | Stammdaten | Jede Änderung im Protokoll |

Die Rechte setzt die Datenbank durch, nicht die Anwendung: ein Fehler im Code kann eine Rechnung nicht ändern. Löschen von Kassenbuchzeilen geht einzig über `cashbook_erase()` und nur, solange nichts davon an DATEV ging (Migration 0100).

### 3.2 Protokoll

Ein Trigger schreibt jede Änderung an protokollierten Tabellen in `audit_log` (Zeitpunkt, Benutzer, Tabelle, alter und neuer Wert). Personenbezogene Werte und Geheimnisse werden dabei geschwärzt (`audit_redaction`, Migration 0044) — das Protokoll weist nach, **dass** und **wann** sich etwas änderte, ohne eine zweite, unlöschbare Kopie von Gastdaten zu erzeugen.

### 3.3 Zeit

Fristen, Nummernjahr und Ausstellungstag rechnen in der Zeitzone des Hauses und gegen den **Geschäftstag**, nicht gegen die Uhr der Maschine.

### 3.4 Zugriff

Rollen und Rechte nach Dokument 14. Jede Anfrage läuft mit dem Mandantenkontext aus der Anmeldung; die Datenbank filtert per Zeilenrichtlinie, sodass ein Haus nur seine eigenen Daten sieht. Ein zweiter Faktor (TOTP) ist nach Dokument 14 für Inhaber, Direktion, Buchhaltung und Steuerberatung vorgesehen. **[Haus: ob er eingerichtet ist]**

### 3.5 Datenzugriff der Finanzverwaltung (§ 147 Abs. 6 AO)

| Art | Umsetzung |
|---|---|
| Z1 unmittelbar | Lesender Zugang mit der Rolle **Steuerberatung** (Rechnungen, Exporte) für die Prüferin oder den Prüfer |
| Z2 mittelbar | Auswertung durch das Haus nach Vorgabe, über dieselbe Oberfläche |
| Z3 Datenträgerüberlassung | **GoBD-Archiv** (`Berichte → Exporte`, ZIP): `index.xml` nach GDPdU-Beschreibungsstandard, Rechnungen, Positionen, Zahlungsvermerke, Anzahlungsjournal und Änderungsprotokoll als CSV, dazu je Rechnung PDF und XML unverändert |

### 3.6 Software

Quelltext unter Versionsverwaltung; jede Änderung läuft durch eine automatische Prüfung (Tests gegen eine echte Datenbank, Typprüfung, Prüfung der E-Rechnungen gegen das Schematron von EN 16931) und wird erst über den Tag `produktion` ausgeliefert. Datenbankänderungen sind fortlaufend nummerierte Migrationen, die nie nachträglich geändert werden. Die Geschichte jeder Änderung bleibt damit nachvollziehbar.

---

## 4. Betriebsdokumentation

- **Betrieb:** **[Haus oder Betreiber: wer die Maschine betreibt]**. Aufbau in Dokument 21, Abläufe in Dokument 17.
- **Sicherung:** laufend und täglich, verschlüsselt, außer Haus bei zwei Anbietern; dazu jährlich der GoBD-Export je Haus mit Belegen und Kassenbuch, zehn Jahre unveränderbar gesperrt (Dokument 37). Die Rückspielung wird vierteljährlich geprobt und mit Datum und Ergebnis protokolliert (`scripts/backup/rueckspielprobe.sh`). **[Haus: Protokoll der Rückspielungen]**
- **Aufbewahrung:** Buchungsbelege acht Jahre (§ 147 Abs. 3 AO seit 2025), Aufzeichnungen zehn. Die Sicherung erfüllt das nicht und soll es nicht; dafür ist der laufende Bestand da. Ein ausscheidendes Haus wird stillgelegt, nicht gelöscht, und erhält seinen Export (Dokument 17 §6).
- **Gastlöschung:** heißt anonymisieren (Art. 17 DSGVO gegen § 147 AO). Rechnungen, Positionen und Zahlungsvermerke bleiben unberührt; die Momentaufnahme des Empfängers an der Rechnung bleibt, weil eine Rechnung ohne Empfänger wertlos wäre.
- **Störung:** Erzeugt der Worker einen Beleg nicht, bleibt die Rechnung festgeschrieben, und der Versuch wird wiederholt (`invoice_document_failure`); der Beleg entsteht aus den festgeschriebenen Daten, nicht aus dem aktuellen Stand.

---

## 5. Internes Kontrollsystem

| Kontrolle | Wo |
|---|---|
| Rechnung erst nach Vorschau | Rechnungsdialog |
| Check-out fragt bei offenem Saldo oder nicht abgerechneten Positionen nach | Abreise |
| Eingaben am Folio geprüft (Satz, Menge, Betrag) | Folio |
| Pflichtangaben der E-Rechnung vor dem Ausstellen geprüft; fehlende Angaben des Hauses werden unter Einstellungen → Rechnungen genannt | Rechnungsdialog, Einstellungen |
| Beleg wird nur erzeugt, wenn Positionen, Steuer je Satz und Summe übereinstimmen | Worker |
| Doppelte Buchung bei wiederholtem Klick ausgeschlossen (Idempotenzschlüssel je Vorgang) | alle Buchungen |
| Rechnungskürzel Pflicht, sobald ein Unternehmen zwei Häuser führt | Einstellungen → Rechnungen |
| Übungsdaten erreichen keinen Export | Übungshaus |
| **[Haus: Vier-Augen-Prinzip bei Storno, Abgleich Zahlungsvermerke mit Bank und Kasse, Monatsabstimmung mit der Steuerberatung]** | |

---

## 6. Änderungen an diesem Dokument

| Datum | Änderung | Wer |
|---|---|---|
| 13.10.2026 | Erste Fassung (Vorlage) | StayGrid |
| **[Haus]** | Übernommen und ergänzt | |
| **[Haus]** | Abgenommen durch Steuerberatung | |
