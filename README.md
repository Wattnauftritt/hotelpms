# hotelpms

Eigenes Hotel Property Management System für den deutschen Markt. Backend und Rezeptions-Oberfläche sind gebaut und getestet ([`docs/16-arbeitsstand.md`](docs/16-arbeitsstand.md)); die Inbetriebnahme für den ersten Kunden steht an ([`docs/17-betrieb.md`](docs/17-betrieb.md), [`docs/21-inbetriebnahme.md`](docs/21-inbetriebnahme.md)).

## Dokumente

- [docs/01-marktanalyse-pms.md](docs/01-marktanalyse-pms.md): Wie bestehende Systeme (Opera, Mews, Apaleo, Cloudbeds, Open Source) funktionieren, gemeinsames Domänenmodell, deutsche Pflichten (Meldeschein, GoBD, TSE, Kurtaxe, Statistik).
- [docs/02-planungsgrundlage.md](docs/02-planungsgrundlage.md): Leitlinien, Domänenmodell-Entwurf, Zustandsautomat, Verfügbarkeitsberechnung, Nachtlauf, Modulschnitt, Roadmap und offene Fragen für unser eigenes System.
- [docs/03-marktfuehrer-deutschland.md](docs/03-marktfuehrer-deutschland.md): Wer ist Marktführer bei Cloud-PMS in Deutschland? Zahlen zu protel/Planet, Mews, Oracle Opera, SIHOT und den DACH-Anbietern, Marktgröße und was daraus für unsere Positionierung folgt.
- [docs/04-api-first-und-performance.md](docs/04-api-first-und-performance.md): Was API-first konkret bedeutet, und die Performance-Architektur dahinter. Warum Fat-Client-Systeme wie KWHotel träge sind, das Grundgesetz Round Trips × Latenz, N+1-Vermeidung, Verfügbarkeit als transaktionale Zählertabelle, Latenzbudget und Absicherung.
- [docs/05-wettbewerber-softtec.md](docs/05-wettbewerber-softtec.md): SoftTec / hotline aus Sonthofen im Detail. Der relevanteste direkte Wettbewerber: 3.500 Hotels, ab 7 Euro je Zimmer und Monat, deutsche Regulatorik vollständig, aber zwei Produktgenerationen parallel und kein offenes API. Einordnung der DEHOGA-Partnerschaft.
- [docs/06-fiskalisierung.md](docs/06-fiskalisierung.md): Was Fiskalisierung bedeutet, wie TSE, DSFinV-K und Meldepflicht zusammenhängen, welche vier Schichten es gibt und welche davon zugekauft werden müssen.
- [docs/07-technologie-und-hosting.md](docs/07-technologie-und-hosting.md): Stack- und Hosting-Entscheidung mit Lastrechnung und Kosten. Warum Serverless-Datenbanken hier die falsche Wahl sind und ein einzelner Server weit reicht.
- [docs/08-compliance-in-der-praxis.md](docs/08-compliance-in-der-praxis.md): Was „unveränderbar“ nach GoBD realistisch verlangt, welche Vorgänge die TSE wirklich signiert, Aufbewahrungsfristen nach der Änderung 2025, und ob wir ISO 27001 brauchen.
- [docs/09-kassenbuch.md](docs/09-kassenbuch.md): Entscheidung gegen eine Kassenfunktion. Fakturierung und Zahlungsvermerk statt Kassenbuch, die vier Merkmale die uns rechtlich abgrenzen, und die Kassenschnittstelle als Ersatz.
- [docs/10-systemarchitektur.md](docs/10-systemarchitektur.md): Zielbild, Tech-Stack, Modulschnitt, Datenmodell, API-Entwurf, Hintergrundverarbeitung und der Betrieb auf einer eigenen VM am Proxmox-Host.
- [docs/11-umsetzungsplan.md](docs/11-umsetzungsplan.md): Repository-Struktur, 15 Arbeitspakete mit Reihenfolge und Definition of Done, Teststrategie, CI und Auslieferung.
- [docs/12-security-und-performance-review.md](docs/12-security-und-performance-review.md): Kritische Durchsicht der Pläne. Drei Widersprüche, 13 Sicherheits- und 12 Performancebefunde, und was vor dem ersten Code zu ändern ist.
- [docs/13-gesamtreview.md](docs/13-gesamtreview.md): Zweites Review über alle Dokumente im Zusammenhang. Zwölf veraltete Stellen korrigiert, elf logische Fehler, elf neue Sicherheits- und fünf Performancebefunde, und elf Dinge, die einem Hotel gefehlt hätten.
- [docs/14-benutzerrollen.md](docs/14-benutzerrollen.md): Berechtigungskatalog, dreizehn Systemrollen für Hotels und vier für uns, Support-Sitzung als einziger Weg zu Kundendaten, Arbeitsplatz-PIN für geteilte Rezeptionen, Datenmodell.
- [docs/15-messungen-aus-dem-saatlauf.md](docs/15-messungen-aus-dem-saatlauf.md): Was ein Bestand realistischer Größe (vier Häuser, 214 000 Reservierungen über drei Jahre) über den Entwurf verraten hat: drei Leistungsbefunde, ihre Ursache und die Migration, die sie behoben hat.
- [docs/16-arbeitsstand.md](docs/16-arbeitsstand.md): Die Übergabe. Was fertig ist, durch Tests belegt statt behauptet, und offene Aufgaben, jede einzeln und ohne Rückfrage bearbeitbar.
- [docs/17-betrieb.md](docs/17-betrieb.md): Betriebshandbuch für fremde Kunden — Plattenverschlüsselung, Sicherung außer Haus, Schulungsbetrieb, Schlüsselrotation, Ratenbegrenzung in der ersten Linie.
- [docs/18-einarbeitung.md](docs/18-einarbeitung.md): Einarbeitung in zwanzig Minuten für alle, die das Repository zum ersten Mal öffnen — was das System tut, wo, und warum es an den entscheidenden Stellen so gebaut ist.
- [docs/19-frontend.md](docs/19-frontend.md): Die Rezeptions-Oberfläche gemessen am Wettbewerb (Mews, Apaleo, SIHOT, Cloudbeds) und an der eigenen API — was fehlte, in Zahlen, und der daraus abgeleitete Bauplan.
- [docs/20-arbeitsteilung.md](docs/20-arbeitsteilung.md): Die Oberflächenarbeit aus Dokument 19 auf drei parallele Bearbeiter aufgeteilt, zugleich die laufende Fortschrittstafel.
- [docs/21-inbetriebnahme.md](docs/21-inbetriebnahme.md): Die Maschine aufsetzen — von der leeren VM auf dem Proxmox-Host bis zum laufenden Betrieb unter Debian.
