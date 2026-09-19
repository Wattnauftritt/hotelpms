# Sicherheitsprüfung des gesamten Systems

Stand: 19.09.2026, gegen `main` bei `62694b8`. Geprüft wurden 261 Quelldateien, 40 Migrationen und 150 Routen, dazu die Betriebsdateien in `ops/`.

Diese Prüfung ist eine **Lesung mit Gegenproben**, kein Penetrationstest. Wo ein Befund nachweisbar war, steht der Nachweis dabei; wo er es nicht war, steht das auch.

Der Stand ist ein Datum, kein Dauerzustand: nach `62694b8` sind die Migrationen 0041 und 0042 und die Änderungen am Ausrollpanel dazugekommen, und sie sind hier **nicht** geprüft. Eine Gegenprobe an ihnen hat nichts gefunden, was einen Befund aufwirft — die drei Routen liegen hinter `platform:operations` und laufen in `tx(...)`, `release` trägt keine Mandantendaten. Wer den Bericht später liest, rechnet ab dieser Stelle selbst weiter.

---

## 1. Das Ergebnis in einem Absatz

Das System ist in den Bereichen, in denen ein Hotel-PMS üblicherweise scheitert, **auffallend solide**: keine SQL-Einschleusung, keine Rechteausweitung über Rollen, saubere Mandantentrennung, Argon2id mit Blindhash, zeitgleiche Vergleiche an jeder Signaturprüfung, ein enger Content-Security-Policy-Kopf. Mehrere Stellen tragen Kommentare über Löcher, die schon einmal offen waren und geschlossen wurden — das ist ein gutes Zeichen, kein schlechtes.

Gefunden wurden **zwei Befunde mittleren Grades** und sieben Härtungspunkte. Einer der beiden verletzt eine Regel, die `CLAUDE.md` selbst als nicht verhandelbar führt.

| | Befund | Grad |
|---|---|---|
| **B1** | Ausgehende Anfragen an kundengesteuerte Adressen (SSRF) über Webhook-Abonnements | **mittel** |
| **B2** | Gastdaten im Anwendungsprotokoll über die Abfragezeichenfolge | **mittel** |
| H1 | `audit_log` ohne Zeilenrichtlinie, Anwendungsrolle darf lesen | niedrig |
| H2 | `rate_plan_product` ohne Mandantenbezug | niedrig |
| H3 | Kontosperre als gezielte Dienstverweigerung | niedrig, abgewogen |
| H4 | Ratenbegrenzung nimmt angemeldete Anfragen aus | strukturell |
| H5 | Sieben Abhängigkeitsbefunde, alle im Werkzeug | niedrig |
| H6 | Fälschbarer Prüfeintrag beim Lesen der Ausweisnummer | niedrig |
| H7 | `style-src 'unsafe-inline'` im CSP | gering |

---

## 2. B1 — Ausgehende Anfragen an kundengesteuerte Adressen

**Wo.** `apps/api/src/routes/webhooks.ts:72` prüft die Zieladresse eines Abonnements so:

```ts
if (typeof body.url !== 'string' || !body.url.startsWith('https://')) {
  throw Errors.validation({ url: ['field.httpsOnly'] })
}
```

Das ist die **einzige** Prüfung. `apps/worker/src/jobs/webhookDelivery.ts:106` schickt danach ein `fetch` mit POST an genau diese Adresse — aus dem Netz des Betreibers heraus.

**Warum das mehr ist als ein Schönheitsfehler.** Erlaubt sind damit unter anderem:

- `https://127.0.0.1:8443/`, `https://[::1]/`, `https://localhost/`
- `https://10.0.0.7/`, `https://192.168.1.1/`, `https://169.254.169.254/`
- jeder interne Name, den die Namensauflösung des Hosts kennt

Der Wurm daran ist nicht die Anfrage, sondern die **Antwort**. `webhook_delivery_attempt` hält `status_code` und `error` fest, und `GET /v1/webhook-subscriptions/:ref/deliveries` gibt beides an den Kunden zurück (`routes/webhooks.ts:204-206`):

```
'attempt', t.attempt, 'statusCode', t.status_code,
'error', t.error, 'durationMs', t.duration_ms,
```

Damit ist es keine blinde, sondern eine **auskunftsfreudige** SSRF: verweigerte Verbindung, Zeitüberschreitung, Namensauflösung fehlgeschlagen, 401, 404, 200 — das sind verschiedene Antworten, und aus ihnen lässt sich das innere Netz kartieren. Der Rumpf der Antwort wird nicht gespeichert; Statuscode, Fehlertext (500 Zeichen) und Dauer genügen aber für Wirt- und Portabtastung.

**Wer es kann.** Jeder angemeldete Benutzer mit `integration:manage` — also die Hausleitung eines beliebigen Kunden. Das ist keine hohe Hürde in einem System, das mehrere Kunden auf einer Maschine führt.

**Was dagegen spricht, es klein zu nennen.** Dokument 17 §1 sieht Entsperrung über einen **Tang-Server** im selben Netz vor. Ein Dienst, dessen einziger Schutz seine Unerreichbarkeit von außen ist, wird durch diesen Weg erreichbar.

**Empfohlene Abhilfe**, in dieser Reihenfolge:

1. **Beim Anlegen** den Namen auflösen und jede Adresse ablehnen, die nicht öffentlich routbar ist: Loopback, Link-Local (`169.254/16`, `fe80::/10`), private Bereiche (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), Multicast, `0.0.0.0/8`. Adressliterale in der URL ganz ablehnen — ein Webhook-Ziel hat einen Namen.
2. **Bei der Zustellung erneut prüfen.** Zwischen Anlage und Zustellung liegt die Namensauflösung; wer beim Anlegen auf einen öffentlichen Namen zeigt und ihn danach auf `127.0.0.1` umlegt, käme sonst durch (DNS-Rebinding). Sauber gelöst mit einem eigenen `lookup` im `fetch`-Agenten, der die aufgelöste Adresse prüft, statt zweimal getrennt aufzulösen.
3. **Umleitungen nicht folgen** (`redirect: 'manual'`). Sonst genügt ein öffentlicher Wirt, der mit `302` auf `http://169.254.169.254/` antwortet.
4. Wenn der Betrieb es zulässt: ausgehend über einen festen Vermittler mit Positivliste, statt jeden Ausgang zu erlauben.

Punkt 3 ist der billigste und schließt den bequemsten Weg — er sollte in jedem Fall kommen.

---

## 3. B2 — Gastdaten im Protokoll

**Die Regel.** `CLAUDE.md`, Abschnitt „Datenschutz und deutsches Recht": *„Keine Gastdaten in Protokollen. `pino` ist entsprechend eingerichtet; wer ein Feld hinzufügt, prüft die Redaktionsliste."*

**Was die Liste abdeckt** (`apps/api/src/platform/app.ts:38-42`):

```ts
redact: {
  paths: ['req.headers.authorization', 'req.headers.cookie',
          'req.body', 'res.body', '*.password', '*.idDocumentNumber'],
  remove: true
}
```

Kopfzeilen, Rumpf, Kennwort, Ausweisnummer — gründlich. **Nicht abgedeckt ist die Adresse selbst**, und Fastify protokolliert sie mitsamt Abfragezeichenfolge.

**Nachweis, aus dem Protokoll dieser Prüfung:**

```
"url":"/v1/companies?q=Werft"
"url":"/v1/companies?q=Kontor"
```

Derselbe Weg gilt für `GET /v1/guests?q=…` (`routes/guests.ts:107-116`): der Suchbegriff ist der **Nachname eines Gastes**, und er landet im Protokoll — bei jeder Suche, in jeder Zeile, mit Zeitstempel und Anfrage-ID daneben.

**Warum das zählt.** Ein Protokoll geht andere Wege als eine Datenbank: es wird eingesammelt, weitergeleitet, länger aufbewahrt und von mehr Leuten gelesen. Die achtjährige Aufbewahrung gilt für Buchungsbelege, nicht für die Tatsache, dass jemand am Dienstag nach „Petersen" gesucht hat. Und die Anonymisierung eines Gastes (`routes/guests.ts:291`) erreicht das Protokoll nicht — **nach der Löschung steht der Name dort weiter**.

**Empfohlene Abhilfe.** Ein eigener `req`-Serialisierer, der `routerPath` statt `url` protokolliert (also `/v1/guests` statt `/v1/guests?q=Petersen`), oder der die Abfragezeichenfolge nach einer Positivliste harter Parameter filtert — `from`, `to`, `limit`, `kind` sind harmlos und für die Fehlersuche nützlich, `q` ist es nicht. Der Serialisierer ist die richtige Stelle, weil er greift, ohne dass jede Route daran denken muss.

---

## 4. Härtungspunkte

### H1 — `audit_log` ohne Zeilenrichtlinie

`audit_log` ist als partitionierte Tabelle angelegt und trägt **keine** Zeilenrichtlinie; die Anwendungsrolle hat `SELECT` und `INSERT`.

Heute nicht ausnutzbar: keine Route liest das Protokoll, nur `routes/guests.ts:291` schreibt hinein und der Worker pflegt Partitionen. Die Tabelle hält aber geänderte Zeilendaten **aller** Mandanten. Wer als nächstes eine Ansicht darauf baut — und ein Prüfprotokoll will man irgendwann sehen — erbt einen mandantenübergreifenden Fund, ohne dass ihn etwas warnt.

Abhilfe: Zeilenrichtlinie auf der Elterntabelle nach `account_id`, oder `SELECT` der Anwendungsrolle entziehen, bis es einen Leser mit Kontext gibt. Das Zweite ist billiger und fällt sofort auf, wenn jemand es braucht.

### H2 — `rate_plan_product` ohne Mandantenbezug

Die Verknüpfungstabelle trägt nur `rate_plan_id` und `product_id`, keine `property_id`, und keine Zeilenrichtlinie. Die Anwendungsrolle darf schreiben.

Nicht ausnutzbar, weil sie heute nur gelesen wird und der Verbund `p.property_id = $2` mitführt (`routes/billing.ts:182-186`) — eine mandantenübergreifende Zeile fiele dort heraus. Ein künftiger Schreibweg hätte diese Sicherung nicht. Abhilfe: `property_id` in die Tabelle, oder beim ersten Schreibweg beide Seiten gegen den Kontext prüfen.

### H3 — Kontosperre als gezielte Dienstverweigerung

Zehn Fehlversuche sperren ein Konto für die eingestellte Dauer (`routes/auth.ts:113-119`). Gesperrt wird **nach Adresse, nicht nach Herkunft** — wer die Dienstadresse eines Mitarbeiters kennt, kann sie von außen aussperren, ohne je ein Kennwort zu treffen.

Das ist eine bewusste Abwägung (C7: ausgesperrt zu sein ist der größere Schaden) und in der gegenläufigen Richtung sauber begründet. Die Abwägung ist trotzdem einseitig dokumentiert: dass die Sperre selbst eine Waffe ist, steht nirgends. Wer sie entschärfen will, sperrt je Paar aus Konto und Herkunft oder verzögert fortschreitend, statt zu sperren.

Bemerkenswert daneben: bei der **PIN**-Sperre ist genau diese Falle gesehen und vermieden worden — dort zählt der Fehlversuch nur, wenn der PIN wirklich falsch war, ausdrücklich damit niemand einen Kollegen aussperren kann, ohne seinen PIN zu treffen (`routes/auth.ts:392-395`). Dieselbe Überlegung fehlt eine Ebene höher.

### H4 — Die Ratenbegrenzung nimmt angemeldete Anfragen aus

`platform/rateLimit.ts:196`: `if (req.principal.clientKey !== 'anonymous') return`.

Die Begründung steht daneben und ist gut: eine Rezeption im Andrang zu bremsen ist Schaden ohne Gegenwert, und Missbrauch durch einen Angemeldeten ist ein Rollenproblem. **Diese Entscheidung hat aber schon einmal ein Loch erzeugt**, und der Kommentar an `workstation-switch` sagt es selbst: der Pfad stand auf der strengen Liste, wurde von ihr aber nie erreicht, weil die Anfrage ein gültiges Sitzungscookie trug — ein vierstelliger PIN ließ sich in Sekunden durchprobieren.

Behoben wurde das mit einem **eigenen** Zähler an dieser Route. Das ist richtig und zugleich der Punkt: die Ausnahme ist strukturell, und jede künftige empfindliche Handlung hinter einer Sitzung muss ihren Zähler selbst mitbringen. Das gehört als Regel in `CLAUDE.md`, nicht als Erfahrung in einen Kommentar.

### H5 — Abhängigkeiten

Sieben Befunde, **alle in Werkzeugen**, keiner im Auslieferungsstand — geprüft: `vite`, `vitest`, `esbuild` und `@vitest/mocker` stehen ausschließlich in `devDependencies`.

| Grad | Paket | betroffen | behoben ab |
|---|---|---|---|
| kritisch | `vitest` | `<3.2.6` | `3.2.6` |
| hoch | `vite` | `<=6.4.2` | `6.4.3` |
| mittel | `vite`, `vitest`, `@vitest/mocker`, `esbuild` | — | — |

Der als kritisch geführte Befund greift nur, wenn der Vitest-UI-Server lauscht; das tut er hier nirgends. Trotzdem heben, weil die Kosten null sind und der Befund sonst bei jeder Prüfung wieder auftaucht.

### H6 — Fälschbarer Prüfeintrag beim Lesen der Ausweisnummer

`GET /v1/guests/:guestRef/id-document` ist die einzige GET-Route, die schreibt — und sie schreibt mit gutem Grund: jeder Abruf eines Ausweismerkmals wird protokolliert, auch der maskierte, weil *„der Zugriff auf ein Ausweismerkmal die Tatsache ist, die nachweisbar sein muss"* (`routes/guests.ts:287-296`).

Genau das macht sie angreifbar. `SameSite=Lax` schickt das Sitzungscookie bei einer **Navigation der obersten Ebene** mit — ein `window.open`, ein Meta-Refresh, ein angeklickter Link. Eine fremde Seite kann damit einen Prüfeintrag erzeugen, der aussagt, das Opfer habe die Ausweisnummer eines Gastes gelesen.

Was dabei **nicht** passiert: die Antwort kann die fremde Seite nicht lesen. Es ist kein Datenabfluss.

Was passiert: der Eintrag, dessen einziger Zweck seine Beweiskraft ist, lässt sich von einem Dritten erzeugen. Die Voraussetzungen sind eng — das Opfer braucht `guest:read_identity`, der Angreifer einen gültigen `guestRef` (eine Zufallskennung) und einen Weg, das Opfer zum Klicken zu bringen. Der Grad ist deshalb niedrig. Die Wirkung trifft aber ausgerechnet die Eigenschaft, für die es diesen Eintrag gibt.

Abhilfe, eine von beiden: `SameSite=Strict` für das Sitzungscookie — die Anwendung ist eine einzige Herkunft ohne Zugänge von außen, der Verlust ist gering. Oder das Lesen der Klartextnummer auf POST umstellen und den GET auf die maskierte Form beschränken; dann bleibt der beweiserhebliche Eintrag am POST hängen, wohin er gehört.

### H7 — `style-src 'unsafe-inline'`

`ops/caddy/Caddyfile:64`. Der übrige Kopf ist eng (`default-src 'self'`, kein `unsafe-eval`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`). Inline-Stile bleiben eine Restfläche; ohne eine XSS-Lücke, die einzubringen sie erlaubt, ist sie nicht erreichbar, und eine solche Lücke wurde nicht gefunden.

---

## 5. Was geprüft wurde und in Ordnung ist

Diese Liste ist nicht Höflichkeit. Wer die Befunde oben liest, soll sehen, wogegen sie stehen.

**Einschleusung.** Alle Zeichenfolgenverkettungen in SQL geprüft (27 Fundstellen). Jede ist entweder eine Konstante im Modul (`FIELDS`, `SPALTEN`, `COMPANY_FIELDS`, `basis`, `von`) oder eine geschlossene Literalmenge, die aus einem geprüften Zustandsübergang gewählt wird (`routes/reservations.ts:786-789`). Kein Benutzereingabewert erreicht eine Abfrage anders als über einen Platzhalter.

**Rechteausweitung.** Rollen und Rechte entstehen **ausschließlich** in Migrationen — keine Route legt eine an. Beide Zuweisungswege filtern nach Ebene **und** Betrieb (`WHERE level = 'property' AND (account_id IS NULL OR account_id = $2)`), eine Plattformrolle ist von dort nicht erreichbar. Der letzte Verwalter kann sich nicht selbst entrechten.

**Mandantentrennung.** Fachtabellen tragen erzwungene Zeilenrichtlinien, der Kontext wird transaktionslokal gesetzt. `req.pool.query` erscheint nur dort, wo es noch keinen Kontext geben **kann**: Anmeldung, Sitzungsnachschlag, Bereitschaftsprüfung. `SYSTEM_CONTEXT` ebenso, jeweils mit Begründung am Aufruf; wo eine Tabelle vor dem Kontext gelesen werden muss, geschieht es über `SECURITY DEFINER`-Funktionen (`user_account_scope`, `oauth_token_principal`) statt durch Aufweichen der Richtlinie.

**Kennwörter.** Argon2id, 19 MiB Speicher — Speicher vor Rechenzeit, weil Grafikkarten knapp beim Speicher sind. Ein **Blindhash** für unbekannte Konten, damit die Antwortzeit nicht verrät, welche Adressen es gibt. Eine Meldung für falsche Adresse, falsches Kennwort und gesperrtes Konto.

**Sitzungen.** 32 Byte aus `randomBytes`, `httpOnly`, `sameSite: lax`, `secure` in Produktion. Untätigkeits- **und** absolute Frist, beide bei jedem Nachschlag geprüft, dazu `revoked_at`. Bei einer Rollenänderung werden alle Sitzungen des Betroffenen ungültig.

**CSRF.** Kein CORS konfiguriert — es gibt nur eine Herkunft, und eine fremde Seite kann keine Antwort lesen. Alle fachlichen Änderungen laufen über POST, PATCH, PUT oder DELETE; bei `SameSite=Lax` schickt der Browser das Cookie dorthin nicht mit. **Eine Ausnahme gibt es**, und sie steht als H6 oben.

**Kryptografie.** AES-256-GCM für die Ausweisnummer, Zufalls-IV je Datensatz, Schlüsselversion **am Datensatz** statt global — Rotation ohne Stillstand. Der Zwischenspeicher der abgeleiteten Schlüssel ist nach Version **und Abdruck des Geheimnisses** benannt; der Kommentar beschreibt den Fehler, der entstünde, wenn er es nicht wäre, und ein Test hält ihn fest. Zeitgleiche Vergleiche an allen drei Signaturprüfungen (Stripe, Webhook, Auth-Token).

**Kennwort-Zurücksetzung.** Token nur als Abdruck gespeichert, mit Ablauf und `used_at` — einmal benutzbar. Die Route antwortet **immer** mit 202, auch für unbekannte Adressen, mit ausdrücklicher Begründung: die Kundenliste eines Hotelsystems sagt, welche Häuser welche Software benutzen.

**Plattformpersonal.** Kein Zugriff auf Kundendaten ohne eine vom Kunden **freigegebene**, befristete Support-Sitzung; ohne sie bleibt der Mandantenkontext leer und die Zeilenrichtlinie liefert nichts. Das ist die strengere von zwei möglichen Bauarten.

**Maschinenzugänge.** OAuth-Token nur als Abdruck gespeichert. Scopes **sind** Berechtigungsschlüssel — ein zweiter Rechteweg existiert nicht, und `registerRoute` sieht keinen Unterschied zwischen Mensch und Maschine. Eingeschränkte Clients bekommen bewusst keine Account-Rechte, weil die Einschränkung sonst wirkungslos wäre.

**Oberfläche.** Kein `dangerouslySetInnerHTML`, kein `innerHTML`, kein `eval`, kein `new Function` — nirgends. Kein Token im JavaScript; die Sitzung liegt im Cookie, ausdrücklich damit ein eingeschleustes Skript sie nicht lesen kann.

**Kopfzeilen.** HSTS mit `preload`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, enger CSP.

**Grenzen.** Rumpf auf 1 MB begrenzt, je Route erhöhbar. Jeder Zeitraumparameter hat eine Obergrenze. Listenendpunkte haben eine Zeilengrenze. Der Dateiname eines Belegs wird bereinigt, bevor er in eine Kopfzeile geht (`routes/billing.ts`).

**`trustProxy`.** Gesetzt, und die Falle dabei — gefälschte Herkunft über `X-Forwarded-For` — steht als Kommentar an der Stelle, die sie betrifft, samt der Bedingung, unter der sie nicht greift: die Anwendung lauscht auf einem Unix-Socket, nicht auf einem offenen Port.

**Übungshaus.** Vier Exportwege weisen hart ab (Beherbergungsstatistik, DATEV, GoBD, Kurtaxe), und der Gastpostversand lässt sich dort nicht einschalten. Der **Mandantenexport** trägt die Sperre nicht — das ist vertretbar, weil er Datenübertragbarkeit an den Kunden selbst ist und `is_training` im Export mitführt, sollte aber einen Satz bekommen, damit es als Entscheidung und nicht als Lücke lesbar ist.

---

## 6. Was diese Prüfung nicht abdeckt

- **Kein Penetrationstest.** Die Befunde sind gelesen und, wo möglich, an der laufenden Anwendung gegengeprüft — nicht ausgenutzt.
- **Kein Betriebssystem.** Härtung des Wirts, Dateirechte, Netzsegmentierung und die Punkte aus Aufgabe 9 (Plattenverschlüsselung, Sicherung außer Haus) sind Betriebsarbeit an einer echten Maschine und standen hier nicht zur Verfügung.
- **Keine Abhängigkeitskette im Tiefen.** Geprüft wurde der Befundstand von `pnpm audit`, nicht die Herkunft jedes Pakets.
- **Keine Lastgrenze.** Ob die Grenzen, die es gibt, hoch genug oder niedrig genug sind, sagt eine Messung, keine Lesung.

---

## 7. Reihenfolge der Abarbeitung

1. **B1**, Punkt 3 zuerst (`redirect: 'manual'`) — eine Zeile, schließt den bequemsten Weg.
2. **B2** — ein Serialisierer, wirkt auf alle Routen zugleich.
3. **B1**, Punkte 1, 2 und 4 — die eigentliche Arbeit, mit Tests gegen die Adressbereiche.
4. **H5** — Abhängigkeiten heben, kostet nichts.
5. **H1**, **H2** — Tiefenverteidigung, bevor jemand den fehlenden Schutz braucht.
6. **H6** — `SameSite=Strict` ist eine Zeile und die kleinere Änderung von beiden.
7. **H4** — die Regel nach `CLAUDE.md`, damit die nächste empfindliche Route ihren Zähler von selbst mitbringt.

---

## 8. Stand der Abarbeitung

Abgearbeitet am 19.09.2026, alle neun Punkte.

**B1** entstand in einem eigenen Zweig und ist als PR #70 in `main`: Sperrliste
als Netze in `packages/domain/src/webhookTarget.ts`, Prüfung beim Anlegen und
noch einmal unmittelbar vor dem Verbinden, `node:https` mit eigenem `lookup`
statt `fetch`, keine Umleitungen, entschärftes Zustellprotokoll und eine
Freigabe eigener Netze über `WEBHOOK_ALLOWED_PRIVATE_CIDRS`. Die übrigen acht
Punkte stehen hier.

| | Punkt | Wo |
|---|---|---|
| B2 | `req`-Serialisierer redigiert jeden Wert der Abfrage | `apps/api/src/platform/app.ts` |
| H1 | Rechte an den Partitionen entzogen | Migration `0048` |
| H2 | `property_id`, Zeilenrichtlinie, zusammengesetzte Fremdschlüssel | Migration `0049` |
| H3 | Sperre je Paar aus Konto und Herkunft | Migration `0050`, `routes/auth.ts` |
| H4 | Regel im eigenen Abschnitt „Ratenbegrenzung" | `CLAUDE.md` |
| H5 | `vitest` auf 4.1.11, `pnpm audit` ohne Befund | `package.json`, `vitest.config.ts` |
| H6 | `sameSite: 'strict'` | `routes/auth.ts` |
| H7 | `style-src-elem 'self'`, `'unsafe-inline'` nur noch für Attribute | `ops/caddy/Caddyfile` |

Abweichungen von der Reihenfolge in Abschnitt 7: **H4** wurde vorgezogen, weil
es ein Absatz in `CLAUDE.md` ist und die nächste empfindliche Route sonst
dieselbe Erfahrung wieder selbst macht. **H5** war teurer als dort angenommen.

**Zwei Punkte wurden zweimal gefunden.** Das DSGVO-Audit (Dokument 26) lief
parallel und fand denselben Protokollbefund als seine Nummer 3 und dieselbe
fehlende Zeilenrichtlinie am Protokoll als seine Nummer 2. Gemergt ist dessen
Fassung, weil sie in beiden Fällen weiter reicht:

- **B2.** Statt einer Positivliste harmloser Parameter wird **jeder** Wert
  ersetzt und nur der Name behalten. Das ist das bessere Mittel: eine
  Positivliste ist nur so gut wie ihre Pflege, und der nächste Endpunkt
  bringt einen Parameter mit, den niemand nachträgt. Aus dieser Runde bleibt
  der Nachweis — das Protokollziel in `buildServer` und
  `apps/api/src/__tests__/protokoll.test.ts`, den die gemergte Behebung nicht
  hatte.
- **H1.** Statt das Leserecht zu entziehen, trägt `audit_log` seit Migration
  `0045` eine Zeilenrichtlinie. Auch das ist besser: die erste Route, die ein
  Prüfprotokoll anzeigen will, lässt sich damit bauen. Aus dieser Runde
  bleiben die Partitionen, und das ist der Teil, den keine der beiden
  Prüfungen gesehen hatte — siehe unten.

Fünf Dinge sind beim Abarbeiten dazugekommen, und das erste hätte die Prüfung
selbst finden können:

**Die Partitionen des Audit-Logs führen eigene Rechte und erben keine
Zeilenrichtlinie**, und die Rechte kommen aus `ALTER DEFAULT PRIVILEGES` in
`0001` — also `SELECT`, `INSERT`, `UPDATE` und `DELETE` für die
Anwendungsrolle. Das ist der Befund, den weder diese Prüfung noch das
DSGVO-Audit gesehen hat, und er macht die Zeilenrichtlinie aus `0045`
umgehbar. Nachgerechnet an der laufenden Datenbank: zwei Häuser, je eine
Protokollzeile, gelesen als Anwendungsrolle im Kontext des einen — über
`audit_log` **eine** Zeile, direkt auf `audit_log_2026_09` **221**, die des
fremden Hauses eingeschlossen. Der Monatsname ist in einer Sekunde geraten.

Dasselbe gilt für die Unveränderlichkeit: der Rechteentzug aus
`make_append_only` traf nur die Elterntabelle, und ein
`DELETE FROM audit_log_2026_09` scheiterte nicht an der Rechteprüfung, sondern
am Trigger. Härtegrad 1 hing damit an **einer** Sicherung statt an zwei.
`0048` entzieht an jeder Partition alles außer `INSERT` — bestehende und, in
der Funktion, die Partitionen anlegt, jede künftige. Gelesen wird über die
Elterntabelle, wo die Richtlinie greift. `packages/db/src/__tests__/auditlogPartitionen.test.ts`
hält beides fest.

**Entsperren muss auch die Sperre je Herkunft aufheben.** Sonst hieße
„entsperrt" nur, dass die Sperre am Konto weg ist, während der Arbeitsplatz,
an dem sich jemand vertippt hat, weiter zu bleibt — und genau von dort
versucht er es wieder. Alle drei Wege (Hausleitung, Plattformsupport,
Kennwort-Zurücksetzung) räumen die Zeilen jetzt mit ab, und die Benutzerliste
zeigt die stärkere der beiden Sperren.

**Der Zähler am Konto bleibt, er sperrt nur nicht mehr.** `failed_login_count`
läuft weiter mit, damit an einem Konto sichtbar ist, dass jemand es
durchprobiert, auch wenn jede einzelne Herkunft unter ihrer Grenze bleibt.
`app_user.locked_until` bleibt als Sperre von Hand: die Aufsicht muss ein
Konto stilllegen können, ohne auf eine Herkunft zu zeigen.

**H5 kostete nicht nichts.** Installiert war `vitest` 2.1.9; der als kritisch
geführte Befund ist ab 3.2.6 behoben, die beiden Moderate-Befunde erst ab
4.1.11 — zwei Hauptversionen. Die Pool-Optionen sind in Vitest 4 nach oben
gewandert; `isolate` bleibt beim Standard `true`, denn ohne die Isolation
teilen alle Testdateien den Modulzustand, die Ratenbegrenzung zählt über
Dateigrenzen weiter, und eine Route antwortet 429, wo der Test 401 erwartet.

**Ein Protokolltest muss am geschriebenen Protokoll prüfen**, nicht am
Serialisierer allein: die Redaktionsliste war vollständig und die Regel
trotzdem gebrochen, weil Fastify die Adresse aus einer anderen Quelle nimmt.
`buildServer` nimmt dafür ein Protokollziel entgegen, das nur der Test setzt.

Was **nicht** gemacht wurde und warum: die Stilattribute im Zimmerplan
bleiben. Die Balken stehen auf gerechneten Pixeln, ein Wert je Reservierung
lässt sich nicht in ein Stylesheet schreiben, und die Komponente dafür
umzubauen wäre die größte Änderung dieser Runde für den Punkt mit dem
geringsten Grad. Abgestellt ist die gefährlichere Hälfte: ein eingeschleustes
`style`-Element.
