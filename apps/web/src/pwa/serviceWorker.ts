/**
 * Der Service Worker der installierbaren Oberflaeche (Dokument 33).
 *
 * Er wird beim Bau erzeugt (`vite.config.ts`) und nicht von Hand
 * geschrieben, weil er die Namen der gebauten Dateien kennen muss: sie
 * tragen einen Hash, und eine Liste von Hand stimmte nach dem naechsten Bau
 * nicht mehr. Aus derselben Liste entsteht die Fassung -- aendert sich eine
 * Datei, aendert sich ihr Name, damit die Fassung, und der Browser holt den
 * neuen Worker und wirft den alten Speicher weg.
 *
 * **Was er zwischenspeichert, und was nie.**
 *
 * - Die Huelle: `index.html` und die gehashten Dateien unter `/assets/`. Sie
 *   enthalten keinen einzigen Gastnamen; dieselben Bytes liegen fuer jedes
 *   Haus auf dem Server.
 * - **Nie die Schnittstelle.** `/v1/*` geht am Worker vorbei, ohne dass er
 *   die Antwort auch nur ansieht. Ein Zwischenspeicher fuer Fachdaten haette
 *   zwei Fehler auf einmal: er zeigte der Rezeption einen alten Stand, als
 *   waere er neu, und er hielte Gastdaten im Browser fest, die nach dem
 *   Abmelden niemand mehr loescht -- am Gaesteterminal genau das, was
 *   CLAUDE.md ausschliesst. Was offline lesbar sein soll, haelt
 *   `lib/offline.ts`, mit Zeitstempel und sichtbarem Hinweis. Das gilt auch
 *   fuer Seitenaufrufe unter `/v1/` wie die Zahlungsseite des Gastes: ohne
 *   Netz soll dort die Fehlerseite des Browsers stehen und nicht die
 *   Oberflaeche der Rezeption.
 *
 * **Seitenaufrufe gehen zuerst ans Netz.** Nur wenn das scheitert, kommt
 * die gespeicherte Huelle. Sonst saehe die Rezeption nach einer Auslieferung
 * die alte Fassung -- dasselbe, was `Cache-Control: no-store` auf der Seite
 * verhindern soll. Die Huelle ohne Netz ist nicht nutzlos: sie zeigt, dass
 * der Server nicht erreichbar ist, statt der Fehlerseite des Browsers, und
 * sie laedt von selbst nach, sobald er es wieder ist (`main.tsx`).
 */
export function serviceWorkerQuelle(dateien: readonly string[], fassung: string): string {
  const huelle = ['/', ...dateien.map(d => '/' + d)]
  return `/* Erzeugt beim Bau aus apps/web/src/pwa/serviceWorker.ts. */
'use strict'
const SPEICHER = 'staygrid-huelle-' + ${JSON.stringify(fassung)}
const HUELLE = ${JSON.stringify(huelle)}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SPEICHER)
    .then(function (c) { return c.addAll(HUELLE) })
    .then(function () { return self.skipWaiting() }))
})

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys()
    .then(function (namen) {
      return Promise.all(namen
        .filter(function (n) { return n.indexOf('staygrid-huelle-') === 0 && n !== SPEICHER })
        .map(function (n) { return caches.delete(n) }))
    })
    .then(function () { return self.clients.claim() }))
})

self.addEventListener('fetch', function (e) {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.indexOf('/v1/') === 0) return
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(function () {
      return caches.open(SPEICHER).then(function (c) { return c.match('/') })
        .then(function (r) { return r || Response.error() })
    }))
    return
  }
  if (url.pathname.indexOf('/assets/') === 0) {
    e.respondWith(caches.open(SPEICHER).then(function (c) { return c.match(req) })
      .then(function (r) { return r || fetch(req) }))
  }
})
`
}
