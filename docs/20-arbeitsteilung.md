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

### Spur A — Der Belegungsplan

**Das Kernelement der ganzen Oberfläche, und die Spur, die die meiste Aufmerksamkeit bekommt.**

Der Belegungsplan ist das Hauptwerkzeug der Rezeption: dort wird geplant und geändert — Buchungen anlegen, ändern, verschieben, verkürzen, verlängern, Notizen setzen. Heute ist er ein Bild. Er kann nicht einmal das, wofür seine eigene Komponente schon einen Anschluss hat: `TapeChart` nimmt ein `onSelect` entgegen, und `Tape.tsx` übergibt es nicht.

Diese Spur ist **deutlich größer als B und C**, und das ist Absicht. A1 bis A6 sind ein einziger Vorgang: auf den Plan sehen, aufziehen, Gast wählen, buchen, anreisen lassen. Auf zwei Bearbeiter verteilt entstehen zwei halbe Masken, die nicht ineinandergreifen.

**Die API trägt das inzwischen.** Was dem Plan fehlte, ist nachgereicht und getestet:

| Neu | Wofür im Plan |
|---|---|
| `GET /v1/reservations/:ref` | Balken anklicken: Gast, Zimmer, Nächte, Preise, Mitreisende, Folio — **in einem Aufruf** |
| `PATCH /v1/reservations/:ref` | Notiz setzen, ohne Bestand oder Preis anzufassen |
| `resourceId` an `POST /v1/bookings` | Im Plan aufgezogen heißt **in einem** Schritt im richtigen Zimmer |
| `notes` im `tape-chart` | Die Notiz steht am Balken, nicht zwei Klicks entfernt |

Verschieben ist `assign-unit`, verkürzen und verlängern ist `change-stay`. Beide gab es schon.

**Eigene Dateien:** `routes/Tape.tsx` und `components/TapeChart.tsx` (**gehören für die Dauer dieser Spur dir**, B und C fassen sie nicht an), dazu `components/ReservationPanel.tsx`, `components/BookingDialog.tsx`, `components/GuestPicker.tsx`, `components/AvailabilityGrid.tsx`, `routes/Guests.tsx`, `routes/CheckIn.tsx`, `routes/Availability.tsx`, `lib/queries/booking.ts`, `lib/queries/guests.ts`, `lib/i18n/plan.ts`, `lib/i18n/gaeste.ts`

| # | Aufgabe | Fertig, wenn |
|---|---|---|
| A1 | **Balken anklicken.** Auswahl an `TapeChart` durchreichen, Seitenfenster mit `GET /v1/reservations/:ref` | Ein Klick zeigt Gast, Zimmer, Nächte mit Preisen, Mitreisende, Folio und Notiz. **Ein** Aufruf, nicht sechs |
| A2 | **Im Plan buchen.** Im leeren Bereich einer Zimmerzeile über Tage aufziehen → Buchungsdialog mit vorbelegtem Zimmer und Zeitraum | Die Buchung entsteht mit `resourceId` in **einem** Aufruf und liegt im aufgezogenen Zimmer. Zweimaliges Absenden erzeugt **eine** Reservierung (`Idempotency-Key`). Ein volles Haus antwortet verständlich, nicht mit „409" |
| A3 | **Verschieben.** Balken auf eine andere Zimmerzeile ziehen | Ruft `assign-unit`. Ein belegtes oder außer Betrieb stehendes Zimmer wird abgelehnt, **bevor** der Balken springt — kein Zurückschnappen nach der Antwort |
| A4 | **Verkürzen und verlängern.** Am Rand des Balkens ziehen | Ruft `change-stay`, nie Storno plus Neubuchung. Der Unterschied ist im vollen Haus der zwischen „geht" und „geht nicht" |
| A5 | **Notiz am Balken.** Setzen, ändern, löschen; am Balken als Merkmal sichtbar | Ruft `PATCH /v1/reservations/:ref`. Die Maske sagt, dass hier **keine Gesundheitsdaten** hingehören: das Feld ist Freitext und wird weder durchsucht noch anonymisiert |
| A6 | **Gastsuche und -profil.** Aus dem Buchungsdialog heraus und als eigener Bildschirm | Die Suche lädt nicht je Zeile nach. **Kein** Feld für eine Ausweiskopie; die Nummer erscheint maskiert, im Klartext nur mit `guest:read_identity`. Ein anonymisierter Gast ist erkennbar |
| A7 | **Warnungen im Plan.** Überbuchung und nicht zugewiesene Anreisen sichtbar | Beides liegt in den Daten (`overbooking_limit`, `resource_id IS NULL`) und wird heute nicht gezeigt. Wer es erst beim Check-in merkt, merkt es zu spät |
| A8 | **Verfügbarkeitsraster.** Zimmergruppe × Tag, freie Einheiten je Zelle; `GET .../availability` liefert bis **731 Tage** | Der Blick neben dem Plan: was ist frei, ohne auf einzelne Zimmer zu sehen. Aus einer Zelle heraus führt ein Weg in A2 |
| A9 | **Check-in mit Meldeschein**, erreichbar aus dem Plan | Bei einem inländischen Gast erscheint **gar kein** Unterschriftsfeld (seit 1.1.2025). Ohne zugewiesenes Zimmer sagt die Maske das, bevor der Knopf gedrückt wird |
| A10 | **Firmen.** Anlegen, ändern, Zahlungsbedingungen | Die Rechnungsadresse der Firma ist sichtbar, weil dorthin die Rechnung geht |
| A11 | **Storno und Wiederherstellen** aus dem Plan | `cancel` und `reinstate`. Ein versehentlicher Storno ist zurücknehmbar, und die Maske sagt das |
| A12 | **Bestätigung schicken.** Knopf im Seitenfenster | Ohne hinterlegte Adresse sagt er, dass die Adresse fehlt, statt still nichts zu tun |

**Zwei Hinweise zur Bedienung**, weil sie über Brauchbarkeit entscheiden:

**Erst fragen, dann springen.** Beim Ziehen darf der Balken nicht an der neuen Stelle liegen bleiben, bevor die API zugestimmt hat. Ein Balken, der zurückspringt, sieht aus wie ein Fehler der Software; einer, der gar nicht erst springt, ist eine Antwort.

**Die Tastatur bleibt gleichwertig.** An einer Rezeption steht jemand neben dem Bildschirm und tippt, während er redet. Alles, was per Ziehen geht, muss auch über die Auswahl im Seitenfenster gehen — Ziehen ist die schnelle, nicht die einzige Bedienung.

**Neuer Endpunkt absehbar (3.1):** Für den Buchungsdialog könnte `GET .../availability` zu grob sein — es liefert Verfügbarkeit, aber nicht Verfügbarkeit *mit Preis je Kategorie*. Prüfe erst `rate-grid`; reicht es nicht, ist ein Aggregat `GET .../offers?from=&to=&guests=` gerechtfertigt. **Ein Aufruf je Bildschirm**, keine Schleife.

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

### Spur A — Der Belegungsplan

| # | Aufgabe | Stand | PR | Bemerkung |
|---|---|---|---|---|
| A1 | Balken anklicken | fertig | #24 | `ReservationPanel`, `GET /v1/reservations/:ref` in einem Aufruf. Im Browser gegen die echte API geprüft |
| A2 | Im Plan buchen | im PR #31 | #31 | Ziehen im leeren Bereich oeffnet `BookingDialog` mit vorbelegtem Zimmer/Zeitraum. `POST /v1/bookings` bekam `guestRef` (die Oberflaeche kennt nie die laufende Gast-id). Im Browser geprueft |
| A3 | Verschieben | im PR #31 | #31 | Balken auf andere Zimmerzeile ziehen, `assign-unit`. Schattenbalken waehrend des Ziehens, kein optimistischer Sprung |
| A4 | Verkürzen und verlängern | im PR #31 | #31 | Balkenrand ziehen, `change-stay` — nie Storno plus Neubuchung |
| A5 | Notiz am Balken | fertig | #24 | Im selben Seitenfenster wie A1 erledigt: `PATCH /v1/reservations/:ref`, Merkmal (📌) am Balken samt Tooltip. Speichern und Persistenz im Browser geprüft |
| A6 | Gastsuche und -profil | im PR #31 | #31 | Eigener Bildschirm `Guests.tsx`: Suche, Anlegen, Profil. Ausweisnummer maskiert, Klartext erst nach Klick hinter `guest:read_identity` |
| A7 | Warnungen im Plan | im PR #31 | #31 | Unzugewiesene Ankuenfte und Ueberbuchung je Zimmergruppe, clientseitig aus den geladenen Plandaten — kein Aufruf je Zeile |
| A8 | Verfügbarkeitsraster | im PR #31 | #31 | Zimmergruppe × Tag, bis 731 Tage in einem Aufruf, Zelle fuehrt in den Buchungsdialog |
| A9 | Check-in mit Meldeschein | im PR #31 | #31 | Aus dem Plan erreichbar (`ReservationPanel` → `CheckIn.tsx`). Kein Unterschriftsfeld fuer inlaendische Gaeste seit 1.1.2025; ohne Zimmer sagt die Maske es vor dem Knopf |
| A10 | Firmen | im PR #31 | #31 | Reiter im Gaeste-Bildschirm. Neue Endpunkte `GET`/`PATCH /v1/companies/:ref` |
| A11 | Storno und Wiederherstellen | im PR #31 | #31 | Reversibel mit Bestaetigung vor dem Storno. Dabei gefunden: `reinstate` liess `canceled_at` stehen — jetzt zurueckgesetzt |
| A12 | Bestätigung schicken | im PR #31 | #31 | Fehlt die Adresse, sagt das Seitenfenster es explizit statt stillschweigend nichts zu tun |

### Spur B — Preise, Rechnung, Geld

| # | Aufgabe | Stand | PR | Bemerkung |
|---|---|---|---|---|
| B1 | Preisraster für ein ganzes Jahr | fertig | #26 | 400 Tage in einer Anfrage, gemessen: 283 ms laden, 22 ms je Zug mit der Maus |
| B2 | Massenänderung mit Vorschau | fertig | #26 | Ohne Vorschau kein Übernehmen; die Vorschau verfällt, sobald sich die Eingabe ändert |
| B3 | Restriktionen | fertig | #26 | Im selben Raster als Kürzel an der Zelle (G / A / B / Mindestaufenthalt) |
| B4 | Ratenpläne | fertig | #30 | Anlegen und abgeleitete Raten neu rechnen, unter dem Raster statt in der Einrichtung |
| B5 | Rechnungsliste | fertig | #30 | Neuer Endpunkt `GET .../invoices`; **kein** „offen"-Merkmal, siehe Befund in Abschnitt 6 |
| B6 | Rechnungsansicht | fertig | #30 | Beleg im Blatt, `document_pending` als Zustand statt als Fehler |
| B7 | Rechnung verschicken | fertig | #30 | Zweiter Versand nur ausdrücklich; Postausgang mit Zurückziehen |
| B8 | Anzahlung | im PR #33 | #33 | Eingeklapptes Feld am Folio. Neuer Endpunkt `GET /v1/folios/:ref/prepayments`; die Verrechnung steht an der Anzahlung, sobald die Schlussrechnung sie zieht |
| B9 | Pay-by-Link | im PR #33 | #33 | Im selben Feld. Die Adresse wird **einmal** gezeigt und nicht gespeichert; ohne Zahlungsdienstleister sagt die Maske das, statt eine 503 zu zeigen |
| B10 | Was der Channel Manager sieht | im PR #33 | #33 | Unter dem Raster. Neuer Endpunkt `GET .../channel-view` mit **demselben SQL** wie ARI; ein Klick aufs Datum zeigt die Rohantwort dieses Tages |

### Spur C — Haus, Berichte, Einstellungen

| # | Aufgabe | Stand | PR | Bemerkung |
|---|---|---|---|---|
| C1 | Kennzahlen | im PR #25 | #25 | Reiter „Kennzahlen". Vorjahresvergleich im selben Aufruf: `kpi` nimmt jetzt `compare=previous-year` |
| C2 | Nachtlauf-Stand | im PR #25 | #25 | Reiter „Nachtlauf". Brauchte einen Endpunkt: `GET /v1/properties/:id/night-audit-status` |
| C3 | Beherbergungsstatistik | im PR #25 | #25 | Reiter „Beherbergung". Im Übungshaus gar nicht erst angeboten |
| C4 | Exporte | im PR #25 | #25 | Reiter „Ausgaben": DATEV, GoBD, Mandantenexport. Läuft neben der Oberfläche |
| C5 | Wartungsmeldungen | im PR #27 | #27 | Eigener Bildschirm „Wartung". Brauchte `PATCH /v1/maintenance-tickets/:id`; die Sperrung nimmt jetzt beide Arten |
| C6 | Absenderangaben Gastpost | im PR #27 | #27 | Reiter in „Einstellungen" |
| C7 | Zahlungsarten | im PR #27 | #27 | Reiter in „Einstellungen". Brauchte POST und PATCH; **kein** Löschen |
| C8 | Webhooks | im PR #28 | #28 | Reiter in „Schnittstellen", mit Zustellprotokoll und Grund der Stilllegung an der Zeile |
| C9 | Maschinenzugänge, Channel Manager | im PR #28 | #28 | Zwei Reiter. Geheimnis einmal, mit ausdrücklicher Bestätigung |
| C10 | Benutzer und Rollen | im PR #28 | #28 | Reiter. Brauchte drei Endpunkte (`users`, `roles`, Rollen setzen). Benutzer **anlegen** gehört zur Einladung und ist nicht dabei |
| C11 | Stammdaten vollständig pflegen | im PR #27 | #27 | `components/Stammdaten.tsx`, eingehängt in `Setup.tsx`. Alle Felder des Modells, stilllegen statt löschen |

---

## 6. Was zwischen den Spuren hängt

Hier steht, was einer braucht und ein anderer liefert — und was aufgefallen ist, ohne dass es in die eigene Spur gehörte. **Eintragen statt selbst ändern.**

| Wer | Braucht von | Was | Stand |
|---|---|---|---|
| A | (Rahmen) | Ein Weg, aus dem Zimmerplan heraus zu buchen — `TapeChart` müsste einen leeren Bereich anklickbar machen | erledigt: #31, Ziehen im leeren Bereich öffnet `BookingDialog` |
| B | A | Gastauswahl (`GuestPicker`) für die Rechnungsadresse | offen |
| C | (Rahmen) | Ein Ort für Einstellungen, die nicht Einrichtung sind — heute gibt es nur `Setup` | erledigt: `routes/Settings.tsx` |
| C | B | `PaymentMethod` in `schemas.ts` trägt jetzt zusätzlich `id`, `sortOrder` und `active` — die Liste war ansehbar, aber nicht pflegbar. Rein additiv; `GET .../payment-methods` liefert weiterhin nur die aktiven, `?includeInactive=true` auch die stillgelegten | erledigt |
| C | (Rahmen) | Ein Bildschirm konnte nur **ein** Recht tragen. Die Berichte bündeln drei (`report:operational`, `report:revenue`, `report:export`), und eine Rezeption hat nur das erste. `permission` in `screens.tsx` nimmt deshalb jetzt auch eine **Liste**; sie heißt „eines davon genügt". Bestehende Einträge bleiben unverändert | erledigt |
| B | (Rahmen) | `formatMoney` in `lib/i18n/index.ts` baut bei **jedem** Aufruf ein `Intl.NumberFormat`. Auf einer Liste unauffällig, im Raster nicht: 1 600 Objekte je Neuzeichnen, gemessen 328 ms je Mausbewegung. Spur B hält sich deshalb einen eigenen Formatierer (`geldFormatierer` in `lib/preisraster.ts`, danach 22 ms). Gehört auf Dauer in den Rahmen, nicht in drei Spuren | offen |
| B | (alle) | `web.test.ts` schrieb die Bildschirmliste **exakt** fest und wäre damit bei jeder Spur rot geworden, sobald sie ihren ersten Bildschirm anhängt. Spur B hat die Prüfung auf ihre Absicht zurückgeführt: die bekannten Schlüssel stehen weiterhin in dieser Reihenfolge am Anfang, angehängte kommen dahinter. Wer einen Bildschirm anhängt, muss dort nichts mehr ändern | erledigt |
| B | (alle) | **`settlement.invoice_id` wird nirgends geschrieben.** Das Feld hat einen Leser — der ZUGFeRD-Beleg setzt daraus BT-113, den vorausgezahlten Betrag — und ein eigenes Schreibrecht aus Migration `0012`, aber keinen Schreiber. Folge: auf **jedem** Beleg steht als Vorauszahlung null, auch wenn der Gast angezahlt hat, und eine Rechnungsliste kann kein „offen" führen. Wer eine Zahlung an eine Rechnung hängt, entscheidet das; gehört zur Fakturierung, nicht in diese Spur | offen |
| B | (Rahmen) | Die Rechte des Benutzers stehen nur in `main.tsx`, ein Bildschirm kommt nicht an sie heran. Spur B liest dafür denselben Zwischenspeicher (`useRechte` in `lib/queries/rates.ts`); sauberer wäre ein Feld am `ScreenContext` — das ändert aber `screens.tsx` für alle drei und wartet deshalb auf eine Absprache | offen |
| B | (alle) | **`sum()` über eine `bigint`-Spalte liefert `numeric`, und `numeric` kommt als Zeichenkette an.** Der Typenparser in `packages/db/src/pool.ts` deckt `int8` und `int8[]` ab, nicht `numeric`. Eine Centsumme als Zeichenkette fällt nicht auf — sie rechnet sich nur falsch, sobald jemand sie addiert. Gefunden in der eigenen Abfrage und dort mit `::bigint` behoben; wer eine Summe zurückgibt, castet sie. Auf Dauer gehört `numeric` in den Parser, das ändert aber das Verhalten aller bestehenden Abfragen | offen |
| B | (Rahmen) | Die Adresse eines Zahlungslinks wird **nicht gespeichert** — `payment_intent` trägt nur die Referenz des Anbieters. Wer den Link ein zweites Mal braucht, erzeugt einen neuen; die Maske sagt das. Gespeichert wäre er ein Link, den jeder mit Lesezugriff einlösen kann, deshalb ist das Absicht und keine Lücke | erledigt: benannt |
| B | (gefunden bei A1) | `Folio.tsx` zeigt den Hinweistext von `GET .../payment-methods` unübersetzt an — die API liefert ihn fest auf Deutsch, unabhängig von der Sprache der Oberfläche. Fällt in Spur B, nicht angefasst | offen |

---

## 7. Wenn etwas unklar ist

**Fachlich:** Dokumente `01` bis `15` sind die Begründungen. Ist eine Regel dort nicht zu finden, ist sie wahrscheinlich keine — dann entscheide und **schreib auf, warum**.

**Technisch:** Der bestehende Code ist die Vorlage. `Blocks.tsx` ist der jüngste vollständige Bildschirm mit Liste, Formular und Aktion; `Folio.tsx` zeigt, wie Unveränderlichkeit dargestellt wird.

**Beim anderen:** In Abschnitt 6 eintragen. Nicht in fremden Dateien arbeiten, auch nicht „nur kurz".

**Beim Umfang:** Lieber die Aufgabe kleiner schneiden und liefern als groß anfangen und nicht fertig werden. Ein Bildschirm, der drei Dinge gut kann, ist mehr wert als einer, der zehn halb kann.
