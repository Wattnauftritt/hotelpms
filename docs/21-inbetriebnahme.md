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

### Wenn der Host kein TPM hat — **derzeit offen**

Bei der Erstinbetriebnahme auf einem gemieteten Strato-Host kam heraus: **kein physisches TPM** (`ima: No TPM chip found`), und **kein freier Platz** für einen eigenen Pool — beide SSDs vollständig in `md1`. Entschieden wurde am 15.09.2026, **vorerst ohne Verschlüsselung** zu fahren.

**Diese Sperre steht damit offen, und sie steht hier, statt übergangen zu werden.** Punkt 8 der Reihenfolge unten knüpft echte Gastdaten an verschlüsselten Speicher; solange das nicht gilt, gilt der Punkt nicht.

Die Begründung, die dabei fiel — *„wer Zugriff auf den Host hat, kommt ohnehin an die Daten"* — trägt **nicht**. Plattenverschlüsselung war nie ein Schutz gegen den Host-Administrator (siehe Dokument 17 §1: sie schützt die Platte, die das Haus verlässt). Bei **gemieteter** Hardware wiegt das schwerer als bei eigener: die Platten gehören dem Anbieter, und RMA, Austausch und Ausmusterung sind sein Vorgang. Genau das Szenario, gegen das sie gedacht ist, ist das, über das man am wenigsten Kontrolle hat.

**Das fehlende TPM nimmt nicht das Problem weg, es ändert die Antwort.** Ohne TPM ist der eine Pin weg, der zweite bleibt — aber nur, wenn er woanders steht:

| Weg | Trägt? |
|---|---|
| Tang **auf demselben Blech** (etwa der Plesk-VM) | **Nein.** Der Tang-Schlüssel liegt auch auf `md1`. Wer die Platten hat, hat beide Hälften |
| Tang **auf einer anderen Maschine** — kleiner VPS, Kasten im Hotel | **Ja.** Die Platten allein sind wertlos, der Neustart bleibt unbeaufsichtigt, solange das Netz die andere Maschine erreicht. Kostet ein paar Euro im Monat |
| `dropbear-initramfs`, Entsperren per SSH aus der Ferne | Hält das Geheimnis ganz von der Maschine fern — holt aber den wachen Menschen zurück |

**Nachrüsten kostet keine Neuinstallation.** Ein LUKS-Container als Datei auf `md1`, in Proxmox als Verzeichnis-Speicher eingetragen, dann `qm move-disk <vmid> scsi0 <speicher>`. Die VM merkt davon nichts. Die Entsperrung als systemd-Unit mit `Before=pve-guests.service`, sonst startet Proxmox die Gäste, bevor der Speicher da ist.

**Aber es hat ein Verfallsdatum.** Was heute unverschlüsselt geschrieben wird, bleibt im Klartext auf `md1` liegen, bis es überschrieben wird; ein späterer Umzug verschlüsselt die Kopie, nicht die alten Blöcke. Solange keine echten Gastdaten auf der Maschine waren, ist das folgenlos — **danach nicht mehr.** Der billige Zeitpunkt ist vor Punkt 8, nicht nach ihm.

---

## 3. Bestückung

```bash
# Grundlage
apt update && apt full-upgrade
# sudo ist dabei, weil ein minimales Debian-netinst es nicht mitbringt und
# das Ausrollskript darauf endet. Ohne es bricht es mit "Kommando nicht
# gefunden" ab -- nach dem Bau und nach den Migrationen, also im
# unguenstigsten Moment.
apt install -y curl git ca-certificates gnupg sudo ufw fail2ban unattended-upgrades

# PostgreSQL 17 aus dem PGDG-Depot. Debian 13 (Trixie) bringt 17 selbst mit;
# PGDG liefert Minor-Updates schneller und traegt die Version laenger.
# Fehlt das Depot fuer einen Codenamen einmal, tut Debians eigenes Paket es
# auch -- die Entscheidung ist keine Voraussetzung, sondern eine Vorliebe.
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
adduser --system --group --home /opt/hotelpms --shell /usr/sbin/nologin hotelpms
```

Der Programmstand liegt unter `/opt/hotelpms/current`, die Umgebung in `/opt/hotelpms/shared/env` mit `chmod 600` und dem Benutzer als Eigentümer. **Nicht im Repository** — dort steht nur `.env.example`.

---

## 5. Von GitHub holen: der einfachste tragfähige Weg

Drei Wege stehen zur Wahl. Der mittlere ist der richtige.

| Weg | Urteil |
|---|---|
| Persönliches Zugriffstoken | **Nein.** Es hängt an einem Menschen, läuft ab, und wer das Unternehmen verlässt, nimmt den Betrieb mit |
| **Deploy Key, nur lesend** | **Ja.** Ein Schlüsselpaar je Maschine, in GitHub am Repository hinterlegt, ohne Schreibrecht. Es hängt an der Maschine, nicht an einer Person |
| Artefakt aus CI ziehen | Sauberer für viele Maschinen, aber es braucht eine Ablage, eine Versionierung und ein Zugriffsrecht darauf. Bei **einer** Maschine ist das mehr Apparat als Nutzen |

```bash
sudo -u hotelpms ssh-keygen -t ed25519 -f /opt/hotelpms/shared/.ssh/id_deploy -N ''
cat /opt/hotelpms/shared/.ssh/id_deploy.pub
# → GitHub → Repository → Settings → Deploy keys → Add
#   "Allow write access" bleibt AUS.
```

**Warum ohne Schreibrecht:** die Maschine hat nichts ins Repository zu schreiben. Ein Schlüssel, der es könnte, ist ein Weg vom Produktivsystem in den Quellcode — und den will man nicht, wenn die Maschine einmal kompromittiert ist.

```bash
sudo -u hotelpms git clone git@github.com:Wattnauftritt/hotelpms.git /opt/hotelpms/current
```

---

## 6. Datenbank einrichten

Die drei Rollen legt `scripts/setup-db.sh` an — dasselbe Skript wie in der Entwicklung, damit Entwicklung und Betrieb nicht auseinanderlaufen. **Kennwörter und Datenbanknamen kommen aus der Umgebung**; die Vorgabewerte sind die der Entwicklung und gehören nicht auf eine Maschine, die aus dem Netz erreichbar ist.

```bash
HOTELPMS_DB_OWNER_PASSWORD="$(openssl rand -base64 33)" \
HOTELPMS_DB_APP_PASSWORD="$(openssl rand -base64 33)"   \
HOTELPMS_DB_RO_PASSWORD="$(openssl rand -base64 33)"    \
HOTELPMS_DATABASES="hotelpms"                           \
  ./scripts/setup-db.sh
```

Die Kennwörter werden bei **jedem** Lauf gesetzt, nicht nur beim Anlegen. Sonst behielte eine Maschine, die einmal mit den Entwicklungsvorgaben aufgesetzt wurde, diese für immer — und niemand sähe es. Hier stand einmal, die Kennwörter würden „dabei ersetzt"; das Skript sah keine Ersetzung vor, und wer der Anleitung folgte, hatte `devapp` auf einer Maschine am Netz.

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
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

# Ohne diese Zeile kommt KEINE Verbindung zustande. packages/db/src/pool.ts
# setzt statement_timeout (30 s) und idle_in_transaction_session_timeout
# (10 s) als Startparameter; PgBouncer fuehrt sie von Haus aus nicht mit und
# weist jede Verbindung mit 08P01 "unsupported startup parameter" ab.
track_extra_parameters = statement_timeout, idle_in_transaction_session_timeout
```

**Nicht mit `ignore_startup_parameters` beheben.** Das ist der Rat, den man zuerst findet, und er verwirft die beiden Zeitlimits stillschweigend — die Schutzgrenze gegen Dauerläufer-Abfragen wäre weg, ohne Fehlermeldung, ohne dass es jemand merkt. `track_extra_parameters` führt sie je Client mit und setzt sie auf der Serververbindung. Probe: `SHOW statement_timeout` muss über Port 6432 `30s` liefern, nicht `0`.

**Der Fehler zeigt sich nur über PgBouncer.** Direkt auf 5432 funktioniert alles, `/health` antwortet über 6432 mit 500 — eine Fehlersuche, die bei der Datenbank anfängt, läuft daran vorbei.

`userlist.txt` wird aus `pg_authid` erzeugt, damit kein Klartextkennwort in einer Datei steht:

```bash
su postgres -c "psql -tAqc \"SELECT concat('\\\"', rolname, '\\\" \\\"', rolpassword, '\\\"') \
  FROM pg_authid WHERE rolname LIKE 'hotelpms%' AND rolpassword IS NOT NULL\"" \
  > /etc/pgbouncer/userlist.txt
chown postgres:postgres /etc/pgbouncer/userlist.txt && chmod 640 /etc/pgbouncer/userlist.txt
```

**Unter systemd auf Debian keine `pidfile`- und keine `logfile`-Zeile.** Debians Unit legt kein `/var/run/pgbouncer` an, und der Dienst bricht mit `could not open pidfile` ab. Ohne beide Zeilen läuft er im Vordergrund und protokolliert ins Journal, wo er hingehört.

**PgBouncer muss sich an PostgreSQL anmelden dürfen.** Es verbindet über den Unix-Socket und läuft dabei als Systembenutzer `postgres`, will aber als `hotelpms_app` herein. Debians Vorgabe `local all all peer` leitet die Kennung aus dem Systembenutzer ab und weist das mit `Peer authentication failed` zurück. In `/etc/postgresql/17/main/pg_hba.conf`:

```
  local   all   postgres                 peer
- local   all   all                      peer
+ local   all   all                      scram-sha-256
```

Die Zeile für `postgres` bleibt `peer` — sonst funktioniert `su postgres -c psql` nicht mehr, auch nicht in `scripts/setup-db.sh`.

`pool_mode = transaction` ist richtig und der Grund, warum der Worker **nicht** darüber geht: in diesem Modus wechselt die Sitzung nach jeder Transaktion, und `LISTEN/NOTIFY` kommt nie an. Zwei Verbindungsziele in `.env`:

```
DATABASE_URL=postgres://hotelpms_app@127.0.0.1:6432/hotelpms         # ueber PgBouncer
DATABASE_URL_DIRECT=postgres://hotelpms_app@/hotelpms                # Unix-Socket, direkt
DATABASE_URL_OWNER=postgres://hotelpms_owner@/hotelpms               # nur fuer Migrationen
```

---

## 7. Die Dienste

**Die Unit-Dateien stehen im Repository und werden nicht abgeschrieben:** [`ops/systemd/hotelpms-api.service`](../ops/systemd/hotelpms-api.service) und [`ops/systemd/hotelpms-worker.service`](../ops/systemd/hotelpms-worker.service). Hier stand einmal eine zweite, leicht abweichende Fassung — dieselbe Falle wie beim Ausrollskript.

```bash
install -m 0644 /opt/hotelpms/current/ops/systemd/hotelpms-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hotelpms-api hotelpms-worker
```

**Der Worker läuft genau einmal** — zwei Nachtläufe für dieselbe Property wären zwar idempotent, aber es gibt keinen Grund, das auszuprobieren.

**`MemoryDenyWriteExecute` gehört nicht hinein**, und das ist kein Versehen: die Option verbietet Speicherseiten, die zugleich beschreibbar und ausführbar sind — genau die braucht jeder JIT-Compiler, und V8 ist einer. Der Dienst stirbt beim Start mit `SIGTRAP`, bevor ein Socket entsteht. Die Zeile stand hier einmal und hat die Erstinbetriebnahme aufgehalten; wer sie „der Vollständigkeit halber" wieder einsetzt, legt den Dienst still. In einem Drop-in setzt eine leere Zuweisung sie übrigens **nicht** zurück — es muss `=false` dastehen.

### Caddy

Eine Herkunft für Oberfläche und Schnittstelle — die Entscheidung steht in AP 12 des Umsetzungsplans. Der Grund: getrennte Namen erzwingen CORS mit Anmeldedaten, `SameSite=None` am Sitzungscookie und eine gepflegte Liste erlaubter Herkünfte. Jede dieser drei Stellen ist eine Gelegenheit, sich zu vertun, und ein Fehler darin ist eine Sitzungsübernahme.

**Auch der Caddyfile steht im Repository:** [`ops/caddy/Caddyfile`](../ops/caddy/Caddyfile). Er trägt die Ratenbegrenzung aus Dokument 17 §4 und die Sicherheitskopfzeilen. Der Name der Herkunft ist darin noch ein Platzhalter und muss vor dem ersten echten Aufruf gesetzt werden — an **drei** Stellen: die beiden Blöcke und der `email`-Eintrag für Let's Encrypt, dazu `PUBLIC_APP_URL` in der Umgebungsdatei.

**Caddy muss in die Gruppe `hotelpms`**, sonst erreicht es den Socket nicht. `RuntimeDirectoryMode=0750` sperrt es sonst aus, und jede Anfrage endet in 502 — ein Fehlerbild, das nach einem kaputten Dienst aussieht, obwohl beide Seiten laufen.

```bash
usermod -aG hotelpms caddy
systemctl restart caddy        # restart, NICHT reload
```

**`restart`, nicht `reload`.** Zusätzliche Gruppen übernimmt ein Prozess nur beim Start. Nach einem `reload` steht in `/proc/<pid>/status` weiterhin die alte Gruppenliste, der 502 bleibt — bei unverändert richtiger Konfiguration. Wer das nicht weiß, sucht den Fehler an der einen Stelle, an der er nicht ist.

**Und die Gruppe allein genügt nicht.** Node legt den Socket mit der Standard-Umask 022 an, also `srwxr-xr-x`; die Gruppe hätte nur `r-x`. Zum **Verbinden** mit einem Unix-Socket braucht man aber Schreibrecht. Deshalb steht `UMask=0007` in der API-Unit — damit entsteht er als `srwxrwx---`. Die Falle daran: alle Rechte am *Verzeichnis* stimmen, und die Fehlersuche läuft zuverlässig dorthin.

```bash
ls -l /run/hotelpms/api.sock   # muss srwxrwx--- hotelpms hotelpms zeigen
```

**Die Bereitschaftsroute heißt `/health`.** Sie hieß im Caddyfile einmal `/healthz`, und der Fehler war nicht „keine Antwort", sondern eine falsche: `/health` fiel in den Oberflächen-Zweig und lieferte `index.html` mit Status 200. Eine Überwachung, die auf den Statuscode schaut, meldet einen toten Dienst als gesund. Die Probe ist deshalb nicht der Statuscode, sondern der Inhalt:

```bash
curl -fsS https://<name>/health | grep -q '"status":"ok"'
```

**Das Modul `caddy-ratelimit` muss dabei sein.** Debians Paket bringt es nicht mit; `caddy list-modules | grep rate_limit` sagt, ob es da ist. Fehlt es, weist Caddy die Konfiguration ab — das ist die richtige Richtung, denn eine stillschweigend weggelassene Ratenbegrenzung merkt niemand.

---

## 8. Ausrollen

**Das Skript steht im Repository: [`ops/deploy/deploy.sh`](../ops/deploy/deploy.sh).** Hier stand es einmal abgeschrieben, und genau das ist schiefgegangen: die Anleitung nannte `/srv/hotelpms`, die Units in `ops/systemd/` `/opt/hotelpms`, und niemandem fiel es auf, weil beide Seiten für sich stimmig aussahen. Was auf der Maschine läuft, gehört ins Repository.

```bash
/opt/hotelpms/current/ops/deploy/deploy.sh
```

Es braucht eine eng gefasste `sudo`-Regel — genau die beiden Neustarts, nichts weiter. Vorlage: [`ops/deploy/hotelpms.sudoers`](../ops/deploy/hotelpms.sudoers).

**Skript und Regel müssen Wort für Wort zusammenpassen**, und das ist schon einmal schiefgegangen: die Regel erlaubte zwei Neustarts als zwei Kommandos, das Skript rief beide in *einem* Kommando auf — für `sudoers` ein drittes, unbekanntes. Die erste Ausrollung über den Agenten endete mit „a password is required", nach umgelegtem Symlink und angewandten Migrationen; von Hand als root war es nie aufgefallen, weil root nicht gefragt wird. `scripts/check-sudoers.sh` prüft den Abgleich jetzt in CI.

```bash
install -m 0440 /opt/hotelpms/current/ops/deploy/hotelpms.sudoers /etc/sudoers.d/hotelpms
visudo -c
```

**Kein allgemeines `NOPASSWD: ALL`.** Das wäre bequemer und machte den Dienstbenutzer zu Root — und der Dienstbenutzer ist genau der, den ein Angreifer über die Anwendung bekommt.

### Die Ablage: gebaut wird neben dem laufenden Stand

```
/opt/hotelpms/
  current  ->  releases/<sha>      Symlink. Darauf zeigen die systemd-Units und Caddy
  releases/<sha>/                  ein fertig gebauter Stand, ohne .git
  shared/repo/                     der Klon, aus dem geholt wird
  shared/env                       die Umgebungsdatei, chmod 600
```

Hier wurde einmal **im** laufenden Verzeichnis gebaut. Scheitert der Bau, steht der Quellbaum dann schon auf dem neuen Commit, während `dist/` halb alt und halb neu ist. Die laufenden Prozesse merken nichts — ihr Code liegt im Speicher. Startet die Maschine aber aus einem anderen Grund neu, fährt sie mit einem halben Bau hoch, und der Befund liegt Tage zurück.

Jetzt entsteht je Stand ein eigenes Verzeichnis, und erst wenn es vollständig ist (`.fertig`), schaltet der Symlink um — über `mv -T`, also ein `rename(2)` und damit unteilbar. Ein `ln -sfn` auf einen bestehenden Symlink wäre es **nicht**: es löscht erst und legt dann neu an, und in der Lücke zeigt `current` ins Leere.

Ein gescheiterter Bau lässt den laufenden Stand damit völlig unberührt.

### Zurückrollen

Fällt nebenbei ab: Symlink auf einen älteren Stand, Dienste neu starten. Kein Bau, in Sekunden durch — in der Konsole ein Knopf je verfügbarem Stand, auf der Maschine:

```bash
/opt/hotelpms/current/ops/deploy/deploy.sh rollback <sha>
```

**Die Migrationen wandern nicht mit zurück.** Das Schema bleibt auf dem Stand des neueren Codes. Für hinzufügende Änderungen ist das unproblematisch — der ältere Code sieht eine Spalte mehr und benutzt sie nicht. Wer eine Migration schreibt, die Bestehendes wegnimmt oder umdeutet, nimmt dem Zurückrollen genau diese Eigenschaft; das ist der Preis, und er ist beim Schreiben der Migration zu zahlen, nicht beim Zurückrollen.

Die Maschine behält die letzten fünf Stände (`HOTELPMS_RELEASES_BEHALTEN`) — und nie den laufenden, auch wenn er älter ist. Die Konsole bietet vier an; die beiden Zahlen gehören zusammen, sonst zeigt sie einen Stand, den es auf der Platte nicht mehr gibt.

### Umstieg einer Maschine, die noch die alte Ablage hat

War `current` bisher ein Arbeitsverzeichnis (kein Symlink), einmalig:

```bash
systemctl stop hotelpms-api hotelpms-worker
cd /opt/hotelpms
mkdir -p releases shared
git clone --bare https://github.com/Wattnauftritt/hotelpms.git shared/repo
git -C shared/repo remote add origin https://github.com/Wattnauftritt/hotelpms.git

# Den alten Arbeitsbaum beiseite, damit deploy.sh den Symlink anlegen kann.
mv current current.alt

# Erster Lauf aus dem alten Baum heraus -- er legt releases/<sha> an und
# setzt current als Symlink.
./current.alt/ops/deploy/deploy.sh deploy produktion

# Erst wenn die Gesundheitspruefung durch ist:
rm -rf current.alt
```

Die Umgebungsdatei unter `shared/env` bleibt dabei unberührt — sie liegt außerhalb der Stände, und genau dafür ist `shared/` da.

**`git reset --hard` und nicht `git pull`.** Der Klon unter `shared/repo` ist kein Arbeitsplatz: aus ihm wird nur geholt und mit `git archive` ausgepackt. Ein `pull` könnte in einen Konflikt laufen und stehen bleiben — und dann läuft ein halber Stand.

### Was ausgerollt wird: der Tag `produktion`, nie `main`

`main` trägt, was zuletzt gemergt wurde — auch einen Stand, den niemand für die Produktion vorgesehen hat. Bei mehreren Bearbeitern ist das der Normalfall, nicht die Ausnahme. Freigegeben wird deshalb ausdrücklich:

**Über GitHub:** Actions → *Für die Produktion freigeben* → **Run workflow**. Das Feld steht schon auf `main`; bestätigen genügt. Für einen älteren Stand trägst du Commit, Zweig oder Tag ein.

Der Workflow ([`.github/workflows/freigeben.yml`](../.github/workflows/freigeben.yml)) **weigert sich, einen Stand freizugeben, der nicht grün durch CI ist** — und unterscheidet dabei „kein Lauf" von „läuft noch". Freizugeben, was nie gebaut wurde, fiele sonst erst auf der Maschine auf, beim Bau, mitten im Betrieb.

Er braucht keinen Schlüssel: der eingebaute `GITHUB_TOKEN` reicht und wirkt nur in diesem Repository. Ein Deploy-Key mit Schreibrecht auf der Produktivmaschine wäre der Weg vom Produktivsystem in den Quellcode und bleibt ausgeschlossen (§5).

**Von Hand**, wo Git ohnehin offen ist:

```bash
git tag -f produktion <commit>
git push -f origin produktion
```

Die Maschine holt **nur** diesen Stand; ein Merge nach `main` allein bewirkt nichts.

### Wann ausgerollt wird: der Knopf im Adminpanel

Ein Timer, der von selbst zieht, rollte mitten im Check-in aus. Stattdessen fordert jemand mit `platform:operations` im Adminpanel unter *Betrieb* an; ein Dienst auf der Maschine sieht minütlich nach und führt es aus.

| | |
|---|---|
| [`ops/deploy/deploy-agent.sh`](../ops/deploy/deploy-agent.sh) | holt die offene Anforderung, ruft `deploy.sh`, vermerkt den Ausgang |
| [`ops/systemd/hotelpms-deploy.service`](../ops/systemd/hotelpms-deploy.service) | führt ihn aus |
| [`ops/systemd/hotelpms-deploy.timer`](../ops/systemd/hotelpms-deploy.timer) | weckt ihn jede Minute |

```bash
install -m 0644 /opt/hotelpms/current/ops/systemd/hotelpms-deploy.{service,timer} \
        /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now hotelpms-deploy.timer
```

**Warum die API nicht selbst ausrollt.** Sie läuft unter `NoNewPrivileges=true`; `sudo` ist aus dem Prozess heraus gesperrt, und der Neustart der Dienste braucht genau das. Das ist keine Hürde, die man umgeht, sondern der Grund, warum ein Einbruch in die Anwendung nicht gleich die Maschine ist. Die API schreibt deshalb nur eine Zeile in `deploy_request`; wer sie ausführt, ist ein anderer Prozess mit anderen Rechten — und `hotelpms-deploy.service` trägt bewusst **kein** `NoNewPrivileges`.

Damit ist diese Unit die empfindlichste auf der Maschine. Was sie trägt, ist nicht Härtung, sondern dass sie nur tut, was in der Datenbank steht — und dorthin schreibt nur, wer `platform:operations` hat.

**Ein Lauf von Hand bleibt möglich** und wird gesehen: `deploy.sh` direkt aufzurufen ist der Weg für den ersten Start und für den Fall, dass die Konsole selbst nicht läuft.

**Wenn der Knopf nicht mehr geht**, steht meist eine Anforderung auf `running` fest — ein abgebrochener Lauf. Der eindeutige Teilindex lässt dann keine weitere zu, und das ist so gewollt: zwei gleichzeitige Läufe zögen sich im selben Verzeichnis die Dateien weg. Nachsehen und freigeben:

```sql
SELECT id, status, started_at, log FROM deploy_request ORDER BY id DESC LIMIT 5;
UPDATE deploy_request SET status = 'failed', finished_at = now() WHERE id = <id>;
```

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
| 1 | **Auf dem Host:** verschlüsselter Datenspeicher, Entsperrung über TPM oder Tang; dann die VM darauf anlegen. Geht das nicht (kein TPM, kein Platz): §2 lesen und die Entscheidung dort eintragen | Auf dem Host zeigt `lsblk` ein `crypt`, `clevis luks list` die Pins — **in der VM nicht**. Probe: Host kalt neu starten, VM kommt ohne Zutun hoch. Nachrüsten: [`22-luks-nachruesten.md`](22-luks-nachruesten.md) |
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

> **Stand 15.09.2026: die zweite Hälfte dieser Sperre ist offen.** Der Host hat kein TPM und keinen freien Platz, entschieden wurde vorerst ohne Verschlüsselung (§2). Für das eigene Pilothaus ist das ein bewusst getragenes, hier dokumentiertes Risiko. Für einen zahlenden Fremdbetrieb ist es keines.

---

## 11. Proxmox: zwei Fallen beim Anlegen der VM

Beides bei der Erstinbetriebnahme aufgelaufen, beides reproduziert.

**Bootreihenfolge: Platte vor CD.** Mit `boot: order=ide2;scsi0` startet die VM nach der fertigen Installation wieder von der Installer-ISO und beginnt von vorn — inklusive Überschreiben der gerade fertigen Installation. Richtig ist `order=scsi0;ide2`: die leere Platte trägt keinen Bootloader, OVMF fällt von selbst auf die CD zurück, und nach der Installation kommt die CD nie wieder an die Reihe.

**`qm set --boot` ersetzt nicht immer.** Auf Proxmox 9.0.11 hängt ein zweites `qm set <vmid> --boot` kurz nach dem ersten eine **zweite** `boot:`-Zeile an, statt die vorhandene zu ändern. Zweimal reproduziert. Nach jedem Ändern nachsehen:

```bash
grep -c '^boot' /etc/pve/qemu-server/<vmid>.conf   # muss 1 sein
```

---

## 12. Was nicht auf die Maschine gehört

- **Kein Geheimnis im Repository.** `.env` liegt daneben, nicht darin.
- **Kein Schreibrecht des Deploy Keys.**
- **Kein Übungshaus auf der Produktivmaschine mit echten Adressen.** Es exportiert zwar nichts und verschickt keine Post — aber Schulungsdaten neben Echtdaten sind eine Verwechslung, die irgendwann jemand macht.
- **Keine Entwicklungswerkzeuge im Dauerbetrieb.** `pnpm build` braucht sie, danach laufen zwei Node-Prozesse und sonst nichts.
- **Kein zweiter Worker.** Einmal, sonst laufen zwei Nachtläufe gegeneinander.
