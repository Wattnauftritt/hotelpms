# hotelpms

Eigenes Hotel Property Management System. Aktuell in der Planungsphase.

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
- [docs/10-systemarchitektur.md](docs/10-systemarchitektur.md): Zielbild, Tech-Stack, Modulschnitt, Datenmodell, API-Entwurf, Hintergrundverarbeitung und der Betrieb auf Linux mit Plesk.
- [docs/11-umsetzungsplan.md](docs/11-umsetzungsplan.md): Repository-Struktur, 15 Arbeitspakete mit Reihenfolge und Definition of Done, Teststrategie, CI und Auslieferung.
- [docs/12-security-und-performance-review.md](docs/12-security-und-performance-review.md): Kritische Durchsicht der Pläne. Drei Widersprüche, 13 Sicherheits- und 12 Performancebefunde, und was vor dem ersten Code zu ändern ist.
