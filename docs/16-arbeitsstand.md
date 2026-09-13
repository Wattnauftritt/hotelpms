# Arbeitsstand und offene Aufgaben

Stand: 13. September 2026. 364 Tests, 26 Migrationen.

Dieses Dokument ist die Übergabe. Es sagt, was steht, und zerlegt das Offene in Aufgaben, die **einzeln und ohne Rückfrage** bearbeitet werden können. Die Regeln, die dabei gelten, stehen in [`CLAUDE.md`](../CLAUDE.md).

---

## 1. Was steht

| Paket | Stand | Wo |
|---|---|---|
| AP 0 Grundgerüst | fertig | Monorepo, CI, Testaufbau |
| AP 1 Mandanten und Rollen | fertig | `0002`, `0003`, `0018`, `0025`, `platform/auth.ts`, `routes/oauth.ts` |
| AP 2 Stammdaten und Einrichtung | fertig | `0004`, `0013`, `routes/setup.ts` |
| AP 3 Raten, Restriktionen, Steuern | fertig | `0007`, `0016`, `routes/rates.ts` |
| AP 4 Verfügbarkeit | fertig | `0005`, `0006`, `routes/availability.ts` |
| AP 5 Reservierungen | fertig | `0009`, `0022`, `routes/reservations.ts`, `routes/blocks.ts` |
| AP 6 Gäste und Firmen | fertig | `0008`, `0015`, `routes/guests.ts` |
| AP 7 Folio und Rechnung | fertig | `0010`, `0012`, `0017`, `0024`, `routes/billing.ts` |
| AP 8 Nachtlauf | fertig | `jobs/nightAudit.ts`, `0014` |
| AP 9 Housekeeping | fertig | `0011`, `routes/housekeeping.ts` |
| AP 10 Meldeschein | fertig | `routes/registrations.ts` |
| AP 11 Berichte und Exporte | fertig | `routes/reports.ts` |
| AP 11b CSV-Import | fertig | `routes/import.ts`, `platform/csv.ts` |
| AP 12 Rezeptions-Oberfläche | fertig | `apps/web` |
| AP 13 Integrationen | fertig | Webhooks (`0020`), Payments (`0021`, `routes/payments.ts`), ARI (`0023`, `routes/channel.ts`), Kasse (`0026`, `routes/pos.ts`) |
| AP 14 Import aus Altsystemen | **offen** | Aufgabe 8 |

**88 Routen**, alle mit deklarierter Berechtigung, davon elf ausdrücklich öffentlich. Ein Vertragstest prüft, dass jede in der OpenAPI-Beschreibung steht. Die Zahl ist aus der Routenregistrierung gezählt, nicht fortgeschrieben.

### Was das System nachweislich kann

Diese Eigenschaften sind durch Tests belegt, nicht behauptet:

- 50 gleichzeitige Buchungen auf das letzte freie Zimmer: genau eine gewinnt, der Zähler stimmt.
- 20 gleichzeitige Check-outs: 20 lückenlose Rechnungsnummern ohne Doppelvergabe.
- Ein Token für Haus A bekommt bei manipuliertem Pfadparameter Haus B nicht, und auch bei vergessener `WHERE`-Bedingung greift die Zeilenrichtlinie.
- Plattformpersonal sieht ohne kundenseitig freigegebene Supportsitzung nichts.
- Der Nachtlauf läuft zweimal für denselben Tag mit identischem Ergebnis über alle berührten Tabellen.
- Eine festgeschriebene Rechnung lässt sich nicht mehr ändern.
- Ein Import mit einer fehlerhaften Zeile schreibt gar nichts.
- Eine zurückgerollte Fachbuchung stellt kein Ereignis zu; ein Empfänger, der dreimal mit 500 antwortet, wird mit wachsendem Abstand erneut bedient und danach stillgelegt.
- Ein Abruf aus einem Kontingent gelingt auch im vollen Haus, storniert fällt der Platz an die Gruppe zurück, und die Freigabe gibt nur den nicht abgerufenen Rest frei.
- Der Beleg zu einer Rechnung ist ein PDF/A-3 mit eingebettetem CII-XML nach EN 16931; das XML kommt beim Empfänger byteweise so an, wie es erzeugt wurde.
- Derselbe Beleg zweimal erzeugt ergibt dieselben Bytes, und ein bereits erzeugter wird nie durch einen zweiten ersetzt.
- Ein Maschinentoken erreicht genau die Endpunkte seiner Zugriffsbereiche und keinen weiteren — geprüft über die gesamte Routenliste, nicht an Beispielen.
- Ein Kassenumsatz landet als Position auf dem Gastkonto, folgt dabei den Umleitungsregeln, und derselbe Beleg zweimal zugestellt bucht kein zweites Mal — auch nicht mit neuem Idempotenzschlüssel.

---

## 2. Offene Aufgaben

Jede ist so geschnitten, dass sie **allein** bearbeitet werden kann. Genannt sind Zweck, Umfang, Abnahmekriterium und was ausdrücklich **nicht** dazugehört.

---

### Aufgabe 1 — ZUGFeRD und PDF/A-3 für die Rechnung — **erledigt**

**Warum.** Die B2B-Ausstellungspflicht kommt gestaffelt bis 2028. ZUGFeRD ist PDF/A-3 mit eingebettetem CII-XML nach EN 16931. Ohne das sind Firmenrechnungen ab dem Stichtag nicht mehr verkehrsfähig (E3 in Dokument 13).

**Wo es liegt.** `packages/domain/src/invoiceCii.ts` (XML und die Geschäftsregeln der Norm), `apps/worker/src/pdf/` (Blatt und PDF/A-3), `apps/worker/src/jobs/invoiceDocument.ts` (Erzeugung), Migration `0024` (Ablage), `GET /v1/invoices/:invoiceRef/pdf` (Auslieferung).

**Was daraus entschieden wurde.**

- **Der Beleg entsteht nach dem Festschreiben, nicht darin.** Das Festschreiben hält die Zählerzeile der Rechnungsnummer gesperrt und serialisiert damit alle Rechnungen einer Property; ein PDF in dieser Transaktion hielte bei zwanzig gleichzeitigen Check-outs zwanzig Kassen an. Der Preis dafür ist Wartezeit: der Worker tickt alle fünf Minuten, und bis dahin antwortet der Endpunkt mit `document_pending`. Die Warteschlange aus Aufgabe 4 beseitigt das.
- **`invoice.pdf_path` ist unbenutzbar und bleibt leer.** Die Spalte gibt es seit `0010`, aber `invoice` ist Härtegrad 1: ein Pfad ließe sich nur beim Anlegen setzen, also bevor es das PDF gibt. Der Beleg liegt deshalb in `invoice_document`, selbst wieder append-only — eine ausgestellte Rechnung wird nicht neu gerendert, sonst ersetzte eine spätere Layoutänderung still das Dokument, das der Gast in der Hand hält.
- **Nicht jede gültige Rechnung ist ein EN-16931-Beleg.** Die Norm kennt keine Kleinbetragsrechnung: § 33 UStDV erlaubt bis 250 Euro brutto den Verzicht auf den Empfänger, BR-07 und BR-10 tun das nicht. Und die Steuernummer genügt ihr nicht — § 14 Abs. 4 Nr. 2 UStG lässt Steuernummer *oder* USt-IdNr. genügen, BR-CO-26 verlangt eine Kennung des Verkäufers, und die Steuernummer ist keine. Solche Rechnungen bekommen ein PDF/A-3 **ohne** XML, mit dem Grund auf dem Blatt und in der Zeile. Fehlt die USt-IdNr. des Hauses, ist das keine Eigenschaft der Rechnung, sondern eine Lücke in den Stammdaten: sie trifft jede weitere und wird einmal als Alarm gemeldet.
- **Eine Gegenbuchung wird über eine negative Menge ausgedrückt**, nicht über einen negativen Preis: BR-27 verbietet den negativen Einzelpreis, und ein Beleg, der ihn trotzdem trägt, fällt erst beim Empfänger durch.
- **Kein Chromium und kein Ghostscript.** Das Blatt wird direkt gezeichnet und im selben Schritt zu PDF/A-3 ergänzt. Ein Browser oder ein zweiter Prozess wären zwei Laufzeitabhängigkeiten für ein A4-Blatt. Mitgeliefert werden dafür eine Schrift und ein Farbprofil (`apps/worker/assets/`): PDF/A verlangt eingebettete Schriften und ein Ausgabeziel, und beides darf sich nicht mit dem nächsten `pnpm install` ändern.

**Nicht dazu.** Versand per E-Mail. Peppol.

**Noch offen.** Ein Lauf gegen einen echten Validator (veraPDF für PDF/A-3, KoSIT oder Mustang für EN 16931) gehört in die Freigabe. Beides sind Java-Werkzeuge und laufen nicht in der Testrunde mit; geprüft wird dort stattdessen jedes einzelne Merkmal, das sie prüfen würden.

---

### Aufgabe 2 — Maschinenzugang mit Client Credentials — **erledigt**

Migration `0025`, `apps/api/src/routes/oauth.ts`, `loadPrincipalFromToken` in
`apps/api/src/platform/auth.ts`.

`POST /oauth/token` gibt gegen Kennung und Geheimnis ein Token auf eine Stunde aus,
formularkodiert nach RFC 6749. Dazu drei Routen unter `integration:manage`, um
Maschinenzugänge anzulegen, aufzulisten und zu sperren — ohne sie wäre der Zugang nur
per SQL erreichbar.

**Scopes sind Berechtigungsschlüssel**, kein zweiter Rechteweg (Grundsatz 1, Dokument 14).
`registerRoute` sieht keinen Unterschied zwischen Mensch und Maschine; der generische
Berechtigungstest läuft deshalb unverändert über den Tokenweg.

Vier Festlegungen:

**Kein `oidc-provider`, obwohl der Umfang ihn nennt.** Die Bibliothek vergleicht
Client-Geheimnisse selbst und braucht sie dafür entschlüsselbar; `oauth_client.secret_hash`
ist ein Argon2-Hash und sollte einer bleiben. Dazu kämen ein Adapter für ihre Artefakte,
JWKS-Verwaltung und eine Einwilligungsseite. Für Client Credentials — das einzige, was die
Abnahme prüft — trägt nichts davon.

**Ein undurchsichtiges Token, kein JWT.** Ein JWT bliebe bis zum Ablauf gültig, auch
nachdem der Kunde den Zugang entzogen hat. Das einzufangen braucht eine Sperrliste, also
wieder die Datenbank; dann kann die Prüfung auch gleich dort stattfinden. Der Preis ist
eine Abfrage je Anfrage, und die läuft ohnehin für den Mandantenkontext.

**Ein Token bekommt keine accountweiten Berechtigungen.** `can()` prüft
`accountPermissions` zuerst und lässt sie auf **alle** Häuser des Accounts wirken. Ein
Client, der auf zwei von zwanzig Häusern eingeschränkt ist, bekäme darüber die anderen
achtzehn dazu — die Einschränkung wäre wirkungslos. Die Scopes hängen deshalb je Haus.

**Plattformrechte sind keine Scopes.** Sie gehören unserem eigenen Personal und wirken
über Mandanten hinweg; ein Kundenclient mit `platform:accounts` hätte Zugriff auf fremde
Betriebe. Die Anlage weist sie ab.

**Offen geblieben:** Authorization Code mit PKCE. Er hat heute keinen Abnehmer — die
Rezeptions-Oberfläche läuft über das Sitzungscookie, und das Entwicklerportal ist
ausdrücklich nicht Teil der Aufgabe. Wer ihn baut, braucht zusätzlich eine
Einwilligungsseite und muss entscheiden, ob Client-Geheimnisse dafür entschlüsselbar
werden dürfen.

---

### Aufgabe 3 — Anzahlungen und ihre Steuerpflicht

**Warum.** Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Steuer bei Anzahlungen mit der Vereinnahmung, nicht mit der Leistung. Das Modell kennt `invoice.kind = 'deposit'`, aber es gibt keinen Weg, eine Anzahlung zu fordern, zu vereinnahmen und später gegen die Schlussrechnung zu verrechnen (B4 in Dokument 13).

**Umfang.**
- Anzahlungsrechnung erstellen, mit eigener Nummer aus demselben Zähler.
- Verrechnung in der Schlussrechnung als eigene Position mit negativem Betrag und Verweis auf die Anzahlungsrechnung.
- `deposit_ledger` als eigener Saldo neben dem Gastkonto.

**Abnahme.** Eine Anzahlung von 200 Euro auf einen Aufenthalt von 500 Euro ergibt eine Schlussrechnung über 500 Euro mit ausgewiesener Anrechnung und 300 Euro offen. Die Steuer der Anzahlung ist im Monat der Vereinnahmung ausgewiesen.

**Vorher klären.** Die steuerliche Behandlung ist mit einem Steuerberater zu bestätigen; das steht als offener Punkt in Dokument 02.

---

### Aufgabe 4 — Webhooks — **erledigt**

Migration `0020`, `apps/api/src/routes/webhooks.ts`, `apps/api/src/platform/events.ts`,
`apps/worker/src/jobs/webhookDelivery.ts`, `packages/domain/src/webhooks.ts`.

Sechs Ereignisarten: `reservation.created`, `.changed`, `.canceled`, `.checked_in`,
`.checked_out` und `invoice.finalized`. Abonnements liegen am Account und lassen sich auf
einzelne Häuser und Ereignisarten einschränken; leer bedeutet jeweils alle.

Drei Festlegungen, die dabei getroffen wurden:

**Kein Graphile Worker.** Der ursprüngliche Grund für ihn war, einen Job in derselben
Transaktion wie die Fachbuchung einreihen zu können. Genau das tut `webhook_enqueue()` als
SQL-Funktion, aufgerufen mit dem Client der laufenden Transaktion — ohne eigenes Schema,
eigene Migrationen und eigene Rechte neben denen, die hier ohnehin gelten. Der bestehende
Worker war schon eine Polling-Schleife ohne diese Abhängigkeit; sie jetzt für einen
Tabelleneintrag einzuführen, hätte mehr gekostet als gebracht. Die Zusage selbst steht:
eine zurückgerollte Fachbuchung stellt nichts zu, und ein Test weist es nach.

**Der Zeitstempel steht im signierten Text, nicht nur in der Kopfzeile.** Signiert wird
`Zeitstempel.Rumpf` mit HMAC-SHA256. Stünde er nur daneben, könnte ein Mitschneider ihn auf
jetzt setzen und eine alte Zustellung erneut einspielen, ohne die Signatur zu brechen. So
bricht jede Änderung an ihm die Signatur, und der Empfänger darf alles verwerfen, was älter
ist als sein Toleranzfenster.

**Der Versuchszähler steigt beim Beanspruchen, nicht beim Vermerken.** Der Netzaufruf liegt
zwischen zwei Transaktionen und damit außerhalb der Zeilensperre — ein Empfänger, der zehn
Sekunden braucht, hielte sonst zehn Sekunden eine Sperre. Unter der Sperre ist die
Versuchsnummer eindeutig vergeben, und ein Versuch, dessen Ergebnis ein Absturz verschluckt,
zählt trotzdem: abgeschickt wurde er ja möglicherweise. Zugestellt wird deshalb **mindestens
einmal**, nicht genau einmal; jedes Ereignis trägt eine Kennung, an der der Empfänger eine
Wiederholung erkennt.

**Offen geblieben:** Die Zustellung hängt am Fünf-Minuten-Takt des Workers, ein Ereignis kann
also bis zu fünf Minuten alt sein, wenn es ankommt. Für einen Channel Manager ist das zu
langsam. Der Weg dahin ist `LISTEN/NOTIFY` — der Worker verbindet aus genau diesem Grund
schon direkt und nicht über PgBouncer (D1, Dokument 13).

---

### Aufgabe 5 — ARI-Schnittstelle für Channel Manager — **erledigt**

**Wo es liegt.** Migration `0023`, `apps/api/src/routes/channel.ts`, `apps/api/src/platform/channelAuth.ts`. Gemergt mit #8; die Begründungen dort stehen in der Beschreibung des Pull Requests, nicht hier.

**Warum.** Der Zielkunde verkauft über Portale. Ohne Verfügbarkeits-, Raten- und Restriktionsabgleich ist das System für ihn nicht benutzbar.

**Umfang.**
- Ausgehend: Verfügbarkeit, Raten und Restriktionen je Kategorie und Tag, als Änderungsmeldung und als Vollabgleich.
- Eingehend: Reservierungen des Portals, mit `booking.external_reference` als Schlüssel gegen Doppelanlage.
- Erste Anbindung an einen Channel Manager, laut Dokument 02 unter anderem Roomcloud.

**Abnahme.** Eine Reservierung des Portals bindet Kontingent über `inventory_reserve`, nicht über einen direkten Schreibzugriff. Ein zweiter Eingang derselben externen Nummer legt nichts doppelt an.

---

### Aufgabe 6 — Payment-Adapter — **erledigt**

**Wo es liegt.** Migration `0021`, `apps/api/src/routes/payments.ts`, `apps/api/src/platform/payments/stripe.ts`, `packages/domain/src/payments.ts`. Gemergt mit #5; die Begründungen dort stehen in der Beschreibung des Pull Requests, nicht hier.

**Warum.** Pay-by-Link ist der einzige vorgesehene Weg, eine Buchung zu garantieren, ohne Kartendaten anzufassen.

**Umfang.** Adapter für Stripe zuerst, danach Adyen und Mollie. Zahlungsaufforderung erzeugen, Rückmeldung verarbeiten, Ergebnis als `settlement` mit `external_reference` vermerken.

**Abnahme.** Eine erfolgreiche Zahlung erzeugt genau einen Zahlungsvermerk. Eine doppelte Rückmeldung erzeugt keinen zweiten. Nirgends im System steht eine Kartennummer.

---

### Aufgabe 7 — Kassenschnittstelle — **erledigt**

**Warum.** Das Haus hat eine Kasse mit TSE. Ihre Umsätze sollen auf das Gastkonto laufen, ohne dass dieses System zur Kasse wird.

**Wo es liegt.** Migration `0026` (Herkunftsvermerk an `charge`), `apps/api/src/routes/pos.ts` mit drei Routen: offene Folios lesen, Umsatz buchen, Umsatz stornieren.

**Was daraus entschieden wurde.**

- **Kein eigener Zugangsweg für die Kasse.** Sie bekommt einen Maschinenzugang aus Aufgabe 2 mit den Zugriffsbereichen `folio:read` und `folio:post`. Ein dritter Anmeldeweg neben Sitzung und Token wäre eine dritte Stelle, an der eine Berechtigungsprüfung fehlen kann.
- **Zwei Sicherungen gegen die Doppelbuchung, und beide werden gebraucht.** Der Idempotenzschlüssel fängt die Wiederholung derselben Anfrage; der eindeutige Index über die Belegnummer der Kasse fängt auch die Wiederholung nach einem Neustart, bei der die Kasse einen neuen Schlüssel bildet, ihre Belegnummer aber behält. Eine Wiederholung ist kein Fehler: sie bekommt dieselbe Antwort wie beim ersten Mal, sonst gerät die Kasse in eine Schleife oder der Umsatz geht verloren.
- **Der Artikel kommt aus den Stammdaten, der Betrag von der Kasse.** Erlöskonto und Steuersatz stehen dort, wo DATEV-Export und Umsatzberichte sie lesen. Ein unbekanntes Artikelkürzel wird abgewiesen und **nicht** auf ein Standardkonto gebucht — ein Getränkeumsatz auf dem Logiskonto fälschte ADR und RevPAR, derselbe Fehler, der bei der No-Show-Gebühr schon einmal drohte.
- **Den Steuersatz darf die Kasse übersteuern.** Dasselbe Getränk ist im Haus 19 und außer Haus 7 Prozent, und die Kasse weiß, was der Gast getan hat. Weicht ihr TSE-signierter Beleg von unserer Rechnung ab, fällt das bei einer Prüfung auf das Haus zurück.
- **Brutto herein, netto und Steuer heraus.** Eine Kasse rechnet in Bruttopreisen, weil die Karte brutto ausgezeichnet ist. Rechnete sie selbst um, stünde auf der Hotelrechnung ein anderer Betrag als auf dem Beleg in der Tasche des Gastes.
- **Die Umleitungsregeln gelten auch für die Kasse.** Umleitung ist genau für diesen Fall gemacht — die Firma zahlt die Übernachtung, die Getränke der Gast. Die genauere Regel gewinnt (Artikel vor Erlöskonto vor „alles"); ein geschlossenes Zielfolio wird übergangen, weil es schon abgerechnet ist.
- **Zwei angereiste Gäste im selben Zimmer sind eine Rückfrage, keine Vermutung.** Geraten landete der Umsatz beim Falschen, und auffallen würde es beim Check-out des Anderen.

**Abnahme.** Ein Kassenumsatz erscheint als `charge` mit Herkunftsvermerk. Es entsteht **kein** Kassenbestand und **kein** Bon in diesem System — geprüft, indem jeder Buchungstest auch zählt, was *nicht* entsteht: kein Zahlungsvermerk, keine Abwicklung. Ein Zimmerbon ist keine Abrechnung, sondern ihre Verschiebung; der Gast zahlt beim Check-out.

---

### Aufgabe 8 — Import aus Altsystemen

**Warum.** Der Zielkunde ist Migrationskandidat. Ohne Importer gewinnt das Produkt keine Kunden (Dokument 05).

**Umfang.** Generisches Importformat mit Adaptern für hotline, HS/3 und protel. Trockenlauf mit Bericht. Stichtagsmigration mit Abgleich.

**Anhaltspunkte.** `routes/import.ts` hat die Mechanik bereits: Trockenlauf als Regelfall, ganz oder gar nicht, Bindung über dieselben Inventarfunktionen. Der Adapter muss nur auf dieses Format abbilden.

**Abnahme.** Ein Altbestand von 5000 Reservierungen läuft ohne überbuchte Kategorietage durch. Der Abgleich nennt jede nicht übernommene Zeile mit Grund.

---

### Aufgabe 9 — Betriebsvoraussetzungen für Fremdkunden

**Teilweise erledigt.** Alles, was Code ist, steht; was Betrieb ist, steht als Handbuch in [`17-betrieb.md`](17-betrieb.md) und muss einmal tatsächlich durchgeführt werden.

| Punkt | Stand |
|---|---|
| Ratenbegrenzung je Herkunft (C7) | **erledigt**, `platform/rateLimit.ts`, zweite Linie hinter Caddy |
| Schulungsbetrieb (C11) | **erledigt**, `platform/training.ts` |
| Schlüsselrotation (C4) | **erledigt** als Werkzeug, `apps/api/src/cli/rotate-keys.ts` |
| Mandantenexport (E7) | **erledigt**, `GET /v1/properties/:id/exports/tenant` |
| Plattenverschlüsselung (C3) | **offen**, Betriebsarbeit, Anleitung in Dokument 17 |
| Sicherung außer Haus | **offen**, Betriebsarbeit; die Rückspielung muss einmal erprobt sein |
| Ratenbegrenzung in Caddy | **offen**, Baustein in Dokument 17 |

Dabei ist ein Fehler aufgefallen, der die Rotation still unbrauchbar gemacht hätte: der Zwischenspeicher der abgeleiteten Schlüssel merkte sich nur die **Version**, nicht das Geheimnis. Bei einer Rotation sind beide Geheimnisse gleichzeitig in Gebrauch; der erste Aufruf hätte den Eintrag für alle weiteren belegt, das Entschlüsseln mit dem falschen Geheimnis hätte still funktioniert, und die Rotation hätte Chiffrate erzeugt, die niemand mehr öffnen kann. Ein Test fängt das jetzt ab.

### Aufgabe 10 — Kleinere Lücken

| Lücke | Wo | Stand |
|---|---|---|
| Verlängerung mit Kategoriewechsel als atomarer Fall (E11) | `0019`, `routes/reservations.ts` | **erledigt** |
| `guaranteed` und Stornoregel beim No-Show auswerten (B10) | `jobs/nightAudit.ts`, Schritt 4 | **erledigt** |
| Routing-Regeln anwenden, wenn der Nachtlauf bucht | `jobs/nightAudit.ts`, Schritt 2 | **erledigt** |
| Alarm bei ausgefallenem Nachtlauf | `jobs/maintenance.ts` | **erledigt** |
| Gruppen und Kontingente | `0022`, `routes/blocks.ts`, `apps/web/src/routes/Blocks.tsx` | **erledigt** |
| Folio-Bildschirm in der Oberfläche | `apps/web/src/routes/Folio.tsx` | **erledigt** |

Aus den vier erledigten Punkten ist eine Entscheidung hervorgegangen, die andernorts gilt: **`inventory_move` bindet zuerst und gibt erst danach frei**, und es bindet bei gleicher Kategorie nur die Differenz. Beides hat einen Grund. Zwischen Freigeben und Neubelegen wäre das Kontingent frei, und genau dann kauft es das Portal. Und wer bei einer Verlängerung den ganzen Aufenthalt neu bindet, konkurriert mit sich selbst und scheitert im vollen Haus an der eigenen Buchung.

Zwei weitere Festlegungen daraus: eine **No-Show-Gebühr ohne hinterlegte Stornoregel wird nicht berechnet** — eine Gebühr ohne vereinbarte Grundlage ist nicht durchsetzbar, und sie trotzdem aufs Folio zu buchen erzeugt einen Streit, den das Haus verliert. Und sie trägt den **vollen Steuersatz auf einem eigenen Erlöskonto**, denn eine Gebühr ist keine Beherbergung; auf das Logiskonto gebucht fälschte sie ADR und RevPAR.

Bei den Kontingenten lag die eigentliche Lücke nicht in der Oberfläche: `availability_block` gab es seit `0009`, und der Nachtlauf gab bei Ablauf `quantity - picked_up` frei — nur gab es keinen Weg, `picked_up` zu erhöhen. Es fehlten die API und der Verweis `reservation.block_id`. Ein Kontingent ließ sich anlegen und freigeben, aber nie benutzen.

Drei Festlegungen daraus: Ein **Abruf verschiebt**, er bindet nicht zusätzlich — `inventory_unblock` und dann `inventory_reserve`, in dieser Reihenfolge und damit umgekehrt zu `inventory_move`. Dort hält noch niemand den Platz, hier hält ihn das Kontingent bereits; im vollen Haus scheiterte ein Binden vor dem Freigeben an der eigenen Gruppe. Ein **Storno gibt an die Gruppe zurück**, nicht in den freien Verkauf, sonst verlöre eine Gruppe bei jedem Storno ein Zimmer an Laufkundschaft. Und ein **Abruf läuft über den ganzen Zeitraum des Kontingents**: bei einem Teilabruf sänke `blocked` nur an den belegten Nächten, die Freigabe des Rests rechnet aber über den ganzen Zeitraum, und an den übrigen Nächten bliebe dauerhaft Kontingent gebunden, das niemandem mehr gehört.

Der Folio-Bildschirm hat drei Eigenschaften, die bewusst so sind: **es gibt keinen Löschknopf** (Positionen sind Härtegrad 1, eine Korrektur ist eine Gegenbuchung und steht sichtbar darunter), **fakturierte Positionen sind erkennbar** (statt eine Änderung erst beim Versuch mit einer Fehlermeldung zu beantworten), und **der Hinweis steht am Zahlungsformular, nicht in einer Fußnote**: wer hier tippt, soll wissen, dass er zuordnet und nicht abwickelt.

---

## 3. Fallstricke, die schon einmal zugeschlagen haben

Wer hier arbeitet, spart sich diese Wege ein zweites Mal.

| Falle | Was passierte |
|---|---|
| Lesen ohne Mandantenkontext | Zweimal still kaputt: der Benutzer sah seine eigenen Häuser nicht, und eine Account-Rolle wirkte auf gar kein Haus |
| Trigger je Zeile bei Massenänderung | 250 Zimmer anzulegen dauerte 28 Sekunden statt 59 Millisekunden |
| Zähler als Aufzeichnung benutzt | Die Auslastung der Vergangenheit wurde mit 0,3 Prozent statt 63 Prozent gemeldet |
| `ORDER BY similarity(...)` statt Abstandsoperator | Die Namenssuche las die ganze Tabelle, 147 statt 14 Millisekunden |
| Korrelierte Unterabfrage je Zeile | Der Saatlauf kam nicht über den Schritt hinaus und musste abgebrochen werden |
| snake_case gelesen, camelCase geprüft | Die Anschrift verschwand lautlos, die Rechnung wurde grundlos abgewiesen |
| Frist gegen `now()` statt gegen den Geschäftstag | Ein Wiederholungslauf hätte andere Zeilen gefunden als der erste |
| Zwei Testrollen zusammen vergeben | Verdeckte, dass jede einzeln nicht funktionierte |

Die drei Leistungsbefunde stehen ausführlich in [`15-messungen-aus-dem-saatlauf.md`](15-messungen-aus-dem-saatlauf.md).

---

## 4. Parallel arbeiten

Der Stand liegt vollständig auf `main`. Jede Aufgabe bekommt einen eigenen Zweig von dort, einen Pull Request gegen `main`, und wird für sich gemergt.

Die einzige Stelle, an der zwei Bearbeiter sich zuverlässig in die Quere kommen, ist die **Nummer einer neuen Migration**. Zwei Zweige von `main` legen beide `0020_` an; beim Mergen fällt das nicht auf, weil es verschiedene Dateien ohne Konflikt sind, und es schlägt erst beim nächsten frischen Schemaaufbau zu. `scripts/check-migrations.sh` prüft das in CI.

Ansonsten schneiden sich die Aufgaben kaum: sie liegen in verschiedenen Routenmodulen, verschiedenen Worker-Jobs oder verschiedenen Bildschirmen. Wo doch, steht es in der Aufgabe.

---

## 5. Umgebung

`.claude/hooks/session-start.sh` richtet eine frische Sitzung vollständig ein: Abhängigkeiten, PostgreSQL, Rollen, Datenbanken, Schema. Von Hand tut `scripts/setup-db.sh` den Datenbankteil.

Scheitern die Tests mit `ECONNREFUSED` auf Port 5432, liegt es nicht an den Tests, sondern daran, dass die Datenbank nicht läuft.

---

## 6. Vor dem Pushen

```bash
./scripts/check-migrations.sh && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Alle vier grün. Der Saatlauf (`pnpm db:seed`) ist kein Teil der Prüfung, aber wer an Abfragen arbeitet, sollte einmal dagegen messen: kleine Datenmengen verbergen genau die Fehler, die im Betrieb zählen.
