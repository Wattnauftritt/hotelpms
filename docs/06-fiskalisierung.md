# Fiskalisierung: was das ist und was SoftTec da eigentlich zukauft

> **Statushinweis:** Nach Entscheidung 9 in [02-planungsgrundlage.md](02-planungsgrundlage.md) bekommt unser PMS **keine Kassenfunktion**. Damit brauchen wir weder TSE noch Fiskal-Middleware noch DSFinV-K. Die Begründung steht in [09-kassenbuch.md](09-kassenbuch.md).
>
> Dieses Dokument bleibt als Hintergrundwissen erhalten. Es erklärt, wie der Wettbewerb Fiskalisierung löst, was unsere Kunden bei ihrer eigenen Kasse erwartet, und was zu tun wäre, falls wir die Entscheidung später umkehren.

Antwort auf die Frage, was hinter „SoftTec kauft Fiskalisierung ein" steckt. Kurz vorweg: **es ist nicht ein Chip, es ist eine komplette Compliance-Schicht als Dienst.**

---

## 1. Was Fiskalisierung bedeutet

**Fiskalisierung ist die gesetzliche Pflicht, elektronisch erfasste Geschäftsvorfälle so aufzuzeichnen, dass sie nachträglich nicht unbemerkt verändert werden können, und sie dem Finanzamt in einem definierten Format vorlegen zu können.**

Der Gesetzgeber geht davon aus, dass eine Software, die Umsätze erfasst, auch Umsätze verschwinden lassen kann. Vor 2020 war das ein Massenphänomen: Kassensysteme wurden mit „Zapper"-Funktionen verkauft, die Barumsätze nachträglich löschten. Fiskalisierung ist die technische Antwort darauf.

Es geht dabei ausschließlich um **Manipulationssicherheit und Prüfbarkeit**, nicht um Buchhaltung. Fiskalisierung sagt nicht, wie man bucht. Sie sagt, dass man nicht heimlich umbuchen kann.

### Die Rechtsgrundlagen

| Norm | Inhalt |
|---|---|
| § 146a AO | Kernpflicht: elektronische Aufzeichnungssysteme müssen durch eine zertifizierte technische Sicherheitseinrichtung geschützt sein. Eingeführt durch das Gesetz zum Schutz vor Manipulationen an digitalen Grundaufzeichnungen vom 22.12.2016 |
| KassenSichV | Führt § 146a AO aus, in Kraft seit 1. Januar 2020 |
| § 146b AO | Kassennachschau: unangekündigte Prüfung durch das Finanzamt |
| BSI-Richtlinien | Das Bundesamt für Sicherheit in der Informationstechnik legt die technischen Anforderungen fest und zertifiziert |
| GoBD | Der allgemeine Rahmen für ordnungsmäßige Buchführung, siehe [01-marktanalyse-pms.md](01-marktanalyse-pms.md) |

### Betrifft uns das überhaupt?

Ja. **Sobald in unserem PMS Barzahlungen erfasst werden können, fällt der entsprechende Teil der Software unter die KassenSichV.** Jede Hotelrezeption hat eine Kasse. Es gibt praktisch kein Haus, in dem nie bar bezahlt wird, sei es die Minibar, die Kurtaxe oder ein Trinkgeld.

Das ist keine Frage, die wir uns aussuchen können, und auch keine, die man auf später schieben kann: ein PMS ohne Fiskalisierung ist in Deutschland nicht verkaufbar.

---

## 2. Die TSE und was sie technisch tut

Die **Technische Sicherheitseinrichtung (TSE)** ist das Herzstück. Sie besteht aus **drei** Komponenten, und das ist wichtig, weil man sonst nur an das Signieren denkt:

| Komponente | Aufgabe |
|---|---|
| **Sicherheitsmodul** | Erzeugt die Signaturen. Sorgt dafür, dass jede Buchung schon **zu Beginn** des Vorgangs protokolliert wird und danach nicht mehr unbemerkt geändert oder gelöscht werden kann |
| **Speichermedium** | Speichert die Einzelaufzeichnungen für die gesetzliche Aufbewahrungsfrist |
| **Digitale Schnittstelle** | Zwei Teile: die Einbindungsschnittstelle, über die die Kassensoftware spricht, und die Exportschnittstelle für die Prüfung, also DSFinV-K |

### Was beim Signieren passiert

Jeder aufzeichnungspflichtige Vorgang wird der TSE gemeldet, und zwar **beim Start**, nicht erst beim Abschluss. Das ist der entscheidende Punkt: Wenn ein Kassiervorgang begonnen und dann abgebrochen wird, ist der Abbruch protokolliert. Man kann einen Vorgang nicht mehr „nicht stattfinden lassen".

Die TSE liefert zurück:

- eine **fortlaufende Transaktionsnummer**, lückenlos über das ganze System
- **Start- und Endzeitpunkt** des Vorgangs
- einen **Signaturzähler**
- den **Prüfwert**, also die eigentliche Signatur
- die **Seriennummer der TSE**

Der Trick liegt in der **Verkettung**: Jede Signatur bezieht die vorhergehende mit ein. Wer eine Buchung aus der Mitte entfernt, zerstört die Kette, und das fällt bei der Prüfung sofort auf. Die Lückenlosigkeit der Transaktionsnummern tut ihr Übriges.

### Belegausgabepflicht

Jeder Vorgang muss zu einem Beleg führen, auf dem die TSE-Daten stehen. In der Praxis als **QR-Code**, damit ein Prüfer den Beleg vor Ort gegen die TSE verifizieren kann. Der Gast muss den Beleg nicht mitnehmen, aber er muss ihm angeboten werden.

### Hardware oder Cloud

| Form | Beschreibung | Kosten |
|---|---|---|
| **Hardware-TSE** | USB-Stick, SD- oder microSD-Karte, gesteckt am Kassensystem. Anbieter: Swissbit, Diebold Nixdorf, Cryptovision, Epson | 179 bis 249 Euro einmalig, Laufzeit 5 Jahre ab Zertifizierungsdatum |
| **Cloud-TSE** | Die Signatur wird über einen Webdienst geholt. Anbieter: fiskaly, Deutsche Fiskal, efsta, Swissbit Cloud | 8 bis 20 Euro pro Monat und Kasse |

**Für uns kommt nur Cloud-TSE infrage.** Wir sind SaaS. Wir können keine USB-Sticks an hunderte Hotels verschicken, dort einstecken lassen und nach fünf Jahren austauschen. Über fünf Jahre gerechnet ist Hardware zwar 200 bis 700 Euro günstiger, aber der Logistik- und Supportaufwand frisst das um ein Vielfaches auf.

**Wichtig für die Kalkulation: eine TSE je Aufzeichnungssystem.** Nicht je Kunde, sondern je Kasse. Ein Hotel mit Rezeptionskasse und Barkasse braucht zwei. Genau deshalb berechnet SoftTec 7,50 Euro **je TSE** und nicht je Betrieb.

---

## 3. DSFinV-K: das Exportformat

**DSFinV-K** steht für „Digitale Schnittstelle der Finanzverwaltung für Kassensysteme". Das ist das genormte Format, in dem bei einer Prüfung alles herausgegeben werden muss. Aktuell gilt **Version 2.5**, ein Diskussionsentwurf für 3.0 liegt vor.

Ein Export besteht aus rund 22 CSV-Dateien plus einer `index.xml` und einer Schemadatei, gegliedert in drei Module:

| Modul | Inhalt |
|---|---|
| **Einzelaufzeichnungsmodul** | Jeder einzelne Geschäftsvorfall: Bonkopf und Bonpositionen, Zahlarten, Stornos, Rabatte, Trainingsbuchungen, jeweils mit der Verknüpfung zur TSE-Transaktion |
| **Stammdatenmodul** | Der Rahmen: Standorte, Kassen mit Seriennummern, eingesetzte TSE, Bediener, Steuersätze, Artikel- und Warengruppenzuordnung |
| **Kassenabschlussmodul** | Die Tagesabschlüsse mit Summen je Zahlart und Steuersatz, die Brücke zur Finanzbuchhaltung |

Das ist deutlich mehr Arbeit, als es klingt. Man muss nicht nur die Daten haben, man muss sie in exakt dieser Struktur, mit exakt diesen Feldnamen und Wertebereichen erzeugen können. Und die Spezifikation ändert sich.

---

## 4. Meldepflicht und Verfahrensdokumentation

Zwei Pflichten, die keine Software erledigt, bei denen wir dem Kunden aber zuarbeiten müssen:

- **Meldung an das Finanzamt über ELSTER.** Jedes Aufzeichnungssystem muss innerhalb eines Monats nach Anschaffung oder Außerbetriebnahme gemeldet werden, mit Seriennummern und Zertifizierungsdaten. Das ist Pflicht des Hoteliers, aber **die Daten müssen aus unserem System kommen**, sonst kann er sie nicht melden.
- **Verfahrensdokumentation.** Eine schriftliche Beschreibung, wie Belege vom Buchungsportal über das PMS bis zur Steuerberatung fließen. Auch Pflicht des Hoteliers, aber gute Anbieter liefern eine Vorlage. Das ist ein billiges, wirksames Vertriebsargument.

---

## 5. Was SoftTec konkret zukauft: efsta EFR

Jetzt zur eigentlichen Frage.

SoftTec kauft **nicht** eine TSE. SoftTec kauft eine **Fiskal-Middleware** namens **EFR (Elektronisches Fiskalregister)** von der **efsta IT Services GmbH**, einem österreichischen Unternehmen. Und über diese Middleware dann auch den Zugang zur TSE.

### Was die Middleware macht

- Sie nimmt Transaktionsdaten über **eine einheitliche REST-Schnittstelle** entgegen, als XML oder JSON.
- Sie wendet die **länderspezifischen Fiskalregeln** an.
- Sie spricht mit der TSE. EFR unterstützt **alle relevanten TSE-Anbieter**: Swissbit, Deutsche Fiskal, fiskaly, Epson, Diebold Nixdorf, Cryptovision. Die Kassensoftware muss davon nichts wissen.
- Sie erzeugt den **DSFinV-K-Export**.
- Sie **archiviert** die Fiskaldaten revisionssicher in der efsta-Cloud.
- Sie läuft wahlweise lokal, zentral im Netzwerk oder webbasiert.

Zur Größenordnung: EFR wird von über 450 Kassenherstellern in 17 europäischen Ländern eingesetzt und verarbeitet täglich über 10 Millionen Transaktionen.

### Die Schichten, und wer welche liefert

```
┌──────────────────────────────────────────────┐
│  1. PMS / Kasse                              │  ← SoftTec baut selbst
│     Umsätze, Steuersätze, Belege             │
├──────────────────────────────────────────────┤
│  2. Fiskal-Middleware (efsta EFR)            │  ← zugekauft
│     eine REST-API, Länderlogik, DSFinV-K     │
├──────────────────────────────────────────────┤
│  3. Zertifizierte TSE                        │  ← zugekauft (über efsta)
│     Signatur, Verkettung, Speicherung        │
├──────────────────────────────────────────────┤
│  4. Revisionssichere Archivierung            │  ← zugekauft (efsta-Cloud)
└──────────────────────────────────────────────┘
```

SoftTec kauft also **Schicht 2 bis 4**. Was sie zahlen, wissen wir aus dem Bestellformular: 249 Euro Einrichtung, 29 Euro monatlich für die efsta-Lizenz, 7,50 Euro monatlich je Online-TSE. Was davon Einkauf und was Marge ist, ist nicht öffentlich.

### Warum man das nicht selbst baut

Drei Gründe, in absteigender Härte:

1. **Die TSE muss BSI-zertifiziert sein.** Das ist kein „wir halten uns an die Richtlinie", sondern ein formales Zertifizierungsverfahren nach Technischen Richtlinien und Schutzprofilen, mit Prüfstelle, Jahren an Dauer und Kosten im Millionenbereich. Eine eigene TSE zu bauen ist für uns schlicht ausgeschlossen. **Diese Schicht muss immer gekauft werden, von jedem.**
2. **Die Fiskalregeln ändern sich.** DSFinV-K geht von 2.5 auf 3.0, Meldepflichten kommen dazu, Auslegungen ändern sich durch BMF-Schreiben. Wer das selbst implementiert, pflegt dauerhaft Steuerrecht statt Produkt.
3. **Mehrere Länder.** Österreich hat die RKSV, Italien, Frankreich, Polen und andere haben je eigene Regime. Eine Middleware wie efsta deckt 17 Länder mit derselben Integration ab. Da unser Zielmarkt DACH ist und Österreich naheliegt, ist das direkt relevant.

---

## 6. Was wir trotz Zukauf selbst bauen müssen

Das wird gern unterschätzt. Die Middleware erledigt die Signatur, nicht die Fachlichkeit. Bei uns bleibt:

- **Entscheiden, was aufzeichnungspflichtig ist.** Welcher Vorgang im PMS ist ein Geschäftsvorfall, der an die TSE muss, und welcher nicht. Eine Reservierung ist keiner. Eine Zahlung schon. Eine Umbuchung zwischen Folios ist eine Auslegungsfrage.
- **Korrekte Steuersätze und deren Aufteilung.** 7 Prozent auf Logis, 19 Prozent auf Frühstück und Parken, Kurtaxe je nach Gemeinde teils ohne Umsatzsteuer. Das ist unsere Fachlogik, nicht die von efsta.
- **Den Beleg selbst**, inklusive QR-Code mit den TSE-Daten, in korrektem Layout.
- **Den Kassenabschluss auslösen.** Wann ein Tagesabschluss läuft und was er umfasst, hängt am Nachtlauf, siehe [02-planungsgrundlage.md](02-planungsgrundlage.md).
- **GoBD-Festigkeit in unserer eigenen Datenbank.** Unveränderliche Buchungen, Storno als Gegenbuchung, fortlaufende Rechnungsnummern je Betrieb, Audit-Log. **Die TSE schützt die Kassendaten, nicht unsere Datenbank.** Das ist der häufigste Denkfehler: Man hat eine TSE und glaubt, damit sei GoBD erledigt. Ist es nicht.
- **Die Daten für die ELSTER-Meldung bereitstellen**, also Seriennummern und Zertifizierungsdaten je Betrieb abrufbar machen.
- **Eine Vorlage für die Verfahrensdokumentation.**

---

## 7. Konsequenz für unsere Planung

**Wir machen es genauso wie SoftTec und kaufen die Schichten 2 bis 4 ein.** Das war bereits die Annahme in [02-planungsgrundlage.md](02-planungsgrundlage.md), sie ist jetzt belegt.

**Anbieterauswahl, noch zu entscheiden:**

| Anbieter | Profil |
|---|---|
| **efsta** | Middleware plus TSE plus Archivierung, 17 Länder, was SoftTec nutzt. Am umfassendsten, dadurch auch am stärksten bindend |
| **fiskaly** | Cloud-TSE mit sehr guter Entwicklerdokumentation und moderner REST-API, deutlich API-freundlicher. Deckt Deutschland und Österreich ab, weniger Breite als efsta |
| **Deutsche Fiskal** | Cloud-TSE, Gemeinschaftsunternehmen unter anderem der DATEV, dadurch nah an der Steuerberaterwelt |

**Meine Empfehlung: fiskaly**, weil deren API-Denke zu unserer API-first-Architektur passt und die Integration sauberer wird. efsta ist die konservativere Wahl, wenn wir früh nach Österreich wollen. Das sollten wir vor Stufe 2 der Roadmap entscheiden, nicht vorher, weil es die Architektur nicht beeinflusst, solange wir die Fiskalisierung hinter einer eigenen Schnittstelle kapseln.

**Und genau das ist die Architekturregel, die jetzt schon gilt:** Wir sprechen nie direkt mit einer TSE oder einer Middleware, sondern definieren eine eigene interne Schnittstelle `FiskalAdapter` mit den Operationen „Vorgang starten", „Vorgang abschließen", „Kassenabschluss", „Export erzeugen". Dahinter liegt austauschbar efsta, fiskaly oder ein anderer. Damit ist der Anbieterwechsel eine Adapterimplementierung und kein Umbau.

**Kalkulation:** Die Kosten sind je Kasse und Monat, nicht je Zimmer. Für ein kleines Haus mit einer Kasse sind das bei 8 bis 20 Euro Cloud-TSE plus anteiliger Middleware-Lizenz grob 15 bis 40 Euro monatlich. Bei einem Preis von 7 bis 12 Euro je Zimmer ist das bei einer Pension mit 8 Zimmern **mehr als die halbe Monatsgebühr**. Das muss als eigene Position weitergegeben werden, so wie SoftTec es macht, und darf nicht im Grundpreis untergehen.

---

## Quellen

- [Wikipedia: Kassensicherungsverordnung](https://de.wikipedia.org/wiki/Kassensicherungsverordnung)
- [BMF: Anwendungserlass zu § 146a AO (PDF)](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/AO-Anwendungserlass/2023-06-30-AEAO-Par-146-AO.pdf?__blob=publicationFile&v=2)
- [fiskaly: KassenSichV und TSE, Fiskalisierung in Deutschland](https://www.fiskaly.com/blog/kassensichv-and-tss-fiscalization-in-germany)
- [efsta: Deutschland, Fiskalisierung mit KassenSichV und TSE](https://www.efsta.eu/laenderloesungen/deutschland-kassensichv-tse)
- [efsta: Fiskalisieren Sie in Deutschland](https://www.efsta.eu/fiskalisierung/deutschland)
- [efsta EFR Guide, Version 2.2.3 (PDF)](https://www.lexware.de/fileadmin/updateseiten/efr_guide__de__2.2.3_de.pdf)
- [Martin Becker GmbH: Fiskal-Software von efsta](https://www.mb-gmbh.de/de/produkte/efsta-fiskal-software-efr)
- [hotline: TSE und Kassensicherungsverordnung, Preise](https://hotlinesoftware.de/bestellformulare/tse-kassensicherungsordnung/)
- [receipt4s: DSFinV-K einfach erklärt](https://receipt4s.de/en/dsfinv-k-einfach-erklaert/)
- [Handelsverband: Stellungnahme zum Diskussionsentwurf DSFinV-K 3.0 (PDF)](https://einzelhandel.de/images/Steuern/Stellungnahmen/2026-020_6er_Stellungnahme_zum_DiskE_DSFinV-K_3.0_Anlage.pdf)
- [Kassensystemevergleich: TSE-Kosten 2026, Cloud vs. Hardware](https://www.kassensystemevergleich.de/tse-kosten/)
- [Lodgit: KassenSichV und TSE, gesetzlicher Hintergrund](https://www.lodgit-hotelsoftware.de/kassensichv-tse.html)
- [softtec: TSE-Meldepflicht ab 2025](https://softtec.de/tse-meldepflicht/)
