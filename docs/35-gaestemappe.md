# 35 — Digitale Gästemappe

Stand: 12. Oktober 2026, Bausteine 1 und 2 gebaut (Migration `0143`). Code: `apps/api/src/routes/gaestemappe.ts`, `apps/api/src/platform/gaestemappe.ts`, `packages/contracts/src/gaestemappe.ts`, `apps/web/src/routes/GastMappe.tsx`, `apps/web/src/gast/`, `apps/web/src/components/GaestemappeEinstellung.tsx`, `apps/web/src/components/Zimmerkarten.tsx`.

## 1. Was sie ist

Die Papiermappe im Zimmer, auf dem Telefon des Gastes. Der Gast scannt den QR-Code auf der Zimmerkarte und sieht WLAN, Anreise- und Abreisezeit und die Seiten, die das Haus auswählt. Ohne Anmeldung, ohne App. Was einen Aufenthalt betrifft — auf die Reinigung verzichten, Extras bestellen, späte Abreise —, kommt mit der Freischaltung (Abschnitt 5).

## 2. Entscheidungen (Sven, 11.10.2026)

| Frage | Entscheidung |
|---|---|
| Wo | Intern in StayGrid, keine Schnittstelle fürs Adminpanel |
| Sprachen | de, en, nl, pl — wie die Gastpost |
| Hausseiten übersetzen | automatisch (DeepL), Deutsch ist die Vorlage, einzelne Übersetzungen überschreibbar |
| WLAN | ein Netz je Haus, keine Ausnahme je Zimmer |
| Zimmerkarte | A6 zum Aufstellen, zwei QR-Codes nebeneinander (WLAN, Mappe), darunter Netzname und Passwort ausgeschrieben |
| Zugang zu Aktionen | QR trägt nur das Zimmer; einmal Nachname **oder** PLZ, danach bis zur Abreise freigeschaltet; Fehlversuche begrenzt; der Mail-Link des Meldeformulars öffnet ohne Eingabe |
| Wer erledigt Wünsche | je Eintrag im Katalog einstellbar (Rezeption oder Housekeeping) |
| Extras | gleich mit Preis, aufs Folio, wenn die Rezeption annimmt |
| Freie Nachricht | ja, als Wunsch „Sonstiges“, kein Chat |
| Späte Abreise | als Anfrage, gegen Gebühr, Preise legt das Haus fest |
| Rechnung in der Mappe | vorerst nein |
| Angebote in der Mail vor Anreise | nein |
| Partnerangebote (Ausflüge, Restaurants) | keine |

## 3. Die Zimmer-Referenz

Der QR-Code trägt `https://<app>/mappe#<referenz>`. Die Referenz ist zufällig (zwölf Zeichen aus dem Alphabet von `generate_public_ref`), nicht die Zimmernummer: sonst zählte jeder die Mappen aller Zimmer durch, sobald er eine gesehen hat. Sie steht im **Fragment**, das kein Server und kein Protokoll sieht, und reist in der Kopfzeile `x-staygrid-folder-room` — dasselbe Muster wie das Token des Online-Check-ins (Dokument 30). Die Kopfzeile steht in der Redaktionsliste von `pino`.

Eingelöst wird sie in der Datenbank: `guest_folder_room_open()` beginnt mit leerem Kontext, liest genau eine Zeile und setzt den Kontext auf genau dieses Haus. Unbekannt ergibt 404, Mappe aus 410 `folder.off`, stillgelegtes Zimmer oder Haus 410 `folder.closed`.

**Kein eigener Zähler für Fehlversuche** an dieser Stelle: rund 10^17 Möglichkeiten, die allgemeine Grenze für anonyme Anfragen genügt. Den Zähler braucht die Freischaltung mit Nachname oder PLZ, deren Raum klein ist.

**Neuer Code.** Wurde ein Foto einer Karte weitergegeben, erzeugt die Rezeption beim Zimmer einen neuen Code; die alte Karte zeigt danach „unbekannt“. Die Referenz steht in `audit_redaction`, damit die alte nicht im Protokoll nachzulesen ist.

**Was ohne Freischaltung sichtbar ist**, ist mit Absicht nur, was ohnehin auf der Karte steht oder im Zimmer ausliegen könnte: kein Gastname, kein Zeitraum, kein Betrag.

## 4. Seiten, WLAN, Karte

- **Seiten** sind die des Gästeterminals (`terminal_content`) mit `folder_position`. Zwei Pflegestellen für dieselbe Frühstückszeit liefen auseinander. Gesetzt wird die Folge als Ganzes, wie die Diashow. Text, kein HTML; Bilder nur PNG, JPEG, WebP. Ein Bild einer Seite, die nicht in der Mappe steht, ist über die Karte nicht zu holen. Die Gastseite lädt Bilder per `fetch` mit der Kopfzeile und zeigt sie als data-URL — ein `<img src>` kann keine Kopfzeile schicken, und die Content-Security-Policy erlaubt für Bilder `'self' data:`, nicht `blob:`.
- **WLAN** an `guest_folder_setting`, Prüfung wie die CHECK-Regel: WPA 8–63 Zeichen, WEP 5–26, offen ohne Kennwort, Name höchstens 32 Byte. Der QR-Code folgt dem Format `WIFI:T:…;S:…;P:…;H:…;;` und maskiert `\ ; , : "` (`wifiQrText`). Der Erzeuger kodiert UTF-8, sonst wäre „Gästehaus“ ein anderes Netz.
- **Zimmerkarte** wird aus dem Browser gedruckt, kein PDF vom Server. Jede Karte ein eigenes Blatt über die benannte Seite `@page zimmerkarte` (sonst druckte das Kassenbuch auf A6), Maße in Millimetern: Chrome kennt das Schlüsselwort `A6` nicht und legt die Karte dann still auf Letter. Die Karte spricht Deutsch und Englisch, unabhängig von der Sprache der Rezeption; die Sätze kommen aus dem Katalog der Mappe. Referenzen legt `GET …/guest-folder/cards` für fehlende Zimmer an — ein GET, das schreibt, mit Absicht: ein Knopf „Referenzen anlegen“ wäre ein Schritt, den jemand vergisst.

## 5. Was als Nächstes kommt

1. Hausseiten automatisch übersetzen (Worker, DeepL, wie Baustein 7 der Personal-App).
2. Freischalten: Nachname oder PLZ gegen den laufenden Aufenthalt des Zimmers; am Wechseltag gegen beide Aufenthalte, die Sitzung bindet sich an den passenden. Mappen-Sitzung als `httpOnly`-Cookie mit `Path=/v1/mappe` bis Ende des Abreisetags, Hash in `audit_redaction`, Löschung in `guest_erase_one()`. Fehlversuche je Zimmer in der Datenbank. Der Mail-Link (`checkin_token`) öffnet die Mappe freigeschaltet.
3. Reinigungsverzicht in der Mappe (`cleaning_waiver.source = 'folder'`).
4. Wünsche und Extras mit Preis (`guest_request_item`, `guest_request`; bei Annahme Buchung aufs Folio über `product`).
5. Wünsche in der Personal-App mit Push und Übersetzung.
6. Freie Nachricht, späte Abreise gegen Gebühr, Abreiseseite, Bewertungslink.
7. Verlängern, Upgrade, Bericht „Umsatz aus der Gästemappe“.
