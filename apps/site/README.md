# Öffentliche Seite staygrid.cloud

Produktseite, Impressum und die Datenschutzerklärung der App. Die Adresse
`https://staygrid.cloud/datenschutz/` steht in App Store und Google Play.

**Sie liegt auf dem Plesk-Host, nicht auf der StayGrid-Maschine** (Sven,
21.10.2026). Eine öffentliche Werbeseite ist eine Angriffsfläche mehr und
gehört nicht neben die Gastdaten. Deshalb kennt `ops/caddy/Caddyfile` den
Namen `staygrid.cloud` nicht, und `deploy.sh` rollt diese Seite nicht aus.

## Bauen

```bash
pnpm --filter @hotelpms/site build      # legt apps/site/dist an
cd apps/site/dist && zip -r ../staygrid-webseite.zip .   # nimmt .htaccess mit
```

Jede Seite ist ein Ordner mit `index.html`, damit jeder Webserver
`/datenschutz/` ohne Umschreiberegel findet. `.htaccess` setzt nur
Kopfzeilen und die 404-Seite.

## Auf Plesk bringen

1. **Domain anlegen:** In Plesk unter *Websites & Domains* die Domain
   `staygrid.cloud` hinzufügen. Wählt man „Nur Hosting", reicht eine
   statische Seite; PHP kann aus.
2. **Hochladen:** Im *Dateimanager* unter `httpdocs` den alten Inhalt
   löschen, das ZIP hochladen und dort entpacken. `.htaccess` muss danach
   in `httpdocs` liegen, nicht in einem Unterordner.
3. **DNS:** Beim DNS-Anbieter von `staygrid.cloud` den A-Eintrag (und ggf.
   AAAA) der **Wurzel** `staygrid.cloud` auf die Adresse des Plesk-Hosts
   setzen. `app.staygrid.cloud`, `api.staygrid.cloud` und
   `mail.staygrid.cloud` bleiben, wie sie sind.
4. **Zertifikat:** Wenn der DNS-Eintrag greift, in Plesk unter *SSL/TLS-
   Zertifikate* ein Zertifikat von Let's Encrypt für `staygrid.cloud` (und
   `www`, falls angelegt) holen. Dann unter *Hosting-Einstellungen*
   „Dauerhafte SEO-sichere 301-Weiterleitung von HTTP zu HTTPS" anhaken.
5. **Prüfen:** `https://staygrid.cloud/datenschutz/` muss die Erklärung
   zeigen, `https://staygrid.cloud/gibtsnicht` die 404-Seite.

## Wer die Seite ändert

- Kein Skript, keine Schrift oder Bild von fremden Servern, kein Analysedienst:
  die Datenschutzerklärung sagt, dass es das nicht gibt.
- Kommt in der App eine Fähigkeit dazu, die Daten erhebt oder weitergibt,
  wird die Erklärung **vorher** ergänzt, ebenso die Angaben zur
  Datensicherheit in beiden Stores.
- Bilder nur aus `db:testhotel` (Übungshaus, erfundene Gäste), nie aus einem
  echten Haus. Das Aufnahmeskript liegt im Projektordner unter
  `webseite/screenshots/`.
