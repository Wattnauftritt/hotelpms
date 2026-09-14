# Die Oberfläche: Stand, Entwurf und was fehlt

Dieses Dokument beschreibt die Rezeptions-Oberfläche (`apps/web`): woraus sie besteht, nach welchen Grundsätzen sie gebaut ist und welche Lücke zwischen ihr und der API klafft. Die Aufteilung der Arbeit auf mehrere Bearbeiter steht daneben in [`20-arbeitsteilung.md`](20-arbeitsteilung.md).

---

## 1. Die Lücke, in einer Zahl

**Die API hat 100 Endpunkte. Die Oberfläche ruft 16 davon auf.**

Das Backend ist fertig, die Oberfläche ist ein Anfang. Was fehlt, ist nicht Politur, sondern Substanz — der auffälligste Punkt:

> **Man kann in dieser Oberfläche kein Zimmer buchen.**

`POST /v1/bookings` existiert, ist getestet, hält 50 gleichzeitige Buchungen aus — und hat keine Maske. Dasselbe gilt für Gastsuche, Preispflege, Rechnungsansicht, Kennzahlen und sämtliche Einstellungen jenseits von Zimmern und Zimmergruppen.

---

## 2. Was heute steht

| Bildschirm | Datei | Ruft auf | Kann |
|---|---|---|---|
| Zimmerplan | `routes/Tape.tsx`, `components/TapeChart.tsx` | `tape-chart` | Belegung über Zeit sehen, Balken anklicken |
| Tagesgeschäft | `routes/Today.tsx` | `daily-sheet`, Reservierungsaktionen | Anreisen, Abreisen, Hausliste; Check-in und Check-out; Folio öffnen |
| Housekeeping | `routes/Housekeeping.tsx` | `housekeeping`, `housekeeping/status` | Zimmerstatus sehen und setzen |
| Gruppen | `routes/Blocks.tsx` | `blocks`, `blocks/release` | Kontingente anlegen, Abrufstand sehen, Rest freigeben |
| Einrichtung | `routes/Setup.tsx` | `categories`, `rooms`, `rooms/series`, `setup-status` | Zimmergruppen und Zimmer anlegen, auch als Serie |
| Gastkonto | `routes/Folio.tsx` | `folios`, `charges`, `settlements`, `invoice` | Positionen sehen, buchen, Zahlung vermerken, Rechnung festschreiben |
| Anmeldung | `routes/Login.tsx` | `auth/login` | Anmelden |

Dazu die Infrastruktur: `lib/api.ts` (Fehlerformat, Idempotenzschlüssel), `lib/queries.ts` (TanStack Query mit Offline-Zwischenspeicher), `lib/i18n/` (Deutsch und Englisch), `lib/dates.ts` (Kalenderrechnung ohne Zeitzonenfallen), `lib/offline.ts`, `components/Shell.tsx` (Rahmen, Navigation, Hinweise), `screens.tsx` (Verzeichnis der Bildschirme).

Rund 2 400 Zeilen.

---

## 3. Grundsätze

Sie sind aus dem Betrieb abgeleitet, nicht aus Geschmack. Wer einen davon bricht, sollte sagen können, warum.

### 3.1 Ein Aufruf je Bildschirm

Die Endpunkte sind Aggregate. Der Zimmerplan kommt in **einer** Anfrage, mitsamt Zimmern, Reservierungen und Sperrungen. Wer das im Frontend auflöst und je Zeile nachlädt, macht aus einer Runde vierhundert — auf einem Rezeptionsrechner mit schwachem WLAN ist das der Unterschied zwischen sofort und unbenutzbar.

Praktisch: eine neue Ansicht braucht in der Regel einen neuen **Aggregat-Endpunkt**, keine Schleife über bestehende.

### 3.2 Kalenderdaten bleiben Zeichenketten

`2026-10-01` ist ein Tag, kein Zeitpunkt. Nie `new Date(iso)` zum Rechnen: in Europa/Berlin ist Mitternacht UTC am Umstellungstag der Vortag, und eine Reservierung verschiebt sich lautlos.

Gerechnet wird in `lib/dates.ts` auf Zeichenketten. Angezeigt wird über `formatDate`. **Das ist schon einmal schiefgegangen**, und zwar nicht in der Oberfläche, sondern in der Abfrage: drei fehlende `::text` machten aus Kalendertagen Zeitstempel, die Oberfläche rechnete `NaN`, React verwarf `left` und `width` stillschweigend, und jeder Balken lag am linken Rand. Sichtbar, gefärbt, beschriftet — und am falschen Tag.

### 3.3 Kein Text im Code, nur Schlüssel

Von Anfang an zweisprachig. Nachträglich zu übersetzen heißt, jede Zeichenkette einzeln herauszuziehen, und dabei wird die Hälfte vergessen.

Die Texte liegen **je Bereich** in `lib/i18n/`, nicht in einer Datei. Der Grund ist Arbeitsteilung: an einer einzigen Textdatei arbeiten drei Bearbeiter zwangsläufig an derselben Stelle.

Die Sprache der **Oberfläche** ist die des Personals; die Sprache der **Gastpost** steht am Gastprofil. Das ist nicht dasselbe: ein deutsches Haus schreibt einem niederländischen Gast auf Englisch und bedient die Oberfläche auf Deutsch.

### 3.4 Die Berechtigung steht am Bildschirm

`screens.tsx` führt zu jedem Bildschirm das Recht, das ihn sichtbar macht. Wer es nicht hat, sieht den Eintrag nicht.

Das ist **keine** Sicherheitsmaßnahme — die liegt in der API und nirgends sonst. Es ist eine Frage der Brauchbarkeit: ein Knopf, der mit 403 antwortet, ist schlechter als kein Knopf.

### 3.5 Zustand steht in der Adresse

Haus und Bildschirm stehen in der URL (`?property=1&screen=today`). Drei Gründe, alle täglich an einer Rezeption: ein Lesezeichen soll dahin führen, wo es gesetzt wurde; ein Link an die Kollegin soll bei ihr dasselbe zeigen; ein versehentliches Neuladen — an einem geteilten Rechner der Normalfall — soll nicht auf dem Startbild enden.

Die Schlüssel in `screens.tsx` sind deshalb **stabil**. Ein Test hält sie fest.

### 3.6 Offline sichtbar machen, nicht verschweigen

Betriebslisten liegen zusätzlich lokal (`lib/offline.ts`). Fällt das Netz aus, zeigt die Oberfläche den letzten Stand **und sagt es**. Ein Betrieb, der nicht merkt, dass er einen alten Stand ansieht, bucht doppelt.

Geschrieben wird offline nicht. Eine Schreiboperation, die scheinbar gelingt und später verschwindet, ist schlimmer als eine, die ehrlich scheitert.

### 3.7 Unveränderlichkeit auch zeigen

Das Gastkonto hat **keinen Löschknopf**. Positionen sind Härtegrad 1; eine Korrektur ist eine Gegenbuchung und steht sichtbar darunter. Fakturierte Positionen sind als solche erkennbar, statt eine Änderung erst beim Versuch mit einer Fehlermeldung zu beantworten.

Derselbe Gedanke gilt überall: **die Oberfläche bildet die Regeln ab, statt sie zu verstecken und den Benutzer auflaufen zu lassen.**

### 3.8 Die Tastatur ist das Eingabegerät

An einer Rezeption steht jemand neben dem Bildschirm und tippt, während er redet. Was mit der Maus drei Klicks braucht, wird nicht benutzt. Für jede neue Maske gilt: Tabulatorreihenfolge stimmt, Enter schickt ab, Escape schließt.

---

## 4. Was fehlt, nach Bereichen

Grundlage ist die vollständige Routenliste. Was heute keinen Bildschirm hat:

### 4.1 Buchen und Gast — die größte Lücke

| Fehlt | Endpunkte |
|---|---|
| Verfügbarkeitssuche | `GET .../availability`, `GET .../rate-grid` |
| Buchungsmaske | `POST /v1/bookings` |
| Gastsuche und -profil | `GET/POST /v1/guests`, `PATCH`, `GET /v1/guests/:ref` |
| Firmen | `GET/POST /v1/companies` |
| Aufenthalt ändern | `POST .../change-stay`, `assign-unit` |
| Meldeschein | `GET .../registration-form`, `POST /v1/registrations`, `.../sign` |
| Storno zurücknehmen | `POST .../reinstate` |
| Bestätigung schicken | `POST .../send-confirmation` |

**Der Meldeschein verdient besondere Sorgfalt.** Seit dem 1.1.2025 unterschreiben nur noch ausländische Gäste. Die Maske muss das abbilden, nicht der Benutzer: bei einem inländischen Gast darf gar kein Unterschriftsfeld erscheinen. Und es gibt **keinen Upload für eine Ausweiskopie** — § 30 BMG erlaubt die Nummer und verbietet die Kopie.

### 4.2 Preise und Verfügbarkeit

| Fehlt | Endpunkte |
|---|---|
| Preisraster | `GET .../rate-grid` |
| Ratenpläne | `GET/POST .../rate-plans`, `POST /v1/rates/rebuild-derived` |
| Preise in Masse | `POST /v1/rates/bulk` |
| Restriktionen | `POST /v1/restrictions/bulk` |

Das Preisraster ist der Bildschirm, an dem ein Revenue Manager arbeitet: Tage waagerecht, Ratenpläne senkrecht, Massenänderung über einen markierten Bereich. **Mit Vorschau vor dem Übernehmen** — wer 365 Tage auf einmal ändert, will vorher sehen, was passiert.

### 4.3 Rechnung und Geld

| Fehlt | Endpunkte |
|---|---|
| Rechnungsliste und -ansicht | `GET /v1/invoices/:ref/pdf` |
| Rechnung verschicken | `POST /v1/invoices/:ref/send`, `GET .../outbound-emails` |
| Anzahlung | `POST .../deposit-invoice` |
| Pay-by-Link | `POST /v1/folios/:ref/payment-links` |
| Gutschrift | `POST .../credit-note` |

### 4.4 Berichte und Haus

| Fehlt | Endpunkte |
|---|---|
| Kennzahlen | `GET .../kpi` |
| Beherbergungsstatistik | `GET .../accommodation-statistics` |
| Exporte | `GET .../exports/datev`, `.../gobd`, `.../tenant` |
| Wartungsmeldungen | `GET .../maintenance-tickets`, `POST /v1/maintenance-tickets` |
| Nachtlauf-Stand | (Teil der Kennzahlen) |

Bei den Exporten gilt: **ein Übungshaus exportiert nicht.** Die API weist es hart ab; die Oberfläche soll den Knopf gar nicht erst anbieten.

### 4.5 Einstellungen und Schnittstellen

| Fehlt | Endpunkte |
|---|---|
| Absenderangaben für Gastpost | `GET/PUT .../email-settings` |
| Zahlungsarten | `GET .../payment-methods` |
| Webhooks | `GET/POST/DELETE /v1/webhook-subscriptions`, `.../deliveries` |
| Maschinenzugänge | `GET/POST /v1/oauth-clients` |
| Channel Manager | `GET/POST .../channel-connections` |
| Import | `POST /v1/imports/...` (8 Endpunkte) |

---

## 5. Technische Festlegungen

**React 19 mit Vite, TanStack Query, Tailwind.** Kein Router-Paket: Haus und Bildschirm stehen in der Adresse, gelesen und gesetzt über `lib/adresse.ts` mit `history.pushState`. Für sieben bis fünfzehn Bildschirme ist eine Abhängigkeit dafür nicht gerechtfertigt; wenn verschachtelte Routen nötig werden, ist das die Stelle, an der man es neu abwägt.

**Kein Formularpaket.** Die Masken sind klein genug für den Zustand, den React selbst mitbringt.

**Kein Komponentenbaukasten.** Tailwind und eigene Bausteine in `components/`. Ein Baukasten bringt Gestaltung mit, die zu einer Rezeptionssoftware nicht passt, und eine Abhängigkeit, die bei jedem React-Sprung nachziehen muss.

**Getestet wird Verhalten, nicht Darstellung.** Ein Test, der prüft, dass ein Kasten blau ist, bricht bei jeder Gestaltungsänderung und fängt nie einen Fehler. Geprüft wird, wo ein Fehler echtes Geld oder echte Zimmer kostet: Datumsrechnung, Geldanzeige, Rechteauswertung.

---

## 6. Der Umbau, der dieser Arbeit vorausging

Damit mehrere gleichzeitig daran arbeiten können, ohne sich zu behindern, wurden drei Stellen entschärft. Sie waren im Frontend das, was die Migrationsnummer im Schema ist: die eine Stelle, an der man sich zuverlässig in die Quere kommt.

**Das Verzeichnis der Bildschirme** (`screens.tsx`). Vorher stand die Liste an drei Stellen: als Aufzählungstyp in der Shell, als Navigationsleiste daneben, als Kette von `screen === '…' && <X />` in `main.tsx`. Einen Bildschirm hinzuzufügen hieß, alle drei zu ändern. Jetzt ist es **eine** Zeile, und die Zeilen liegen untereinander.

**Die Texte je Bereich** (`lib/i18n/`). Vorher eine Datei mit 292 Zeilen, in der drei Bearbeiter gleichzeitig schreiben. Jetzt eine Datei je Bereich und eine Zeile im Index.

**Haus und Bildschirm in der Adresse** (`lib/adresse.ts`). Vorher lag der Bildschirm in `useState` — nicht teilbar, nicht als Lesezeichen zu setzen, beim Neuladen weg.

Nebenbei zwei Dinge, die die API seit jeher liefert und die Oberfläche ignoriert hat:

- **Rechte je Haus.** `GET /v1/auth/me` liefert sie; die Navigation zeigt jetzt nur, was benutzbar ist.
- **Die Kennzeichnung des Übungshauses.** Dokument 13 verlangt sie ausdrücklich (C11) — *„wer nicht sieht, dass er übt, übt irgendwann versehentlich am echten Haus"* —, `isTraining` kam mit, angezeigt wurde es nie. Jetzt steht es als durchgehender Balken oben.

---

## 7. Die Reihenfolge, in der gebaut werden sollte

Nicht alphabetisch, sondern nach Nutzen für den Betrieb.

1. **Buchungsmaske mit Verfügbarkeitssuche.** Ohne sie ist das Produkt nicht vorführbar.
2. **Gastsuche und -profil.** Jede Buchung braucht einen Gast.
3. **Check-in mit Meldeschein.** Der Vorgang, den die Rezeption am häufigsten durchführt.
4. **Preisraster.** Ohne Preispflege verkauft ein Haus zu falschen Preisen.
5. **Rechnungsliste und Versand.** Der Abschluss des Aufenthalts.
6. **Kennzahlen.** Was die Hausleitung täglich ansieht.
7. **Einstellungen und Schnittstellen.** Einmal pro Haus, nicht täglich.

Punkt 1 bis 3 sind ein zusammenhängender Vorgang und gehören in **eine** Hand.
