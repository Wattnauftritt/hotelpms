# 35 — Digitale Gästemappe

Stand: 12. Oktober 2026, Bausteine 1 und 2 gebaut (Migration `0143`). Code: `apps/api/src/routes/gaestemappe.ts`, `apps/api/src/platform/gaestemappe.ts`, `packages/contracts/src/gaestemappe.ts`, `apps/web/src/routes/GastMappe.tsx`, `apps/web/src/gast/`, `apps/web/src/components/GaestemappeEinstellung.tsx`, `apps/web/src/components/Zimmerkarten.tsx`.

## 1. Was sie ist

Die Papiermappe im Zimmer, auf dem Telefon des Gastes. Der Gast scannt den QR-Code auf der Zimmerkarte und sieht WLAN, Anreise- und Abreisezeit und die Seiten, die das Haus auswählt. Ohne Anmeldung, ohne App. Was einen Aufenthalt betrifft — auf die Reinigung verzichten, Extras bestellen, späte Abreise —, kommt mit der Freischaltung (Abschnitt 5).

## 2. Entscheidungen (Sven, 11.10.2026)

| Frage | Entscheidung |
|---|---|
| Wo | Intern in StayGrid, keine Schnittstelle fürs Adminpanel |
| Sprachen | alle vierzehn des Systems — wie die Gastpost (anfangs de, en, nl, pl; seit 12.10.2026 vierzehn) |
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

## 5. Übersetzung der Seiten

Migration `0144`, Svens Entscheidung „automatisch“. Deutsch ist die Vorlage, übersetzt wird nach Englisch, Niederländisch und Polnisch (`terminal_content_translation`, eine Zeile je Seite und Sprache).

- **Eine Übersetzung gehört zu genau einer deutschen Fassung.** Sie trägt den Fingerabdruck von Titel und Text, zu denen sie entstand (`terminal_content_hash`). Ändert jemand die deutsche Seite, passt er nicht mehr, und die Mappe zeigt die Seite deutsch, bis die neue Übersetzung da ist — eine veraltete nennt womöglich die alte Frühstückszeit, und ein Gast glaubt der Seite in seiner Sprache mehr als der, die er nicht lesen kann. Die deutsche Fassung trägt dann `lang="de"`, damit ein Vorleseprogramm sie richtig ausspricht.
- **Keine Warteschlange.** Fällig ist, was nicht zum Fingerabdruck passt; der Worker (`jobs/folderTranslation.ts`) findet das selbst, im selben Tick wie die Texte des Personals und hinter derselben Sicherung für DeepL. Übersetzt wird nur, was in einer **eingeschalteten** Mappe steht — eine Seite nur fürs Terminal liest niemand auf Polnisch, und jedes Zeichen kostet Kontingent. Nach sechs Fehlversuchen bleibt die Fassung deutsch, bis jemand die Seite ändert oder „Neu von DeepL übersetzen lassen“ drückt.
- **Das Format überlebt die Übersetzung.** Jede Zeile geht als eigenes XML-Element hinaus, Fettes als `<b>`, mit `tag_handling=xml` und fester Ausgangssprache Deutsch. Als Klartext verschob DeepL die Sternchen von `**fett**`; eine Antwort, die nicht Zeile für Zeile passt, gilt als Fehler und wird wiederholt (`folderTextToDeeplXml`, `folderTextFromDeeplXml`).
- **Jede Sprache der Mappe, nicht eine Auswahl** (Migration 0145). Die Mappe bietet die vierzehn Sprachen des Systems an; eine Sprache, deren Knöpfe übersetzt sind und deren Seiten nicht, zeigt dem Gast seine Wahl und darunter Deutsch. Der Preis ist Kontingent: dreizehn Zielsprachen kosten je Seite das Dreizehnfache der Zeichen. Weil nur geänderte Seiten neu übersetzt werden, fällt das einmal beim Einrichten an und danach je Änderung, nicht je Aufruf. `FOLDER_TRANSLATION_LANGS` leitet sich aus `FOLDER_LOCALES` ab, damit beide nicht auseinanderlaufen.
- **Von Hand überschreiben.** Einstellungen → Gästemappe zeigt je Seite den Stand (EN ✓, NL …, PL !) und öffnet eine Maske mit der deutschen Vorlage über allen dreizehn Sprachen (`PUT`/`DELETE …/guest-folder/pages/:ref/translations/:lang`). Eine Übersetzung von Hand gilt für die deutsche Fassung von jetzt; ändert sich die Seite, übersetzt DeepL neu, denn die Berichtigung stimmte für einen Text, den es nicht mehr gibt.
- **Datenschutz.** Hausseiten bezeichnen keinen Menschen; an DeepL geht nur, was das Haus für alle Gäste geschrieben hat. Kein Eintrag in `audit_redaction`, kein neuer Eintrag im Verarbeitungsverzeichnis — DeepL steht dort bereits als Unterauftragsverarbeiter.

Nebenbei behoben: die Gastseite zeigte den Seitentext roh, mit Sternchen statt Fettschrift und Strichen statt Aufzählung. Sie nutzt jetzt `Inhaltstext` wie das Terminal.

## 6. Freischalten

Migration `0147`. Wer die Karte scannt, sieht Hausinfos und WLAN; den eigenen Aufenthalt erst, wer einmal mit **Nachname oder PLZ** bestätigt.

- **Gegen wen.** Jede Reservierung, die heute im Zimmer der Karte läuft (Optional, Bestätigt, Im Haus; Anreise bis Abreisetag), und jede Person daran: Hauptgast, Mitreisende, Meldescheine. Am Wechseltag sind das zwei Aufenthalte, und die Freischaltung bindet sich an den, der passt; bei Gleichstand an den Ankommenden. Damit braucht es keine Uhrzeit, ab der ein Zimmer „dem Neuen gehört“.
- **Wie nachsichtig.** Groß/klein, Akzente, `ß`, Umlaut und Umschrift (`Müller`, `Mueller`, `Muller`), jeder Teil eines Doppelnamens; aber kein Anfang eines Namens („Sch“ öffnet nicht „Schmidt“). Die PLZ ohne Leerzeichen und Bindestrich. Die Regel steht in `packages/domain/src/folderUnlock.ts`, nicht in SQL — dort fehlt `unaccent`, und zwei Fassungen liefen auseinander.
- **Wie lange.** Ein `httpOnly`-Cookie `hp_mappe` mit `Path=/v1/mappe` und `SameSite=Strict` bis zum Ende des Abreisetags am Ort des Hauses; in der Datenbank nur sein Hash (`guest_folder_session`, in `audit_redaction`). Die Freischaltung hängt an der Reservierung, nicht am Zimmer: wechselt der Gast das Zimmer, gilt sie mit der neuen Karte und nicht mehr mit der alten. Gezeigt wird danach nur der Abreisetag — kein Name, keine Adresse.
- **Fehlversuche je Zimmer, in der Datenbank.** Zehn je Viertelstunde, dann wartet das Zimmer, auch mit dem richtigen Namen. Je Herkunft hälfe nicht: im Hotel-WLAN teilen sich alle Gäste eine Adresse. Zusätzlich steht `/v1/mappe/unlock` unter der engen Grenze für anonyme Anfragen, gegen den, der viele Zimmer zugleich durchprobiert. Ein Fehlversuch sagt nicht, ob das Zimmer belegt ist.
- **Mail-Link.** Wer den Link zum Online-Check-in aus der Mail öffnet, bekommt ab dem Anreisetag, mit zugeteiltem Zimmer und eingeschalteter Mappe, den Knopf „Gästemappe öffnen“ (`POST /v1/mappe/from-checkin`): der Link ist schon an genau diesen Aufenthalt gebunden und reicht als Freischaltung. Der Link am Terminal schaltet nichts frei — an dem Gerät steht der nächste Gast.
- **Aufheben.** Der Gast meldet sein Telefon selbst ab (`/v1/mappe/lock`); die Rezeption hebt im Seitenfenster der Reservierung alle auf, solange eine besteht (`reservation:checkin`).
- **Löschen.** `guest_erase_one()` und `guest_erase_partial()` löschen die Freischaltungen über `guest_folder_sessions_erase()`; sonst räumt `purgeExpired()` sie sieben Tage nach dem Abreisetag ab. Eingetragen im Verarbeitungsverzeichnis.

Offen und bewusst nicht hier: Die allgemeine Grenze für anonyme Anfragen (300 je Minute und Adresse) gilt auch für das Laden der Mappe. In einem großen Haus hinter **einer** Adresse kann ein voller Frühstücksraum sie erreichen; dann ist die Mappe für eine Minute nicht zu laden. Messen, bevor eine Ausnahme gebaut wird.

## 7. Reinigungsverzicht

Migration `0148`. Das freigeschaltete Telefon sieht unter „Ihr Aufenthalt“ dieselben Bleibetage mit „Keine Reinigung“ wie die Gastseite des Online-Check-ins (`VerzichtListe.tsx`, ohne den Katalog der Rezeption).

- **Nur mit Freischaltung.** `POST /v1/mappe/cleaning-waiver` antwortet ohne Freischaltung mit 403 (`folder.unlockRequired`). Die Karte allein hat jeder, der je im Zimmer war; ein früherer Gast soll dem jetzigen nicht die Reinigung abbestellen. Genau diese Lücke hatte die offene Verzichtsseite der alten App.
- **Eine Regel, drei Türen.** Welche Tage gehen, bis wann, und wer davon erfährt (Push an die zugeteilte Kraft), entscheidet weiter `setzeVerzicht` in `platform/reinigungsverzicht.ts`. Ob die Mappe den Verzicht zeigt, folgt der Einstellung des Verzichts selbst (`property_cleaning_waiver_setting`); einen zweiten Schalter in der Mappe gibt es nicht, weil ein Haus, das den Verzicht anbietet, ihn nicht an einer Tür anbieten und an der anderen verschweigen will.
- **Eigene Herkunft.** `cleaning_waiver.source = 'folder'` neben `guest` (Mail-Link) und `reception`, damit nachzulesen bleibt, über welche Tür verzichtet wurde.

## 8. Wünsche und Extras

Migration `0149`. Das Haus pflegt unter Einstellungen → Gästemappe einen kurzen **Katalog**: Kopfkissen, Decke, Babybett, aber auch Sekt aufs Zimmer oder ein Lunchpaket. Je Eintrag: der Name je Sprache (Deutsch Pflicht, eine leere Sprache zeigt den deutschen), wer sich kümmert (Rezeption oder Housekeeping, Svens Entscheidung), eine Höchstmenge, ob er in der Mappe und/oder am Terminal steht, und optional ein **Bruttopreis** mit Umsatzsteuersatz und Erlöskonto. Partnerangebote gibt es nicht (Sven); was kostenlos ist, bleibt kostenlos.

- **Kein Freitext.** Der Gast wählt Eintrag, Menge und optional einen Tag seines Aufenthalts; die Rezeption lehnt mit einem Grund aus einer festen Liste ab (nicht vorrätig, an dem Tag nicht, bitte an der Rezeption melden). So liest jede Seite die Antwort in ihrer Sprache, und keine Spalte trägt etwas, das einen Menschen bezeichnet. Die freie Nachricht kommt mit Abschnitt 9 und bringt dann ihre eigene Löschung mit.
- **Ein Extra mit Preis ist ein `product`.** StayGrid hat keine Artikelpflege; der Katalog legt deshalb einen eigenen Artikel `MAPPE-<id>` an, den eine spätere Artikelpflege wiederfindet. Ohne Preis wird er abgeschaltet, nicht gelöscht.
- **Gebucht wird beim Annehmen, nicht beim Bestellen**, brutto auf das offene Gastfolio, mit dem Preis, den der Gast gesehen hat — ändert das Haus ihn dazwischen, gilt für diesen Wunsch der alte. Wer annimmt, braucht dafür zusätzlich `folio:post`. Ohne offenes Gastfolio 409.
- **Höchstens zehn offene Wünsche je Aufenthalt.** Eine freigeschaltete Mappe ist kein Ausweis gegen einen Gast, der aus Spaß dreißig Kissen bestellt.
- Die Rezeption sieht offene Wünsche über den Spalten unter „Heute“ und alle im Seitenfenster der Reservierung. Housekeeping-Einträge tragen dort einen Vermerk, bis sie mit dem nächsten Schritt in die Personal-App gehen.

## 9. Was als Nächstes kommt

1. Wünsche in der Personal-App mit Push und Übersetzung.
2. Freie Nachricht, späte Abreise gegen Gebühr, Abreiseseite, Bewertungslink.
3. Verlängern, Upgrade, Bericht „Umsatz aus der Gästemappe“.
