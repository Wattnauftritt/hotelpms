# Security- und Performance-Review des Plans

Kritische Durchsicht von [10-systemarchitektur.md](10-systemarchitektur.md) und [11-umsetzungsplan.md](11-umsetzungsplan.md), bevor eine Zeile Code entsteht. Enthält auch drei Widersprüche, die in den Plänen selbst stecken.

**Bedrohungsmodell:** Mehrmandantenfähiges SaaS mit Finanzdaten und personenbezogenen Daten, darunter Staatsangehörigkeit und Ausweisnummern ausländischer Gäste. Wir sind Auftragsverarbeiter nach Art. 28 DSGVO. Ein Datenabfluss über Mandantengrenzen hinweg ist der Totalschaden, ein manipulierbares Rechnungswesen der zweite.

Schweregrade: **kritisch** muss vor dem ersten Kunden erledigt sein, **hoch** vor Produktivgang, **mittel** vor Wachstum, **niedrig** beobachten.

---

# Teil 1: Widersprüche im Plan

## W1 — Zwei Besitzer für `inventory_day` (kritisch)

Dokument 10 sagt an einer Stelle, die Zähler würden **per Trigger** aus Reservierung, Block und Sperrung fortgeschrieben. An anderer Stelle sagt es, die Belegung erfolge als **einzelne UPDATE-Anweisung** im Buchungspfad.

**Beides zusammen zählt doppelt.** Eine Reservierung würde den Zähler einmal durch den expliziten `UPDATE` und einmal durch den Trigger erhöhen.

**Auflösung:** Genau ein Besitzer. Alle Änderungen an `inventory_day` laufen durch eine kleine Menge von SQL-Funktionen:

```sql
inventory_reserve(property, category, from, to, count)  -- mit Kapazitätsprüfung
inventory_release(property, category, from, to, count)
inventory_set_capacity(property, category, from, to, capacity)
```

Der Buchungspfad ruft `inventory_reserve` auf. Trigger auf `maintenance_block` und `resource` rufen `inventory_set_capacity` auf. Storno und No-Show rufen `inventory_release`. **Kein Pfad schreibt direkt in die Tabelle**, durchgesetzt über Rechte: die Anwendungsrolle bekommt kein `UPDATE` auf `inventory_day`, nur `EXECUTE` auf die Funktionen.

## W2 — Rechteentzug wirkungslos bei Eigentümerrolle (hoch)

Dokument 10 schreibt `REVOKE UPDATE, DELETE ON charge ... FROM app_role`. Das ist wirkungslos, wenn `app_role` die Tabellen besitzt, denn der Eigentümer kann sich Rechte jederzeit zurückgeben.

**Auflösung:** Drei getrennte Rollen.

| Rolle | Zweck |
|---|---|
| `hotelpms_owner` | Besitzt Schema und Tabellen, wird **nur** von Migrationen benutzt |
| `hotelpms_app` | Die Anwendung. Kein Eigentümer, kein `UPDATE`/`DELETE` auf Finanztabellen |
| `hotelpms_readonly` | Berichte, Replikat |

Zusätzlich `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, sonst umgeht der Eigentümer die Zeilenrichtlinien.

## W3 — Vertragsprinzip zwischen Dokument 04 und 10 (niedrig)

Dokument 04 forderte handgepflegtes OpenAPI als Quelle der Wahrheit, Dokument 10 generiert die Spezifikation aus Routen-Schemata. Das ist bewusst und in Dokument 10 begründet, sollte aber nicht als Widerspruch stehenbleiben.

**Auflösung:** Dokument 10 gilt. Der Entwurf wird vorab als Dokument festgelegt, die Spezifikation generiert, ein Vertragstest fängt brechende Änderungen. Dokument 04 wird entsprechend ergänzt.

---

# Teil 2: Sicherheit

## S1 — Mandantentrennung nur in der Anwendung (kritisch)

Eine vergessene `WHERE property_id = ...` genügt, um die Gästedaten eines fremden Hotels auszuliefern. Das ist bei mehreren hundert Endpunkten keine theoretische Gefahr.

**Maßnahme: Row Level Security als zweite Verteidigungslinie.**

```sql
ALTER TABLE reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON reservation
  USING (property_id = ANY (
    string_to_array(current_setting('app.property_ids', true), ',')::bigint[]
  ));
```

Die Anwendung setzt den Kontext **zu Beginn jeder Transaktion**:

```sql
SELECT set_config('app.property_ids', $1, true);   -- true = transaktionslokal
```

Drei Fallstricke, die sonst später wehtun:

1. **Jede Anfrage muss in einer Transaktion laufen.** Bei `set_config(..., true)` gilt die Einstellung nur innerhalb der Transaktion. Läuft eine Abfrage außerhalb, ist der Kontext leer und die Richtlinie filtert alles weg, was immerhin sicher fehlschlägt statt still zu lecken.
2. **PgBouncer im Transaction Mode passt dazu**, weil transaktionslokale Einstellungen die Verbindung nicht verschmutzen. Session-lokale Einstellungen wären hier ein Fehler.
3. **`FORCE ROW LEVEL SECURITY` nicht vergessen**, siehe W2.

**Der Mandantenkontext kommt ausschließlich aus dem Token, nie aus Pfad, Query oder Body.** Eine Route `/properties/{id}/...` nimmt die ID entgegen, prüft sie aber gegen die Berechtigung im Token und setzt den Kontext aus dem Token.

## S2 — Idempotenzschlüssel unvollständig spezifiziert (hoch)

Der Plan nennt den Header, nicht aber das Verhalten. Ohne Festlegung entstehen genau die Doppelbuchungen, die er verhindern soll.

**Festlegung:**

| Fall | Verhalten |
|---|---|
| Schlüssel unbekannt | Anfrage ausführen, Antwort samt Statuscode und Prüfsumme des Rumpfs speichern |
| Schlüssel bekannt, gleicher Rumpf | Gespeicherte Antwort ausliefern, nichts erneut ausführen |
| Schlüssel bekannt, **anderer** Rumpf | `422`, niemals die alte Antwort ausliefern |
| Schlüssel bekannt, erste Anfrage läuft noch | `409`, Client soll wiederholen |
| Alter | Nach 24 Stunden verfallen |

Der Schlüssel wird **je Client** eindeutig gehalten, nicht global, sonst kann ein Client die Idempotenz eines anderen stören.

## S3 — Formelinjektion in CSV-Exporten (hoch)

Der DATEV- und GoBD-Export erzeugt CSV. Felder wie `external_reference`, Gastname oder Notiz sind frei befüllbar. Ein Wert, der mit `=`, `+`, `-` oder `@` beginnt, wird von Excel als Formel ausgeführt, sobald der Steuerberater die Datei öffnet.

**Maßnahme:** Beim Export jedes Textfeld prüfen und gefährliche führende Zeichen mit einem Apostroph entwerten. Zusätzlich Zeilenumbrüche und Trennzeichen korrekt maskieren.

## S4 — SSRF über Webhook-Ziele (hoch)

Kunden registrieren beliebige URLs. Ohne Prüfung ruft unser Server damit interne Adressen auf, etwa das Plesk-Panel auf `127.0.0.1:8443` oder Metadatendienste.

**Maßnahme:**

- Nur `https`, kein `http`.
- DNS auflösen und **die aufgelöste IP prüfen**, nicht nur den Namen. Ablehnen: `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`.
- **Keine Weiterleitungen folgen.** Sonst umgeht ein Angreifer die Prüfung über eine Umleitung nach der Auflösung, Stichwort DNS-Rebinding.
- Feste Zeitüberschreitung, Begrenzung der Antwortgröße.
- Zustellung aus dem Worker, nicht aus dem API-Prozess.

## S5 — Ausweisnummern im Meldeschein (hoch)

§ 30 BMG erlaubt die Nummer, verbietet die Kopie. Die Nummer ist besonders schützenswert und darf nicht im Klartext liegen.

**Maßnahme:** Anwendungsseitige Verschlüsselung mit AES-GCM, Schlüssel aus der systemd-Umgebungsdatei, nicht in der Datenbank. Kein Feld und kein Endpunkt für Datei-Uploads am Meldeschein. Automatischer Löschjob nach einem Jahr, protokolliert.

## S6 — Chromium als Angriffsfläche bei der PDF-Erzeugung (hoch)

Die Rechnungsvorlage rendert Gastnamen, Adressen und Notizen. Unmaskierte Ausgabe ergibt Skriptausführung im Renderer.

**Maßnahme:** Alles maskieren, JavaScript im Renderer abschalten, Netzwerkzugriff des Renderers blockieren, Schriften und Bilder lokal einbetten, als eigener unprivilegierter Benutzer laufen lassen, **Sandbox nicht deaktivieren**. Begrenzte Nebenläufigkeit, siehe P5.

## S7 — Plesk als Angriffsfläche (hoch)

Das Panel auf Port 8443 ist ein lohnendes Ziel und hatte in der Vergangenheit Schwachstellen. Zusätzlich installiert Plesk Dienste, die wir nicht brauchen.

**Maßnahme:**

- Panel per Firewall auf feste Adressen oder ein VPN begrenzen, Zwei-Faktor-Anmeldung erzwingen.
- Automatische Sicherheitsaktualisierungen aktiv.
- Abschalten: FTP, Webmail, eingehender Mailserver, phpMyAdmin, phpPgAdmin, PHP-Handler auf der API-Domain.
- Prüfen, wohin Plesk-Sicherungen gehen und ob sie verschlüsselt sind. Eine unverschlüsselte Sicherung auf fremdem Speicher enthält alle Gästedaten.
- Keine Geheimnisse in Plesk-verwalteten Umgebungsvariablen, siehe Dokument 10.

## S8 — Unveränderlichkeit des Audit-Logs nur relativ (mittel)

Rechteentzug schützt vor der Anwendung, nicht vor jemandem mit Datenbankzugang. Für die Glaubwürdigkeit gegenüber einer Betriebsprüfung ist das dünn.

**Maßnahme:** Hash-Verkettung. Jede Zeile enthält den Hash der vorhergehenden. Manipulation wird damit erkennbar. Zusätzlich täglicher Versand des Tagesend-Hashes an einen zweiten Ort. Kostet wenig und ist ein Vertriebsargument.

## S9 — CORS und Origin-Prüfung (mittel)

Ein API mit `Access-Control-Allow-Origin: *` und Cookie-Sitzungen ist angreifbar.

**Maßnahme:** Erlaubte Ursprünge je registriertem Client, keine Wildcard. Zusätzlich `SameSite=Strict` und CSRF-Token für zustandsändernde Operationen der Oberfläche.

## S10 — Anmeldung und Sitzungen (mittel)

- Argon2id mit angemessenen Parametern, gemessen auf der Zielhardware.
- Gleiche Antwortzeit für unbekannten Benutzer und falsches Passwort.
- Sitzungs-ID bei Anmeldung und Rechteänderung rotieren.
- Absolute Höchstdauer zusätzlich zur Untätigkeitsdauer.
- Ratenbegrenzung je Konto **und** je IP, mit Verzögerung statt hartem Block.

## S11 — Lieferkette (mittel)

- `pnpm-lock.yaml` verbindlich, `--frozen-lockfile` in der CI.
- `pnpm audit` als Build-Schritt.
- **GitHub-Actions auf Commit-Hash festnageln**, nicht auf einen Tag. Ein verschobener Tag ist ein bekannter Angriffsweg.
- Dependabot aktiv, Aktualisierungen laufen durch dieselbe CI.

## S12 — Fehlerausgaben (mittel)

`detail` in den Problem-Details darf in der Produktion keine SQL-Fragmente, Stapelspuren oder internen Bezeichner enthalten. Die Anfrage-ID gehört hinein, damit der Support im Log nachschauen kann.

## S13 — Rechte auf jedem Endpunkt testen (hoch, organisatorisch)

Der gefährlichste Fehler ist der vergessene Test, nicht der vergessene Code.

**Maßnahme:** Ein generischer Test iteriert über **alle** registrierten Routen und prüft für jede: ohne Token abgelehnt, mit fremdem Mandanten abgelehnt, ohne passenden Scope abgelehnt. Neue Route ohne Berechtigungsangabe bricht den Build.

---

# Teil 3: Performance

## P1 — Fehlende `inventory_day`-Zeilen (hoch)

Fehlt eine Zeile für einen Tag, liefert der Belegungs-`UPDATE` weniger Zeilen zurück und die Buchung schlägt fehl, mit einer Meldung, die wie „ausgebucht" aussieht, obwohl das Zimmer frei ist.

**Maßnahme:** Materialisierungsjob für 24 Monate Vorlauf, täglich. Zusätzlich unterscheidet die Fehlerbehandlung zwischen „Kapazität erschöpft" und „Zeitraum nicht materialisiert", und Letzteres löst einen Alarm aus. Ein fachlicher Fehler darf nie hinter einem technischen verschwinden.

## P2 — Partitionen des Audit-Logs (hoch)

`audit_log` ist nach Monat partitioniert. **Wenn die Partition für den nächsten Monat fehlt, schlägt jeder Schreibzugriff fehl.** Da der Audit-Trigger an fast jeder Tabelle hängt, steht damit das ganze System. Das ist ein klassischer Ausfall zum Monatsersten.

**Maßnahme:** Job legt Partitionen zwölf Monate im Voraus an, plus Alarm, wenn weniger als drei Monate Vorlauf bestehen. Alternativ `DEFAULT`-Partition als Auffangnetz, die nie leer sein sollte und überwacht wird.

## P3 — Vorbereitete Anweisungen hinter PgBouncer (hoch)

Im Transaction Mode funktionieren protokollseitig vorbereitete Anweisungen nur mit `max_prepared_statements > 0` in PgBouncer. Ohne diese Einstellung wird jede Abfrage bei jedem Aufruf neu geparst und geplant. Bei tausenden Abfragen pro Minute sind das spürbare Prozente, und es fällt beim Entwickeln ohne PgBouncer nicht auf.

**Maßnahme:** `max_prepared_statements` setzen und in Staging mit identischer Konfiguration wie in Produktion messen.

## P4 — Nachtlauf aller Betriebe zur selben Minute (hoch)

Alle deutschen Betriebe haben denselben Tageswechsel, typisch 04:00 Uhr. Bei 500 Mandanten starten 500 Nachtläufe gleichzeitig auf einem Server.

**Maßnahme:** Streuung über ein Zeitfenster, etwa 03:30 bis 05:30, abgeleitet aus der Property-ID. Begrenzte Nebenläufigkeit im Worker. Der fachliche Stichtag bleibt davon unberührt, nur der Ausführungszeitpunkt streut.

## P5 — Worker verdrängt die API (hoch)

Anwendung und Datenbank liegen bewusst auf einer Maschine. Damit konkurriert jeder schwere Job, also PDF-Erzeugung, Export und Nachtlauf, direkt mit der Antwortzeit der Rezeption.

**Maßnahme:** Ressourcenbegrenzung über systemd.

```ini
# hotelpms-worker.service
CPUQuota=150%
MemoryMax=4G
IOWeight=50
```

Der API-Dienst bekommt keine Quote und damit Vorrang. Chromium mit Nebenläufigkeit 1 bis 2.

## P6 — Unbegrenzte Zeiträume in Aggregat-Endpunkten (mittel)

Der Zimmerplan über 30 Tage und 250 Zimmer ist harmlos. Fragt jemand fünf Jahre ab, entstehen Millionen Zellen und eine sehr große Antwort.

**Maßnahme:** Harte Obergrenze je Endpunkt, etwa 92 Tage für den Zimmerplan und 731 Tage für Verfügbarkeit, mit klarer Fehlermeldung. Gilt für alle Endpunkte mit Zeitraum.

## P7 — Schreibverstärkung durch den Audit-Trigger (mittel)

Jedes `UPDATE` auf einer Tabelle des Härtegrads 3 erzeugt eine zusätzliche JSONB-Zeile. An einem betriebsamen Vormittag verdoppelt das die Schreiblast, und `audit_log` wird die größte Tabelle im System.

**Maßnahme:** Nur tatsächlich geänderte Felder protokollieren, nicht die ganze Zeile. Kein Protokoll, wenn sich nichts geändert hat. Aufbewahrung je Tabelle festlegen und alte Partitionen auslagern statt zu löschen.

## P8 — Kosten der Zeilenrichtlinien (mittel)

RLS hängt an jede Abfrage eine zusätzliche Bedingung. Bei einfachen Richtlinien ist das günstig, bei Unterabfragen in der Richtlinie kann der Planer Indizes verwerfen.

**Maßnahme:** Richtlinie so einfach wie im Beispiel unter S1 halten, keine Unterabfragen. Die Ausführungspläne der zehn heißesten Abfragen mit und ohne RLS vergleichen und das Ergebnis dokumentieren.

## P9 — Cursor-Paginierung ohne passenden Index (mittel)

`(created_at, id)` als Cursor braucht genau diesen zusammengesetzten Index, sonst sortiert die Datenbank die ganze Treffermenge.

**Maßnahme:** Für jede paginierte Liste den Index anlegen und im Test über `EXPLAIN` nachweisen, dass kein `Sort` im Plan steht.

## P10 — Serialisierung der Rechnungsnummern (niedrig)

Die gesperrte Zählerzeile serialisiert die Rechnungserstellung je Property. Bei zwanzig gleichzeitigen Check-outs ist das unkritisch, es ist aber ein Engpass, den man kennen muss.

**Maßnahme:** Transaktion um die Nummernvergabe so kurz wie möglich halten, insbesondere **keine PDF-Erzeugung innerhalb dieser Transaktion**. `statement_timeout` setzen, damit eine hängende Transaktion nicht alle weiteren Rechnungen blockiert.

## P11 — Berichte auf dem primären Server (niedrig)

Der Plan sieht ein Replikat vor, nutzt es aber nirgends. Schwere Auswertungen laufen damit gegen die Datenbank, an der auch die Rezeption hängt.

**Maßnahme:** Zweiter Verbindungspool auf das Replikat, alle lesenden Berichte und Exporte dorthin. Bewusst in Kauf nehmen, dass die Daten Sekunden alt sind.

## P12 — Zeitzonen in Schleifen (niedrig)

Zeitzonenauflösung ist überraschend teuer. Sie darf nicht pro Zeile geschehen.

**Maßnahme:** Zeitzone und Tageswechselzeit der Property einmal je Anfrage auflösen und durchreichen.

---

# Teil 4: Was vor dem ersten Code geändert werden muss

Diese Punkte ändern den Plan, nicht nur die Umsetzung. Sie gehören in Arbeitspaket 0 und 1.

1. **W1**: `inventory_day` bekommt genau einen Besitzer über SQL-Funktionen, kein direkter Schreibzugriff.
2. **W2**: Drei Datenbankrollen, Migrationen laufen unter einer eigenen Eigentümerrolle, `FORCE ROW LEVEL SECURITY`.
3. **S1**: Row Level Security ist Teil von AP 1, nicht später. Jede Anfrage läuft in einer Transaktion.
4. **S2**: Verhalten der Idempotenz ist vor dem ersten schreibenden Endpunkt festgelegt.
5. **S13**: Der generische Berechtigungstest über alle Routen existiert in AP 0, zusammen mit dem Abfragezähler.
6. **P2**: Der Partitionsjob für `audit_log` existiert, sobald der Audit-Trigger existiert.
7. **P5**: Die systemd-Ressourcenbegrenzung steht in `ops/systemd/` von Anfang an.

Die übrigen Befunde sind Arbeitspakete im normalen Verlauf und in [11-umsetzungsplan.md](11-umsetzungsplan.md) zu ergänzen.

---

# Teil 5: Was der Plan gut löst

Damit das Bild vollständig ist. Diese Entscheidungen halten der Prüfung stand:

- **Anwendung neben der Datenbank.** Der Round Trip von 0,1 Millisekunden ist die Grundlage, auf der alles andere funktioniert.
- **Belegung als eine Anweisung mit Kapazitätsprüfung.** Korrekt unter Nebenläufigkeit, ohne Anwendungssperren, mit natürlicher Serialisierung nur innerhalb einer Kategorie.
- **Zählertabelle statt Aggregation.** Laufzeit unabhängig von der Historie.
- **Jobs in derselben Transaktion wie die Fachbuchung.** Beseitigt eine ganze Fehlerklasse.
- **Lückenlose Rechnungsnummern über eine Zählerzeile statt einer Sequenz.** Sequenzen hätten bei jedem Rollback eine Lücke hinterlassen.
- **systemd statt Passenger.** Gibt Prozesskontrolle, ermöglicht den Worker und hält Geheimnisse aus dem Plesk-Panel heraus.
- **Abfragezähler vor dem ersten Endpunkt.** Der wirksamste einzelne Test im Projekt.
