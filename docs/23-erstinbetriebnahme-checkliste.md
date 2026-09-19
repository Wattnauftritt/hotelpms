# Erstinbetriebnahme: was jetzt zu tun ist

Für den Agenten, der die VM betreut. **Einmalig**, in dieser Reihenfolge, mit einem Halt nach jedem Abschnitt.

Dies ist keine zweite Anleitung neben [`21-inbetriebnahme.md`](21-inbetriebnahme.md), sondern die Reihenfolge für *diesen* Stand: die Maschine steht, aber der Ausrollweg, der Mailversand und der erste Zugang fehlen noch. Was ein Schritt im Einzelnen tut, steht dort — hier steht, was zu tun ist und woran man merkt, dass es getan ist.

> **Reihenfolge ist nicht Geschmack.** Schritt 3 braucht den Tag aus Schritt 2, Schritt 5 braucht den Benutzer aus Schritt 4, und Schritt 6 braucht alles davor. Wer vorgreift, bekommt Fehler, deren Ursache zwei Schritte zurückliegt.

---

## 0. Vorher wissen

Die Maschine trägt heute vermutlich noch die **alte Ablage**: `/opt/hotelpms/current` ist ein Arbeitsverzeichnis mit `.git`. Ab jetzt ist es ein **Symlink** auf `releases/<sha>`. Der Umstieg ist Schritt 3 und geht ohne Neuinstallation.

```bash
ls -ld /opt/hotelpms/current      # Symlink oder Verzeichnis?
```

Ist es schon ein Symlink, ist Schritt 3 erledigt — weiter mit 4.

---

## 1. Umgebungsdatei ergänzen

`/opt/hotelpms/shared/env`, Rechte `600`. Zwei Werte fehlen, und **beide fallen still aus**: ohne sie geht keine Einladung und keine Support-Anfrage hinaus, und niemand bekommt eine Fehlermeldung.

```
PLATFORM_EMAIL_FROM=mail@staygrid.cloud
PLATFORM_EMAIL_FROM_NAME=StayGrid
PUBLIC_APP_URL=https://<der-echte-name>
```

Die Absenderadresse muss **bei Brevo verifiziert** sein. Ist sie es nicht, weist der Anbieter jede Nachricht mit 400 ab — dauerhaft, ohne Wiederholung. Das ist der häufigste Fehler bei der Inbetriebnahme.

`PUBLIC_APP_URL` ist die Wurzel der Links in Einladung und Kennwortrücksetzung. Steht sie falsch, zeigen die Links ins Leere, und der eingeladene Kunde meldet sich bei euch statt sich anzumelden.

**Fertig, wenn:** `grep -c PLATFORM_EMAIL_FROM /opt/hotelpms/shared/env` → `1`, und die Adresse im Brevo-Konto als verifiziert erscheint.

---

## 2. Den Tag `produktion` setzen

Ausgerollt wird **nur**, was mit diesem Tag markiert ist — nie einfach `main`. Ohne ihn bricht der erste Ausrollversuch mit einem Git-Fehler ab.

**Am einfachsten über GitHub:** Actions → *Für die Produktion freigeben* → **Run workflow**. Das Feld steht schon auf `main`, bestätigen genügt. Der Workflow weist einen Stand ab, der nicht grün durch CI ist — du kannst dabei also nichts Unfertiges erwischen.

Von Hand, wo Git offen ist:

```bash
git tag -f produktion <commit>
git push -f origin produktion
```

**Fertig, wenn:** `git ls-remote --tags origin produktion` eine Zeile liefert.

---

## 3. Umstieg auf die Release-Ablage

Der Grund steht in [`21-inbetriebnahme.md`](21-inbetriebnahme.md) §8: bisher wurde in dem Verzeichnis gebaut, aus dem die Dienste laufen. Scheitert ein Bau, bleibt ein halber Stand liegen, und das fällt erst beim nächsten Neustart der Maschine auf.

```bash
systemctl stop hotelpms-api hotelpms-worker
cd /opt/hotelpms
mkdir -p releases shared
git clone --bare https://github.com/Wattnauftritt/hotelpms.git shared/repo
git -C shared/repo remote add origin https://github.com/Wattnauftritt/hotelpms.git

mv current current.alt
./current.alt/ops/deploy/deploy.sh deploy produktion
```

Das Skript baut nach `releases/<sha>`, setzt `current` als Symlink, migriert, startet die Dienste und prüft die Gesundheit. **Erst wenn die Prüfung `{"status":"ok"}` ausgibt:**

```bash
rm -rf /opt/hotelpms/current.alt
```

**Fertig, wenn:** `ls -ld /opt/hotelpms/current` einen Symlink zeigt und `curl -fsS --unix-socket /run/hotelpms/api.sock http://localhost/health` antwortet.

**Geht schief, wenn** `shared/env` nicht liest — das Skript lädt sie; steht sie woanders, bricht es sofort ab. Nicht weitermachen, sondern den Pfad richten.

---

## 4. Den ersten Plattformbenutzer anlegen

Ohne ihn kann niemand einen Kunden anlegen oder ausrollen — und ihn über die Oberfläche anzulegen geht nicht, weil man dafür angemeldet sein müsste.

```bash
cd /opt/hotelpms/current
PLATTFORM_EMAIL=betrieb@staygrid.cloud \
PLATTFORM_PASSWORD='<mindestens zwölf Zeichen>' \
  pnpm db:plattformbenutzer
```

Ohne `PLATTFORM_PASSWORD` erzeugt das Skript eines und gibt es **einmal** aus. Dann notieren.

Das Skript **erhöht keinen vorhandenen Benutzer**. Gibt es die Adresse schon, weist es ab — das wäre der Weg, auf dem ein Kundenzugang unbemerkt zu einem Plattformzugang wird.

**Fertig, wenn:** die Anmeldung unter `https://<name>` klappt und die Oberfläche das **Adminpanel** zeigt (nicht ein Haus). Das ist richtig so: Plattformpersonal ohne freigegebene Support-Sitzung hat einen leeren Mandantenkontext und sieht keine Kundendaten.

Weitere Zugänge legst du danach **im Panel** an, Reiter *Plattformbenutzer* — das Skript hier braucht es nur für den ersten. Es erhöht auch bewusst keinen vorhandenen Benutzer; wer eine vergebene Adresse eingibt, wird abgewiesen.

---

## 5. Den Ausrollmechanismus aktivieren

```bash
install -m 0644 /opt/hotelpms/current/ops/systemd/hotelpms-deploy.{service,timer} \
        /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hotelpms-deploy.timer
```

Prüfen, dass die sudo-Regel steht — der Dienst braucht genau die beiden Neustarts:

```bash
install -m 0440 /opt/hotelpms/current/ops/deploy/hotelpms.sudoers /etc/sudoers.d/hotelpms
visudo -c
```

**Fertig, wenn:** `systemctl list-timers hotelpms-deploy.timer` eine nächste Auslösung zeigt.

**Die Probe:** im Adminpanel unter *Betrieb* „Jetzt ausrollen" drücken. Binnen einer Minute muss die Zeile auf „Läuft" und dann auf „Durch" springen. Bleibt sie auf „Wartet", läuft der Timer nicht — `journalctl -u hotelpms-deploy -n 50`.

---

## 6. Den ersten Kunden anlegen

Über die Konsole oder direkt:

```
POST /v1/platform/accounts
{ "accountName": …, "code": …, "name": …,
  "addressLine1": …, "postalCode": …, "city": …, "taxNumber": …,
  "userEmail": …, "userName": … }
```

Anschrift und Steuernummer sind **Pflicht**: ohne sie darf das Haus nach § 14 UStG keine Rechnung ausstellen, und die Lücke fiele sonst erst beim ersten Check-out auf.

Der Kunde bekommt eine Einladung. Sie ist zugleich die Probe auf Schritt 1: kommt sie nicht an, stimmt etwas am Mailversand.

**Fertig, wenn:** der Kunde über den Link in der Mail sein Kennwort setzt und sich anmeldet.

**Kommt keine Mail:** `SELECT status, attempts, last_error FROM platform_email ORDER BY id DESC LIMIT 5;`

| Befund | Ursache |
|---|---|
| `pending`, Versuche 0 | Kein `BREVO_API_KEY` oder kein `PLATFORM_EMAIL_FROM` |
| `failed` nach **einem** Versuch, 400 | Absender nicht verifiziert |
| `sent`, aber nichts angekommen | SPF/DKIM. Der Empfänger wartet und ruft nicht an |

---

## 7. Kein Testhotel auf dieser Maschine

`pnpm db:testhotel` gehört auf einen Entwicklungsrechner, nicht hierher. Es legt ein Übungshaus mit erfundenen Gästen an; das hat in derselben Datenbank wie echte Kundendaten nichts zu suchen — auch wenn es als Übungshaus nichts exportiert.

Wer das System ausprobieren will, tut das lokal ([`../CLAUDE.md`](../CLAUDE.md), Abschnitt „Ausprobieren").

---

## Was danach noch offen ist

**Die Plattenverschlüsselung.** Sie braucht einen Tang-Server auf **fremdem Blech** — auf demselben Host nützt er nichts, weil der Schlüssel dann neben den Daten liegt. Ein kleiner VPS bei einem anderen Anbieter genügt. Die Anleitung steht in [`22-luks-nachruesten.md`](22-luks-nachruesten.md) und geht ohne Neuinstallation.

**Sie gehört vor die ersten echten Gastdaten.** Danach ist es keine Nachrüstung mehr, sondern eine Nachrüstung plus Aufräumen des freien Platzes — und das Aufräumen vergisst man.
