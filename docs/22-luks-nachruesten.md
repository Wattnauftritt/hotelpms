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

Ohne zweiten Ort bleibt nur `dropbear-initramfs` (Entsperren per SSH aus der Ferne) — das holt den wachen Menschen zurück, den wir loswerden wollten, ist aber besser als nichts.

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

Größe so wählen, dass die VM-Platten hineinpassen und Luft bleibt. Später vergrößern geht, ist aber Handarbeit.

```bash
apt install -y cryptsetup clevis clevis-luks

mkdir -p /srv/verschluesselt
fallocate -l 200G /srv/hotelpms-krypto.img

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
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/clevis luks unlock -d /srv/hotelpms-krypto.img -n hotelpms_krypto
ExecStart=/bin/mount /dev/mapper/hotelpms_krypto /srv/verschluesselt
ExecStop=/bin/umount /srv/verschluesselt
ExecStop=/sbin/cryptsetup close hotelpms_krypto
# Tang kann beim Hochfahren noch nicht antworten. Lieber dreimal
# versuchen als die Gaeste ohne Speicher starten lassen.
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now hotelpms-krypto
```

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

## Zwei Dinge, die dabei schiefgehen und teuer sind

**Die alten Blöcke bleiben lesbar.** Der Umzug verschlüsselt die *Kopie*; was vorher unverschlüsselt auf `md1` stand, liegt dort weiter im Klartext, bis es überschrieben wird. `qm move-disk --delete 1` gibt den Platz frei, löscht ihn aber nicht. Waren echte Gastdaten drauf, gehört der freie Bereich anschließend überschrieben (`blkdiscard` auf einem SSD-Pool, sonst `dd if=/dev/zero` auf eine Fülldatei und wieder weg damit).

**Deshalb: vor den ersten echten Gastdaten machen.** Danach ist es keine Nachrüstung mehr, sondern eine Nachrüstung plus Aufräumen — und das Aufräumen vergisst man.

**Und die Sicherung mitdenken.** Eine Proxmox-Sicherung der verschlüsselten Platte ist ein Klumpen, den man ohne Schlüssel nicht öffnet. Gesichert wird aus der laufenden VM heraus (`pg_dump` plus Belege, eigenständig verschlüsselt, außer Haus) — steht so in [`21-inbetriebnahme.md`](21-inbetriebnahme.md) §9.
