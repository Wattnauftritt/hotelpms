# Verschlüsselung nachrüsten, ohne die VM anzufassen

Für den Fall, der bei der Erstinbetriebnahme eingetreten ist: der Host hat **kein TPM** und **keinen freien Platz** für einen eigenen Pool, und die VM läuft bereits unverschlüsselt.

**Die VM wird nicht neu aufgesetzt.** Die Verschlüsselung ist Arbeit am Host; die VM merkt davon nichts. Das Warum steht in [`17-betrieb.md`](17-betrieb.md) §1, die Entscheidungslage in [`21-inbetriebnahme.md`](21-inbetriebnahme.md) §2.

---

## Vorher entscheiden: wo steht Tang?

Ohne TPM ist der eine Pin weg. Der zweite trägt nur, wenn er **nicht auf demselben Blech** steht:

| Ort | Trägt? |
|---|---|
| Plesk-VM, andere VM auf demselben Host | **Nein.** Der Tang-Schlüssel liegt auch auf `md1`. Wer die Platten hat, hat beide Hälften |
| Kleiner VPS bei einem **anderen** Anbieter | **Ja.** Empfohlen. Ein paar Euro im Monat |
| Kasten im Hotel, per VPN erreichbar | **Ja**, wenn die Verbindung beim Hostboot schon steht |

Ohne zweiten Ort bleibt nur das Entsperren von Hand. Das holt den wachen Menschen zurück, den wir loswerden wollten — der Aufwand dahinter ist aber ein Bruchteil dessen, was hier einmal stand: **kein `dropbear-initramfs`.** Das Werkzeug entsperrt eine verschlüsselte **Wurzel** im initramfs, und die bleibt hier bewusst offen, damit der Host nach einem Stromausfall immer erreichbar ist ([`17-betrieb.md`](17-betrieb.md) §1). Der Host bootet also normal durch; jemand meldet sich per SSH an und führt drei Befehle aus:

```bash
clevis luks unlock -d /srv/hotelpms-krypto.img -n hotelpms_krypto \
  || cryptsetup open /srv/hotelpms-krypto.img hotelpms_krypto     # Notfall-Passphrase
mount /dev/mapper/hotelpms_krypto /srv/verschluesselt
qm start <vmid>
```

---

## 1. Tang aufsetzen (auf der **anderen** Maschine)

```bash
apt install -y tang
systemctl enable --now tangd.socket        # lauscht auf 7500/tcp
```

Nur vom Host erreichbar machen — Tang hat keine eigene Zugangsprüfung, seine Sicherheit ist die Erreichbarkeit:

```bash
ufw allow from <host-ip> to any port 7500 proto tcp
```

Schlüssel-Fingerabdruck notieren, er gehört ins Protokoll:

```bash
tang-show-keys 7500
```

## 2. LUKS-Container auf `md1` anlegen (auf dem **Proxmox-Host**)

**Erst messen, dann anlegen.** `fallocate` belegt den Platz sofort und vollständig; eine zu grosszügige Zahl macht den Host arbeitsunfähig. Hier stand einmal `200G` — bei 205 GB frei wären fünf übrig geblieben.

```bash
df -h /                          # was ist frei?
qm list                          # welche VMs sollen hinein?
du -sh /var/lib/vz/images/*      # was belegen sie TATSAECHLICH
du -sh /var/lib/vz/dump          # und liegen dort Sicherungen? (siehe unten)
```

Die nominelle Plattengröße einer VM ist nicht ihr Platzbedarf: eine mit 80 GB angelegte, frisch installierte VM belegt dünn bereitgestellt oft unter 5 GB. Gerechnet wird mit dem **tatsächlich Belegten** plus Wachstum plus einem Drittel Luft — und die Hälfte des freien Platzes bleibt beim Host, sonst kann Proxmox weder eine Sicherung schreiben noch eine Platte verschieben.

```bash
apt install -y cryptsetup clevis clevis-luks

mkdir -p /srv/verschluesselt
fallocate -l <gemessene-groesse> /srv/hotelpms-krypto.img

cryptsetup luksFormat --type luks2 /srv/hotelpms-krypto.img
# Die hier vergebene Passphrase ist die NOTFALL-Passphrase.
# Ausgedruckt in den Tresor, zusaetzlich in den Passwortspeicher,
# erreichbar fuer mindestens zwei Personen. Nicht der Betriebsweg.

cryptsetup open /srv/hotelpms-krypto.img hotelpms_krypto
mkfs.ext4 /dev/mapper/hotelpms_krypto
mount /dev/mapper/hotelpms_krypto /srv/verschluesselt
```

## 3. An Tang binden

```bash
clevis luks bind -d /srv/hotelpms-krypto.img tang '{"url":"http://<tang-host>:7500"}'
clevis luks list -d /srv/hotelpms-krypto.img      # muss den tang-Pin zeigen
```

**Probe, bevor es weitergeht:** schließen und ohne Passphrase wieder öffnen.

```bash
umount /srv/verschluesselt && cryptsetup close hotelpms_krypto
clevis luks unlock -d /srv/hotelpms-krypto.img -n hotelpms_krypto
```

Fragt es nach einer Passphrase, ist die Bindung nicht in Ordnung — **nicht weitermachen**, sonst startet der Host später nicht durch.

## 4. Beim Hochfahren entsperren — vor den Gästen

Die Reihenfolge ist der Punkt: ohne `Before=pve-guests.service` startet Proxmox die VMs, bevor der Speicher da ist.

```ini
# /etc/systemd/system/hotelpms-krypto.service
[Unit]
Description=LUKS-Container fuer die VM-Platten entsperren
# Netz muss stehen, sonst ist Tang nicht erreichbar.
After=network-online.target
Wants=network-online.target
Before=pve-guests.service pve-container.service
# KEIN DefaultDependencies=no. Das nimmt der Unit unter anderem
# Conflicts=shutdown.target und Before=shutdown.target -- damit ist nicht
# mehr zugesichert, dass ExecStop beim Herunterfahren ueberhaupt laeuft,
# und der Container wird nicht sauber geschlossen. Es widerspricht ausserdem
# dem After=network-online.target darueber, einem Ziel aus dem spaeten Start.
# Before= allein erreicht, worum es hier geht.

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/clevis luks unlock -d /srv/hotelpms-krypto.img -n hotelpms_krypto
ExecStart=/bin/mount /dev/mapper/hotelpms_krypto /srv/verschluesselt
ExecStop=/bin/umount /srv/verschluesselt
ExecStop=/sbin/cryptsetup close hotelpms_krypto

# Ein Tang-Server auf einer fremden Maschine braucht nach einem Kaltstart
# beider Seiten leicht eine Minute, bis er antwortet. Die Vorgaben
# (StartLimitBurst=5 in StartLimitIntervalSec=10s) greifen bei RestartSec=10
# aber sofort: nach wenigen Versuchen gilt die Unit endgueltig als
# gescheitert. Deshalb ausdruecklich setzen -- zwoelf Versuche ueber zwei
# Minuten.
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=180
StartLimitBurst=12

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now hotelpms-krypto
```

**Und was gilt, wenn Tang dauerhaft schweigt?** Das ist zu entscheiden, nicht zu vergessen. `Before=` ist nur eine *Reihenfolge*, keine Bedingung: scheitert diese Unit endgültig, startet Proxmox die Gäste trotzdem — **ohne ihre Platten**. Genau das, was hier verhindert werden soll.

Wer das nicht will, macht die Abhängigkeit hart. Dann bleiben die Gäste aus, bis jemand von Hand entsperrt (Abschnitt „Vorher entscheiden"):

```bash
# /etc/systemd/system/pve-guests.service.d/krypto.conf
[Unit]
Requires=hotelpms-krypto.service
After=hotelpms-krypto.service
```

Beides ist vertretbar, eines muss gewählt sein: eine VM, die ohne ihre Platte hochfährt, ist kein ausgefallener Dienst, sondern ein Dienst, der Unsinn erzählt.

## 5. Speicher in Proxmox eintragen und die Platte umziehen

```bash
pvesm add dir verschluesselt --path /srv/verschluesselt --content images
qm move-disk <vmid> scsi0 verschluesselt --delete 1
```

Geht im laufenden Betrieb; mit angehaltener VM ist es schneller und ruhiger. Dasselbe danach für die Plesk-VM, wenn sie auch hinein soll.

## 6. Abnahme

Nicht `lsblk`, sondern der **Kaltstart**:

```bash
reboot
# danach, ohne dass jemand etwas eingibt:
cryptsetup status hotelpms_krypto     # muss "is active" zeigen
qm status <vmid>                      # muss "running" zeigen
curl -fsS https://<name>/health | grep -q '"status":"ok"'
```

Mit Datum ins Betriebsprotokoll, wie die Rückspielung.

---

## Drei Dinge, die dabei schiefgehen und teuer sind

**Die alten Blöcke bleiben lesbar.** Der Umzug verschlüsselt die *Kopie*; was vorher unverschlüsselt auf `md1` stand, liegt dort weiter im Klartext, bis es überschrieben wird. `qm move-disk --delete 1` gibt den Platz frei, löscht ihn aber nicht. Waren echte Gastdaten drauf, gehört der freie Bereich anschließend verworfen:

```bash
fstrim -v /
```

> **Nicht `blkdiscard`.** Hier stand das einmal, und es wäre der teuerste Befehl dieses Dokuments gewesen. `blkdiscard` arbeitet auf einem **ganzen Blockgerät**, nicht auf dem freien Platz innerhalb eines Dateisystems — und wo `md1` die Wurzel *ist*, verwirft `blkdiscard /dev/md1` Proxmox, alle VM-Platten und alle Sicherungen in einem Zug. `fstrim` verwirft die ungenutzten Blöcke eines **eingehängten** Dateisystems; auf SSDs sind sie danach nicht mehr auslesbar.

`fstrim.timer` läuft auf einem üblichen Debian ohnehin wöchentlich. Der Befehl beschleunigt also nur, was von selbst passiert — nachsehen lohnt trotzdem: `systemctl is-enabled fstrim.timer` und `lsblk -D` (die Spalte `DISC-GRAN` darf nicht `0B` sein).

**Deshalb: vor den ersten echten Gastdaten machen.** Danach ist es keine Nachrüstung mehr, sondern eine Nachrüstung plus Aufräumen — und das Aufräumen vergisst man.

**Die Sicherungen, die schon da sind.** Der Umzug bewegt VM-Platten. Er bewegt **nicht**, was in `/var/lib/vz/dump` liegt — und dort stehen vollständige Abbilder, unter Umständen mit echten Kundendaten, weiter unverschlüsselt auf `md1`. Dokument 17 §1 nennt „die mitgenommene Sicherung" ausdrücklich als Schutzziel; solange die Archive daneben liegen, ist genau dieses Ziel nicht erreicht.

```bash
du -sh /var/lib/vz/dump          # meist der groesste Posten ueberhaupt
```

Zwei Wege: die Archive **mit** in den Container legen — dann muss er entsprechend größer ausfallen, siehe Abschnitt 2 — oder sie außer Haus schieben und lokal löschen. Was nicht geht, ist sie zu übersehen: sie sind oft umfangreicher als die VM-Platten, die man gerade mühsam verschlüsselt hat.

**Und die künftige Sicherung mitdenken.** Eine Proxmox-Sicherung der verschlüsselten Platte ist ein Klumpen, den man ohne Schlüssel nicht öffnet. Gesichert wird aus der laufenden VM heraus (`pg_dump` plus Belege, eigenständig verschlüsselt, außer Haus) — steht so in [`21-inbetriebnahme.md`](21-inbetriebnahme.md) §9.
