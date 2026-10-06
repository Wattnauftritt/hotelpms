# Online-Check-in: Meldeschein vorab per Link, am Terminal vor Ort

Stand: 2. Oktober 2026. Migration `0061`, Begründungen zu allem, was in diesem Teil gebaut ist.

Der Betrieb hatte bisher ein eigenes System: Gäste bekamen das Meldeformular vorab per Mail, und wer es nicht ausfüllte, tat es vor Ort an einem Touchscreen. Das übernimmt jetzt StayGrid. Dieses Dokument beschreibt den **Gast-Teil** — Link, Gastseite, Versand vor Anreise, Anzeige an der Rezeption. Die Station im Haus (Terminal) baut darauf auf und öffnet dieselbe Gastseite im Terminalmodus; ihr Vertrag steht in Abschnitt 8.

---

## 1. Was gebaut ist, in einem Bild

```
 Worker (x Tage vor Anreise)          Rezeption (Seitenfenster)
   │ createCheckinToken('mail')          │ "Link erneut senden" / "Link kopieren"
   │ email_enqueue('checkin_invitation') │
   ▼                                     ▼
 Mail: https://app.staygrid.cloud/checkin#<token>          Station im Haus
   │                                                         │ createCheckinToken('terminal')
   ▼                                                         ▼
 Gastseite  <GastCheckin modus="mail">           <GastCheckin modus="terminal">
   │  Kopfzeile x-staygrid-checkin-token: <token>
   ▼
 /v1/checkin/form (GET, POST), /v1/checkin/signature (POST)
   │  checkin_token_open(hash): leerer Kontext → Kontext genau dieses Hauses
   ▼
 platform/meldeschein.ts  ← dieselben Regeln wie POST /v1/registrations am Tresen
```

| Teil | Wo |
|---|---|
| Schema, Rechte der Anwendungsrolle, Einlösen, Löschung | `packages/db/migrations/0061_online_checkin.sql` |
| Link ausgeben (API **und** Worker) | `packages/domain/src/checkinToken.ts` → `createCheckinToken` |
| Mailtext in vier Sprachen | `packages/domain/src/email.ts` → `renderCheckinInvitationEmail` |
| Vertrag (Kopfzeile, Link, „ausländisch", Unterschriftsform, Schemata) | `packages/contracts/src/checkin.ts` |
| Regeln des Meldescheins, eine Fassung für drei Wege | `apps/api/src/platform/meldeschein.ts` |
| Gastprofil schreiben, eine Fassung für zwei Wege | `apps/api/src/platform/gast.ts` |
| Transaktion im Kontext des Links, Stand fürs Seitenfenster | `apps/api/src/platform/checkin.ts` |
| Routen | `apps/api/src/routes/checkin.ts` |
| Versand vor Anreise | `apps/worker/src/jobs/onlineCheckin.ts` |
| Gastseite | `apps/web/src/routes/GastCheckin.tsx` |
| Rezeption: Seitenfenster, Einstellung | `components/OnlineCheckinStand.tsx`, `components/OnlineCheckinEinstellung.tsx` |

---

## 2. Rechtslage, und welche Lesart gewählt ist

Grundlage ist das Bundesmeldegesetz in der Fassung des Vierten Bürokratieentlastungsgesetzes, gültig seit dem 1. Januar 2025. Der Wortlaut von § 29 wurde für dieses Dokument nachgeschlagen ([buzer.de, § 29 BMG](https://www.buzer.de/29_BMG.htm)); § 30 nur in Zusammenfassung ([lxgesetze.de, § 30 BMG](https://lxgesetze.de/bmg/30)) — gesetze-im-internet.de war beim Schreiben nicht erreichbar. **Vor der Freigabe gehört § 30 einmal im amtlichen Wortlaut gegengelesen**; lxgesetze nennt eine Änderung vom 22.07.2026, deren Inhalt hier nicht geprüft ist.

### 2.1 Was das Gesetz sagt

- **§ 29 Abs. 2 Satz 1:** „Beherbergte ausländische Personen haben **am Tag der Ankunft** einen besonderen Meldeschein **handschriftlich** zu unterschreiben, der die in § 30 Absatz 2 aufgeführten Daten enthält."
- **§ 29 Abs. 2 Satz 2:** „Mitreisende ausländische Ehegatten, Lebenspartner und minderjährige Kinder sind auf dem Meldeschein **nur der Zahl nach** anzugeben."
- **§ 29 Abs. 2 Satz 3:** Bei Reisegesellschaften von mehr als zehn Personen trifft die Pflicht nur den Reiseleiter.
- **§ 29 Abs. 3:** Wer namentlich auf dem Schein steht, weist sich bei der Anmeldung durch **Vorlage** eines gültigen Passes oder Passersatzes aus.
- **§ 29 Abs. 5:** Die Unterschrift kann entfallen, wenn die Daten mit Zustimmung elektronisch erhoben werden und der Gast ihre Richtigkeit **am Tag der Ankunft** bestätigt — durch einen kartengebundenen Zahlungsvorgang mit starker Kundenauthentifizierung, durch den elektronischen Identitätsnachweis (eID) oder durch Vor-Ort-Auslesen der eID-Karte.
- **§ 30 Abs. 2:** Inhalt: Tag der Ankunft und voraussichtliche Abreise, Familienname, Vornamen, Geburtsdatum, Staatsangehörigkeiten, Anschrift, Zahl der Mitreisenden und ihre Staatsangehörigkeit, **Seriennummer des Passes oder Passersatzpapiers**. Der Betrieb vergleicht die Angaben mit dem Dokument und vermerkt Abweichungen.
- **§ 30 Abs. 4:** Aufbewahrung ein Jahr ab Abreise, dann Vernichtung.

### 2.2 Die Lesarten, die daraus folgen

**Die Unterschrift wird über den Mail-Link nicht geleistet.** Das ist die folgenreichste Entscheidung. „Am Tag der Ankunft" ist drei Tage vorher nicht erfüllt, und eine mit dem Finger auf dem eigenen Telefon gezogene Linie ist keines der drei Verfahren aus Absatz 5, die die Unterschrift ersetzen dürfen — die verlangen gerade eine starke Bindung an die Person, die eine Zeichnung nicht hat. Die Gastseite im Mailmodus erfasst deshalb **alles außer** der Unterschrift; der Meldeschein steht danach mit `signature_required = true` und `signed_at IS NULL` da. Unterschrieben wird am Anreisetag an der Station oder am Tresen. Die Schnittstelle setzt das durch: eine über den Mail-Link mitgeschickte Unterschrift wird verworfen, `POST /v1/checkin/signature` antwortet mit einem Mail-Link 422 `checkin.signatureOnArrival`.

Die weniger vorsichtige Lesart — Zeichnung auf dem eigenen Gerät genügt, wenn sie am Anreisetag geleistet wird — wäre bequemer und ist bewusst nicht gewählt. Sie zu ändern ist eine Zeile in `unterschriftHier()`; die Frage gehört vorher an den Datenschutzbeauftragten und an die Meldebehörde des Hauses.

**Am Terminal gilt die Zeichnung als handschriftlich** — genau so, wie das System sie am Tresen seit jeher behandelt (`signature_svg`). Wer das in Frage stellt, stellt auch den Tresen in Frage; die Entscheidung ist nicht neu, sondern übernommen. Zusätzlich gilt sie nur, wenn der Geschäftstag die Anreise erreicht hat.

**„Ausländisch" heißt: ohne deutsche Staatsangehörigkeit.** Der Meldeschein entschied bis hierher nach dem **Land der Anschrift** (`guest.country`) — eine Deutsche mit Wohnsitz in Wien hätte unterschreiben müssen, ein türkischer Staatsangehöriger aus Bremen nicht. Das Gesetz spricht von „ausländischen Personen". Jetzt entscheidet die Staatsangehörigkeit, hilfsweise der Wohnsitz, wenn keine erfasst ist (Profile aus der Zeit davor tragen oft nur das eine). Wer mehrere hat und eine davon die deutsche, ist nicht ausländisch; die Gastseite sagt das unter der Auswahl. Die Regel steht einmal, in `istAuslaendisch()` im Vertrag, und Tresen, Gastseite und Schnittstelle rufen sie.

**Steht eine ausländische Person auf dem Schein, braucht er eine Unterschrift — auch wenn der Hauptgast deutsch ist.** Bisher entschied allein der Hauptgast. Eine deutsche Reisende mit niederländischem Begleiter ergab einen Schein ohne Unterschrift, obwohl der Begleiter eine „beherbergte ausländische Person" ist. Die vorsichtige Lesart verlangt sie. Die Maske am Tresen zeigt das Unterschriftsfeld jetzt auch, sobald ein solcher Mitreisender hinzugefügt wird.

**Die Passnummer nur, wo das Gesetz sie verlangt.** § 30 Abs. 2 nennt sie für ausländische Personen. Für inländische wird eine mitgeschickte Nummer verworfen, nicht verschlüsselt abgelegt — eine Erhebung ohne Rechtsgrund bleibt eine, auch verschlüsselt. Für ausländische ist sie Pflicht und landet, wie am Tresen, verschlüsselt in `guest.id_document_number_enc` (`ID_DOCUMENT_KEY`, `platform/gast.ts`).

**Keine Ausweiskopie, und das sagt die Antwort.** Es gibt kein Feld dafür. Ein mitgeschicktes (`idDocumentScan`, oder was immer jemand erfindet) wird mit 422 `field.unknown` abgewiesen, nicht still entfernt — Fastifys Prüfung hätte es in der Grundeinstellung stillschweigend gestrichen, und der Absender glaubte dann, die Kopie liege vor. Die Gastseite hat kein Dateifeld; ein Test über die Quelle hält das fest.

**Vorlage bleibt vor Ort.** Die Seite nimmt die Nummer, sie prüft kein Dokument. § 29 Abs. 3 und § 30 Abs. 2 verlangen Vorlage und Abgleich; Mail, Gastseite und Seitenfenster sagen deshalb ausdrücklich, dass der Pass bei der Ankunft vorgezeigt wird.

### 2.3 Was offen bleibt

1. **Brauchen deutsche Gäste überhaupt noch einen Meldeschein?** § 29 Abs. 2 spricht seit 2025 nur noch von ausländischen Personen. Das System legt für deutsche Gäste weiterhin einen Schein ohne Unterschrift an — so war es vor dieser Arbeit, und daran hängen Kurtaxe, Gästeverzeichnis und Beherbergungsstatistik, für die Landes- und Kommunalrecht eigene Grundlagen hat. Ob der Schein für Inländer entfallen kann, ist eine Rechtsfrage je Bundesland und Gemeinde, keine Programmierfrage. **An den Nutzer.**
2. **Familienangehörige nur der Zahl nach.** § 29 Abs. 2 Satz 2 verlangt für mitreisende ausländische Ehegatten, Lebenspartner und minderjährige Kinder nur die Zahl. Das bestehende Modell — und mit ihm die Gastseite — erfasst jeden Mitreisenden namentlich mit Geburtsdatum und Staatsangehörigkeit, weil der Sammelmeldeschein und die Kurtaxe daran hängen (Dokument 16). Datensparsamer wäre, bei Familien nur die Zahl zu nehmen; das ist ein Umbau des Sammelmeldescheins und der Kurtaxberechnung, nicht dieses Teils.
3. **Erwachsene ausländische Mitreisende ohne Familienbezug** müssten streng genommen einen eigenen Schein mit eigener Unterschrift haben. Das System kennt eine Unterschrift je Sammelschein. Die Gastseite begrenzt Mitreisende auf neun; größere Gruppen gehen an den Tresen.
4. **§ 29 Abs. 5 (eID, Zahlung mit starker Authentifizierung)** ist nicht gebaut. Mit ihm ließe sich die Unterschrift am Anreisetag ganz ersetzen — über den Zahlungsdienstleister (Pay-by-Link, Aufgabe 6) wäre der erste Weg nicht weit. Das wäre die eigentliche Lösung für „ganz ohne Tresen" und gehört in eine eigene Aufgabe.

---

## 3. Datenschutz

### 3.1 Rechtsgrundlage

**Der Meldeschein selbst:** Art. 6 Abs. 1 lit. c DSGVO in Verbindung mit §§ 29, 30 BMG — eine gesetzliche Pflicht des Hauses.

**Die Mail mit dem Link:** Art. 6 Abs. 1 lit. b DSGVO, Durchführung des Beherbergungsvertrags. Sie bietet einen zweiten Weg zu einer Pflicht an, die mit dem Vertrag ohnehin entsteht, und verwendet nur die Adresse, die der Gast für diese Buchung angegeben hat. Sie ist keine Werbung und braucht deshalb weder Einwilligung noch Widerspruchsmöglichkeit nach § 7 UWG; sie sagt ausdrücklich, dass der Weg freiwillig ist und das Ausfüllen bei der Ankunft genauso geht. Damit die Abgrenzung zur Werbung hält, steht in der Mail nichts außer dem Check-in: kein Angebot, kein Upgrade, kein Newsletter. Wer das ändern will, ändert die Rechtsgrundlage mit.

**Informationspflicht (Art. 13):** steht auf der Gastseite an der Stelle, an der erhoben wird — wer erhebt, wozu, wie lange, an wen —, nicht hinter einem Link, den es am Terminal nicht gibt.

### 3.2 Was die Seite zeigt

Name, Zeitraum, Haus. Keine Anschrift, kein Geburtsdatum, keine Passnummer, kein Preis, keine anderen Gäste. Vorbefüllt wird nur der Name. Ein Link kann weitergeleitet werden; wer ihn aus einem fremden Postfach öffnet, soll nicht mehr erfahren, als im Betreff der Mail stand. Der Preis dafür ist, dass ein Stammgast seine Anschrift neu eintippt. Die Antwort trägt `Cache-Control: no-store`.

### 3.3 Der Link

- **256 Bit** aus `randomBytes` (`neuesToken()`, dieselbe Funktion wie Einladung und Kennwortrücksetzung), base64url.
- **In der Datenbank nur der SHA-256-Hash**, und die Datenbank sieht den Klartext nicht einmal als Parameter: der Hash entsteht in `createCheckinToken`.
- **`token_hash` steht in `audit_redaction`**: das Protokoll hält fest, *dass* ein Link ausgegeben oder zurückgezogen wurde, nicht welcher.
- **Befristet bis spätestens Abreisetag**, geprüft gegen den **Geschäftstag** des Hauses, nicht gegen `now()`. Die SQL-Funktion kappt jede längere Frist.
- **Widerrufbar** (`revoked_at`). Die Anwendungsrolle darf an der Tabelle nur `revoked_at` und `completed_at` ändern — kein `UPDATE` auf Hash oder Frist (das wäre ein Weg, einen alten Link wiederzubeleben), kein `DELETE` (das verwischte die Spur einer Ausgabe). Ein Test prüft beides.
- **Ungültig, sobald** die Reservierung storniert, abgereist oder No-Show ist, der Gast gelöscht, das Haus oder der Kunde stillgelegt.

### 3.4 Der Link im Protokoll

Drei Stellen, an denen ein Token liegen bleiben könnte, und keine davon lässt es liegen:

| Stelle | Was dort steht |
|---|---|
| **Anfrageprotokoll der API** | Das Token reist in der Kopfzeile `x-staygrid-checkin-token`, **nicht im Pfad**. Der `req`-Serialisierer in `platform/app.ts` ersetzt Werte der Abfragezeichenfolge, aber nicht den Pfad — ein Token als Pfadsegment stünde im Protokoll. Kopfzeilen schreibt er gar nicht mit; die Kopfzeile steht trotzdem auf der Redaktionsliste von pino, falls ihn jemand erweitert. Ein Test liest das geschriebene Protokoll. |
| **Caddy, Proxys, Referer** | Der Link aus der Mail trägt das Token im **Fragment** (`/checkin#…`). Ein Fragment verlässt den Browser nie. `ops/caddy/Caddyfile` hat ohnehin kein Zugriffsprotokoll (`log` fehlt); sollte es eines bekommen, steht das Token trotzdem nicht darin. |
| **Postausgang** | Im Rumpf der Einladung steht der Link im Klartext. Der Worker leert Rumpf und HTML-Teil, sobald die Nachricht angenommen oder endgültig aufgegeben ist, ebenso das Zurückziehen einer wartenden Nachricht — dieselbe Regel wie bei der Zugangspost (`platformEmail.ts`). Betreff, Empfänger und Zeitpunkt bleiben: „ist die Einladung rausgegangen" lässt sich weiter beantworten. |

Bleibt der Browser des Gastes: im Mailmodus steht das Fragment in seinem eigenen Verlauf, wie jeder andere Link aus seinem Postfach. Am Terminal gibt es keine Adresse mit Token (die Station reicht es als Eigenschaft an die Komponente).

### 3.5 Löschung

Die Links gehören zum Gast und fallen in `guest_erase_one()` **und** `guest_erase_partial()` — beide in `0061` vollständig neu geschrieben, weil PostgreSQL eine Funktion nicht teilweise ersetzen kann; gegenüber `0046` kommt in jeder genau ein `DELETE` hinzu. Nicht in der Route, nicht im Nachtlauf (CLAUDE.md). Ein alter Link öffnet nach der Löschung nichts mehr; ein Test prüft beide Wege. Die Einladungsmail fängt der bestehende Block über `outbound_email.reservation_id` ab. Neue Spalten mit Personenbezug gibt es sonst nicht: `registration.source` und `signature_required` bezeichnen niemanden.

### 3.6 Was das Terminal nicht behalten darf

Die Gastseite hält ihren Zustand selbst und **nicht** im Zwischenspeicher von TanStack Query: der behielte eine Antwort nach dem Schließen noch Minuten, und am Terminal steht danach der Nächste vor demselben Browser. Kein `localStorage`, kein `sessionStorage`; die Passnummer trägt `autocomplete="off"`. Am Terminal geht die Seite nach drei Minuten ohne Eingabe und zwanzig Sekunden nach dem Dank von selbst zurück (`onFertig`). Tests über die Quelle halten das fest.

---

## 4. Mandantentrennung ohne angemeldeten Benutzer

Die Gastseite hat keinen Benutzer und damit keinen Mandantenkontext. Ohne ihn liefert jede Tabelle mit Zeilenrichtlinie **leise nichts** — der Fehler, der hier zweimal passiert ist (Migrationen 0014, 0018). Zwei naheliegende Auswege sind beide falsch: eine Eigentümerverbindung in der API wäre ein stehender `BYPASSRLS` im Anfrageprozess; eine Abfrage „ohne Kontext, aber mit WHERE" fände nichts.

Gewählt ist das Muster von `account_provision` (Aufgabe 13b): **eine schmale `SECURITY DEFINER`-Funktion**, `checkin_token_open(hash)`. Sie

1. verlangt einen **leeren** Kontext und bricht sonst ab — eine angemeldete Sitzung oder der Worker sollen ihren Kontext nicht über einen Link umbiegen; ein Test ruft sie mit gesetztem Kontext und erwartet den Abbruch,
2. liest **genau eine Zeile** über den Hash,
3. setzt, wenn der Link gilt, den Kontext der Transaktion auf **genau dieses Haus und diesen Account** (`set_config(..., true)`, transaktionslokal).

Danach läuft alles unter der Zeilenrichtlinie wie jede andere Anfrage, und zwar in **derselben** Transaktion (`checkinTx` in `platform/checkin.ts`) — zwischen Einlösen und Schreiben kann der Link nicht widerrufen werden. Die Route schränkt zusätzlich auf die eine Reservierung des Links ein; hält sie das einmal nicht ein, bleiben fremde Häuser trotzdem draußen. Ein Test belegt, dass nach dem Einlösen `app_property_ids()` genau das Haus des Links enthält und eine Abfrage ohne `WHERE` nur dessen Reservierungen sieht.

Das ist dieselbe Regel wie überall — „der Kontext kommt aus dem Token, nie aus Pfad, Query oder Rumpf" —, nur dass das Token hier ein Link ist und kein Sitzungscookie.

**`registerRoute` mit `permission: null`** für die drei Gast-Routen, jeweils mit Begründung am Eintrag. Die Rezeptionsrouten tragen Rechte: Link kopieren und zurückziehen `reservation:checkin` (wer den Meldeschein am Tresen erfassen darf, darf dem Gast den Weg geben, es selbst zu tun), per Mail senden `email:send`, Einstellung `settings:property`. Neue Rechte gibt es keine.

**Nur an die Adresse am Profil.** Anders als die Rechnung kennt der Versand des Links keine abweichende Adresse: der Link öffnet den Meldeschein dieses Gastes, und eine Route, die ihn an eine frei wählbare Adresse schickt, wäre ein Weg, ihn jemand anderem zu geben.

### Ratenbegrenzung

Die Gast-Routen sind anonym und fallen unter die allgemeine Grenze je Herkunft (300 je Minute, `platform/rateLimit.ts`). Ein Gast braucht drei bis fünf Anfragen; auch eine Familie im Hotel-WLAN hinter einer Adresse kommt nicht in die Nähe. Einen eigenen Zähler wie beim Arbeitsplatz-PIN (H4, Dokument 25) braucht es nicht: dort war das Geheimnis vier Ziffern lang, hier sind es 256 Bit. Die Station im Haus ist vermutlich angemeldet und damit gar nicht begrenzt; ihre Anfragen tragen das Cookie, aber der Kontext kommt trotzdem aus dem Link, nicht aus der Sitzung.

---

## 5. Eine Fassung der Regeln

Die Aufgabe verlangte ausdrücklich, denselben Weg zu benutzen wie der Tresen. Dafür sind zwei Stellen aus den Routen herausgezogen:

- **`platform/meldeschein.ts`** — `erfasseMeldeschein()` und `unterschreibeMeldeschein()`. `POST /v1/registrations`, `POST /v1/registrations/:id/sign` und die drei Gast-Routen rufen sie. Unterschiedlich ist allein, **wann** unterschrieben wird: `{ art: 'jetzt', svg }` am Tresen und an der Station, `{ art: 'amAnreisetag' }` über den Link. Die Frist (ein Jahr ab Abreise), der Sammelmeldeschein und der Eintrag in `reservation_occupant` (der Fehler aus Dokument 16) stehen einmal.
- **`platform/gast.ts`** — `gastAnlegen()` und `gastAendern()`. Vorher stand das `INSERT`/`UPDATE` des Gastprofils nur in `routes/guests.ts`; eine zweite Fassung auf der Gastseite wäre genau die Bauart, bei der die Ausweisnummer an einer Stelle verschlüsselt wird und an der anderen nicht.

Die Gastseite schreibt ins Gastprofil: Name, Geburtsdatum, Staatsangehörigkeit, Anschrift, bei Ausländern Dokumentart und -nummer. **E-Mail und Telefon nicht** — an die Adresse ging der Link, und über eine Seite ohne Anmeldung soll sie niemand umbiegen können. Mitreisende werden als eigene Profile angelegt; eine Dublettenprüfung wie am Tresen gibt es dabei bewusst nicht, weil sie dem Gast fremde Profile zeigen würde.

---

## 6. Versand vor Anreise

`apps/worker/src/jobs/onlineCheckin.ts`, je Haus in jedem Tick vor der Zustellung der Gastpost.

| Bedingung | Warum |
|---|---|
| Einstellung am Haus eingeschaltet, Vorgabe **aus**, drei Tage | Ein Haus soll nicht durch eine Auslieferung plötzlich Gäste anschreiben (wie beim Gastversand, 0028). Drei Tage: früh genug für zu Hause, spät genug, dass die Buchung nicht mehr wackelt; mehr als vierzehn sind nicht einstellbar. |
| Status **`Confirmed`**, nicht `Optional` | Eine Option ist noch keine Buchung. Einen Gast um Geburtsdatum und Passnummer für einen Aufenthalt zu bitten, der vielleicht nie zustande kommt, ist eine Erhebung auf Vorrat (Art. 5 Abs. 1 lit. c DSGVO). |
| Anreise **nach** dem Geschäftstag und höchstens *x* Tage danach | Am Anreisetag selbst steht der Gast im Zweifel schon am Tresen oder an der Station. Wer kurzfristig bucht, bekommt den Link beim nächsten Lauf. |
| Gegen den **Geschäftstag**, nicht `now()` | Ein Wiederholungslauf findet dieselben Zeilen und keine anderen (CLAUDE.md). Ein Test stellt den offenen Tag ein halbes Jahr zurück und erwartet die Mail trotzdem. |
| Hauptgast mit brauchbarer Adresse, nicht gelöscht, keine Löschung beantragt | Eine Löschung soll nicht über einen Link unterlaufen werden. |
| Noch kein Meldeschein, noch kein Mail-Link | Wer schon ausgefüllt hat oder dem die Rezeption den Link schon geschickt hat, bekommt keine zweite Mail. |
| Kein Übungshaus, Gastversand an, Absenderdomain freigeschaltet (auch die Plattform-Unterdomain) | `email_enqueue` prüft das selbst und bricht sonst ab — richtig für eine Route, falsch für einen Stapel, dessen Abbruch alle anderen Gäste des Hauses mitnähme. Die Abfrage fragt deshalb vorher; der Zaun in der Funktion bleibt der, der hält. |

**Genau einmal.** Die Abfrage schließt Reservierungen mit einem Mail-Link aus; zwei gleichzeitige Läufe sähen trotzdem beide „noch keiner". Dagegen steht ein eindeutiger Teilindex über `reservation_id` für den automatischen Link (`channel = 'mail' AND created_by IS NULL`): `createCheckinToken` gibt dann `null`, und es wird nichts eingereiht. Von Hand ausgegebene Links zählen nicht mit, damit „erneut senden" geht.

**Sprache** nach dem Gastprofil über `emailLanguage()` — Deutsch, Englisch, Niederländisch, Polnisch, sonst Deutsch. Die Sätze stehen als Tabelle je Sprache in `email.ts`, mit Platzhaltern statt Zusammensetzen. Der Satz zur Unterschrift steht für jeden da: die Staatsangehörigkeit kennt das Haus vor dem Ausfüllen oft gar nicht, und eine Mail, die sie errät, rät falsch.

### 6.1 Vorschau und Testmail

Unter der Einstellung (Einstellungen, Online-Check-in) steht die Einladung so, wie ein Gast sie heute bekäme — Hausname und Anreisedatum echt, Gast, Buchungsnummer und Link erfunden —, in jeder Sprache der Gastpost, mit den Voraussetzungen einzeln abgehakt: kein Übungshaus, Gastversand an, Absenderdomain freigeschaltet, und ob der Vorabversand selbst an ist. Darunter geht dieselbe Einladung als **Testmail an eine Adresse nach Wahl** (Migration `0095`, Art `checkin_invitation_test`).

| Entscheidung | Warum |
|---|---|
| Dieselbe Vorlage, davor ein Hinweis, im Betreff `[TEST]` | Geprüft werden soll, was der Gast bekommt; eine eigene Testvorlage wiche irgendwann ab. Der Hinweis verhindert, dass eine weitergeleitete Testmail für eine echte Einladung gehalten wird. |
| Beispieldaten und ein Link ohne Token | Eine Mail mit dem Link einer echten Buchung an eine frei wählbare Adresse wäre genau der Weg, den „erneut senden" verschließt (nur an die Adresse am Gastprofil). Das Formular selbst prüft man an einer Testbuchung mit „Link kopieren". |
| Eigene Art ohne Bezug, nicht `checkin_invitation` | Die Einladung hängt an einer Reservierung, damit die Löschung sie findet. Die Prüfbedingung hält fest, dass eine Testmail an **keiner** hängt. |
| Durch `email_enqueue`, unabhängig vom Schalter für den Vorabversand | Übungshaus, Gastversand und Absenderdomain gelten wie für jede Gastpost — das ist, was der Test zeigen soll. Der Vorabversand bleibt aus, bis jemand ihn bewusst einschaltet. |
| Höchstens zehn je Stunde und Haus, gezählt im Postausgang | Die allgemeine Ratenbegrenzung erreicht eine angemeldete Anfrage nicht; eine Route, die an beliebige Adressen schreibt, wäre ohne Grenze ein Werkzeug für Spam unter dem Namen des Hauses. |

Nach dem Senden fragt die Maske im Postausgang nach, bis die Nachricht vom Anbieter angenommen oder endgültig gescheitert ist; zugestellt wird im Takt des Workers.

**Nebenbei behoben.** Die deutschen Vorlagen der Gastpost standen in Umschrift („Gäste" als „Gaeste", „für" als „fuer") — gesehen hat das niemand, bis es eine Vorschau gab. Ein Test hält die Umlaute jetzt fest.

---

## 7. An der Rezeption

**Seitenfenster der Reservierung.** Der Stand kommt mit `GET /v1/reservations/:ref` (`onlineCheckin`), nicht als eigener Aufruf: verschickt am, wartet, gescheitert; online oder am Terminal ausgefüllt am; Unterschrift steht aus; Zahl gültiger Links. Dazu „Link erneut senden", „Link kopieren" und „Links zurückziehen", jeweils nur, wenn die Schnittstelle sie erlaubt (`mayLink`, `maySend` — sie kennt das Haus der Reservierung, das Fenster nicht). Der kopierte Link steht danach markierbar im Fenster, mit dem Hinweis, ihn nur dem Gast selbst zu geben.

**Check-in-Maske.** Liegt ein vorab erfasster Schein mit offener Unterschrift vor, zeigt sie das Unterschriftsfeld und gibt „Einchecken" erst danach frei. Damit ist nebenbei die Lücke aus Dokument 16 geschlossen: „Meldeschein nachträglich unterschreiben" hatte eine Route und keine Maske.

**Einstellungen → Online-Check-in**, unter `settings:property`.

---

## 8. Vertrag mit der Station im Haus (Terminal)

Die Station gibt einen eigenen Link aus und bettet die Gastseite ein. Mehr braucht sie nicht.

**Link ausgeben** — in einer Route der API, in deren Transaktion (Kontext des Hauses):

```ts
import { createCheckinToken } from '@hotelpms/domain'

const t = await createCheckinToken(client, {
  reservationId,            // interne id der Reservierung
  channel: 'terminal',
  expiresOn: geschaeftstag, // optional; nie später als die Abreise
  createdBy: principal.userId
})
// t: { token: string, tokenId: number, expiresOn: string } | null
// null nur beim automatischen Mail-Versand (channel 'mail' ohne createdBy)
```

Voraussetzungen, die die SQL-Funktion prüft: die Reservierung liegt im Kontext des Aufrufers, sie hat einen Hauptgast. Den Klartext gibt es genau einmal, als Rückgabewert; die Station reicht ihn an die Komponente weiter und legt ihn nirgends ab.

**Einbetten** — innerhalb der laufenden Oberfläche:

```tsx
import { GastCheckin } from '../routes/GastCheckin.tsx'

<GastCheckin token={t.token} modus="terminal" onFertig={() => zurueckZurStation()} />
```

Im Modus `terminal`: große Bedienelemente und Unterschriftsfeld, Sprachwahl als Knöpfe, keine Links nach außen, Unterschrift erlaubt, sobald der Geschäftstag die Anreise erreicht hat; nach dem Dank, nach zwanzig Sekunden oder nach drei Minuten ohne Eingabe ruft sie `onFertig`. Die Komponente bringt ihren eigenen Sprachkontext mit und verändert die Sprache des Personals nicht. Hat der Gast vorab per Link ausgefüllt, zeigt sie nur noch das Unterschriftsfeld.

**Schnittstelle der Gastseite** (für den Fall, dass die Station selbst etwas braucht):

| Methode und Pfad | Recht | Kopfzeile | Rumpf, Antwort |
|---|---|---|---|
| `GET /v1/checkin/form` | öffentlich | `x-staygrid-checkin-token` | → `CheckinFormView` (`@hotelpms/contracts`) |
| `POST /v1/checkin/form` | öffentlich | dito | `CheckinSubmit` → 201 `{ state: 'done' \| 'signatureOnly' }` |
| `POST /v1/checkin/signature` | öffentlich | dito | `{ signatureSvg }` → `{ state: 'done' }`; nur `terminal` am Anreisetag |
| `POST /v1/reservations/:ref/online-checkin/link` | `reservation:checkin` | — | → 201 `{ link, expiresOn }` (Kanal `mail`) |
| `POST /v1/reservations/:ref/online-checkin/send` | `email:send` | — | → 202 `{ messageRef }` |
| `POST /v1/reservations/:ref/online-checkin/revoke` | `reservation:checkin` | — | → `{ revoked }` |
| `GET`/`PUT /v1/properties/:id/online-checkin-settings` | `settings:property` | — | `{ enabled, daysBefore }` |

Antworten auf ungültige Links: 404 (unbekannt oder verstümmelt), 410 mit `checkin.linkExpired`, `checkin.linkRevoked` oder `checkin.reservationClosed`.

**Die Unterschrift** muss genau die Form haben, die `components/Unterschriftsfeld.tsx` erzeugt (`istUnterschriftSvg` im Vertrag): ein SVG mit einem PNG als data-URL darin und nichts sonst. Auf einer öffentlichen Seite schickt ein Fremder, was er will, und ein SVG kann Skript und Verweise nach außen tragen — es wird später einem Menschen gezeigt, wenn die Meldebehörde Einsicht nimmt. Der Tresen nimmt weiterhin jede Zeichenkette an; ihn auf dieselbe Prüfung zu stellen, ist eine kleine Folgearbeit.

---

## 9. Nebenbei gefunden und behoben

1. **„Ausländisch" nach Wohnsitz statt Staatsangehörigkeit** (Abschnitt 2.2). Betraf jeden Meldeschein am Tresen.
2. **Ein ausländischer Mitreisender verlangte keine Unterschrift**, solange der Hauptgast deutsch war (Abschnitt 2.2).
3. **Das Zeichenfeld traf den Finger nicht**, sobald es breiter angezeigt wurde als seine Auflösung: die Koordinaten waren nicht umgerechnet. Am Tresen kaum aufgefallen, an einem Terminal nicht zu übersehen. Das Feld liegt jetzt einmal in `components/Unterschriftsfeld.tsx`.
4. **Nachträglich unterschreiben hatte keine Maske** (Dokument 16, „Was der Oberfläche noch fehlt"); jetzt in der Check-in-Maske, wo die offene Unterschrift ohnehin auffällt.

---

## 10. Offen

- Die Rechtsfragen aus Abschnitt 2.3, vor allem die erste.
- `§ 29 Abs. 5`: Bestätigung per Zahlungsvorgang oder eID statt Unterschrift.
- Abgelaufene Links werden nicht aufgeräumt. Sie tragen keinen Personenbezug außer dem Verweis auf die Reservierung, die ohnehin bleibt; ein Pflegejob, der sie ein Jahr nach Ablauf entfernt, wäre trotzdem sauberer.
- ~~Hausbedingungen sind auf der Gastseite nicht dabei.~~ Seit 05.10.2026 (Sven) zeigt die Gastseite die offenen Hausbedingungen des Anreisetags vollständig, verlangt die Zustimmung und, wo die Fassung es will, eine Unterschrift — auch von zu Hause und von inländischen Gästen, weil die Hausbedingung privatrechtlich ist und § 29 Abs. 2 BMG für sie nicht gilt. Gespeichert über `stimmeBedingungZu`, also je Fassung. Dazu je Person die Kurtaxe-Befreiung mit den Gründen des Hauses (Migration 0089, Arbeitsstand in Dokument 16).
- Die Gastseite kennt Deutsch, Englisch und Türkisch (`LOCALES`); die Mail Deutsch, Englisch, Niederländisch und Polnisch (`EMAIL_LANGUAGES`). Ein niederländischer Gast bekommt die Mail auf Niederländisch und die Seite auf Englisch. Beide Listen zusammenzuführen ist eine Übersetzungsaufgabe für Oberfläche **und** Meldungskatalog, keine dieses Teils.
