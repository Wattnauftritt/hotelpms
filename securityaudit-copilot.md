# Security-Audit: StayGrid (`Wattnauftritt/hotelpms`)

**Ergebnis:** Es wurden keine Änderungen am Anwendungscode, an Konfigurationen oder an Migrationen vorgenommen. Der Audit erfolgte als statische Quellcode-, Konfigurations-, Migrations- und Dokumentationsprüfung des Repository-Stands auf `main` (`c26f1f20d33c9c843dc146bcf10aaf7321a2496c`). Es wurde kein Build, Testlauf, Dependency-Scan und kein Penetrationstest ausgeführt.

Die Anwendung ist in den zentralen Bereichen vergleichsweise solide: Mandantentrennung über PostgreSQL-RLS, Sitzungsverwaltung, Argon2id, Webhook-SSRF-Schutz, Audit-Redaktion und Cookie-Schutz sind erkennbar bewusst umgesetzt. Es gibt jedoch einige sicherheitsrelevante Punkte, die vor einem Produktivbetrieb geklärt werden sollten.

## Befunde

| ID | Befund | Risiko | Bewertung |
|---|---|---:|---|
| S1 | Produktive Datenbankrollen erhalten bei fehlenden Umgebungsvariablen bekannte Entwicklungskennwörter | Kompromittierung der Datenbank | **Hoch** |
| S2 | `setup-db.sh` setzt Shell-/SQL-Kommandos aus unmaskierten Umgebungsvariablen zusammen | Kommando-/SQL-Injection bei manipulierten Setup-Variablen | **Hoch** |
| S3 | `pnpm audit` darf in CI fehlschlagen, ohne den Build zu stoppen | Verwundbare Dependencies können gemergt werden | **Mittel** |
| S4 | `trustProxy: true` ist vollständig vom vorgeschalteten Unix-Socket-/Caddy-Betrieb abhängig | Umgehung von IP-basiertem Rate-Limit bei direktem API-Zugriff | **Mittel, bedingt** |
| S5 | Rate-Limiting ist pro API-Prozess im Arbeitsspeicher | Umgehung durch mehrere Prozesse oder Neustarts | **Mittel, dokumentiert** |
| S6 | systemd-Härtung ist vorhanden, aber nicht vollständig | Größere Auswirkung bei erfolgreicher RCE | **Niedrig–mittel** |
| S7 | OAuth-Basic-Header kann bei ungültiger Prozentkodierung eine ungefangene Exception auslösen | Fehler-/DoS-Pfad, wahrscheinlich kein Datenleck | **Niedrig** |
| S8 | Security-Dokumentation und Quellstand sind nicht vollständig synchron | Sicherheitsannahmen können auf veralteten Prüfungen beruhen | **Prozessrisiko** |
| S9 | Kritische Betriebsannahmen wie Plattenverschlüsselung und Offsite-Backups bleiben offen | Vertraulichkeits- und Wiederherstellungsrisiko | **Betrieblich hoch** |

## S1 — Bekannte Entwicklungskennwörter als Fallback

In `scripts/setup-db.sh` werden bei fehlenden Variablen bekannte Standardwerte verwendet:

- `devowner`
- `devapp`
- `devro`

Das Skript ist laut Kommentar auch auf einer Produktivmaschine verwendbar. Damit entsteht ein gefährlicher Fehlkonfigurationspfad: Fehlt eine Produktionsvariable, läuft das Setup erfolgreich mit öffentlich bekannten Zugangsdaten durch.

**Empfehlung:** Im Produktionsmodus müssen alle Datenbankkennwörter verpflichtend sein. Entwicklungsdefaults sollten ausschließlich in einem ausdrücklich erkannten Entwicklungsmodus erlaubt sein. Zusätzlich sollte das Setup prüfen, dass keine Entwicklungskennwörter verwendet werden.

## S2 — Unmaskierte Variablen in `setup-db.sh`

Das Skript interpoliert Werte direkt in Shell- und SQL-Strings. Betroffen sind insbesondere Rollenkennwörter, Datenbanknamen und `HOTELPMS_DATABASES`.

Ein Kennwort mit `'`, `$()`, Backticks oder ähnlichen Zeichen kann das erzeugte SQL oder die äußere Shell-Kommandozeile verändern. Auch Datenbanknamen werden ungequotet in `CREATE DATABASE` eingesetzt.

**Empfehlung:** Keine Stringinterpolation über `sh -c` verwenden. SQL-Identifier und Passwörter getrennt behandeln, PostgreSQL-Quoting einsetzen und Datenbanknamen gegen eine restriktive Allowlist prüfen.

## S3 — Dependency-Audit ist in CI nicht wirksam

Die CI führt aus:

```yaml
pnpm audit --audit-level high || true
```

Damit bleibt der Job auch bei hohen oder kritischen Schwachstellen grün. Das betrifft insbesondere API, Worker, Weboberfläche sowie Build- und Testwerkzeuge.

**Empfehlung:** `pnpm audit` mindestens für `high`/`critical` fehlschlagen lassen oder einen dokumentierten Ausnahmeprozess mit Ablaufdatum und Begründung einführen. Dependabot/Renovate und Lockfile-Prüfungen sollten ebenfalls verifiziert werden.

## S4 — `trustProxy: true` ist eine Betriebsabhängigkeit

Die API setzt `trustProxy: true`. Die Herkunft für das Rate-Limit wird aus `req.ip` gelesen. Die Absicherung funktioniert nur, wenn Node ausschließlich über den Unix-Socket erreichbar ist und nur Caddy Zugriff darauf besitzt.

Bei direktem Zugriff auf den Node-Prozess wäre `X-Forwarded-For` fälschbar und die IP-basierte Begrenzung umgehbar.

**Empfehlung:** `trustProxy` auf die tatsächlich vertrauenswürdige Proxy-Kette begrenzen und technisch prüfen, dass kein öffentlicher API-TCP-Port aktiv ist.

## S5 — Rate-Limit ist nicht verteilt

Der Rate-Limiter verwendet eine In-Memory-Map. Mehrere API-Prozesse vervielfachen das effektive Limit; ein Neustart setzt die Zähler zurück. Caddy soll als erste Linie dienen.

Das ist als zweite Schutzlinie akzeptabel, aber für Login, OAuth und Passwort-Reset nicht ausreichend, wenn mehrere API-Instanzen betrieben werden oder Caddy falsch konfiguriert ist.

**Empfehlung:** Für produktive Mehrprozess- oder Mehrinstanzumgebungen einen verteilten Limiter oder eine belastbare Edge-Konfiguration einsetzen.

## S6 — systemd-Härtung ist ausbaufähig

Positiv vorhanden sind unter anderem `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `ProtectKernelTunables=true`, `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, Ressourcenlimits und `LockPersonality=true`.

Nicht erkennbar sind unter anderem `PrivateDevices=true`, `ProtectKernelModules=true`, `ProtectKernelLogs=true`, `RestrictAddressFamilies`, `SystemCallFilter` und eine explizite `CapabilityBoundingSet`-Begrenzung.

**Empfehlung:** Nach Kompatibilitätsprüfung schrittweise ergänzen. Besonders `RestrictAddressFamilies` und `CapabilityBoundingSet` sollten geprüft werden.

## S7 — Fehlerpfad in der OAuth-Basic-Authentifizierung

In `apps/api/src/routes/oauth.ts` wird die Basic-Authentifizierung mit `decodeURIComponent()` verarbeitet. Ungültige Prozentkodierung kann eine ungefangene Exception auslösen und wahrscheinlich einen 500-Fehler verursachen.

Das liefert keinen erkennbaren Zugriff, ist aber ein unnötiger Fehlerkanal und nicht RFC-konform für ungültige Zugangsdaten.

**Empfehlung:** Dekodierungsfehler abfangen und als `401 invalid_client` behandeln. Abgeschnittene, ungültige und überlange Header sollten getestet werden.

## S8 — Dokumentations- und Prüfstand nicht vollständig synchron

`docs/25-sicherheitspruefung.md` nennt einen historischen Prüfstand (`62694b8`), während der aktuelle gelesene Repository-Stand `c26f1f20...` ist. Ein historischer Prüfbericht darf nicht automatisch als Nachweis für den aktuellen Code gelten.

**Empfehlung:** Für jeden Audit Commit, Datum, Toolversionen und tatsächlich ausgeführte Prüfbefehle festhalten. Alte Prüfberichte klar als historisch kennzeichnen.

## S9 — Offene Betriebsrisiken

Die Dokumentation nennt weiterhin:

- Plattenverschlüsselung als offen,
- Offsite-Backups als offen,
- Wiederherstellungstest als offen,
- echte Validatorläufe für bestimmte Belegformate als offen,
- DSFA und anwaltliche Prüfung des AVV als offen.

Für ein Hotel-PMS sind diese Punkte sicherheitsrelevant. Ohne Verschlüsselung schützt ein gestohlener Datenträger die Gastdaten nicht. Ohne getestete Offsite-Sicherung und Restore bleibt die Wiederherstellbarkeit unbewiesen. Die DSFA ist laut Dokumentation fällig, nicht abgeschlossen.

## Positiv geprüfte Bereiche

### Authentifizierung und Sitzungen

- Argon2id mit Memory-Cost.
- Blind-Hash gegen Benutzerenumeration.
- Sitzungstoken mit `randomBytes(32)`.
- `HttpOnly`, `SameSite=Strict` und `Secure` in Produktion.
- Absolute und inaktive Ablaufzeit.
- Widerruf bestehender Sitzungen beim Passwort-Reset.
- Einmal- und Hash-basierte Reset-Tokens.

### Mandantentrennung

Die Architektur setzt auf transaktionslokalen Mandantenkontext, `FORCE ROW LEVEL SECURITY`, getrennte App-/Owner-Rollen, Berechtigungsprüfung über `registerRoute` sowie separate Property- und Account-Sichten.

### Webhook-Sicherheit

Der frühere SSRF-Befund wurde nachvollziehbar adressiert:

- Zielprüfung bei Anlage,
- erneute Prüfung vor Zustellung,
- Prüfung aller DNS-Antworten,
- kein automatisches Folgen von Redirects,
- direkte Verbindung zur geprüften Adresse,
- private Netze standardmäßig gesperrt,
- Fehlerprotokoll ohne Rohfehler mit Zieladresse und Port.

### Logging und Datenschutz

Positiv sind die Redaktion von Request-/Response-Body, Cookies und Authorization-Headern, die Entfernung von Query-Parameterwerten aus URLs sowie die zentrale Audit-Redaktion und Gastlöschung.

Diese Aussagen stammen aus Quellcode und Dokumentation und wurden in dieser Sitzung nicht durch Testausführung verifiziert.

### Frontend

Im vorhandenen Sicherheitsbericht werden keine riskanten Konstruktionen wie `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` oder Tokens im JavaScript genannt. Die CSP enthält weiterhin `unsafe-inline` für Style-Attribute; dies ist dokumentiert und mit dem Belegungsplan begründet.

## Nicht durch diesen Audit belegt

Ohne Ausführung sind nicht abschließend verifiziert:

1. tatsächliche Wirksamkeit aller PostgreSQL-RLS-Policies,
2. Rechte auf jeder einzelnen Partition,
3. konkurrierende Buchungs- und Check-out-Szenarien,
4. tatsächliche Cookie- und Headerwerte hinter Caddy,
5. laufende systemd-Dateirechte und Socket-Rechte,
6. aktuelle Dependency-Schwachstellen,
7. Secrets in Git-Historie oder GitHub-Actions-Logs,
8. Backup- und Restore-Fähigkeit,
9. DNS-Rebinding unter realer Netzwerkumgebung,
10. Penetrationstest gegen die laufende Anwendung.

## Priorisierte nächste Schritte

1. Produktionsdefaults entfernen: `setup-db.sh` darf ohne explizite Produktionskennwörter nicht erfolgreich durchlaufen.
2. Setup-Skript gegen Injection härten: keine unquotierte Shell-/SQL-Interpolation.
3. CI-Dependencyprüfung wirksam machen: `pnpm audit` darf bei relevanten Schweregraden nicht mit `|| true` neutralisiert werden.
4. Proxy-Invariante technisch erzwingen: API-Port schließen, Unix-Socket prüfen, `trustProxy` begrenzen.
5. OAuth-Fehlerpfad testen und normalisieren.
6. systemd-Sandboxing vervollständigen.
7. Offsite-Backup und Restore tatsächlich durchführen und protokollieren.
8. Plattenverschlüsselung vor Produktivbetrieb umsetzen.
9. Aktuellen Commit mit einem reproduzierbaren Security-Testlauf auditieren.
10. DSFA, AVV und TOM organisatorisch abschließen.

## Gesamturteil

Der Anwendungskern zeigt ein überdurchschnittlich bewusstes Sicherheitsdesign. Für einen Produktivbetrieb bestehen aber insbesondere wegen der bekannten Datenbank-Fallbackkennwörter, des unsicheren Setup-Skripts und der nicht durchsetzenden Dependency-Prüfung noch relevante offene Punkte.
