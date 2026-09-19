# DSGVO-Audit des Gesamtsystems

Stand 19. September 2026, Schemastand 42 Migrationen.

Geprüft wurde gegen die **Quelle**, nicht gegen diese Dokumentation: Migrationen,
Routen, Nachtlauf und Oberfläche. Wo ein Befund es zuließ, ist er an einer
laufenden Datenbank **nachgestellt** und nicht nur erschlossen; solche Befunde
sind unten als *nachgewiesen* gekennzeichnet und tragen die Ausgabe bei sich.

Das ist eine technische Prüfung, keine Rechtsberatung. Sie sagt, was das System
tut, und stellt es der Anforderung gegenüber. Ob ein Restrisiko tragbar ist,
entscheidet der Verantwortliche, nicht der Prüfer.

---

## 0. Kurzfassung

Der Entwurf ist in seiner **Substanz** gut: die Dinge, die man nachträglich
kaum repariert, sind von vornherein richtig entschieden. Es gibt kein Feld für
Kartendaten und keines für eine Ausweiskopie — nicht als Regel, sondern als
fehlende Spalte. Die Ausweisnummer liegt mit AES-256-GCM und Schlüsselversion
verschlüsselt, und jeder Abruf wird protokolliert. An Stripe geht eine
Belegnummer und ein Betrag, sonst nichts. Der Meldeschein trägt eine
Vernichtungsfrist, und ein Job hält sie ein.

Der schwerste Befund liegt nicht in dem, was gespeichert wird, sondern in dem,
was beim **Löschen** geschieht:

> Der Audit-Trigger hängt an `guest`, `guest_property_note`, `registration` und
> `guest_agreement`. Er schreibt bei einer Änderung beide Werte und bei einer
> Löschung die ganze Zeile in `audit_log`. Die Löschung nach Art. 17 ist eine
> Änderung. **Sie erzeugt damit im selben Moment eine vollständige, dauerhafte
> und für die Anwendung unerreichbare Kopie genau der Daten, die sie entfernt.**

Das ist keine Schwäche der Löschroutine — die ist sorgfältig gebaut. Es ist
eine Wechselwirkung zwischen zwei Mechanismen, die jeder für sich richtig sind:
Unveränderlichkeit des Protokolls und Löschpflicht am Profil.

| Nr. | Befund | Schwere | Artikel |
|---|---|---|---|
| 1 | Die Löschung schreibt ihre eigene Kopie ins Protokoll | **schwer** | Art. 17, 5 Abs. 1 lit. e; § 30 Abs. 4 BMG |
| 2 | `audit_log` hat keine Zeilenrichtlinie | **schwer** | Art. 32, 25 |
| 3 | `audit_log` hat keine Aufbewahrungsgrenze | **schwer** | Art. 5 Abs. 1 lit. e |
| 4 | Freitextfelder ohne Schutz vor Art.-9-Daten | mittel | Art. 9 |
| 5 | Die Löschung erreicht die Einwilligung nicht | mittel | Art. 17 |
| 6 | Die Auskunft nach Art. 15 ist unvollständig | mittel | Art. 15 |
| 7 | Gastpost überlebt die Löschung bis zu 90 Tage | mittel | Art. 17 |
| 8 | AVV, TOM, Verzeichnis, DSFA und Meldeprozess fehlen | mittel | Art. 28, 30, 32, 33, 35 |
| 9 | `idempotency_key` hält vollständige Antwortkörper | gering | Art. 5, 32 |

---

## 1. Die Löschung schreibt ihre eigene Kopie — *nachgewiesen*

**Was passiert.** `guest_erasure_complete()` anonymisiert das Profil und löscht
Hausnotizen und Meldescheine. Alle drei Tabellen tragen den Audit-Trigger aus
Migration 0001. Der schreibt bei `UPDATE` ein Objekt `{von, nach}` je geändertem
Feld und bei `DELETE` die vollständige alte Zeile.

**Nachgestellt** an einer laufenden Datenbank: ein Gast mit Anschrift,
Geburtsdatum, einer Hausnotiz und einem unterschriebenen Meldeschein, danach die
Löschung über denselben Weg, den der Nachtlauf geht.

Das Profil danach:

```
  last_name   | vorname | email | geburtsdatum |   status
--------------+---------+-------+--------------+------------
 Anonymisiert | NULL    | NULL  | NULL         | anonymized
```

Dieselben Felder danach in `audit_log`:

```json
{
    "ort": "Sylt",
    "email": "hannelore.musterfrau@example.de",
    "telefon": "+49 170 1234567",
    "vorname": "Hannelore",
    "nachname": "Musterfrau",
    "anschrift": "Deichstrasse 7",
    "geburtsdatum": "1968-04-02"
}
```

Die Hausnotiz, deren Zeile gelöscht wurde:

```
Benoetigt barrierefreies Zimmer, kommt mit Sauerstoffgeraet.
```

Der Meldeschein, dessen Vernichtung § 30 Abs. 4 BMG gerade verlangt — samt
Unterschrift:

```
 Unterschrift im Protokoll                | Vernichtungsfrist der Originalzeile
------------------------------------------+-------------------------------------
 <svg><path d="M2,2 L40,30 L80,5"/></svg> | 2027-09-19
```

**Warum die Kopie bleibt.** `hotelpms_app` hat auf `audit_log` genau zwei
Rechte: `INSERT` und `SELECT`. Kein `UPDATE`, kein `DELETE`. Die Anwendung kann
die Kopie nicht entfernen, auch wenn sie wollte — das ist Härtegrad 1 und so
gewollt. Nur trifft es hier die falsche Zeile.

**Warum das mehr ist als eine Formalie.** Derselbe Mechanismus trifft die
Vernichtung des Meldescheins. `purgeRegistrations` löscht nach `destroy_after`,
und genau dieses Löschen legt den Meldeschein mit Unterschrift unbefristet ins
Protokoll. Die Aufbewahrungsfrist wird damit nicht eingehalten, sondern in eine
andere Tabelle verschoben.

**Was zu tun ist.** Der Audit-Trigger braucht eine Feldliste, wie `pino` sie
schon hat. Drei Wege, in der Reihenfolge ihrer Güte:

1. **Feldweise Redaktion im Trigger.** Eine Tabelle `audit_redaction (table_name,
   column_name)`; der Trigger ersetzt diese Felder durch einen Marker statt
   durch den Wert. Das Protokoll behält, *dass* und *wann* jemand den Namen
   geändert hat — das ist der Zweck des Protokolls — und verliert den Namen
   selbst, der dort nie gebraucht wurde.
2. **Löschbare Protokollzeilen für personenbezogene Tabellen.** Eine zweite,
   nicht auf Härtegrad 1 stehende Partition; die Löschroutine räumt sie mit.
   Schwächer, weil sie die Unveränderlichkeit aufweicht.
3. **Nachträgliches Überschreiben durch eine `SECURITY DEFINER`-Funktion.**
   Am schwächsten: sie umgeht die Härtung, die es gerade zu erhalten gilt.

Empfohlen ist Weg 1. Er kostet eine Migration und eine Zeile je zu schützendem
Feld, und er ist die einzige Variante, die nicht die Eigenschaft opfert, wegen
der das Protokoll existiert.

Die verschlüsselte Ausweisnummer ist ein Sonderfall: sie steht als Geheimtext
im Protokoll und ist ohne den Schlüssel wertlos. Sobald die alte
Schlüsselversion aus dem Umlauf ist, ist sie unwiederbringlich — das wirkt hier
zufällig richtig. Verlassen sollte man sich darauf nicht; auch sie gehört auf
die Redaktionsliste.

---

## 2. `audit_log` hat keine Zeilenrichtlinie

**Befund.** Von den Tabellen mit Mandantenbezug trägt `audit_log` als einzige
keine Richtlinie — `0 Richtlinien`, bei gleichzeitigem `SELECT`-Recht für
`hotelpms_app`. Die Tabelle führt `property_id` und `account_id` als Spalten,
verlässt sich zur Trennung aber vollständig darauf, dass jede Abfrage von Hand
filtert.

**Wie schlimm es heute ist.** Nicht schlimm: derzeit liest **keine** Route aus
`audit_log`, es wird nur geschrieben. Das ist der Grund, warum der Befund hier
nicht als aktive Lücke steht, sondern als gestellte Falle. CLAUDE.md nennt genau
diesen Fehler zweimal in der Vergangenheit, beide Male still bemerkt
(Migrationen 0014, 0018). Die erste Route, die ein Protokoll anzeigen will —
und die will früher oder später jemand —, fällt hinein, wenn niemand daran
denkt.

**Was zu tun ist.** Richtlinie nachziehen, wie bei den übrigen Tabellen:
`USING (property_id = ANY (app_property_ids()) OR account_id = ANY
(app_account_ids()))`. Zeilen ohne beides — Plattformvorgänge — bleiben damit
unsichtbar, was richtig ist. Der Schreibpfad läuft über `SECURITY DEFINER` und
ist davon nicht betroffen.

---

## 3. `audit_log` hat keine Aufbewahrungsgrenze

**Befund.** `audit_log_ensure_partitions()` legt zwölf Monate im Voraus an;
derzeit stehen 56 Partitionen. Eine Funktion, die alte Partitionen abhängt oder
löscht, gibt es nicht — weder in der Datenbank noch im Worker.

Damit wächst das Protokoll unbegrenzt, und mit ihm die Kopien aus Befund 1. Art.
5 Abs. 1 lit. e verlangt eine Frist; „so lange wie die Platte reicht" ist keine.

**Was zu tun ist.** Eine Aufbewahrungsdauer festlegen und begründen — für ein
Buchungsprotokoll sind zehn Jahre die naheliegende Wahl, weil sie der längsten
handels- und steuerrechtlichen Frist entspricht und damit nicht gesondert
verteidigt werden muss. Dann ein Gegenstück zu `audit_log_ensure_partitions`,
das ältere Partitionen abhängt und löscht, im selben Job.

---

## 4. Freitextfelder ohne Schutz vor Art.-9-Daten

**Befund.** `guest_property_note.note` und `reservation.notes` sind freies Text.
Die Oberfläche warnt bei der Reservierungsnotiz ausdrücklich („Hier gehören
keine Gesundheitsdaten hin"), aber nichts hindert die Eingabe, und die
Hausnotiz trägt nicht einmal diesen Hinweis.

Das ist keine theoretische Sorge. Die Notiz, die im Versuch zu Befund 1
entstand, ist der Normalfall an einer Rezeption: *barrierefreies Zimmer,
Sauerstoffgerät*. Das ist ein Gesundheitsdatum nach Art. 9 — eine Kategorie mit
deutlich höherer Schwelle, die eine ausdrückliche Einwilligung oder einen der
engen Ausnahmetatbestände braucht.

Verschärft wird es dadurch, dass diese Notizen über Befund 1 dauerhaft ins
Protokoll gelangen: gerade die Datenkategorie mit der strengsten Löschpflicht
landet in der Tabelle, die nicht gelöscht werden kann.

**Was zu tun ist.** Technisch lässt sich ein Freitextfeld nicht dichtmachen, und
der Versuch endete in einer Rezeption, die es in ein anderes Feld schreibt.
Realistisch sind drei Dinge: erstens die Hausnotiz mit demselben Hinweis
versehen wie die Reservierungsnotiz; zweitens beide Felder auf die
Redaktionsliste aus Befund 1 setzen, damit sie wenigstens nicht unlöschbar
werden; drittens die Handreichung für die Rezeption um den Satz ergänzen, dass
eine Anforderung notiert wird (*barrierefreies Zimmer*) und nicht ihr Grund
(*Sauerstoffgerät*). Der erste Teil ist die Information, die der Betrieb
braucht; der zweite ist der, der die Kategorie wechselt.

---

## 5. Die Löschung erreicht die Einwilligung nicht

**Befund.** `guest_agreement` trägt `guest_id` und `signature_svg` — die
Unterschrift unter die Hausbedingungen. Die Quelle von
`guest_erasure_complete()` erwähnt die Tabelle nicht:

```
 guest_agreement | outbound_email | reservation_occupant
-----------------+----------------+----------------------
 NEIN            | NEIN           | NEIN
```

Nach der Löschung steht die Unterschrift also weiter da, verknüpft mit einem
Profil, das jetzt „Anonymisiert" heißt — die Unterschrift trägt den Namen aber
selbst.

Zu `reservation_occupant` ausdrücklich **kein** Befund: die Zeile führt nur
`guest_id` und das Alter bei Anreise, keine unmittelbaren Kennzeichen, und
zeigt nach der Anonymisierung auf ein anonymisiertes Profil. Das ist in Ordnung.

**Einschränkung der Prüfung.** Der Testbestand konnte den Fall nicht
herbeiführen: ein Übungshaus verschickt keine Gastpost und legt keine
Einwilligungen an. Der Befund stützt sich auf die Quelle der Funktion, nicht auf
einen Durchlauf.

**Was zu tun ist.** `guest_agreement.signature_svg` in der Löschroutine auf
`NULL` setzen. Die Zeile selbst bleibt — dass zugestimmt wurde und wann, ist der
Nachweis, um den es geht; das Bild der Unterschrift ist es nicht.

---

## 6. Die Auskunft nach Art. 15 ist unvollständig

**Befund.** Der Export liefert Profil, Aufenthalte, Rechnungen, Hausnotizen und
Meldescheine. Nicht enthalten sind:

- **`outbound_email`** — jede Nachricht an den Gast, mit Adresse, Betreff und
  vollständigem Text. Unstreitig seine Daten.
- **`guest_agreement`** — wann er welcher Fassung zugestimmt hat, mit
  Unterschrift.
- **die Historie aus `audit_log`** — nach Befund 1 der umfangreichste Bestand
  überhaupt.

Art. 15 Abs. 1 verlangt Auskunft über alle verarbeiteten Daten, nicht über die
aktuellen. Die Angaben nach Abs. 1 lit. a bis h — Zwecke, Kategorien,
Empfänger, Speicherdauer, Betroffenenrechte, Herkunft — fehlen im Export
ebenfalls; er liefert Daten, aber keine Auskunft im Sinne der Norm.

**Was zu tun ist.** Die beiden Tabellen ergänzen, das ist wenig Arbeit. Für die
Historie hängt die Antwort an Befund 1: wird dort feldweise redigiert, schrumpft
sie auf „am 4.3. wurde die Anschrift geändert" und ist dann sinnvoll
auszugeben. Die Angaben nach lit. a bis h gehören als fester Kopf an den Export
— sie ändern sich je Betrieb kaum und lassen sich aus den Stammdaten des Hauses
und einem Textbaustein erzeugen.

---

## 7. Gastpost überlebt die Löschung bis zu 90 Tage

**Befund.** `email_redact_old` entfernt Empfänger und Rumpf nach 90 Tagen. Das
ist für sich eine gute Regel und sauber begründet: die Frage „ist die Rechnung
rausgegangen" lässt sich danach ohne Gastdaten beantworten.

Nur hängt sie allein am Alter. Verlangt ein Gast heute Löschung, bleiben Name,
Adresse und der vollständige Rechnungstext bis zu 90 Tage in `outbound_email`
stehen. Die Löschroutine stößt die Redaktion nicht an.

**Was zu tun ist.** `guest_erasure_complete()` redigiert die Post dieses Gastes
mit, unabhängig vom Alter. Dieselbe Funktion, anderer Auslöser.

---

## 8. AVV, TOM, Verzeichnis, DSFA und Meldeprozess fehlen

Das ist der organisatorische Teil, und er ist der einzige, der sich nicht
programmieren lässt.

`docs/08-compliance-in-der-praxis.md` benennt zwei davon korrekt als
Voraussetzung „vor dem ersten Kunden" — den **Auftragsverarbeitungsvertrag nach
Art. 28** und die **dokumentierten TOM nach Art. 32**. Beide existieren als
Absicht, nicht als Dokument. Ohne AVV darf kein Hotel dieses System einsetzen;
das ist keine Empfehlung, sondern die Bedingung dafür, dass der Betrieb den
Dienst überhaupt rechtmäßig nutzen kann.

Drei weitere fehlen und sind bisher nirgends benannt:

- **Verzeichnis von Verarbeitungstätigkeiten (Art. 30 Abs. 2).** Für den
  Auftragsverarbeiter verpflichtend. Der größte Teil lässt sich aus diesem
  Audit und dem Schema ableiten; die Empfängerliste steht unten.
- **Datenschutz-Folgenabschätzung (Art. 35).** Nicht automatisch fällig, aber
  naheliegend: umfangreiche Verarbeitung durch viele Betriebe, Ausweismerkmale,
  gesetzliche Meldepflichten, und nach Befund 4 faktisch Gesundheitsdaten im
  Freitext. Zumindest die Schwellenwertprüfung gehört dokumentiert — auch ein
  begründetes „nicht erforderlich" ist ein Ergebnis.
- **Meldeprozess nach Art. 33/34.** 72 Stunden sind kurz. Wer in dem Moment
  erst überlegt, wen er anruft und was in die Meldung gehört, hält sie nicht
  ein. `docs/17-betrieb.md` regelt den Betrieb, aber keinen Datenschutzvorfall.

**Empfänger, die ins Verzeichnis gehören** (aus dem Quelltext erhoben):

| Empfänger | Wofür | Was geht hin |
|---|---|---|
| Stripe | Zahlungslink | Belegnummer, Betrag, Währung — **kein** Name, **keine** Adresse |
| Brevo (`api.brevo.com`) | Gastpost | Empfängeradresse, Name, Nachrichtentext |
| Channel Manager (roomcloud) | Preise und Verfügbarkeit | keine Gastdaten |
| Statistisches Landesamt | Beherbergungsstatistik | aggregiert nach Wohnsitzland — das System **erzeugt** den Satz, übermittelt wird er außerhalb über eSTATISTIK.core |
| GitHub | Ausrollen | keine Gastdaten |

---

## 9. `idempotency_key` hält vollständige Antwortkörper

**Befund.** Die Tabelle speichert `response_body jsonb` — die vollständige
Antwort der API, also je nach Endpunkt ein Gastprofil oder eine Trefferliste.
Sie hat keine Zeilenrichtlinie, und ihr Schlüssel ist der Client, nicht der
Mandant.

Entschärft ist das dadurch, dass `purgeExpired` nach 24 Stunden räumt und der
Zugriff einen passenden `client_key` verlangt. Es bleibt eine Kopie
personenbezogener Daten außerhalb des Bereichs, den die Zeilenrichtlinie
schützt — und sie überlebt eine Löschung, die in diese 24 Stunden fällt.

**Was zu tun ist.** Entweder Richtlinie über den Mandanten nachziehen, oder —
einfacher und wirksamer — nur speichern, was die Idempotenz wirklich braucht:
Status und die erzeugte Kennung reichen, um dieselbe Antwort ein zweites Mal
auszuliefern.

---

## 10. Was richtig gebaut ist

Ein Audit, das nur Mängel aufzählt, gibt ein falsches Bild. Folgendes ist
geprüft und in Ordnung, und mehreres davon ist besser als üblich:

**Keine Kartendaten, keine Ausweiskopie.** Nicht als Richtlinie, sondern als
fehlende Spalte. Eine Regel wird gebrochen, eine fehlende Spalte nicht. Die
sicherste Form der Datenminimierung.

**Die Ausweisnummer.** AES-256-GCM mit Schlüsselversion, ein Werkzeug zur
Rotation (`rotate-keys.ts`), und — bemerkenswert — jeder Abruf wird
protokolliert, auch der maskierte. Im Protokoll steht `"id_document_number":
"gelesen"`, also die Tatsache des Zugriffs ohne den Wert. Genau so gehört das.

**Stripe bekommt nichts.** Die Sitzung wird mit `Zahlung {Belegnummer}` und
einem Betrag erzeugt, ohne Name und ohne Adresse. `payment_event` speichert die
Ereigniskennung und **keinen** Rumpf. Das ist gelebte Minimierung, nicht
behauptete.

**Der Meldeschein.** `destroy_after` in der Zeile, ein Job, der sie einhält,
und eine Prüfbedingung, die eine Unterschrift bei inländischen Gästen gar nicht
erst zulässt. Die Rechtslage seit dem 1.1.2025 ist im Schema abgebildet, nicht
in einem Kommentar.

**Die aufgeschobene Löschung.** Statt einen Löschwunsch wegen einer
Aufbewahrungsfrist abzulehnen, hält `erasure_requested_at` ihn fest, die
Routine löscht sofort, was der Nachweis nicht braucht, und der Nachtlauf
vollendet den Rest, sobald die Frist fällt. Das ist die richtige Lesart von Art.
17 Abs. 3 lit. b, und sie ist selten sauber umgesetzt.

**Protokollredaktion.** `pino` entfernt Authorization, Cookie, Rumpf, Antwort,
Kennwörter und Ausweisnummern. Konfiguriert und nicht nur vorgesehen.

**Sitzungen.** Cookie mit `httpOnly`, `sameSite=lax`, `secure` im Betrieb;
abgelaufene Sitzungen werden geräumt. Kein Tracking, keine Drittanbieter im
Frontend — die Einwilligungsfrage nach § 25 TTDSG stellt sich damit gar nicht.

**Mandantentrennung.** Zeilenrichtlinie mit `FORCE` auf den Tabellen mit
Gastdaten, transaktionslokaler Kontext, und ein Kontext, der aus dem Token
kommt. Bis auf Befund 2 vollständig.

---

## 11. Reihenfolge

1. **Befund 1** — Redaktionsliste für den Audit-Trigger. Alles andere ist
   kleiner, und Befund 4, 6 und teilweise 3 hängen daran.
2. **Befund 2 und 3** — Richtlinie und Aufbewahrung für `audit_log`. Eine
   Migration, zusammen zu machen.
3. **Befund 5 und 7** — zwei Ergänzungen in `guest_erasure_complete()`.
4. **Befund 6** — zwei Tabellen in den Export, Kopf nach lit. a bis h.
5. **Befund 8** — AVV und TOM vor dem ersten Kunden, Verzeichnis und
   Meldeprozess davor oder gleichzeitig.
6. **Befund 9** — wenn Befund 2 ohnehin angefasst wird.

Befund 4 läuft nebenher: der Hinweis an der Hausnotiz ist eine Zeile, der Rest
ist Schulung.
