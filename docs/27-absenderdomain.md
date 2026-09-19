# 27 — Absenderdomain der Gastpost

*Stand: 19.09.2026. Umgesetzt in Migration 0052.*

Eine Rechnung, die beim Gast als Post von „StayGrid" ankommt, erzeugt zwei
Probleme auf einmal. Der Gast weiß nicht, wovon sie handelt — er war bei
Hotel Wattenblick, nicht bei uns. Und seine Antwort landet bei uns statt an
der Rezeption, die sie beantworten könnte. Gastpost muss deshalb vom Hotel
kommen.

Technisch heißt das: der Versandanbieter muss im Namen der Hoteldomain
signieren dürfen. Tut er das nicht, scheitert die Prüfung beim Empfänger
(DMARC), und die Nachricht landet im Werbeordner. **Das ist der teuerste
Fehlerfall dieses ganzen Bereichs**, weil er still passiert: der Anbieter
nimmt die Nachricht an, meldet Erfolg, und niemand erfährt etwas — bis ein
Gast anruft und sagt, er habe seine Rechnung nie bekommen.

---

## Der Einwand, der den Entwurf geformt hat

> „Die Hotels können ihre Domain ja nicht in meinen Brevo-Account eintragen,
> aber da muss die Domain rein, um über meinen API-Key zu senden."

Der Einwand ist berechtigt und löst sich in die andere Richtung auf. **Das
Hotel trägt nichts in unser Konto ein und bekommt es nie zu sehen.** Der
Ablauf ist umgekehrt:

1. Das Haus beantragt eine Domain in seinen Einstellungen.
2. Wir geben im Adminpanel frei. Erst die Freigabe meldet die Domain **mit
   unserem Schlüssel** beim Anbieter an (`POST /v3/senders/domains`).
3. Zurück kommen drei öffentliche TXT-Einträge: Anbietercode auf `@`, DKIM
   auf `mail._domainkey`, DMARC auf `_dmarc`.
4. Diese drei Zeilen trägt das Haus bei **seinem eigenen** DNS-Anbieter ein,
   bei Strato, IONOS oder wo die Domain liegt. Dort hat es ohnehin Zugang.
5. Ein Knopf fragt beim Anbieter nach (`PUT …/authenticate`, dann `GET`).
   Stehen die Einträge, ist die Domain freigeschaltet.

Das ist der Weg, den Agenturen benutzen. Die Domain gehört dem Kunden, das
Versandkonto gehört uns, und die Brücke dazwischen sind drei öffentliche
DNS-Einträge. Ein DKIM-Wert ist dabei der **öffentliche** Teil des
Schlüsselpaars; den privaten hält der Anbieter. In `property_email_domain`
steht deshalb kein Geheimnis, und die Tabelle braucht keinen Eintrag in
`audit_redaction`.

---

## Warum eine Freigabe dazwischen steht

Was ein Haus beantragt, landet in **unserem** Konto beim Anbieter,
verbraucht dort Kontingent und hängt an unserem Ruf als Versender. Ein
Tippfehler oder eine fremde Domain schlüge ungeprüft dorthin durch. Der
Kunde trägt dafür keinen Preis; wir schon.

Selbstbedienung wäre bequemer und die falsche Abwägung. Die Freigabe ist
kein Formular mit Bedenkzeit, sondern ein Klick auf eine Zeile, die Haus,
Kunde, Domain und Antragsteller schon nebeneinander zeigt.

**Entschieden wird im Adminpanel, nicht per Mail.** An `info@staygrid.cloud`
geht nur der Hinweis, dass etwas zu entscheiden ist, und davon höchstens
einer gleichzeitig (`platform_notice_enqueue`): zehn Anträge an einem
Vormittag sollen zehn Zeilen im Panel ergeben und eine Mail, nicht zehn. Ein
Postfach, das bei jedem Antrag klingelt, wird nach einer Woche nicht mehr
gelesen und ist dann so nützlich wie keines.

Eine Freigabe per Antwortmail wäre die naheliegende Bequemlichkeit und die
schlechtere Bauart: sie hinge an einem Postfach, das niemand absichert, und
sie ließe sich fälschen. Der Hinweis trägt deshalb auch keinen Namen eines
Menschen — er sagt „es liegt Arbeit an", und wer den Antrag gestellt hat,
steht im Panel.

---

## Zwei Wege, und der zweite ist kein Sonderfall

**`own` — eigene Domain.** Der Regelfall. Die Post kommt sichtbar vom Hotel,
Antworten gehen direkt an die Rezeption, kein Weiterleiten, kein zweiter
Absender im Postfach des Gastes.

**`relay` — unsere Unterdomain.** Für Häuser, die nur eine Adresse bei GMX,
Web.de oder T-Online haben. Solche Domains lassen sich nicht anmelden, und
das ist richtig so: wer `gmx.de` anmelden könnte, könnte im Namen jedes
GMX-Kunden schreiben. Diese Häuser senden als
`wattenblick@mail.staygrid.cloud`, mit dem Hotelnamen als Anzeigename und
ihrer echten Adresse als Antwortadresse. Der Gast sieht den Hotelnamen,
seine Antwort geht direkt ans Hotel, wir leiten nichts weiter.

Eine eigene Domain zur Pflicht zu machen wäre die einfachere Tabelle und die
falsche Entscheidung: **die Häuser, die keine haben, sind nicht die, die auf
Gastpost verzichten können.**

`mail.staygrid.cloud` ist dafür **einmal** beim Anbieter zu hinterlegen
(`RELAY_EMAIL_DOMAIN`). Steht sie dort nicht, fällt jede Mail dieser Häuser
durch die Prüfung beim Empfänger. Eine `relay`-Freigabe setzt den Status
deshalb sofort auf `active`: einzutragen hat das Haus nichts.

---

## Wo die Regel durchgesetzt wird

An zwei Stellen, und das ist keine Doppelung aus Versehen.

**In der Route** (`PUT …/email-settings`) ist es die Antwort an einen
Menschen: ohne freigeschaltete Domain lässt sich der Versand nicht
einschalten, und die Meldung sagt, warum. Zwei getrennte Meldungen, weil die
Fälle verschiedene nächste Schritte haben — keine Domain heißt beantragen,
falsche Absenderadresse heißt die Adresse ändern.

**In `email_enqueue`** ist es der Zaun. Wer die Einstellung an der Route
vorbei setzt — ein Skript, ein Import, ein späterer Endpunkt —, kommt
trotzdem nicht durch. Genau diese Sorte Fehler gehört in die Datenbank, weil
sie nirgends von selbst auffällt.

Geprüft wird auf **Gleichheit** der Domain, nicht auf Endung: wer auf
`hotel.de` endet, ist auch `nicht-mein-hotel.de`. Bei `relay` zählt
zusätzlich der Namensteil, sonst könnte jedes Haus unter der Unterdomain als
jedes andere senden.

Eine Rücknahme schaltet den Versand mit aus. Sie stehen zu lassen hieße: ab
jetzt scheitert jede Rechnung beim Einreihen, mit einer Meldung über eine
Domain, die niemand mehr sucht.

---

## Was in der Umgebung steht

| Variable | Bedeutung |
|---|---|
| `BREVO_API_KEY` | Derselbe Schlüssel wie für den Versand. Meldet auch die Domains an. |
| `PLATFORM_NOTICE_EMAIL` | Postfach für den Hinweis auf offene Anträge. Vorgabe `info@staygrid.cloud`. |
| `RELAY_EMAIL_DOMAIN` | Unterdomain für Häuser ohne eigene. Vorgabe `mail.staygrid.cloud`. |

Ein Postfach und keine Personenliste: wer ausscheidet, müsste sonst aus
einer Verteilerliste im Code entfernt werden, und das geschieht nie.

---

## Offen

- **Rückläufer.** Eine abgelehnte Zustellung (Bounce) erreicht uns bisher
  nur als Fehlercode des Anbieters, nicht als eingehende Meldung. Der
  Webhook dafür ist nicht gebaut (Befund B2, Dokument 25).
- **Kollision mit einem eigenen Konto des Hotels.** Ein Haus, das Brevo
  schon selbst für seinen Newsletter benutzt, hat auf `mail._domainkey`
  bereits einen anderen Wert stehen. Zwei gehen dort nicht. Bisher fällt das
  erst beim Nachsehen auf; eine eigene Meldung dafür wäre besser.
- **Aufräumen beim Anbieter.** Eine zurückgenommene Domain bleibt zunächst
  in unserem Konto stehen. `entfernen()` ist gebaut, aber nicht verdrahtet:
  das gehört an einen Pflegejob, nicht an eine Route, die ein Mensch aus
  Versehen zweimal drückt.
