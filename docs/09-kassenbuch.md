# Kassenfunktion und Kassenbuch: als Modul, nicht als Pflicht

**Korrigierte Fassung.** Die erste Version dieses Dokuments behauptete, das Kassenbuch sei zwangsläufig und müsse in Stufe 1. Das war in zwei Punkten falsch. Die Korrektur steht in Abschnitt 1, die daraus folgende Produktentscheidung in Abschnitt 3.

---

## 1. Was ich falsch hatte

**Falsch war: „Ein Hotel nimmt Bargeld an, also brauchen wir TSE und Kassenbuch."**

Richtig ist:

1. **Es gibt in Deutschland derzeit keine Registrierkassenpflicht.** Die **offene Ladenkasse** ist zulässig. Ein Betrieb darf Bargeld ohne jedes elektronische System annehmen, solange er täglich einen Kassenbericht erstellt und ein Zählprotokoll führt. Genau so arbeitet das Pilothaus, und das ist vollkommen korrekt.
2. **Die TSE-Pflicht knüpft nicht an das Hotel an, sondern an unsere Software.** Sie greift nur, wenn ein **elektronisches Aufzeichnungssystem mit Kassenfunktion** eingesetzt wird. Nimmt das Hotel bar an und schreibt es woanders auf, entsteht für uns keine Pflicht.
3. **Ein elektronisches Kassenbuch ist keine Kasse.** Das ist der Punkt, den ich verwechselt hatte. Ein digitales Kassenbuch, auch als Onlinewerkzeug oder Tabelle, hat keine Kassenfunktion und fällt **nicht** unter § 146a AO. Es besteht dafür auch keine Meldepflicht. Kassenfunktion setzt voraus, dass das System Zahlungsvorgänge am Verkaufspunkt **erfasst und abwickelt**, Rückgaben und Gutscheine behandelt und einen ordnungsgemäßen Beleg ausgibt.

**Und die Produktkritik war ebenfalls berechtigt.** In [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md) habe ich SoftTec für vertikale Bündelung als Kundenbindung kritisiert und im nächsten Dokument selbst ein Pflicht-Kassenbuch vorgeschlagen. Das widerspricht sich. Ein Hotel mit laufendem Kassenbuch zum Umstieg zu zwingen, ist genau die Hürde, die wir bei anderen bemängeln.

---

## 2. Die Antwort auf die Frage nach dem zweiten Kassenbuch

**Wenn wir nur Einnahmen aus Buchungen erfassen, ist das kein Kassenbuch.** Ein Kassenbuch bildet die Geldlade ab: Bestand, Einlagen, Entnahmen, Zählung, Differenz. Eine reine Umsatzaufzeichnung ist Fakturierung, nicht Kassenführung.

**Aber die Gefahr, die du benennst, ist real.** Wenn wir Barzahlungen erfassen und das Hotel dieselben Vorgänge in seinem eigenen Kassenbuch führt, gibt es **zwei Grundaufzeichnungen desselben Geldflusses**. Die driften auseinander, und in der Prüfung stellt sich die Frage, welche die maßgebliche ist. Zwei Kassenbücher sind schlechter als eines, egal welches.

Daraus folgt die harte Regel:

> **Genau ein System ist das Kassenbuch. Entweder unseres oder das des Betriebs. Nie beide.**

Und damit das nicht durch die Hintertür verletzt wird: **In Modus A gibt es keine Zahlart „Bar".** Nicht ausgegraut, nicht versteckt, sondern nicht vorhanden. Bargeld existiert in diesem Modus im PMS schlicht nicht. Damit ist die Abgrenzung eindeutig, es gibt keine Doppelerfassung, und die Frage, ob ein Zahlungsvermerk schon eine Aufzeichnung ist, stellt sich gar nicht erst.

---

## 3. Die Produktentscheidung: zwei Betriebsmodi

Das Kassenmodul wird **je Betrieb zuschaltbar**. Das ist nicht nur eine Produktentscheidung, es ist auch die vom Bundesfinanzministerium ausdrücklich vorgesehene Konstruktion für Systeme mit optionalem Kassenmodul.

### Modus A: ohne Kassenfunktion (Standard)

| | |
|---|---|
| Was das PMS tut | Belegung, Reservierungen, Gäste, Preise, Folios, Rechnungen, unbare Zahlungen |
| Zahlarten | Überweisung, Karte über ein externes Terminal, OTA-Zahlung, Rechnung an Firma |
| **Keine Zahlart** | **Bar** |
| Kassenbuch | Bleibt beim Betrieb, wo es heute ist. Offene Ladenkasse, Excel, separate Software |
| TSE | Nein, nicht erforderlich, keine Meldepflicht |
| GoBD | **Trotzdem voll anwendbar**, siehe unten |

Das ist **der Standard und der Auslieferungszustand**. Ein Hotel kann uns einsetzen, ohne irgendetwas an seiner Kassenführung zu ändern. Genau das, was du willst.

### Modus B: mit Kassenfunktion

| | |
|---|---|
| Zusätzlich | Kassen, Schichten, Bargeldbewegungen, Einlagen und Entnahmen, Zählprotokoll, Kassendifferenz, Kassenabschluss |
| Zahlarten | Zusätzlich Bar und Kartenzahlung am Terminal vor Ort |
| TSE | **Zwingend.** Wird gemeinsam mit dem Modul bereitgestellt |
| Kassenbuch | Jetzt führt das PMS es. Das externe wird eingestellt |
| Kosten | Fiskalisierung je Kasse, siehe [06-fiskalisierung.md](06-fiskalisierung.md) |

### Die entscheidende Umsetzungsregel

Die amtliche Position lautet, dass ein Kassenmodul nur in Verkehr gebracht werden darf, wenn es eine TSE anbinden kann, und dass die TSE-Anbindung zwingend ist, **sobald der Anwender das Kassenmodul nutzen kann**. Maßgeblich ist also die Nutzbarkeit, nicht die tatsächliche Nutzung.

Daraus folgt zwingend:

> **Es darf keinen Zustand geben, in dem die Kassenfunktion nutzbar ist und keine TSE angebunden ist.**

Praktisch heißt das:

- Das Kassenmodul kann **nicht vom Kunden selbst** in den Einstellungen eingeschaltet werden.
- Die Aktivierung ist ein **Bereitstellungsvorgang**: TSE beim Dienstleister anlegen, Seriennummer eintragen, Kasse anlegen, Modul freischalten. Alles in einem Schritt, protokolliert, mit Datum.
- Schlägt die TSE-Bereitstellung fehl, bleibt das Modul aus. Kein Teilzustand.
- Die Umschaltung braucht ein **Stichdatum**, ab dem das PMS das Kassenbuch führt, damit die Übergabe vom Altsystem sauber dokumentiert ist.

Das ist gleichzeitig die Antwort auf die Zwangsfrage: Weil die Aktivierung ein bewusster, begleiteter Vorgang ist, kann niemand versehentlich hineinrutschen.

---

## 4. Was in beiden Modi gilt

**GoBD ist nicht optional.** Auch ohne Kassenfunktion erzeugt das PMS Rechnungen, und die sind Buchungsbelege. Alles aus [08-compliance-in-der-praxis.md](08-compliance-in-der-praxis.md) bleibt unverändert:

- Unveränderliche Charges, Payments und Rechnungen
- Fortlaufende Rechnungsnummern je Betrieb und Jahr, vergeben beim Festschreiben
- Storno als Gegenbuchung, nie Löschung
- Audit-Log per Datenbank-Trigger
- Aufbewahrung und Löschkonzept

**Das ist wichtig für die Positionierung:** Wir sind auch in Modus A GoBD-fest. Der Unterschied zwischen den Modi betrifft ausschließlich die Kassenfunktion, nicht die Ordnungsmäßigkeit.

---

## 5. Der Grund, warum wir Modus B trotzdem bauen: 2028

Bei der Recherche ist etwas aufgetaucht, das für die ganze Planung relevanter ist als die Modulfrage.

**Die Registrierkassenpflicht kommt.** Stand der Gesetzgebung:

| | |
|---|---|
| Grundlage | Koalitionsvertrag CDU/CSU und SPD |
| Referentenentwurf des BMF | seit Juni 2026 |
| Aktueller Gesetzentwurf | 7. August 2026 |
| Maßgebliches Umsatzjahr | **2027** |
| Pflicht ab | **1. Januar 2028** |
| Schwelle | **100.000 Euro Gesamtumsatz**, bar und unbar zusammen |
| Folge | Elektronisches Kassensystem mit TSE ist Pflicht, offene Ladenkasse entfällt |
| Status | **Noch nicht verabschiedet.** Details, insbesondere Ausnahmen, sind offen und werden vom Steuerberaterverband kritisiert |

**Die Schwelle von 100.000 Euro Gesamtumsatz überschreitet praktisch jedes Hotel.** Schon ein Haus mit zehn Zimmern liegt darüber. Das heißt:

- Die offene Ladenkasse des Pilothauses läuft nach heutigem Stand **Ende 2027 aus**.
- **Der gesamte deutsche Hotelmarkt muss bis zum 1. Januar 2028 eine TSE-Kasse haben.**

Das ist eine erzwungene Umstellungswelle mit festem Datum, und sie trifft genau unsere Zielgruppe. Für uns bedeutet das dreierlei:

1. **Modus B muss deutlich vor 2028 fertig und erprobt sein.** Wer im Herbst 2027 noch keine Kasse anbieten kann, verliert die Welle.
2. **Es ist ein Vertriebsanlass.** Ein Betrieb, der ohnehin eine TSE-Kasse anschaffen muss, ist offen dafür, gleich das ganze System zu wechseln. Das ist der beste Aufhänger für die Migrationskandidaten aus [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md).
3. **Das Argument bleibt freiwillig.** Wir zwingen niemanden. Der Gesetzgeber übernimmt das. Wir müssen nur bereit sein.

**Vorbehalt:** Das Gesetz ist nicht verabschiedet, die Daten können sich verschieben und Ausnahmen sind möglich. Wir sollten den Gesetzgebungsstand halbjährlich nachverfolgen und die Planung nicht darauf verwetten, sondern nur darauf ausrichten.

---

## 6. Was Modus B enthält

Der fachliche Inhalt aus der ersten Fassung bleibt richtig, nur eben als Modul.

### Entitäten

| Entität | Inhalt |
|---|---|
| `cash_register` | Physische Kasse. Ein Betrieb hat oft mehrere: Rezeption, Bar, Restaurant. **Je Kasse eine eigene TSE**, plus Seriennummer und ELSTER-Meldedatum |
| `cash_shift` | Schicht mit Anfangsbestand, verantwortlicher Person, Soll- und Ist-Bestand, Differenz |
| `cash_movement` | Jede Bargeldbewegung. Härtegrad 1, hart unveränderlich |
| `cash_count` | Zählprotokoll, nach Stückelung |
| `cash_closing` | Tagesabschluss, füllt das DSFinV-K-Kassenabschlussmodul |

### Bewegungsarten

| Art | Umsatz? | TSE? |
|---|---|---|
| Einnahme, Gast zahlt bar | ja | ja |
| Ausgabe, Barauslage mit Beleg | nein | ja |
| Einlage, Wechselgeld aus dem Tresor | nein | **ja** |
| Entnahme, Abschöpfung in den Tresor | nein | **ja** |
| Übertrag zwischen Kassen | nein | ja |
| Bankeinzahlung | nein | ja |
| Gebuchte Kassendifferenz | nein | ja |

Der nicht offensichtliche Punkt bleibt: **Einlagen und Entnahmen sind TSE-pflichtig**, obwohl sie keine Umsätze sind. Sie sind kassensturzrelevant, und der Anwendungserlass verlangt die Absicherung aller Vorgänge, die zu einem baren oder kassensturzrelevanten Vorgang gehören. Eine Lücke dort wäre der offensichtliche Weg, Bargeld unbemerkt zu bewegen.

### Die sechs Prüfungspunkte als harte Checks im Code

1. **Der Kassenbestand darf nie negativ werden.** Man kann nicht mehr herausgeben, als in der Lade liegt. Wirksamste Einzelmaßnahme.
2. **Kassensturzfähigkeit jederzeit**, nicht erst nach einem Abschluss.
3. **Differenzen werden gebucht**, mit Grund und Verantwortlichem, nie stillschweigend ausgeglichen.
4. **Jede Ausgabe braucht einen Beleg**, Pflichtfeld.
5. **Täglich abschließen.** Ein ausgelassener Abschluss ist ein Mangel und muss sichtbar sein.
6. **Kassenbestand und Umsatz sind getrennt.** Eine Kartenzahlung ist Umsatz, aber keine Bargeldbewegung. Wer beides vermischt, hat jeden Abend eine Differenz.

---

## 7. Korrektur der Roadmap, zweiter Anlauf

Die erste Fassung zog Kassenbuch und TSE nach Stufe 1. **Das wird zurückgenommen.**

| Stufe | Kassenthema |
|---|---|
| **Stufe 1** | **Modus A.** Keine Zahlart Bar, keine Kassenfunktion, keine TSE. Rechnungen und unbare Zahlungen, voll GoBD-fest. Das Pilothaus kann so sofort produktiv arbeiten und behält seine offene Ladenkasse |
| **Stufe 2** | **Modus B** als zuschaltbares Modul: Kassenbuch, TSE-Anbindung, DSFinV-K-Export. Muss deutlich vor Ende 2027 erprobt sein |

Das war ursprünglich die Aufteilung, bevor ich sie mit falscher Begründung geändert habe. Sie ist richtig, aber aus einem anderen Grund als zunächst gedacht: **nicht weil die Kasse unwichtig wäre, sondern weil sie optional sein muss.**

Die Roadmap in [02-planungsgrundlage.md](02-planungsgrundlage.md) ist entsprechend zurückgesetzt.

---

## 8. Was das über das Produkt insgesamt sagt

Dieser Fall ist ein Muster, das für weitere Module gilt: **Alles, wofür ein Betrieb schon ein laufendes System hat, muss bei uns abschaltbar sein.** Das betrifft neben der Kasse mindestens:

- Kassenbuch
- Buchungsmaschine, viele Häuser haben eine und wollen sie behalten
- Channel Manager
- Restaurantkasse
- Schließsystem

**Das ist die praktische Umsetzung von „kein Zwang zur Bündelung" aus [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md).** Es ist gleichzeitig der Grund, warum das offene API kein Luxus ist: Wer ein Modul bei uns abschaltet, muss sein eigenes anbinden können.

Und es hat eine Konsequenz für die Preisgestaltung: Ein modulares Produkt braucht einen modularen Preis. Wer nur die Belegungsplanung nutzt, zahlt weniger als wer Kasse, Buchungsmaschine und Kiosk dazunimmt. Das ist auch das Modell von SoftTec mit dem Einstieg ab 7 Euro je Zimmer und Aufpreisen je Modul.

---

## Quellen

- [BMF: Anwendungserlass zur Abgabenordnung, zu § 146a](https://ao.bundesfinanzministerium.de/ao/2023/Abgabenordnung/Vierter-Teil/Zweiter-Abschnitt/Erster-Unterabschnitt/Paragraf-146a/ae-146a.html)
- [Haufe / BMF-FAQ: Warenwirtschaftssysteme mit optional zuschaltbarem Kassenmodul](https://www.haufe.de/id/beitrag/das-kassengesetz-fuer-mehr-steuergerechtigkeit-belegausg-3-wie-sind-warenwirtschaftssysteme-zu-beurteilen-die-ueber-ein-optional-zuschaltbares-kassenmodul-verfuegen-HI16191551.html)
- [BMF: FAQ Kassengesetz und Belegausgabepflicht](https://www.bundesfinanzministerium.de/Content/DE/FAQ/FAQ-steuergerechtigkeit-belegpflicht.html)
- [tax & bytes: Quo vadis elektronisches Kassenbuch, Einordnung nach § 146a AO](https://www.taxandbytes.de/360/quo-vadis-elektronisches-kassenbuch)
- [Steuerberater te Heesen: Elektronische Kassenbücher und § 146a AO, Meldepflicht](https://stb-teheesen.de/elektronische-kassenbuecher-%C2%A7-146a-ao-muessen-sie-gemeldet-werden/)
- [sevdesk: Offene Ladenkasse, Voraussetzungen und Anforderungen](https://sevdesk.de/ratgeber/buchhaltung-finanzen/kassenfuehrung/offene-ladenkasse/)
- [Handwerksblatt: Bundesregierung plant Registrierkassenpflicht ab 2027](https://www.handwerksblatt.de/themen-specials/registrierkassen-worauf-muessen-haendler-achten/bundesregierung-plant-registrierkassenpflicht)
- [kassensystemevergleich: Registrierkassenpflicht, Umsatzjahr 2027, Pflicht ab 2028](https://www.kassensystemevergleich.de/registrierkassenpflicht-deutschland/)
- [Haufe: Gesetz zur Einführung einer Kassenpflicht](https://www.haufe.de/steuern/gesetzgebung-politik/gesetz-zur-einfuehrung-einer-kassenpflicht_168_691756.html)
- [IHK Darmstadt: Registrierkassenpflicht soll kommen](https://www.ihk.de/darmstadt/produktmarken/recht-und-fair-play/steuerinfo/registrierkassenpflicht-soll-kommen-der-papierbon-soll-gehen-7123986)
- [IWW: Elektronische Aufzeichnungsgeräte und § 146a AO in der Praxis](https://www.iww.de/bbp/unternehmensberatung/kassenfuehrung-elektronische-aufzeichnungsgeraete-und-der-146a-ao-in-der-praxis-f132011)
