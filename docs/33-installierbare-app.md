# 33 — StayGrid als installierbare App

StayGrid läuft im Browser. An der Rezeption soll es sich trotzdem wie ein Programm verhalten: ein Symbol auf dem Desktop und in der Taskleiste, ein eigenes Fenster ohne Adressleiste und Reiter, kein versehentliches Schließen zusammen mit dem Browser. Das leistet eine installierbare Web-App (PWA) ohne zweite Codebasis und ohne Installationsprogramm.

## Was dazugehört

| Teil | Wo | Warum |
|---|---|---|
| Manifest | `apps/web/public/manifest.webmanifest` | Name, Symbole, `display: standalone` — das eigene Fenster |
| Symbole | `apps/web/public/icons/` | Ein Ausschnitt des Zimmerplans in den Statusfarben. `maskable-512.png` hat volle Fläche und Inhalt in der sicheren Zone, weil Android und ChromeOS das Symbol selbst zuschneiden |
| Service Worker | `apps/web/src/pwa/serviceWorker.ts`, erzeugt beim Bau als `sw.js` | Chrome und Edge bieten das Installieren an, die Hülle startet auch ohne Server |
| Knopf „Als App installieren" | `lib/pwa.ts`, `components/Shell.tsx` | Das Symbol des Browsers in der Adressleiste übersieht jeder |
| Hinweis „Server nicht erreichbar" | `main.tsx` | Ohne Netz stand bisher die Anmeldemaske da |
| Kopfzeilen | `ops/caddy/Caddyfile` | `sw.js` ohne Zwischenspeicher, Manifest mit seinem Typ |

Die Content-Security-Policy bleibt unverändert: Manifest und Worker kommen von derselben Herkunft, und `default-src 'self'` bzw. `script-src 'self'` decken beides.

## Was der Service Worker speichert, und was nie

Gespeichert wird die **Hülle**: `index.html` und die gehashten Dateien unter `/assets/`. Darin steht kein Gastname; es sind dieselben Bytes für jedes Haus.

**Nie gespeichert wird die Schnittstelle.** Alles unter `/v1/` geht am Worker vorbei, auch Seitenaufrufe wie die Zahlungsseite des Gastes. Zwei Gründe, jeder für sich genügt:

- Ein Zwischenspeicher für Fachdaten zeigt der Rezeption einen alten Stand, als wäre er neu. Wer eine alte Belegung für die aktuelle hält, bucht doppelt.
- Er hielte Gastdaten im Browser fest, die nach dem Abmelden niemand mehr löscht. Am Gästeterminal ist das ausdrücklich ausgeschlossen (CLAUDE.md), und an einem geteilten Rezeptionsrechner ist es nicht besser.

Was ohne Netz lesbar sein soll — Anreiseliste, Hausliste, Zimmerstatus —, hält weiterhin `lib/offline.ts`, mit Zeitstempel und dem gelben Hinweis in der Kopfleiste. Der Worker ändert daran nichts; er sorgt nur dafür, dass das Fenster überhaupt aufgeht.

**Seitenaufrufe gehen zuerst ans Netz**, erst ohne Netz kommt die gespeicherte Hülle. Sonst sähe die Rezeption nach einer Auslieferung die alte Fassung. Die Liste der zu speichernden Dateien entsteht beim Bau aus den Dateinamen, und aus ihr die Fassung des Workers: ein neuer Bau ergibt einen neuen Worker, der den Speicher des alten wegwirft.

`pwa.test.ts` führt den erzeugten Worker gegen nachgebaute Browserschnittstellen aus und hält fest, dass `/v1` mit und ohne Netz unberührt bleibt.

## `no-store` auf der Seite — ein Befund nebenbei

Das Caddyfile setzte `Cache-Control: no-store` mit `header /index.html …`. Das traf nie: `header` läuft vor `try_files` und sieht den Pfad der Anfrage, also `/` oder `/tagesgeschaeft`, nie `/index.html`. Gegen Caddy 2.10 nachgerechnet kam `/` ohne jede Cache-Control-Zeile zurück — und damit war die Seite für den Vor-Zurück-Speicher des Browsers wieder zulässig, gegen den das `no-store` gerade schützen sollte (Kommentar in `main.tsx` zum Abmelden). Jetzt gilt `no-store` für alles außer `/assets/*`, Manifest, Symbolen und `sw.js`.

## Installieren

- **Chrome und Edge** (Windows, macOS, Linux, ChromeOS): Knopf „Als App installieren" in der Kopfleiste, oder das Symbol rechts in der Adressleiste. Danach liegt StayGrid im Startmenü bzw. im Programme-Ordner und lässt sich an die Taskleiste heften.
- **Safari ab macOS 14:** Ablage → „Zum Dock hinzufügen". Einen Knopf gibt es dort nicht, weil Safari das Angebot nicht an die Seite meldet.
- **Firefox** installiert auf dem Desktop keine Web-Apps.

Das installierte Fenster teilt sich die Sitzung mit dem Browser derselben Herkunft. Abmelden im Fenster meldet also auch im Browser ab, und umgekehrt.

## Nicht gemacht

- **Kein Offline-Schreiben.** Die Begründung steht in `lib/offline.ts`: eine Buchung, die im Browser wartet, bindet später Kontingent, das inzwischen jemand anders verkauft hat.
- **Keine Benachrichtigungen.** Push braucht eine eigene Einwilligung, einen Schlüssel auf dem Server und eine Antwort auf die Frage, wer an einem geteilten Rechner benachrichtigt wird.
- **Keine Desktop-Hülle (Electron, Tauri).** Was sie zusätzlich brächte, ist Zugriff auf das Gerät — Drucker ohne Dialog, Kartenleser, Dateisystem. Das braucht StayGrid heute nicht, und es kostet eine signierte Auslieferung je Betriebssystem und eine Aktualisierung, die nicht mehr mit dem Server mitläuft.
