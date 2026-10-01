# Antwort auf das Security-Audit von Copilot

Stand: 01.10.2026. Geprüft wurde `securityaudit-copilot.md` im Wurzelverzeichnis — eine Gegenprüfung des Stands `c26f1f2` durch GitHub Copilot, als Lesung ohne Build, Testlauf oder Penetrationstest.

Dieses Dokument ist die Antwort darauf: **was stimmte, was behoben ist, was offen bleibt und warum.** Es ersetzt den Bericht nicht; der bleibt unverändert stehen, damit nachvollziehbar ist, was jemand von außen gesehen hat.

---

## Das Ergebnis in einem Absatz

Von neun Befunden sind **sieben zutreffend**, und sechs davon sind behoben. Zwei sind betrieblich und nicht durch Code zu schließen (S9), einer ist eine bewusste Entscheidung mit Begründung (S5). Ein Befund war in seiner Einordnung **zu milde**: S4 ist kein bedingtes Risiko, sondern eine Lücke, die über den regulären Weg durch Caddy offenstand — nachgestellt, behoben und mit einem Test festgehalten, der vorher fehlschlägt. Dabei mitgefunden wurde ein Punkt, den der Bericht nicht nennt: das Datenbankkennwort stand während des Aufsetzens in der Prozessliste der Maschine.

| ID | Bewertung im Bericht | Unser Befund | Zustand |
|---|---|---|---|
| S1 | Hoch | **Trifft zu** | behoben |
| S2 | Hoch | **Trifft zu**, und eine Hälfte fehlte | behoben |
| S3 | Mittel | **Trifft zu** | behoben |
| S4 | Mittel, bedingt | **Trifft zu, Einordnung zu milde** | behoben |
| S5 | Mittel, dokumentiert | Trifft zu, **bewusst so** | bleibt, begründet |
| S6 | Niedrig–mittel | Trifft zu | behoben, Startversuch steht aus |
| S7 | Niedrig | **Trifft zu** | behoben |
| S8 | Prozess | Trifft zu | behoben |
| S9 | Betrieblich hoch | Trifft zu | offen, betrieblich |

---

## S1 — Entwicklungskennwörter als Rückfalloption

**Zutreffend, und die Bauform ist das Schlimme daran.** `scripts/setup-db.sh` nahm `devowner`, `devapp` und `devro`, wenn die Umgebungsvariablen fehlten — auf jeder Maschine, auch auf der am Netz. Ein vergessenes Produktionsgeheimnis endete damit nicht in einem Fehler, sondern in einem **Erfolg** mit öffentlich bekannten Zugangsdaten. Fehler, die wie das Gelingen aussehen, fallen nicht auf.

Behoben: ohne alle drei Kennwörter bricht das Skript ab. Wer die Vorgaben will — Entwicklung, CI, eine Sitzung im Web —, sagt es mit `HOTELPMS_ALLOW_DEV_PASSWORDS=1`. Dieselben drei Wörter werden ohne diesen Schalter auch dann abgewiesen, wenn sie von Hand gesetzt sind: wer `devapp` in eine Produktionsumgebung schreibt, hat sich vertan und nicht entschieden.

Nachgezogen: `.claude/hooks/session-start.sh`, `CLAUDE.md`, Dokument 16, 18 und 21 nennen den Schalter jetzt.

## S2 — Unmaskierte Werte im Setup-Skript

**Zutreffend.** Jedes Kommando stand als Zeichenkette in `su postgres -c "psql -c \"…\""`, mit dem Kennwort mittendrin. Ein Kennwort mit `'`, `$(…)` oder Backtick ändert damit das erzeugte SQL oder die äußere Befehlszeile — und die läuft als `root`. Ein zufällig erzeugtes Geheimnis enthält solche Zeichen früher oder später.

**Was der Bericht nicht nennt:** dasselbe Kennwort stand während des Laufs in der **Prozessliste**. Jeder Benutzer der Maschine konnte es mit `ps` mitlesen, es steht in keinem Protokoll, und es fällt nie auf.

Behoben: SQL geht über die Standardeingabe, nie über die Befehlszeile. In der Prozessliste steht nur noch `psql -f -`. Kennwörter werden zusätzlich als SQL-Zeichenkette maskiert (verdoppeltes Anführungszeichen); Datenbanknamen werden gegen `^[a-z][a-z0-9_]{0,62}$` geprüft statt maskiert — ein Datenbankname mit Anführungszeichen ist kein Fall, den dieses System je gebraucht hat.

Nachgestellt: mit dem Kennwort ``a'b$(touch /tmp/pwned)`id`c`` legt das Skript die Rolle korrekt an, die Anmeldung mit genau diesem Kennwort gelingt, und `/tmp/pwned` entsteht nicht.

## S3 — `pnpm audit` war eine Anzeige ohne Folgen

**Zutreffend.** `pnpm audit --audit-level high || true` kann nicht fehlschlagen. Ein Schritt, der nicht fällt, prüft nichts.

Behoben: `|| true` ist weg. Damit der Schritt grün ist, sind die vier damals offenen `high`-Befunde geschlossen — alle vier betrafen `brace-expansion` unter `eslint` beziehungsweise `eslint-plugin-import-x`, zwei Ebenen tief und nicht direkt anhebbar. `pnpm.overrides` erzwingt die geflickten Fassungen, beide innerhalb ihrer Hauptversion, damit `minimatch` 3 und `minimatch` 10 ihre jeweilige Schnittstelle behalten.

Was bleibt: vier Befunde des Grades `moderate`. Sie stoppen den Lauf bewusst nicht — die Grenze bei `high` ist dieselbe, die der Bericht vorschlägt.

## S4 — `trustProxy`: die Begrenzung war offen, nicht nur offenbar

**Zutreffend, und schwerer als dort eingeordnet.** Der Bericht nimmt an, die Lücke öffne sich erst bei direktem Zugriff auf den Node-Prozess. Das ist nicht der Fall:

- `trustProxy: true` heißt in `proxy-addr`: **jede** Adresse in `X-Forwarded-For` ist vertrauenswürdig, also gilt die **erste** — und die erste ist die, die der Aufrufer selbst mitgeschickt hat.
- Caddy **ergänzt** `X-Forwarded-For`, es ersetzt die Kopfzeile nicht. Aus `X-Forwarded-For: 203.0.113.9` wird `203.0.113.9, <echter Peer>`.

Damit war die Adresse, auf die sich die Ratenbegrenzung stützt, über den **regulären** Weg durch Caddy frei wählbar. Zehn Anmeldeversuche mit zehn erfundenen Adressen waren zehn verschiedene Herkünfte; die Sperre nach zehn Fehlversuchen (Befund H3, Dokument 25) griff nie.

Nachgestellt: mit `trustProxy: true` entstehen bei zehn Versuchen mit `203.0.113.$i, 198.51.100.7` zehn Zeilen in `login_failure` statt einer. Der Test dazu steht in `auth.test.ts` und schlägt gegen die alte Fassung fehl.

Behoben an beiden Enden, und beide gehören zusammen:

- Caddy überschreibt die Kopfzeile mit `header_up X-Forwarded-For {remote_host}` (Baustein `echte_herkunft`, an allen vier Weiterleitungen).
- Die Anwendung vertraut genau einen Sprung statt allen.

Fällt eine der beiden Hälften weg, ist die Begrenzung wieder zu umgehen.

## S5 — Ratenbegrenzung im Arbeitsspeicher

**Zutreffend und bewusst so.** Der Dienst läuft als **eine** systemd-Unit mit einem Prozess; die Begrenzung ist die zweite Linie hinter Caddy. Ein verteilter Zähler brauchte einen weiteren Dienst (Redis), den dieses System sonst nirgends benötigt — und ein Dienst mehr ist auch eine Angriffsfläche mehr und ein Ausfallgrund mehr.

Was dagegen nicht bleibt: dass ein Neustart die Zähler löscht, ist für die **Anmeldesperre** egal, denn die steht in der Datenbank (`login_failure`, Migration 0050) und nicht im Speicher. Betroffen ist nur die allgemeine Begrenzung anonymer Anfragen.

Wird das System je auf mehrere API-Prozesse verteilt, wird dieser Punkt zur Voraussetzung und steht als solcher in Dokument 16.

## S6 — systemd-Härtung

**Zutreffend.** Ergänzt sind jetzt `PrivateDevices`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectHostname`, `ProtectClock`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictAddressFamilies` und eine leere `CapabilityBoundingSet` — an der API **und** am Worker, der die halbe Liste ohnehin nicht hatte.

Gemessen mit `systemd-analyze security --offline=true`:

| Unit | vorher | nachher |
|---|---|---|
| `hotelpms-api.service` | 7.8 EXPOSED | **3.2 OK** |
| `hotelpms-worker.service` | 8.3 EXPOSED | **3.3 OK** |

`RestrictAddressFamilies` steht mit `AF_NETLINK` da, nicht ohne: `os.networkInterfaces()` fragt in libuv über Netlink, und ein Dienst, der daran stirbt, stirbt an einer Zeile, die niemand mit der Härtung in Verbindung bringt.

**`SystemCallFilter` fehlt weiterhin, und zwar absichtlich.** Es ist die Option mit dem größten Gewinn und dem größten Risiko: ein fehlender Aufruf endet als SIGSYS beim Start oder, schlimmer, Stunden später unter Last. Dieselbe Datei trägt mit `MemoryDenyWriteExecute` bereits einen Fall, in dem genau das passiert ist. Sie gehört an der Maschine ausprobiert und erst dann eingecheckt.

Geprüft wurde hier `systemd-analyze verify` (Schreibweise, unbekannte Optionen). **Der Startversuch auf der echten Maschine steht aus** und gehört zur nächsten Auslieferung — die Regel aus `CLAUDE.md` über Betriebsdateien gilt weiter, und dieser Satz ist der ehrliche Vermerk, dass sie hier nur zur Hälfte eingelöst ist.

## S7 — Fehlerpfad in der OAuth-Basic-Authentifizierung

**Zutreffend.** `decodeURIComponent('%zz')` wirft, und die Ausnahme lief ungefangen durch: aus falschen Zugangsdaten wurde ein 500. Kein Zugriff, aber ein Serverfehler, den jeder mit einer Kopfzeile auslösen kann, und eine Antwort, die den Fehler auf der falschen Seite verortet.

Behoben: Dekodierungsfehler führen zu `401 invalid_client`, wie es RFC 6749 vorsieht. Test dabei.

## S8 — Prüfstand und Quellstand

**Zutreffend.** Dokument 25 nennt `62694b8` und trug bereits den Hinweis, dass ein Stand ein Datum und kein Dauerzustand ist. Das genügt nicht: ein Bericht wird später gelesen als geschrieben, und dann zählt die Kopfzeile.

Behoben: Dokument 25 ist im Kopf als **historisch** gekennzeichnet, mit dem Verweis hierher. Dieses Dokument nennt Stand, Datum und was tatsächlich ausgeführt wurde.

## S9 — Offene Betriebsrisiken

**Zutreffend, und durch Code nicht zu schließen.** Plattenverschlüsselung (Dokument 22 beschreibt das Nachrüsten), Offsite-Sicherung, ein durchgeführter Wiederherstellungstest, DSFA und die anwaltliche Prüfung des AVV bleiben offen. Sie stehen weiterhin in Dokument 16 und in `docs/datenschutz/`.

Der Satz des Berichts gilt unverändert: ohne Verschlüsselung schützt ein gestohlener Datenträger die Gastdaten nicht, und eine Sicherung, die nie zurückgespielt wurde, ist keine.

---

## Was dieser Durchgang nicht geprüft hat

Dieselbe Ehrlichkeit wie im Bericht: ausgeführt wurden `pnpm typecheck`, `pnpm lint`, `pnpm test` und `pnpm build` sowie die Nachstellungen zu S1, S2, S4 und S7. Nicht ausgeführt wurden ein Penetrationstest, ein Lauf gegen die echte Maschine, der Startversuch der gehärteten Units und eine Prüfung der Git-Historie auf Geheimnisse.
