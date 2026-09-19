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

## 4. Kategorien betroffener Personen und Daten

**Gäste.** Name, Anschrift, Geburtsdatum, Staatsangehörigkeit, Kontaktdaten,
Sprache, Aufenthaltsdaten, Rechnungsdaten, Meldedaten, Ausweisart und
-nummer, Unterschrift bei ausländischen Gästen, Hausnotizen.

**Mitreisende.** Zuordnung zur Reservierung und Alter bei Anreise.

**Beschäftigte des Betriebs.** Name, dienstliche E-Mail, Rolle, Zeitpunkt der
letzten Anmeldung, Authentifizierungsmerkmale.

**Ansprechpartner von Firmenkunden.** Firmenname, Anschrift, USt-IdNr.,
Rechnungsadresse.

> **Besondere Kategorien nach Art. 9 sind nicht vorgesehen.** Es gibt kein
> Feld dafür. Die Freitextfelder `guest_property_note.note` und
> `reservation.notes` können sie faktisch aufnehmen; beide tragen einen
> Hinweis, und beide sind von der Protokollierung ausgenommen
> (`audit_redaction`, Migration 0043). Dass der Betrieb sie so führt, ist Teil
> der Weisung nach Art. 29 und gehört in die Einweisung der Rezeption.

## 5. Empfänger

| Empfänger | Rolle | Übermittelte Daten | Ort |
|---|---|---|---|
| ⟨Hoster⟩ | Unterauftragsverarbeiter | alle, im Rahmen des Betriebs | ⟨Land⟩ |
| Stripe | Unterauftragsverarbeiter | **nur** Belegnummer, Betrag, Währung — kein Name, keine Anschrift | Irland / USA, Angemessenheitsbeschluss bzw. SCC |
| Brevo | Unterauftragsverarbeiter | Empfängeradresse, Name, Nachrichtentext | Frankreich |
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
| Idempotenzschlüssel | 24 Stunden | `purgeExpired()` |
| Protokoll | zehn Jahre | `audit_log_drop_old_partitions()` |

## 8. Technische und organisatorische Maßnahmen

Siehe [`tom.md`](tom.md).
