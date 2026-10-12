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
Abreisetag. Fehlversuche zählen je Zimmer, ohne Bezug zu einer Person.
Wünsche aus der Mappe (`guest_request`, Migration 0149): Eintrag aus dem
Katalog des Hauses, Menge, gewünschter Tag, Stand — kein Freitext. Sie
hängen an der Reservierung und werden mit deren Gast anonymisiert; ein
angenommenes Extra mit Preis ist eine Buchung und bleibt wie jede andere.

**Beschäftigte des Betriebs.** Name, dienstliche E-Mail, Rolle, Zeitpunkt der
letzten Anmeldung, Authentifizierungsmerkmale.

**Ansprechpartner von Firmenkunden.** Firmenname, Anschrift, USt-IdNr.,
Rechnungsadresse.

> **Besondere Kategorien nach Art. 9 sind nicht vorgesehen.** Es gibt kein
> Feld dafür. Die Freitextfelder `guest_property_note.note` und
> `reservation.notes` können sie faktisch aufnehmen; beide tragen einen
> Hinweis, und beide sind von der Protokollierung ausgenommen
> (`audit_redaction`, Migration 0044). Dass der Betrieb sie so führt, ist Teil
> der Weisung nach Art. 29 und gehört in die Einweisung der Rezeption.

## 5. Empfänger

| Empfänger | Rolle | Übermittelte Daten | Ort |
|---|---|---|---|
| ⟨Hoster⟩ | Unterauftragsverarbeiter | alle, im Rahmen des Betriebs | ⟨Land⟩ |
| Stripe | Unterauftragsverarbeiter | **nur** Belegnummer, Betrag, Währung — kein Name, keine Anschrift | Irland / USA, Angemessenheitsbeschluss bzw. SCC |
| Brevo | Unterauftragsverarbeiter | Empfängeradresse, Name, Nachrichtentext | Frankreich |
| DeepL | Unterauftragsverarbeiter | freie Texte des Personals aus der Personal-App (Tätigkeit, Zimmerproblem, Notiz der Hausdame) und die Hausseiten der Gästemappe (Migration 0144) — **keine** Gastdaten, kein Name des Personals; nur mit Pro-Vertrag | Deutschland |
| Push-Dienste der Browserhersteller (Google, Apple, Mozilla, Microsoft) | Übermittlungsweg, keine Verarbeitung im Auftrag: der Inhalt ist Ende-zu-Ende verschlüsselt | Geräteadresse des Telefons; Inhalt (Zimmernummer oder Datum) nur verschlüsselt — **keine** Gastdaten | je nach Hersteller, USA mit Angemessenheitsbeschluss |
| Channel Manager ⟨Anbieter⟩ | eigenständig | Preise, Verfügbarkeit, Restriktionen — **keine** Gastdaten | ⟨Land⟩ |
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
| Gastpost | 90 Tage, bei Löschverlangen sofort | `email_redact_old()`, `guest_erase_one()` |
| Sitzungen und Einmaltoken | 7 Tage nach Ablauf | `purgeExpired()` |
| Freischaltungen der Gästemappe | 7 Tage nach dem Abreisetag, bei Löschverlangen sofort | `purgeExpired()`, `guest_erase_one()`, `guest_erase_partial()` |
| Idempotenzschlüssel | 24 Stunden | `purgeExpired()` |
| Protokoll | zehn Jahre | `audit_log_drop_old_partitions()` |

## 8. Technische und organisatorische Maßnahmen

Siehe [`tom.md`](tom.md).
