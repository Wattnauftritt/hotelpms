# Arbeitsteilung Oberfläche: drei Spuren

Dieses Dokument teilt die offene Frontend-Arbeit aus [`19-frontend.md`](19-frontend.md) auf **drei Bearbeiter** auf, die gleichzeitig arbeiten, ohne aufeinander zu warten oder sich gegenseitig zu überschreiben.

Es ist gleichzeitig die **Fortschrittstafel**: Abschnitt 5 wird von jedem in seinem eigenen Pull Request fortgeschrieben.

---

## 1. Was vorab gilt

**Lies zuerst** [`18-einarbeitung.md`](18-einarbeitung.md), dann [`../CLAUDE.md`](../CLAUDE.md), dann [`19-frontend.md`](19-frontend.md). In dieser Reihenfolge. Das kostet eine halbe Stunde und spart einen Tag.

**Zweig und Pull Request.** Ein Zweig je Spur, abgezweigt von `main`, ein Pull Request gegen `main`. Der Zweig heißt `frontend/spur-a`, `frontend/spur-b`, `frontend/spur-c`.

**Vor jedem Push:**

```bash
./scripts/check-migrations.sh && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Alle fünf grün. Ohne Ausnahme.

**Kleine Pull Requests.** Lieber drei Stück je Spur als einen großen am Ende. `main` bewegt sich schnell; wer zwei Tage sammelt, merged zwei Tage.

**Wer `main` einmergt, tut das per Merge-Commit**, nicht per Rebase. Der Zweig kann bei einem anderen ausgecheckt sein.

---

## 2. Wo ihr euch in die Quere kommen könnt — und wo nicht

Die Spuren sind so geschnitten, dass jede in **eigenen Dateien** arbeitet. Es bleiben vier gemeinsame Berührungspunkte, und für jeden gibt es eine Regel.

| Gemeinsame Datei | Regel |
|---|---|
| `apps/web/src/screens.tsx` | **Anhängen, nie einfügen.** Jeder Eintrag ist eine Zeile am Ende der Liste. Zwei angehängte Zeilen erzeugen keinen Konflikt, den jemand von Hand auflösen muss |
| `apps/web/src/lib/i18n/index.ts` | **Ein Import und eine Zeile je Bereich**, beide am Ende ihres Blocks. Die Texte selbst liegen in **deiner eigenen** Datei unter `lib/i18n/` |
| `apps/web/src/lib/queries.ts` | **Nicht anfassen.** Neue Abfragen kommen in `lib/queries/<bereich>.ts`. Bestehende bleiben, wo sie sind |
| `packages/contracts/src/schemas.ts` | Nur ergänzen, nie bestehende Typen ändern. Wer einen ändern **muss**, sagt es vorher den anderen beiden |

**Ändert keine bestehenden Bildschirme der anderen Spuren.** Wenn du in `Today.tsx` etwas brauchst, das dort nicht ist, schreib es in Abschnitt 6 („Was zwischen den Spuren hängt") statt es zu ändern.

**Braucht ihr einen neuen Endpunkt?** Das kommt vor und ist kein Fehler — Abschnitt 3.1 nennt zwei Stellen, an denen es absehbar ist. Regel: **eine neue Migrationsnummer ist die einzige Stelle, an der ihr euch im Backend zuverlässig blockiert.** `scripts/check-migrations.sh` fängt eine Kollision ab; wer die Meldung sieht, benennt die spätere Datei um.

---

## 3. Die drei Spuren

### Spur A — Buchen, Gast, Anreise

**Der zusammenhängendste und wichtigste Teil.** Ohne ihn kann man in dieser Oberfläche kein Zimmer buchen, und das Produkt ist nicht vorführbar.

Diese Spur ist **erkennbar größer als B und C**, und das ist Absicht: A0 bis A6 sind ein einziger Vorgang — sehen, was frei ist, buchen, den Gast anlegen, anreisen lassen. Auf zwei Bearbeiter verteilt entstehen zwei halbe Masken, die nicht ineinandergreifen. Wer Luft hat, nimmt sich A9 und A10 zuletzt vor; sie hängen am selben Zimmerplan, sind aber vom Buchungsvorgang trennbar.

**Eigene Dateien:** `routes/Booking.tsx`, `routes/Guests.tsx`, `routes/CheckIn.tsx`, `routes/Availability.tsx`, `components/AvailabilityGrid.tsx`, `components/GuestPicker.tsx`, `lib/queries/booking.ts`, `lib/queries/guests.ts`, `lib/i18n/buchen.ts`, `lib/i18n/gaeste.ts`

**Ausnahme von der Regel „keine fremden Bildschirme":** A9 und A10 ändern `routes/Tape.tsx` und `components/TapeChart.tsx`. Die gehören für die Dauer dieser Spur **dir**; B und C fassen sie nicht an.

| # | Aufgabe | Fertig, wenn |
|---|---|---|
| A0 | **Verfügbarkeitsraster.** Zimmergruppe senkrecht, Tage waagerecht, freie Einheiten je Zelle. `GET .../availability` liefert bis **731 Tage** in einer Anfrage | Ein Blick beantwortet „was kann ich noch verkaufen". Überbuchte Tage sind als solche erkennbar, nicht nur als negative Zahl. Aus einer Zelle heraus führt ein Weg in A2 |
| A1 | **Verfügbarkeitssuche.** Zeitraum, Personenzahl, Zimmergruppe → freie Kategorien mit Preis | Ein Zeitraum ohne Verfügbarkeit sagt das, statt eine leere Liste zu zeigen. Der Zeitraum ist nach oben begrenzt |
| A2 | **Buchungsmaske.** Aus dem Suchergebnis heraus buchen, mit Gast und Ratenplan | Eine Buchung entsteht mit `Idempotency-Key`; zweimaliges Absenden erzeugt **eine** Reservierung. Ein volles Haus antwortet verständlich, nicht mit „409" |
| A3 | **Gastsuche.** Nach Name, Mail, Firma; Treffer in einer Anfrage | Die Suche lädt nicht je Zeile nach. Ein anonymisierter Gast ist als solcher erkennbar |
| A4 | **Gastprofil.** Anlegen, ändern, Aufenthaltshistorie | Es gibt **kein** Feld für eine Ausweiskopie. Die Ausweisnummer erscheint maskiert, im Klartext nur mit `guest:read_identity` |
| A5 | **Firmen.** Anlegen, ändern, Zahlungsbedingungen | Die Rechnungsadresse der Firma ist sichtbar, weil dorthin die Rechnung geht |
| A6 | **Check-in mit Meldeschein.** Vorbelegtes Formular, Unterschrift nur bei ausländischen Gästen | Bei einem inländischen Gast erscheint **gar kein** Unterschriftsfeld. Ohne zugewiesenes Zimmer sagt die Maske das, bevor der Knopf gedrückt wird |
| A7 | **Aufenthalt ändern.** Verlängern, verkürzen, Kategorie wechseln | Die Maske ruft `change-stay` auf, nicht Storno plus Neubuchung. Der Unterschied ist im vollen Haus der zwischen „geht" und „geht nicht" |
| A8 | **Bestätigung schicken.** Knopf in der Reservierung | Ohne hinterlegte Adresse sagt er, dass die Adresse fehlt, statt still nichts zu tun |
| A9 | **Zimmerplan als Arbeitsfläche.** Reservierung anklicken, Zimmer zuweisen, verschieben, verlängern — mit der Maus auf dem Balken | Der Zimmerplan ist heute ein Bild: `TapeChart` nimmt ein `onSelect` entgegen, und `Tape.tsx` übergibt es nicht. Fertig, wenn von dort aus dasselbe geht wie aus dem Tagesgeschäft. Verschieben ruft `change-stay`/`assign-unit`, nie Storno plus Neubuchung |
| A10 | **Warnungen im Plan.** Überbuchung und nicht zugewiesene Anreisen sichtbar | Beides liegt in den Daten (`overbooking_limit`, `resource_id IS NULL`) und wird heute nicht gezeigt. Der Wettbewerb zeigt es; wer es erst beim Check-in merkt, merkt es zu spät |

**Neuer Endpunkt absehbar (3.1):** Für A1 könnte `GET .../availability` zu grob sein — es liefert Verfügbarkeit, aber nicht Verfügbarkeit *mit Preis je Kategorie*. Prüfe erst `rate-grid`; reicht es nicht, ist ein Aggregat `GET .../offers?from=&to=&guests=` gerechtfertigt. **Ein Aufruf je Bildschirm**, keine Schleife.

---

### Spur B — Preise, Rechnung, Geld

**Eigene Dateien:** `routes/Rates.tsx`, `routes/Invoices.tsx`, `components/RateGrid.tsx`, `lib/queries/rates.ts`, `lib/queries/billing.ts`, `lib/i18n/preise.ts`, `lib/i18n/rechnung.ts`

| # | Aufgabe | Fertig, wenn |
|---|---|---|
| B1 | **Preisraster für ein ganzes Jahr.** Tage waagerecht, Ratenpläne senkrecht, ein Aufruf. `GET .../rate-grid` liefert bis **400 Tage** | 400 Tage × 10 Ratenpläne laden in **einer** Anfrage und scrollen flüssig. Das ist die Ansicht, aus der die Preise an den Channel Manager gehen — sie muss ein Jahr am Stück tragen |
| B2 | **Massenänderung mit Vorschau.** Bereich markieren, Preis setzen, **erst ansehen, dann übernehmen** | Die Vorschau zeigt die Zahl der betroffenen Tage. Ohne Vorschau kein Übernehmen |
| B3 | **Restriktionen.** Mindestaufenthalt, Anreisesperre, Stopp im selben Raster | Eine gesetzte Restriktion ist im Raster sichtbar, nicht nur in einem Formular |
| B4 | **Ratenpläne.** Anlegen, abgeleitete Raten neu rechnen | Nach dem Neurechnen zeigt die Oberfläche, wie viele Tage sich geändert haben |
| B5 | **Rechnungsliste.** Je Zeitraum, mit Status und Betrag | Der Zeitraum ist nach oben begrenzt |
| B6 | **Rechnungsansicht.** PDF anzeigen, herunterladen | Ist der Beleg noch nicht erzeugt (`document_pending`), sagt die Maske „wird erzeugt" statt einen Fehler zu zeigen |
| B7 | **Rechnung verschicken.** Knopf mit abweichender Adresse, Postausgang einsehen | Ein zweiter Klick erzeugt keine zweite Mail — die API antwortet mit 409 und verlangt `resend` |
| B8 | **Anzahlung.** Anzahlungsrechnung erzeugen, Verrechnung sichtbar | Die Verrechnung erscheint als Position auf der Schlussrechnung, nicht als Kopfangabe |
| B9 | **Pay-by-Link.** Zahlungslink erzeugen und dem Gast geben | Die Maske sagt, dass ein Link keine Zahlung ist, bis sie eingeht |
| B10 | **Was der Channel Manager sieht.** Zu einem Zeitraum zeigen, welche Preise, Verfügbarkeiten und Restriktionen über `GET /v1/channel/ari/*` hinausgehen | Dieselbe Antwort wie die Maschine bekommt, nur lesbar dargestellt. Ohne das ist „warum steht bei Booking.com ein anderer Preis" nicht zu beantworten, ohne Protokolle zu lesen |

**Zu B2:** Die Vorschau ist keine Bequemlichkeit. Wer 365 Tage auf einmal ändert und sich vertippt, merkt es sonst, wenn die ersten Buchungen zum falschen Preis hereinkommen — und Preise rückwirkend zu ändern geht nicht, weil eine bestätigte Buchung ihren Preis behält.

---

### Spur C — Haus, Berichte, Einstellungen

**Eigene Dateien:** `routes/Reports.tsx`, `routes/Settings.tsx`, `routes/Integrations.tsx`, `lib/queries/reports.ts`, `lib/queries/settings.ts`, `lib/i18n/berichte.ts`, `lib/i18n/einstellungen.ts`

| # | Aufgabe | Fertig, wenn |
|---|---|---|
| C1 | **Kennzahlen.** Belegung, ADR, RevPAR je Tag, mit Vergleich zum Vorjahr | Die Zahlen kommen aus `business_day_stat` (Aufzeichnung), **nicht** aus `inventory_day` (Zähler). Wer das verwechselt, bekommt keine Fehlermeldung, sondern eine plausibel falsche Zahl |
| C2 | **Nachtlauf-Stand.** Lief er, wann, mit welchem Ergebnis | Ein ausgefallener Nachtlauf ist auf den ersten Blick sichtbar |
| C3 | **Beherbergungsstatistik.** Monatlich je Haus, mit Ausgabe zur Meldung | Ein Übungshaus bietet den Knopf **nicht** an |
| C4 | **Exporte.** DATEV, GoBD, Mandantenexport | Wie C3. Der Zeitraum ist begrenzt, und ein laufender Export blockiert die Oberfläche nicht |
| C5 | **Wartungsmeldungen.** Liste, anlegen, erledigen | Out of Order und Out of Service sind unterscheidbar — das eine senkt die Kapazität, das andere nicht |
| C6 | **Absenderangaben Gastpost.** Absender, Antwortadresse, Blindkopie, Ein/Aus | In einem Übungshaus lässt sich der Versand nicht einschalten; die Maske sagt warum |
| C7 | **Zahlungsarten.** Liste und Pflege | — |
| C8 | **Webhooks.** Abonnements anlegen, Zustellprotokoll ansehen, stillgelegte wieder einschalten | Der Grund der Stilllegung steht an der Zeile |
| C9 | **Maschinenzugänge und Channel Manager.** Anlegen, sperren, Zugriffsbereiche sehen | Ein Geheimnis wird **einmal** bei der Anlage gezeigt und nie wieder |
| C10 | **Benutzer und Rollen.** Wer darf was, je Haus | Die Rechte werden gezeigt, wie die API sie liefert, nicht nachgebaut |
| C11 | **Stammdaten vollständig pflegen.** Zimmergruppe und Zimmer **ändern und stilllegen**, mit allen Feldern des Modells | Heute lässt sich beides nur anlegen, obwohl `PATCH /v1/categories/:id` und `PATCH /v1/rooms/:id` existieren. Eine Gruppe hat neben Code, Name und Belegung auch `description` (geht an den Channel Manager), `sort_order`, `overbooking_limit` und `active`; ein Zimmer hat `floor` und `attributes` (Balkon, barrierefrei, Raucher) — an letzterem hängt später die Zimmerzuweisung |

**Zu C9:** Ein angezeigtes Geheimnis, das sich erneut abrufen lässt, ist ein Geheimnis, das in jedem Bildschirmfoto liegt. Einmal zeigen, mit Hinweis, dann nie wieder.

---

## 4. Was für alle drei gilt

**Neuer Bildschirm, in vier Schritten:**

1. `routes/DeinBildschirm.tsx` anlegen.
2. Texte in `lib/i18n/deinbereich.ts`, im Index importieren und in beide Sprachblöcke eintragen.
3. Abfragen in `lib/queries/deinbereich.ts`.
4. **Eine** Zeile ans Ende von `SCREENS` in `screens.tsx`, mit dem Recht, das ihn sichtbar macht.

**Prüfe deinen Bildschirm mit einem Konto, das nicht alles darf.** Ein Bildschirm, der nur als `hotel_director` funktioniert, ist nicht fertig. `packages/testing` legt Benutzer mit beliebiger Rolle an.

**Jede Liste bekommt eine Obergrenze**, jeder Zeitraum ein Maximum. Ohne sie ist jeder Endpunkt ein Selbstangriff.

**Tests:** Verhalten, nicht Darstellung. Geprüft wird, wo ein Fehler Geld oder Zimmer kostet — Datumsrechnung, Geldanzeige, Rechteauswertung, Umrechnung von Formulardaten in Nutzlast. Nicht, dass ein Kasten blau ist.

---

## 5. Fortschrittstafel

**Jeder trägt seinen eigenen Stand in seinem eigenen Pull Request ein.** Nur die eigene Zeile ändern; dann bleibt die Tafel konfliktfrei, auch wenn drei gleichzeitig schreiben.

Zustände: `offen` · `läuft` · `im PR #n` · `fertig` · `blockiert (Grund)`

### Spur A — Buchen, Gast, Anreise

| # | Aufgabe | Stand | PR | Bemerkung |
|---|---|---|---|---|
| A0 | Verfügbarkeitsraster | offen | — | |
| A1 | Verfügbarkeitssuche | offen | — | |
| A2 | Buchungsmaske | offen | — | |
| A3 | Gastsuche | offen | — | |
| A4 | Gastprofil | offen | — | |
| A5 | Firmen | offen | — | |
| A6 | Check-in mit Meldeschein | offen | — | |
| A7 | Aufenthalt ändern | offen | — | |
| A8 | Bestätigung schicken | offen | — | |
| A9 | Zimmerplan als Arbeitsfläche | offen | — | |
| A10 | Warnungen im Plan | offen | — | |

### Spur B — Preise, Rechnung, Geld

| # | Aufgabe | Stand | PR | Bemerkung |
|---|---|---|---|---|
| B1 | Preisraster für ein ganzes Jahr | offen | — | |
| B2 | Massenänderung mit Vorschau | offen | — | |
| B3 | Restriktionen | offen | — | |
| B4 | Ratenpläne | offen | — | |
| B5 | Rechnungsliste | offen | — | |
| B6 | Rechnungsansicht | offen | — | |
| B7 | Rechnung verschicken | offen | — | |
| B8 | Anzahlung | offen | — | |
| B9 | Pay-by-Link | offen | — | |
| B10 | Was der Channel Manager sieht | offen | — | |

### Spur C — Haus, Berichte, Einstellungen

| # | Aufgabe | Stand | PR | Bemerkung |
|---|---|---|---|---|
| C1 | Kennzahlen | offen | — | |
| C2 | Nachtlauf-Stand | offen | — | |
| C3 | Beherbergungsstatistik | offen | — | |
| C4 | Exporte | offen | — | |
| C5 | Wartungsmeldungen | offen | — | |
| C6 | Absenderangaben Gastpost | offen | — | |
| C7 | Zahlungsarten | offen | — | |
| C8 | Webhooks | offen | — | |
| C9 | Maschinenzugänge, Channel Manager | offen | — | |
| C10 | Benutzer und Rollen | offen | — | |
| C11 | Stammdaten vollständig pflegen | offen | — | |

---

## 6. Was zwischen den Spuren hängt

Hier steht, was einer braucht und ein anderer liefert — und was aufgefallen ist, ohne dass es in die eigene Spur gehörte. **Eintragen statt selbst ändern.**

| Wer | Braucht von | Was | Stand |
|---|---|---|---|
| A | (Rahmen) | Ein Weg, aus dem Zimmerplan heraus zu buchen — `TapeChart` müsste einen leeren Bereich anklickbar machen | offen |
| B | A | Gastauswahl (`GuestPicker`) für die Rechnungsadresse | offen |
| C | (Rahmen) | Ein Ort für Einstellungen, die nicht Einrichtung sind — heute gibt es nur `Setup` | offen |

---

## 7. Wenn etwas unklar ist

**Fachlich:** Dokumente `01` bis `15` sind die Begründungen. Ist eine Regel dort nicht zu finden, ist sie wahrscheinlich keine — dann entscheide und **schreib auf, warum**.

**Technisch:** Der bestehende Code ist die Vorlage. `Blocks.tsx` ist der jüngste vollständige Bildschirm mit Liste, Formular und Aktion; `Folio.tsx` zeigt, wie Unveränderlichkeit dargestellt wird.

**Beim anderen:** In Abschnitt 6 eintragen. Nicht in fremden Dateien arbeiten, auch nicht „nur kurz".

**Beim Umfang:** Lieber die Aufgabe kleiner schneiden und liefern als groß anfangen und nicht fertig werden. Ein Bildschirm, der drei Dinge gut kann, ist mehr wert als einer, der zehn halb kann.
