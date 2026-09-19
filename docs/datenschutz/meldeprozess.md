# Datenschutzvorfall: was in den ersten 72 Stunden geschieht

nach **Art. 33 und 34 DSGVO**.

> Wer im Ernstfall erst überlegt, wen er anruft und was in die Meldung
> gehört, hält die Frist nicht ein. Deshalb steht es vorher hier.
>
> Als Auftragsverarbeiter melden wir **nicht** an die Aufsichtsbehörde. Wir
> melden **unverzüglich an den Verantwortlichen** — Art. 33 Abs. 2 —, und der
> entscheidet über die Meldung an die Behörde. „Unverzüglich" heißt hier:
> ohne die eigene Untersuchung abzuwarten.

---

## Auslöser

Jeder Verdacht auf unbefugten Zugriff, Verlust, Veränderung oder
unbeabsichtigte Offenlegung personenbezogener Daten. Auch der **Verdacht**
löst die Uhr aus, nicht erst die Bestätigung.

Typische Fälle in diesem System:

- ein Mandantenkontext greift nicht, und jemand sieht fremde Daten
- ein Maschinenzugang oder ein Signaturschlüssel ist abhandengekommen
- ein Datenbankabzug liegt an einem Ort, an den er nicht gehört
- Gastpost geht an einen falschen Empfänger
- ein Zugang wird von einer unerwarteten Stelle benutzt

## Schritt 1 — sofort, ohne Untersuchung abzuwarten

| | |
|---|---|
| Wer entscheidet | ⟨Name, Vertretung⟩ |
| Erreichbar unter | ⟨Telefon, außerhalb der Geschäftszeit⟩ |
| Wer informiert die Kunden | ⟨Rolle⟩ |
| Datenschutzbeauftragter | ⟨Name und Kontakt, falls benannt⟩ |

**Zugang sperren, bevor untersucht wird.** Ein Maschinenzugang wird gesperrt
und seine Token entwertet; eine Support-Sitzung wird beendet; ein Benutzer
wird gesperrt. Das kostet einen Betrieb eine Stunde Unannehmlichkeit und
begrenzt den Schaden.

**Nichts löschen.** Protokolle, Sitzungsdaten und Systemprotokolle sind
Beweismittel. Die Versuchung, „aufzuräumen", ist der häufigste Fehler.

## Schritt 2 — Umfang feststellen

Die Fragen, die der Verantwortliche stellen wird, und wo die Antwort steht:

| Frage | Quelle |
|---|---|
| Welche Häuser sind betroffen? | `audit_log.property_id`, `account_id` |
| Wer hat was angefasst? | `audit_log`, gefiltert nach `user_id` und Zeitraum |
| Lief es über eine Support-Sitzung? | `audit_log.support_session_id`, `support_session` |
| Wurde eine Ausweisnummer gelesen? | `audit_log`, `changed ? 'id_document_number'` |
| Welche Gastpost ging hinaus? | `outbound_email` |
| Welche Maschinenzugänge waren aktiv? | `oauth_access_token`, `last_used_at` |

Das Protokoll hält **welches Feld** angefasst wurde, nicht seinen Wert
(Migration 0043). Für die Meldung genügt das: gefragt ist die Kategorie der
Daten, nicht ihr Inhalt.

## Schritt 3 — an den Verantwortlichen melden

Eine Meldung je betroffenem Betrieb, auch wenn die Ursache dieselbe ist. Der
Textbaustein:

> **Betreff:** Datenschutzvorfall in ⟨System⟩, Ihr Betrieb ist betroffen
>
> Am ⟨Datum, Uhrzeit⟩ haben wir ⟨Feststellung⟩ festgestellt.
>
> **Art des Vorfalls:** ⟨Beschreibung⟩
> **Kategorien betroffener Personen:** ⟨Gäste / Beschäftigte / Firmenkontakte⟩
> **Kategorien betroffener Daten:** ⟨Stammdaten, Kontaktdaten, Meldedaten …⟩
> **Ungefähre Zahl der Betroffenen:** ⟨Zahl oder Größenordnung⟩
> **Wahrscheinliche Folgen:** ⟨Einschätzung⟩
> **Ergriffene Maßnahmen:** ⟨was gesperrt, was behoben⟩
> **Noch offen:** ⟨was wir noch untersuchen⟩
>
> Ansprechpartner: ⟨Name, Telefon, E-Mail⟩
>
> Die Entscheidung über eine Meldung nach Art. 33 Abs. 1 an Ihre
> Aufsichtsbehörde liegt bei Ihnen als Verantwortlichem. Wir unterstützen
> Sie dabei mit allem, was wir wissen.

**Unvollständig melden ist richtig.** Art. 33 Abs. 4 erlaubt ausdrücklich,
Angaben schrittweise nachzureichen. Zu warten, bis das Bild vollständig ist,
ist der Fehler, der die Frist reißt.

## Schritt 4 — dokumentieren

Jeder Vorfall wird festgehalten, **auch der, den wir nicht melden** — Art. 33
Abs. 5 verlangt die Dokumentation unabhängig von der Meldepflicht, und die
Aufsichtsbehörde prüft genau diese Aufzeichnung.

Festzuhalten: was geschah, was wir feststellten, wann, was wir taten, was wir
entschieden und warum. Ein begründetes „nicht meldepflichtig" ist ein
Ergebnis und gehört aufgeschrieben.

Ablage: ⟨Ort⟩.

## Schritt 5 — Ursache beheben

Erst nach den vorigen Schritten. Eine Behebung, die vor der Beweissicherung
kommt, macht die Untersuchung unmöglich.

Gehört die Ursache in den Code, gehört sie auch in einen Test: ein Vorfall,
den nur ein Mensch verhindert, kommt wieder.
