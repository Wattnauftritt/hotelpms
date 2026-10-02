# Gästeterminal

Ein Touchscreen an der Rezeption, an dem ein Gast den Meldeschein unterschreibt. Die Rezeption klickt am Rezeptionsrechner, und am Touchscreen öffnet sich, was zu tun ist. Dazu die kleine Lücke, die beim Bauen mitgefallen ist: die Hausnotiz am Gastprofil.

Stand: 2. Oktober 2026. Migrationen `0063`, `0064`. Code: `apps/api/src/routes/terminal.ts`, `apps/web/src/routes/Terminal.tsx`, `apps/web/src/components/AmTerminal.tsx`, `apps/web/src/components/Gaesteterminals.tsx`.

---

## 1. Was der Betrieb hatte und wollte

Die Häuser schicken das Meldeformular vorab per Mail; wer das nicht möchte oder vergisst, füllt es vor Ort aus — an einem zweiten Rechner mit Touchscreen, auf dem eine Webseite läuft und fragt. Am Rezeptionsrechner ein Knopf, am Touchscreen öffnet sich das Formular. Gewünscht war dasselbe hier, und so gebaut, dass es mehr als eine Sache öffnen kann: Meldeformular ausfüllen, Meldeformular unterschreiben, und was noch dazukommt.

Gebaut ist jetzt: **Meldeschein unterschreiben** vollständig, **Meldeformular ausfüllen** als vorbereiteter Platzhalter (§6).

---

## 2. Gerät statt Sitzung

Am Touchscreen steht ein **Gast**. Eine Mitarbeitersitzung dort öffnete ihm das ganze Haus, sobald er die Adresszeile anfasst — `/` liegt einen Fingertipp neben `/terminal`. Deshalb meldet sich das Terminal nicht an, es wird **gekoppelt**:

1. Einstellungen → Gästeterminals → Name eingeben → „Terminal koppeln". Die Schnittstelle legt das Gerät an und gibt **einmal** einen Code aus (`XXXX-XXXX`, acht Zeichen aus dem Alphabet der öffentlichen Referenzen, zehn Minuten gültig). In der Datenbank steht nur sein SHA-256.
2. Am Touchscreen `https://<haus>.staygrid.cloud/terminal` öffnen, Code eingeben. `POST /v1/terminal/pair` löst ihn ein — genau einmal: der Code fällt in derselben Anweisung, in der das Gerätegeheimnis entsteht (`terminal_device_pair()`).
3. Das Terminal bekommt dafür ein **langlebiges Geheimnis** (32 zufällige Byte) im Cookie `hp_terminal`.

**Warum ein Cookie und nicht ein Token im JavaScript.** Aus demselben Grund wie bei der Sitzung (`lib/api.ts`): `httpOnly` hält es von jedem eingeschleusten Skript fern, und ein Geheimnis, das ein Jahr am Touchscreen eines Gastes liegt, ist genau das, wonach ein solches Skript suchte. Dazu `SameSite=Strict`, `Secure` im Betrieb, und **`Path=/v1/terminal`**: der Browser schickt es an keine andere Route, auch nicht versehentlich. In der Datenbank liegt auch hier nur der Hash, und beide Hashes stehen in `audit_redaction`.

**Eine Mitarbeitersitzung im selben Browser wird beim Koppeln beendet** und ihr Cookie gelöscht. Wer an diesem Rechner danach wieder die Rezeptionsoberfläche öffnet, muss sich neu anmelden — und sollte es dort nicht tun. Der Hinweis steht neben dem Code.

**Ein Terminal gehört genau einem Haus**, ist benannt („Touchscreen Rezeption"), steht in den Einstellungen mit „erreichbar / nicht erreichbar" (letzte Frage jünger als eine Minute) und lässt sich **neu koppeln** (neuer Code, das alte Geheimnis fällt sofort) und **widerrufen** (Geheimnis gelöscht, ein offener Auftrag fällt mit). Höchstens zehn je Haus.

### Das Principal des Geräts

`loadPrincipalFromDevice` (`platform/auth.ts`) baut es wie den Maschinenzugang — dasselbe `Principal`, derselbe Rechtekatalog, dieselbe Prüfung in `registerRoute`. Nur schmaler:

| | Benutzer | Maschinenzugang | Gästeterminal |
|---|---|---|---|
| `userId` | gesetzt | null | null |
| Häuser | Rollen | Auswahl oder alle | **genau eines** |
| Rechte | Rollen | Zugriffsbereiche | **nur** `terminal:device` |
| Account-Rechte | Rollen | keine | keine |
| `clientKey` | `user:…` | `client:…` | `device:…` |
| im Protokoll | `user_id` | — | `terminal_device_id` |

`terminal:device` steht im Katalog, weil `registerRoute` nur Rechte aus dem Katalog kennt — es gibt keinen zweiten Rechteweg, und die Geräterouten fallen damit unter denselben Test über die ganze Routenliste wie jede andere. Das Recht ist **keiner Rolle** zugeordnet (Migration 0063) und als Zugriffsbereich eines Maschinenzugangs **ausgeschlossen** (`routes/oauth.ts`). Die Geräterouten prüfen zusätzlich, dass das Principal wirklich ein Gerät ist (`geraetVon`): das Recht allein genügt nie.

Abgenommen durch `terminal.test.ts`: ein gekoppeltes Terminal bekommt auf **jeder** registrierten Route außer seinen eigenen 401 oder 403 — mit dem eigenen Haus als Pfadparameter, also abgewiesen am Recht und nicht am fremden Haus.

### Ratenbegrenzung

Zwei Richtungen, beide aus CLAUDE.md:

- **Ein gekoppeltes Terminal zählt nicht als anonym.** Es fragt alle zwei Sekunden, dreißigmal je Minute, ohne Pause. Als anonym gezählt teilte es sich die Grenze mit allem, was aus derselben Herkunft unangemeldet kommt — an einer Rezeption hinter einem Anschluss die Anmeldemasken aller Arbeitsplätze und jedes weitere Terminal. `zeigtZugangsdaten` kennt deshalb `hp_terminal`; ein Cookie, das nicht trägt, wird danach wie jede ungültige Sitzung doch gezählt.
- **Ein ungekoppeltes Terminal fragt nicht.** Die Seite fragt einmal, bekommt 401 und zeigt die Kopplung — danach keine Abfrage mehr, bis gekoppelt ist. Ohne Netz fragt sie alle zehn statt alle zwei Sekunden.

**Den Code raten** verhindert ein eigener Fehlversuchszähler an der Route (`limiters.kopplung`, zehn Fehlversuche je Viertelstunde und Herkunft) — gezählt wird an der Route und nicht an der allgemeinen Grenze, weil eine Anfrage mit gültiger Sitzung die allgemeine Grenze nie erreicht. Genau das war bei `workstation-switch` passiert (H4, Dokument 25); der Test prüft es ausdrücklich **mit** gültiger Sitzung. Zusätzlich steht `/v1/terminal/pair` auf der engen Liste wie die Anmeldung. Gegen viele Herkünfte zugleich trägt die Länge: rund 6,5 · 10¹¹ Codes, zehn Minuten Laufzeit.

---

## 3. Aufträge

`terminal_job`: Haus, Gerät, Art, Bezug (Reservierung, Meldeschein), Zustand, angelegt von, Zeiten.

```
pending ──öffnen──▶ opened ──abschließen──▶ done
   │                  │
   ├──Rezeption───────┴──▶ canceled (reception | terminal | timeout | revoked)
   └──3 Minuten ungeöffnet──▶ expired       (geöffnet: Sicherung nach 15 Minuten)
```

**Höchstens ein offener Auftrag je Gerät** — ein Teilindex auf `(device_id) WHERE state IN ('pending','opened')`. Zwei hießen, dass der zweite Gast die Daten des ersten sieht. Derselbe Index trägt die Frage des Terminals.

**Ablauf ohne Nachtlauf.** Ein offener Auftrag nach Fristablauf *gilt* als abgelaufen, auch wenn ihn noch niemand umgeschrieben hat: die Frage des Terminals filtert über dieselbe Bedingung, die Rezeption sieht „abgelaufen", und der nächste Auftrag an dasselbe Gerät schreibt ihn weg. Ein Pflegejob für drei Minuten alte Zeilen wäre Aufwand ohne Gegenwert.

**Kein personenbezogener Wert im Auftrag.** Er verweist auf Reservierung und Meldeschein, sonst nichts — er muss deshalb in `guest_erase_one()` nicht vorkommen. Der Verweis auf den Meldeschein ist `ON DELETE SET NULL`: die Vernichtung nach einem Jahr (§ 30 Abs. 4 BMG) darf ein alter Auftrag nicht aufhalten, ein Test führt sie als Anwendungsrolle aus.

### Rezeption

`GET /v1/reservations/:ref/terminal` liefert in **einem** Aufruf, was die Rezeption an der Reservierung braucht: Terminals (erreichbar, belegt), welche Arten sich anbieten, den Stand des Meldescheins und den letzten Auftrag. Solange ein Auftrag offen ist, fragt die Oberfläche denselben Aufruf alle zwei Sekunden — „wartet", „geöffnet", „erledigt", „abgebrochen (vom Gast am Terminal)", „abgelaufen — ist es eingeschaltet?".

Der Abschnitt steht als eigene Komponente (`AmTerminal`) im Seitenfenster der Reservierung und in der Check-in-Maske. Er zeigt sich nur, wenn es ein Terminal **und** etwas anzubieten gibt. Bei einem Terminal geht der Auftrag direkt hinaus, bei mehreren erst nach Auswahl (Escape schließt sie).

**Warum die Routen eine Reservierung nehmen und keine Property.** Das Seitenfenster kennt sein Haus nicht, und es dafür umzubauen hieße, den Zimmerplan anzufassen. `registerRoute` prüft das Recht dann nur „in irgendeinem Haus" — die Routen prüfen es deshalb noch einmal am Haus der gefundenen Reservierung (`pruefeHaus`), und das Terminal muss zu genau diesem Haus gehören. Beides hat einen Test mit zwei Häusern in einem Account.

### Terminal

`GET /v1/terminal/job` ist die Frage, alle zwei Sekunden: **zwei** Datenbankanweisungen (Gerät auflösen, Auftrag lesen), ob ein Auftrag ansteht oder nicht — ein Test zählt sie. Die Antwort trägt Hausname, Übungskennzeichen und Art und Kennung des Auftrags; **keine Gastdaten**. Die kommen erst mit `POST …/open`, also erst, wenn sie gezeigt werden — und nur, was der Gast mit seiner Unterschrift bestätigt: Name, Geburtsdatum, Staatsangehörigkeit, Anschrift, Aufenthalt, Personenzahl, bei einem Sammelmeldeschein die Namen der Mitreisenden. Keine Mailadresse, kein Telefon, kein Preis, keine Buchungsnummer, keine Ausweisnummer.

Die letzte Frage wird höchstens alle zwanzig Sekunden fortgeschrieben, in einer eigenen Tabelle ohne Audit-Trigger (`terminal_device_seen`) — am Gerät selbst schriebe jede Fortschreibung eine Zeile ins Prüfprotokoll, tausende am Tag.

---

## 4. Die Seite am Touchscreen

`/terminal` in der Web-App, außerhalb der Anmeldung wie `/einladung` (`main.tsx`). Im Ruhezustand nur Hausname und Begrüßung, oben die Sprachwahl für den Gast.

**Keine Gastdaten über den Auftrag hinaus.**

- Die Seite benutzt **nicht** TanStack Query. Dessen Speicher hält Antworten über das Ende einer Komponente hinaus, und genau das darf hier nicht sein; die Daten stehen nur im Zustand der gerade gezeigten Ansicht.
- Nach jedem Auftrag — erledigt, vom Gast abgebrochen, von der Rezeption abgebrochen, abgelaufen — baut sich die Seite **neu auf** (`abraeumen()`: `history.replaceState`, dann `location.replace`). Dieselbe Begründung wie beim Abmelden in `main.tsx`: nur der Neuaufbau lässt garantiert nichts stehen, weder im Zustand noch im abgelösten DOM noch in der Leinwand. Die Adresse wird ersetzt, nicht ergänzt; ein „Zurück" führt nicht in die Daten des Vorgängers.
- Kommt die Seite aus dem Vor-Zurück-Speicher des Browsers zurück (`pageshow` mit `persisted`), baut sie sich ebenfalls neu auf — unabhängig davon, welche Kopfzeilen der Server gesetzt hat.
- Kein `localStorage`, kein `sessionStorage`.
- **Neunzig Sekunden ohne Berührung** brechen den Auftrag ab (`canceled_by = 'timeout'`, für die Rezeption unterscheidbar von „Gast hat abgebrochen") und räumen ab.

Ein Quelltexttest hält jede dieser Zusagen fest (`apps/web/src/__tests__/terminal.test.ts`).

**Betrieb.** Der Touchscreen läuft im Kioskmodus des Browsers (`chromium --kiosk https://…/terminal` o. ä.), damit der Gast weder Adresszeile noch Tabs erreicht. Das ist Einrichtung des Rechners, nicht Teil dieses Systems; Dokument 23 sagt, wer die Maschine aufsetzt, nicht den Rechner an der Rezeption.

---

## 5. Meldeschein unterschreiben

**Eine Regel, eine Stelle.** Die Unterschrift läuft am Terminal über dieselbe Funktion wie am Tresen: `signRegistration()` in `routes/registrations.ts`, aufgerufen von `POST /v1/registrations/:id/sign` und von `POST /v1/terminal/job/:ref/complete`. Seit dem 1.1.2025 unterschreiben nur ausländische Gäste; für einen inländischen bietet `GET …/terminal` die Art gar nicht an, und die Schnittstelle weist den Auftrag mit derselben Meldung ab wie den Weg am Tresen (`registration.signatureNotForeseen`). Die Oberfläche zeigt nur, was die Schnittstelle anbietet — eine zweite Fassung der Regel im Browser liefe beim nächsten Stichtag auseinander.

**Gespeichert wie bisher**: ein SVG, das ein PNG der gezeichneten Linie einbettet. Das Unterschriftsfeld ist jetzt eine gemeinsame Komponente (`components/Unterschriftsfeld.tsx`) für Check-in, Hausbedingung und Terminal. Neu ist eine Obergrenze (`SIGNATURE_MAX_LENGTH`, 400 000 Zeichen) — seit ein Gerät unterschreibt, vor dem ein Gast steht, wäre ein Megabyte je Schein ein Weg, eine Tabelle zu füllen, die ein Jahr hält.

**Der Weg im Betrieb.** Check-in-Maske, ausländischer Gast: neben „Meldeschein speichern" steht jetzt **„Anlegen, unterschreiben am Terminal"**. Der Schein entsteht ohne Unterschrift (`POST /v1/registrations` mit `signatureLater: true` — ohne die Angabe bleibt es bei der Abweisung, die ein Test festhält), und darunter steht der Auftrag ans Terminal. Ist es aus, lässt sich **hier** unterschreiben — das war der offene Punkt „Meldeschein nachträglich unterschreiben" aus Dokument 16. **Eingecheckt wird erst nach der Unterschrift**: die Maske sperrt den Knopf, solange sie fehlt. Das ist die vorsichtigere Lesart des Meldegesetzes (Unterschrift am Tag der Ankunft); die Schnittstelle selbst prüft beim Check-in den Meldeschein nicht und tat es nie.

**Im Prüfprotokoll** steht das Gerät als Handelnder: `audit_log.terminal_device_id` (Migration 0064), gesetzt wie der Benutzer aus dem transaktionslokalen Kontext (`app.terminal_device_id`). Vorher stand eine Unterschrift am Terminal mit leerem Handelnden da — genau wie die Handlung eines Maschinenzugangs, und im Streitfall nicht zu unterscheiden von einer über die Schnittstelle. Bewusst eine eigene Spalte und nicht `user_id`: eine Kennung aus einer anderen Tabelle in derselben Spalte ließe jede Auswertung „wer hat was getan" still falsche Namen zuordnen. Die Unterschrift selbst steht nicht im Protokoll (`audit_redaction` seit 0044).

---

## 6. Meldeformular ausfüllen — vorbereitet, nicht angebunden

Das Formular baut die parallele Arbeit am Online-Check-in. Vertrag: sie liefert eine Funktion, die für eine Reservierung einen Check-in-Token mit dem Kanal `terminal` erzeugt, und eine einbettbare Komponente `<GastCheckin token=… modus="terminal" onFertig=… />`.

Vorbereitet ist: der Wert `registration_fill` in der Prüfbedingung von `terminal_job.kind`, der Eintrag in der Tabelle der Arten (`ARTEN` in `routes/terminal.ts`, `verfuegbar: false`) und in der Tabelle der Ansichten (`ANSICHTEN` in `routes/Terminal.tsx`), beide mit `TODO(checkin)`. Die Schnittstelle weist die Art bis dahin mit `terminal.kindUnavailable` ab, und weil sie sie nie anbietet, erscheint auch kein Knopf.

Die Anbindung: `verfuegbar` auf `true`, `angeboten` nach dem Stand des Scheins, `nutzlast` liefert **nur** den Token (mit dem Öffnen, nicht mit der Frage), `abschliessen` bleibt leer, weil das Formular selbst über seinen Token schreibt; die Ansicht bettet die Komponente ein und ruft `onFertig`.

**Eine weitere Art** ist dasselbe: ein Wert in der Prüfbedingung (neue Migration), ein Eintrag in `ARTEN`, eine Ansicht in `ANSICHTEN`. Frage, Öffnen, Abbrechen, Ablauf und Aufräumen sind für alle Arten dieselben.

---

## 7. Übungshaus

Ein Übungshaus darf Terminals haben — es ist zum Üben da. Nichts davon wirkt nach draußen: das Terminal schreibt nur in die eigene Datenbank (Meldeschein, Auftrag), es exportiert nichts und verschickt keine Post. Die Seite zeigt im Übungshaus oben „Übungshaus", damit niemand an einem echten Touchscreen übt, ohne es zu merken.

---

## 8. Hausnotiz am Gastprofil

`POST /v1/guests/:ref/notes` gab es, eine Maske nicht — und das Profil zeigte die Notizen gar nicht, nur die Auskunft nach Art. 15. Jetzt:

- `GET /v1/guests/:ref` liefert die Hausnotizen **im selben Aufruf** mit (Haus, Verfasser, Zeitpunkt; höchstens fünfzig, die neuesten zuerst). Nur die der Häuser, die der Aufrufer sieht — das erledigt die Zeilenrichtlinie aus 0008, ein Test belegt es mit zwei Häusern.
- Am Profil steht „+ Notiz anlegen"; das Feld klappt auf, **Escape** klappt es wieder zu und verwirft den Text. Der Hinweis „eine Anforderung, nicht ihr Grund" steht am Eingabefeld, nicht in einem Handbuch.
- Höchstens 500 Zeichen. Wer mehr schreiben will, schreibt vermutlich gerade die Begründung.

**Mitbehoben:** an ein anonymisiertes Profil ließ sich eine neue Notiz hängen — und damit genau das wieder anlegen, was die Löschung entfernt hatte. Jetzt 409.

---

## 9. Was mitbehoben wurde

| Befund | Wo |
|---|---|
| `POST /v1/registrations/:id/sign` prüfte das Recht nur „in irgendeinem Haus"; wer in Haus A einchecken durfte, konnte einen Meldeschein in Haus B desselben Accounts unterschreiben lassen | `registrations.ts`, Test in `terminal.test.ts` |
| Der vorbefüllte Meldeschein lieferte seine Kennung nicht; an `/sign` kam aus der Oberfläche niemand heran | `registrations.ts` (`registrationId`) |
| Das Unterschriftsfeld rechnete Bildschirm- nicht in Leinwandkoordinaten um; in einer breiten Maske lag der Strich neben dem Finger | `components/Unterschriftsfeld.tsx` |
| Ein bloßes Antippen des Unterschriftsfelds ergab ein leeres Bild, das als Unterschrift durchging | ebenda |
| Eine Unterschrift hatte keine Größengrenze außer dem Rumpflimit | `SIGNATURE_MAX_LENGTH` |
| Notiz an anonymisiertem Profil | `guests.ts` |

---

## 10. Offen

- **Kioskmodus und Rechner an der Rezeption** sind Einrichtung beim Kunden. Eine kurze Anleitung gehört in die Einweisung, nicht in `ops/`.
- **Caddy und `/terminal`.** `ops/caddy/Caddyfile` setzt `Cache-Control: no-store` mit `header /index.html …`. Ob das für Pfade greift, die erst `try_files` auf `index.html` umschreibt (`/`, `/terminal`), hängt an der Reihenfolge der Direktiven und ist an einer echten Maschine nicht nachgerechnet. Die Terminalseite verlässt sich darauf nicht (`pageshow`, Neuaufbau); für die Rezeptionsoberfläche gehört es geprüft.
- **Meldeformular ausfüllen**, sobald der Online-Check-in gemergt ist (§6).
