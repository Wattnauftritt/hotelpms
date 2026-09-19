# Arbeitsstand und offene Aufgaben

Stand: 19. September 2026. 926 Tests, 40 Migrationen.

> **Neu hier?** [`18-einarbeitung.md`](18-einarbeitung.md) erklärt in zwanzig Minuten, was das System tut, wo es das tut und warum. Danach ist dieses Dokument leichter zu lesen.

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
| AP 7 Folio und Rechnung | fertig | `0010`, `0012`, `0017`, `0024`, `0027`, `0029`, `routes/billing.ts` |
| AP 8 Nachtlauf | fertig | `jobs/nightAudit.ts`, `0014` |
| AP 9 Housekeeping | fertig | `0011`, `routes/housekeeping.ts` |
| AP 10 Meldeschein | fertig | `routes/registrations.ts` |
| AP 11 Berichte und Exporte | fertig | `routes/reports.ts` |
| AP 11b CSV-Import | fertig | `routes/import.ts`, `platform/csv.ts` |
| AP 12 Rezeptions-Oberfläche | **teilweise** | `apps/web`. Belegungsplan mit Ziehen (buchen, verschieben, verlängern), Gäste, Firmen, Verfügbarkeitsraster, Check-in, Storno; Preisraster und Rechnungen ebenfalls fertig. Offen: Anzahlung, Pay-by-Link, Channel-Manager-Ansicht — [`20-arbeitsteilung.md`](20-arbeitsteilung.md) §5 |
| AP 13 Integrationen | fertig | Webhooks (`0020`), Payments (`0021`, `routes/payments.ts`), ARI (`0023`, `routes/channel.ts`), Kasse (`0026`, `routes/pos.ts`) |
| AP 14 Import aus Altsystemen | fertig | `routes/import.ts`, `platform/legacyImport/` |
| AP 15 Gastpost | fertig | `0028`, `routes/email.ts`, `jobs/emailDelivery.ts`, `email/brevo.ts` |
| AP 12b Oberflaeche: Verzeichnis, Rechte, Adresse | fertig | `screens.tsx`, `lib/adresse.ts`, `lib/i18n/` |

**104 Routen**, alle mit deklarierter Berechtigung, davon elf ausdrücklich öffentlich. Ein Vertragstest prüft, dass jede in der OpenAPI-Beschreibung steht. Die Zahl ist aus der Routenregistrierung gezählt, nicht fortgeschrieben.

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
- Eine Anzahlung erzeugt eine eigene Rechnung aus derselben Nummernfolge; die Schlussrechnung verrechnet sie als eigene Position mit negativem Betrag, und das Folio zeigt den tatsächlich offenen Betrag ohne doppelte Zählung.

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

### Aufgabe 3 — Anzahlungen und ihre Steuerpflicht — **erledigt**

Migrationen `0027` und `0029`, `apps/api/src/routes/billing.ts` (`POST .../deposit-invoice`,
erweitertes `POST .../invoice`), `packages/domain/src/deposit.ts`,
`apps/worker/src/jobs/invoiceDocument.ts`, DATEV-Stapel in `apps/api/src/routes/reports.ts`.

Die steuerliche Behandlung wurde mit dem Steuerberater bestätigt: die Vereinnahmung ist sofort
umsatzsteuerpflichtig, § 13 Abs. 1 Nr. 1a UStG in seiner einfachen Lesart, ohne Sonderfall.

**Eigenes Journal statt charge/settlement-Paar.** `deposit_ledger` führt die Anzahlung als
eigenen Saldo neben dem Gastkonto, mit zwei Ereignisarten: `received` bei der Vereinnahmung,
`applied` bei der Verrechnung in einer Schlussrechnung. Eine Anzahlung als `charge` zu buchen
hätte sie doppelt gezählt, sobald die Schlussrechnung entsteht: einmal als gebuchte Leistung,
einmal als bereits bezahlte. Das Folio selbst bleibt deshalb unberührt — sein Saldo kommt
weiterhin allein aus `charge` und `settlement`, die Anzahlung stand dort schon als `settlement`.

**Verrechnung als Position, nicht als Kopfangabe.** Die Schlussrechnung bekommt eine zusätzliche
Position mit negativem Betrag (negative Menge nach BR-27, nicht negativer Einzelpreis) und dem
Verweis auf die Anzahlungsrechnung im Positionstext. Die bereits vorhandene `prepaidCent`-Angabe
(BT-113) ist etwas anderes — eine Zahlung, die derselben Rechnung direkt zugeordnet ist — und
bleibt davon unberührt.

**`settlement.invoice_id` bleibt unangetastet.** Der Zahlungsvermerk der Anzahlung wird nicht auf
die Anzahlungsrechnung umgebogen: dieses Feld trägt bereits eine andere, bestehende Bedeutung
(Zahlung direkt der eigenen Rechnung zugeordnet), und eine zweite Bedeutung am selben Feld hätte
zwei Mechanismen leise vermischt. Stattdessen trägt `deposit_ledger.settlement_id` den Verweis,
mit einem eindeutigen Index als eigentlichem Schutz gegen doppelte Verbuchung unter
Nebenläufigkeit — dieselbe Lehre wie bei Aufgabe 5 und 6.

**Im Buchungsstapel, nicht nur auf dem Beleg (`0029`).** Der DATEV-Export las ausschließlich über
`invoice JOIN charge`. Eine Anzahlung erzeugt aber keine `charge` — sie ist keine Leistung —, und
damit stand ihre Steuer zwar im ZUGFeRD-Beleg, aber in keinem Stapel, den der Steuerberater
einspielt. Genau das verlangt die Abnahme jedoch. Gebucht wird deshalb zusätzlich aus dem
Anzahlungsjournal: die Vereinnahmung am Geschäftstag des Zahlungsvermerks gegen das Konto für
erhaltene, versteuerte Anzahlungen (SKR03 1718, bewusst kein Erlöskonto — bis geleistet wurde,
ist es eine Verbindlichkeit), die Verrechnung am Tag der Schlussrechnung wieder heraus. Der
Stapel läuft chronologisch und trägt nur positive Beträge: DATEV kennt keinen negativen Umsatz,
die Richtung steht im Soll/Haben-Kennzeichen. Das galt auch schon für die Storno-Position der
Kasse, die bisher ein Minus ins Betragsfeld schrieb.

**Eine Anzahlung trägt so viele Steuersätze wie der Aufenthalt (`0029`).** Anfangs war es genau
einer, vom Aufrufer mitgegeben. Das Haus verkauft aber Übernachtung zum ermäßigten und Getränke
zum vollen Satz, und ein Frühstücksbuffet beides in einem Preis. Fehlt der Satz, wird er nun im
Verhältnis der **erwarteten** Leistung abgeleitet: der geplante Aufenthalt und die im Ratenpreis
enthaltenen Leistungen, das Buffet nach dem Verhältnis, das an `product` steht (üblich 30 Prozent
Getränke). Gerechnet wird mit dem Plan und nicht mit dem schon Gebuchten — bei einer Anzahlung
zur Buchungszeit ist noch keine Nacht gebucht, und für die Aufteilung zählt nur das Verhältnis.

**Die Rechnung weist den vereinnahmten Betrag aus, nicht einen Cent daneben.** Netto
herausrechnen und die Steuer wieder daraufschlagen trifft ihn nicht: beide Schritte runden, und
bei jeder fünfzehnten Anzahlung fehlte danach ein Cent — eine Anzahlung über 250,00 Euro stand
als 249,99 Euro auf dem Beleg, während das Journal 250,00 führte. Die Nettobeträge werden deshalb
absichtlich nachgestellt, bis die Rechnung den Eingang trifft; ins Journal kommt, was der Beleg
ausweist. Bei zwei Sätzen geht das fast immer auf. Bleibt ein Cent, ist er eine Grenze der Norm
und nicht ein Rundungsfehler: zu 7 Prozent gibt es kein Netto, dessen aufgeschlagene Steuer genau
250,00 Euro ergibt, und BR-CO-14 lässt nichts anderes zu. Aus demselben Grund kann der ausgewiesene
Endbetrag einer Schlussrechnung um einen Cent von „Leistung minus Anzahlung" abweichen; der Saldo
des Folios, also das Geld, ist davon unberührt und exakt. Dieselbe Frage stellt sich überall, wo ein
Bruttobetrag vorgegeben wird — an der Kasse und beim Paketpreis. Die Schlussrechnung gleicht das
seit **Aufgabe 12** über den Rundungsbetrag BT-114 aus; bei der Anzahlung bleibt es bei der
Nachstellung, weil dort ein vereinnahmter Betrag aufgeteilt und nicht ein geforderter ausgeglichen
wird.

**Beim Nachprüfen gefunden und mitbehoben.** Eine Zwischenrechnung über ausgewählte Positionen
verbrauchte die ganze Anzahlung: die Schlussrechnung bekam nichts mehr, und eine Zwischenrechnung
über ein Mineralwasser hätte über einen negativen Betrag gelautet. Verrechnet wird nun nur auf der
Schlussrechnung über alle offenen Positionen. Übersteigt die Anzahlung die abzurechnenden
Leistungen — der Gast reist früher ab —, wird die Rechnung abgewiesen statt negativ ausgestellt:
das ist eine Rückzahlung, und dafür ist eine Rechnung das falsche Papier. Ein negativer
Zahlungsvermerk (Storno, Erstattung) wird nicht mehr als Anzahlung angenommen; vorher schlug erst
die Bedingung am Journal zu, als Fehler 500.

**Abnahme geprüft:** eine Anzahlung von 200 Euro auf einen Aufenthalt von 500 Euro ergibt eine
Schlussrechnung über netto 500 Euro Leistung mit einer Verrechnungsposition und 300 Euro offen;
die Steuer der Anzahlung steht im Geschäftsdatum ihres Zahlungsvermerks, nicht im
Ausstellungsdatum der Anzahlungsrechnung, und sie steht dort auch im DATEV-Stapel.

**Noch offen.** Die Rückzahlung einer nicht verbrauchten Anzahlung: das Journal kennt die Art
`refunded` nicht, und es gibt keinen Weg, sie zu erzeugen. Sie gehört zum Storno und braucht eine
eigene Entscheidung darüber, ob eine Stornogebühr einbehalten wird. Ebenfalls offen: das
Anzahlungsjournal steht nicht im GoBD-Export — die Anzahlungsrechnung selbst schon, die Verbindung
zu Zahlungsvermerk und Verrechnung nicht.

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

### Aufgabe 8 — Import aus Altsystemen — **erledigt**

**Warum.** Der Zielkunde ist Migrationskandidat. Ohne Importer gewinnt das Produkt keine Kunden (Dokument 05).

**Umfang.** Generisches Importformat mit Adaptern für hotline, HS/3 und protel. Trockenlauf mit Bericht. Stichtagsmigration mit Abgleich.

**Anhaltspunkte.** `routes/import.ts` hat die Mechanik bereits: Trockenlauf als Regelfall, ganz oder gar nicht, Bindung über dieselben Inventarfunktionen. Der Adapter muss nur auf dieses Format abbilden.

**Abnahme.** Beide Kriterien sind als Test hinterlegt: 5000 Reservierungen über den hotline-Adapter laufen in 13,5 Sekunden durch, ohne einen einzigen überbuchten Kategorietag, und der bestehende Bericht nennt jede nicht übernommene Zeile mit Zeilennummer und Grund.

**Was daraus entschieden wurde.** Die Adapter übersetzen nur die Rohform und rufen dann dieselbe `runImport()` wie der generische Import — die korrektursensible Logik gibt es einmal, nicht viermal. Die drei Spaltenformen in `platform/legacyImport/` sind **begründete, aber unbestätigte Annahmen**: für keines der drei Systeme gibt es eine veröffentlichte Formatbeschreibung, und das steht auch in der Antwort von `GET /v1/imports/legacy/templates`. Vor dem ersten echten Kunden gehören sie gegen eine tatsächliche Exportdatei geprüft. Protels amerikanisches Datum ist der Grund, warum ein Adapter das Datum selbst umrechnet: `07/01/2026` wäre sonst der 7. Januar statt des 1. Juli.

---

### Aufgabe 9 — Betriebsvoraussetzungen für Fremdkunden

**Teilweise erledigt.** Alles, was Code ist, steht; was Betrieb ist, steht als Handbuch in [`17-betrieb.md`](17-betrieb.md) und muss einmal tatsächlich durchgeführt werden.

| Punkt | Stand |
|---|---|
| Ratenbegrenzung je Herkunft (C7) | **erledigt**, `platform/rateLimit.ts`, zweite Linie hinter Caddy |
| Schulungsbetrieb (C11) | **erledigt**, `platform/training.ts` |
| Schlüsselrotation (C4) | **erledigt** als Werkzeug, `apps/api/src/cli/rotate-keys.ts` |
| Mandantenexport (E7) | **erledigt**, `GET /v1/properties/:id/exports/tenant` |
| Plattenverschlüsselung (C3) | **offen**, Betriebsarbeit. Entwurf steht: verschlüsselt wird der **Host-Speicher**, nicht die VM, entsperrt über das physische TPM und einen Tang-Server statt durch einen wachen Menschen. Anleitung in Dokument 17 §1 |
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
| Bestand am Zustand statt am Handlungspaar binden | `routes/reservations.ts` | **erledigt** |
| Wiederherstellen nach Storno oder No-Show als Endpunkt | `routes/reservations.ts` | **erledigt** |

Aus den vier erledigten Punkten ist eine Entscheidung hervorgegangen, die andernorts gilt: **`inventory_move` bindet zuerst und gibt erst danach frei**, und es bindet bei gleicher Kategorie nur die Differenz. Beides hat einen Grund. Zwischen Freigeben und Neubelegen wäre das Kontingent frei, und genau dann kauft es das Portal. Und wer bei einer Verlängerung den ganzen Aufenthalt neu bindet, konkurriert mit sich selbst und scheitert im vollen Haus an der eigenen Buchung.

Zwei weitere Festlegungen daraus: eine **No-Show-Gebühr ohne hinterlegte Stornoregel wird nicht berechnet** — eine Gebühr ohne vereinbarte Grundlage ist nicht durchsetzbar, und sie trotzdem aufs Folio zu buchen erzeugt einen Streit, den das Haus verliert. Und sie trägt den **vollen Steuersatz auf einem eigenen Erlöskonto**, denn eine Gebühr ist keine Beherbergung; auf das Logiskonto gebucht fälschte sie ADR und RevPAR.

Bei den Kontingenten lag die eigentliche Lücke nicht in der Oberfläche: `availability_block` gab es seit `0009`, und der Nachtlauf gab bei Ablauf `quantity - picked_up` frei — nur gab es keinen Weg, `picked_up` zu erhöhen. Es fehlten die API und der Verweis `reservation.block_id`. Ein Kontingent ließ sich anlegen und freigeben, aber nie benutzen.

Drei Festlegungen daraus: Ein **Abruf verschiebt**, er bindet nicht zusätzlich — `inventory_unblock` und dann `inventory_reserve`, in dieser Reihenfolge und damit umgekehrt zu `inventory_move`. Dort hält noch niemand den Platz, hier hält ihn das Kontingent bereits; im vollen Haus scheiterte ein Binden vor dem Freigeben an der eigenen Gruppe. Ein **Storno gibt an die Gruppe zurück**, nicht in den freien Verkauf, sonst verlöre eine Gruppe bei jedem Storno ein Zimmer an Laufkundschaft. Und ein **Abruf läuft über den ganzen Zeitraum des Kontingents**: bei einem Teilabruf sänke `blocked` nur an den belegten Nächten, die Freigabe des Rests rechnet aber über den ganzen Zeitraum, und an den übrigen Nächten bliebe dauerhaft Kontingent gebunden, das niemandem mehr gehört.

Beim Nachlesen der Kontingent-Umsetzung ist ein älterer Fehler aufgefallen, der nichts mit Kontingenten zu tun hat: **ob Bestand gebunden wird, hing am Handlungspaar Storno/Wiederherstellen statt am Zustand.** Ein No-Show, der doch noch anreist, geht aber nicht über dieses Paar — er geht über `check_in` direkt nach `InHouse`, einen bindenden Zustand, ohne dass je wieder gebunden wurde. Das Zimmer war belegt, der Zähler sagte frei, und auffallen würde die Differenz als Überbuchung, nicht als Fehlermeldung. Der Übergang fragt jetzt `occupiesInventory` für Vorher und Nachher; damit ist jeder Weg in einen bindenden Zustand abgedeckt, auch die, die es noch nicht gibt. Dabei fiel auf, dass der Zustandsautomat `reinstate` seit jeher kennt, es aber keinen Endpunkt dafür gab: ein versehentlicher Storno war bis dahin endgültig.

Ein manueller No-Show-Endpunkt ist bewusst **nicht** dazugekommen. Den No-Show setzt der Nachtlauf, und er bucht dabei die Stornogebühr nach hinterlegter Regel. Eine Route, die nur den Zustand umlegt, sähe aus wie dasselbe und wäre es nicht.

Der Folio-Bildschirm hat drei Eigenschaften, die bewusst so sind: **es gibt keinen Löschknopf** (Positionen sind Härtegrad 1, eine Korrektur ist eine Gegenbuchung und steht sichtbar darunter), **fakturierte Positionen sind erkennbar** (statt eine Änderung erst beim Versuch mit einer Fehlermeldung zu beantworten), und **der Hinweis steht am Zahlungsformular, nicht in einer Fußnote**: wer hier tippt, soll wissen, dass er zuordnet und nicht abwickelt.

---

### Aufgabe 11 — Mailversand über Brevo — **erledigt**

**Warum.** Das System erzeugte den Beleg nach EN 16931, legte ihn ab — und beim Gast kam er nie an. Der Weg vom Check-out bis zur Rechnung war an genau einer Stelle unterbrochen, und zwar an der letzten. Jede Rechnung musste von Hand heruntergeladen und aus einem zweiten Programm verschickt werden.

**Wo es liegt.** Migration `0028`, `packages/domain/src/email.ts` (Vorlagen und Wiederholungsregel), `apps/api/src/routes/email.ts` (Einstellungen, Versand, Postausgang), `apps/worker/src/jobs/emailDelivery.ts` und `apps/worker/src/email/brevo.ts`. Der Anbieter wird über seine **REST-API** angesprochen, nicht über SMTP.

**Was daraus entschieden wurde.**

- **Die API verschickt nichts.** Sie rendert das Anschreiben und reiht es in der Transaktion der Fachbuchung ein; zugestellt wird im Worker. Wer beides in einem Schritt täte, hätte die Wahl zwischen einer Rechnung ohne Mail und einer Mail ohne Rechnung — und der Check-out hinge am langsamsten Glied.
- **Der Aufrufer bestimmt den Empfänger, nie den Inhalt.** Das ist die Grenze, an der aus einem Rechnungsversand ein Versandapparat für beliebige Post würde. Betreff und Rumpf entstehen aus dem Fachdatum; übergeben werden kann nur die Adresse — und auch das nur, weil die Firma ihre Rechnung in der Buchhaltung will und nicht beim Reisenden.
- **Der Anhang ist der archivierte Beleg, nicht eine neu erzeugte Fassung.** Verschickt werden dieselben Bytes, die in `invoice_document` liegen, und ihr Fingerabdruck wandert an die Zustellung. Damit ist belegbar, welche Fassung der Gast bekommen hat.
- **Eine Rechnungsmail darf eingereiht werden, bevor der Beleg existiert.** Der Worker holt sie erst, wenn der Anhang bereitsteht — ohne einen Versuch zu verbrauchen. Sie ist nicht fehlgeschlagen, sie ist noch nicht dran. Wer sie trotzdem holte, hätte nach fünf Minuten eine Rechnung ohne Anhang aufgegeben, deren Beleg inzwischen fertig ist.
- **Ein dauerhafter Fehler wird nicht wiederholt.** Eine abgelehnte Adresse ist beim fünften Versuch genauso abgelehnt wie beim ersten. Fünfmal gegen eine 400 zu laufen verzögert alles andere und färbt beim Anbieter die eigene Absenderbewertung ein.
- **Nichts wird stillgelegt.** Beim Webhook ist die Stilllegung richtig, dort steht eine kaputte Gegenstelle. Hier hieße sie, dass eine einzige falsch getippte Gastadresse den Rechnungsversand des ganzen Hauses anhält.
- **Ein Übungshaus verschickt nichts**, und der Versand lässt sich dort nicht einmal einschalten. Schulungsdaten tragen echte Adressen, weil jemand seine eigene einträgt, um zu sehen wie es aussieht.
- **Gastadressen im Postausgang altern nach 90 Tagen.** Entfernt werden Empfänger und Anschreiben, nicht die Zeile: die Frage „ist die Rechnung rausgegangen" kann noch Jahre später kommen und lässt sich ohne Gastdaten beantworten.

**Mitbehoben, und das war der eigentliche Fund.** `truncateAll()` in `packages/testing` leerte den Berechtigungskatalog und säte ihn aus **Migration 0003 allein** wieder aus. Der Katalog wächst aber in späteren Migrationen — jedes dort hinzugefügte Recht fehlte damit in **jedem** Test. Der Befund sieht aus wie ein Fehler in der Route (403 statt 202), und gesucht wird an der falschen Stelle. Wiederhergestellt wird jetzt aus einer Kopie des tatsächlichen Standes; die kennt diese Frage nicht. Ebenso ist `formatCent` aus dem PDF-Blatt in die Domäne gewandert: zwei Formatierer für dieselbe Währung laufen auseinander, und der Unterschied fällt erst auf, wenn Rechnung und Anschreiben nebeneinander liegen.

**Noch offen.** Rückmeldungen über Zustellung und Bounces holt das System nicht ab — das wäre ein eingehender Webhook von Brevo. `sent` heißt deshalb *angenommen*, nicht *zugestellt*. Und der Adapter hat noch nie mit dem echten Brevo gesprochen: geprüft ist er gegen einen echten HTTP-Empfänger mit umgelenktem Ziel, also Kopfzeilen, Rumpfaufbau und Kodierung des Anhangs — aber nicht die Gegenseite.

---

### Aufgabe 12 — Rundung zwischen Netto- und Bruttosumme — **erledigt**

**Warum.** Die Steuer wird je Satzgruppe aus der **Nettosumme** gerechnet — so steht es in `CLAUDE.md`, und die Norm verlangt es ebenso (BR-CO-14 in EN 16931). Netto und Steuer sind beide auf den Cent gerundet, und daraus folgt etwas, das leicht zu übersehen ist: **nicht jeder Bruttobetrag ist darstellbar.** Zu 7 Prozent gibt es kein Netto, dessen aufgeschlagene Steuer 250,00 Euro ergibt — 233,64 plus 16,35 sind 249,99, 233,65 plus 16,36 sind 250,01. **Nachgemessen über die ersten 100 000 Centbeträge:** zu 7 Prozent sind **6,5 Prozent** der Bruttobeträge nicht darstellbar, zu 19 Prozent **16,0 Prozent** — also etwa jeder fünfzehnte und etwa jeder sechste. (Hier stand zuvor „zu 19 Prozent etwa jeder dritte"; das war geschätzt und zu hoch.)

Die Folge war unangenehmer als „ein Cent auf dem Papier". Ein Kassenbeleg über glatte 250,00 zu 7 Prozent erschien auf der Rechnung als 249,99. Der Gast zahlt, was auf dem Papier steht — und der eine Cent blieb auf dem Folio offen stehen. Für immer, weil niemand nach einem Cent sucht. Über mehrere Posten einer Satzgruppe wuchs die Abweichung; ein Barumsatz aus zehn Posten zu 19 Prozent ergab drei Cent.

**Was gebaut wurde.** Die Schlussrechnung weist jetzt den **Rundungsbetrag auf Belegebene** aus, BT-114 der EN 16931. Er berührt weder die Satzgruppen noch die Gesamtsumme BT-112, sondern allein den Zahlbetrag BT-115 über BR-CO-16: *Zahlbetrag = Gesamtsumme − Anzahlung + Rundung.* Damit fordert die Rechnung genau, was die Positionen zusammen ergeben, das Folio schließt auf null, und die Steuer bleibt normgerecht je Satzgruppe aus der Nettosumme gerechnet.

Sichtbar ist er an drei Stellen: als eigene Zeile „Rundung" auf dem Blatt (still in der Endsumme wäre er ein Fehler, den niemand erklären kann), als `ram:RoundingAmount` im eingebetteten XML, und als `roundingCent` samt `payableCent` in der festgeschriebenen Momentaufnahme `invoice.totals`. Der Beleg liest ihn von dort und rechnet ihn nicht neu — wäre er ableitbar, wäre er nicht nötig. Ist er null, wird er nirgends ausgegeben: ein `RoundingAmount` über 0,00 auf jedem Beleg ist Rauschen, das ein Prüfer erst einmal für einen Fehler hält.

**Warum keine eigene Position, obwohl das der naheliegende Weg ist.** Das war der erste Entwurf, und er ist an der eigenen Pflichtangabenprüfung gescheitert — zu Recht:

- **Zu 0 Prozent** braucht eine Position nach § 14 Abs. 4 Nr. 8 UStG den **Grund der Steuerbefreiung**. Für eine Rundung gibt es keinen, denn sie ist kein Umsatz. `invoiceRequirements.ts` hat die Rechnung entsprechend abgewiesen. Ein erfundener Grund wäre eine Falschangabe auf einem steuerlichen Beleg.
- **Im Satz der Gruppe** wirkt eine Position nicht in ihrer eigenen Höhe: sie verschiebt die Steuer der ganzen Gruppe mit. Um einen Cent Wirkung zu erzielen, müsste sie zu 7 Prozent rund **vierzehn Cent** groß sein — also genau der Betrag, den sie ausgleichen soll, wäre falsch.
- Eine Gruppe zu 0 Prozent in `totals.groups` stünde außerdem im DATEV-Stapel als steuerfreier Umsatz, den es nie gab.

BT-114 ist für genau diesen Fall in der Norm vorgesehen. Keine Position, keine Steuerkategorie, kein Befreiungsgrund.

**Wo der Cent sonst noch liegt.**

| Stelle | Stand |
|---|---|
| Schlussrechnung (`routes/billing.ts`) | **erledigt**: BT-114 gleicht auf den Cent aus, auch über mehrere Satzgruppen und gegen angerechnete Anzahlungen |
| Anzahlung (`depositLines` in `packages/domain/src/deposit.ts`) | unverändert: die Nettobeträge werden nachgestellt, bis die Rechnung den Eingang trifft. Das bleibt richtig, weil hier ein **vereinnahmter** Betrag aufgeteilt wird und das Journal denselben tragen muss — nicht ein geforderter Betrag ausgeglichen wird |
| Kassenumsatz (`routes/pos.ts`) | unverändert und richtig: die `charge`-Zeile trägt `gross_cent` der Kasse exakt. Die Abweichung entstand erst auf der Rechnung und wird dort ausgeglichen |
| Paketpreis (`splitPackage`) | setzt Zusatzleistungen mit festem Brutto an; die Summe der Teile trifft den Paketpreis exakt, weil der Rest Logis ist. Auf der Rechnung greift derselbe Ausgleich |

**Nebenbefund.** An der Grenze zur Kleinbetragsrechnung (§ 33 UStDV, 250 Euro) entscheidet jetzt der **geforderte** Betrag, nicht die Summe vor dem Ausgleich. Ein Beleg über glatte 250,00 lag vorher mit 249,99 unter der Grenze und wäre ohne Empfänger durchgegangen.

**Abnahme geprüft:** ein Kassenbeleg über 250,00 zu 7 Prozent ergibt eine Rechnung mit Gesamtsumme 249,99, Rundung 0,01 und Zahlbetrag 250,00; zahlt der Gast den Zahlbetrag, steht das Folio auf null. Ein Barumsatz aus zehn Posten zu 19 Prozent trägt drei Cent. Ist der Betrag darstellbar, gibt es keinen Rundungsbetrag und keine zusätzliche Position. Die Satzgruppen der Leistung bleiben unberührt; es entsteht keine Gruppe zu 0 Prozent. Belegt in `apps/api/src/__tests__/rundung.test.ts`, `packages/domain/src/__tests__/invoiceCii.test.ts` und `apps/worker/src/__tests__/invoiceDocument.test.ts`.

**Noch offen.** Ein Beleg mit gesetztem BT-114 ist noch nicht gegen einen **echten Validator** (KoSIT oder Mustang) gelaufen. Geprüft ist die XSD-Sequenz (BT-114 vor BT-112) und die Summenregel BR-CO-16 gegen den Wortlaut der Norm, nicht gegen ein Prüfwerkzeug.

---

### Aufgabe 13 — Onboarding, Einladung, Supportzugang

Beim Aufsetzen des Testhotels aufgefallen und hier benannt, weil es zusammengehört: **es gibt keinen Weg, einen Account oder ein Haus anzulegen.** Keine Route, nirgends. Die Tests und `db:testhotel` schreiben mit der Eigentümerrolle direkt in die Tabellen. Auf einer Produktivmaschine heißt das: der erste Kunde kommt nur über die Datenbank hinein.

Drei Stücke, in dieser Reihenfolge, weil jedes auf dem vorigen steht:

| # | Was | Stand |
|---|---|---|
| 13a | **Einmaltoken**: Einladung *und* Passwort vergessen | **fertig.** Migration 0030 (`auth_token`, `platform_email`), `POST /v1/auth/password-reset` und `.../confirm`, Zustellung im Worker. Ein Mechanismus für beide Anlässe, verschieden nur in Frist und Text |
| 13b | **Onboarding-Endpunkt** hinter Plattformrecht | **fertig.** `POST /v1/platform/accounts` hinter `platform:accounts`, Migration 0031 (`account_provision`). Account, erstes Haus, Inhaber und Einladung in einer Transaktion. Kein Selbstbedienungsweg; das ist eine Produktentscheidung, keine Lücke |
| 13d | **Zugangsseiten** der Oberfläche | **fertig.** `/einladung` und `/kennwort` samt „Kennwort vergessen" an der Anmeldung. Ohne sie bekam der eingeladene Kunde einen gültigen Link auf eine Seite, die es nicht gab |
| 13c | **Adminoberfläche** mit Support-Sitzungen | **fertig.** Migration 0032, Routen unter `/v1/platform/support-sessions` und `/v1/support-sessions`, Konsole für die Plattform, Freigabe beim Kunden unter Einstellungen. Ticketsystem weiterhin angebunden statt gebaut — siehe unten |

**Was 13a hinterlässt, worauf 13b aufsetzt.** Ein Token wird über `POST /v1/auth/password-reset` angefordert oder — für eine Einladung — beim Anlegen eines Benutzers als Zeile in `auth_token` hinterlegt; eingelöst wird beides über dieselbe Route. Der Onboarding-Endpunkt muss also keinen eigenen Einladungsweg bauen, sondern nur Token und Nachricht einreihen.

Drei Entwurfsentscheidungen darin, die beim Weiterbauen zu kennen sind:

- **In `auth_token` steht nur der Hash**, nie das Token. Wer eine Sicherung liest, bekommt damit keinen Zugang. Der Klartext steht einzig im Rumpf der wartenden Nachricht, und der Worker leert ihn, sobald sie durch ist.
- **`platform_email` statt `outbound_email`.** Gastpost ist hausgebunden, weist Übungshäuser ab und bleibt aus, solange der Versand am Haus nicht eingeschaltet ist. Für eine Zugangsmail wäre jede dieser Regeln falsch — sie gehört zu einem Benutzer, nicht zu einem Haus. Absender aus der Umgebung (`PLATFORM_EMAIL_FROM`), siehe [`17-betrieb.md`](17-betrieb.md) §7.
- **Immer 202**, auch für eine unbekannte Adresse, und die Route steht auf der strengen Liste der Ratenbegrenzung. Sonst wäre sie ein Verzeichnis darüber, welche Häuser diese Software benutzen.

**Warum 13b eine SQL-Funktion ist und keine Route mit Eigentümerverbindung.** Die Zeilenrichtlinie auf `account` lautet `USING (id = ANY (app_account_ids()))`, und ohne eigenes `WITH CHECK` gilt sie auch für `INSERT`. Ein neuer Account hat naturgemäß eine `id`, die in keinem Kontext steht — die Anwendungsrolle kann ihn deshalb **grundsätzlich** nicht anlegen. Migration 0006 benennt das schon: die Bereitstellung gehört der Eigentümerrolle und „wird nie für normale Anfragen benutzt".

Der naheliegende Weg wäre also eine zweite Verbindung in der API unter `hotelpms_owner`. Das wäre ein stehender `BYPASSRLS` im Anfrageprozess: wer dort Code ausführen kann, liest jeden Mandanten. `account_provision` ist statt dessen genau ein Loch, und es ist schmal — wer es aufruft, legt einen leeren Account an und sonst nichts. Die API hält weiterhin **keine** Eigentümerverbindung.

Die Funktion prüft zusätzlich selbst, dass der Mandantenkontext **leer** ist. Das Recht an der Route ist die eigentliche Tür; diese Prüfung ist die, die hält, wenn die erste beim nächsten Umbau falsch verdrahtet wird. Ein Test ruft die Funktion direkt mit gesetztem Kontext auf und erwartet den Abbruch.

**Mitgefunden, noch offen:** `assert_property_in_context` (Migration 0006) behandelt einen leeren Kontext als Systemarbeit und lässt dann **jede** Property durch. Für Worker und Migration ist das richtig. Plattformpersonal hat aber ebenfalls einen leeren Kontext — für das Lesen ist das folgenlos, weil die Zeilenrichtlinie nichts liefert, aber die Inventarfunktionen sind `SECURITY DEFINER` und prüfen nur über diese Zusicherung. Heute nicht erreichbar, weil die Plattformrollen keines der Fachrechte tragen, mit denen man an die betreffenden Routen käme. Wer der Plattform jemals ein Fachrecht gibt, muss das vorher auflösen — etwa über eine ausdrückliche Systemkennzeichnung statt „leer heißt System".

**Zu 13d.** Die beiden Seiten liegen in `main.tsx` **vor** der Frage, wer angemeldet ist: wer den Link aus seiner E-Mail anklickt, ist es gerade nicht, und die Anmeldemaske verlangte genau das Kennwort, das er nicht hat. Ausgewertet wird der Pfad (`try_files` in Caddy liefert dafür `index.html`); `zugangAusAdresse()` nimmt Pfad und Abfrageteil als Parameter, damit sich das ohne Browser prüfen lässt — ein zu großzügiger Vergleich ersetzt sonst die ganze Anwendung durch die Zugangsseite.

Die Kennwortregel ist dabei von `packages/domain` nach `packages/contracts` gewandert. Sie ist keine Fachlogik, sondern eine Zusage an beide Enden: die Schnittstelle weist ein zu kurzes Kennwort ab, die Oberfläche nennt die Länge vorher. Zwei Fassungen liefen auseinander, und der Befund wäre ein Benutzer, dem die Maske zwölf Zeichen nennt und die Antwort vierzehn verlangt.

**Zu 13c, weil es leicht falsch verstanden wird.** „Anmelden, als wäre man der Kunde" ist hier bewusst **nicht** gebaut und soll es nicht werden. Plattformpersonal ohne freigegebene, befristete Sitzung bekommt einen leeren Mandantenkontext — die Zeilenrichtlinie liefert dann nichts. Der Kunde gibt frei, die Sitzung läuft ab, und jede Handlung trägt im Protokoll ihre `support_session_id`. Eine stille Übernahme wäre bei Auftragsverarbeitung (Art. 28 DSGVO) nicht haltbar und im Protokoll nicht von der Handlung des Kunden zu unterscheiden.

**Was 13c tatsächlich tut — und was dabei gefunden wurde.** Das Fundament stand seit Migration 0002, aber es war **doppelt wirkungslos**, und beides fiel nicht auf, weil der Test dazu `accountIds` und `supportSessionId` prüft und nie, ob jemand mit der Sitzung etwas lesen kann:

1. `applySupportSession` trug `permissionsByProperty` mit **leeren** Rechtemengen ein, während der Kommentar daneben „die Rechte einer Hoteldirektion" versprach. Eine freigegebene Sitzung bekam auf jeder Fachroute 403.
2. Der Zugriffsbereich kam aus `SELECT id FROM property WHERE account_id = $1` unter `SYSTEM_CONTEXT` — also mit leeren `app_property_ids()`, während `property` eine erzwungene Zeilenrichtlinie über genau diese Liste trägt. Die Abfrage lieferte **null** Zeilen. Dieselbe Falle wie in den Migrationen 0014 und 0018; für OAuth ist sie in 0025 als `oauth_account_properties()` gelöst, der Support-Pfad hat es nie bekommen. Jetzt `account_active_properties()`.

Was eine Sitzung darf, steht in [`apps/api/src/platform/support.ts`](../apps/api/src/platform/support.ts) als **positive** Liste je Stufe — eine Sperrliste wäre die falsche Bauart, weil ein später hinzugefügtes Recht darin automatisch erlaubt wäre. Zwei Stufen, weil Datenminimierung (Art. 5 Abs. 1 lit. c DSGVO) „nicht mehr als nötig" heißt und das am Anlass hängt: Fehlersuche braucht Lesen, eine erbetene Korrektur braucht Schreiben. Der Kunde gibt die Stufe mit frei und sieht dabei, was sie umfasst.

**Keine Stufe enthält je:** Ausweisdaten (§ 30 BMG), das Anstoßen von DSGVO-Auskunft und Löschung, Rechnungen festschreiben oder gutschreiben, Exporte nach außen (DATEV, GoBD, Statistik), Benutzer- und Schnittstellenverwaltung, Account-Einstellungen und Vertrag. Die beiden vorletzten sind der eigentliche Punkt: `user:manage` und `integration:manage` würden erlauben, sich einen Benutzer oder einen API-Client anzulegen — beides überlebt die Sitzung, und damit wäre die Befristung, also der ganze Mechanismus, umgangen.

Ein Trigger hält Stufe, Anlass und Beteiligte fest, sobald angefragt ist, und verhindert das Verlängern der Frist und das Wiederbeleben einer widerrufenen Sitzung. Ohne ihn ließe sich nach der Freigabe nachschieben — und im Protokoll stehen die Handlungen, nicht die Rechte, unter denen sie geschahen.

**Ticketsystem:** angebunden, nicht gebaut. Verlauf, Postfachanbindung, Zuweisung und Suche sind Wochen Arbeit und haben mit Hotels nichts zu tun. Die Adminoberfläche verlinkt, und die Support-Sitzung trägt die Ticketnummer als Grund.

---

### Belegungsplan: Gruppenbuchung und Arbeitsplatzwechsel — **erledigt**

**Warum.** Eine Sichtung der Oberfläche gegen die laufende Anwendung, angestoßen von der Rezeption: „Buchungen lassen sich im Kalender nicht verschieben, und Gruppenbuchungen über mehrere markierte Zimmer gibt es nicht."

Der erste Teil des Befunds war **falsch, und die Ursache trotzdem echt**. Verschieben gibt es seit `33cd009`; ein Zug mit der Maus löst `assign-unit` aus, im Browser nachgefahren. Nur sagte es niemand: der Balken trug `hover:ring-2` und keinen `cursor-move`, der Zeiger blieb ein Pfeil. **Eine Funktion, die niemand findet, ist keine** — das ist der eigentliche Fund, und er gilt über diesen Bildschirm hinaus. Jetzt tragen die Balken `cursor-move`, die freie Fläche `cursor-crosshair`, und unter dem Plan steht eine Zeile, die die drei Gesten benennt.

Der zweite Teil stimmte: eine Modifikatortaste wurde in der gesamten Oberfläche nirgends ausgewertet.

**Was eine Gruppenbuchung hier ist.** Eine `booking` mit mehreren `reservation`, so wie das Datenmodell es seit `0009` vorsieht — nicht mehrere Buchungen nebeneinander. Der Unterschied ist nicht kosmetisch: die Gruppe hat einen Besteller, eine Herkunft und am Ende eine Rechnung; acht lose Vorgänge verbindet später nichts mehr. `POST /v1/bookings` nimmt dafür `rooms`, und die Einzelbuchung ist von innen die Gruppe mit einem Zimmer — zwei Pfade wären zwei Fassungen von Zimmerprüfung, Preis, Folio und Ereignis, und die zweite würde beim nächsten Befund vergessen.

Das ist ausdrücklich **nicht** dasselbe wie ein Kontingent. Ein Kontingent hält Zimmer einer Kategorie, ohne sie zu verkaufen, und die Zimmernummern stehen erst am Anreisetag fest; das bleibt der Weg für die große Reisegruppe. Die Mehrfachauswahl ist der Weg für die acht Zimmer, die jemand jetzt konkret zusagt.

Vier Festlegungen daraus:

- **Der Zeitraum gilt für alle Zimmer.** Aufgezogen wurde ein Rechteck, und ein Rechteck hat eine Breite. Ein Feld je Zimmer hätte den Abruf aus einem Kontingent unentscheidbar gemacht, der immer über den ganzen Zeitraum läuft.
- **Der Besteller wird nur im ersten Zimmer als Mitreisender geführt.** Er ist nicht der Bewohner von acht Zimmern; in jedes eingetragen zählte die Kurtaxe ihn achtmal, und die Rechnung sähe dabei plausibel aus. Die übrigen Zimmer bleiben ohne Eintrag, und `erwarteteSaetze` rechnet dann mit einer Person je Zimmer.
- **Bestand wird je Zimmergruppe in einem Aufruf gebunden**, nicht je Zimmer. `inventory_reserve` sperrt die Bestandszeilen des Zeitraums; acht Aufrufe sperrten sie achtmal.
- **Ein Ereignis je Reservierung**, mit derselben `bookingRef`. Ein Kanalmanager führt seine Zimmer einzeln, und die bestehenden Empfänger erwarten `reservationRef` im Singular.

**Mitgefunden und behoben:** `POST /v1/bookings` prüfte nie, ob die Zimmergruppe zu diesem Haus gehört. Bei einem Benutzer mit **einem** Haus fängt die Zeilenrichtlinie das ab; bei zweien — in einer Kette der Normalfall — stand die fremde Gruppe in seinem Kontext, und die Buchung scheiterte erst an `inventory_reserve`, also mit einer Meldung über fehlenden Bestand statt über die falsche Gruppe.

**Die Namensliste, nachgereicht.** Hier stand zuerst, alle Zimmer einer Gruppe trügen den Besteller als Hauptgast und das sei die Lücke. Das war an der falschen Stelle aufgehängt: **im Plan ist der Name des Buchers richtig.** Ein Bucher nimmt fünf Zimmer, die übrigen Namen stehen bis zum Anreisetag nicht fest, und ein Balken ohne Namen ist an der Rezeption unbrauchbar.

Die Lücke lag einen Moment später — am Tresen, wenn die Namen bekannt sind. Dort ging es nicht: `PATCH /v1/reservations/:ref` konnte nur die Notiz, und die Check-in-Maske zeigte den Hauptgast an, ohne ihn ändern zu können. Ohne Gast war sie sogar eine Sackgasse („kein Gast hinterlegt", und nichts weiter) — bei einer Gruppe der Normalfall für vier von fünf Zimmern.

`PATCH` nimmt jetzt zusätzlich `guestRef`, unter zwei Bedingungen. **Nicht nach dem Check-in:** der Meldeschein liegt dann vor und ist eine Erklärung dieser Person über sich selbst; den Hauptgast danach auszutauschen ließe eine Unterschrift unter einem fremden Namen stehen. **Nicht nach dem Fakturieren:** am Folio hängt der Rechnungsempfänger, und der steht dann auf einem Beleg mit Härtegrad 1. Der Mitreisendeneintrag wandert mit — sonst stünde in `reservation_occupant` weiter der Bucher, und die Personenzahl auf dem Meldeschein zählte jemanden, der gar nicht da ist.

**Der Arbeitsplatzwechsel** war derselbe Fall wie das Verschieben, nur schlimmer: `POST /v1/auth/workstation-switch` steht seit Anfang, prüft den PIN korrekt — und **niemand konnte je einen PIN setzen**. Es gab keine Route dafür; außer zwei Tests, die die Spalte direkt beschreiben, war das Feld in der ganzen Anwendung leer. Dazu kam jetzt `POST /v1/auth/workstation-pin` (nur der eigene, und nur gegen das eigene Kennwort) und die Maske hinter dem Namen in der Kopfleiste.

Beim Bauen fielen an dieser Route drei Löcher auf, und jedes einzelne stand offen:

1. **Die Ratenbegrenzung greift hier nicht.** Sie nimmt angemeldete Anfragen aus, und diese Route trägt immer ein gültiges Sitzungscookie — der Pfad steht zwar auf der strengen Liste, wurde davon aber nie erreicht. Ein vierstelliger PIN ließ sich in Sekunden durchprobieren. Jetzt zählt sie ihre Fehlversuche selbst, je Zielperson.
2. **Das Ziel musste zu nichts gehören.** Adresse und PIN irgendeines Benutzers der ganzen Datenbank genügten — ein Weg von einem Kunden zum nächsten, den die Zeilenrichtlinie nicht deckt, weil die Abfrage ohne Mandantenkontext läuft. Jetzt muss das Ziel mindestens ein Haus mit der angemeldeten Person teilen.
3. **Der Weg zurück war nicht gesichert.** Zurückwechseln verlangt denselben Nachweis wie hinwechseln; wer selbst keinen PIN hat, wäre nach dem ersten Wechsel aus seiner eigenen Sitzung ausgesperrt gewesen. Die Route verlangt deshalb, dass die angemeldete Person selbst einen PIN hinterlegt hat.

Der Fehlversuchszähler ist **getrennt von dem der Anmeldung** (Migration `0035`), und das ist die Stelle, an der das Naheliegende falsch gewesen wäre. Dasselbe Konto, dieselbe Gefahr — aber wer bei einem gemeinsamen Zähler den PIN eines Kollegen falsch rät, sperrt dessen **Anmeldung**. Ein Mitarbeiter mit irgendeiner Sitzung könnte die Hausleitung aus dem System aussperren, ohne ein Kennwort zu kennen. Getrennt gezählt sperrt derselbe Angriff nur den Personenwechsel.

---

### Ausrollen: was und wann sind getrennt

Bis zur Erstinbetriebnahme gab es nur `deploy.sh` von Hand. Bei mehreren Bearbeitern, die täglich nach `main` mergen, heißt das: die Maschine hinkt beliebig weit hinterher, und niemand sieht es.

Ein Timer, der einfach zieht, wäre die falsche Antwort gewesen — er rollte mitten im Check-in aus und nähme, was gerade auf `main` liegt. Getrennt wird deshalb:

- **was** — der Git-Tag `produktion`. Die Maschine holt nur diesen Stand. Wer ihn verschiebt, gibt frei.
- **wann** — ein Knopf im Adminpanel unter *Betrieb*, hinter `platform:operations`. Die API schreibt eine Zeile in `deploy_request`; `ops/deploy/deploy-agent.sh` führt sie aus.

**Die API führt nichts aus, und das ist der Kern.** Sie läuft unter `NoNewPrivileges=true` — `sudo` ist ihr gesperrt, der Dienstneustart braucht es. Genau deshalb ist ein Einbruch in die Anwendung nicht gleich die Maschine. Der ausführende Dienst trägt die Rechte, die Anwendung nicht.

**Gebaut wird neben dem laufenden Stand.** Je Commit ein Verzeichnis unter `releases/`, und erst wenn es vollständig ist, schaltet ein Symlink um. Vorher wurde im laufenden Verzeichnis gebaut — ein gescheiterter Bau ließ dann einen Quellbaum auf dem neuen Commit und ein halb überschriebenes `dist/` zurück, was erst beim nächsten Neustart der Maschine aufgefallen wäre. Das Zurückrollen fällt dabei ab: Symlink umlegen, Dienste neu starten, in Sekunden durch. Migrationen wandern nicht mit zurück — das Schema bleibt auf dem neueren Stand, was für hinzufügende Änderungen folgenlos ist.

Ein eindeutiger Teilindex lässt höchstens eine offene Anforderung zu: zwei gleichzeitige Läufe zögen sich im selben Verzeichnis die Dateien weg, und heraus käme ein halber Stand, den niemand als solchen erkennt. Einzelheiten in [`21-inbetriebnahme.md`](21-inbetriebnahme.md) §8.

---

### Meldeschein: zwei Befunde beim Bauen der Namensliste

**Die Gastauswahl war zwei Bildschirme lang wirkungslos.** Ein Klick auf einen Treffer der Gastsuche wählte den Gast aus und nahm die Auswahl im selben Wimpernschlag zurück. Der Grund liegt im `<label>`, das sie umschloss: es leitet einen Klick an sein erstes bedienbares Kind weiter. Vor der Auswahl ist das das Suchfeld, **danach** steht dort der Knopf „Ändern" — und der ruft `onChange(null)`. `POST /v1/bookings` ging deshalb aus dem Buchungsdialog immer ohne `guestRef` hinaus, und niemandem fiel es auf, weil die Buchung ja gelang: sie hatte nur keinen Gast. Ein Test über die Quelle hält jetzt fest, dass die Auswahl in keinem `<label>` steht; im Browser nachgefahren, weil eine DOM-Umgebung für die Oberfläche hier nicht eingerichtet ist.

**Ein Mitreisender kam auf den Meldeschein, aber nicht in die Personenliste.** `POST /v1/registrations` legte den Sammelmeldeschein an und ließ `reservation_occupant` unberührt. Die Kurtaxe rechnet aus dieser Tabelle — gemeldet waren drei Personen, berechnet wurde eine, und die Rechnung sah dabei richtig aus. Genau der Fall aus Migration 0014: keine Fehlermeldung, sondern eine plausibel aussehende falsche Zahl. Aufgefallen ist es erst, als die Maske überhaupt anfing, `occupantGuestRefs` zu schicken — die API nahm sie seit jeher an, geschickt hat sie nie jemand.

Für den Meldeschein gab es bis dahin **keinen einzigen Test**, obwohl dort drei Regeln zusammenkommen, deren Bruch erst bei einer Prüfung auffällt. Jetzt dreizehn: dass ein inländischer Gast keine Unterschrift bekommt und eine mitgeschickte **verworfen** wird, dass ein ausländischer ohne Unterschrift abgewiesen wird, dass die Frist ab **Anreise** läuft, und dass jeder Mitreisende einen eigenen Datensatz am Hauptschein bekommt.

---

### Fristen nach Landes- und Kommunalrecht, und Hausbedingungen

Ausgelöst von der Frage, ob Länder und Gemeinden längere Aufbewahrung vorschreiben. Die Antwort ist dreigeteilt, und die Trennung ist der ganze Punkt.

**Der Meldeschein lief ab dem falschen Tag.** § 30 Abs. 4 BMG sagt „vom Tag der **Abreise** der beherbergten Person an ein Jahr". Gerechnet wurde ab **Anreise** — bei drei Nächten drei Tage zu früh vernichtet, bei einem Langzeitgast Wochen. Zu früh vernichtet heißt: die Meldebehörde verlangt Einsicht und bekommt sie nicht, obwohl die Frist noch läuft. Der Test dazu hielt den Fehler fest, statt ihn zu fangen.

Die Abreise steht bei der Erfassung außerdem noch nicht fest. Ein Trigger auf Anweisungsebene zieht die Frist nach, wenn sich der Aufenthalt ändert, und rechnet mit dem **tatsächlichen** Abreisetag (`checked_out_at`), sonst dem geplanten. Nicht ein Aufruf in jeder Route, die an `departure` rührt: davon gibt es mehrere, und die nächste würde ihn vergessen.

**Die längere Frist gilt einem anderen Nachweis.** Die Gästebeitragssatzung der Stadt Cuxhaven verlangt in § 9 Abs. 5 das Gästeverzeichnis „sechs Jahre ab Beginn des auf die Eintragung folgenden Kalenderjahres"; ein Verstoß ist eine Ordnungswidrigkeit mit Geldbuße bis 10 000 Euro. Das ist **nicht** der Meldeschein: das Verzeichnis führt Name, Anschrift, Zeitraum, Nächte, Satz und Betrag — also das, was ohnehin in Beleg und Rechnung steht. Der Meldeschein trägt darüber hinaus Ausweisnummer und Staatsangehörigkeit, und für die gibt es nach einem Jahr keinen Rechtsgrund mehr; ihn „wegen der Gästebeiträge" länger zu halten, wäre der falsche Schluss.

Die Frist steht deshalb am Haus (`property.guest_levy_retention_years`, Standard sechs) und bremst die **Anonymisierung**, nicht den Meldeschein — und auch die nur dort, wo wirklich eine Abgabe gebucht wurde, also an einer Position mit einer Regel der Art `city_tax` oder `bed_tax`. Solange sie läuft, ist die Aufbewahrung eine rechtliche Verpflichtung, und Art. 17 Abs. 3 lit. b DSGVO nimmt sie von der Löschung aus. Die Ermächtigung steht in den Kommunalabgabengesetzen der Länder, nicht im Bundesrecht — deshalb je Haus und nicht als Konstante.

**Unterschrieben wird in der Praxis mehr als der Meldeschein.** Viele Häuser lassen den Gast zugleich eine Hausbedingung unterschreiben, etwa eine Pauschale bei Verlust der Zimmerkarte. Zulässig — aber nicht auf demselben Blatt im System:

| | Meldeschein | Hausbedingung |
|---|---|---|
| Rechtsnatur | öffentlich-rechtlich, § 30 BMG | privatrechtlich |
| Unterschrift | nur ausländische Gäste (seit 1.1.2025) | jeder Gast |
| Frist | ein Jahr nach Abreise, dann Vernichtung | über die Verjährung hinaus |

Beides in ein Feld zu schreiben hieße, entweder den Meldeschein zu lange zu halten oder den Nachweis der Vereinbarung mit ihm zu vernichten. Deshalb `property_terms` (der Text am Haus) und `guest_agreement` (die Zustimmung am **Aufenthalt**, nicht am Meldeschein).

Zwei Festlegungen daraus: **Fassungen statt Änderungen** — wer die Pauschale von 50 auf 60 setzt, legt eine neue an; ein geänderter Text unter einer alten Unterschrift wäre als Nachweis wertlos, dieselbe Überlegung wie bei `invoice.issuer_snapshot`. Und **maßgeblich ist die am Anreisetag geltende Fassung**, nicht die neueste: der Gast hat bei der Ankunft den Text vor sich, der dann hängt.

**Nachgetragen: die Ausweisnummer hatte gar keine Frist.** Die Frage „widersprechen sich die sechs Jahre und die zwölf Monate nicht?" hat einen echten Fehler aufgedeckt, und zwar einen, den der Abschnitt oben erst scharf gemacht hat.

§ 30 Abs. 2 BMG erlaubt, die Nummer des Identitätsdokuments zu notieren; Absatz 4 verlangt, den Meldeschein ein Jahr nach Abreise zu vernichten. In diesem System stand die Nummer aber **nie auf dem Meldeschein**, sondern am Gastprofil (`guest.id_document_number_enc`, seit Migration 0008) — und `purgeRegistrations` löschte nur `registration`. Die Nummer blieb unbegrenzt liegen; der einzige Weg, sie loszuwerden, war die Anonymisierung auf Antrag.

Und genau davor hat Migration 0036 die Abgabenfrist gestellt. Damit stand der letzte Löschweg bis zu sieben Jahre lang zu, und aus einem stillen Versäumnis wurde ein handfester Widerspruch: eine kommunale Abgabenfrist hätte eine bundesrechtliche Vernichtungspflicht ausgehebelt.

Aufgelöst nicht dadurch, dass eine der beiden Fristen weicht — die eine steht im BMG, die andere in der Satzung —, sondern dadurch, dass jede das tut, wofür sie da ist: **das Gästeverzeichnis braucht die Ausweisnummer nicht.** Sie fällt jetzt im Nachtlauf ein Jahr nach der Abreise, unabhängig von jedem Antrag und jeder Abgabenfrist (`guest_document_purge`). Geburtsdatum und Staatsangehörigkeit bleiben: sie tragen die Beherbergungsstatistik, die Unterschriftspflicht und die Altersfreigrenze der Kurtaxe — sie mitzulöschen wäre Übererfüllung mit Folgeschaden.

**Und die Löschung läuft jetzt in zwei Schritten.** Das glatte 409 aus 0036 hielt mehr zurück, als die Satzung verlangt: E-Mail, Telefon, Geburtsdatum, Vorlieben und Hausnotizen braucht kein Verzeichnis, und Art. 17 Abs. 3 lit. b DSGVO nimmt nur aus, was die Pflicht wirklich fordert. Wer heute Löschung verlangt, bekommt sofort alles außer Name und Anschrift; der Rest fällt im Nachtlauf, sobald die Frist abgelaufen ist (`erasure_requested_at`, `guest_erasure_complete`). Dass das nicht vergessen wird, hängt an einer Spalte und nicht an einer Wiedervorlage — zwischen Antrag und Frist liegen Jahre.

**Das Gästeverzeichnis als Ausgabe** gibt es jetzt: `GET /v1/properties/:id/exports/guest-levy`, als JSON und als CSV.

**Warum eine Liste und kein Anbieterformat.** Die Meldung an die Gemeinde läuft in Deutschland über verschiedene Wege. [AVS](https://www.avs.de/tourismus/meldeschein) ist der größte Anbieter — über 300 Orte in DACH, Auftragsverarbeiterin der Gemeinden, zwei Wege (XML-Import von Hand und ein Webservice), über 120 angebundene Hotelprogramme. Daneben [feratel Deskline](https://www.feratel.de/unsere-loesungen/meldewesen/) mit XML über HTTP POST und SOAP, `secra bookings`, Gemeindeportale wie Amt24 in Sachsen — und Orte, die schlicht einen Vordruck herausgeben, wie Cuxhaven.

Die Schnittstellenbeschreibungen von AVS und feratel sind **nicht öffentlich**; AVS gibt sie auf Anfrage heraus. Wer ohne sie ein Format nachbaut, baut eine Vermutung und merkt es beim ersten echten Kunden.

Was dagegen überall gleich ist, ist der **Inhalt**: wer, woher, wie lange, wie viele Nächte, welcher Satz, welcher Betrag. Genau das liefert der Endpunkt — als Liste, die jede Gemeinde annimmt, und als Grundlage, auf der ein Anbieteradapter später aufsetzt, statt die Abfrage ein zweites Mal zu schreiben. Dieselbe Bauart wie bei den Altsystem-Importen (`platform/legacyImport/`): ein Kern, dünne Adapter.

Drei Festlegungen: **eine Zeile je Aufenthalt und Abgabenart** — zwei Abgaben nebeneinander sind zwei Satzungen. **Gerechnet wird aus den gebuchten Positionen, nicht aus der Regel** — ein Satz, der zum Jahreswechsel gestiegen ist, machte aus einer Neuberechnung eine plausibel aussehende falsche Zahl, und der Nachweis muss zu der Rechnung passen, die der Gast bekommen hat. Und die **Gästekartennummer fehlt bewusst**: die vergibt das System der Gemeinde, nicht das Haus.

**Noch offen:** die Adapter selbst. Für AVS und feratel fehlen die Schnittstellenbeschreibungen; das ist eine Anfrage beim Anbieter, keine Programmierarbeit.

---

### Das Band der Buchungen ohne Zimmer

**Was dort liegt.** Eine Reservierung braucht eine Zimmergruppe, aber kein Zimmer. Der Channel Manager legt gar keines an — `routes/channel.ts` kennt die Spalte `resource_id` in seinem `INSERT` nicht —, und auch eine Option am Telefon wird oft nur auf die Gruppe gebucht. Solche Buchungen zählen in der Verfügbarkeit voll mit, stehen aber in keiner Zimmerzeile. Der Plan zeigt sie deshalb in einem eigenen Band über den Zeilen, und von dort zieht die Rezeption sie in ein Zimmer.

**Drei Befunde beim Nachsehen, alle drei still:**

**Das Band zeigte vier und zählte alle.** Es war auf `slice(0, 4)` begrenzt. Die Warnung darüber nannte die richtige Zahl — „19 ohne Zimmer" —, sichtbar und damit zuweisbar waren vier. Bei einem Haus mit angebundenem Channel Manager ist das nicht der Randfall, sondern der Normalfall: der Rest war im Plan unerreichbar. Das Band scrollt jetzt statt abzuschneiden, standardmäßig vier Zeilen hoch. `overscroll-contain` hält das Scrollen im Band: sonst rutscht der ganze Plan weg, sobald man unten ankommt — zwei Scrollflächen ineinander sind genau dann unangenehm, wenn man sie nicht auseinanderhält.

**Am Balken stand die Zimmergruppe nicht.** Im Band liegen Einzelzimmer, Doppelzimmer, Ferienwohnungen und Suiten übereinander, und beim Ziehen entscheidet sich in einer Sekunde, wohin. Jeder Balken trägt jetzt das Kürzel der gebuchten Gruppe, und das Band ist nach Gruppe sortiert, nicht nur nach Anreise.

**Die Warnung „zu klein" rechnete mit der falschen Zahl.** Sie verglich die Plätze des Zielzimmers mit der Zahl der erfassten Belegten — und die steht bei einer Buchung aus dem Channel Manager auf **1**: angelegt wird genau ein Belegter, der Bucher; die weiteren Namen fallen erst beim Check-in an. Ein Doppelzimmer aus dem Channel war damit im Einzelzimmer „groß genug", und die Warnung fehlte genau dort, wofür sie gebaut war.

Gerechnet wird jetzt mit dem **verkauften Produkt**: ein Doppelzimmer ist für zwei verkauft, ob der zweite Name bekannt ist oder nicht (`category_max_occupancy` im Belegungsplan, `platzbedarf()` in `tapeSelection.ts`). Sind mehr Personen erfasst, als die Gruppe fasst — vier in einem Doppelzimmer mit Aufbettung —, zählt die größere Zahl.

Beim Ziehen färben sich die Zeilen danach: grün die gebuchte Gruppe, rot die zu kleinen, neutral der Rest. Neutral ist die wichtige Mitte — eine andere Gruppe, die groß genug ist, ist ein Upgrade und Alltag; abgerechnet wird, was gebucht wurde. Die API prüft die Gruppe deshalb bewusst nicht. Gefragt wird beim Loslassen, nicht beim Ziehen: eine Rückfrage mitten in der Geste steht im Weg.

---

### Das Adminpanel

**Was es vorher gab.** Eine Seite mit drei Abschnitten — Support-Sitzung anfragen, eigene Sitzungen, Ausrollen —, erreichbar in genau einem Zustand: angemeldet als Plattformpersonal **ohne** laufende Support-Sitzung. Dann hat der Benutzer kein Haus, und statt einer Fehlermeldung erschien die Konsole. Das war als Normalzustand gedacht und hieß zugleich: sobald eine Sitzung lief, war der Bildschirm weg, samt Ausrollknopf. Erreichbar sein und zufällig sichtbar sein ist nicht dasselbe.

Dazu kam: es gab **keine Route, die Kunden aufzählt**. Das Formular für die Support-Sitzung fragte deshalb nach einer numerischen Konto-Kennung, die man von Hand eintippt — man musste die Nummer des Kunden kennen, um ihm zu helfen. Kunden anlegen lief über `curl`, ein weiterer Plattformbenutzer über ein Skript auf der Maschine.

**Was jetzt steht.** Ein eigener Eintrag in der Navigation für Plattformpersonal, unabhängig von einer laufenden Sitzung, mit vier Reitern — und jeder Reiter erscheint nur, wer das passende Plattformrecht hat. Ein Support-Zugang sieht zwei davon, nicht vier mit drei Fehlermeldungen darin.

| Reiter | Recht | Was er kann |
|---|---|---|
| Kunden | `platform:accounts` | Liste mit Häusern, Benutzern und letzter Anmeldung; Detail mit Häusern (samt `is_training`), Benutzern und ihren Rollen; sperren, entsperren, archivieren; Kunden anlegen |
| Plattformbenutzer | `platform:staff` | Liste mit Rolle und Zustand; anlegen und einladen; stilllegen und freigeben |
| Betrieb | `platform:operations` | Was hängt, je Kunde; ausrollen und zurückrollen |
| Support | `platform:support_session` | Sitzung anfragen, eigene Sitzungen |

**`platform:staff` ist ein neues, eigenes Recht** und hängt allein an `platform_admin`. Plattformbenutzer anzulegen ist die eine Handlung, mit der sich der Kreis der Berechtigten selbst erweitert; wer Kunden betreut, muss nicht auch Kollegen mit Vollzugriff anlegen dürfen. Zwei Sperren stehen davor: den eigenen Zugang legt niemand still, und der letzte aktive Plattform-Admin bleibt stehen.

**Ein vorhandener Benutzer wird nie nachträglich zu Plattformpersonal.** Dieselbe Regel wie im Skript `db:plattformbenutzer`, und aus demselben Grund: ein Tippfehler in der Adresse genügte sonst, um einem Hotelier Vollzugriff auf die Plattform zu geben. Ein neuer Zugang bekommt eine Einladung und setzt sein Kennwort selbst — eines, das durch einen Chat gegangen ist, ist ab dem ersten Tag kompromittiert.

**Warum jede Abfrage durch eine SQL-Funktion geht.** `account` und `property` tragen eine erzwungene Zeilenrichtlinie, und Plattformpersonal hat ohne freigegebene Sitzung einen **leeren** Mandantenkontext — das ist der Kern des Entwurfs. Eine gewöhnliche Abfrage käme hier still leer zurück, ohne Fehler und ohne Meldung. Genau so sind die Befunde der Migrationen 0014, 0018 und 0032 entstanden. Migration 0038 legt deshalb `SECURITY DEFINER`-Funktionen an, und die Rechteprüfung steht **in** der Funktion (`platform_can`), nicht nur an der Route: eine vergessene Berechtigung an einer Route wäre sonst der ganze Datenbestand.

**Was das Panel bewusst nicht zeigt:** keine Gastdaten, keine Buchungen, keine Umsätze. Der Zugriff auf Kundendaten läuft über eine vom Kunden freigegebene Support-Sitzung und ausschließlich darüber. Der Betriebszustand nennt Zahlen und Zeitpunkte — eine Gastpost trägt Namen und Anschrift, ein Webhook den Rumpf einer Buchung. Zwei Tests halten das fest: einer prüft, dass keine Antwort des Panels ein Kennwort oder Geheimnis enthält, einer, dass die Oberfläche keine einzige Fachroute eines Hauses aufruft.

**Und der Befund beim Bauen: die Sperre sperrte nichts.** `account.status` gibt es seit Migration 0002 mit `active`, `suspended`, `archived`, und das Recht heißt seit Migration 0003 „Accounts anlegen, **sperren**". Gelesen wurde die Spalte an keiner einzigen Stelle — weder beim Anmelden noch beim Aufbau des Zugriffsbereichs. Ein Knopf dafür wäre ein Knopf gewesen, der lügt.

Jetzt endet der Zugriffsbereich am Zustand des Kunden, und zwar auf beiden Ebenen: `user_property_scope` verlangt zusätzlich einen aktiven Account, `user_account_scope` deckt die Account-Rolle ab, die ihren Account im Aufbau des Principals direkt mitbringt — ohne sie wäre die Sperre auf halbem Weg stehengeblieben. Eine Property-Rolle wirkt außerdem nur noch, wenn ihr Haus im Zugriffsbereich steht; vorher wirkte sie unabhängig davon.

**Der Support bleibt ausdrücklich davon unberührt** (`account_active_properties`): wer gesperrt ist, ist meist gerade der, dem geholfen werden muss, und eine Sperre, die auch den Support aussperrt, macht aus einer offenen Rechnung einen Totalausfall.

**Und der gesperrte Kunde erfährt, warum.** Er meldet sich weiterhin an — gesperrt ist der Account, nicht der Benutzer — und läse sonst „diesem Benutzer ist noch kein Haus zugeordnet". Das ist der Satz, nach dem montags um sieben jemand anruft und niemand weiß, warum. `/v1/auth/me` unterscheidet die beiden Fälle jetzt (`accountSuspended`), und die Oberfläche sagt den passenden Satz, ohne einen Grund zu nennen: der gehört zwischen den Kunden und uns, nicht auf einen Anmeldebildschirm.

**Zweiter Durchgang: die Handgriffe des Supports.** Der erste konnte mit dem häufigsten Anruf nichts anfangen — „Frau X kommt nicht mehr rein". Zu sehen war, dass sie gesperrt ist; zu tun war nichts. Jetzt stehen an jedem Benutzer des Kunden drei Knöpfe, und keiner davon fasst ein Kennwort an: **Entsperren** (Anmelde- und PIN-Sperre, Migration 0035), **Link schicken** (Einladung erneut für `invited`, Kennwort-Ruecksetzung für aktive — dasselbe Einmaltoken wie „Kennwort vergessen"), **alle Sitzungen beenden** (für den Vorfall, nicht den Alltag). Daneben steht, ob die letzte Post ankam: „die Einladung ist nie angekommen" ist die zweithäufigste Frage, und die Antwort steht in `platform_email` — noch nicht versendet, gescheitert samt Fehler des Anbieters, oder versendet und dann im Spam.

**Und ein Befund dabei, der über das Panel hinausgeht: der Kunde kann keinen zweiten Benutzer anlegen.** `users.ts` kennt nur die Rollenvergabe für Benutzer, die im Account schon bekannt sind — bekannt wird man aber nur durch das Onboarding. Ein Haus mit einer neuen Rezeptionistin hatte also keinen Weg außer einem Anruf bei uns, und wir hatten keinen außer SQL. Das Panel kann es jetzt (`POST /v1/platform/accounts/:id/users`, Account- oder Hausrolle, mit Einladung); die Maske für den Kunden selbst steht unten in der Liste der Lücken, und sie ist dort die wichtigste.

Ebenso neu: ein **weiteres Haus** an einem bestehenden Kunden (`platform_property_add`, dieselben Pflichtangaben nach § 14 UStG, derselbe offene Geschäftstag wie in 0031), die **Support-Anfrage aus der Kundenkarte** (vorbelegt statt einer von Hand getippten Nummer), die **Sitzungen eines Kunden** auf seiner Karte, und für den Admin die **Aufsicht**: alle Sitzungen aller Kollegen, mit den Änderungen darunter als Zahlen je Tabelle. Art. 5 Abs. 2 DSGVO verlangt, dass der Auftragsverarbeiter nachweisen kann, was er getan hat — und ein Nachweis, den nur der Handelnde selbst sieht, ist keiner. `audit_log.changed` trägt die Zeile selbst, bei `guest` also Name und Anschrift; deshalb Zahlen, nicht Inhalte (`platform_session_activity`, Migration 0039).

Der Betriebszustand nennt jetzt auch die **Post der Plattform** — Einladungen, Kennwort-Links, Support-Anfragen — mit dem letzten Fehler des Anbieters, und eine **hängende Ausrollung**, die über den eindeutigen Teilindex jede weitere sperrt. Plattformbenutzer bekommen eine Rollenwahl in der Liste und den Link-Knopf.

**Dritter Durchgang: der Kunde verwaltet sein Personal selbst.** Der zweite Durchgang hatte es als wichtigste Lücke benannt, und die Begründung ist Arithmetik: bei hundert Häusern sind wir sonst keine Plattform, sondern deren Personalabteilung. Jetzt kann eine Hausleitung mit `user:manage` unter *Schnittstellen → Benutzer* einladen (mit Hausrollen, per E-Mail, Kennwort setzt die Person selbst), Rollen ändern, umbenennen, einen Zugangslink schicken, nach Fehlversuchen entsperren, **sperren** und **entfernen**.

**So autark wie möglich, so eingeschränkt wie nötig — die Grenze ist das Eigentliche.** Zwei Ebenen, zwei Rechte: `user:manage` am Haus für Menschen, deren Rollen im Haus liegen; `settings:account` am Betrieb für Menschen mit einer Rolle für den ganzen Betrieb (Inhaber, Buchhaltung, Steuerberatung) und für die Vergabe dieser Rollen (`PUT …/users/:ref/account-roles`, `GET …/account-roles`). Ohne diese Grenze könnte die Direktion eines Hauses den Inhaber aussperren. Mit ihr kann sie es nicht; und der Inhaber kann sich nicht selbst aussperren, weil der letzte Mensch mit `settings:account` bleibt — er ist der, der Support-Sitzungen freigibt, und ohne ihn bliebe der Betrieb stumm. Die Oberfläche zeigt die Grenze, wie die API sie zieht: an einem Inhaber sieht die Direktion keinen Knopf, der ihr ohnehin nur mit 403 antwortete.

**Was „sperren" beim Kunden heißt** (Migration 0040, `account_user_block`): die Sperre hängt am **Paar** (Kunde, Benutzer), nicht am Benutzer. `app_user.status` ist eine Eigenschaft des Menschen; eine Aushilfe in zwei Betrieben darf vom einen gesperrt werden, ohne dass der andere sie verliert — und ohne dass der eine vom anderen erfährt. Der Zugriffsbereich endet an der Sperre wie am Zustand des Kunden (0038); die Rollen bleiben stehen, sodass die Rückkehr ein Klick ist. Beim Sperren enden die laufenden Sitzungen — der Rechner, der noch angemeldet an der Rezeption steht, ist der Fall, für den man sperrt. **Entfernen** nimmt alle Rollen im Betrieb; der Benutzer selbst bleibt, weil das Protokoll auf ihn verweist, und wird nur dann stillgelegt, wenn er nirgends mehr eine Rolle hat.

Eine vergebene Adresse wird beim Einladen abgewiesen — auch wenn sie zum eigenen Betrieb gehört (dann ist die Rollenvergabe der Weg), und mit **demselben Satz**, wenn sie zu einem anderen gehört: eine Route, die dann anders antwortet, verriete, wer sonst noch Kunde ist. Die E-Mail-Adresse lässt sich nicht ändern: sie ist die Anmeldung, und wer sie ändern könnte, könnte einen Zugang auf sich umleiten.

**Was das Panel noch nicht kann:** Abrechnung. `platform:billing` gibt es als Recht seit Migration 0003, aber es steht kein Modell dahinter — keine Abo-Tabelle, keine Route, nichts. Einen Reiter dafür zu bauen hieße, eine Maske vor ein leeres Feld zu stellen. Ebenso fehlt weiterhin die Anzeige, **welcher** Stand freigegeben ist: der Ausrollknopf nennt nur den Marker `produktion`, nicht den Commit dahinter. Dafür müsste die Maschine bei jedem Lauf den aufgelösten Stand mitschreiben — sie hat keinen Netzzugang zu GitHub, und das soll so bleiben.

---

### Was der Oberfläche noch fehlt

Aus demselben Abgleich, Routenliste gegen die im Frontend vorkommenden Adressen. Alles hier ist gebaut, geprüft und über die Schnittstelle erreichbar — nur über keinen Bildschirm. Das ist kein Entwurf, sondern eine Liste; der Abschnitt darunter sagt, was ausdrücklich **nicht** dazugehört.

| Fehlt | Route | Was das bedeutet |
|---|---|---|
| CSV-Import und Import aus Altsystemen | `/v1/imports/*` | Der ganze Bildschirm fehlt, nicht nur ein Knopf: Datei wählen, Trockenlauf, Bericht lesen, festschreiben. Für einen Migrationskandidaten ist das der erste Tag. |
| Notiz am Gastprofil anlegen | `POST /v1/guests/:ref/notes` | Die Notizen werden angezeigt, aber es gibt keinen Weg, eine zu schreiben. |
| Meldeschein nachträglich unterschreiben | `POST /v1/registrations/:id/sign` | Beim Check-in geht es; wer später unterschreibt, kommt nicht mehr hin. |

---

### Was bewusst keine Oberfläche bekommt

**Die Kassenschnittstelle.** In einer früheren Sichtung stand hier „keine POS-Maske" als offener Punkt. Das war ein Missverständnis: `routes/pos.ts` ist der Vertrag mit einer **externen** Ladenkasse mit TSE, nicht ein Bildschirm, der noch fehlt. Die Kasse holt sich die offenen Folios und bucht ihre Zimmerbons dagegen; sie meldet sich über einen Maschinenzugang mit `folio:read` und `folio:post` an.

Eine Kassenmaske in diesem System zu bauen, hieße genau das zu werden, was Dokument 09 ausschließt — mit allen Folgen aus § 146a AO. Wer den Punkt das nächste Mal auf einer Liste offener Arbeiten findet, streicht ihn.

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
| Zimmer zuweisen ohne Hauspruefung | Ein Benutzer mit zwei Haeusern konnte ein Zimmer aus Haus B an eine Reservierung in Haus A haengen; mit nur einem Haus faengt die Zeilenrichtlinie es ab, was leicht fuer ausreichend gehalten wird |
| Testaufbau sät den Katalog aus einer festen Migration | Jedes später hinzugefügte Recht fehlte in jedem Test, und der Befund sah aus wie ein Fehler in der Route |
| Bestand am Handlungspaar statt am Zustand gebunden | Ein No-Show, der doch noch anreiste, belegte ein Zimmer, das der Zaehler als frei fuehrte |
| Netto aus dem Brutto herausgerechnet und die Steuer wieder daraufgeschlagen | Eine Anzahlung ueber 250,00 Euro stand als 249,99 Euro auf dem Beleg, waehrend das Journal 250,00 fuehrte (Aufgabe 12) |
| Rundungsdifferenz als Position zu 0 Prozent gebucht | Faellt nach § 14 Abs. 4 Nr. 8 UStG durch die eigene Pflichtangabenpruefung: ohne Befreiungsgrund geht keine Position ohne Steuer. Im Satz der Gruppe wiederum verschiebt eine Position die Steuer der ganzen Gruppe mit und muesste vierzehn Cent gross sein, um einen zu bewegen. Richtig ist BT-114 auf Belegebene (Aufgabe 12) |
| `sum()` über eine `bigint`-Spalte ohne Cast zurückgegeben | `sum()` liefert `numeric`, und `numeric` kommt als **Zeichenkette** an — mit Absicht, damit nichts still gerundet wird. Eine Centsumme sieht dann richtig aus und rechnet sich falsch, sobald jemand sie addiert: `"100" + 50` ist `"10050"`. Wer eine Summe zurückgibt, castet sie (`::bigint`); `count()` ist die Ausnahme, das ist schon `bigint`. Ein Test in `packages/db` hält beides fest und sieht die Routen durch |

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
