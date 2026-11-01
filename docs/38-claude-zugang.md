# Claude-Zugang: lesend ins Livesystem

Bis November 2026 lief jede Fehlersuche im Betrieb über Rückfragen: Sven kopierte Protokollzeilen, Zahlen aus dem Adminpanel oder eine Buchungsnummer in ein Gespräch, und die Antwort hing davon ab, ob er das Richtige kopiert hatte. Der Claude-Zugang gibt Claude stattdessen einen **lesenden** Zugang zum Livesystem über das Model Context Protocol (MCP). Den Entwurf hat Sven am 01.11.2026 freigegeben („Wir machen alles wie von dir geplant“), mit allen sechs zusätzlichen Werkzeugen („Alle bitte“).

Die Grundsätze, in der Reihenfolge, in der sie greifen:

1. **Aus, solange niemand ihn einschaltet.** Ohne `MCP_ENABLED=1` endet der Dienst beim Start.
2. **Nur aus dem Netz von Anthropic.** Caddy lässt `/mcp`, die OAuth-Metadaten und den Tokentausch nur aus `160.79.104.0/21` durch (`ops/caddy/Caddyfile`).
3. **Nur mit Passkey verbunden.** Die Verbindung erlaubt ein Mensch mit dem Recht `platform:mcp`, angemeldet mit Passkey (0211), mit frischer Bestätigung. Sie gilt acht Stunden und wird nicht verlängert.
4. **Nur lesen, zweimal.** Die Rolle `hotelpms_mcp` hat kein Schreibrecht, und jede Abfrage läuft in `BEGIN READ ONLY`.
5. **Gastdaten geschwärzt.** Die Rolle sieht nicht die Tabellen, nur Sichten im Schema `mcp`. Klartext gibt es je Haus für 60 Minuten und höchstens 2000 Zeilen, wenn ein Mensch genau diese Anfrage mit seinem Passkey freigibt.
6. **Alles protokolliert.** Jeder Aufruf steht unveränderlich in `mcp_call`; jede Klartext-Anfrage ist ein Sicherheitsereignis mit Mail und Push.

Die Dateien: `packages/db/migrations/0222_mcp_zugang.sql` (Rolle, Sichten, Funktionen), `apps/mcp/` (der Dienst), `apps/api/src/routes/mcp.ts` (OAuth und Adminpanel), `apps/web/src/routes/ClaudeZugang.tsx` und `ClaudeVerbinden.tsx` (Oberfläche), `ops/systemd/hotelpms-mcp.service`, `ops/deploy/mcp.env.vorlage`.

---

## 1. Verbinden

Sven legt in claude.ai unter Einstellungen → Konnektoren einen eigenen Konnektor mit der Adresse `https://app.staygrid.cloud/mcp` an. Dann:

1. claude.ai fragt `/mcp` an, bekommt 401 und den Verweis auf `/.well-known/oauth-protected-resource/mcp`. Darin steht die API als Autorisierungsserver.
2. claude.ai registriert sich (`POST /v1/mcp/oauth/register`, RFC 7591). Angenommen wird nur die Rückleitung `https://claude.ai/api/mcp/auth_callback` (oder dieselbe unter `claude.com`); die Antwort ist immer dieselbe Kennung `staygrid-claude`.
3. Der Browser landet auf `https://app.staygrid.cloud/mcp-verbinden`. Wer nicht angemeldet ist, meldet sich an; Plattformrechte gibt es nur mit Passkey. Der Knopf „Verbindung erlauben“ verlangt eine frische Bestätigung — auch das per Passkey.
4. Die API gibt einen Code aus (zwei Minuten, einmal), claude.ai tauscht ihn mit PKCE (S256) gegen ein Token `sgmcp_…`. In der Datenbank steht nur dessen SHA-256.

Ein abgelaufenes Token wird nicht erneuert, sondern durch neues Verbinden ersetzt. Acht Stunden reichen für eine Fehlersuche; ein Zugang, der über Nacht offen bleibt, ist einer, den niemand beobachtet.

## 2. Was Claude sieht

`mcp_views_refresh()` legt für jede Tabelle in `public` eine Sicht in `mcp` an und ordnet jede Spalte einer Klasse zu (`mcp_column_class`). Die Zuordnung ist **Ablehnung zuerst**: was nicht ausdrücklich als harmlos bekannt ist, wird geschwärzt.

| Klasse | Was | Beispiele |
|---|---|---|
| `fehlt` | Spalte gibt es in der Sicht nicht | Kennwort-Hashes, Token, Schlüssel, Unterschriften, jedes `bytea` (PDF, Bild) |
| `person` | `[geschwaerzt]`, außer bei Klartext-Freigabe für das Haus der Zeile | Namen, Mailadressen, Telefon, Anschrift, Freitext, alles in `audit_redaction` |
| `netz` | IP-Adresse auf das Netz gekürzt (/24, /48) | `origin` in Sicherheitsereignissen |
| `maskiert` | Fehlertexte und technisches JSON mit herausgenommenen Mailadressen | `last_error`, `detail` |
| `sichtbar` | wie gespeichert | Kennungen, Zahlen, Beträge, Daten, Zustände |

Ganz ausgenommen sind Köder (`decoy_*`), Passkey-Herausforderungen, der VAPID-Schlüssel und die Tabellen des Zugangs selbst, die ein Geheimnis tragen. Eine neue Tabelle bekommt ihre Sicht beim nächsten `migrate` (`packages/db/src/migrate.ts` ruft `mcp_views_refresh()` nach den Migrationen). Wer eine Spalte anlegt, die einen Menschen bezeichnet, trägt sie wie bisher in `audit_redaction` ein — die Sicht schwärzt sie dann von selbst.

Konfiguration sieht Claude nur als Namen: API und Worker schreiben beim Start, welche Variablen aus `.env.example` gesetzt sind (`service_config_presence`), nie ihren Wert.

## 3. Klartext freigeben

Reichen die geschwärzten Daten nicht — „warum hat Frau X zwei Anreisen?“ —, ruft Claude `klartext_anfragen` mit Haus und Grund. Dann:

- Es entsteht eine Anfrage mit einer **zweistelligen Abgleichszahl**. Claude nennt sie im Gespräch.
- Mail an `PLATFORM_NOTICE_EMAIL`, Push an jede Person mit `platform:mcp` (sofern Meldungen eingeschaltet sind), Hinweis oben im Adminpanel, Sicherheitsereignis `mcp_release_requested`.
- Im Adminpanel, Reiter **Claude-Zugang**, steht die Anfrage mit Grund und Abgleichszahl. „Mit Passkey freigeben“ holt eine Herausforderung, die an **diese** Anfrage gebunden ist (`mcp_release_bind`); eine Unterschrift für eine andere Anfrage oder eine allgemeine Bestätigung nimmt die API nicht an.
- Danach ist das Haus 60 Minuten im Klartext lesbar, höchstens 2000 Zeilen; „Beenden“ hört früher auf.

Freigeben kann nur, wer das Haus selbst sehen darf: eigener Betrieb oder eine laufende Support-Freigabe des Kunden. Für einen fremden Betrieb ohne Support-Sitzung gibt es keinen Knopf. Höchstens drei offene Anfragen je Viertelstunde.

Die Freigabe läuft im Browser und in der App, sofern deren Hülle Passkeys anbietet (`passkeyMoeglich()`).

## 4. Werkzeuge

| Werkzeug | Wofür |
|---|---|
| `ueberblick` | Stand, Migrationen, Häuser mit Geschäftstag und Nachtlauf, Warteschlangen, Sicherheit der letzten 24 Stunden |
| `tabellen` | Tabellen und Spalten mit ihrer Klasse |
| `sql_lesen` | eine SELECT-Abfrage, 5 Sekunden, 500 Zeilen |
| `sicherheit` | Sicherheitsereignisse, Abrufmengen, Anmeldefehler |
| `protokoll` | Journal von API, Worker und Betriebsdiensten, IP gekürzt |
| `konfiguration` | welche Einstellungen gesetzt sind |
| `buchung_lebenslauf` | alles zu einer Reservierung: Nächte, Folios, Rechnungen, Post, Webhooks, Protokoll |
| `konsistenz` | Prüfungen: Belegung gegen Zähler, Rechnung ohne Beleg, offener Saldo nach Abreise, doppelte Kurtaxe, hängende Post, überfällige Abreisen, alter Geschäftstag, gescheiterte Webhooks |
| `leistung` | langsame Pfade aus dem Journal, Anfragen über `DB_QUERY_WARN`, `pg_stat_statements` |
| `datenbank_zustand` | Größen, tote Zeilen, Sperren, lange Transaktionen, Verbindungen |
| `schnittstellen` | Kanalabgleich, Preiskalender, Webhooks je Kunde |
| `ausrollen_vergleich` | Kennzahlen vor und nach einem Ausrollen |
| `klartext_anfragen`, `klartext_status` | siehe §3 |

Das Protokoll eines Aufrufs (`mcp_call.detail`) ersetzt jede Zeichenkette einer Abfrage durch `'…'`: dort soll stehen, wonach gesucht wurde, nicht nach wem — dieselbe Regel wie im Protokoll der API (Befund B2, Dokument 25).

## 5. Einrichten auf der Maschine

Einmal, in dieser Reihenfolge:

1. `HOTELPMS_DB_MCP_PASSWORD` setzen und `scripts/setup-db.sh` laufen lassen: legt die Rolle `hotelpms_mcp` an und gibt ihr `pg_read_all_stats`. Danach `pnpm --filter @hotelpms/db migrate`, damit die Sichten die Rechte bekommen (oder `SELECT mcp_views_refresh()` als Eigentümer).
2. `ops/deploy/mcp.env.vorlage` nach `/opt/hotelpms/shared/mcp.env`, Eigentümer root, Modus 600; Kennwort eintragen, `MCP_ENABLED=1`.
3. `ops/systemd/hotelpms-mcp.service` nach `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now hotelpms-mcp`. Der Dienst läuft als flüchtiger Benutzer (`DynamicUser`) und kann `/opt/hotelpms/shared/env` nicht lesen; er braucht Lesezugriff auf `/opt/hotelpms/current`.
4. Die Zeile `systemctl try-restart hotelpms-mcp` aus `ops/deploy/hotelpms.sudoers` nach `/etc/sudoers.d/hotelpms`.
5. Den Matcher `@nicht_claude` und die drei `handle`-Blöcke darunter aus `ops/caddy/Caddyfile` übernehmen, `caddy validate`, neu laden. **Hier nicht gegen ein Caddy-Binärprogramm geprüft**, nur mit `scripts/check-caddyfile.sh` — auf der Maschine vor dem Neuladen validieren.
6. Von außen prüfen: `curl -i https://app.staygrid.cloud/mcp` muss 404 geben (fremdes Netz).

Abschalten: im Adminpanel **Sperren** — wirkt sofort, beendet Verbindungen und Freigaben. Dauerhaft: `MCP_ENABLED=0` und `systemctl restart hotelpms-mcp`.

## 6. Recht

- **Anthropic ist Unterauftragsverarbeiter**, auch ohne Klartext: geschwärzte Zeilen tragen Kennungen, Beträge und Zeitpunkte von Aufenthalten. Der AVV mit Anthropic besteht (Sven, 01.11.2026); eingetragen in [`datenschutz/verarbeitungsverzeichnis.md`](datenschutz/verarbeitungsverzeichnis.md), Abschnitt 5 und 6.
- **Kunden:** Für fremde Betriebe gibt es Klartext nur mit deren laufender Support-Freigabe. Die Liste der Unterauftragsverarbeiter im AVV-Muster (§ 5, Anlage 1) nennt Anthropic; ein bestehender Kunde wird nach § 5 Abs. 2 vorher unterrichtet.
- **DSFA:** Sie ist ohnehin durchzuführen ([`datenschutz/dsfa-schwellenwert.md`](datenschutz/dsfa-schwellenwert.md)); der Zugang steht dort jetzt als eigenes Risiko. Er dient der Fehlersuche, nicht der Auswertung von Personen, und Klartext ist die Ausnahme mit menschlicher Freigabe.
- **Technische Maßnahmen:** in [`datenschutz/tom.md`](datenschutz/tom.md), Abschnitt 1.3.
- **Grund einer Anfrage:** Er geht per Mail hinaus und steht im Protokoll. Claude schreibt dort keinen Namen hinein, sondern was geprüft werden soll („doppelte Anreise zu Reservierung ABC123“).

## 7. Was offen ist

- Der Startversuch des Dienstes auf der Maschine und `caddy validate` (§5).
- `SystemCallFilter` fehlt in der Unit aus demselben Grund wie bei API und Worker.
- Ändert Anthropic sein Ausgangsnetz, schlägt das Verbinden fehl, bis die Zeile in Caddy und `ANTHROPIC_AUSGANG` in `packages/contracts/src/mcp.ts` nachgezogen sind.
