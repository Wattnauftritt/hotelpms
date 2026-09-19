# Schwellenwertprüfung zur Datenschutz-Folgenabschätzung

nach **Art. 35 Abs. 1 DSGVO**.

> Eine DSFA ist nicht automatisch fällig. Ob sie es ist, muss aber geprüft
> **und die Prüfung dokumentiert** werden — auch ein begründetes „nicht
> erforderlich" ist ein Ergebnis, und die Aufsichtsbehörde fragt danach.
>
> Diese Prüfung betrifft das System. Der einzelne Betrieb als
> Verantwortlicher muss sie für seine Verarbeitung selbst anstellen; dieses
> Dokument gibt ihm die technischen Angaben dafür.

---

## 1. Greift die Muss-Liste nach Art. 35 Abs. 3?

| Tatbestand | Trifft zu? | Begründung |
|---|---|---|
| lit. a — systematische umfassende Bewertung persönlicher Aspekte, automatisierte Entscheidung | **nein** | Es gibt kein Profiling und keine automatisierte Einzelfallentscheidung. Preise hängen an Datum und Ratenplan, nicht an der Person. |
| lit. b — umfangreiche Verarbeitung besonderer Kategorien nach Art. 9 | **nein**, mit Vorbehalt | Es gibt kein Feld dafür. Zwei Freitextfelder können sie faktisch aufnehmen; siehe Abschnitt 3. |
| lit. c — systematische umfangreiche Überwachung öffentlich zugänglicher Bereiche | **nein** | Keine Videoüberwachung, keine Ortung, keine Anwesenheitserfassung. |

**Keiner der drei Tatbestände greift zwingend.**

## 2. Die Liste der Aufsichtsbehörde

⟨Die Positivliste der zuständigen Landesbehörde ist gegen diese Verarbeitung
zu prüfen und das Ergebnis hier einzutragen. Mehrere Länder führen
„Verarbeitung von Daten zu Meldezwecken" oder „umfangreiche Verarbeitung von
Ausweisdaten"; beides ist hier einschlägig genug, um es nicht zu
überspringen.⟩

## 3. Kriterien der Art.-29-Gruppe (WP 248)

Zwei oder mehr erfüllte Kriterien sprechen für eine DSFA.

| Kriterium | Erfüllt | Anmerkung |
|---|---|---|
| Bewertung oder Scoring | nein | |
| Automatisierte Entscheidung mit Rechtswirkung | nein | |
| Systematische Überwachung | nein | |
| **Besondere Kategorien oder höchst persönliche Daten** | **teilweise** | Ausweisnummer nach § 30 BMG; Unterschrift; Freitextfelder, in denen faktisch Gesundheitliches landet |
| **Umfangreiche Verarbeitung** | **ja** | viele Betriebe, alle Gäste, dauerhaft |
| Abgleich oder Zusammenführung von Datensätzen | nein | |
| **Daten schutzbedürftiger Personen** | **teilweise** | mitreisende Kinder sind als Mitreisende erfasst |
| Innovative Nutzung neuer Technologien | nein | |
| Verhinderung von Rechtsausübung oder Vertragszugang | nein | |

**Drei Kriterien ganz oder teilweise erfüllt.**

## 4. Ergebnis

> **Eine DSFA ist durchzuführen.** Nicht weil ein Muss-Tatbestand greift,
> sondern weil drei Kriterien der WP 248 zutreffen und die Schwelle dort bei
> zwei liegt. Der Ausschlag gibt die Verbindung aus **Ausweismerkmalen**,
> **umfangreicher Verarbeitung** und **Freitextfeldern, die faktisch
> Gesundheitsdaten aufnehmen**.

Eine DSFA ist keine Strafe. Sie ist die Gelegenheit, aufzuschreiben, was
ohnehin gilt — und der größte Teil davon steht bereits in
[`tom.md`](tom.md) und [`../24-dsgvo-audit.md`](../24-dsgvo-audit.md).

## 5. Was in die DSFA gehört

1. **Beschreibung der Verarbeitung** → aus
   [`verarbeitungsverzeichnis.md`](verarbeitungsverzeichnis.md)
2. **Notwendigkeit und Verhältnismäßigkeit** → jede Datenkategorie gegen
   ihren Zweck. Die kurze Fassung: das System erhebt, was der
   Beherbergungsvertrag und das Meldegesetz verlangen, und drei Dinge
   bewusst nicht — Kartendaten, Ausweiskopien und eine Kassenfunktion.
3. **Risiken für die Betroffenen** → mindestens: Offenlegung von
   Aufenthaltsdaten (wer war wann wo), Offenlegung von Ausweismerkmalen,
   unbefugter Zugriff über einen Support-Zugang, Gastpost an den falschen
   Empfänger.
4. **Abhilfemaßnahmen** → aus [`tom.md`](tom.md)
5. **Restrisiko und Bewertung** → ⟨vom Betreiber⟩
6. ⟨Standpunkt der betroffenen Personen, soweit eingeholt — Art. 35 Abs. 9⟩

## 6. Wann diese Prüfung zu wiederholen ist

Bei jeder Änderung, die eine neue Datenkategorie einführt, einen neuen
Empfänger hinzufügt oder eine automatisierte Entscheidung einführt. Die
Prüfung ist nicht einmalig: sie gilt für die Verarbeitung, die tatsächlich
stattfindet, und die ändert sich mit dem System.
