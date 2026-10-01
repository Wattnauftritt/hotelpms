# Antwort auf das Performance-Audit

Stand: 01.10.2026. Geprüft wurde `performanceaudit.md` im Wurzelverzeichnis — eine Gegenprüfung des Stands `61616f3` als statische Lesung, ohne Lasttest, Profiling oder Monitoring.

Dieses Dokument ist die Antwort darauf: **was zutrifft, was behoben ist, was auf einer falschen Annahme beruht und was offen bleibt.** Der Bericht selbst bleibt unverändert stehen.

---

## Das Ergebnis in einem Absatz

Von neun Befunden sind **drei zutreffend und behoben** (P5, P8, P9), **einer war schon erledigt** (P8 zur Hälfte — Zeitgrenzen gab es, aber dieselben für Anfrage und Stapelarbeit, und genau das war der Fehler), **drei beruhen auf Annahmen über eine Architektur, die so noch nicht läuft** (P2, P3, P6), **einer auf einer falschen Annahme über den Nachtlauf** (P4), und **zwei bleiben offen und brauchen eine Maschine unter Last** (P1, P7 teilweise). Der Bericht liest sorgfältig, aber er liest die Planungsdokumente (10, 13) als Beschreibung des Betriebs — und zwischen beidem liegt der Unterschied zwischen „drei API-Prozesse hinter PgBouncer" und dem, was `ops/` heute startet: **ein Prozess, kein PgBouncer**.

| ID | Bewertung im Bericht | Unser Befund | Zustand |
|---|---|---|---|
| P1 | Informativ | Trifft zu | offen, braucht Last |
| P2 | Mittel | **Annahme über Geplantes** | heute gegenstandslos |
| P3 | Mittel | **Annahme über Geplantes**, sonst bekannt | dokumentiert |
| P4 | Gering | **Falsche Annahme** (kein Nachtlauf) | richtiggestellt |
| P5 | Niedrig | **Trifft zu** | behoben |
| P6 | Niedrig | Trifft zu | bleibt, begründet |
| P7 | Niedrig | **Teilweise falsch** (CI teilt auf vier) | bleibt |
| P8 | Niedrig | **Trifft zu, aber anders** | behoben |
| P9 | Niedrig–mittel | **Trifft zu** | behoben |

---

## P5 — Die Poolgröße stand im Quelltext

**Zutreffend.** `max: 10` stand fest in `platform/app.ts`, ohne Begründung und ohne Weg, es an einer Maschine zu ändern.

Behoben: `DB_POOL_MAX` mit zehn als Vorgabe. Die Begründung steht jetzt dabei und ist nicht die des Berichts — zehn ist **keine** Obergrenze, die bei 250 Zimmern eng wird. Node arbeitet in einem Faden; mehr gleichzeitige Verbindungen als PostgreSQL Kerne hat, machen eine Datenbank langsamer statt schneller, und die Empfehlung `2 × os.cpus().length` würde auf einer 8-Kern-VM mit drei API-Prozessen 48 Verbindungen gegen `max_connections = 100` stellen. Die Zahl gehört an die Maschine, weil die Gleichzeitigkeit dort entschieden wird — nicht, weil zehn zu wenig wäre.

## P8 — Zeitgrenzen gab es, aber nur eine

**Der Befund trifft zu, die Begründung nicht.** Der Bericht schreibt, es gebe „keine erkennbare Dokumentation von Query-Timeouts in der Anwendung". `packages/db/src/pool.ts` setzt seit jeher `statement_timeout: 30_000` und `idle_in_transaction_session_timeout: 10_000` an **jedem** Pool.

Genau das war der Fehler, und der Bericht benennt ihn in seiner eigenen Empfehlung („30 Sekunden für normale Queries, 5 Minuten für Batch-Jobs"), ohne zu bemerken, dass die erste Hälfte schon galt — und zwar auch für die zweite. Für eine Anfrage aus der Oberfläche sind dreißig Sekunden richtig: was länger braucht, ist kaputt, und eine hängende Anweisung hält eine Verbindung des Pools fest. Für den Nachtlauf eines Hauses mit 250 Zimmern oder einen Jahresexport sind sie es nicht — der stürbe mitten im Lauf und finge beim nächsten Tick von vorn an.

Behoben: `ANFRAGE_TIMEOUT_MS` (30 s) und `STAPEL_TIMEOUT_MS` (5 min), der Worker nimmt die zweite. Test dabei.

## P9 — Keine Beobachtung im Betrieb

**Zutreffend, und der wertvollste Befund des Berichts.** Der Abfragezähler aus `@hotelpms/testing` fängt jedes N+1 in dem Moment ab, in dem es entsteht — aber nur dort, wo ein Test ihn aufruft. Im Betrieb sah eine Antwort in 300 ms gleich aus, ob sie aus einer Abfrage kam oder aus vierhundert.

Behoben, ohne OpenTelemetry: `withTransaction` nimmt einen freiwilligen Beobachter, die API summiert ihn je Anfrage, und über einer Schwelle (`DB_QUERY_WARN`, Vorgabe 50) steht eine Warnung mit **beiden** Zahlen in der Protokollzeile. Beide, weil sie zusammen erst die Diagnose ergeben: die Anweisungen allein sagen nicht, ob es weh tut, die Zeit allein nicht, woran es liegt — „eine langsame Abfrage" und „vierhundert schnelle" sind zwei verschiedene Fehler mit zwei verschiedenen Behebungen.

Ohne Beobachter wird nichts gemessen und nichts umhüllt; der Worker zahlt nichts für eine Zahl, auf die dort niemand wartet.

## P4 — Es gibt keinen Nachtlauf für die Materialisierung

**Falsche Annahme.** Der Bericht schreibt, `inventory_day` werde „über einen täglichen Job materialisiert", und sorgt sich um Lücken „vor dem nächsten Nachtlauf".

`apps/worker/src/worker.ts` tickt **alle fünf Minuten**, und `propertyMaintenance` ruft bei jedem Tick `materializeInventory` mit einem rollierenden Horizont von 24 Monaten ab `current_date`. Der Horizont kann also höchstens fünf Minuten nachhängen, nicht einen Tag. Die Funktion legt fehlende Tage nach; sie ist kein Neuaufbau.

Was bleibt, ist die **Grenze** des Horizonts: eine Buchung mehr als 24 Monate im Voraus bekommt `not_materialized`. Das ist Absicht (P1, Dokument 12) und steht in der Fehlertabelle von `CLAUDE.md`. Richtig ist der Hinweis des Berichts auf das Fehlen einer Überwachung für den Fall, dass der Worker steht — dafür gibt es `overdueNightAudits`, aber nichts für „der Tick läuft gar nicht mehr". Das bleibt offen und steht unten.

## P2 und P3 — Eine Architektur, die so noch nicht läuft

Der Bericht nennt unter P2 eine „aktuell vermutete Konfiguration" für PgBouncer und rechnet unter P3 mit drei API-Prozessen. Beides stammt aus den Entwurfsdokumenten (10 §PostgreSQL, 13 §Dimensionierung).

**Im Repository gibt es keinen PgBouncer**, und `ops/systemd/hotelpms-api.service` startet genau **einen** Node-Prozess. Damit ist P2 heute gegenstandslos, und die Begrenzung aus P3 ist exakt so hoch, wie sie konfiguriert ist — nicht dreifach.

Das ist kein Punkt für uns: dass ein Leser die Planung für den Betrieb hält, ist ein Mangel der Dokumente, nicht des Lesers. Dokument 10 trägt dazu jetzt einen Vermerk.

Richtig bleibt die Aussage für den Tag, an dem mehrere Prozesse laufen: dann ist die wirksame Grenze ein Vielfaches, und der verteilte Zähler wird zur Voraussetzung. Das steht als Befund S5 in Dokument 28 und als Aufgabe in Dokument 16; es ist dieselbe Sache, einmal aus der Sicherheits- und einmal aus der Leistungsperspektive gesehen.

## P6 — Die Grenzen des Workers

**Zutreffend und bewusst.** `CPUQuota=150%`, `MemoryMax=4G`, `IOWeight=50` sind da, damit der Worker die API nicht verdrängt (P5, Dokument 12). Die Sorge des Berichts — der Worker könnte bei großen Exporten an die Speichergrenze stoßen — ist berechtigt und mit einer Zahl nicht zu beantworten, die hier jemand schätzt. Sie gehört gemessen, und zwar an einem Haus mit echten Daten. Bleibt offen.

Dass `150%` auf einem Zweikernsystem anderthalb Kerne bedeutet und nicht einen, sei der Vollständigkeit halber angemerkt.

## P7 — Die Tests laufen längst parallel, nur nicht im Prozess

**Teilweise falsch.** `fileParallelism: false` gilt **innerhalb** eines Läufers, und der Grund ist der richtige: ein Prozess, eine Datenbank. `.github/workflows/ci.yml` verteilt die Dateien aber auf **vier** Läufer mit vier eigenen PostgreSQL-Diensten; aus zehn Minuten am Stück werden knapp drei. Die Empfehlung des Berichts ist also umgesetzt, nur eine Ebene höher als dort vermutet.

Innerhalb eines Läufers bleibt es sequenziell, und das bleibt es auch: eine Datenbank je Testdatei hieße, das Schema je Datei neu aufzubauen — bei 56 Migrationen teurer als die Ersparnis.

## P1 — Zusagen über Latenz und Durchsatz

**Zutreffend, und durch Lesen nicht zu schließen.** Dokument 15 nennt Einzelmessungen auf einem Entwicklungsrechner mit warmem Cache; Perzentile unter Gleichzeitigkeit, Durchsatz und das Verhalten bei kaltem Cache fehlen.

Das lässt sich hier nicht nachholen: eine Messung in diesem Container misst diesen Container. Sie gehört auf die Zielmaschine, mit `k6` oder `autocannon` gegen das Saatlaufhaus, und das Ergebnis gehört als Zusage in ein Dokument. Bleibt offen und steht in Dokument 16.

---

## Was dieser Durchgang nicht geprüft hat

Dieselbe Ehrlichkeit wie im Bericht: ausgeführt wurden `pnpm typecheck`, `pnpm lint`, `pnpm test` und `pnpm build`. Nicht ausgeführt wurden ein Lasttest, ein Profiling unter Gleichzeitigkeit, eine Messung des Workers unter großen Exporten und irgendetwas auf der Zielmaschine.

## Offen, nach Dringlichkeit

1. **Lasttest auf der Zielmaschine** und daraus abgeleitete Zusagen (P1).
2. **Überwachung, dass der Worker tickt** — nicht nur, dass Nachtläufe überfällig sind (P4).
3. **Speicher- und CPU-Bedarf des Workers messen**, statt die Grenzen zu schätzen (P6).
4. **Verteilter Zähler**, sobald mehr als ein API-Prozess läuft (P3, zugleich S5 aus Dokument 28).
