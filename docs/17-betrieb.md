# Betriebshandbuch

Was zu tun ist, damit dieses System für **fremde** Betriebe tragbar ist. Für das Pilothaus im eigenen Haus ist manches davon Kür; sobald ein zahlender Kunde seine Gästedaten hier liegen hat, ist es Pflicht.

Dieses Dokument beschreibt den Betrieb, nicht den Entwurf. Warum die Dinge so gebaut sind, steht in [`10-systemarchitektur.md`](10-systemarchitektur.md) und den beiden Reviews.

---

## 1. Plattenverschlüsselung (C3)

**Warum.** Die Datenbank enthält Namen, Anschriften, Geburtsdaten und Ausweisnummern. Ohne verschlüsselte Platte genügt der physische Zugriff auf den Proxmox-Host oder eine mitgenommene Sicherung, um alles zu lesen. Die Verschlüsselung der Ausweisnummer in der Anwendung schützt genau ein Feld; sie ersetzt das hier nicht.

**Wie.** LUKS auf dem Datenträger der VM, eingerichtet bei der Installation. Nachträglich geht es nur über Neuanlage und Rückspielung.

Die Passphrase liegt **nicht** auf dem Host. Beim Neustart wird sie eingegeben, oder über `clevis` gegen einen TPM gebunden. Ein automatisch entschlüsselndes System, dessen Schlüssel daneben liegt, ist unverschlüsselt mit Zusatzschritten.

**Prüfen.**

```bash
lsblk -o NAME,FSTYPE,MOUNTPOINT | grep crypt
cryptsetup status <gerät>
```

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

## 7. Was regelmäßig zu prüfen ist

| Wann | Was |
|---|---|
| Täglich | Protokoll auf `ALARM:` durchsehen. Der Worker meldet so einen ausgefallenen Nachtlauf und abweichende Bestandszähler |
| Täglich | Sicherung ist gelaufen und hat eine plausible Größe |
| Monatlich | Beherbergungsstatistik je Haus gemeldet |
| Vierteljährlich | Rückspielung aus der Sicherung, protokolliert |
| Jährlich | Schlüsselrotation |
| Bei Personalwechsel | Sitzungen des Ausgeschiedenen zurückziehen, Rollen entziehen, außerplanmäßige Rotation erwägen |

Der wichtigste Eintrag ist der erste. Der schlimmste Ausfall ist der stille: läuft der Nachtlauf nicht, bucht die Rezeption weiter, nur die Logis fehlt auf den Folios, und bemerkt wird es vom Gast beim Check-out.
