# Verzeichnis von Verarbeitungstätigkeiten

nach **Art. 30 Abs. 2 DSGVO** — für den Auftragsverarbeiter.

> **Was hier auszufüllen ist.** Die Felder in `⟨spitzen Klammern⟩` kennt nur
> der Betreiber. Alles übrige ist aus dem Quelltext erhoben und gilt für jede
> Installation dieses Systems. Stand: Schemastand 46 Migrationen.

---

## 1. Auftragsverarbeiter

| | |
|---|---|
| Name | ⟨Firmierung⟩ |
| Anschrift | ⟨Anschrift⟩ |
| Vertreter | ⟨Geschäftsführung⟩ |
| Datenschutzbeauftragter | ⟨Name und Kontakt, oder: nicht benannt, weil Art. 37 nicht greift⟩ |

## 2. Verantwortliche

Jeder Beherbergungsbetrieb, der das System einsetzt, ist eigener
Verantwortlicher. Die Liste führt der Betreiber; im System entspricht sie der
Tabelle `account`.

## 3. Kategorien von Verarbeitungen im Auftrag

| Nr. | Verarbeitung | Zweck des Verantwortlichen |
|---|---|---|
| 1 | Reservierung und Aufenthalt | Abwicklung des Beherbergungsvertrags |
| 2 | Abrechnung und Rechnungsstellung | § 14 UStG, § 147 AO, § 257 HGB |
| 3 | Meldewesen | § 29 ff. BMG |
| 4 | Beherbergungsstatistik | BStatG in Verbindung mit dem Landesrecht |
| 5 | Gastpost | Vertragsanbahnung und -abwicklung |
| 6 | Zahlungsabwicklung | Erfüllung des Vertrags |
| 7 | Benutzer- und Rechteverwaltung des Betriebs | Organisation des Verantwortlichen |
| 8 | Protokollierung | Art. 32 Abs. 1 lit. b, Nachweisbarkeit |
| 9 | Digitale Gästemappe | Erfüllung des Vertrags: Hausinfos, später Wünsche und Reinigungsverzicht des laufenden Aufenthalts |
| 10 | Support-Anfragen (Tickets) | Unterstützung des Verantwortlichen beim Betrieb der Software (Migration 0208) |

## 4. Kategorien betroffener Personen und Daten

**Gäste.** Name, Anschrift, Geburtsdatum, Staatsangehörigkeit, Kontaktdaten,
Sprache, Aufenthaltsdaten, Rechnungsdaten, Meldedaten, Ausweisart und
-nummer, Unterschrift bei ausländischen Gästen, Hausnotizen.

**Mitreisende.** Zuordnung zur Reservierung und Alter bei Anreise.

**Gäste in der digitalen Gästemappe.** Die Freischaltung eines Telefons
(`guest_folder_session`, Migration 0147): Zuordnung zur Reservierung, Weg
(Zimmerkarte oder Mail-Link), Zeitpunkt und Abreisetag. Gespeichert wird nur
der Hash des Cookies, nie Nachname oder PLZ, mit denen der Gast bestätigt;
beide werden nur verglichen. Die Seite zeigt nach der Freischaltung nur den
Abreisetag. Fehlversuche zählen je Zimmer und je Herkunft; für die Herkunft
steht nur der SHA-256 der IP-Adresse da (pseudonym, Migration 0186), und
beide Zähler löscht der Worker einen Tag nach dem letzten Fehlversuch.
Wünsche aus der Mappe (`guest_request`, Migration 0149): Eintrag aus dem
Katalog des Hauses, Menge, gewünschter Tag, Stand. Sie hängen an der
Reservierung und werden mit deren Gast anonymisiert; ein angenommenes Extra
mit Preis ist eine Buchung und bleibt wie jede andere. Seit Migration 0153
kann ein Wunsch eine **freie Nachricht** an die Rezeption sein (höchstens 500
Zeichen, nur wenn das Haus sie einschaltet). Ihr Text ist Freitext und kann
alles enthalten; er steht nicht im Protokoll und wird gelöscht, siehe
Löschfristen.

**Beschäftigte des Betriebs.** Name, dienstliche E-Mail, Rolle, Zeitpunkt der
letzten Anmeldung, Authentifizierungsmerkmale.

**Sicherheitsereignisse** (`security_event`, Migration 0209). Bei einer
kritischen Handlung — Bankverbindung, Zahlungskonto, Maschinenzugang,
Webhook, Kanalzugang, Leitungsrolle, Support-Freigabe, Datenexport — und bei
einem falschen Kennwort in einer gültigen Sitzung: wer, wann, welche
Handlung, **die ungekürzte IP-Adresse** und gekürzte Angaben (etwa die
letzten vier Stellen einer IBAN), nie ein Gastname. Rechtsgrundlage ist
Art. 6 Abs. 1 lit. f DSGVO in Verbindung mit Art. 32: das berechtigte
Interesse, einen Missbrauch zu erkennen, zu belegen und zur Anzeige zu
bringen; eine gekürzte Adresse taugt dafür nicht (Entscheidung Sven Rotermundt,
23.10.2026). Die Leitung des Betriebs sieht die Ereignisse unter
„Benutzer" und bekommt je Ereignis einen Hinweis per Mail, ohne Link. Fristen
siehe Löschfristen.

**Support-Anfragen.** Verfasser, Haus, Betreff, Text und angehängte Bilder
oder PDFs einer Anfrage an den StayGrid-Support, dazu die Antworten. Das
Formular bittet ausdrücklich, keine Gast- und Kartendaten hineinzuschreiben;
ein Bildschirmfoto kann sie trotzdem zeigen. Deshalb: Zeilenrichtlinie je
Account, keine Werte im Protokoll (`audit_redaction`), keine Inhalte in Mails,
Löschung 24 Monate nach dem Schließen.

**Ansprechpartner von Firmenkunden.** Firmenname, Anschrift, USt-IdNr.,
Rechnungsadresse.

> **Besondere Kategorien nach Art. 9 sind nicht vorgesehen.** Es gibt kein
> Feld dafür. Die Freitextfelder `guest_property_note.note` und
> `reservation.notes` können sie faktisch aufnehmen; beide tragen einen
> Hinweis, und beide sind von der Protokollierung ausgenommen
> (`audit_redaction`, Migration 0044). Dass der Betrieb sie so führt, ist Teil
> der Weisung nach Art. 29 und gehört in die Einweisung der Rezeption.

> **Offenlegung am Gästeterminal.** Bietet ein Haus die Selbstbedienung am
> Touchscreen der Rezeption an (Dokument 31, §14), zeigt das Terminal jedem,
> der davor steht, die Nummern belegter Zimmer und nach einem Tipp den
> Nachnamen des Hauptgastes („Sind Sie Herr/Frau …?“). Kein Vorname, keine
> Daten, keine Anschrift. Die Rückfrage schützt vor einem vertippten Zimmer;
> dass der Nachname dabei in der Halle steht, hat der Betrieb so entschieden
> (Sven, 12.10.2026). Ab der vierten Rückfrage in einer Minute, mit oder
> ohne „Ja“, und nach drei „Ja“ in fünf Minuten macht das Gerät eine Pause,
> damit niemand die Namen aller Zimmer abliest (Audit 19.10., M5).

## 5. Empfänger

| Empfänger | Rolle | Übermittelte Daten | Ort |
|---|---|---|---|
| ⟨Hoster⟩ | Unterauftragsverarbeiter | alle, im Rahmen des Betriebs | ⟨Land⟩ |
| Stripe | Unterauftragsverarbeiter | **nur** Belegnummer, Betrag, Währung — kein Name, keine Anschrift | Irland / USA, Angemessenheitsbeschluss bzw. SCC |
| plusserver GmbH (S3 Storage, Köln) | Unterauftragsverarbeiter | Sicherung (Dokument 37): alle Daten, **vor** dem Hochladen verschlüsselt, der Anbieter sieht keinen Klartext | Deutschland |
| netcup | Unterauftragsverarbeiter | zweites Sicherungsziel (Dokument 37): alle Daten, mit `age` verschlüsselt, Schlüssel nicht beim Anbieter | Deutschland |
| Brevo | Unterauftragsverarbeiter | Empfängeradresse, Name, Nachrichtentext | Frankreich |
| DeepL | Unterauftragsverarbeiter | freie Texte des Personals aus der Personal-App (Tätigkeit, Zimmerproblem, Notiz der Hausdame) und die Hausseiten der Gästemappe (Migration 0144) — **keine** Gastdaten, kein Name des Personals; nur mit Pro-Vertrag | Deutschland |
| Push-Dienste der Browserhersteller (Google, Apple, Mozilla, Microsoft) | Übermittlungsweg, keine Verarbeitung im Auftrag: der Inhalt ist Ende-zu-Ende verschlüsselt | Geräteadresse des Telefons; Inhalt (Zimmernummer oder Datum) nur verschlüsselt — **keine** Gastdaten | je nach Hersteller, USA mit Angemessenheitsbeschluss |
| Channel Manager ⟨Anbieter⟩ | eigenständig | Preise, Verfügbarkeit, Restriktionen, beim Abholen von Buchungen die Kennung der Revision — **keine** Gastdaten. Buchungen mit Gastdaten kommen von dort herein (Kanaladapter, Migration 0198); die Zugangsdaten des Hauses beim Anbieter liegen verschlüsselt | ⟨Land⟩ |
| Meldebehörde | gesetzlich | Meldedaten | Deutschland |
| Statistisches Landesamt | gesetzlich | aggregiert nach Wohnsitzland; das System **erzeugt** den Satz, übermittelt wird er außerhalb über eSTATISTIK.core | Deutschland |

Kartendaten werden nirgends gespeichert und nirgends entgegengenommen. Es gibt
kein Feld dafür.

## 6. Drittlandübermittlung

Nur über Stripe, soweit dort Verarbeitung außerhalb der EU stattfindet.
Grundlage: ⟨Angemessenheitsbeschluss EU-US Data Privacy Framework bzw.
Standardvertragsklauseln — nach tatsächlicher Vertragslage eintragen⟩.
Übermittelt werden Belegnummer und Betrag, keine Gastdaten.

## 7. Löschfristen

| Bestand | Frist | Wodurch umgesetzt |
|---|---|---|
| Meldeschein | ⟨ein Jahr, nach Landesrecht⟩ | `registration.destroy_after`, Job `purgeRegistrations` |
| Ausweisnummer | nach Abreise | `guest_document_purge()` |
| Gästebeitragsnachweis | ⟨nach kommunaler Satzung⟩ | `property.guest_levy_retention_years` |
| Rechnungen und Belege | zehn Jahre | keine Löschung, Aufbewahrungspflicht |
| Gastprofil | auf Verlangen, sobald keine Frist entgegensteht | `guest_erase_one()`, `guest_erasure_complete()` |
| Gastpost | 90 Tage, bei Löschverlangen sofort; bei versandten Rechnungen bleiben Empfänger und Betreff als Versandnachweis sechs Jahre (§ 257 HGB, § 147 AO, Migration 0170) | `email_redact_old()`, `guest_erase_one()` |
| Sitzungen und Einmaltoken | 7 Tage nach Ablauf | `purgeExpired()` |
| Freischaltungen der Gästemappe | 7 Tage nach dem Abreisetag, bei Löschverlangen sofort | `purgeExpired()`, `guest_erase_one()`, `guest_erase_partial()` |
| Text einer Nachricht aus der Gästemappe | 30 Tage nach der Abreise, bei Löschverlangen sofort | `purgeExpired()`, `guest_erase_one()`, `guest_erase_partial()` |
| Idempotenzschlüssel | 24 Stunden | `purgeExpired()` |
| Support-Anfragen samt Anhängen | 24 Monate nach dem Schließen | `purgeRetention()` (Worker) |
| Protokoll | zehn Jahre | `audit_log_drop_old_partitions()` |
| Sicherheitsereignis: IP-Adresse | 180 Tage voll, danach auf das Netz gekürzt (/24, /48) | `security_event_prune()` im Job `purgeExpired` |
| Sicherheitsereignis | zwei Jahre | `security_event_prune()` |

## 8. Technische und organisatorische Maßnahmen

Siehe [`tom.md`](tom.md).
