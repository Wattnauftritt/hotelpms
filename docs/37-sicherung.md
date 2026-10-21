# Sicherung: einrichten, prüfen, zurückspielen

Bis 15.10.2026 beschrieb Dokument 17 §3 eine Sicherung, die es nicht gab: weder Skript noch Unit standen in `ops/`, und Dokument 16 führte „Sicherung außer Haus" als offen. Hier steht, was eingerichtet wird, und was zu tun ist, wenn es gebraucht wird. Die Dateien liegen in `ops/backup/`, `ops/systemd/` und `scripts/backup/`; dieses Dokument verweist auf sie und schreibt sie nicht ab.

Die Entscheidungen dahinter traf Sven am 15.10.2026, den Speicher am 21.10.2026: **plusserver S3 Storage** in Köln (Region `de-west-1`), bestellt über den CloudHub. Vorher standen OVH (nicht auszahlbare Vorauszahlung von 100 €), Hetzner (Konto kam nicht zustande) und IONOS (im Konto fand sich kein Objektspeicher) zur Wahl. plusserver ist ein deutscher Anbieter mit Rechenzentren in Köln und Hamburg und gehört nicht wie Strato zu United Internet; der Speicher liegt damit bei einem anderen Anbieter als die Maschine, und Schicht 2 bei einem dritten. Zweites Ziel ist ein kleiner **netcup-VPS**, der zugleich den Tang-Server aus Dokument 22 trägt. Dateien bleiben in der Datenbank (Rechnungs-PDF, Kassenbelege, Bilder liegen als `bytea` darin), und eine Datenbanksicherung ist damit vollständig.

---

## 1. Was wogegen schützt

| Schicht | Was | Wohin | Wie lange | Schützt gegen |
|---|---|---|---|---|
| 1 | pgBackRest: WAL laufend, sonntags voll, sonst differenziell | plusserver S3 Storage Köln, Bucket `staygrid-pgbackrest`, Object Lock | 2 Vollsicherungen, also 14 bis 21 Tage, jeder Zeitpunkt darin | Ausfall der VM oder des Hosts, missglückte Migration, Bedienfehler. Verlust höchstens eine Minute |
| 2 | `pg_dump`, Rollen, `/etc`, Umgebungsdatei, Löschliste; mit `age` verschlüsselt | netcup-VPS, nimmt nur an (`rrsync -wo -no-del`) | 30 Tage täglich, 12 Monate monatlich | Fehler in pgBackRest, verlorene Passphrase, gesperrtes plusserver-Konto. Ein Tag Verlust |
| 3 | `vzdump` der VM 102 | Proxmox-Host | zwei Generationen | Nur schneller Neuaufbau, keine Sicherung im eigentlichen Sinn |
| 4 | GoBD-Export je Haus und Jahr, mit Belegen und Kassenbuch | plusserver, Bucket `staygrid-archiv`, Object Lock **Compliance** 10 Jahre; dazu offline im Tresor | 10 Jahre | Verlust von Datenbank **und** Sicherungen; StayGrid läuft nicht mehr |

Die steuerliche Aufbewahrung erfüllt der laufende Bestand, nicht Schicht 1 bis 3 (Dokument 17 §3). Schicht 4 ist der Fall, in dem es den laufenden Bestand nicht mehr gibt.

**Gelöschte Gäste.** Eine Löschung nach Art. 17 DSGVO wirkt auf den Bestand, nicht rückwirkend auf Sicherungen. Zulässig ist das, weil jede Vollsicherung nach spätestens zwölf Monaten verfällt, Sicherungen nur zur Wiederherstellung dienen und eine Wiederherstellung die Löschungen nachholt (§5.4). Schicht 4 enthält nur, was nach § 147 AO ohnehin bleiben muss: keine Meldescheine, keine Ausweisnummern, keine Kontaktdaten.

---

## 2. Einrichten: plusserver

Im plusserver CloudHub:

1. **S3 Storage** bestellen, Variante Standard (ohne Replikation: die zweite Kopie ist Schicht 2 bei netcup, nicht ein zweites Rechenzentrum desselben Anbieters), Region Köln (`de-west-1`).
2. Einen Zugangsschlüssel (Access Key und Secret Key) erzeugen. Beide gehen auf die Maschine in `/etc/pgbackrest/conf.d/geheim.conf` und in den Passwortspeicher, nie in einen Chat oder eine Mail.
3. Den AVV mit plusserver abschließen und ausgedruckt zu den Unterlagen legen. Ohne ihn ist der Eintrag im Verarbeitungsverzeichnis falsch.

Die Buckets werden **mit der CLI** angelegt, nicht in der Oberfläche: Object Lock lässt sich nur beim Anlegen einschalten, und die Anleitung von plusserver tut es über `--object-lock-enabled-for-bucket`. Ein Bucket ohne Sperre lässt sich nicht nachrüsten, nur neu anlegen und umkopieren. Bucket-Namen sind über alle Kunden von plusserver eindeutig: ist der Name vergeben, einen anderen wählen und in `ops/backup/pgbackrest.conf` eintragen.

Einmal von einem Rechner mit `aws`-CLI und den Zugangsdaten (`aws configure`, Region `de-west-1`):

```bash
E=https://s3.de-west-1.psmanaged.com
R=de-west-1

# Beide Buckets mit Object Lock; die Versionierung kommt damit von selbst.
for b in staygrid-pgbackrest staygrid-archiv; do
  aws --endpoint-url $E --region $R s3api create-bucket --bucket $b \
    --object-lock-enabled-for-bucket --create-bucket-configuration LocationConstraint=$R
done

# Gegenprobe: "ObjectLockEnabled": "Enabled" und "Status": "Enabled".
aws --endpoint-url $E --region $R s3api get-object-lock-configuration --bucket staygrid-pgbackrest
aws --endpoint-url $E --region $R s3api get-bucket-versioning --bucket staygrid-pgbackrest

# Schicht 1: jede Version 21 Tage im Compliance-Modus gesperrt. Das ist
# laenger als die Aufbewahrung in pgBackRest. Wer die Zugangsdaten vom Server
# hat, kann loeschen, aber nur Loeschmarker setzen -- die Versionen bleiben
# die Frist ueber da. Governance reichte nicht: dieselben Zugangsdaten
# duerften die Sperre umgehen.
aws --endpoint-url $E --region $R s3api put-object-lock-configuration \
  --bucket staygrid-pgbackrest --object-lock-configuration '{"ObjectLockEnabled":"Enabled",
    "Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":21}}}'

# Ueberholte Versionen nach 30 Tagen wegraeumen, sonst waechst der Bucket
# ohne Ende.
aws --endpoint-url $E --region $R s3api put-bucket-lifecycle-configuration \
  --bucket staygrid-pgbackrest --lifecycle-configuration '{"Rules":[{"ID":"alte-versionen",
    "Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}'
```

Die Zugangsdaten gelten für beide Buckets. Das Archiv schützt deshalb nicht die Trennung der Schlüssel, sondern die Sperre im **Compliance**-Modus, die niemand aufheben kann, auch nicht mit diesen Schlüsseln (§6).

Am Archiv wird **keine** Standardsperre gesetzt: die Frist steht an jeder Datei beim Hochladen (§6).

**Vor dem ersten Vertrauen prüfen**, weil es am 21.10.2026 nur aus der Anleitung des Anbieters bekannt war (sie zeigt Object Lock und die Standardsperre, sagt aber nichts zu Lebenszyklusregeln): dass sich eine gesperrte Version nicht löschen lässt (`aws s3api delete-object --version-id …` muss scheitern), dass die Lebenszyklusregel angenommen wird, und dass pgBackRest in den gesperrten Bucket schreiben kann. Manche S3-Dienste verlangen bei Object Lock eine Prüfsumme je Upload; `stanza-create` und `check` in §3 zeigen es sofort. Scheitern sie daran, die Standardsperre wieder entfernen und Schicht 1 ohne Sperre betreiben: Schicht 2 bleibt dann der Schutz gegen Löschen. Weist plusserver nur die Lebenszyklusregel ab, bleibt die Sperre; die überholten Versionen räumt dann einmal im Monat `aws s3api delete-object --version-id` für alles älter als 30 Tage weg, was nach Ablauf der Sperre geht.

---

## 3. Einrichten: Produktivmaschine

**Schlüssel zuerst.** Auf einem anderen Rechner, nicht auf der VM:

```bash
age-keygen -o staygrid-sicherung.key     # privat: Passwortspeicher und Tresor
age-keygen -y staygrid-sicherung.key     # oeffentlich: auf die VM
```

Auf der VM, als root:

```bash
apt install pgbackrest age rsync

# Schicht 1
install -m 644 ops/backup/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
install -d -m 750 -o postgres -g postgres /etc/pgbackrest/conf.d
install -m 600 -o postgres -g postgres ops/backup/geheim.conf.vorlage \
  /etc/pgbackrest/conf.d/geheim.conf      # dann die drei Werte eintragen
install -m 644 ops/backup/postgresql-sicherung.conf \
  /etc/postgresql/17/main/conf.d/hotelpms-sicherung.conf
systemctl restart postgresql             # archive_mode braucht den Neustart
sudo -u postgres pgbackrest --stanza=hotelpms stanza-create
sudo -u postgres pgbackrest --stanza=hotelpms check
sudo -u postgres pgbackrest --stanza=hotelpms --type=full backup

# Damit deploy.sh vor jeder Migration einen Wiederherstellungspunkt setzen
# kann. Je Datenbank, nicht global.
sudo -u postgres psql -d hotelpms \
  -c 'GRANT EXECUTE ON FUNCTION pg_create_restore_point(text) TO hotelpms_owner'

# Schicht 2
install -d -m 700 /etc/hotelpms /var/backups/hotelpms
echo 'age1…' > /etc/hotelpms/sicherung.age-empfaenger   # der oeffentliche Schluessel
install -m 600 ops/backup/sicherung.env.vorlage /etc/hotelpms/sicherung.env
install -m 755 ops/backup/sicherung.sh /usr/local/sbin/hotelpms-sicherung
ssh-keygen -t ed25519 -N '' -C hotelpms-sicherung -f /root/.ssh/hotelpms-sicherung

# Units
cp ops/systemd/hotelpms-sicherung.{service,timer} ops/systemd/hotelpms-pgbackrest@.service \
   ops/systemd/hotelpms-pgbackrest-{voll,diff}.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hotelpms-sicherung.timer hotelpms-pgbackrest-voll.timer \
  hotelpms-pgbackrest-diff.timer
```

In `/etc/hotelpms/sicherung.env` stehen das Ziel (§4) und die Adresse des Totmannschalters. Ein erster Lauf von Hand: `systemctl start hotelpms-sicherung` und dann `journalctl -u hotelpms-sicherung`.

**Der Pfad in `postgresql-sicherung.conf` und `pgbackrest.conf` nennt PostgreSQL 17.** Auf einer anderen Version beide Stellen anpassen.

---

## 4. Einrichten: zweites Ziel (netcup-VPS)

Der VPS trägt zugleich den Tang-Server aus Dokument 22. Als root:

```bash
apt install rsync curl
useradd -m -s /bin/sh sicherung
install -d -o sicherung -m 700 /srv/sicherung/eingang
install -d -m 700 /srv/sicherung/{taeglich,monatlich,defekt}
# authorized_keys nach ops/backup/authorized_keys.vorlage, mit dem
# oeffentlichen Schluessel aus /root/.ssh/hotelpms-sicherung.pub der VM
install -m 755 ops/backup/einsortieren.sh /usr/local/sbin/hotelpms-einsortieren
cp ops/backup/hotelpms-einsortieren.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now hotelpms-einsortieren.timer
```

**Warum geschoben und nicht geholt.** Die VM steht hinter dem Proxmox-Host und ist von außen nicht erreichbar. Sie schiebt deshalb, aber der Schlüssel kann nur in `eingang/` schreiben, nicht lesen und nicht löschen. `einsortieren.sh` holt fertige Sätze alle 15 Minuten heraus, prüft die Prüfsummen und legt sie dorthin, wo die VM nicht hinkommt. Wer die VM übernimmt, kann neue Sätze schicken, aber keinen alten anrühren.

Auch nicht über den Namen (Audit 19.10.2026, M8): die Aufbewahrung sortiert danach, und dreißig Sätze `9999-01-01` ff. hätten jeden echten verdrängt. `einsortieren.sh` nimmt deshalb nur ein echtes Datum bis morgen an, ersetzt keinen vorhandenen Satz (der zweite geht nach `defekt/`) und räumt nicht auf, wenn in einem Lauf mehr als drei Sätze ankommen. Dann steht `/srv/sicherung/AUFRAEUMEN_GESPERRT`, der Totmannschalter meldet einen Fehler, und erst wer `taeglich/` angesehen und die Datei gelöscht hat, gibt das Aufräumen wieder frei.

Der Totmannschalter (zum Beispiel healthchecks.io, in `/etc/hotelpms/einsortieren.env` als `MELDEN=`) bekommt nur bei einem neuen, geprüften Satz ein Lebenszeichen. Bleibt es einen Tag aus, kommt eine Mail, auch dann, wenn die VM gar nicht mehr sendet.

---

## 5. Zurückspielen

Zuerst die Dienste anhalten, damit niemand in einen Stand bucht, der gleich ersetzt wird: `systemctl stop hotelpms-api hotelpms-worker`.

### 5.1 Eine Migration ist schiefgegangen

`deploy.sh` setzt vor jeder Migration den Punkt `vor-<sha>`. Im Journal der Ausrollung steht, welcher es war.

```bash
systemctl stop postgresql
sudo -u postgres pgbackrest --stanza=hotelpms --delta \
  --type=name --target=vor-<sha> --target-action=promote restore
systemctl start postgresql
sudo -u hotelpms /opt/hotelpms/current/ops/deploy/deploy.sh rollback <voriger-sha>
```

Alles, was nach der Ausrollung gebucht wurde, ist danach weg. Das ist der Preis; die Rezeption muss wissen, was sie seitdem gebucht hat.

### 5.2 Die VM ist verloren

Neue VM nach Dokument 21 bis einschließlich PostgreSQL und pgBackRest, die Schlüssel aus dem Passwortspeicher in `geheim.conf`, dann:

```bash
systemctl stop postgresql
sudo -u postgres pgbackrest --stanza=hotelpms --delta restore   # bis zum letzten WAL
systemctl start postgresql
```

Die Umgebungsdatei und `/etc` kommen aus dem neuesten Satz von Schicht 2 (`konfiguration.tar.age`). **Ohne die Umgebungsdatei sind die Ausweisnummern unlesbar**, denn `ID_DOCUMENT_KEY` steht nur dort und im Passwortspeicher.

### 5.3 pgBackRest ist unbrauchbar

Aus Schicht 2, auf einen Tag genau:

```bash
age -d -i staygrid-sicherung.key datenbank.dump.age > datenbank.dump
age -d -i staygrid-sicherung.key rollen.sql.age | sudo -u postgres psql
sudo -u postgres createdb -O hotelpms_owner hotelpms
sudo -u postgres pg_restore --exit-on-error -d hotelpms datenbank.dump
```

Danach §5.4.

### 5.4 Löschungen nachholen

Nach jeder Rückspielung auf einen älteren Stand, also immer nach §5.1 und §5.3:

```bash
scripts/backup/loeschnachtrag.sh <neuester-satz>/geloescht.txt.age staygrid-sicherung.key hotelpms
```

Die Liste kommt aus dem **neuesten** Satz, nicht aus dem zurückgespielten: nur er kennt die späteren Löschungen. Sie trägt Konto und Gast-ID, keine Namen.

---

## 6. Jahresarchiv

Einmal im Jahr, wenn die Steuerberatung das Jahr abgeschlossen hat, je Haus:

1. In der Oberfläche den GoBD-Export des Kalenderjahres als ZIP holen. Er enthält Rechnungen, Positionen, Zahlungen, Anzahlungsjournal, Kassenbuch, Kassenbelege, Protokoll und alle Belege, beschrieben nach GDPdU. Ein großes Haus bekommt ein Jahr in zwei Teilen, wenn die Belege die Obergrenze je Archiv übersteigen.
2. Verschlüsseln und hochladen, mit einer Sperre, die auch der Kontoinhaber nicht aufheben kann:

```bash
age -r age1… -o gobd-2026-haus1.zip.age gobd-2026-haus1.zip
sha256sum gobd-2026-haus1.zip.age > gobd-2026-haus1.zip.age.sha256
aws --endpoint-url https://s3.de-west-1.psmanaged.com --region de-west-1 s3api put-object \
  --bucket staygrid-archiv --key 2026/gobd-2026-haus1.zip.age \
  --body gobd-2026-haus1.zip.age \
  --object-lock-mode COMPLIANCE --object-lock-retain-until-date 2037-01-01T00:00:00Z
```

3. Dieselben Dateien auf einen Datenträger im Tresor.

Zehn Jahre ab Ende des Kalenderjahres, also bis 2037 für 2026 (§ 147 Abs. 4 AO).

---

## 7. Prüfen

| Wann | Was |
|---|---|
| Ständig | Der Worker liest stündlich `pg_stat_archiver` und schreibt `ALARM:` ins Protokoll, wenn die Archivierung aus ist, der letzte Versuch scheiterte oder seit einem Tag nichts archiviert wurde |
| Täglich | Totmannschalter des zweiten Ziels; `journalctl -u hotelpms-sicherung` zeigt die Größe des Satzes |
| Wöchentlich | `sudo -u postgres pgbackrest --stanza=hotelpms info` |
| Vierteljährlich | `scripts/backup/rueckspielprobe.sh <satz> <schluessel>`. Spielt in `hotelpms_restore` zurück, prüft jedes Rechnungs-PDF und jeden Kassenbeleg gegen seine SHA-256 und ob `ID_DOCUMENT_KEY` im Satz steckt, druckt Summen je Haus zum Vergleich mit der Produktion und trägt das Ergebnis mit Datum ins Protokoll ein. Die Datenbank danach löschen |
| Jährlich | §5.2 auf einer frischen VM, mit der Uhr daneben. Das ist das tatsächliche RTO |

**Erprobt am 15.10.2026** an PostgreSQL 16 in der Entwicklungsumgebung, mit einem lokalen Repository statt S3:

- `stanza-create`, `check` und eine Vollsicherung mit Verschlüsselung;
- die Rückspielung auf einen benannten Wiederherstellungspunkt: ein danach gelöschter Gast war wieder da, ein davor gelöschter nicht;
- `sicherung.sh` durch `rrsync -wo -no-del`: Löschen und Lesen über denselben Schlüssel wurden abgewiesen;
- `einsortieren.sh` mit einem manipulierten und einem halben Satz und der Rotation auf 30 und 12;
- `rueckspielprobe.sh` und `loeschnachtrag.sh`: ein nach der Sicherung gelöschter Gast war nach der Rückspielung wieder da und nach dem Nachtrag gelöscht.

Nicht erprobt sind das S3-Ziel bei plusserver und die Units an einem laufenden systemd. Beides gehört beim Einrichten nachgerechnet (CLAUDE.md, Betriebsdateien).
