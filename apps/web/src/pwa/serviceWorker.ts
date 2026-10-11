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
 *
 * **Push (Baustein 8, Migration 0113).** Der Worker schickt Titel, Text,
 * Ziel und Kennung fertig in der Sprache der Kraft; hier wird nur angezeigt.
 * Das Ziel muss ein Pfad dieser Seite sein -- eine Meldung fuehrt nie nach
 * draussen. Gespeichert wird davon nichts.
 *
 * **Je Anwendung nur ihre Dateien** (Performance-Audit 11.10.2026, Befund
 * 11). Beim Installieren kommt nur der Grund -- Seite und `boot.ts`. Die
 * Seite, die den Worker anmeldet, sagt danach, welche Anwendung sie ist
 * (`lib/pwa.ts`), und erst dann laedt er deren Dateien vor: die Rezeption
 * alle Bildschirme, die Personal-App ihre drei. Ein Worker weiss beim
 * Installieren nicht, wer ihn angemeldet hat; und an einem Geraet, das
 * beides oeffnet, soll beides offline gehen. Was dennoch fehlt, legt er beim
 * ersten Abruf ab -- auch das nur unter `/assets/`. Die Gastseiten melden
 * keinen Worker an.
 */
export interface Huelle {
  /** Was jedes Fenster braucht, um ohne Netz aufzugehen. */
  grund: readonly string[]
  /** Je Anwendung ihre Dateien, beim ersten Oeffnen vorgeladen. */
  apps: Readonly<Record<string, readonly string[]>>
}

export function serviceWorkerQuelle(huelle: Huelle, fassung: string): string {
  return `/* Erzeugt beim Bau aus apps/web/src/pwa/serviceWorker.ts. */
'use strict'
const SPEICHER = 'staygrid-huelle-' + ${JSON.stringify(fassung)}
const GRUND = ${JSON.stringify(huelle.grund)}
const APPS = ${JSON.stringify(huelle.apps)}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SPEICHER)
    .then(function (c) { return c.addAll(GRUND) })
    .then(function () { return self.skipWaiting() }))
})

/* Nur holen, was noch fehlt: die Seite meldet sich bei jedem Aufruf. */
function vorladen(liste) {
  return caches.open(SPEICHER).then(function (c) {
    return Promise.all(liste.map(function (u) {
      return c.match(u).then(function (r) { return r ? null : u })
    })).then(function (fehlt) {
      fehlt = fehlt.filter(function (u) { return u !== null })
      return fehlt.length > 0 ? c.addAll(fehlt) : undefined
    })
  })
}

self.addEventListener('message', function (e) {
  const app = e.data && e.data.vorladen
  if (typeof app !== 'string' || !Object.prototype.hasOwnProperty.call(APPS, app)) return
  e.waitUntil(vorladen(APPS[app]).catch(function () { /* ohne Netz: beim naechsten Aufruf */ }))
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
    e.respondWith(caches.open(SPEICHER).then(function (c) {
      return c.match(req).then(function (r) {
        if (r) return r
        return fetch(req).then(function (antwort) {
          // Die Namen tragen ihren Hash: was einmal ok kam, gilt fuer diese Fassung.
          if (antwort.ok) e.waitUntil(c.put(req, antwort.clone()).catch(function () {}))
          return antwort
        })
      })
    }))
  }
})

// Nur ein Pfad dieser Seite. Der URL-Parser liest einen Backslash wie einen
// Schraegstrich und wirft Tab und Zeilenumbruch weg: aus "/\\boese.example"
// und "/<Tab>/boese.example" wird so "//boese.example", eine fremde Herkunft
// (Audit 11.10.2026). Deshalb Zeichencodes statt eines Musters -- 92 ist der
// Backslash, unter 32 die Steuerzeichen.
function eigenerPfad(p) {
  if (typeof p !== 'string' || p.charAt(0) !== '/' || p.charAt(1) === '/') return '/personal'
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i)
    if (c === 92 || c < 32) return '/personal'
  }
  return p
}

self.addEventListener('push', function (e) {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch (x) { d = {} }
  const titel = typeof d.title === 'string' ? d.title : 'StayGrid'
  e.waitUntil(self.registration.showNotification(titel, {
    body: typeof d.body === 'string' ? d.body : '',
    tag: typeof d.tag === 'string' ? d.tag : undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: eigenerPfad(d.url) }
  }))
})

self.addEventListener('notificationclick', function (e) {
  e.notification.close()
  const ziel = eigenerPfad(e.notification.data && e.notification.data.url)
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (fenster) {
      for (const f of fenster) {
        if (new URL(f.url).pathname.indexOf(ziel) === 0 && 'focus' in f) return f.focus()
      }
      return self.clients.openWindow(ziel)
    }))
})
`
}
