# Gästeterminal

Ein Touchscreen an der Rezeption, an dem ein Gast den Meldeschein ausfüllt oder unterschreibt, einer Hausbedingung zustimmt oder eine Seite des Hauses liest. Die Rezeption klickt am Rezeptionsrechner, und am Touchscreen öffnet sich, was zu tun ist; ohne Auftrag läuft eine Diashow. Dazu die kleine Lücke, die beim Bauen mitgefallen ist: die Hausnotiz am Gastprofil.

Stand: 2. Oktober 2026. Migrationen `0070`, `0071`, `0072`, `0073` — geschrieben als `0062` bis `0067` und umbenannt, weil `0068` (dauerhafter Zahlungslink) zuerst auf `main` kam: der Migrator wendet nach Namen an und übernimmt, was fehlt, und als `0064` hätte die Fassung von `audit_trigger()` auf einer frischen Datenbank vor `0068` gelegen, auf einer bestehenden danach. Geprüft beides: frischer Aufbau und Einspielen auf einen Stand bis `0068` ergeben dasselbe Schema. Code: `apps/api/src/routes/terminal.ts`, `apps/api/src/routes/terminalInhalte.ts`, `apps/api/src/platform/terminalArten.ts`, `apps/web/src/routes/Terminal.tsx`, `apps/web/src/routes/TerminalPult.tsx`, `apps/web/src/components/AmTerminal.tsx`, `apps/web/src/components/Gaesteterminals.tsx`, `apps/web/src/components/TerminalInhalte.tsx`.

---

## 1. Was der Betrieb hatte und wollte

Die Häuser schicken das Meldeformular vorab per Mail; wer das nicht möchte oder vergisst, füllt es vor Ort aus — an einem zweiten Rechner mit Touchscreen, auf dem eine Webseite läuft und fragt. Am Rezeptionsrechner ein Knopf, am Touchscreen öffnet sich das Formular. Gewünscht war dasselbe hier, und so gebaut, dass es mehr als eine Sache öffnen kann: Meldeformular ausfüllen, Meldeformular unterschreiben, und was noch dazukommt.

Gebaut sind fünf Arten (§6): **Meldeformular ausfüllen** über den Online-Check-in (Dokument 30), **Meldeschein unterschreiben**, **Hausbedingung zustimmen**, **Seite zeigen** und **freigegebene Adresse zeigen**. Dazu die Diashow im Ruhezustand (§7) und das Bedienfeld der Rezeption ohne Reservierung (§8).

---

## 2. Gerät statt Sitzung

Am Touchscreen steht ein **Gast**. Eine Mitarbeitersitzung dort öffnete ihm das ganze Haus, sobald er die Adresszeile anfasst — `/` liegt einen Fingertipp neben `/terminal`. Deshalb meldet sich das Terminal nicht an, es wird **gekoppelt**:

1. Einstellungen → Gästeterminals → Name eingeben → „Terminal koppeln". Die Schnittstelle legt das Gerät an und gibt **einmal** einen Code aus (`XXXX-XXXX`, acht Zeichen aus dem Alphabet der öffentlichen Referenzen, zehn Minuten gültig). In der Datenbank steht nur sein SHA-256.
2. Am Touchscreen `https://<haus>.staygrid.cloud/terminal` öffnen, Code eingeben. `POST /v1/terminal/pair` löst ihn ein — genau einmal: der Code fällt in derselben Anweisung, in der das Gerätegeheimnis entsteht (`terminal_device_pair()`).
3. Das Terminal bekommt dafür ein **langlebiges Geheimnis** (32 zufällige Byte) im Cookie `hp_terminal`.

**Warum ein Cookie und nicht ein Token im JavaScript.** Aus demselben Grund wie bei der Sitzung (`lib/api.ts`): `httpOnly` hält es von jedem eingeschleusten Skript fern, und ein Geheimnis, das ein Jahr am Touchscreen eines Gastes liegt, ist genau das, wonach ein solches Skript suchte. Dazu `SameSite=Strict`, `Secure` im Betrieb, und **`Path=/v1/terminal`**: der Browser schickt es an keine andere Route, auch nicht versehentlich. In der Datenbank liegt auch hier nur der Hash, und beide Hashes stehen in `audit_redaction`.

**Eine Mitarbeitersitzung im selben Browser wird beim Koppeln beendet** und ihr Cookie gelöscht. Wer an diesem Rechner danach wieder die Rezeptionsoberfläche öffnet, muss sich neu anmelden — und sollte es dort nicht tun. Der Hinweis steht neben dem Code.

### Kiosk-Adresse: für einen Browser, der alles vergisst

Edge im Kioskmodus von Windows (Assigned Access, „Digitale/interaktive Beschilderung" wie „Öffentliches Browsen") läuft laut Microsoft **immer** als InPrivate-Sitzung ([Configure Microsoft Edge kiosk mode](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-configure-kiosk-mode)). Das Cookie `hp_terminal` verschwindet damit bei jedem Neustart des Rechners und bei jedem Leerlauf-Reset, den die Windows-Einrichtung mit fünf Minuten vorschlägt. Danach stünde wieder die Codeeingabe da, und die Rezeption müsste mehrmals am Tag neu koppeln.

Deshalb gibt es neben dem Code die **Kiosk-Adresse**: Einstellungen → Gästeterminals → „Kiosk-Adresse". `POST /v1/properties/:id/terminals/:ref/kiosk-key` koppelt das Gerät sofort mit einem neuen Geheimnis und gibt es **einmal** zurück; die Oberfläche zeigt es als `https://<haus>.staygrid.cloud/terminal#k=<geheimnis>`. Diese Adresse wird im Kiosk als Startseite hinterlegt. Bei jedem Start nimmt die Seite das Geheimnis aus der Adresse (`history.replaceState`) und tauscht es über `POST /v1/terminal/resume` gegen das Cookie; ohne Netz versucht sie es weiter, weil der Browser nach einem Neustart oft vor dem Netz da ist.

- **Hinter dem `#`**, weil der Browser diesen Teil nie an einen Server schickt. Das Geheimnis steht in keiner Protokollzeile, weder bei Caddy noch in der API — nur im Rumpf der Einlöseanfrage.
- **Dasselbe Geheimnis wie im Cookie**, kein zweites. Widerruf und Neukoppeln wirken damit auf beides, und es gibt keinen zweiten Hash, der nachzutragen wäre.
- **Der Preis:** das Geheimnis liegt in der Kioskeinstellung des Windows-Rechners und für einen Augenblick im JavaScript der Seite. Wer die Adresse hat, kann sich als dieses Terminal ausgeben — also genau den eigenen Auftrag lesen, nicht mehr. Das ist dieselbe Reichweite wie das Cookie selbst, und der Hinweis neben der Adresse sagt, dass sie nicht weitergegeben wird.
- `/v1/terminal/resume` ist öffentlich wie die Kopplung, steht auf der strengen Liste und zählt seine Fehlversuche auf denselben Zähler (`limiters.kopplung`). Ein Geheimnis aus 32 Byte rät niemand; gezählt wird, damit keine öffentliche Route ein Geheimnis unbegrenzt prüfen lässt.
- Eine Mitarbeitersitzung im selben Browser endet auch hier (`geraetAnmelden`).

Ein Kiosk, der seine Cookies behält (Chrome mit festem Profil, `--kiosk`), braucht die Adresse nicht; der Code genügt.

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

`terminal:device` steht im Katalog, weil `registerRoute` nur Rechte aus dem Katalog kennt — es gibt keinen zweiten Rechteweg, und die Geräterouten fallen damit unter denselben Test über die ganze Routenliste wie jede andere. Das Recht ist **keiner Rolle** zugeordnet (Migration 0071) und als Zugriffsbereich eines Maschinenzugangs **ausgeschlossen** (`routes/oauth.ts`). Die Geräterouten prüfen zusätzlich, dass das Principal wirklich ein Gerät ist (`geraetVon`): das Recht allein genügt nie.

Abgenommen durch `terminal.test.ts`: ein gekoppeltes Terminal bekommt auf **jeder** registrierten Route außer seinen eigenen 401 oder 403 — mit dem eigenen Haus als Pfadparameter, also abgewiesen am Recht und nicht am fremden Haus.

### Ratenbegrenzung

Zwei Richtungen, beide aus CLAUDE.md:

- **Ein gekoppeltes Terminal zählt nicht als anonym.** Es fragt alle zwei Sekunden, dreißigmal je Minute, ohne Pause. Als anonym gezählt teilte es sich die Grenze mit allem, was aus derselben Herkunft unangemeldet kommt — an einer Rezeption hinter einem Anschluss die Anmeldemasken aller Arbeitsplätze und jedes weitere Terminal. `zeigtZugangsdaten` kennt deshalb `hp_terminal`; ein Cookie, das nicht trägt, wird danach wie jede ungültige Sitzung doch gezählt.
- **Ein ungekoppeltes Terminal fragt nicht.** Die Seite fragt einmal, bekommt 401 und zeigt die Kopplung — danach keine Abfrage mehr, bis gekoppelt ist. Ohne Netz fragt sie alle zehn statt alle zwei Sekunden.

**Den Code raten** verhindert ein eigener Fehlversuchszähler an der Route (`limiters.kopplung`, zehn Fehlversuche je Viertelstunde und Herkunft) — gezählt wird an der Route und nicht an der allgemeinen Grenze, weil eine Anfrage mit gültiger Sitzung die allgemeine Grenze nie erreicht. Genau das war bei `workstation-switch` passiert (H4, Dokument 25); der Test prüft es ausdrücklich **mit** gültiger Sitzung. Zusätzlich steht `/v1/terminal/pair` auf der engen Liste wie die Anmeldung. Gegen viele Herkünfte zugleich trägt die Länge: rund 6,5 · 10¹¹ Codes, zehn Minuten Laufzeit.

---

## 3. Aufträge

`terminal_job`: Haus, Gerät, Art, Bezug, Zustand, angelegt von, Zeiten. Der Bezug hängt an der Art — Reservierung und Meldeschein, Hausbedingung (`terms_id`), Seite (`content_id`), Adresse (`url_id`), beim Meldeformular der Check-in-Link (`checkin_token_id`) —, und eine Prüfbedingung je Art verlangt genau den, den sie braucht (`terminal_job_bezug`, Migration 0073). Ein Auftrag „Seite zeigen" ohne Seite ist damit keine Zeile, die erst das Terminal entdeckt.

```
pending ──öffnen──▶ opened ──abschließen──▶ done
   │                  │
   ├──Rezeption───────┴──▶ canceled (reception | terminal | timeout | revoked)
   └──3 Minuten ungeöffnet──▶ expired       (geöffnet: Sicherung nach 15 Minuten)
```

**Höchstens ein offener Auftrag je Gerät** — ein Teilindex auf `(device_id) WHERE state IN ('pending','opened')`. Zwei hießen, dass der zweite Gast die Daten des ersten sieht. Derselbe Index trägt die Frage des Terminals.

**Ablauf ohne Nachtlauf.** Ein offener Auftrag nach Fristablauf *gilt* als abgelaufen, auch wenn ihn noch niemand umgeschrieben hat: die Frage des Terminals filtert über dieselbe Bedingung, die Rezeption sieht „abgelaufen", und der nächste Auftrag an dasselbe Gerät schreibt ihn weg. Ein Pflegejob für drei Minuten alte Zeilen wäre Aufwand ohne Gegenwert.

**Kein personenbezogener Wert im Auftrag.** Er verweist auf Reservierung, Meldeschein, Bedingung, Seite oder Adresse, sonst nichts — er muss deshalb in `guest_erase_one()` nicht vorkommen. Der Verweis auf den Meldeschein ist `ON DELETE SET NULL`: die Vernichtung nach einem Jahr (§ 30 Abs. 4 BMG) darf ein alter Auftrag nicht aufhalten, ein Test führt sie als Anwendungsrolle aus.

### Rezeption

`GET /v1/reservations/:ref/terminal` liefert in **einem** Aufruf, was die Rezeption an der Reservierung braucht: Terminals (erreichbar, belegt), was sich anbietet, den Stand des Meldescheins und den letzten Auftrag. Ein Angebot ist ein Objekt — Art, bei Bedingung, Seite und Adresse auch Kennung und Bezeichnung —, weil „Hausbedingung zustimmen" je geltende Fassung einmal angeboten wird und „Seite zeigen" je Seite. Solange ein Auftrag offen ist, fragt die Oberfläche denselben Aufruf alle zwei Sekunden — „wartet", „geöffnet", „erledigt", „abgebrochen (vom Gast am Terminal)", „abgelaufen — ist es eingeschaltet?".

Der Abschnitt steht als eigene Komponente (`AmTerminal`) im Seitenfenster der Reservierung und in der Check-in-Maske. Er zeigt sich nur, wenn es ein Terminal **und** etwas anzubieten gibt. Was den Gast betrifft (Meldeformular, Meldeschein, Bedingung), steht als Knopf da; Seiten und Adressen in einer Auswahl darunter, weil es davon viele geben kann. Bei einem Terminal geht der Auftrag direkt hinaus, bei mehreren erst nach Auswahl (Escape schließt sie).

**Warum die Routen eine Reservierung nehmen und keine Property.** Das Seitenfenster kennt sein Haus nicht, und es dafür umzubauen hieße, den Zimmerplan anzufassen. `registerRoute` prüft das Recht dann nur „in irgendeinem Haus" — die Routen prüfen es deshalb noch einmal am Haus der gefundenen Reservierung (`pruefeHaus`), und das Terminal muss zu genau diesem Haus gehören. Beides hat einen Test mit zwei Häusern in einem Account.

### Terminal

`GET /v1/terminal/job` ist die Frage, alle zwei Sekunden: **zwei** Datenbankanweisungen (Gerät auflösen, Auftrag lesen), ob ein Auftrag ansteht oder nicht — ein Test zählt sie. Die Antwort trägt Hausname, Übungskennzeichen und Art und Kennung des Auftrags; **keine Gastdaten**. Die kommen erst mit `POST …/open`, also erst, wenn sie gezeigt werden — und nur, was der Gast mit seiner Unterschrift bestätigt: Name, Geburtsdatum, Staatsangehörigkeit, Anschrift, Aufenthalt, Personenzahl, bei einem Sammelmeldeschein die Namen der Mitreisenden. Keine Mailadresse, kein Telefon, kein Preis, keine Buchungsnummer, keine Ausweisnummer.

Die letzte Frage wird höchstens alle zwanzig Sekunden fortgeschrieben, in einer eigenen Tabelle ohne Audit-Trigger (`terminal_device_seen`) — am Gerät selbst schriebe jede Fortschreibung eine Zeile ins Prüfprotokoll, tausende am Tag.

---

## 4. Die Seite am Touchscreen

`/terminal` in der Web-App, außerhalb der Anmeldung wie `/einladung` (`main.tsx`). Im Ruhezustand Hausname und Begrüßung oder die Diashow (§7), oben die Sprachwahl für den Gast. Beim Meldeformular fehlt sie: das Formular des Online-Check-ins bringt seine eigene mit, und zwei Sprachwahlen übereinander wären eine zu viel.

**Keine Gastdaten über den Auftrag hinaus.**

- Die Seite benutzt **nicht** TanStack Query. Dessen Speicher hält Antworten über das Ende einer Komponente hinaus, und genau das darf hier nicht sein; die Daten stehen nur im Zustand der gerade gezeigten Ansicht.
- Nach jedem Auftrag — erledigt, vom Gast abgebrochen, von der Rezeption abgebrochen, abgelaufen — baut sich die Seite **neu auf** (`abraeumen()`: `history.replaceState`, dann `location.replace`). Dieselbe Begründung wie beim Abmelden in `main.tsx`: nur der Neuaufbau lässt garantiert nichts stehen, weder im Zustand noch im abgelösten DOM noch in der Leinwand. Die Adresse wird ersetzt, nicht ergänzt; ein „Zurück" führt nicht in die Daten des Vorgängers.
- Kommt die Seite aus dem Vor-Zurück-Speicher des Browsers zurück (`pageshow` mit `persisted`), baut sie sich ebenfalls neu auf — unabhängig davon, welche Kopfzeilen der Server gesetzt hat.
- Kein `localStorage`, kein `sessionStorage`.
- **Neunzig Sekunden ohne Berührung** brechen den Auftrag ab (`canceled_by = 'timeout'`, für die Rezeption unterscheidbar von „Gast hat abgebrochen") und räumen ab.

Ein Quelltexttest hält jede dieser Zusagen fest (`apps/web/src/__tests__/terminal.test.ts`).

**Eine eigene Bildschirmtastatur** (`components/Bildschirmtastatur.tsx`), wie im Meldeformular des Adminpanels: am Touchscreen steht keine Tastatur, und die des Betriebssystems kommt im Kioskmodus nicht oder schiebt sich in ihrer eigenen Sprache über das halbe Formular. Sie hängt **einmal an der Seite**, nicht am einzelnen Feld — jedes Textfeld, das dort den Fokus bekommt, holt sie, auch in einer Ansicht, die später dazukommt. QWERTZ mit Umlauten, `ß`, Ziffern und `@`; eine Ebene mit Akzentbuchstaben (`ø å é ç ñ ş ğ ı İ ł` …), weil der Gast, der den Meldeschein unterschreibt, ausländisch ist; ein Ziffernblock für Felder, die Ziffern erwarten. „Weiter" springt ins nächste Feld und schickt nie ab. Das Feld bekommt `inputmode="none"`, damit die Systemtastatur zu bleibt, und die Seite hält unter sich die Höhe der Tastatur frei. Sie hält nichts: was getippt wurde, steht nur im Feld. In einer freigegebenen fremden Seite (`url`) erreicht sie kein Feld — deren Inhalt ist für diese Seite unsichtbar, mit Absicht. Dort übernimmt die Bildschirmtastatur von Windows: am Touchscreen-Rechner wird sie für Berührung eingeschaltet (Windows 11: Einstellungen → Zeit und Sprache → Eingabe → Bildschirmtastatur → „Bildschirmtastatur anzeigen“: „Immer“ oder „Wenn keine Tastatur angeschlossen ist“, für das Kiosk-Konto). Auf den eigenen Seiten des Terminals bleibt sie trotzdem zu, weil jedes Feld dort `inputmode="none"` trägt; sie erscheint also nur in der fremden Seite, nie zusammen mit unserer.

**Geburtsdaten tippt der Gast am Terminal als Ziffern** (`components/Datumsfeld.tsx`, `TT.MM.JJJJ`, die Punkte setzt das Feld). In die Teilfelder von `<input type="date">` schreibt nur ein echter Tastenanschlag, und der Kalender dahinter beginnt beim heutigen Monat — vierzig Jahre Blättern bis zum Geburtsjahr. Per Mail-Link auf dem eigenen Gerät bleibt das Datumsfeld des Browsers.

**Betrieb.** Der Touchscreen läuft im Kioskmodus des Browsers (`chromium --kiosk https://…/terminal` o. ä., unter Windows Edge über Assigned Access mit der Kiosk-Adresse aus Abschnitt 2), damit der Gast weder Adresszeile noch Tabs erreicht. Das ist Einrichtung des Rechners, nicht Teil dieses Systems; Dokument 23 sagt, wer die Maschine aufsetzt, nicht den Rechner an der Rezeption.

---

## 5. Meldeschein unterschreiben

**Eine Regel, eine Stelle.** Der Meldeschein entsteht und wird unterschrieben in `platform/meldeschein.ts`: `erfasseMeldeschein()` legt ihn an — mit Unterschrift oder ausdrücklich „unterschreibt am Anreisetag" —, `unterschreibeMeldeschein()` holt die Unterschrift nach. Beide rufen dieselbe Prüfung (`pruefeUnterschrift`). Aufgerufen werden sie vom Tresen (`POST /v1/registrations`, `POST /v1/registrations/:id/sign`), von der Gastseite des Online-Check-ins und vom Terminal (`POST /v1/terminal/job/:ref/complete`). Was eine frühere Fassung dieses Dokuments `signRegistration()` nannte, ist darin aufgegangen; eine zweite Fassung der Regel gibt es nicht mehr.

**Wer unterschreibt, entscheidet der Schein, nicht die Oberfläche.** Seit dem 1.1.2025 unterschreiben nur ausländische Personen, nach **Staatsangehörigkeit** (`requiresRegistrationSignature`, die Anschrift nur, wo die Staatsangehörigkeit fehlt). Das Ergebnis steht beim Anlegen in `registration.signature_required`; jeder spätere Weg liest diese Spalte, statt die Regel neu zu rechnen. Für einen Schein ohne ausländische Person bietet `GET …/terminal` die Art gar nicht an, und die Schnittstelle weist sie mit derselben Meldung ab wie den Weg am Tresen (`registration.signatureNotForeseen`). Die Oberfläche zeigt nur, was die Schnittstelle anbietet; ein Quelltexttest hält fest, dass `AmTerminal` weder Land noch Staatsangehörigkeit liest.

**Gespeichert**: ein SVG, das ein PNG der gezeichneten Linie einbettet, aus dem gemeinsamen Unterschriftsfeld (`components/Unterschriftsfeld.tsx`) für Check-in, Gastseite, Hausbedingung und Terminal. Obergrenze `UNTERSCHRIFT_MAX_ZEICHEN` (300 000 Zeichen, `packages/contracts/src/checkin.ts`) auf jedem Weg. Wo **kein Mitarbeiter** davorsteht — Terminal und Gastseite —, wird zusätzlich genau die Form verlangt, die das Zeichenfeld erzeugt (`istUnterschriftSvg`): ein Gerät, vor dem ein Gast steht, soll kein beliebiges SVG in eine Tabelle schreiben, die ein Jahr hält.

**Der Weg im Betrieb.** Check-in-Maske, ausländischer Gast: neben „Meldeschein speichern" steht **„Anlegen, unterschreiben am Terminal"**. Der Schein entsteht ohne Unterschrift (`signatureLater: true` — ohne die Angabe bleibt es bei der Abweisung, die ein Test festhält), und darunter steht der Auftrag ans Terminal. Ist es aus, lässt sich **hier** unterschreiben. **Eingecheckt wird erst nach der Unterschrift**: die Maske sperrt den Knopf, solange sie fehlt. Das ist die vorsichtigere Lesart des Meldegesetzes (Unterschrift am Tag der Ankunft); die Schnittstelle selbst prüft beim Check-in den Meldeschein nicht und tat es nie.

**Das Haus.** `unterschreibeMeldeschein` nimmt, in welchen Häusern der Aufrufer unterschreiben darf: am Tresen jedes Haus mit `reservation:checkin`, am Terminal genau das Haus des Auftrags. Ein Schein in einem anderen Haus ist dann nicht gefunden, nicht verboten — die Antwort verrät nicht, dass es ihn gibt.

**Im Prüfprotokoll** steht das Gerät als Handelnder: `audit_log.terminal_device_id` (Migration 0072), gesetzt wie der Benutzer aus dem transaktionslokalen Kontext (`app.terminal_device_id`). Vorher stand eine Unterschrift am Terminal mit leerem Handelnden da — genau wie die Handlung eines Maschinenzugangs, und im Streitfall nicht zu unterscheiden von einer über die Schnittstelle. Bewusst eine eigene Spalte und nicht `user_id`: eine Kennung aus einer anderen Tabelle in derselben Spalte ließe jede Auswertung „wer hat was getan" still falsche Namen zuordnen. Die Unterschrift selbst steht nicht im Protokoll (`audit_redaction` seit 0044).

---

## 6. Die Arten

Eine Art ist **ein Eintrag** in `ARTEN` (`platform/terminalArten.ts`), ein Wert in der Prüfbedingung von `terminal_job.kind` (Migration 0073) und **eine Ansicht** in `ANSICHTEN` (`routes/Terminal.tsx`). Frage, Öffnen, Abbrechen, Ablauf und Aufräumen sind für alle dieselben und stehen in `routes/terminal.ts`. Jeder Eintrag sagt vier Dinge, manche ein fünftes:

| | |
|---|---|
| `mitReservierung` | ohne Reservierung sinnlos? Dann weist die Schnittstelle den Auftrag ohne ab |
| `vorbereiten` | prüft beim Anlegen und liefert den Bezug |
| `nutzlast` | was das Terminal mit dem Öffnen bekommt — und nichts darüber hinaus |
| `abschliessen` | was der Gast abschließt; `done` oder `canceled` („ging, ohne dass etwas entstanden ist") |
| `bereitsErledigt` | wahlweise: hat der Gast schon an anderer Stelle erledigt, was er sollte? Dann wird ein Abbruch zu `done` |

**Allgemein, aber kein Scheunentor.** Das Terminal zeigt, was das Haus vorher angelegt hat — einen Meldeschein, eine Hausbedingung, eine Seite, eine freigegebene Adresse —, nie etwas, das erst im Auftrag steht. Ein Rezeptionsrechner, der beliebigen Text oder beliebige Adressen auf einen Gastbildschirm schicken kann, wäre ein Werkzeug für Phishing, und der Gast hätte keinen Grund, dem Bildschirm des Hauses zu misstrauen.

| Art | Reservierung | Angeboten, wenn | Am Terminal |
|---|---|---|---|
| `registration_fill` | ja | Hauptgast da, noch kein Meldeschein | das Formular des Online-Check-ins |
| `registration_sign` | ja | Schein da, Unterschrift verlangt und offen | Daten des Scheins, Unterschriftsfeld |
| `terms_sign` | ja | je geltende Fassung ohne Zustimmung | Text, Zustimmung, bei Bedarf Unterschrift |
| `content` | nein | je Seite des Hauses | Titel, Text, Bild, „Fertig" |
| `url` | nein | je freigegebene Adresse | die Seite im Rahmen, „Fertig" |

### Meldeformular ausfüllen

Dasselbe Formular wie hinter dem Link aus der Buchungsmail (Dokument 30), im Modus des Terminals: `<GastCheckin token=… modus="terminal" onFertig=… />`. Kein zweites Formular, keine zweite Prüfung.

**Der Link entsteht beim Öffnen**, nicht beim Anlegen: `createCheckinToken(client, { reservationId, channel: 'terminal', expiresOn: <Geschäftstag>, createdBy })`. Im Klartext steht er **nur** in der Antwort auf `POST /v1/terminal/job/:ref/open` an das gekoppelte Gerät — nicht in der Frage, nicht im Protokoll (die Antwort ist `no-store`, und `pino` schreibt keinen Rumpf), nicht in der Datenbank: dort liegt wie bei jedem Check-in-Link nur sein Hash, der Auftrag hält die Kennung (`checkin_token_id`). Am Terminal geht der Link an die öffentlichen Routen des Online-Check-ins im Kopf `x-staygrid-checkin-token`, nie in der Adresse.

**Der Link fällt mit dem Auftrag**, wie immer dieser endet — erledigt, vom Gast oder der Rezeption abgebrochen, abgelaufen, das Gerät widerrufen (`zieheLinksZurueck`). Ein Link, der nach dem Auftrag noch gälte, öffnete den Meldeschein dieses Gastes für den nächsten, der an das Terminal tritt. Ein zweites Öffnen (das Terminal wurde neu geladen) zieht den ersten zurück und gibt einen neuen.

**Erledigt** ist der Auftrag, wenn die Gastseite den Link als eingereicht vermerkt hat — nicht, wenn das Terminal es behauptet. Das gilt auch umgekehrt: unter dem Dank der Gastseite steht am Terminal weiter „Abbrechen", und ein Abbruch nach dem Einreichen — vom Gast, durch Stille oder von der Rezeption — steht als erledigt da (`bereitsErledigt` in `ARTEN`). „Abgebrochen" hieße für die Rezeption: noch einmal schicken, und das scheiterte am vorhandenen Schein. Liegt schon ein Meldeschein vor, wird die Art nicht angeboten und mit 409 abgewiesen; fehlt dort nur die Unterschrift, ist `registration_sign` der Weg.

### Hausbedingung zustimmen

Über denselben Weg wie am Tresen (`stimmeBedingungZu` in `platform/hausbedingungen.ts`, aufgerufen auch von `routes/terms.ts`). Angeboten je geltende Fassung, der dieser Aufenthalt noch nicht zugestimmt hat. Eine Hausbedingung ist privatrechtlich und gilt für jeden Gast, auch den inländischen — die Meldeschein-Regel spielt hier keine Rolle. Verlangt die Fassung eine Unterschrift, zeigt das Terminal das Feld, und die Unterschrift wird geprüft wie beim Meldeschein.

### Seiten des Hauses

Einstellungen → Gästeterminals → Seiten: Titel (bis 120 Zeichen), Text (bis 5000), ein Bild. Hausordnung, WLAN, Frühstückszeiten, Ausflugstipps.

**Der Text ist kein HTML.** Ein kleines Format — Absätze, Zeilen mit `- ` als Liste, `**fett**` — wird als React-Elemente gesetzt (`components/Inhaltstext.tsx`), nie über `innerHTML`; ein Quelltexttest hält das fest. Wer mehr Gestaltung braucht, legt eine Adresse frei.

**Bilder nur als PNG, JPEG oder WebP, höchstens 1 MB.** Erkannt wird die Art an den ersten Bytes, nicht an der Angabe des Browsers oder der Dateiendung (`platform/terminalBild.ts`). **Kein SVG**: ein SVG ist ein Dokument mit Skript und Verweisen, kein Bild, und die Schnittstelle weist es ab — ein Test schickt eines mit `image/png` als Angabe. Ausgeliefert wird mit `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` und privatem Cache. Die Bytes liegen in der Datenbank (`terminal_content_image`) wie die Belege: Sicherung und Zeilenrichtlinie gelten ohne zweiten Speicher, und im Prüfprotokoll stehen sie nicht (`audit_redaction`, Migration 0070). Eine Seite hat höchstens ein Bild.

Archivieren statt löschen: eine archivierte Seite wird nicht mehr angeboten und fällt aus der Diashow, ein alter Auftrag verweist weiter auf sie.

### Freigegebene Adressen

Einstellungen → Gästeterminals → Adressen: eine Liste je Haus (`terminal_url`), nur `https`, ohne Zugangsdaten in der Adresse, ohne interne Ziele — dieselbe Prüfung wie bei Webhooks (`checkWebhookTargetUrl`). Ein Auftrag nennt nur die Kennung eines Eintrags; die Adresse selbst kommt aus der Liste, nie aus dem Auftrag. Tests schicken eine ungültige Adresse, eine nicht freigegebene und die eines anderen Hauses.

**Nicht jede Seite lässt sich einbetten.** Viele verbieten die Anzeige in einem fremden Rahmen (`X-Frame-Options`, `frame-ancestors`), und der Rahmen bleibt weiß. Erkennen lässt sich das im Browser nicht — ein gesperrter Rahmen meldet sich wie ein geladener —, deshalb sagt es der Hinweis neben der Liste, und die Vorschau zeigt es vor dem ersten Gast. **YouTube** ist der häufigste Fall: ein Video-Link (`watch`, `youtu.be`, `shorts`, `live`) wird beim Speichern und bei der Ausgabe zum Player unter `youtube-nocookie.com/embed/<ID>` (`platform/einbetten.ts`), der sich einbetten lässt und vor dem Abspielen keine Cookies setzt. Die Startseite `youtube.com` bleibt, wie sie ist, und bleibt weiß. Der Player verlangt außerdem einen Referer und meldet ohne ihn „Fehler 153“; sein Rahmen schickt deshalb als einziger die Herkunft (`strict-origin-when-cross-origin`, `lib/rahmen.ts`), alle anderen keinen.

Am Terminal steht die Seite in einem `iframe` mit `sandbox="allow-scripts allow-same-origin allow-forms"` — ohne `allow-top-navigation`, ohne `allow-popups`, ohne Downloads und Dialoge: die fremde Seite kann das Terminal nicht verlassen und kein Fenster daneben öffnen. `referrerpolicy="no-referrer"`. Darüber steht fest ein Knopf **„Fertig"**, den die Seite nicht verdecken kann.

**Viele Seiten lassen sich nicht einbetten** (`X-Frame-Options`, `frame-ancestors`). Das lässt sich im Browser nicht verlässlich erkennen — ein abgewiesener Rahmen meldet keinen Fehler an die einbettende Seite. Deshalb steht über dem Rahmen dauerhaft ein Hinweis („Bleibt die Seite leer, erlaubt sie keine Anzeige hier. Bitte fragen Sie an der Rezeption."), und in den Einstellungen zeigt eine Vorschau vor dem Freigeben, ob die Seite erscheint (Escape schließt sie). Eine Prüfung auf dem Server wäre ein Abruf beliebiger Adressen aus dem Rechenzentrum — eine zweite Fassung der Webhook-Zustellung mit ihrem SSRF-Risiko für einen Komfort.

---

## 7. Diashow im Ruhezustand

Ohne Auftrag zeigt das Terminal die Seiten, die das Haus in die Diashow aufgenommen hat, jede so lange, wie bei ihr steht (3 bis 600 Sekunden), in der eingestellten Reihenfolge. Ohne Seiten in der Diashow bleibt es bei Hausname und Begrüßung.

- `GET /v1/terminal/idle` liefert höchstens zwanzig Seiten mit Titel, Text, Dauer und Bildkennung, **nie** in der Frage nach dem Auftrag: die läuft alle zwei Sekunden und bleibt bei zwei Anweisungen. Die Diashow wird alle fünf Minuten neu geholt.
- Bilder kommen über `GET /v1/terminal/images/:ref` — nur Bilder des eigenen Hauses; ein Test fragt nach dem eines anderen.
- Die Reihenfolge setzt `PUT /v1/properties/:id/terminal-slideshow` in einer Anweisung für die ganze Liste; eine fremde oder archivierte Seite darin lässt alles unverändert (404).

Ein Auftrag unterbricht die Diashow sofort; danach baut die Seite sich wie immer neu auf und beginnt von vorn.

**Wie sie aussieht** (`components/Ruhebild.tsx`, Oktober 2026). Ein Bild füllt den ganzen Bildschirm, zoomt langsam und blendet über das vorige; Titel und Text stehen unten links auf einem Verlauf, der sie auf jedem Foto lesbar hält, der Text höchstens sechs Zeilen hoch. Eine Seite ohne Bild steht auf einem Meeresverlauf mit vollem Text — dafür sind Hinweise wie Check-out, WLAN und Parkplätze gedacht. Oben links „Willkommen" und der Hausname, oben rechts die Sprachwahl, unten rechts Uhrzeit und Datum des Geräts, unten die Punkte der Folien. Ohne Seiten in der Diashow steht der Hausname groß in der Mitte. Wer am Gerät Bewegung abgeschaltet hat (`prefers-reduced-motion`), bekommt das Überblenden ohne Zoom.

Die Fotos lädt das Haus selbst als Seiten hoch, im Repository liegt keines: die Rechte an einem Hotelfoto hat das Hotel, nicht StayGrid, und das Aussehen ist für jedes Haus dasselbe. Bilder im Querformat in voller Bildschirmbreite (1920 Pixel) wirken am besten; was nicht ins Format passt, wird beschnitten, nicht verzerrt. Schrift im Foto selbst (ein eingebranntes Logo, ein Werbebanner) steht dann über dem Titel der Seite — ein Bild ohne Aufdruck ist hier das bessere.

---

## 8. Bedienfeld der Rezeption

Seiten und Adressen gehören zu keinem Gast. Sie aus dem Seitenfenster einer Reservierung zu schicken, verlangte eine Reservierung, die mit der Sache nichts zu tun hat. Deshalb das Bedienfeld **„Terminal"** in der Navigation (`routes/TerminalPult.tsx`, Recht `reservation:checkin` wie das Schicken an der Reservierung):

- `GET /v1/properties/:id/terminal-desk` liefert in **einem** Aufruf alle Terminals des Hauses mit ihrem offenen oder letzten Auftrag (Art, Bezeichnung, Zustand) und alles, was sich ohne Reservierung schicken lässt. Ein Test zählt die Anweisungen bei einem und bei mehreren Terminals: es sind gleich viele.
- `POST /v1/terminal-jobs` nimmt entweder `reservationRef` oder `propertyId`; die Arten mit `mitReservierung` weisen den zweiten Weg ab.
- Stand live (alle zwei Sekunden, solange ein Auftrag offen ist), **Abbrechen** je Terminal.

---

## 9. Übungshaus

Ein Übungshaus darf Terminals haben — es ist zum Üben da. Nichts davon wirkt nach draußen: das Terminal schreibt nur in die eigene Datenbank (Meldeschein, Zustimmung, Auftrag), es exportiert nichts und verschickt keine Post; auch der Check-in-Link des Meldeformulars geht nicht per Mail, sondern nur an das Gerät. Die Seite zeigt im Übungshaus oben „Übungshaus", damit niemand an einem echten Touchscreen übt, ohne es zu merken.

---

## 10. Hausnotiz am Gastprofil

`POST /v1/guests/:ref/notes` gab es, eine Maske nicht — und das Profil zeigte die Notizen gar nicht, nur die Auskunft nach Art. 15. Jetzt:

- `GET /v1/guests/:ref` liefert die Hausnotizen **im selben Aufruf** mit (Haus, Verfasser, Zeitpunkt; höchstens fünfzig, die neuesten zuerst). Nur die der Häuser, die der Aufrufer sieht — das erledigt die Zeilenrichtlinie aus 0008, ein Test belegt es mit zwei Häusern.
- Am Profil steht „+ Notiz anlegen"; das Feld klappt auf, **Escape** klappt es wieder zu und verwirft den Text. Der Hinweis „eine Anforderung, nicht ihr Grund" steht am Eingabefeld, nicht in einem Handbuch.
- Höchstens 500 Zeichen. Wer mehr schreiben will, schreibt vermutlich gerade die Begründung.

**Mitbehoben:** an ein anonymisiertes Profil ließ sich eine neue Notiz hängen — und damit genau das wieder anlegen, was die Löschung entfernt hatte. Jetzt 409.

---

## 11. Was mitbehoben wurde

| Befund | Wo |
|---|---|
| `POST /v1/registrations/:id/sign` prüfte das Recht nur „in irgendeinem Haus"; wer in Haus A einchecken durfte, konnte einen Meldeschein in Haus B desselben Accounts unterschreiben lassen | `registrations.ts`, Test in `terminal.test.ts` |
| Der vorbefüllte Meldeschein lieferte seine Kennung nicht; an `/sign` kam aus der Oberfläche niemand heran | `registrations.ts` (`registrationId`) |
| Das Unterschriftsfeld rechnete Bildschirm- nicht in Leinwandkoordinaten um; in einer breiten Maske lag der Strich neben dem Finger | `components/Unterschriftsfeld.tsx` |
| Ein bloßes Antippen des Unterschriftsfelds ergab ein leeres Bild, das als Unterschrift durchging | ebenda |
| Eine Unterschrift hatte keine Größengrenze außer dem Rumpflimit | `UNTERSCHRIFT_MAX_ZEICHEN`, auf jedem Weg |
| Zwei Fassungen der Unterschriftsregel — am Tresen nach Anschrift, beim Online-Check-in nach Staatsangehörigkeit | `platform/meldeschein.ts`, `registration.signature_required` |
| Die Zustimmung zu einer Hausbedingung prüfte das Recht nur „in irgendeinem Haus" | `routes/terms.ts` (Recht am Haus der Reservierung) |
| Notiz an anonymisiertem Profil | `guests.ts` |

---

## 12. Offen

- **Kioskmodus und Rechner an der Rezeption** sind Einrichtung beim Kunden. Eine kurze Anleitung gehört in die Einweisung, nicht in `ops/`.
- **Caddy und `/terminal`.** `ops/caddy/Caddyfile` setzt `Cache-Control: no-store` mit `header /index.html …`. Ob das für Pfade greift, die erst `try_files` auf `index.html` umschreibt (`/`, `/terminal`), hängt an der Reihenfolge der Direktiven und ist an einer echten Maschine nicht nachgerechnet. Die Terminalseite verlässt sich darauf nicht (`pageshow`, Neuaufbau); für die Rezeptionsoberfläche gehört es geprüft.
- ~~**Freigegebene Adressen im Betrieb.**~~ Erledigt am 04.10.2026: `ops/caddy/Caddyfile` trägt `frame-src https:`, auf der Maschine so eingetragen. Für die ganze Seite statt nur für `/terminal`; die Begründung steht am Eintrag.
- **Ein Bild je Seite.** Mehr war nicht verlangt; eine Galerie bräuchte eine Reihenfolge und eine Grenze je Seite.
