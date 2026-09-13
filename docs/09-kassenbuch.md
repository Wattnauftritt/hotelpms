# Kassenbuch und Kassenführung

**Ja, wir bauen ein Kassenbuch. Wir haben keine Wahl.** Es fällt aus der TSE-Pflicht automatisch heraus. Dieses Dokument klärt, was genau dazugehört, was ausdrücklich nicht, und korrigiert einen Widerspruch in der Roadmap.

---

## 1. Warum das keine Entscheidung ist

Die Kette ist zwingend:

1. Ein Hotel nimmt Bargeld an. Minibar, Kurtaxe, Restzahlungen, Trinkgeld. Es gibt praktisch kein Haus ohne Rezeptionskasse.
2. Sobald unsere Software Bargeldbewegungen erfassen kann, ist sie ein **elektronisches Aufzeichnungssystem mit Kassenfunktion** im Sinne von § 146a AO.
3. Damit greift die TSE-Pflicht, und damit auch die **Kassensturzfähigkeit**: Der aus den Aufzeichnungen errechnete Soll-Bestand muss jederzeit mit dem tatsächlichen Geld in der Schublade vergleichbar sein.
4. Eine Aufzeichnung, die jederzeit einen Soll-Bestand liefert, **ist** ein Kassenbuch. Ob wir es so nennen, ändert nichts.

Dazu kommt das DSFinV-K-Format aus [06-fiskalisierung.md](06-fiskalisierung.md): Es hat ein eigenes **Kassenabschlussmodul** mit Summen je Zahlart und Steuersatz. Ohne geführtes Kassenbuch können wir dieses Modul nicht befüllen.

**Umgekehrt gilt aber auch:** Ein Kassenbuch ist keine Finanzbuchhaltung. Die Abgrenzung im nächsten Abschnitt ist der eigentlich wichtige Teil dieser Antwort.

---

## 2. Was wir bauen und was ausdrücklich nicht

| Wir bauen | Wir bauen nicht |
|---|---|
| Kassen je Betrieb, mit eigener TSE je Kasse | Sachkontenrahmen, Bilanz, Gewinn- und Verlustrechnung |
| Schichten mit Anfangs- und Endbestand | Debitorenbuchhaltung mit Mahnwesen (Entscheidung 7 in [02](02-planungsgrundlage.md)) |
| Alle Bargeldbewegungen inklusive Einlagen und Entnahmen | Kreditorenbuchhaltung, Lieferantenrechnungen |
| Zählprotokoll und Kassendifferenz | Lohnbuchhaltung |
| Kassenabschluss je Tag, der Z-Bon | Anlagenbuchhaltung |
| DSFinV-K- und DATEV-Export | Umsatzsteuervoranmeldung |

**Die Grenze verläuft an der Schnittstelle zum Steuerberater.** Wir liefern saubere, kontierte, geprüfte Kassendaten und exportieren sie. Was danach passiert, ist nicht unser Produkt.

Das ist auch die Grenze, an der SoftTec und die meisten deutschen Anbieter stehen. Wer weiter geht, konkurriert mit DATEV, und das ist kein Kampf, den ein PMS gewinnt.

---

## 3. Die Entitäten

### `cash_register` (Kasse)

Eine physische Kasse. Ein Betrieb hat oft mehrere: Rezeption, Bar, Restaurant, Wellness.

| Feld | Anmerkung |
|---|---|
| `property_id`, `name`, `aktiv` | |
| `tse_seriennummer`, `tse_anbieter` | **Je Kasse eine eigene TSE.** Das ist der Kostentreiber aus [06-fiskalisierung.md](06-fiskalisierung.md) |
| `elster_gemeldet_am` | Für die Meldepflicht, siehe unten |
| `waehrung` | |

### `cash_shift` (Schicht)

Die Klammer um einen Zeitraum, in dem eine benannte Person die Verantwortung für die Kasse trägt. Rechtlich nicht zwingend, praktisch unverzichtbar: Ohne Schichten kann man eine Differenz niemandem zuordnen.

| Feld | Anmerkung |
|---|---|
| `cash_register_id`, `eroeffnet_von`, `eroeffnet_am` | |
| `anfangsbestand` | Der Wechselgeldbestand beim Start |
| `geschlossen_von`, `geschlossen_am` | |
| `soll_bestand` | Errechnet aus Anfangsbestand plus allen Bewegungen |
| `ist_bestand` | Aus dem Zählprotokoll |
| `differenz` | Soll minus Ist, wird gebucht, nicht versteckt |

### `cash_movement` (Kassenbewegung)

Der Kern. **Härtegrad 1 nach [08-compliance-in-der-praxis.md](08-compliance-in-der-praxis.md), also hart unveränderlich.**

| Bewegungsart | Beschreibung | Umsatz? | TSE? |
|---|---|---|---|
| `Einnahme` | Gast zahlt bar | ja | ja |
| `Ausgabe` | Barauslage, etwa Paketbote oder Blumen | nein | ja |
| `Einlage` | Wechselgeld aus dem Tresor in die Kasse | nein | **ja** |
| `Entnahme` | Abschöpfung in den Tresor | nein | **ja** |
| `Uebertrag` | Von einer Kasse in eine andere | nein | ja |
| `Bankeinzahlung` | Von der Kasse zur Bank | nein | ja |
| `Differenz` | Gebuchte Kassendifferenz | nein | ja |

**Der nicht offensichtliche Punkt: Einlagen und Entnahmen müssen ebenfalls durch die TSE.** Sie sind keine Umsätze, aber sie sind **kassensturzrelevant**, und der Anwendungserlass verlangt die Absicherung aller Vorgänge, die zu einem baren oder kassensturzrelevanten Vorgang gehören. Wer nur Umsätze signiert und Entnahmen nicht, hat eine Lücke, über die sich Bargeld unbemerkt bewegen ließe. Genau danach sucht ein Prüfer.

### `cash_count` (Zählprotokoll)

Die physische Zählung beim Schichtende, idealerweise nach Stückelung. Klingt nach Detail, ist aber der Beleg dafür, dass tatsächlich gezählt wurde, und nicht nur die Zahl aus dem System abgeschrieben wurde.

### `cash_closing` (Kassenabschluss)

Der Tagesabschluss, klassisch der Z-Bon. Wird vom Nachtlauf ausgelöst, siehe Abschnitt 5. Enthält die Summen je Zahlart und je Steuersatz und ist die Zeile, die im DSFinV-K-Kassenabschlussmodul landet.

---

## 4. Die Regeln, die ein Prüfer prüft

Diese sechs Punkte sind die klassischen Beanstandungen. Sie gehören als harte Prüfungen in den Code, nicht in eine Bedienungsanleitung.

1. **Der Kassenbestand darf nie negativ werden.** Ein negativer Bestand ist der Beweis eines Fehlers, weil man nicht mehr Geld herausgeben kann, als in der Lade liegt. Wir prüfen das bei jeder Bewegung und lehnen ab. Das ist die wirksamste Einzelmaßnahme überhaupt.
2. **Kassensturzfähigkeit jederzeit.** Der Soll-Bestand muss auf Knopfdruck da sein, nicht erst nach einem Abschluss.
3. **Differenzen werden gebucht, nicht ausgeglichen.** Eine Differenz ist eine eigene Bewegungsart mit Grund und Verantwortlichem. Wer Differenzen still glattzieht, manipuliert.
4. **Jede Ausgabe braucht einen Beleg.** Pflichtfeld, mindestens Belegnummer und Zweck.
5. **Täglich abschließen.** Kasseneinnahmen sind täglich zu erfassen, siehe [08-compliance-in-der-praxis.md](08-compliance-in-der-praxis.md). Ein Abschluss, der zwei Tage aussetzt, ist ein Mangel. Das System muss daran erinnern und den ausstehenden Abschluss sichtbar machen.
6. **Trennung von Kassenbestand und Umsatz.** Der häufigste Denkfehler in selbstgebauten Systemen: Eine Kartenzahlung ist Umsatz, aber keine Bargeldbewegung. Sie erhöht den Tagesumsatz und nicht den Kassenbestand. Wer beides in einen Topf wirft, bekommt jeden Abend eine Differenz.

---

## 5. Zusammenspiel mit dem Nachtlauf

Der Kassenabschluss und der Nachtlauf sind zwei verschiedene Dinge, die oft verwechselt werden:

| | Kassenabschluss | Nachtlauf |
|---|---|---|
| Betrifft | Eine Kasse | Den ganzen Betrieb |
| Häufigkeit | Je Kasse und Tag, oft zusätzlich je Schicht | Einmal täglich |
| Inhalt | Bargeldbestand, Zahlarten, Z-Bon, TSE-Abschluss | Logis buchen, No-Shows, Geschäftsdatum weiterschalten |

Der Nachtlauf **löst** den fälligen Kassenabschluss aus, sofern die Rezeption ihn nicht schon manuell gemacht hat, und meldet offene Kassen in der Prüfliste. Das ergänzt Abschnitt 5 von [02-planungsgrundlage.md](02-planungsgrundlage.md).

---

## 6. Korrektur der Roadmap

Beim Durchgehen ist ein Widerspruch aufgefallen, der vorher nicht auflösbar war:

- **Stufe 1** enthält „Payments (Bar, Karte extern erfasst, Überweisung)".
- **Stufe 2** enthält „Cloud-TSE für Barzahlungen, DSFinV-K-Export".

**Das geht nicht zusammen.** Sobald ein Betrieb produktiv Bargeld über unser System erfasst, braucht er die TSE. Es gibt keine legale Zwischenstufe „Bargeld ohne TSE". Und da das Pilothaus laut Entscheidung 1 ein echtes Haus im laufenden Betrieb ist, ist das keine theoretische Frage.

**Zwei mögliche Auflösungen:**

| Variante | Beschreibung | Bewertung |
|---|---|---|
| **A: TSE und Kassenbuch nach Stufe 1 ziehen** | Der MVP kann von Anfang an legal kassieren | Mehr Aufwand in Stufe 1, dafür ist das Ergebnis sofort produktiv einsetzbar und verkaufbar |
| **B: Stufe 1 ausdrücklich ohne Kasse** | Kein Bargeld, Zahlungen nur als Vermerk. Das Pilothaus führt seine Kasse weiter im Altsystem | Schnellerer MVP, aber Doppelarbeit im Pilothaus und kein verkaufbares Produkt am Ende von Stufe 1 |

**Empfehlung: Variante A.** Ein PMS ohne Kasse ist in Deutschland kein Produkt, sondern ein Prototyp. Der Aufwand für Kassenbuch plus TSE-Anbindung über einen Dienstleister ist überschaubar, weil die schwierigen Teile eingekauft werden. Und die Kassenlogik greift tief in Folio, Rechnung und Nachtlauf ein, also ist ein späteres Einziehen teurer als ein sofortiger Einbau.

Die Roadmap in [02-planungsgrundlage.md](02-planungsgrundlage.md) ist entsprechend angepasst.

---

## 7. Nebeneffekt: das ist ein Verkaufsargument

Ein sauberes deutsches Kassenbuch mit Schichtabschluss, Zählprotokoll und Differenzbuchung ist genau die Stelle, an der die internationalen Systeme dünn sind. Mews, Cloudbeds und Opera behandeln die Kasse als eine von vielen Zahlarten. Ein deutscher Rezeptionsleiter, der bisher abends eine Excel-Tabelle geführt hat, sieht den Unterschied in der ersten Demo.

Das gehört zur „deutschen Tiefe" aus [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md) und ist billiger zu bauen, als es wirkt, weil die eigentliche Fiskalisierung zugekauft wird.

---

## Quellen

- [BMF: Anwendungserlass zur Abgabenordnung, zu § 146a](https://ao.bundesfinanzministerium.de/ao/2023/Abgabenordnung/Vierter-Teil/Zweiter-Abschnitt/Erster-Unterabschnitt/Paragraf-146a/ae-146a.html)
- [IWW: Elektronische Aufzeichnungsgeräte und § 146a AO in der Praxis](https://www.iww.de/bbp/unternehmensberatung/kassenfuehrung-elektronische-aufzeichnungsgeraete-und-der-146a-ao-in-der-praxis-f132011)
- [receipt4s: DSFinV-K einfach erklärt, Kassenabschlussmodul](https://receipt4s.de/en/dsfinv-k-einfach-erklaert/)
- [Haufe: GoBD, Festschreibung der Buchführung](https://www.haufe.de/finance/haufe-finance-office-premium/gobd-von-a-wie-aufzeichnungen-bis-z-wie-zwangsgeld-126-festschreibung-der-buchfuehrung_idesk_PI20354_HI9892666.html)
