# Preissteuerung

Stand: 2. Oktober 2026. Migrationen `0065`, `0066`; `apps/api/src/routes/rateSteering.ts`, `apps/worker/src/jobs/rateSteering.ts`, Oberfläche unter **Preise → Preissteuerung** (`apps/web/src/components/Preissteuerung.tsx`).

Stufe 4 aus [`02-planungsgrundlage.md`](02-planungsgrundlage.md) nennt eine „Revenue-Management-Anbindung (RMS)". Dieses Dokument begründet, was davon gebaut ist: eine **regelbasierte, nachvollziehbare** Preissteuerung im System und ein abgegrenzter Weg für ein externes RMS. Kein schwarzer Kasten, keine Prognose, keine Wettbewerberpreise.

---

## 1. Ausgangslage und drei Befunde

Vorhanden waren Ratenpläne mit Tagespreisen je Belegung (`rate_day`, `0007`), abgeleitete Raten, Restriktionen, ein Preisraster und die ARI-Schnittstelle, über die ein Channel Manager Preise **holt** (`0023`). Ein Ratenplan gehört genau einer Kategorie; „Ratenplan × Kategorie" ist deshalb hier dasselbe wie „Ratenplan", und eine Regel kann auf einen Plan **oder** eine Kategorie zielen.

**Kann ein externes RMS heute schon Preise setzen?** Ja. Ein Maschinenzugang (`0025`) mit dem Zugriffsbereich `rate:write` erreicht `PUT /v1/rates/bulk` — Scopes sind Berechtigungsschlüssel, es gibt keinen zweiten Rechteweg. Was fehlte, war die Abgrenzung gegen eine interne Steuerung (Abschnitt 7).

Beim Nachsehen fielen drei Dinge auf, die mit der Steuerung zusammen behoben sind, weil sie „derselbe Weg wie die manuelle Preisänderung" sonst nicht hätte sein können:

1. **Die Änderungsmeldung an den Channel Manager sah geänderte Preise nicht.** `PUT /v1/rates/bulk` setzte `rate_day.updated_at` beim Einfügen, beim Ändern nicht — `ON CONFLICT DO UPDATE SET price_cent = …` ohne Zeitstempel. `GET /v1/channel/ari/rates?since=` fand eine Preisänderung an einem schon gepflegten Tag deshalb nie; nur der Vollabgleich holte sie. Dasselbe beim Neurechnen abgeleiteter Raten und bei Restriktionen. Still, und gegen den Kommentar in `0023`, der das Gegenteil behauptet.
2. **Abgeleitete Raten folgten erst nach „neu rechnen".** Bis jemand den Knopf drückte, verkaufte der Channel Manager die Nicht-Stornierbare zum alten Abstand — je nach Richtung teurer als die Flexible.
3. **Ein Übungshaus gab Preise über ARI hinaus.** Die Ausfuhrsperre (`is_training`) galt für DATEV, GoBD und Statistik, nicht für den Channel Manager. Jetzt weisen das Anlegen eines Zugangs und jeder ARI-Abruf ab (`training.noChannel`).

Dazu ein Ereignis, das Dokument 04 zu den Grundereignissen zählt und das es nicht gab: `rate.changed`.

---

## 2. Ein Schreibweg für Verkaufspreise

`rate_prices_write(property, plans[], dates[], prices[], origin)` (Migration 0066) ist der Weg, den **alle drei** Schreiber nehmen: die Preispflege von Hand, das Neurechnen abgeleiteter Raten (über `rate_derived_rebuild`) und die Steuerung. Er

- schreibt `rate_day` in einer Anweisung und setzt `updated_at` bei jeder **tatsächlichen** Änderung, nicht bei unveränderten Tagen — sonst meldete jedes Neurechnen das ganze Jahr als geändert;
- rechnet die abgeleiteten Raten der berührten Pläne im selben Zeitraum nach, Ebene für Ebene: eine Anweisung je Ableitungsstufe statt einer je Plan;
- reiht **ein** `rate.changed` je Schreibvorgang ein (Herkunft, Pläne, Zeitraum, Zahl der Tage) — nicht eines je Tag. Die Werte holt der Empfänger über ARI;
- prüft die Haustrennung selbst: die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus.

Er liegt in der Datenbank und nicht in der API, weil sein zweiter Aufrufer der Worker ist, und der darf aus `apps/api` nichts importieren. Restriktionen berührt die Steuerung nicht; sie gelten weiter, wie sie gepflegt sind.

---

## 3. Die Bauart, die das Aufschaukeln ausschließt

Eine Steuerung, die ihren eigenen Ausgabewert beim nächsten Lauf als Eingabe nimmt, schaukelt sich auf: +10 % auf 100 € sind 110 €, beim nächsten Lauf 121 €, dann 133 € — ohne dass sich die Belegung bewegt.

**Regeln wirken deshalb immer auf den Grundpreis, und der Grundpreis ist nie ein gesteuerter Preis.** `rate_steer_state` merkt sich je Plan und Tag zweierlei: den Grundpreis, von dem der Lauf ausging, und den Preis, den er geschrieben hat.

| In `rate_day` steht … | Grundpreis des nächsten Laufs |
|---|---|
| genau der Preis, den die Steuerung geschrieben hat | der gemerkte Grundpreis |
| etwas anderes (Mensch, Import, RMS hat gesetzt) | der stehende Preis |

Der Lauf sieht seinen eigenen Ausgabewert damit nie als Eingabe. Eine Preispflege über `rate_prices_write` mit anderer Herkunft als `rules` löscht den Gedächtnisstand der berührten Tage ausdrücklich — sonst hielte eine Preisänderung, die zufällig den gesteuerten Betrag trifft, den alten Grundpreis fest. Andere Schreiber (Import, Testhaus) müssen von der Steuerung nichts wissen: was dort steht, ist schlicht der neue Grundpreis.

**Verworfen: eine zweite Preisspalte in `rate_day`.** Jeder Leser dort — ARI, Preisraster, Buchung, abgeleitete Raten — müsste dann entscheiden, welche er meint, und der erste, der es vergisst, verkauft zum Grundpreis. `rate_day.price_cent` bleibt der Verkaufspreis und sonst nichts.

Die einzige gewollte Rückkopplung ist die Schrittgrenze (Abschnitt 5): sie misst am aktuellen Preis, nähert sich aber einem Ziel, das allein aus dem Grundpreis kommt, und bleibt dort stehen.

**Gebuchte Reservierungen behalten ihren Preis.** Gesteuert wird `rate_day`, der Verkaufspreis; `reservation_night.price_cent` ist bei der Buchung eingefroren und wird nicht berührt.

---

## 4. Regeln

Eine Regel hat einen **Auslöser** und darf weitere Bedingungen tragen, die alle zugleich gelten müssen:

| Auslöser | Bedingung | Beispiel |
|---|---|---|
| Belegung | ab x % und/oder unter y %, gemessen an der Kategorie oder am Haus | „ab 85 %: +20 %" |
| Vorlauf | Anreise in weniger als n Tagen und/oder frühestens in m Tagen | „unter 3 Tagen und Belegung unter 40 %: −10 %" |
| Wochentag | eine Auswahl von Montag bis Sonntag | „Fr, Sa: +15 €" |
| Zeitraum | von … bis … | „24.–26.12.: +10 %" |

Wirkung: Prozent (in Basispunkten, 2000 = +20 %) oder fester Betrag in Cent, mit Vorzeichen. Erlaubt sind −90 % bis +200 % und ±1 000 €; was darüber liegt, ist ein Tippfehler.

**Kombination.** Je Auslöser wirkt an einem Tag nur die **stärkste** passende Regel (gemessen an ihrer Wirkung auf den Grundpreis der ersten Belegungsstufe, bei Gleichstand die ältere); die Auslöser untereinander **addieren** sich. Sonst ergäben die Stufen „ab 70 % +10 %" und „ab 85 % +20 %" bei 90 % zusammen +30 %, und niemand hätte das so gemeint. Ein Wochenendaufschlag und ein Messezuschlag dagegen sind verschiedene Auslöser und gelten beide. Alles wird auf den Grundpreis gerechnet, nie nacheinander.

**Belegung aus dem Zähler, nicht aus der Aufzeichnung.** `inventory_day` sagt, was gerade gebunden ist; `business_day_stat` sagt, wie es war, und ist für einen künftigen Tag leer (Migration 0014, CLAUDE.md „Zähler und Aufzeichnung"). Gebunden heißt verkauft **oder** für ein Kontingent gehalten — beides steht nicht mehr zum Verkauf. Die Kapazität ist dort schon ohne Out of Order gerechnet (`0005`): ein gesperrtes Zimmer ist nicht verkäuflich, eines außer Dienst schon. Die Quote ist ganzzahlig in Basispunkten und abgerundet, damit 84,99 % die Schwelle 85 % nicht erreicht. Ohne Kapazität gibt es keine Quote, und eine Belegungsregel wirkt dann nicht.

**Vorlauf gegen den Geschäftstag**, nicht gegen die Uhr. Gesteuert wird ab dem offenen Geschäftstag bis zum Horizont (Vorgabe 365 Tage, Obergrenze 365); die Vergangenheit verkauft niemand mehr. Nur Tage mit Preis werden gesteuert: was keinen Grundpreis hat, hat nichts zu steuern.

**Abgeleitete Raten werden nicht selbst gesteuert.** Sie folgen ihrer Basis; sonst wirkten die Regeln zweimal.

---

## 5. Leitplanken und Rundung

Je Ratenplan: Mindest- und Höchstpreis in Cent, Rundung, höchste Änderung je Lauf. Die Reihenfolge ist Teil der Fachlichkeit (`rate_steer_price`, gespiegelt in `steerPrice` im Domänenkern; ein Test vergleicht beide an 400 Eingaben):

1. **Wirkung** auf den Grundpreis, kaufmännisch auf den Cent, dann auf das Raster der Rundung (kaufmännisch). Ohne Wirkung bleibt der Grundpreis, wie er ist — auch ungerundet: ihn hat ein Mensch so gewollt.
2. **Leitplanken.** Sie begrenzen die Wirkung, nicht den Grundpreis: liegt der schon unter dem Mindestpreis, wird nicht weiter rabattiert, aber auch nicht angehoben. Innerhalb des Bandes nach innen auf das Raster gerundet (Höchstpreis 120,00 € bei „,90" ergibt 119,90 €). Lässt das Band keinen Rasterwert zu, gewinnt die Leitplanke: eine krumme Endung ist ein Schönheitsfehler, ein Preis unter dem Mindestpreis ein Schaden.
3. **Schrittgrenze** gegen den aktuellen Verkaufspreis (mindestens 1 %), auf das Raster nach innen. Rückt das Raster keinen Schritt vor, geht es um genau einen Rasterwert weiter — sonst bliebe ein Preis, dessen Schritt kleiner als ein Euro ist, für immer stehen.
4. **Noch einmal Leitplanken**: sie sind hart, die Schrittgrenze ist es nicht.

**Rundung**, festgelegt auf drei Raster: centgenau, volle Euro (Vorgabe), auf ,90. Gerechnet wird alles in ganzen Cent; Prozent als Basispunkte, nie Fließkomma im gespeicherten Wert.

Jede Belegungsstufe (`price_cent[i]`) wird mit derselben Wirkung und denselben Leitplanken gerechnet. Leitplanken je Stufe gibt es nicht; ein Einzelzimmerpreis unter einem für das Doppel gedachten Mindestpreis bekommt dann keinen Rabatt, wird aber auch nicht angehoben.

---

## 6. Modus: Vorschlag oder automatisch

**Vorschlag** (Vorgabe). Die Vorschau zeigt je gesteuertem Plan und Tag Grundpreis, aktuellen Preis, Vorschlag, Belegung und die Regeln, die gewirkt haben. Übernommen wird gesammelt oder tageweise. Die Vorschau trägt einen **Fingerabdruck** aller vorgeschlagenen Änderungen; wer übernimmt, schickt ihn mit, und hat sich seither eine Belegung oder ein Preis bewegt, wird nichts übernommen (409, `rateSteer.previewStale`) — sonst setzte der Knopf Preise, die niemand gesehen hat. Prüfung und Übernahme sind **eine** Anweisung (`rate_steer_apply`), damit dazwischen nichts passieren kann; zwei Anweisungen sähen unter READ COMMITTED zwei Stände.

**Automatisch.** Der Worker übernimmt **einmal je Geschäftstag**, nach dem Nachtlauf, innerhalb der Leitplanken. Ein eindeutiger Index am Lauf (`property_id, business_date` für `kind = 'auto'`) ist die Wiederholbarkeit: ein zweiter Tick, ein Neustart, ein zweiter Worker finden den Lauf vor und tun nichts. Warum nicht stündlich: eine Belegungsschwelle, die mittags überschritten wird, greift erst am nächsten Geschäftstag — dafür ändert sich ein Preis höchstens einmal am Tag, Channel Manager und Portale sehen keine Preise springen, und die Schrittgrenze heißt, was sie sagt. Wer sofort reagieren will, übernimmt aus der Vorschau; das geht auch im automatischen Modus. Ein stündlicher Lauf wäre eine Änderung am Index und an `rate_steer_apply`, kein Umbau.

---

## 7. Quelle je Ratenplan und externes RMS

Interne Regeln und ein externes RMS dürfen sich nicht gegenseitig überschreiben — jedes mit gutem Gewissen und im Wechsel. Deshalb steht an jedem Ratenplan, wem sein Verkaufspreis gehört (`rate_plan_steering.source`):

| Quelle | Wer setzt den Preis | Steuerung | Schnittstelle (`PUT /v1/rates/bulk` mit Maschinentoken) |
|---|---|---|---|
| von Hand (Vorgabe) | Menschen und Schnittstellen, wie bisher | lässt ihn in Ruhe | erlaubt |
| Regeln | die Steuerung; ein Mensch setzt den **Grundpreis** | steuert | **abgewiesen** (409, `rateSteer.sourceRules`) |
| externes RMS | das RMS | lässt ihn in Ruhe | erlaubt |

**Ein externes RMS anbinden:** unter Schnittstellen einen Maschinenzugang mit dem Zugriffsbereich `rate:write` (und `rate:read` für das Raster) anlegen, die betroffenen Ratenpläne auf „externes RMS" stellen. Das RMS schreibt über `PUT /v1/rates/bulk`, liest über `GET /v1/properties/:id/rate-grid` und die Belegung über `GET /v1/properties/:id/availability`, und abonniert `rate.changed`, um Änderungen von Hand zu bemerken. Abgeleitete Raten, ARI und Ereignisse folgen über denselben Schreibweg. Ein eigener Scope ist dafür nicht nötig.

Ein Mensch darf einen extern geführten Plan weiter von Hand ändern; das RMS überschreibt ihn beim nächsten Mal. Das ist gewollt: der Mensch muss eingreifen können.

---

## 8. Rechte

| Handlung | Recht | Warum |
|---|---|---|
| Einstellung, Regeln, Vorschau, Verlauf sehen | `rate:read` | wer Preise sehen darf, darf sehen, was die Regeln daraus machen würden |
| Vorschläge übernehmen | `rate:write` | es ist genau das, was die Preispflege tut, auf demselben Weg |
| Regeln, Leitplanken, Quelle, Modus ändern | **`rate:steer`** (neu) | das bewegt Preise ohne weiteres Zutun; ein Tippfehler darin verkauft ein Jahr lang falsch, und niemand sieht hin, weil niemand mehr Preise pflegt |

`rate:steer` bekommen Inhaber, Account-Admin, Hoteldirektion und Revenue. Empfangsleitung und Rezeption bewusst nicht; die Rezeption darf mit ihrem `rate:read` auch nicht übernehmen. Ein Haus, das das anders will, vergibt eine eigene Rolle.

---

## 9. Nachvollziehbarkeit

- `rate_steer_run`: jeder Lauf mit Geschäftstag, Art (automatisch oder Übernahme), Modus, Zeitraum, Person, Zahl der geänderten Tage.
- `rate_steer_change`: je geändertem Tag Plan, Datum, alter und neuer Preis, Grundpreis, wirkende Regeln, Belegung. **Unveränderlich** (`make_append_only`) — ein Verlauf, den man nachträglich glätten kann, beantwortet die Frage „warum stand am Freitag 149 €" nicht. Eine eigene Tabelle und nicht `audit_log`: `rate_day` hat bewusst keinen Audit-Trigger, und das Protokoll kennte die Regel nicht.
- Entfernte Regeln werden archiviert, nicht gelöscht: der Verlauf nennt sie weiter beim Satz.
- Einstellung, Leitplanken und Regeln tragen den Audit-Trigger. Personenbezogen ist darin nichts; kein Eintrag in `audit_redaction`.

---

## 10. Übungshaus

Steuerung ist erlaubt — man soll sie üben können. Nach draußen geht nichts: seit dieser Änderung weist ARI ein Übungshaus ab (Abschnitt 1). `rate.changed` entsteht wie jedes Ereignis über Webhooks; ob Webhooks eines Übungshauses überhaupt zugestellt werden sollten, ist eine eigene, offene Frage (Abschnitt 13).

---

## 11. Messungen am Saatlauf

`pnpm db:seed` (4 Häuser, 1 000 Zimmer, 214 000 Reservierungen), Haus 1: 15 Ratenpläne auf „Regeln", 15 abgeleitete Raten, vier Regeln (zwei Belegungsstufen, Last Minute mit Belegungsbedingung, Wochenende), Rundung auf ,90, Leitplanken 60–300 €. Warmer Cache, `ANALYZE`.

| Vorgang | Zeit | Anweisungen |
|---|---|---|
| Vorschau, 365 Tage × 15 Pläne (5 475 Zellen) | 165 ms | 1 (+1 für Geschäftstag und Horizont) |
| Vorschau, 30 Tage | 31 ms | dieselben |
| Automatischer Lauf, 365 Tage, 3 093 Tage geändert, 15 abgeleitete Raten nachgerechnet, Ereignis eingereiht | 545 ms | **1** |
| Zweiter Tick am selben Geschäftstag | 2 ms | 1 |
| Übernahme ohne offene Änderung, 365 Tage | 101 ms | 1 |

Die Zahl der Anweisungen hängt nicht von der Zahl der Tage ab; Tests prüfen das für Vorschau, Übernahme (7 gegen 300 Tage) und Worker (10 gegen 365 Tage).

**Befund beim Messen.** Die Vorschau stand zuerst als SQL-Funktion da und brauchte für das Jahr **66 Sekunden**; dieselbe Anfrage mit eingesetzten Werten 0,19. Eine SQL-Funktion mit `SET search_path` wird nicht in die aufrufende Anfrage eingebettet und mit einem allgemeinen Plan ausgeführt, der die Werte nicht kennt. Jetzt plpgsql mit `RETURN QUERY EXECUTE … USING`, das jedes Mal mit den Werten plant. Ebenfalls gefunden: der Fingerabdruck entstand als Fensterfunktion über den ganzen Rahmen und wurde je Zeile neu verkettet; jetzt ein Aggregat.

---

## 12. Oberfläche

Unter **Preise** zwei Reiter, Preisraster und Preissteuerung (`?preise=steuerung`, in der Adresse). Von oben nach unten: Modus und Horizont; die Vorschau als Kalenderraster (Pläne × Tage, Vorschlag mit durchgestrichenem aktuellem Preis, Belegung, grün Aufschlag, orange Abschlag) mit Klick für Auswahl und Grund darunter; die Regeln als Sätze („Wenn die Belegung der Kategorie mindestens 85 % beträgt: Preis +20 %"); Ratenpläne mit Quelle und Leitplanken; der Verlauf der Läufe mit aufklappbaren Änderungen. Zwei Aufrufe für den Bildschirm (Einstellung, Vorschau), beide Aggregate. Escape schließt die Regelmaske, hebt die Auswahl auf und klappt den Verlauf zu. Die Oberfläche rechnet nichts nach: was eine Regel aus einem Preis macht, sagt die Vorschau der API.

---

## 13. Annahmen und offene Fragen

- **Gebunden = verkauft + Kontingent.** Ein Haus, das gehaltene Gruppenkontingente nicht als Belegung zählen will, bräuchte eine Einstellung dafür.
- **Ein automatischer Lauf je Geschäftstag**, nicht stündlich (Abschnitt 6).
- **Leitplanken je Plan, nicht je Belegungsstufe** (Abschnitt 5).
- **Webhooks eines Übungshauses** werden wie bisher zugestellt, auch `rate.changed`. ARI ist gesperrt; ob Webhooks es auch sein sollen, ist eine Produktfrage, die über diese Aufgabe hinausgeht.
- **Abgeleitete Raten folgen jetzt jeder Preispflege sofort.** Wer an einer abgeleiteten Rate einen Tag von Hand anders gesetzt hatte, verliert ihn beim nächsten Schreiben der Basis — wie schon bisher beim Knopf „neu rechnen".
- **Nicht gebaut:** Wettbewerberpreise und Rate-Shopping (brauchen einen externen Datenanbieter), Prognosen, Restriktionen aus Regeln (etwa Mindestaufenthalt bei hoher Belegung). Letzteres wäre der naheliegende nächste Schritt und ginge über `restriction_day` auf demselben Muster.
