# Die Maschine aufsetzen

Von der leeren VM bis zum laufenden Betrieb. [`17-betrieb.md`](17-betrieb.md) sagt, **was** im Betrieb gilt; dieses Dokument sagt, **wie** die Maschine dorthin kommt.

Der Host ist Proxmox. **Die Verschlüsselung sitzt dort und nicht in dieser VM** — warum, steht in [`17-betrieb.md`](17-betrieb.md) §1, und es ist wichtig genug, um es vor dem ersten Schritt gelesen zu haben.

---

## 1. Die Entscheidungen vorweg

| Frage | Entscheidung | Warum |
|---|---|---|
| Betriebssystem | **Debian 13 (stable)** | PostgreSQL 17, Node 22 und Caddy sind alle als Paket verfügbar, die Aktualisierungen sind langweilig, und langweilig ist bei einem System mit Aufbewahrungspflicht die richtige Eigenschaft. Ubuntu LTS ginge auch; Debian hat weniger Beiwerk, das man abschalten muss |
| Wie viele VMs | **Eine**, mit allem darauf | Ein Haus mit 40 Zimmern erzeugt keine Last, die Trennung rechtfertigt. Eine zweite Maschine verdoppelt Sicherung, Aktualisierung und Verschlüsselung — und die Datenbank dann über Netz statt über einen Unix-Socket zu erreichen, kostet mehr, als die Trennung bringt |
| Container | **Nein, systemd-Dienste** | Es laufen zwei Node-Prozesse und eine Datenbank. Docker dazwischen fügt eine Schicht hinzu, die bei der Fehlersuche im Weg steht, und löst hier kein Problem |
| Node | **22 LTS**, aus NodeSource | `package.json` verlangt `>=22`. Debians eigenes Paket hinkt hinterher |
| pnpm | **über Corepack**, Version aus `package.json` | `"packageManager": "pnpm@10.33.0"` — Corepack nimmt genau die. Kein globales Installieren, keine abweichende Version zwischen Entwicklung und Betrieb |
| Reverse Proxy | **Caddy** mit dem Modul `caddy-ratelimit` | TLS ohne Handarbeit, und Dokument 17 §4 setzt Caddy für die erste Linie der Ratenbegrenzung bereits voraus |
| Verbindungsbündelung | **PgBouncer** für die API, **nicht** für den Worker | D1, Dokument 13: `LISTEN/NOTIFY` kommt im Transaction Mode nie an. Der Worker verbindet direkt |

---

## 2. Die VM anlegen

**Größe zum Start:** 4 vCPU, 8 GB RAM, 80 GB Platte. Das ist reichlich für ein bis vier Häuser und lässt Luft für den Saatlauf und einen Wiederherstellungstest neben dem Betrieb.

Der Platzbedarf wächst vor allem durch zwei Dinge: die Rechnungsbelege liegen als PDF **in der Datenbank** (`invoice_document`, rund 2 GB bei 20 000 Rechnungen im Jahr) und das `audit_log` ist partitioniert und bleibt acht Jahre liegen. 80 GB tragen einige Jahre; beobachten statt raten.

**Die VM selbst wird nicht verschlüsselt.** Sie wird auf einen **verschlüsselten Datenspeicher des Hosts** gelegt; das ist der erste Schritt und er passiert auf dem Host, bevor diese VM entsteht. Die Begründung steht in Dokument 17 §1 und lässt sich in einem Satz sagen: Proxmox kann das physische TPM nicht durchreichen, sein `swtpm` legt den Schlüssel als Volume **neben** die Platte, und damit entsperrt sich eine gestohlene VM von allein.

**Kein vTPM an dieser VM.** Es kauft nichts und kostet die Sicherung — Sicherungen von VMs mit TPM-Gerät bleiben hängen, und der übliche Behelf (`backup=0`) nimmt den vTPM-Zustand aus der Sicherung heraus. Die zurückgespielte VM entsperrt sich dann nie wieder.

**Und niemand tippt beim Neustart eine Passphrase.** Ein PMS läuft rund um die Uhr, und `unattended-upgrades` weiter unten will nach jedem Kernel-Update neu starten. Entsperrt wird auf dem Host über `clevis`, „eines von zweien": physisches TPM oder Tang-Server. Dazu eine Notfall-Passphrase im Tresor, erreichbar für mindestens zwei Personen.

---

## 3. Bestückung

```bash
# Grundlage
apt update && apt full-upgrade
apt install -y curl git ca-certificates gnupg ufw fail2ban unattended-upgrades

# PostgreSQL 17 aus dem PGDG-Depot (Debian liefert eine aeltere Version)
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt update && apt install -y postgresql-17 postgresql-contrib-17 pgbouncer

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
corepack enable          # pnpm kommt aus package.json

# Caddy mit dem Ratenbegrenzungsmodul
# Das Standardpaket bringt es nicht mit; mit xcaddy bauen oder ein
# fertiges Paket mit dem Modul verwenden.
```

**Die beiden Erweiterungen**, die das Schema braucht, stecken in `postgresql-contrib`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- Gastsuche (0015)
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- oeffentliche Referenzen
```

---

## 4. Der Anwendungsbenutzer

Kein Betrieb als `root`, und kein Anmelden als der Anwendungsbenutzer:

```bash
adduser --system --group --home /srv/hotelpms --shell /usr/sbin/nologin hotelpms
```

Der Programmstand liegt unter `/srv/hotelpms/app`, die Umgebung in `/srv/hotelpms/.env` mit `chmod 600` und dem Benutzer als Eigentümer. **Nicht im Repository** — dort steht nur `.env.example`.

---

## 5. Von GitHub holen: der einfachste tragfähige Weg

Drei Wege stehen zur Wahl. Der mittlere ist der richtige.

| Weg | Urteil |
|---|---|
| Persönliches Zugriffstoken | **Nein.** Es hängt an einem Menschen, läuft ab, und wer das Unternehmen verlässt, nimmt den Betrieb mit |
| **Deploy Key, nur lesend** | **Ja.** Ein Schlüsselpaar je Maschine, in GitHub am Repository hinterlegt, ohne Schreibrecht. Es hängt an der Maschine, nicht an einer Person |
| Artefakt aus CI ziehen | Sauberer für viele Maschinen, aber es braucht eine Ablage, eine Versionierung und ein Zugriffsrecht darauf. Bei **einer** Maschine ist das mehr Apparat als Nutzen |

```bash
sudo -u hotelpms ssh-keygen -t ed25519 -f /srv/hotelpms/.ssh/id_deploy -N ''
cat /srv/hotelpms/.ssh/id_deploy.pub
# → GitHub → Repository → Settings → Deploy keys → Add
#   "Allow write access" bleibt AUS.
```

**Warum ohne Schreibrecht:** die Maschine hat nichts ins Repository zu schreiben. Ein Schlüssel, der es könnte, ist ein Weg vom Produktivsystem in den Quellcode — und den will man nicht, wenn die Maschine einmal kompromittiert ist.

```bash
sudo -u hotelpms git clone git@github.com:Wattnauftritt/hotelpms.git /srv/hotelpms/app
```

---

## 6. Datenbank einrichten

Die drei Rollen legt `scripts/setup-db.sh` an — dasselbe Skript wie in der Entwicklung, damit Entwicklung und Betrieb nicht auseinanderlaufen. **Die Kennwörter werden dabei ersetzt**; die Vorgabewerte aus der Entwicklung (`devapp`, `devowner`) gehören nicht auf eine Maschine, die aus dem Netz erreichbar ist.

| Rolle | Darf | Benutzt von |
|---|---|---|
| `hotelpms_owner` | DDL, Migrationen, alles | nur die Migration und der Worker für Partitionen |
| `hotelpms_app` | lesen und schreiben, **kein** `UPDATE`/`DELETE` auf `charge`, `settlement`, `invoice`, `audit_log` | API und Worker im Tagesbetrieb |
| `hotelpms_readonly` | lesen | Auswertungen, Steuerberater |

**Das Trennen ist keine Förmlichkeit.** Die Unveränderlichkeit der Belege (GoBD) hängt daran, dass die Anwendungsrolle das Recht gar nicht hat — nicht daran, dass der Code es nicht tut.

### PgBouncer

```ini
[databases]
hotelpms = host=/var/run/postgresql dbname=hotelpms

[pgbouncer]
pool_mode = transaction
listen_addr = 127.0.0.1
```

`pool_mode = transaction` ist richtig und der Grund, warum der Worker **nicht** darüber geht: in diesem Modus wechselt die Sitzung nach jeder Transaktion, und `LISTEN/NOTIFY` kommt nie an. Zwei Verbindungsziele in `.env`:

```
DATABASE_URL=postgres://hotelpms_app@127.0.0.1:6432/hotelpms         # ueber PgBouncer
DATABASE_URL_DIRECT=postgres://hotelpms_app@/hotelpms                # Unix-Socket, direkt
DATABASE_URL_OWNER=postgres://hotelpms_owner@/hotelpms               # nur fuer Migrationen
```

---

## 7. Die Dienste

Zwei Prozesse: die API und der Worker. Beide als systemd-Dienst, beide als `hotelpms`.

```ini
# /etc/systemd/system/hotelpms-api.service
[Unit]
Description=hotelpms API
After=network.target postgresql.service pgbouncer.service
Requires=postgresql.service

[Service]
Type=simple
User=hotelpms
WorkingDirectory=/srv/hotelpms/app
EnvironmentFile=/srv/hotelpms/.env
ExecStart=/usr/bin/node apps/api/dist/server.js
Restart=always
RestartSec=5

# Was der Dienst nicht koennen muss, soll er auch nicht koennen.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/hotelpms
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

Für den Worker dasselbe mit `apps/worker/dist/worker.js`. **Der Worker läuft genau einmal** — zwei Nachtläufe für dieselbe Property wären zwar idempotent, aber es gibt keinen Grund, das auszuprobieren.

### Caddy

Eine Herkunft für Oberfläche und Schnittstelle — die Entscheidung steht in AP 12 des Umsetzungsplans. Der Grund: getrennte Namen erzwingen CORS mit Anmeldedaten, `SameSite=None` am Sitzungscookie und eine gepflegte Liste erlaubter Herkünfte. Jede dieser drei Stellen ist eine Gelegenheit, sich zu vertun, und ein Fehler darin ist eine Sitzungsübernahme.

```caddyfile
pms.beispielhotel.de {
    encode zstd gzip

    rate_limit {
        zone anmeldung {
            match { path /v1/auth/* }
            key    {remote_host}
            events 30
            window 5m
        }
    }

    handle /v1/* {
        reverse_proxy unix//run/hotelpms/api.sock
    }
    handle /openapi.json {
        reverse_proxy unix//run/hotelpms/api.sock
    }
    handle {
        root * /srv/hotelpms/app/apps/web/dist
        try_files {path} /index.html
        file_server
    }
}
```

`api.beispielhotel.de` kommt später dazu, wenn Channel Manager und Kasse anbinden: Maschinen brauchen keine Oberfläche.

**Unix-Socket statt Port.** `.env` kennt dafür `LISTEN_SOCKET`. Ein Dienst, der gar nicht auf einem Netzwerkport lauscht, ist an dieser Stelle nicht erreichbar, auch wenn die Firewall einmal falsch steht.

### Firewall

```bash
ufw default deny incoming
ufw allow 22/tcp      # besser: nur aus dem eigenen Netz
ufw allow 80,443/tcp
ufw enable
```

PostgreSQL und PgBouncer lauschen auf `127.0.0.1` und gehören **nicht** in die Firewallregeln. Was von außen nicht erreichbar sein soll, bekommt keine Regel, sondern keinen Zuhörer.

---

## 8. Ausrollen

Ein Skript, immer dieselbe Reihenfolge:

```bash
#!/usr/bin/env bash
# /srv/hotelpms/deploy.sh — als Benutzer hotelpms ausfuehren
set -euo pipefail
cd /srv/hotelpms/app

git fetch --prune origin
git checkout main
git reset --hard origin/main        # die Maschine aendert nie selbst etwas

set -a; . /srv/hotelpms/.env; set +a

pnpm install --frozen-lockfile
pnpm build

# Migrationen mit der Eigentuemerrolle, nie mit der Anwendungsrolle.
# Das Skript liest DATABASE_URL_OWNER aus der Umgebung, die oben schon steht.
pnpm --filter @hotelpms/db migrate

sudo systemctl restart hotelpms-api hotelpms-worker
sleep 2
curl -fsS --unix-socket /run/hotelpms/api.sock http://localhost/health
```

**`git reset --hard` und nicht `git pull`.** Die Maschine ist kein Arbeitsplatz: sie soll genau den Stand tragen, der auf `main` steht. Ein `pull` kann in einen Konflikt laufen und stehen bleiben — und dann läuft ein halber Stand.

**Migrationen vor dem Neustart.** Das Schema ist dabei kurz neuer als der laufende Code. Das ist die richtige Richtung: eine hinzugefügte Spalte stört den alten Code nicht, ein fehlendes Schema den neuen schon.

**Keine unterbrechungsfreie Auslieferung.** Der Neustart kostet ein paar Sekunden, und in denen antwortet Caddy mit 502. Für ein Haus mit einer Rezeption ist das vertretbar; zwei Prozesse hinter einem Lastverteiler zu betreiben, kostet mehr Sorgfalt, als die Sekunden wert sind. Wenn es stört, ist die einfachste Abhilfe ein Zeitfenster nachts nach dem Nachtlauf, nicht eine zweite Maschine.

---

## 9. Sicherung

Ohne sie ist alles andere vergeblich. Dokument 17 §3 sagt, was gilt; hier steht, was eingerichtet wird.

```bash
# Taeglich, als eigener Dienst mit Timer.
pg_dump --format=custom --file=/var/backups/hotelpms/$(date +%F).dump hotelpms
```

Dazu ein Ziel **außer Haus** — eine Kopie auf derselben verschlüsselten Platte überlebt keinen Plattenfehler und keinen Verschlüsselungstrojaner. Ein Anbieter mit Objektspeicher in Deutschland, Übertragung verschlüsselt, Aufbewahrung nach Generationen.

**Gesichert wird aus der laufenden VM heraus, nicht das Blockgerät.** Eine Sicherung der verschlüsselten Platte ist ein undurchsichtiger Klumpen: zurückspielen lässt er sich, öffnen nur mit dem Schlüssel — und steckt der bloß in einem Kopf oder in einem vTPM-Zustand, der gar nicht mitgesichert wurde, ist die Sicherung wertlos. Entsperrung und Sicherung sind dieselbe Frage; wer die eine plant, muss die andere mitplanen. `pg_dump` plus die Belege, eigenständig verschlüsselt, zum Objektspeicher.

**Der Teil, der übersprungen wird und der eigentlich zählt: die Rückspielung.** Vierteljährlich in eine leere Datenbank zurückspielen und nachsehen, ob die Zahlen stimmen. Eine Sicherung, die nie zurückgespielt wurde, ist eine Vermutung. Sie gehört ins Protokoll mit Datum und Ergebnis.

---

## 10. Reihenfolge der Inbetriebnahme

| # | Schritt | Fertig, wenn |
|---|---|---|
| 1 | **Auf dem Host:** verschlüsselter Datenspeicher, Entsperrung über TPM und Tang; dann die VM darauf anlegen | Auf dem Host zeigt `lsblk` ein `crypt`, `clevis luks list` die Pins — **in der VM nicht**. Probe: Host kalt neu starten, VM kommt ohne Zutun hoch |
| 2 | Pakete, Benutzer, Firewall | `ufw status` zeigt nur 22, 80, 443 |
| 3 | PostgreSQL, Erweiterungen, drei Rollen mit **eigenen** Kennwörtern | `scripts/setup-db.sh` durchgelaufen |
| 4 | Deploy Key, Repository geklont | `git log -1` zeigt den Stand von `main` |
| 5 | `.env` gefüllt, `chmod 600` | `SESSION_SECRET` und `ID_DOCUMENT_KEY` je ≥ 32 Zeichen, **neu erzeugt** |
| 6 | Migrationen, Build, Dienste | `/health` antwortet |
| 7 | Caddy mit TLS und Ratenbegrenzung | Von außen erreichbar, `/v1/auth/login` begrenzt |
| 8 | Erstes Haus anlegen, Stammdaten | `setup-status` meldet vollständig |
| 9 | Brevo: Absender verifiziert, SPF und DKIM gesetzt | Eine Testrechnung kommt an, **nicht** im Spam |
| 10 | Sicherung eingerichtet **und einmal zurückgespielt** | Protokolleintrag mit Datum |
| 11 | Schlüsselrotation einmal geprobt | Dokument 17 §2 |

**Vor Schritt 8 keine echten Gastdaten.** Die Punkte 9 bis 11 sind kein Nachklapp: ohne erprobte Rückspielung und ohne verschlüsselten **Host-Speicher** dürfen dort keine personenbezogenen Daten liegen.

---

## 11. Was nicht auf die Maschine gehört

- **Kein Geheimnis im Repository.** `.env` liegt daneben, nicht darin.
- **Kein Schreibrecht des Deploy Keys.**
- **Kein Übungshaus auf der Produktivmaschine mit echten Adressen.** Es exportiert zwar nichts und verschickt keine Post — aber Schulungsdaten neben Echtdaten sind eine Verwechslung, die irgendwann jemand macht.
- **Keine Entwicklungswerkzeuge im Dauerbetrieb.** `pnpm build` braucht sie, danach laufen zwei Node-Prozesse und sonst nichts.
- **Kein zweiter Worker.** Einmal, sonst laufen zwei Nachtläufe gegeneinander.
