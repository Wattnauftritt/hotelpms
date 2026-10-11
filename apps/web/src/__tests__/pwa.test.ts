import { describe, it, expect } from 'vitest'
import { runInNewContext } from 'node:vm'
import { serviceWorkerQuelle } from '../pwa/serviceWorker.js'

/**
 * Der Service Worker, ausgefuehrt gegen nachgebaute Browserschnittstellen.
 *
 * Geprueft wird das eine, was teuer waere: dass er nie eine Antwort der
 * Schnittstelle anfasst. Ein Worker, der `/v1` zwischenspeichert, zeigte
 * der Rezeption einen alten Stand als neuen und hielte Gastdaten im
 * Browser, die nach dem Abmelden niemand mehr loescht (Dokument 33).
 */

type Abruf = { url: string; method: string; mode: string }
type Behandler = (e: { request: Abruf; data?: unknown; respondWith: (p: Promise<unknown>) => void
                       waitUntil: (p: Promise<unknown>) => void }) => void

/*
 * Eine Antwort, wie der Worker sie sieht: `ok`, `clone()`, und der Text in
 * `body`, damit die Pruefungen lesen koennen, woher sie kam.
 */
interface Antwort { ok: boolean; body: string; clone: () => Antwort }
const antwort = (body: string, ok = true): Antwort =>
  ({ ok, body, clone: () => antwort(body, ok) })

const HUELLE = {
  grund: ['/', '/assets/index-abc.js'],
  apps: {
    rezeption: ['/', '/assets/main-rez.js', '/assets/tape-rez.js', '/assets/styles-x.css'],
    personal: ['/', '/assets/main-per.js', '/assets/styles-x.css']
  }
}

function worker(netz: 'an' | 'aus') {
  const speicher = new Map<string, Map<string, Antwort>>()
  const behandler = new Map<string, Behandler>()
  const abrufe: string[] = []
  const fetch = (r: Abruf | string): Promise<Antwort> => {
    const url = typeof r === 'string' ? r : r.url
    abrufe.push(new URL(url, 'https://app.staygrid.cloud').pathname)
    return netz === 'an' ? Promise.resolve(antwort('netz:' + url))
      : Promise.reject(new TypeError('offline'))
  }
  const pfad = (r: Abruf | string): string =>
    typeof r === 'string' ? r : new URL(r.url).pathname
  const caches = {
    open: (name: string) => {
      const c = speicher.get(name) ?? new Map<string, Antwort>()
      speicher.set(name, c)
      return Promise.resolve({
        // Unabhaengig von `netz`: "aus" steht fuer ein Geraet, das den
        // Worker mit Netz installiert hat und jetzt ohne laeuft.
        addAll: (urls: string[]) => {
          urls.forEach(u => abrufe.push(u))
          urls.forEach(u => c.set(u, antwort('gespeichert:' + u)))
          return Promise.resolve()
        },
        put: (r: Abruf | string, a: Antwort) => {
          c.set(pfad(r), antwort('gespeichert:' + a.body))
          return Promise.resolve()
        },
        match: (r: Abruf | string) => Promise.resolve(c.get(pfad(r)))
      })
    },
    keys: () => Promise.resolve([...speicher.keys()]),
    delete: (n: string) => Promise.resolve(speicher.delete(n))
  }
  const self = {
    location: { origin: 'https://app.staygrid.cloud' },
    addEventListener: (art: string, f: Behandler) => behandler.set(art, f),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() }
  }
  runInNewContext(serviceWorkerQuelle(HUELLE, 'v1'),
    { self, caches, fetch, URL, Promise, Object, Response: { error: () => antwort('fehler', false) } })

  /*
   * Ein Ereignis ausloesen und warten, bis alles erledigt ist -- auch was
   * der Worker innerhalb von `respondWith` noch mit `waitUntil` anhaengt.
   */
  const ereignis = async (art: string, request?: Abruf, data?: unknown) => {
    let ergebnis: Promise<unknown> | undefined
    const warten: Array<Promise<unknown>> = []
    behandler.get(art)!({ request: request!, data, respondWith: p => { ergebnis = p },
                          waitUntil: p => { warten.push(p) } })
    const r = ergebnis === undefined ? undefined : await ergebnis
    await Promise.all(warten)
    return r === undefined ? undefined : (r as Antwort).body
  }
  const abruf = (pfad: string, mode = 'cors', method = 'GET'): Abruf =>
    ({ url: 'https://app.staygrid.cloud' + pfad, method, mode })
  const gespeichert = (): string[] =>
    [...(speicher.get('staygrid-huelle-v1')?.keys() ?? [])].sort()
  return { ereignis, abruf, speicher, abrufe, gespeichert }
}

describe('Service Worker', () => {
  /*
   * Beim Installieren nur der Grund. Vorher lud der Worker hier jede Datei
   * des Baus -- auf jedes Geraet, das die Seite je oeffnete
   * (Performance-Audit 11.10.2026, Befund 11).
   */
  it('speichert beim Installieren nur die Seite und den Einstieg', async () => {
    const w = worker('an')
    await w.ereignis('install')
    expect(w.gespeichert()).toEqual(['/', '/assets/index-abc.js'])
  })

  it('laedt je Anwendung nur deren Dateien vor, auf Zuruf der Seite', async () => {
    const w = worker('an')
    await w.ereignis('install')
    await w.ereignis('message', undefined, { vorladen: 'personal' })
    expect(w.gespeichert()).toEqual(
      ['/', '/assets/index-abc.js', '/assets/main-per.js', '/assets/styles-x.css'])
    // Dasselbe Geraet oeffnet danach die Rezeption: deren Dateien kommen dazu.
    await w.ereignis('message', undefined, { vorladen: 'rezeption' })
    expect(w.gespeichert()).toEqual(['/', '/assets/index-abc.js', '/assets/main-per.js',
      '/assets/main-rez.js', '/assets/styles-x.css', '/assets/tape-rez.js'])
  })

  it('holt beim erneuten Zuruf nur, was noch fehlt', async () => {
    const w = worker('an')
    await w.ereignis('install')
    await w.ereignis('message', undefined, { vorladen: 'personal' })
    w.abrufe.length = 0
    await w.ereignis('message', undefined, { vorladen: 'personal' })
    expect(w.abrufe).toEqual([])
  })

  it('kennt nur die Anwendungen aus dem Bau', async () => {
    const w = worker('an')
    await w.ereignis('install')
    for (const data of [{ vorladen: 'toString' }, { vorladen: 'gast' }, null, 'rezeption']) {
      await w.ereignis('message', undefined, data)
    }
    expect(w.gespeichert()).toEqual(['/', '/assets/index-abc.js'])
  })

  it('legt eine Datei unter /assets/ beim ersten Abruf ab', async () => {
    const w = worker('an')
    await w.ereignis('install')
    expect(await w.ereignis('fetch', w.abruf('/assets/rates-neu.js')))
      .toBe('netz:https://app.staygrid.cloud/assets/rates-neu.js')
    expect(w.gespeichert()).toContain('/assets/rates-neu.js')
    w.abrufe.length = 0
    expect(await w.ereignis('fetch', w.abruf('/assets/rates-neu.js')))
      .toBe('gespeichert:netz:https://app.staygrid.cloud/assets/rates-neu.js')
    expect(w.abrufe).toEqual([])
  })

  it('laesst die Schnittstelle unberuehrt, mit und ohne Netz', async () => {
    for (const netz of ['an', 'aus'] as const) {
      const w = worker(netz)
      await w.ereignis('install')
      // `undefined`: kein respondWith, der Browser geht selbst ans Netz.
      expect(await w.ereignis('fetch', w.abruf('/v1/auth/me'))).toBeUndefined()
      expect(await w.ereignis('fetch', w.abruf('/v1/reservations?q=Meier'))).toBeUndefined()
      // Auch ein Seitenaufruf unter /v1 -- die Zahlungsseite des Gastes.
      expect(await w.ereignis('fetch', w.abruf('/v1/pay?t=x', 'navigate'))).toBeUndefined()
      expect(await w.ereignis('fetch', w.abruf('/v1/reservations', 'cors', 'POST')))
        .toBeUndefined()
    }
  })

  it('holt Seiten zuerst vom Netz, damit eine Auslieferung sofort ankommt', async () => {
    const w = worker('an')
    await w.ereignis('install')
    expect(await w.ereignis('fetch', w.abruf('/tagesgeschaeft', 'navigate')))
      .toBe('netz:https://app.staygrid.cloud/tagesgeschaeft')
  })

  it('zeigt ohne Netz die gespeicherte Huelle', async () => {
    const w = worker('aus')
    await w.ereignis('install')
    expect(await w.ereignis('fetch', w.abruf('/tagesgeschaeft', 'navigate')))
      .toBe('gespeichert:/')
  })

  it('wirft beim Wechsel den Speicher der alten Fassung weg', async () => {
    const w = worker('an')
    w.speicher.set('staygrid-huelle-alt', new Map())
    w.speicher.set('fremd', new Map())
    await w.ereignis('activate')
    expect([...w.speicher.keys()].sort()).toEqual(['fremd'])
  })
})

describe('Service Worker: Push (Baustein 8)', () => {
  function pushWorker() {
    const behandler = new Map<string, (e: unknown) => void>()
    const gezeigt: Array<{ titel: string; opts: { body: string; tag?: string
                                                  data: { url: string } } }> = []
    const geoeffnet: string[] = []
    const self = {
      location: { origin: 'https://app.staygrid.cloud' },
      addEventListener: (art: string, f: (e: unknown) => void) => behandler.set(art, f),
      registration: { showNotification: (titel: string, opts: never) => {
        gezeigt.push({ titel, opts }); return Promise.resolve() } },
      clients: { matchAll: () => Promise.resolve([]),
                 openWindow: (u: string) => { geoeffnet.push(u); return Promise.resolve() } }
    }
    runInNewContext(serviceWorkerQuelle({ grund: [], apps: {} }, 'v1'),
      { self, caches: {}, fetch, URL, Promise })
    const ausloesen = async (art: string, e: Record<string, unknown>) => {
      let warten: Promise<unknown> | undefined
      behandler.get(art)!({ ...e, waitUntil: (p: Promise<unknown>) => { warten = p } })
      await warten
    }
    return { ausloesen, gezeigt, geoeffnet }
  }

  it('zeigt an, was kommt, und fuehrt nie nach draussen', async () => {
    const w = pushWorker()
    const daten = (d: unknown) => ({ data: { json: () => d } })
    await w.ausloesen('push', daten({ title: 'Zimmer 101 ist frei', body: 'Los',
                                      url: '/personal', tag: 'room_free-101' }))
    await w.ausloesen('push', daten({ title: 'x', body: 'y', url: 'https://boese.example/' }))
    await w.ausloesen('push', daten({ title: 'x', body: 'y', url: '//boese.example/' }))
    expect(w.gezeigt.map(g => [g.titel, g.opts.tag, g.opts.data.url])).toEqual([
      ['Zimmer 101 ist frei', 'room_free-101', '/personal'],
      ['x', undefined, '/personal'], ['x', undefined, '/personal']])
    await w.ausloesen('notificationclick',
      { notification: { close: () => undefined, data: { url: '/personal' } } })
    expect(w.geoeffnet).toEqual(['/personal'])
  })
})
