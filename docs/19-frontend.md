# Die Oberfläche: Maßstab, Stand und Plan

Dieses Dokument misst die Rezeptions-Oberfläche (`apps/web`) an drei Dingen: an dem, was ein PMS im Kern können muss ([`01-marktanalyse-pms.md`](01-marktanalyse-pms.md)), an dem, was der Wettbewerb tatsächlich macht, und an dem, was unsere eigene API bereits hergibt. Die Aufteilung der Arbeit steht daneben in [`20-arbeitsteilung.md`](20-arbeitsteilung.md).

---

## 1. Die Lücke, in Zahlen

**Die API hat 100 Endpunkte. Die Oberfläche ruft 16 davon auf.**

Von den zwölf Kernfunktionen eines PMS aus Dokument 01 sind in der Oberfläche **drei** vollständig bedienbar. Der auffälligste Einzelbefund:

> **Man kann in dieser Oberfläche kein Zimmer buchen.**

`POST /v1/bookings` existiert, ist getestet, hält 50 gleichzeitige Buchungen aus — und hat keine Maske.

---

## 2. Der Maßstab: die zwölf Kernfunktionen

Dokument 01 hat sie über alle untersuchten Systeme hinweg herausgearbeitet. Das ist der ehrliche Prüfstein, nicht eine Liste, die ich mir neu ausdenke.

| # | Kernfunktion | API | Oberfläche |
|---|---|---|---|
| 1 | Reservierungsverwaltung | vollständig | **fehlt** — kein Buchen, kein Ändern, kein Gruppenvorgang |
| 2 | Front Desk, Zimmerplan | vollständig | teilweise — Check-in/-out ja; Zimmerplan **nur lesend** |
| 3 | Gästeprofile, CRM | vollständig | **fehlt** vollständig |
| 4 | Folio und Rechnungswesen | vollständig | **ja** — Positionen, Zahlung, Festschreiben |
| 5 | Zahlungen | Pay-by-Link, Anzahlung | **fehlt** |
| 6 | Housekeeping | vollständig | **ja** |
| 7 | Wartung | vollständig | **fehlt** |
| 8 | Nachtlauf | vollständig | **fehlt** — kein Blick auf Lauf und Ergebnis |
| 9 | Channel Management | ARI in beide Richtungen | **fehlt** — Zugänge und Preispflege beide nicht |
| 10 | Rate Management | vollständig | **fehlt** vollständig |
| 11 | Reporting | vollständig | **fehlt** — keine Kennzahl sichtbar |
| 12 | Schnittstellen (POS, Webhooks, OAuth) | vollständig | **fehlt** |

Drei von zwölf. Und die drei sind nicht die, an denen ein Haus sein Geld verdient.

---

## 3. Die drei Kalender — und wir haben einen davon, halb

Hier liegt der Kern des Missverständnisses, das beim Draufschauen entsteht. Ein PMS hat **drei** Rasteransichten, und sie beantworten drei verschiedene Fragen. Sie werden leicht verwechselt, weil alle drei „Kalender" heißen.

| Ansicht | Achsen | Beantwortet | API | Oberfläche |
|---|---|---|---|---|
| **Zimmerplan** (Tape Chart) | Zimmer × Tag | *Wer liegt in welchem Zimmer?* | `GET .../tape-chart`, 92 Tage | vorhanden, **nur lesend** |
| **Verfügbarkeitsraster** | Zimmergruppe × Tag | *Was kann ich noch verkaufen?* | `GET .../availability`, **731 Tage** | **kein Bildschirm** |
| **Preisraster** | Ratenplan × Tag | *Was kostet es, und darf man anreisen?* | `GET .../rate-grid`, **400 Tage** | **kein Bildschirm** |

Der Zimmerplan ist das, was heute da ist — und er ist ein Bild. Er kann nicht einmal das, wofür seine eigene Komponente schon einen Anschluss hat: `TapeChart` nimmt ein `onSelect` entgegen, und `Tape.tsx` übergibt es nicht. Man kann also nicht einmal eine Reservierung anklicken.

**Das ist genau der Unterschied zum Wettbewerb.** SIHOT beschreibt den Belegungsplan als „ein zentrales Element im Front-Office-Bereich, **von dem aus viele Funktionen direkt abgerufen** werden können". Mews nennt es eine „live, interactive timeline" mit „drag-and-drop bookings: move, extend or split stays and fix gaps instantly". Bei beiden ist der Plan die **Arbeitsfläche**, nicht die Übersicht.

Die beiden anderen Raster fehlen ganz — und das sind die, an denen ein Haus Geld verdient oder verliert. Das Verfügbarkeitsraster ist der Bildschirm, den man ansieht, bevor man ein Kontingent zusagt. Das Preisraster ist der, an dem ein Jahr Preise entsteht, das an den Channel Manager geht.

**Die API kann beides schon**, und zwar in der Spanne, die dafür nötig ist: 731 Tage Verfügbarkeit, 400 Tage Preise und Restriktionen in **einer** Anfrage. Ein ganzes Jahr Preispflege ist keine Backend-Aufgabe mehr, sondern eine Oberflächenaufgabe.

---

## 4. Was heute steht

| Bildschirm | Datei | Kann | Kann nicht |
|---|---|---|---|
| Zimmerplan | `routes/Tape.tsx` | Belegung über 14–60 Tage ansehen | anklicken, verschieben, verlängern, buchen |
| Tagesgeschäft | `routes/Today.tsx` | Anreisen, Abreisen, Hausliste; Check-in, Check-out; Folio öffnen | Zimmer zuweisen, Meldeschein |
| Housekeeping | `routes/Housekeeping.tsx` | Zimmerstatus sehen und setzen | Aufgaben verteilen |
| Gruppen | `routes/Blocks.tsx` | Kontingent anlegen, Abrufstand, Rest freigeben | daraus abrufen (buchen) |
| Einrichtung | `routes/Setup.tsx` | Zimmergruppe anlegen, Zimmer in Serie | **ändern, stilllegen** — obwohl `PATCH /v1/categories/:id` und `PATCH /v1/rooms/:id` existieren |
| Gastkonto | `routes/Folio.tsx` | Positionen, Zahlung, Rechnung festschreiben | Rechnung ansehen, verschicken |
| Anmeldung | `routes/Login.tsx` | anmelden | — |

Rund 2 400 Zeilen.

### Die Stammdaten sind dünner, als sie aussehen

Eine Zimmergruppe lässt sich anlegen mit **drei** Feldern: Code, Name, maximale Belegung. Das Datenmodell hat mehr, und jedes weitere Feld hat einen Zweck:

| Feld | Wofür | in der Maske |
|---|---|---|
| `description` | Text für Channel Manager und Buchungsstrecke | nein |
| `sort_order` | Reihenfolge im Zimmerplan und in Listen | nein |
| `overbooking_limit` | bewusste Überbuchung je Gruppe | nein |
| `time_unit` | Nacht, Stunde, Tag, Monat (Entscheidung 8) | nein |
| `active` | Gruppe stilllegen, ohne sie zu löschen | nein |

Beim Zimmer dasselbe: `floor` und `attributes` (Balkon, barrierefrei, Raucher) sind im Modell, in der Serie aber nicht pflegbar — und genau daran hängt später die Zimmerzuweisung („Gast wünscht barrierefrei").

---

## 5. Was der Wettbewerb macht, und was wir davon übernehmen

### Mews

| Was sie machen | Übernehmen? |
|---|---|
| **Drag-and-drop auf der Timeline**: verschieben, verlängern, Aufenthalt teilen, Lücken schließen | **Ja.** Das ist die Kernbedienung einer Rezeption. Bei uns hängt es an `change-stay` und `assign-unit`, beide vorhanden |
| **Sichtbare Warnung bei Überbuchung und Lücken** | **Ja.** Wir haben `overbooking_limit` je Gruppe und kennen die Lücken; angezeigt wird nichts |
| **Block-Vorlagen, automatische Freigabe, Pick-up-Verfolgung** | **Haben wir schon** — `availability_block` mit `release_date` und `picked_up`, inklusive Nachtlauf-Freigabe. Nur der Abruf fehlt in der Maske |
| **Bulk Rate Editing** über Häuser und Portfolios | **Ja, je Haus.** `POST /v1/rates/bulk` und `restrictions/bulk` sind da. Über mehrere Häuser hinweg: später |
| **Rate inheritance** — einmal ändern, kaskadiert | **Haben wir** als abgeleitete Raten, `rebuild-derived`. Ohne Maske unbenutzbar |
| **Attribute-based pricing** (Alter, Wochentag, Produkt) | **Teilweise.** Alter haben wir bei der Kurtaxe. Der Rest ist ein eigener Schnitt und kein MVP |
| **Generalisierte „Resources"** statt nur Zimmer (Parkplatz, Meetingraum, stundenweise) | **Nein, aber vorbereitet.** `time_unit` steht im Modell; die Oberfläche bleibt beim Zimmer, bis ein Kunde mehr braucht |

### Apaleo

Reines API-first ohne eigene Oberflächentiefe, ARI-Push an den Channel Manager als Delta, sobald sich etwas ändert.

**Übernehmen:** die Haltung, dass die API die Wahrheit ist und die Oberfläche nur ein Client — das ist bei uns schon so. **Nicht übernehmen:** das Weglassen der Oberfläche. Apaleos Zielgruppe baut ihr Frontend selbst; ein deutsches Haus mit 40 Zimmern tut das nicht.

Der ARI-Weg ist bei uns bewusst anders herum gebaut: der Channel Manager **holt** (`GET /v1/channel/ari/*`, voll oder als Änderung seit einem Zeitpunkt), statt dass wir pushen. Das ist für den Anfang robuster — ein Empfänger, der gerade nicht erreichbar ist, verliert nichts. Ein Push-Weg wäre ein Aufsatz darauf, kein Umbau.

### SIHOT

Der Belegungsplan als zentrales Bedienelement, von dem aus die Funktionen erreichbar sind. **Übernehmen, unverändert** — es ist die Arbeitsweise, die deutsche Rezeptionen kennen.

### Cloudbeds

All-in-One inklusive Channel Manager und Buchungsstrecke. **Nicht übernehmen.** Wir sind das PMS und binden Channel Manager an; eine eigene Buchungsstrecke ist ein zweites Produkt.

### Was wir bewusst besser machen

Drei Dinge, bei denen die deutschen Pflichten ein Vorteil und kein Ballast sind — und die in einer internationalen Oberfläche typischerweise nachgerüstet aussehen:

- **Der Meldeschein gehört in den Check-in**, nicht in ein Zusatzmodul. Und er weiß, dass seit dem 1.1.2025 nur ausländische Gäste unterschreiben.
- **Die Unveränderlichkeit ist sichtbar**, nicht nur wirksam: kein Löschknopf am Folio, fakturierte Positionen erkennbar.
- **Das Übungshaus ist durchgehend gekennzeichnet**, und aus ihm geht nichts nach draußen — kein Export, keine Gastpost.

---

## 6. Grundsätze

Aus dem Betrieb abgeleitet, nicht aus Geschmack. Wer einen bricht, sollte sagen können, warum.

**Ein Aufruf je Bildschirm.** Die Endpunkte sind Aggregate — das Preisraster liefert 400 Tage in einer Anfrage. Wer das im Frontend auflöst und je Zeile nachlädt, macht aus einer Runde vierhundert.

**Der Plan ist die Arbeitsfläche, nicht das Bild.** Was man auf einem Raster sieht, muss man dort auch tun können.

**Kalenderdaten bleiben Zeichenketten.** Nie `new Date(iso)` zum Rechnen. Das ist schon einmal schiefgegangen: drei fehlende `::text` machten aus Kalendertagen Zeitstempel, die Oberfläche rechnete `NaN`, und jeder Balken lag am linken Rand — sichtbar, gefärbt, am falschen Tag.

**Kein Text im Code, nur Schlüssel**, je Bereich in `lib/i18n/`. Die Sprache der Oberfläche ist die des Personals, die der Gastpost steht am Gastprofil.

**Die Berechtigung steht am Bildschirm** (`screens.tsx`). Keine Sicherheitsmaßnahme — die liegt in der API — sondern Brauchbarkeit: ein Knopf, der 403 antwortet, ist schlechter als kein Knopf.

**Zustand steht in der Adresse.** Lesezeichen, Weitergabe, Neuladen am geteilten Rechner.

**Offline sichtbar machen, nicht verschweigen.** Lesen ja, schreiben nein. Eine Buchung, die im Browser wartet, bindet Kontingent, das inzwischen verkauft ist.

**Unveränderlichkeit zeigen.** Die Oberfläche bildet die Regeln ab, statt den Benutzer auflaufen zu lassen.

**Die Tastatur ist das Eingabegerät.** Was drei Klicks braucht, wird an einer Rezeption nicht benutzt.

---

## 7. Was gebaut werden muss

Nach Nutzen geordnet, nicht nach Bequemlichkeit.

### Stufe 1 — ohne das ist es kein PMS

1. **Verfügbarkeitsraster** (Gruppe × Tag). Der Bildschirm, auf den man sieht, bevor man zusagt.
2. **Buchungsmaske**, erreichbar aus Raster und Zimmerplan.
3. **Gastsuche und -profil.** Jede Buchung braucht einen Gast.
4. **Zimmerplan als Arbeitsfläche**: anklicken, zuweisen, verschieben, verlängern.
5. **Check-in mit Meldeschein.**
6. **Preisraster** mit Massenänderung und Vorschau — ein Jahr am Stück.

### Stufe 2 — ohne das verkauft man schlecht

7. **Restriktionen** im selben Raster.
8. **Ratenpläne und abgeleitete Raten.**
9. **Stammdaten vollständig**: ändern, stilllegen, alle Felder.
10. **Channel-Zugänge**: anlegen, sperren, sehen was geholt wurde.

### Stufe 3 — ohne das führt man das Haus blind

11. **Kennzahlen** (Belegung, ADR, RevPAR) und **Nachtlauf-Stand**.
12. **Rechnungsliste, -ansicht, -versand.**
13. **Wartungsmeldungen.**
14. **Exporte und Statistik.**

### Stufe 4 — Einrichtung, einmal je Haus

15. Zahlungsarten, Gastpost-Absender, Webhooks, Maschinenzugänge, Benutzer und Rollen.

**Stufe 1 ist die Schwelle zur Vorführbarkeit.** Punkte 1 bis 5 sind ein zusammenhängender Vorgang und gehören in eine Hand.

---

## 8. Technische Festlegungen

**React 19, Vite, TanStack Query, Tailwind.** Kein Router-Paket: Haus und Bildschirm stehen in der Adresse (`lib/adresse.ts`, `history.pushState`). Der Plan nannte einen Router; für sieben bis fünfzehn Bildschirme ist die Abhängigkeit nicht gerechtfertigt. Werden verschachtelte Routen nötig — etwa eine Reservierung als eigene Adresse unter dem Zimmerplan —, ist das die Stelle, an der man neu abwägt.

**Kein Formular- und kein Komponentenpaket.** Die Masken sind klein genug für Reacts eigenen Zustand; ein Baukasten bringt Gestaltung mit, die zu einer Rezeptionssoftware nicht passt.

**Die Raster brauchen Virtualisierung, sobald sie groß werden.** 400 Tage × 10 Ratenpläne sind 4 000 Zellen; 731 Tage × 20 Gruppen sind 14 620. Das ist die einzige Stelle, an der eine Abhängigkeit absehbar gerechtfertigt ist — erst messen, dann holen.

**Getestet wird Verhalten, nicht Darstellung.** Geprüft wird, wo ein Fehler Geld oder Zimmer kostet: Datumsrechnung, Geldanzeige, Rechteauswertung, Umrechnung von Formulardaten in Nutzlast.

---

## 9. Der Umbau, der dieser Arbeit vorausging

Damit mehrere gleichzeitig arbeiten können, sind drei Stellen entschärft — im Frontend das, was die Migrationsnummer im Schema ist.

**Das Verzeichnis der Bildschirme** (`screens.tsx`): vorher stand die Liste an drei Stellen, jetzt ist ein Bildschirm eine Zeile. **Die Texte je Bereich** (`lib/i18n/`): vorher eine Datei mit 292 Zeilen. **Haus und Bildschirm in der Adresse** (`lib/adresse.ts`): vorher `useState`, also nicht teilbar und beim Neuladen weg.

Dazu zwei Dinge, die die API seit jeher liefert und die Oberfläche ignoriert hat: **Rechte je Haus** (die Navigation zeigt nur Benutzbares) und die **Kennzeichnung des Übungshauses** (Dokument 13, C11 — verlangt, nie angezeigt).

---

## Quellen

- [Mews — Reservation Management](https://www.mews.com/en-gb/products/reservation-management)
- [Mews — Rate Management](https://www.mews.com/en/products/hotel-rate-management)
- [Apaleo — ARI-Daten für Channel Manager](https://apaleo.dev/guides/business-cases/channel-integration/ari-data.html)
- [Apaleo — Open APIs](https://apaleo.com/open-apis)
- [SIHOT — PMS-Vergleich, Belegungsplan als zentrales Element](https://sihot.com/de/blog/hotel-pms-vergleich/)
- [3RPMS Hotelsoftware](https://3rpms-hotelsoftware.de/)
- Eigene Vorarbeit: [`01-marktanalyse-pms.md`](01-marktanalyse-pms.md), [`03-marktfuehrer-deutschland.md`](03-marktfuehrer-deutschland.md)
