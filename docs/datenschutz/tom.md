# Technische und organisatorische Maßnahmen

nach **Art. 32 DSGVO**. Anlage zum Auftragsverarbeitungsvertrag.

> Dieses Dokument beschreibt, was im System **tatsächlich umgesetzt** ist,
> und benennt die Stelle im Quelltext. Wo eine Maßnahme vom Betrieb der
> Maschine abhängt und nicht vom Code, steht sie in `⟨spitzen Klammern⟩` und
> ist vom Betreiber auszufüllen. Ein TOM-Papier, das mehr verspricht als die
> Software hält, ist schlimmer als keines: es wird beim ersten Vorfall
> gelesen.

---

## 1. Vertraulichkeit

### 1.1 Zutrittskontrolle
⟨Rechenzentrum, Zutrittsregelung — vom Hoster beizubringen⟩

### 1.2 Zugangskontrolle

- Anmeldung mit E-Mail und Kennwort; Kennworthash mit **Argon2id**.
- Sperre nach mehreren Fehlversuchen (`failed_login_count`, `locked_until`).
- Sitzung im Cookie mit `httpOnly`, `sameSite=lax` und `secure` im Betrieb;
  absolute Laufzeit begrenzt, abgelaufene Sitzungen werden entfernt.
- Arbeitsplatzwechsel am geteilten Rezeptionsrechner über einen eigenen PIN;
  im Protokoll steht, wer tatsächlich gehandelt hat.
- Maschinenzugänge über OAuth 2.0 Client Credentials mit begrenzten
  Zugriffsbereichen; das Geheimnis wird genau einmal ausgegeben.

### 1.3 Zugriffskontrolle

- **Rollen und Rechte je Haus.** Jede Route trägt eine Pflichtberechtigung;
  einen anderen Weg, eine Route anzulegen, gibt es nicht, und ein Test läuft
  über die gesamte Routenliste.
- **Mandantentrennung in der Datenbank**, nicht nur in der Anwendung:
  Zeilenrichtlinien mit `FORCE ROW LEVEL SECURITY`. Der Kontext wird
  transaktionslokal gesetzt und stammt aus dem Token, nie aus Pfad, Query oder
  Rumpf.
- **Die Anwendungsrolle ist nicht Eigentümerin** des Schemas. Auf `charge`,
  `settlement`, `invoice` und `audit_log` hat sie kein `UPDATE` und kein
  `DELETE`; eine Korrektur ist eine Gegenbuchung.
- **Support sieht nichts ohne Freigabe.** Plattformpersonal hat einen leeren
  Mandantenkontext. Eine Support-Sitzung wird mit Anlass angefragt, vom Kunden
  befristet freigegeben und ist in jedem Protokolleintrag vermerkt.

### 1.4 Trennungskontrolle

Ein Mandant je `account`, durchgesetzt über Zeilenrichtlinien. Bei mehreren
Häusern in einem Account prüft die Anwendung zusätzlich die `property_id` —
die Richtlinie filtert nach Mandant, nicht nach Haus.

### 1.5 Pseudonymisierung und Verschlüsselung

- **Ausweisnummer** nach § 30 BMG: **AES-256-GCM** mit Schlüsselversion, der
  Schlüssel aus der Umgebung und nicht aus der Datenbank. Ein Werkzeug zur
  Rotation liegt bei (`rotate-keys.ts`). **Jeder Abruf wird protokolliert** —
  im Protokoll steht die Tatsache des Zugriffs, nicht der Wert.
- **Eine Ausweiskopie kann nicht gespeichert werden.** Es gibt kein Feld dafür.
- **Kartendaten werden nie entgegengenommen.** Es gibt kein Feld dafür; eine
  Garantie läuft über Pay-by-Link oder das virtuelle Terminal des
  Zahlungsdienstleisters.
- Transportverschlüsselung ⟨TLS-Konfiguration, siehe `ops/`⟩.
- Verschlüsselung der Datenträger ⟨siehe `docs/22-luks-nachruesten.md`⟩.

## 2. Integrität

### 2.1 Eingabekontrolle

Ein Audit-Trigger in der Datenbank protokolliert jede Änderung an den
fachlich tragenden Tabellen: wer, wann, welche Tabelle, welche Zeile, welche
Felder. **In der Datenbank und nicht in der Anwendung** — was in der
Anwendung liegt, wird irgendwann an einer Stelle vergessen.

Das Protokoll hält **welches Feld** sich geändert hat, nicht seinen Wert,
soweit das Feld personenbezogen ist oder ein Geheimnis trägt
(`audit_redaction`, Migration 0043). Der Grund steht in
[`../24-dsgvo-audit.md`](../24-dsgvo-audit.md), Befund 1: sonst schriebe die
Löschung ihre eigene, unlöschbare Kopie.

### 2.2 Weitergabekontrolle

Ausgehende Ereignisse werden mit **HMAC-SHA256** über Zeitstempel und Rumpf
signiert. Ziele müssen `https://` sein. Ein Schulungshaus (`is_training`)
weist jeden Export nach draußen und jeden Versand hart ab.

## 3. Verfügbarkeit und Belastbarkeit

⟨Sicherungskonzept, Wiederherstellungszeiten, Prüfung der Wiederherstellung —
vom Betreiber einzutragen; siehe `docs/17-betrieb.md`⟩

## 4. Verfahren zur Überprüfung

- Typprüfung, Lint, Test und Bau laufen in CI; alle vier müssen grün sein.
- Die Tests laufen gegen ein **echtes PostgreSQL**, nicht gegen eine
  Nachbildung: Zeilenrichtlinien, Trigger und Rechte sind sonst unsichtbar.
- Die Befunde des Datenschutz-Audits sind als Regressionstests festgehalten
  (`packages/db/src/__tests__/dsgvo.test.ts`).
- ⟨Wiederkehrende Überprüfung: Rhythmus und Verantwortlicher⟩

## 5. Auftragskontrolle

- Weisungen des Verantwortlichen ⟨Form und Empfänger im AVV⟩.
- Unterauftragsverarbeiter siehe
  [`verarbeitungsverzeichnis.md`](verarbeitungsverzeichnis.md), Abschnitt 5.
- Beschäftigte auf Vertraulichkeit verpflichtet ⟨Nachweis beim Betreiber⟩.

## 6. Betroffenenrechte

| Recht | Umsetzung |
|---|---|
| Auskunft (Art. 15) | ein Endpunkt, der alles zusammenträgt — Profil, Aufenthalte, Rechnungen, Hausnotizen, Meldescheine, Gastpost, Einwilligungen, dazu die Angaben nach lit. a bis h |
| Berichtigung (Art. 16) | über die Gästemaske |
| Löschung (Art. 17) | `guest_erase_one()`; wo eine Frist entgegensteht, wird sie vorgemerkt und im Nachtlauf vollendet |
| Einschränkung (Art. 18) | `guest.status = 'blocked'` |
| Datenübertragbarkeit (Art. 20) | die Auskunft nach Art. 15 in maschinenlesbarer Form |
| Widerspruch (Art. 21) | ⟨Verfahren beim Verantwortlichen⟩ |

Die Frist von einem Monat scheitert damit nicht an Handarbeit — das war der
Grund, die Auskunft als **einen** Aufruf zu bauen und nicht als Anleitung.
