# Keine Kassenfunktion: Entscheidung und Abgrenzung

**Entscheidung: Unser PMS führt kein Kassenbuch, weder verpflichtend noch als Modul. Es hat keine Kassenfunktion und braucht daher keine TSE.**

Das ist die dritte und finale Fassung dieses Dokuments. Die ersten beiden lagen falsch: die erste machte das Kassenbuch zur Pflicht, die zweite zum optionalen Modul. Beides war mehr, als das Produkt braucht.

---

## 1. Die Begründung

Die Marktrealität, an der sich die Entscheidung ausrichtet:

- **Jedes Hotel führt bereits ein Kassenbuch.** Es gibt keinen Betrieb ohne Kassenführung, also gibt es auch keinen Bedarf, den wir decken würden.
- **Die meisten Hotels planen mit dem PMS die Belegung** und wickeln Zahlungen getrennt ab: bar oder Karte an der Rezeption, oder gleich über das Buchungsportal und den Channel Manager.
- **Die Fiskalisierung passiert dort, wo kassiert wird**, also an der Ladenkasse der Rezeption oder beim Portal. Nicht bei uns.
- **Hat die Rezeption eine Ladenkasse mit TSE**, über die sie Buchungen abrechnet, betrifft uns das nicht. Die TSE-Pflicht knüpft an das System an, das kassiert.

Und der Produktgrundsatz dahinter: **Nichts aufzwingen, was der Betrieb schon führt.** Ein erzwungener Umstieg bei einem laufenden System ist abschreckend, und zwar genau bei der Zielgruppe, die wir gewinnen wollen. Das ist dieselbe Kritik, die wir in [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md) an der vertikalen Bündelung von SoftTec formuliert haben.

---

## 2. Was das PMS stattdessen tut

### Fakturierung: ja

Rechnungen erstellen bleibt Kernfunktion. Das ist ausdrücklich **keine Kassenfunktion**. Die amtliche Position nennt Fakturierungslösungen neben Warenwirtschafts- und Buchhaltungssystemen als Beispiele für Systeme, die **nicht** unter § 146a AO fallen, solange sie kein Kassenmodul haben.

Was das bedeutet:

- Folios, Charges, Routing, Split Billing, Rechnung mit fortlaufender Nummer, Storno als Gegenbuchung
- Umsatzsteueraufteilung 7 zu 19 Prozent, Kurtaxe
- Vollständig GoBD-fest nach [08-compliance-in-der-praxis.md](08-compliance-in-der-praxis.md)
- **Keine TSE, keine Meldepflicht nach § 146a AO, kein DSFinV-K**

### Zahlungsvermerk: ja, aber strukturiert und nicht führend

Der Betrieb muss im PMS sehen, was offen ist und was beglichen wurde. Sonst funktioniert keine Debitorenübersicht und kein Check-out.

**Ein Freitextfeld taugt dafür nicht.** Ein strukturierter Vermerk schon:

| Feld | Inhalt |
|---|---|
| `beglichen_am` | Datum |
| `beglichen_art` | Bar, Karte vor Ort, Überweisung, Portal, Firmenrechnung |
| `beglichen_betrag` | Betrag |
| `externe_referenz` | Belegnummer der Ladenkasse, Terminal-Referenz, Portal-Zahlungs-ID |
| `erfasst_von` | Benutzer |

Das ist ein **Statusvermerk über einen Vorgang, der anderswo stattgefunden hat**, nicht die Aufzeichnung des Vorgangs selbst. Das Feld `externe_referenz` ist dabei der wichtigste: Es macht sichtbar, dass die maßgebliche Aufzeichnung woanders liegt, und erlaubt dem Steuerberater den Abgleich.

### Kassenbuch: nein

Ausdrücklich nicht enthalten, und das ist die Abgrenzung, die uns rechtlich sauber hält:

- Kein Kassenbestand, kein Anfangs- und Endbestand
- Keine Schichten, keine Zählprotokolle
- Keine Einlagen, Entnahmen, Überträge, Bankeinzahlungen
- Keine Kassendifferenz
- Kein Kassenabschluss, kein Z-Bon
- Keine Kassensturzfähigkeit, und das ist kein Mangel, sondern Absicht

---

## 3. Die vier Merkmale, die uns außerhalb der Kassenfunktion halten

Die gesetzliche Definition: Kassenfunktion liegt vor, wenn ein System dem Verkauf von Waren oder Dienstleistungen **und deren Abrechnung** dient und dabei zumindest teilweise **bare Zahlungsvorgänge erfasst und abwickelt**.

Vier Merkmale halten uns klar davon getrennt. Sie gehören als bewusste Nicht-Funktionen ins Produkt, nicht als vergessene Lücken:

1. **Wir führen keinen Kassenbestand.** Das System kann die Frage „wie viel Geld liegt in der Lade" nicht beantworten und soll es nicht können. Das ist das deutlichste Unterscheidungsmerkmal zwischen Fakturierung und Kassenführung.
2. **Wir wickeln keine Zahlung ab.** Kein Kassenladen-Auslöser, kein Rückgeld, keine Stornierung eines Kassiervorgangs, keine Gutscheineinlösung an der Kasse.
3. **Wir geben keinen Kassenbon aus.** Wir geben eine Hotelrechnung aus. Das ist ein Leistungsnachweis, kein Zahlungsbeleg eines Aufzeichnungssystems.
4. **Die maßgebliche Zahlungsaufzeichnung liegt nachweislich woanders**, dokumentiert über die externe Referenz und die Verfahrensdokumentation.

**Zur Belegausgabepflicht:** Sie gilt nur für elektronische Aufzeichnungssysteme. Ein Betrieb mit offener Ladenkasse hat keine. Ein Betrieb mit elektronischer Kasse erfüllt sie an dieser Kasse. In beiden Fällen ist unsere Hotelrechnung davon unberührt.

---

## 4. Sonderfall Kartenzahlung und unser Payment-Gateway

Hier ist eine Unterscheidung wichtig, damit die Payment-Pläne aus Entscheidung 6 nicht versehentlich gekippt werden.

| Zahlungsweg | Kassenfunktion? |
|---|---|
| Karte am Terminal an der Rezeption | **Vor Ort.** Gehört zur Kassenfunktion des kassierenden Systems, also des Terminals oder der Ladenkasse. Bei uns nur als Vermerk |
| Pay-by-Link, Anzahlung online, Kartenzahlung bei der Buchung | **Nicht vor Ort.** Fernzahlung über einen Zahlungsdienstleister, keine Kassenfunktion |
| Zahlung beim Buchungsportal, Virtual Credit Card, OTA-Inkasso | **Nicht vor Ort.** Findet vollständig außerhalb statt |
| Überweisung, Firmenrechnung | Unbar, nie Kassenfunktion |

**Unsere Anbindung an Stripe, Mollie und Adyen bleibt also unverändert möglich.** Ein Zahlungsdienstleister ist kein Kassensystem, und eine Fernzahlung ist kein Vorgang vor Ort. Das ist genau die Bauweise, die Mews und Apaleo nutzen.

---

## 5. Was wir stattdessen brauchen: die Kassenschnittstelle

Wenn wir die Kasse nicht bauen, müssen wir uns mit ihr vertragen. Zwei Richtungen:

| Richtung | Zweck |
|---|---|
| **Kasse zum PMS** | Die Ladenkasse oder Restaurantkasse bucht Umsätze auf ein Zimmer oder Folio. Der klassische Zimmerbon |
| **PMS zur Kasse** | Das PMS liefert offene Folios, Zimmernummer und Gastname, damit die Kasse zuordnen kann. Und meldet zurück, wenn beglichen wurde |

Das ist ohnehin die Bauweise von Mews und Apaleo und passt zum API-first-Ansatz aus [04-api-first-und-performance.md](04-api-first-und-performance.md).

**Und der Zeitpunkt ist günstig.** Wenn die geplante Registrierkassenpflicht kommt, muss nach heutigem Stand jeder Betrieb über 100.000 Euro Umsatz bis zum 1. Januar 2028 eine elektronische Kasse mit TSE haben. Das heißt: **In zwei Jahren hat praktisch jedes Hotel eine TSE-Kasse.** Eine gute Kassenschnittstelle ist dann mehr wert als eine eigene Kasse, weil der Betrieb die Kasse ohnehin hat und sie nicht doppelt kaufen will.

Die Registrierkassenpflicht ist damit kein Problem für uns, sondern ein Argument für unsere Bauweise. Details zum Gesetzgebungsstand in Abschnitt 7.

---

## 6. Was diese Entscheidung spart und was sie kostet

### Gespart

| Posten | Einsparung |
|---|---|
| Kassenbuch-Fachlichkeit | Kassen, Schichten, Bewegungen, Zählprotokoll, Differenzen, Abschluss |
| TSE-Anbindung | Fiskal-Middleware, Adapter, Belegdarstellung mit QR-Code |
| DSFinV-K-Export | 22 Dateien, drei Module, Versionspflege von 2.5 auf 3.0 |
| Laufende Fiskal-Compliance | Gesetzesänderungen, BMF-Schreiben, Auslegungen |
| Kosten je Kunde | 15 bis 40 Euro monatlich je Kasse, die wir weiterberechnen müssten |
| Support | Kassendifferenzen sind der supportintensivste Bereich eines PMS überhaupt |

**Der letzte Punkt ist der größte.** Kassendifferenzen erzeugen Anrufe, in denen es um Geld und Schuldzuweisung geht. Wer die Kasse nicht führt, führt diese Gespräche nicht.

Zusätzlich entfällt ein Preisproblem: Die Fiskalisierungskosten hätten bei einer Pension mit acht Zimmern die halbe Monatsgebühr ausgemacht. Diese offene Frage aus [02-planungsgrundlage.md](02-planungsgrundlage.md) erledigt sich.

### Bewusst aufgegeben

Ehrlichkeitshalber, damit die Entscheidung mit offenen Augen getroffen ist:

- **Kein Alles-aus-einer-Hand.** Ein Betrieb, der genau das sucht, ist bei SoftTec besser aufgehoben. Das ist in Ordnung, denn er ist nicht unser Zielkunde.
- **Der DATEV-Export enthält Umsätze und Forderungen, keine Kassenbewegungen.** Der Steuerberater führt Kasse und PMS zusammen. Das ist der Normalfall, muss aber im Vertrieb klar gesagt werden, damit keine falsche Erwartung entsteht.
- **Kein Umsatzbericht, der Kassenbestände zeigt.** Unsere Berichte zeigen Umsatz, Belegung, ADR und RevPAR, nicht den Kassenstand.
- **Die Entscheidung ist rückholbar, aber nicht billig.** Sollte die Nachfrage später eindeutig sein, ist ein Kassenmodul nachrüstbar. Der Aufwand bleibt derselbe wie heute, nur ohne Zeitdruck.

---

## 7. Gesetzgebungsstand zur Registrierkassenpflicht

Zur Einordnung, weil es die Kassenschnittstelle terminiert:

| | |
|---|---|
| Grundlage | Koalitionsvertrag CDU/CSU und SPD |
| Referentenentwurf des BMF | Juni 2026 |
| Aktueller Gesetzentwurf | 7. August 2026 |
| Maßgebliches Umsatzjahr | 2027 |
| Pflicht ab | 1. Januar 2028 |
| Schwelle | 100.000 Euro Gesamtumsatz, bar und unbar |
| Status | **Nicht verabschiedet.** Ausnahmen und Details offen, vom Steuerberaterverband als unklar kritisiert |

**Wichtig: Diese Pflicht trifft die Hotels, nicht uns.** Wir sind kein Kassensystem und werden es nicht. Für uns ist es ein Terminhinweis: Die Kassenschnittstelle sollte stehen, bevor die Betriebe umstellen, damit wir bei der Umstellung die zweite Wahl sind, mit der die neue Kasse sprechen soll.

Der Stand sollte halbjährlich nachverfolgt werden.

---

## 8. Was noch zu klären ist

**Ein Steuerberater oder Wirtschaftsprüfer muss die Abgrenzung vor dem Produktivgang bestätigen.** Die Grenze zwischen Fakturierung mit Zahlungsvermerk und Kassenfunktion ist schmal, und wir wollen sie nicht selbst auslegen. Konkret zu bestätigen:

1. Dass ein strukturierter Zahlungsvermerk ohne Kassenbestand und ohne Belegausgabe keine Kassenfunktion begründet.
2. Wie die Verfahrensdokumentation formulieren muss, dass die maßgebliche Kassenaufzeichnung beim Betrieb liegt.
3. Ob der Zahlungsvermerk im DATEV-Export mitgehen soll oder besser nicht.

Das gehört ohnehin zur Verfahrensdokumentation, die wir als Vorlage mitliefern wollen. Der Aufwand ist also gering und der Nutzen hoch, weil wir die Abgrenzung dann schriftlich haben und im Vertrieb zeigen können.

---

## 9. Die regulatorischen Hürden, realistisch betrachtet

Die Frage war, ob ein eigenes Kassenbuch an Lizenzen, Zertifizierungen oder der DATEV-Anbindung scheitert. **Tut es nicht.** Die vermuteten Hürden existieren größtenteils nicht.

| Vermutete Hürde | Realität |
|---|---|
| Zulassung oder Lizenz für Kassensoftware | **Existiert in Deutschland nicht.** Es gibt keine staatliche Genehmigung für Kassensoftware. Anders als etwa in Italien oder Frankreich |
| GoBD-Zertifizierung | **Gibt es amtlich nicht.** Die Finanzverwaltung erteilt keine Positivtestate zur Ordnungsmäßigkeit. Was Anbieter „GoBD-zertifiziert" nennen, ist ein privates Testat eines Wirtschaftsprüfers. Nützlich als Vertriebsargument, kein Rechtsakt |
| BSI-Zertifizierung | Betrifft **nur die TSE**, und die kaufen wir ein. Die Kassensoftware selbst wird nicht zertifiziert |
| DATEV-Anbindung | **Kommt darauf an, welche.** Es gibt drei Stufen mit sehr unterschiedlichen Kosten, siehe unten. Die für uns nötige ist kostenfrei |

### Die drei Stufen der DATEV-Anbindung

Dieser Punkt war in einer früheren Fassung falsch dargestellt. Er ist wichtig, weil die Stufen um Größenordnungen auseinanderliegen.

| Stufe | Was es ist | Kosten für uns |
|---|---|---|
| **1. DATEV-Format-Datei** | Wir erzeugen eine Datei im DATEV-Format für Buchungsstapel. Der Betrieb oder sein Steuerberater importiert sie. Das Format ist im DATEV Developer Portal nach kostenfreier Registrierung dokumentiert, samt Prüfprogramm | **Keine.** Kein Onboarding, keine Partnerschaft, keine Gebühr |
| **2. DATEV-Datenservice** | Ein API, das Daten direkt in die DATEV-Cloud schiebt, etwa der **Datenservice Kassenarchiv** nach DATEV Kassenarchiv online und weiter nach Kassenbuch online. Die Umsetzung läuft über ein von DATEV-Beratern begleitetes Onboarding | **Kostenpflichtig.** Erstes Onboarding **1.500 Euro zzgl. USt.** inklusive vier Beratungsstunden, jede weitere angefangene Stunde **210 Euro zzgl. USt.** Dazu ein DATEV-Testsystem, das eigene Kosten verursachen kann. Laufende Kosten je API-Aufruf nach gewähltem API-Plan, die typischerweise beim DATEV-Endkunden anfallen, also beim Steuerberater oder Mandanten |
| **3. DATEV-Marktplatz-Partner** | Eigene Marktplatzseite, Partnermanager, das Siegel „von DATEV technisch geprüft" | **Zusätzlich.** Setzt einen umgesetzten Datenservice mit **mindestens 25 aktiven Kunden** und drei Referenzkunden voraus. Partner zahlen monatliche Grundgebühr plus Klickpreis, deren Höhe nicht öffentlich ist |

#### Was die laufenden API-Kosten konkret sind

**DATEV veröffentlicht keinen Preis „je API-Aufruf".** Die Kosten werden im Developer Portal erst bei der Auswahl eines API-Plans angezeigt. Abgerechnet wird nicht je Aufruf, sondern **mengengestaffelt je Monat**, und laut DATEV fallen sie **typischerweise beim Endkunden an**, also beim Steuerberater oder Mandanten, nicht beim Softwarehersteller.

Öffentlich sind die Endkundenpreise der betroffenen Produkte:

| Produkt | Preis | Anmerkung |
|---|---|---|
| DATEV Kassenarchiv online | 5,00 bis 7,50 Euro je Monat und Kasse | Quellen streuen: der Ratgeber von 2022 nennt 5,00 Euro, der von 10/2024 nennt 7,50 Euro. Je physischer Kasse ein Kassenordner |
| DATEV Kassenbuch online | 2,50 Euro je Monat und Kasse | Auch als Bestandteil von Unternehmen online |
| DATEV Unternehmen online | 11,56 Euro netto je Monat und Mandant | Enthält unter anderem Kassenbuch online |
| DATEV Rechnungsdatenservice 1.0 | ab 2,00 Euro je Monat inklusive 200 Belegen, 4,00 Euro bis 400 Belege | Beispiel für die Staffelung nach Menge |

Alle Preise netto. Die verbindliche Quelle ist die DATEV-Preisliste, die halbjährlich aktualisiert wird; die oben genannten Werte stammen aus Ratgebern und Produktseiten und streuen entsprechend.

**Für unsere Kalkulation heißt das:** Die laufenden Kosten einer DATEV-Datenservice-Anbindung trägt der Kunde, nicht wir. Unsere Kosten sind das einmalige Onboarding und die Entwicklungszeit. Das relativiert Stufe 2 etwas, ändert aber nichts daran, dass wir sie für den beschlossenen Umfang nicht brauchen.

**Zur genannten Zahl von 5.000 Euro:** Die konnte ich in den öffentlichen Quellen nicht als Festpreis bestätigen. Der dokumentierte Einstieg liegt bei 1.500 Euro. Realistisch ist die Größenordnung trotzdem: 1.500 Euro plus rund 17 Beratungsstunden ergeben bereits 5.000 Euro, und ein Onboarding mit Testsystem, Abstimmung und Fehlerbehebung kommt schnell dorthin. **Wer von 5.000 Euro als realistischen Gesamtkosten ausgeht, liegt vermutlich richtig.** Die verbindliche Auskunft gibt nur DATEV selbst.

### Was das für uns bedeutet

**Für den beschlossenen Umfang genügt Stufe 1, und die ist kostenfrei.** Entscheidung 7 in [02-planungsgrundlage.md](02-planungsgrundlage.md) lautet „DATEV-Export genügt". Wir erzeugen eine Datei, der Steuerberater importiert sie. Genau so arbeiten die meisten PMS.

Stufe 2 wäre erst dann interessant, wenn wir Daten aktiv in die DATEV-Cloud schieben wollen. Bemerkenswert dabei: **Der Datenservice Kassenarchiv ist genau der Kassenweg**, den wir nach Entscheidung 9 nicht gehen. Er ist für uns also doppelt irrelevant, solange wir keine Kassenfunktion haben.

Stufe 3 ist ein Vertriebskanal und scheidet ohnehin aus, solange wir keine 25 Kunden mit umgesetztem Datenservice haben.

**Für die Bewertung eines späteren Kassenbuchs ändert das die Rechnung aber spürbar:** Ein Kassenbuch, das seinen Nutzen ausspielt, will die Daten nach DATEV Kassenarchiv online schieben. Dann kommen zu TSE, DSFinV-K und Supportlast noch ein vierstelliges Onboarding und laufende API-Kosten. Das stärkt die Entscheidung aus Abschnitt 1 zusätzlich.

### Die echten Hürden

Sie sind nicht regulatorisch, sondern betrieblich und kommerziell:

1. **DSFinV-K korrekt erzeugen.** 22 Dateien in drei Modulen, mit exakten Feldnamen und Wertebereichen, und die Spezifikation wandert von 2.5 auf 3.0. Das ist echte, wiederkehrende Arbeit.
2. **Laufende Compliance-Pflege.** BMF-Schreiben, geänderte Auslegungen, neue Meldepflichten. Wer die Kasse führt, pflegt dauerhaft Steuerrecht statt Produkt.
3. **Supportlast.** Kassendifferenzen sind der supportintensivste Bereich eines PMS, weil es um Geld und Schuldzuweisung geht.
4. **Haftungs- und Vertrauensrisiko, und das ist der gewichtigste Punkt.** Kassenführungsmängel berechtigen das Finanzamt zu **Hinzuschätzungen**, und die können für ein Hotel existenzbedrohend werden. Strafrechtlich haftet ein Anbieter nur bei Vorsatz, etwa beim Vertrieb von Manipulationssoftware. Aber wenn ein Kunde wegen eines Fehlers in unserer Kasse eine Hinzuschätzung kassiert, ist das ein Konflikt, den keine Haftungsbeschränkung im Vertrag heilt.

**Fazit: Der Grund, das Kassenbuch nicht zu bauen, ist nicht Regulatorik. Es ist Aufwand, Supportlast und Haftungsexposition.** Die Entscheidung aus Abschnitt 1 bleibt richtig, aber sie ist eine Abwägung, keine Unmöglichkeit. Das ist ein Unterschied, weil es bedeutet: Wir können sie jederzeit umkehren, wenn der Markt es verlangt.

---

## 10. Wie wir die Tür offenhalten, ohne etwas zu bauen

**Ja, das Backend sollte so gebaut sein, dass ein Kassenbuch später additiv möglich ist. Und die gute Nachricht: Das kostet praktisch nichts extra**, weil fast alles davon ohnehin aus der GoBD-Festigkeit folgt.

### Was ohnehin entschieden ist und bereits passt

| Entscheidung | Quelle |
|---|---|
| Geldbeträge als ganze Zahlen in Cent | [07-technologie-und-hosting.md](07-technologie-und-hosting.md) |
| Finanztabellen append-only, Korrektur nur als Gegenbuchung | [08-compliance-in-der-praxis.md](08-compliance-in-der-praxis.md) |
| Audit-Log per Datenbank-Trigger | dito |
| Fortlaufende Nummern aus einer Sequenz beim Festschreiben | dito |
| `property_id` in jeder Tabelle | [02-planungsgrundlage.md](02-planungsgrundlage.md) |
| Geschäftsdatum getrennt vom Zeitstempel | dito |

Ein Kassenabschluss braucht genau diese sechs Dinge. Sie sind alle schon da.

### Die eine Entscheidung, die man bewusst treffen muss

**Der Zahlungsvermerk muss eine eigene Tabelle mit Zahlartenkatalog sein, kein Statusfeld am Folio.**

Das ist der Angelpunkt. Ist „bezahlt" ein Boolean am Folio, wird ein späteres Kassenbuch zur Datenmigration mit Rekonstruktion von Historie. Ist es eine Zeilentabelle, ist es rein additiv.

```sql
-- Zahlarten als Stammdaten, nicht als Enum im Code
CREATE TABLE payment_method (
  id           bigserial PRIMARY KEY,
  property_id  bigint NOT NULL,
  name         text   NOT NULL,     -- Bar, Karte vor Ort, Ueberweisung, Portal
  aktiv        boolean NOT NULL DEFAULT true
  -- spaeter additiv: ist_bar, beruehrt_kassenbestand, tse_pflichtig
);

-- Der Zahlungsvermerk. Haertegrad 1, hart unveraenderlich.
CREATE TABLE settlement (
  id                bigserial PRIMARY KEY,
  property_id       bigint  NOT NULL,
  folio_id          bigint  NOT NULL,
  geschaeftsdatum   date    NOT NULL,
  betrag_cent       bigint  NOT NULL,
  payment_method_id bigint  NOT NULL,
  externe_referenz  text,             -- Beleg der Ladenkasse, Portal-ID, Terminal
  erfasst_von       bigint  NOT NULL,
  erfasst_am        timestamptz NOT NULL DEFAULT now(),
  storniert_von_id  bigint            -- Verweis auf die Gegenbuchung
);
```

Diese Form braucht man ohnehin, unabhängig vom Kassenbuch:

- Ein Folio kann in Teilen beglichen werden, etwa Anzahlung plus Restzahlung.
- Die Offene-Posten-Sicht ist die Differenz aus Charges und Settlements.
- Der Storno funktioniert wie überall sonst im Finanzteil.

Ein späteres Kassenbuch wäre dann: drei neue Tabellen für Kasse, Schicht und Bargeldbewegung, drei zusätzliche Spalten an `payment_method`, ein Hook im Erfassungsdienst. **Kein bestehender Datensatz muss angefasst werden.**

### Der zweite Punkt: eine einzige Stelle im Code

Jede Erfassung eines Zahlungsvermerks läuft durch **eine** Dienstfunktion. Nicht durch drei Stellen in Check-out, Rechnungserstellung und Import. Dann gibt es später genau einen Ort, an dem ein Fiskal-Hook ansetzt.

Das ist keine Vorbereitung auf das Kassenbuch, sondern schlicht sauberer Aufbau. Es zahlt nur zufällig darauf ein.

### Was wir ausdrücklich nicht tun

Vorbereitung heißt, die allgemeinen Entscheidungen richtig zu treffen, **nicht ungenutztes Gerüst zu bauen**:

- Keine leeren Tabellen `cash_register`, `cash_shift`, `cash_movement` auf Vorrat.
- Keine `FiskalAdapter`-Schnittstelle ohne Implementierung. Eine Abstraktion mit genau null Implementierungen ist keine Abstraktion, sondern eine Vermutung.
- Keine `tse_`-Spalten „für später" an bestehenden Tabellen.
- Keine Konfigurationsschalter für ein Modul, das es nicht gibt.

Ungenutztes Gerüst kostet bei jeder Migration, jedem Review und jedem neuen Entwickler Aufmerksamkeit, und es ist am Ende doch falsch geschnitten, weil man beim Bauen immer klüger ist als beim Vorbereiten.

### Und zur Beruhigung

Die Form der `settlement`-Tabelle macht uns **nicht** zu einem Kassensystem. Maßgeblich ist die Funktion, nicht das Schema: kein Kassenbestand, keine Abwicklung, kein Bon. Die vier Abgrenzungsmerkmale aus Abschnitt 3 bleiben unberührt.

---

## 11. Das übergreifende Muster

Diese Entscheidung ist ein Beispiel für einen Grundsatz, der für weitere Module gilt:

> **Was der Betrieb schon führt, bauen wir nicht. Wir schließen an.**

Das betrifft mindestens:

| Bereich | Unser Ansatz |
|---|---|
| Kassenbuch und Kasse | Schnittstelle statt eigener Kasse |
| Buchungsmaschine | Eigene anbieten, fremde anbindbar |
| Channel Manager | Nur ARI-Schnittstelle, kein eigener |
| Restaurantkasse | Schnittstelle |
| Schließsystem | Schnittstelle |
| Buchhaltung | DATEV-Export, keine eigene Fibu |

Das hält das Produkt schlank, senkt die Umstiegshürde und ist der eigentliche Grund, warum das offene API keine Kür ist: **Jedes Modul, das wir nicht bauen, muss anbindbar sein.**

---

## Quellen

- [BMF: Anwendungserlass zur Abgabenordnung, zu § 146a](https://ao.bundesfinanzministerium.de/ao/2023/Abgabenordnung/Vierter-Teil/Zweiter-Abschnitt/Erster-Unterabschnitt/Paragraf-146a/ae-146a.html)
- [Haufe / BMF-FAQ: Warenwirtschaftssysteme mit optional zuschaltbarem Kassenmodul](https://www.haufe.de/id/beitrag/das-kassengesetz-fuer-mehr-steuergerechtigkeit-belegausg-3-wie-sind-warenwirtschaftssysteme-zu-beurteilen-die-ueber-ein-optional-zuschaltbares-kassenmodul-verfuegen-HI16191551.html)
- [BMF: FAQ Kassengesetz und Belegausgabepflicht](https://www.bundesfinanzministerium.de/Content/DE/FAQ/FAQ-steuergerechtigkeit-belegpflicht.html)
- [tax & bytes: Quo vadis elektronisches Kassenbuch, Einordnung nach § 146a AO](https://www.taxandbytes.de/360/quo-vadis-elektronisches-kassenbuch)
- [Steuerberater te Heesen: Elektronische Kassenbücher und § 146a AO, Meldepflicht](https://stb-teheesen.de/elektronische-kassenbuecher-%C2%A7-146a-ao-muessen-sie-gemeldet-werden/)
- [sevdesk: Offene Ladenkasse, Voraussetzungen und Anforderungen](https://sevdesk.de/ratgeber/buchhaltung-finanzen/kassenfuehrung/offene-ladenkasse/)
- [kassensystemevergleich: Registrierkassenpflicht, Umsatzjahr 2027, Pflicht ab 2028](https://www.kassensystemevergleich.de/registrierkassenpflicht-deutschland/)
- [Haufe: Gesetz zur Einführung einer Kassenpflicht](https://www.haufe.de/steuern/gesetzgebung-politik/gesetz-zur-einfuehrung-einer-kassenpflicht_168_691756.html)
- [IWW: Elektronische Aufzeichnungsgeräte und § 146a AO in der Praxis](https://www.iww.de/bbp/unternehmensberatung/kassenfuehrung-elektronische-aufzeichnungsgeraete-und-der-146a-ao-in-der-praxis-f132011)
- [kassensystem-der-zukunft: GoBD-Zertifizierung, gibt es ein GoBD-Zertifikat?](https://kassensystem-der-zukunft.com/gobd-zertifizierung-gibt-es-eigentlich-ein-gobd-zertifikat/)
- [Bayerisches Landesamt für Steuern: Elektronische Kassensysteme](https://www.lfst.bayern.de/steuerinfos/weitere-themen/elektronische-kassensysteme)
- [DATEV: FAQ für Software-Hersteller zum Marktplatz](https://www.datev.de/web/de/ueber-datev/das-digitale-oekosystem-von-datev/partnering/datev-marktplatz/faq-fuer-interessierte-software-hersteller/)
- [DATEV: Erste Schritte zum Partnerstatus](https://www.datev.de/web/de/berufsgruppenuebergreifend/ueber-datev/portfolio/oekosystem/partnering/datev-marktplatz/erste-schritte-zum-partnerstatus)
- [auditplan: DATEV Buchungsstapel EXTF, Format und Export](https://auditplan.io/datev-buchungsstapel-extf)
- [DATEV Developer Portal: Hilfe und Kontakt, Onboarding-Kosten](https://developer.datev.de/de/help)
- [DATEV: Infos für Kassen- und TSE-Hersteller](https://www.datev.de/web/de/berufsgruppenuebergreifend/ueber-datev/portfolio/oekosystem/partnering/datev-marktplatz/infos-fuer-kassen-und-tse-hersteller)
- [DATEV: Datenservice Kassenarchiv einrichten](https://www.datev.de/web/de/berufsgruppenuebergreifend/mydatev/datenservices/datenservice-kassenarchiv-einrichten)
- [DATEV: Kassenarchiv online, Produktseite](https://www.datev.de/web/de/shop/produkt-details/datev-kassenarchiv-online-97337)
- [DATEV: Ratgeber Kassenarchiv online, Stand 10/2024 (PDF)](https://www.datev.de/content/dam/markenassets/themen-und-produktgruppen/service/pdf/Ratgeber_Kassenarchiv_online.pdf)
- [DATEV: Preisliste Kassenarchiv online (PDF)](https://www.datev.de/content/dam/markenassets/preislisten/datev-preisliste_datev_kassenarchiv_online.pdf)
- [DATEV: Preisliste für Unternehmen (PDF)](https://www.datev.de/content/dam/markenassets/preislisten/DATEV-Preisliste_fuer_Unternehmen.pdf)
- [DATEV: Rechnungsdatenservice 1.0, Produktseite](https://www.datev.de/web/de/shop/produkt-details/datev-rechnungsdatenservice-1)
- [LHP: Zuschätzung in der Betriebsprüfung und Haftung bei Manipulation durch Kassensoftware](https://www.lhp-gruppe.de/themen/zuschaetzung-in-betriebspruefung-und-haftung-bei-manipulation-durch-kassen-software/)
- [Gastgewerbe-Magazin: Hinzuschätzung bei gravierenden Kassenführungsmängeln zulässig](https://gastgewerbe-magazin.de/urteil-hinzuschaetzung-bei-gravierenden-kassenfuehrungsmaengeln-zulaessig-27411)
