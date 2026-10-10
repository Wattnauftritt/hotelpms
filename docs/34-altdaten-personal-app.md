# 34 — Altdaten aus der alten Personal-App

Aufgabe 18, Baustein 9. StayGrid übernimmt Putzplan und Zusatzarbeiten aus der alten Reinigungs-App (Repo `zurseerobbe`, Flask). Das Cleaning-Backend schreibt dafür einen Exportbefehl, der aus der **Live-Datenbank** liest (Svens Freigabe vom 07.10.2026); StayGrid liest die Datei im Bildschirm „Datenübernahme“. Dieses Dokument ist der Vertrag zwischen beiden Seiten. Was hier nicht steht, liest StayGrid nicht.

Die Datei geht **nicht** ins Repo und nicht in den Projektordner: sie trägt Namen und Arbeitszeiten von Menschen. Sie wird im Bildschirm hochgeladen, und StayGrid behält von ihr nur, was es übernimmt.

## 1. Was übernommen wird, und was nicht

| Alt-App | StayGrid | Anmerkung |
|---|---|---|
| Putzplanzeile | `housekeeping_task`, `source = 'legacy'` | mit den **gespeicherten** Minuten, nicht neu gerechnet |
| Status der Zeile | `status` und `outcome` | Tabelle in Abschnitt 3 |
| Zusatzarbeit (auch „Küche“) | `staff_work_entry`, Art `extra`, `source = 'legacy'` | die Alt-App speicherte bei der Küche nur Minuten, keine Uhrzeiten |
| Übersetzung einer Zusatzarbeit | `staff_text_translation` (Deutsch) | manuelle immer, DeepL nur, wenn sie zum aktuellen Text gehört |
| Benutzer | **nicht** angelegt | jeder Alt-Benutzername wird einmal einer Person in StayGrid zugeordnet |
| Push-Abos, Kennwörter | nichts | jedes Telefon meldet sich in der neuen App neu an |
| Reinigungsverzicht des Gastes | nichts | die Alt-App kennt dazu keine Buchung; in StayGrid hängt er an der Reservierung (Migration 0115) |

## 2. Dateiformat

Eine JSON-Datei in UTF-8. Alle Daten sind **Hoteltage in Europe/Berlin** (`YYYY-MM-DD`), keine Zeitpunkte.

```json
{
  "format": "zurseerobbe-staygrid",
  "schemaVersion": 1,
  "exportedAt": "2026-10-07T18:00:00+02:00",
  "since": "2026-09-01",
  "until": "2026-10-07",
  "manifest": {
    "staff":       { "rows": 12,   "sha256": "…" },
    "schedules":   { "rows": 3600, "sha256": "…" },
    "workEntries": { "rows": 780,  "sha256": "…" }
  },
  "staff": [
    { "username": "olga", "displayName": "Olga K.", "roles": ["reinigung"],
      "status": "active", "language": "ru" }
  ],
  "schedules": [
    { "date": "2026-10-01", "room": "101", "kind": "departure", "username": "olga",
      "status": "cleaned", "minutes": 30 }
  ],
  "workEntries": [
    { "date": "2026-10-01", "username": "olga", "text": "Сложила бельё", "minutes": 25,
      "language": "ru", "translationDe": "Wäsche zusammengelegt", "translationManual": false }
  ]
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `since` | nein | erster Tag des Ausschnitts; `null` heißt: alles |
| `until` | ja | letzter Tag des Ausschnitts |
| `staff[].status` | ja | `active` oder `inactive` |
| `staff[].language` | nein | `de`, `en`, `ru`, `uk` oder `null` |
| `schedules[].kind` | ja | `departure` (Abreise) oder `stayover` (Bleiber) |
| `schedules[].username` | nein | `null`, wenn die Zeile niemandem zugeteilt ist |
| `schedules[].minutes` | ja | ganze Zahl ≥ 0, der in der Alt-App **gespeicherte** Wert |
| `workEntries[].minutes` | ja | 1 bis 44640 (ein Monat); die alte App kannte Sammelbuchungen wie „Uneingetragenes“ mit 4080 Minuten (Migration 0119) |
| `workEntries[].text` | ja | höchstens 500 Zeichen; Küche als `"Küche"` |

**Prüfsumme.** `sha256` ist der SHA-256 (hex, klein) über die kanonische Form der jeweiligen Liste: Schlüssel sortiert, ohne Leerraum, Nicht-ASCII unmaskiert, UTF-8. In Python:

```python
hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':'),
                          sort_keys=True).encode('utf-8')).hexdigest()
```

Stimmen Zeilenzahl oder Prüfsumme nicht, übernimmt StayGrid nichts. Eine abgeschnittene Datei sieht sonst aus wie ein Monat mit weniger Arbeit.

## 3. Status

| Alt-App | `status` in der Datei | StayGrid `status` / `outcome` | zählt zur Arbeitszeit |
|---|---|---|---|
| offen | `open` | `open` / – | nein |
| gereinigt | `cleaned` | `done` / `cleaned` | ja, mit den Minuten |
| keine Reinigung (Gast will nicht) | `declined` | `skipped` / `declined` | nein |
| war schon sauber (nur Admin) | `was_clean` | `skipped` / `was_clean` | nein |
| Fehler | `problem` | `open` / – | nein |

## 4. Wiederholbar bis zum Umschalttag

Die Alt-App löscht hart: Plan speichern, Tag zurücksetzen, Zusatzarbeit löschen. Ein Folgeexport kann deshalb nicht „was neu ist“ schicken, sondern **jeden Tag zwischen `since` und `until` vollständig**. StayGrid ersetzt diese Tage: was aus der Alt-App stammt (`source = 'legacy'`), fällt weg und kommt neu. Ein Tag ohne Zeilen im Ausschnitt ist danach in StayGrid leer — soweit er aus der Alt-App kam.

Was in StayGrid selbst geplant oder eingetragen wurde, gewinnt immer: steht für ein Zimmer an einem Tag schon eine Zeile aus StayGrid, bleibt sie, und die Zeile aus der Datei wird übersprungen. Ein Tag in einem **abgeschlossenen** Monat (Baustein 6) wird nicht angefasst.

Putzplanzeilen werden über **(Tag, Zimmernummer, Art)** zugeordnet, nicht über die ID der Alt-App — die ändert sich, wenn eine Zeile umgeteilt wird.

**Eine Datei, mehrere Häuser** (Migration 0116). Die Alt-App führt Hotel und Gästehaus in einem Plan, StayGrid als zwei Häuser. Jede Putzplanzeile geht in das Haus, das die Zimmernummer trägt: zuerst das Haus, in dem hochgeladen wird, sonst ein anderes Haus desselben Betriebs, in dem die Leitung ebenfalls `worktime:manage` hat. Steht die Nummer dort mehrmals, ist sie nicht zuzuordnen und steht im Bericht. Abgeschlossene Monate gelten je Haus. Zusatzarbeiten haben kein Zimmer und bleiben im Haus des Hochladens, ebenso die Zuordnung der Personen.

**„Bad“** ist kein Zimmer, sondern ein Reinigungsbereich des Gästehauses (Svens Entscheidung vom 07.10.2026). Er muss vor dem ersten Hochladen im Reinigungsplan des Gästehauses unter „Reinigungsbereiche“ mit der Kennung `Bad` angelegt sein; sonst stehen seine Zeilen als unbekanntes Zimmer im Bericht. Eine Zeile für einen Bereich wird immer als Abreise übernommen, gleich wie die Alt-App sie führte.

## 5. Zuordnung der Personen

Die Alt-App kennt nur Benutzernamen. Beim ersten Hochladen schlägt StayGrid je Alt-Benutzer eine Person vor (gleicher Benutzername im Haus) und merkt sich die Zuordnung (`staff_legacy_user`, Migration 0114); jeder spätere Export benutzt sie wieder. Wer keine Zuordnung hat, wird übersprungen und im Bericht genannt — fehlende Kräfte legt man vorher unter „Benutzer“ an. Gelöschte Benutzer der Alt-App fehlen samt ihrer Arbeitszeit; das ist dort nicht wiederherstellbar.

## 6. Ablauf im Bildschirm

1. Datei wählen. StayGrid prüft Format und Prüfsummen und zeigt einen **Trockenlauf**: Tage, Zeilen je Art, Zuordnung der Personen, übersprungene Zeilen mit Grund.
2. Personen zuordnen, wo der Vorschlag fehlt oder falsch ist.
3. Übernehmen. Ganz oder gar nicht, in einer Transaktion.

Recht: `worktime:manage` (Direktion, Betriebsverwaltung, Inhaber).
