# Compliance in der Praxis: was unveränderbar, TSE-pflichtig und ISO wirklich bedeuten

Drei Fragen, die direkt die Datenbankstruktur betreffen. Die kurzen Antworten:

- **Unveränderbar heißt nicht „nie änderbar", sondern „nicht spurlos änderbar".** Das ist ein erheblicher Unterschied und macht die Umsetzung deutlich einfacher, als es zunächst klingt.
- **Die TSE signiert nicht jede Buchung im System**, sondern nur Vorgänge mit Kassenbezug. Eine Reservierung wird nie signiert.
- **ISO 27001 ist nicht gesetzlich vorgeschrieben.** Wir bauen die Kontrollen früh, das Zertifikat holen wir erst, wenn ein Kunde danach fragt.

> Hinweis: Das folgende ist eine sorgfältige Auslegung der Rechtslage, keine steuerliche Beratung. Vor dem Produktivgang muss ein Steuerberater oder Wirtschaftsprüfer die Umsetzung abnehmen. Das ist ohnehin nötig, weil die Verfahrensdokumentation testiert werden sollte.

---

# Teil 1: Was „unveränderbar" tatsächlich verlangt

## 1.1 Die Norm

Der entscheidende Satz steht in **§ 146 Abs. 4 AO**:

> Eine Buchung oder eine Aufzeichnung darf nicht in der Weise verändert werden, dass der ursprüngliche Inhalt nicht mehr feststellbar ist.

**Verboten ist also nicht die Änderung, sondern der Verlust des ursprünglichen Inhalts.** Wer ändert, muss dokumentieren, was vorher dastand und warum geändert wurde. Das ist eine ganz andere Anforderung als „die Datenbank darf kein UPDATE kennen".

Ergänzend die GoBD: Es gilt das **Verbot der unprotokollierten Änderung**. Jede Veränderung und jede Löschung an Buchungen und Aufzeichnungen muss protokolliert werden. Stornos und Korrekturen müssen auf die Ursprungsbuchung rückbeziehbar sein. Ein ersatzloses Löschen ist unzulässig.

## 1.2 Der Schlüsselbegriff: Festschreibung

Die Praxis dreht sich um die **Festschreibung**. Vorher gilt ein weicheres Regime, nachher ein hartes.

| Zustand | Was erlaubt ist |
|---|---|
| **Vor der Festschreibung** | Ändern und korrigieren ist erlaubt, muss aber protokolliert werden |
| **Nach der Festschreibung** | Keine Änderung mehr. Eine Korrektur entsteht ausschließlich als **Storno plus Neubuchung**, beide mit eigener fortlaufender Nummer und Bezug zum Original |

**Die Fristen, bis wann festgeschrieben sein muss:**

| Vorgang | Frist |
|---|---|
| Kasseneinnahmen | **täglich** erfassen |
| Unbare Geschäftsvorfälle | innerhalb von **zehn Tagen** erfassen |
| Festschreibung IT-gestützt erfasster unbarer Vorgänge | bis zum **Ablauf des Folgemonats** |

Für uns heißt das konkret: Der Nachtlauf ist nicht nur ein betrieblicher Ablauf, er ist der **Festschreibungszeitpunkt für den Kassenbereich**. Was der Nachtlauf abgeschlossen hat, ist hart.

## 1.3 Was das für unsere Tabellen bedeutet

Hier die praktische Umsetzung. **Nicht alles muss append-only sein.** Drei Härtegrade:

### Härtegrad 1: hart unveränderlich

Kein UPDATE, kein DELETE. Die Anwendungsrolle bekommt in PostgreSQL schlicht keine Rechte dafür. Korrektur nur durch eine neue Zeile, die auf die alte verweist.

| Tabelle | Begründung |
|---|---|
| `charge` | Umsatzbuchung |
| `payment` | Zahlung |
| `invoice` | Festgeschriebenes Dokument mit fortlaufender Nummer |
| `tse_transaction` | Signaturprotokoll |
| `audit_log` | Das Protokoll selbst darf erst recht nicht änderbar sein |

Ein Storno ist hier eine **zweite Zeile** mit negativem Betrag und einem Feld `storniert_von` beziehungsweise `storniert_durch`. Die Ursprungszeile bleibt unangetastet stehen. Die Summe über beide ist null. Genau so will es der Prüfer sehen.

### Härtegrad 2: festgeschrieben nach einem Ereignis

Änderbar bis zu einem definierten Moment, danach hart.

| Tabelle | Festschreibung durch |
|---|---|
| `folio` | Schließen des Folios beziehungsweise Rechnungserstellung |
| `reservation_night` | Nachtlauf, der die Nacht gebucht hat |
| `business_day` | Abschluss des Nachtlaufs |

### Härtegrad 3: änderbar mit Protokoll

UPDATE ist erlaubt. Ein Datenbank-Trigger schreibt den Vorzustand ins Audit-Log.

| Tabelle | Warum unkritisch |
|---|---|
| `reservation` | **Eine Reservierung ist keine Buchung.** Sie ist eine Absichtserklärung über eine künftige Leistung |
| `guest`, `company` | Stammdaten, keine Geschäftsvorfälle |
| `rate_plan`, `rate_day`, `restriction_day` | Preispflege ist laufender Betrieb |
| `unit`, `resource_category` | Konfiguration |
| `housekeeping_status` | Betrieblicher Zustand ohne steuerliche Relevanz |

**Das ist die wichtigste Entlastung in diesem ganzen Dokument.** Die Versuchung ist groß, aus Vorsicht alles append-only zu machen. Das würde die Anwendung erheblich komplizierter und langsamer machen, ohne dass es die GoBD verlangt. Eine Reservierung, die von Dienstag auf Mittwoch verschoben wird, ist kein Buchhaltungsvorgang.

## 1.4 Zwei Umsetzungsdetails

**Das Audit-Log gehört in Datenbank-Trigger, nicht in die Anwendung.** Was in der Anwendungsschicht liegt, wird irgendwann an einer Stelle vergessen, typischerweise in einem Importskript oder einer Migration. Ein Trigger auf der Tabelle kann nicht umgangen werden. Ein generischer Trigger, der `OLD` als JSONB samt Benutzer und Zeitstempel wegschreibt, deckt alle Tabellen des Härtegrads 3 mit einer Implementierung ab.

**Löschen in der Oberfläche darf trotzdem „Löschen" heißen.** Wenn die Rezeption eine falsch gebuchte Minibar entfernt, klickt sie auf Löschen. Dahinter passiert ein Storno. Der Anwender muss die GoBD nicht verstehen, das System muss sie einhalten. Diese Trennung von Bedienlogik und Datenlogik ist der Unterschied zwischen einem Produkt, das sich gut anfühlt, und einem, das nach Behörde riecht.

## 1.5 Rechnungsnummern

Ein Punkt, der oft unterschätzt wird: Rechnungsnummern müssen **fortlaufend und je Nummernkreis lückenlos** sein. Eine Lücke muss erklärbar sein. Praktisch heißt das:

- Ein Nummernkreis **je Property und Jahr**.
- Die Nummer wird erst beim **Festschreiben** vergeben, nicht beim Anlegen des Entwurfs. Sonst entstehen Lücken durch abgebrochene Vorgänge.
- Die Vergabe läuft über eine Datenbanksequenz oder eine gesperrte Zählerzeile in derselben Transaktion. **Keine Vergabe in der Anwendung**, sonst gibt es bei gleichzeitigen Check-outs Doppelvergaben.
- Ein Storno bekommt eine **eigene** Nummer aus demselben Kreis.

---

# Teil 2: Welche Vorgänge die TSE wirklich signiert

## 2.1 Die klare Antwort auf die Frage

**Nein, nicht jede Buchung im System.** Die TSE schützt die **Kassenfunktion**, nicht das PMS als Ganzes.

Der Maßstab aus dem Anwendungserlass: Ein elektronisches Aufzeichnungssystem hat eine **Kassenfunktion**, wenn es zumindest teilweise Bargeldbewegungen erfassen und abwickeln kann. Und abzusichern sind grundsätzlich alle Geschäftsvorfälle, die **zu einem baren oder kassensturzrelevanten Vorgang gehören oder werden können**.

## 2.2 Was signiert wird und was nicht

| Vorgang im PMS | TSE? | Begründung |
|---|---|---|
| Reservierung anlegen, ändern, stornieren | **Nein** | Kein Geschäftsvorfall im Kassensinn, kein Geld bewegt |
| Check-in | **Nein** | Betrieblicher Vorgang |
| Logis auf ein offenes Folio buchen | **Nein**, solange nicht kassiert wird | Kontokorrent, laufende Rechnung |
| Minibar auf ein offenes Folio buchen | **Nein**, solange nicht kassiert wird | dito |
| **Barzahlung an der Rezeption** | **Ja** | Kernfall |
| **Kartenzahlung am Terminal an der Rezeption** | **Ja** | Elektronische Zahlungsform vor Ort wird ausdrücklich einbezogen |
| Gutschein oder Wertkarte vor Ort eingelöst | **Ja** | Wird bargeldgleich behandelt |
| Rechnung erstellen mit sofortiger Zahlung | **Ja** | Kassiervorgang |
| Rechnung auf Firmenkonto, Zahlung später per Überweisung | **Grauzone**, siehe unten | Debitorenvorgang, kein Kassensturz |
| Abgebrochener Kassiervorgang | **Ja** | Abbrüche sind ausdrücklich mit zu erfassen |
| Trainings- oder Testbuchung | **Ja**, als solche gekennzeichnet | Sonst könnte man echte Umsätze als Training tarnen |
| Kassenabschluss am Tagesende | **Ja** | Eigener Vorgangstyp |

## 2.3 Die Grauzone und wie wir damit umgehen

Die Abgrenzung zwischen **Kassenvorgang** und reinem **Debitorenvorgang** ist die einzige echte Auslegungsfrage. Eine Firmenrechnung, die per Überweisung beglichen wird, berührt keine Kasse. Sie gehört in den City Ledger, nicht in den Kassenabschluss.

Riskant wird es, wenn man diese Grenze zu großzügig zieht, denn dann kann man Barumsätze als Debitorenvorgänge tarnen, und genau das will das Gesetz verhindern.

**Unser Vorgehen:**

1. Eine **Zahlung** ist der Auslöser, nicht die Rechnung. Alles, was auf dem Weg über die Rezeptionskasse abgewickelt wird, geht durch die TSE. Alles, was reine Forderung bleibt und später auf dem Bankkonto eingeht, nicht.
2. Der **Signaturbeginn** liegt beim Start des Kassiervorgangs, nicht beim Abschluss. Damit sind auch Abbrüche protokolliert.
3. Wir bauen die Zuordnung **konfigurierbar je Zahlart**, weil sich Auslegungen ändern. Ein Flag `tse_pflichtig` an der Zahlart, änderbar ohne Codeänderung.
4. Im Zweifel signieren wir. Eine zu viel signierte Zahlung ist kein Verstoß, eine zu wenig signierte schon.

## 2.4 Was in unserem Datenmodell dazukommt

```sql
CREATE TABLE tse_transaction (
  id                bigserial PRIMARY KEY,
  property_id       bigint  NOT NULL,
  payment_id        bigint,            -- Bezug zur Zahlung, falls vorhanden
  vorgangstyp       text    NOT NULL,  -- Kassenbeleg, Abbruch, Training, Abschluss
  transaktionsnummer bigint NOT NULL,  -- von der TSE, lueckenlos
  signaturzaehler   bigint  NOT NULL,
  start_zeit        timestamptz NOT NULL,
  ende_zeit         timestamptz,
  signatur          text    NOT NULL,
  tse_seriennummer  text    NOT NULL,
  qr_nutzdaten      text    NOT NULL   -- fuer den Beleg
);
```

Diese Tabelle ist Härtegrad 1, also hart unveränderlich. Und sie ist **das Protokoll unserer Seite**, nicht die TSE selbst. Die eigentlichen Daten liegen zusätzlich beim Fiskaldienstleister, siehe [06-fiskalisierung.md](06-fiskalisierung.md).

**Wichtig, weil es der häufigste Denkfehler ist:** Die TSE schützt die Kassendaten. Sie schützt nicht unsere Datenbank. GoBD-Festigkeit nach Teil 1 müssen wir davon unabhängig selbst herstellen.

---

# Teil 3: Aufbewahrungsfristen

Hier hat sich 2025 etwas geändert, das in älteren Quellen noch falsch steht.

| Unterlagenart | Frist | Grundlage |
|---|---|---|
| **Buchungsbelege**, also Rechnungen, Belege, Kassenbelege | **8 Jahre** | § 147 Abs. 1 Nr. 4 in Verbindung mit Abs. 3 AO, verkürzt durch das Vierte Bürokratieentlastungsgesetz zum 1. Januar 2025 |
| Handelsbücher, Aufzeichnungen, Inventare, Jahresabschlüsse | **10 Jahre** | unverändert |
| Kassendaten und TSE-Aufzeichnungen | **10 Jahre** | zählen zu den Aufzeichnungen |
| Empfangene Handels- und Geschäftsbriefe | 6 Jahre | § 147 Abs. 3 AO |
| **Meldescheine** | **1 Jahr**, danach Vernichtung binnen 3 Monaten | Bundesmeldegesetz, siehe [01-marktanalyse-pms.md](01-marktanalyse-pms.md) |

Die Verkürzung auf 8 Jahre gilt auch rückwirkend für Belege, deren Frist am 31. Dezember 2024 noch nicht abgelaufen war. Für Banken und Versicherungen wurde sie im August 2025 wieder auf 10 Jahre angehoben, was uns nicht betrifft.

**Praktische Empfehlung: technisch 10 Jahre vorsehen und je Datenart konfigurierbar machen.** Der Unterschied zwischen 8 und 10 Jahren kostet uns bei diesen Datenmengen nichts, aber ein Löschkonzept, das nach Datenart unterscheidet, brauchen wir ohnehin.

**Und der eigentliche Konflikt:** Die Aufbewahrungspflicht steht gegen das Löschrecht aus der DSGVO. Ein Gast, der Löschung verlangt, hat Anspruch darauf, aber nicht auf die Löschung steuerrelevanter Belege. Die saubere Lösung ist **Sperren statt Löschen**: Die Person wird im operativen Betrieb unsichtbar und anonymisiert, die Belege bleiben mit dem historischen Namen bestehen, weil die Rechnung ohne Empfänger wertlos wäre. Das muss im Löschkonzept dokumentiert sein, und der Meldeschein mit seiner Ein-Jahres-Frist braucht einen eigenen, automatischen Löschjob.

---

# Teil 4: ISO 27001, ehrlich betrachtet

## 4.1 Brauchen wir das?

**Gesetzlich: nein.** ISO 27001 ist eine freiwillige Norm für ein Informationssicherheits-Managementsystem. Kein Gesetz verlangt sie von einem PMS-Anbieter.

**Vertrieblich: irgendwann ja, aber nicht am Anfang.**

| Kundensegment | Fragt nach ISO 27001? |
|---|---|
| Ferienwohnung, Pension, kleines Hotel | Nein, praktisch nie |
| Unabhängiges Haus mit 20 bis 150 Zimmern | Selten |
| Kleine Gruppe, 5 bis 20 Häuser | Gelegentlich |
| Kette, Franchisenehmer einer Marke, öffentlicher Auftraggeber | **Regelmäßig, oft als Ausschlusskriterium** |

Da wir laut [02-planungsgrundlage.md](02-planungsgrundlage.md) im Mittelbau starten und die großen Häuser später kommen, brauchen wir das Zertifikat **nicht zum Marktstart**.

## 4.2 Was es realistisch kostet

Ich muss hier eine frühere Angabe korrigieren. In [05-wettbewerber-softtec.md](05-wettbewerber-softtec.md) stand „mittlerer fünfstelliger Betrag". Das trifft nur die direkten Kosten und unterschätzt das Ganze deutlich.

| Kostenblock | Realistisch |
|---|---|
| Zertifizierungsaudit durch akkreditierte Stelle | 10.000 bis 30.000 € |
| Beratung oder ISMS-Plattform für den Aufbau | 10.000 bis 25.000 € |
| **Interner Aufwand: etwa 1 Vollzeitkraft über 12 Monate** | **80.000 bis 120.000 €** |
| GRC-Werkzeuge, jährlich | 5.000 bis 15.000 € |
| **Erstes Jahr gesamt** | **etwa 50.000 bis 150.000 €** |
| Folgejahre, Überwachungsaudits plus laufender Betrieb | 20.000 bis 50.000 € jährlich |

Der Ablauf: Erstzertifizierung, dann **Überwachungsaudits in den Jahren 1 und 2**, dann im dritten Jahr Rezertifizierung.

**Der größte Posten ist nicht das Audit, sondern die interne Zeit.** Ein ISMS ist ein Managementsystem mit Richtlinien, Risikoanalysen, Schulungen, Vorfallsprozessen und Wirksamkeitsprüfungen. Es ist kein Häkchen, das man setzt.

## 4.3 Was stattdessen Pflicht ist

Zwei Dinge, die wir **vor dem ersten Kunden** brauchen, unabhängig von jeder Zertifizierung:

1. **Auftragsverarbeitungsvertrag (AVV) nach Art. 28 DSGVO** mit jedem Hotel. Wir verarbeiten Gästedaten im Auftrag des Hotels, also sind wir Auftragsverarbeiter. Ohne AVV darf uns kein Hotel einsetzen. Das ist ein Standarddokument, aber es muss existieren.
2. **Dokumentierte technische und organisatorische Maßnahmen (TOM) nach Art. 32 DSGVO.** Eine Beschreibung, wie wir Verschlüsselung, Zugriffskontrolle, Mandantentrennung, Protokollierung, Backup und Wiederherstellung umsetzen. Kunden fragen danach, und der Datenschutzbeauftragte eines größeren Hauses liest sie tatsächlich.

Diese beiden zusammen kosten ein paar Tage Arbeit und decken 90 Prozent dessen ab, wonach ein mittelständisches Hotel fragt.

## 4.4 Empfehlung

**Die Kontrollen früh bauen, das Zertifikat spät kaufen.**

Der Grund: Fast alles, was ISO 27001 an Technik verlangt, ist ohnehin gute Praxis und kostet am Anfang fast nichts, während es später teuer nachzurüsten ist:

- Mandantentrennung auf Datenebene, also `property_id` in jeder Tabelle und Durchsetzung in jeder Abfrage
- Rollen- und Rechtemodell mit dem Prinzip der geringsten Rechte
- Verschlüsselung im Transport und der Datenträger
- Vollständige Zugriffsprotokollierung, die ohnehin für die GoBD gebraucht wird
- Getestete Backups mit dokumentierter Wiederherstellungszeit
- Ein Prozess für Sicherheitsvorfälle und Meldung binnen 72 Stunden nach DSGVO
- Nachvollziehbare Freigaben und Trennung von Entwicklungs- und Produktivumgebung

**Zeitplan:** AVV und TOM zum ersten Kunden. ISO 27001 dann angehen, wenn der erste ernsthafte Interessent es zur Bedingung macht, und die Kosten in dessen Vertrag einpreisen. Nicht vorher, weil 50.000 bis 150.000 Euro in der Frühphase besser in das Produkt fließen.

---

## Zusammenfassung als Regelsatz

1. Unveränderbar heißt nicht spurlos änderbar. Änderung ist erlaubt, Verlust des Originals nicht.
2. Drei Härtegrade statt append-only für alles. Reservierungen sind keine Buchungen.
3. Nach der Festschreibung nur noch Storno plus Neubuchung, beide mit eigener Nummer und Bezug zum Original.
4. Audit-Log über Datenbank-Trigger, nicht in der Anwendung.
5. Die Oberfläche darf „Löschen" anbieten, dahinter läuft ein Storno.
6. Rechnungsnummern werden beim Festschreiben vergeben, aus einer Sequenz, je Property und Jahr.
7. Die TSE signiert Zahlungen mit Kassenbezug, nicht Reservierungen und nicht Buchungen auf offene Folios.
8. Die Zuordnung Zahlart zu TSE-Pflicht ist konfigurierbar, im Zweifel wird signiert.
9. Aufbewahrung technisch 10 Jahre, je Datenart konfigurierbar. Meldeschein hat einen eigenen Ein-Jahres-Löschjob.
10. DSGVO-Löschung wird als Sperren und Anonymisieren umgesetzt, Belege bleiben bestehen.
11. AVV und TOM vor dem ersten Kunden. ISO 27001 erst, wenn ein Kunde zahlt.

## Quellen

- [BMF: Anwendungserlass zur Abgabenordnung, zu § 146a](https://ao.bundesfinanzministerium.de/ao/2023/Abgabenordnung/Vierter-Teil/Zweiter-Abschnitt/Erster-Unterabschnitt/Paragraf-146a/ae-146a.html)
- [BMF: Neufassung des Anwendungserlasses zu § 146a AO (PDF)](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/AO-Anwendungserlass/2023-06-30-AEAO-Par-146-AO.pdf?__blob=publicationFile&v=2)
- [IWW: Elektronische Aufzeichnungsgeräte und § 146a AO in der Praxis](https://www.iww.de/bbp/unternehmensberatung/kassenfuehrung-elektronische-aufzeichnungsgeraete-und-der-146a-ao-in-der-praxis-f132011)
- [Haufe: GoBD, Festschreibung der Buchführung](https://www.haufe.de/finance/haufe-finance-office-premium/gobd-von-a-wie-aufzeichnungen-bis-z-wie-zwangsgeld-126-festschreibung-der-buchfuehrung_idesk_PI20354_HI9892666.html)
- [NWB: GoBD, Unveränderbarkeit, Protokollierung von Änderungen und Aufbewahrung](https://datenbank.nwb.de/Dokument/707584/)
- [Haufe: Bürokratieentlastungsgesetz, Aufbewahrungspflichten verkürzt](https://www.haufe.de/finance/buchfuehrung-kontierung/buerokratieentlastungsgesetz-aufbewahrungspflichten-verkuerzt_186_634670.html)
- [BBH: Verkürzung der Aufbewahrungsfrist auf 8 Jahre und das DSGVO-Löschkonzept](https://www.bbh-blog.de/allgemein/verkuerzung-der-aufbewahrungsfristen-fuer-buchungsbelege-auf-8-jahre-unternehmen-muessen-ihr-loeschkonzept-nach-ds-gvo-ueberpruefen-buerokratiebelastung-statt-buerokratieentlastung/)
- [IHK Hochrhein-Bodensee: Aufbewahrung von Geschäftsunterlagen](https://www.ihk.de/konstanz/recht-und-steuern/steuer-und-finanzpolitik/finverwal/aufbewahrung-von-geschaeftsunterlagen-1672476)
- [heyData: ISO 27001 Kosten 2026 für KMU](https://heydata.eu/magazin/iso-27001-kosten-2026-zertifizierung-kmu)
- [Proliance: ISO 27001 Kosten 2026](https://www.proliance.ai/blog/iso-27001-kosten-2026-was-die-zertifizierung-wirklich-kostet)
- [secjur: ISO 27001 Kosten nach Firmengröße](https://www.secjur.com/blog/iso-27001-kosten)
