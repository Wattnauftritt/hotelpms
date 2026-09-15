# Betriebshandbuch

Was zu tun ist, damit dieses System für **fremde** Betriebe tragbar ist. Für das Pilothaus im eigenen Haus ist manches davon Kür; sobald ein zahlender Kunde seine Gästedaten hier liegen hat, ist es Pflicht.

Dieses Dokument beschreibt den Betrieb, nicht den Entwurf. Warum die Dinge so gebaut sind, steht in [`10-systemarchitektur.md`](10-systemarchitektur.md) und den beiden Reviews.

---

> **Die Maschine steht noch nicht?** [`21-inbetriebnahme.md`](21-inbetriebnahme.md) führt von der leeren VM bis zum laufenden Betrieb. Dieses Dokument sagt, was danach gilt.

---

## 1. Plattenverschlüsselung (C3)

**Warum.** Die Datenbank enthält Namen, Anschriften, Geburtsdaten und Ausweisnummern. Ohne verschlüsselte Platte genügt der physische Zugriff auf den Proxmox-Host oder eine mitgenommene Sicherung, um alles zu lesen. Die Verschlüsselung der Ausweisnummer in der Anwendung schützt genau ein Feld; sie ersetzt das hier nicht.

**Wogegen genau.** Das entscheidet über den Preis, den die Verschlüsselung kosten darf. LUKS schützt einen einzigen Zustand: **Platte aus, oder Platte vom Rechner getrennt.** Also den ausgebauten Datenträger, die RMA-Rücksendung, den weiterverkauften Host, den Einbruch mit Blechmitnahme, das kopierte VM-Abbild. Gegen ein *laufendes* System schützt sie nicht — ist einmal entsperrt, liegt der Schlüssel im RAM, und wer Root hat, liest alles. Sie ist kein Schutz gegen Angreifer über das Netz, sondern gegen Hardware, die das Haus verlässt.

### Verschlüsselt wird der Host, nicht die VM

| Ebene | Was | Warum |
|---|---|---|
| **PVE-Wurzel** | unverschlüsselt | Dort liegen keine Gastdaten. Und der Host bleibt nach einem Stromausfall **immer** über Netz erreichbar, auch wenn das Entsperren scheitert — das ist der Unterschied zwischen „aus der Ferne zu reparieren" und „jemand muss hinfahren" |
| **Datenpool** (die VM-Platten) | LUKS, entsperrt über das **physische** TPM des Hosts | Das TPM sitzt auf der Hauptplatine und geht mit der ausgebauten Platte nicht mit |
| **VM** | **keine Verschlüsselung** | Ihre Platte liegt auf verschlüsseltem Speicher. Sie startet unbeaufsichtigt, ohne Sonderfall |

**Warum nicht LUKS in der VM — obwohl es naheliegt und hier einmal so stand.** Proxmox kann das physische TPM nicht an einen Gast durchreichen; es bietet nur `swtpm`, einen **Software-Emulator**. Dessen Zustand liegt als gewöhnliches Volume (`tpmstate0`) auf demselben Speicher wie die VM-Platte — Proxmox behandelt es wie die EFI-Disk. Wer die Platte kopiert, kopiert den Schlüssel mit, und die VM entsperrt sich beim Dieb von allein.

Das verletzt wörtlich die Regel aus C3: *der Schlüssel darf nicht auf demselben Datenträger liegen*. LUKS in der VM plus vTPM ist genau das, wovor die Regel warnt — unverschlüsselt mit Zusatzschritten.

Dazu ein zweiter Grund, der im Ernstfall zählt: Sicherungen von VMs mit TPM-Gerät bleiben hängen, und der übliche Behelf ist `backup=0` am `tpmstate0`. Dann fehlt der vTPM-Zustand in der Sicherung, und die **zurückgespielte VM entsperrt sich nie wieder**. Ein Bauteil, das die Wiederherstellung verhindert, hat in einem System mit acht Jahren Aufbewahrungsfrist nichts zu suchen.

### Entsperren ohne Menschen

**Eine Passphrase von Hand einzugeben ist keine Möglichkeit, sondern ein Ausfall mit Ansage.** Ein PMS läuft rund um die Uhr; eine Rezeption um drei Uhr nachts kann nicht warten, bis jemand wach wird. Und der häufige Fall ist nicht einmal der Absturz: `unattended-upgrades` will nach einem Kernel-Update neu starten. Bei manueller Passphrase heißt das entweder „startet nie neu und läuft ungepatcht" oder „jemand tippt nachts". Beides ist falsch.

Entsperrt wird deshalb über `clevis` mit einer **Eines-von-zweien-Regel**:

```bash
# 1 von 2 genuegt: das physische TPM ODER der Tang-Server.
clevis luks bind -d /dev/<datenplatte> sss '{"t":1,"pins":{
  "tpm2": {"pcr_ids":"7"},
  "tang": [{"url":"http://<tang-im-eigenen-netz>"}]
}}'
```

**PCR 7 und nicht 4, 8 oder 9.** PCR 7 ist der Secure-Boot-Zustand. Die anderen ändern sich bei jedem Kernel-Update — die Maschine startet dann nach einem Sicherheitspatch nicht mehr, und das ist dieselbe Ausfallfalle in Grün.

Der Datenpool wird **nach** dem Hochfahren entsperrt, nicht in der initramfs. Das ist der Grund für die unverschlüsselte Wurzel: scheitert das Entsperren, steht der Host trotzdem im Netz und lässt sich anmelden.

**Und eine Notfall-Passphrase**, in einem eigenen LUKS-Schlüsselfach, ausgedruckt im Tresor und im Passwortspeicher, erreichbar für **mindestens zwei** Personen. Nicht als Betriebsweg, sondern für den Tag, an dem Hauptplatine und Tang zusammen sterben. Ein Schlüssel, den nur ein Kopf kennt, ist kein Schlüssel, sondern ein Einzelausfallpunkt mit Menschenrechten.

**Das Entsperren ist nicht das eigentliche Problem.** „Kein Administrator ist wach" gilt genauso, wenn nachts die Platte vollläuft, der Nachtlauf hängt oder Caddy stirbt. Ein System für fremde Betriebe braucht Überwachung und einen Rufweg; die Verschlüsselung ist davon nur eine Spielart. Siehe §5.

**Prüfen.**

```bash
# Auf dem Host: der Datenpool ist verschluesselt
lsblk -o NAME,FSTYPE,MOUNTPOINT | grep crypt
cryptsetup status <geraet>
clevis luks list -d /dev/<datenplatte>     # zeigt die gebundenen Pins

# In der VM: hier darf KEIN crypt stehen
lsblk -o NAME,FSTYPE,MOUNTPOINT | grep crypt || echo 'richtig so'
```

**Die Probe, die zählt**, ist nicht `lsblk`, sondern: den Host **kalt neu starten** und nachsehen, ob die VM ohne Zutun wieder Gäste bedient. Mit Datum ins Protokoll, wie die Rückspielung.

### Wenn der Host kein TPM hat

Kommt bei gemieteter Hardware regelmaessig vor. Dann faellt der TPM-Pin weg, und der Tang-Pin traegt nur, wenn er auf einer **anderen** Maschine steht — auf demselben Blech liegt sein Schluessel auch auf denselben Platten. Schritt fuer Schritt, ohne die VM neu aufzusetzen: [`22-luks-nachruesten.md`](22-luks-nachruesten.md).

### Wenn LUKS schon in der VM steckt

Kommt vor — es stand bis hierher so in diesem Dokument. Neu installieren muss man deswegen **nicht**; die Host-Verschlüsselung ist eine Arbeit am Host und rührt die VM nicht an.

1. Auf dem Host einen **verschlüsselten Datenspeicher** anlegen und die VM-Platte dorthin schieben (`qm move-disk`). Ein bestehendes ZFS-Dataset lässt sich nicht nachträglich verschlüsseln — die Eigenschaft wird beim Anlegen gesetzt; es braucht also ein neues Ziel und einen Umzug.
2. Das LUKS **in** der VM kann bleiben. Es schadet nicht, und es trägt sogar eine Kleinigkeit bei: gegen einen laufenden, übernommenen Host schützt es die VM-Platte weiter. Damit es den unbeaufsichtigten Neustart nicht blockiert, wird es an den Tang-Server auf dem Host gebunden — ein `clevis luks bind`, kein Umbau.
3. Wer es sauber will, setzt die VM ohne LUKS neu auf, sobald der Host-Speicher verschlüsselt ist. Das lohnt, **solange noch keine echten Gastdaten daraufliegen** — dann kostet es eine Stunde nach Dokument 21 und spart eine Schicht, die sonst für immer mitläuft.

**Ein vTPM-Gerät an der VM wird in jedem Fall entfernt.** Es kostet die Sicherung (siehe oben) und kauft nichts.

---

## 2. Schlüsselrotation (C4)

**Warum.** An jedem verschlüsselten Feld steht eine Schlüsselversion. Ohne einen erprobten Weg, sie zu erhöhen, bleibt die erste Version für immer in Gebrauch, und das Feld trägt nie einen anderen Wert. Eine Rotation, die nicht erprobt ist, findet im Ernstfall nicht statt.

**Wann.** Planmäßig jährlich. Außerplanmäßig, sobald der Verdacht besteht, dass ein Schlüssel bekannt geworden ist, etwa nach dem Ausscheiden eines Administrators.

**Wie.** Beide Schlüssel müssen gleichzeitig bekannt sein: der alte zum Lesen, der neue zum Schreiben.

```bash
# 1. Trockenlauf. Schreibt nichts, nennt die Zahl der Datensätze.
DRY_RUN=true \
  ID_DOCUMENT_KEY_OLD="<alt>" ID_DOCUMENT_KEY="<neu>" \
  ID_DOCUMENT_KEY_VERSION=2 \
  pnpm --filter @hotelpms/api rotate-keys

# 2. Echter Lauf.
ID_DOCUMENT_KEY_OLD="<alt>" ID_DOCUMENT_KEY="<neu>" \
  ID_DOCUMENT_KEY_VERSION=2 \
  pnpm --filter @hotelpms/api rotate-keys

# 3. Erst wenn der Lauf "Verbleibend auf alter Version: 0" meldet:
#    ID_DOCUMENT_KEY in der EnvironmentFile auf den neuen Wert setzen,
#    Dienste neu starten, alten Schlüssel vernichten.
```

Der Lauf arbeitet in Stapeln, nicht in einer Transaktion. Zwischendurch ist der Bestand gemischt: manche Datensätze auf der alten Version, manche auf der neuen. Das ist ein **gültiger** Zustand, und genau dafür steht die Version an jedem einzelnen Datensatz.

Ein Datensatz, der sich mit dem alten Schlüssel nicht öffnen lässt, wird übersprungen und gemeldet, nicht verworfen. Er könnte mit einem noch älteren Schlüssel verschlüsselt sein.

**Den alten Schlüssel nicht vor Schritt 3 entfernen.** Ein Ablauf, der ihn vorher wegwirft, macht die Daten unlesbar, und das fällt erst auf, wenn jemand sie braucht.

---

## 3. Sicherung außer Haus

**Warum.** Eine Sicherung auf demselben Proxmox-Host überlebt einen Brand, einen Diebstahl und einen Verschlüsselungstrojaner nicht. Für fremde Kunden ist eine Sicherung außer Haus die Bedingung, unter der man ihre Daten überhaupt annehmen darf.

**Wie.**

```bash
# Täglich, verschlüsselt, an einen Ort außerhalb des Hauses.
pg_dump --format=custom --no-owner hotelpms \
  | age -r "$BACKUP_PUBKEY" \
  > "hotelpms-$(date +%F).dump.age"
```

Der öffentliche Schlüssel liegt auf dem Server, der private **nicht**. Sonst kann, wer den Server hat, auch die Sicherungen lesen.

**Aufbewahrung.** Täglich für 30 Tage, monatlich für 12 Monate. Die steuerliche Aufbewahrungspflicht von acht Jahren erfüllt das nicht und soll es nicht: dafür ist der laufende Bestand da, nicht die Sicherung.

**Die Rückspielung muss einmal durchgeführt und protokolliert sein.** Eine Sicherung, aus der noch nie zurückgespielt wurde, ist keine Sicherung, sondern eine Vermutung.

```bash
age -d -i ~/.backup-key "hotelpms-2026-09-13.dump.age" \
  | pg_restore --dbname=hotelpms_restore_test --no-owner
```

---

## 4. Ratenbegrenzung (C7)

**Zwei Linien, und die erste ist nicht die Anwendung.**

Die Anmeldung sperrt ein Konto nach zehn Fehlversuchen. Das hilft gegen den Angreifer, der ein Kennwort rät, aber nicht gegen den, der ein bekanntes Kennwort gegen **viele** Adressen probiert: jede Adresse bleibt unter ihrer eigenen Grenze.

| Linie | Ort | Wirkt |
|---|---|---|
| Erste | Caddy | vor der Anwendung, über alle Prozesse |
| Zweite | `apps/api/src/platform/rateLimit.ts` | im Prozess, auch ohne Caddy |

Die zweite Linie zählt im Arbeitsspeicher des Prozesses. Bei drei API-Prozessen ist die wirksame Grenze dreimal so hoch, und ein Neustart setzt sie zurück. Das ist bewusst so: eine geteilte Grenze bräuchte Redis oder eine Schreiboperation je Anfrage.

**In Caddy zu ergänzen:**

```caddyfile
# Erfordert das Modul caddy-ratelimit.
rate_limit {
    zone anmeldung {
        match { path /v1/auth/* }
        key    {remote_host}
        events 30
        window 5m
    }
}
```

---

## 5. Schulungsbetrieb (C11)

**Warum eine eigene Property und nicht ein Schalter.** Jedes Haus schult neue Mitarbeiter. Ohne einen dafür vorgesehenen Ort schult es auf den Produktivdaten, und dann stehen erfundene Reservierungen im echten Belegungsplan und erfundene Übernachtungen in der Beherbergungsstatistik, die an das Statistische Landesamt geht.

**Einrichten.**

```sql
UPDATE property SET is_training = true WHERE id = <id>;
```

**Was das Kennzeichen bewirkt:**

| Wirkung | Warum |
|---|---|
| Rechnungsnummern bekommen das Kürzel `UEBUNG-` | Eine Übungsrechnung muss man auch ausgedruckt auf dem Tresen erkennen |
| DATEV- und GoBD-Export werden abgewiesen | Ein Stapel aus Übungsdaten landet sonst in der echten Buchhaltung |
| Beherbergungsstatistik wird abgewiesen | Eine Meldung aus Übungsdaten ist eine falsche Meldung an eine Behörde |
| `isTraining` steht in `/v1/auth/me` | Die Oberfläche zeigt es dauerhaft an |

Die Absagen sind hart, keine Warnungen. Eine Warnung wird geklickt.

**Nicht vergessen:** Schulungshäuser gehören nicht in die Abrechnung. Wir berechnen je Zimmer und Monat; ein Übungshaus mit 250 Zimmern wäre sonst der teuerste Posten auf der Rechnung eines Kunden.

---

## 6. Ausscheidender Betrieb (E7)

**Warum das zum Produkt gehört und nicht zur Kulanz.** Ein Betrieb, der kündigt, muss seine Daten mitnehmen können. Das ist Art. 20 DSGVO für die personenbezogenen Teile, die steuerliche Aufbewahrungspflicht, die beim Betrieb bleibt und nicht bei uns, und schlicht Anstand: ein Anbieter, der Daten als Geisel hält, wird genau einmal empfohlen.

**Ablauf.**

1. **Export übergeben.** `GET /v1/properties/:id/exports/tenant` liefert alles zu dieser Property in JSON, ohne dieses System lesbar. Dazu die Rechnungen als Belege.
2. **Empfang bestätigen lassen.** Schriftlich, mit Datum. Ohne diese Bestätigung ist später strittig, ob übergeben wurde.
3. **Property stilllegen**, nicht löschen:

   ```sql
   UPDATE property SET status = 'archived' WHERE id = <id>;
   ```

   Ein `DELETE` ginge an den Fremdschlüsseln nicht durch, und es wäre auch falsch: solange die Aufbewahrungsfrist läuft, muss der Bestand lesbar bleiben.
4. **Nach Ablauf der Frist** den Mandanten endgültig entfernen. Acht Jahre für Buchungsbelege.

Was der Export **nicht** enthält und warum:

- **Ausweisnummern.** Sie liegen verschlüsselt vor. Ohne den Schlüssel wären sie nutzlos, mit dem Schlüssel wäre es eine Weitergabe des Schlüssels. Die Schlüsselversion ist vermerkt.
- **Meldescheine.** Sie unterliegen der Jahresfrist nach § 30 BMG und werden vernichtet, nicht weitergegeben.

---

## 7. Mailversand über Brevo

Gastpost — Rechnungen und Buchungsbestätigungen — geht über die **REST-API** von Brevo, nicht über SMTP. Der Endpunkt heißt `POST /v3/smtp/email` und meint trotzdem HTTP; das ist eine Eigenheit der Benennung. Der Unterschied ist keine Geschmacksfrage: über SMTP gäbe es keine Nachrichtenkennung, keinen verwertbaren Fehlercode und eine Verbindung, die der Worker offenhalten müsste.

### Einrichten

1. **Absender bei Brevo verifizieren.** Ohne verifizierten Absender weist der Anbieter jede Nachricht ab, und zwar mit 400 — also dauerhaft, ohne Wiederholung. Das ist der häufigste Fehler bei der Inbetriebnahme.
2. **SPF und DKIM für die Domäne setzen**, wie Brevo es vorgibt. Ohne beides landet die Rechnung im Spam-Ordner des Gastes, und das fällt niemandem auf — der Gast ruft nicht an, er wartet.
3. **`BREVO_API_KEY` in die Umgebung des Workers.** Nicht in die Datenbank: ein Schlüssel in einer Fachtabelle wandert in jede Sicherung und in jeden Mandantenexport.
4. **Absenderangaben je Haus setzen**, über `PUT /v1/properties/:id/email-settings` oder den Einrichtungsbildschirm. Erst `enabled: true` schaltet den Versand ein.

Ohne Schlüssel läuft der Worker unverändert weiter und meldet es einmal beim Start. Eingereihte Post bleibt stehen und geht hinaus, sobald der Schlüssel da ist — verloren ist nichts.

### Was der Betrieb wissen muss

**`sent` heißt angenommen, nicht zugestellt.** Der Status sagt, dass Brevo die Nachricht entgegengenommen hat. Ob sie im Postfach ankam, weiß nur Brevo; die `providerMessageId` im Postausgang ist der Schlüssel, mit dem sich eine Nachricht dort wiederfinden lässt. Rückmeldungen über Zustellung und Bounces holt das System **nicht** ab — das wäre ein eingehender Webhook und ist noch nicht gebaut.

**Ein Übungshaus verschickt nichts.** Der Versand lässt sich dort nicht einmal einschalten. Grund: Schulungsdaten tragen echte Adressen, weil jemand seine eigene einträgt, um zu sehen wie es aussieht.

**Eine unzustellbare Adresse hält das Haus nicht an.** Anders als ein Webhook-Abonnement wird nichts stillgelegt: die einzelne Nachricht scheitert, der Rest geht hinaus.

**Gastadressen im Postausgang altern.** Nach 90 Tagen entfernt der Pflegejob Empfänger und Anschreiben und behält den Nachweis — wann, welche Art, welcher Ausgang, welcher Fingerabdruck des Anhangs. Die Rechnung selbst liegt davon unberührt in `invoice_document` unter der achtjährigen Aufbewahrung.

### Wenn nichts ankommt

| Befund im Postausgang | Ursache |
|---|---|
| `pending`, Versuche 0, älter als ein paar Minuten | Kein `BREVO_API_KEY`, oder der Versand ist nicht eingeschaltet |
| `pending`, Versuche 0, Rechnungsmail | Der Beleg ist noch nicht erzeugt. Die Mail wartet darauf, absichtlich |
| `failed` nach **einem** Versuch, Fehler 400 | Adresse abgelehnt oder Absender nicht verifiziert. Kein Wiederholungsfall |
| `failed` nach fünf Versuchen | Anbieter war dauerhaft nicht erreichbar |
| `sent`, Gast sagt nichts bekommen | Mit der `providerMessageId` im Protokoll bei Brevo nachsehen. Meist SPF/DKIM |

---

## 8. Was regelmäßig zu prüfen ist

| Wann | Was |
|---|---|
| Täglich | Protokoll auf `ALARM:` durchsehen. Der Worker meldet so einen ausgefallenen Nachtlauf und abweichende Bestandszähler |
| Täglich | Sicherung ist gelaufen und hat eine plausible Größe |
| Monatlich | Beherbergungsstatistik je Haus gemeldet |
| Vierteljährlich | Rückspielung aus der Sicherung, protokolliert |
| Jährlich | Schlüsselrotation |
| Bei Personalwechsel | Sitzungen des Ausgeschiedenen zurückziehen, Rollen entziehen, außerplanmäßige Rotation erwägen |

Der wichtigste Eintrag ist der erste. Der schlimmste Ausfall ist der stille: läuft der Nachtlauf nicht, bucht die Rezeption weiter, nur die Logis fehlt auf den Folios, und bemerkt wird es vom Gast beim Check-out.
