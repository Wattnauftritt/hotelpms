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
type Behandler = (e: { request: Abruf; respondWith: (p: Promise<unknown>) => void
                       waitUntil: (p: Promise<unknown>) => void }) => void

function worker(netz: 'an' | 'aus') {
  const speicher = new Map<string, Map<string, string>>()
  const behandler = new Map<string, Behandler>()
  const abrufe: string[] = []
  const fetch = (r: Abruf | string): Promise<string> => {
    const url = typeof r === 'string' ? r : r.url
    abrufe.push(new URL(url, 'https://app.staygrid.cloud').pathname)
    return netz === 'an' ? Promise.resolve('netz:' + url) : Promise.reject(new TypeError('offline'))
  }
  const caches = {
    open: (name: string) => {
      const c = speicher.get(name) ?? new Map<string, string>()
      speicher.set(name, c)
      return Promise.resolve({
        addAll: (urls: string[]) => { urls.forEach(u => c.set(u, 'gespeichert:' + u))
                                      return Promise.resolve() },
        match: (r: Abruf | string) => Promise.resolve(
          c.get(typeof r === 'string' ? r : new URL(r.url).pathname))
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
  runInNewContext(serviceWorkerQuelle(['assets/index-abc.js'], 'v1'),
    { self, caches, fetch, URL, Promise, Response: { error: () => 'fehler' } })

  const ereignis = async (art: string, request?: Abruf) => {
    let antwort: Promise<unknown> | undefined
    let warten: Promise<unknown> | undefined
    behandler.get(art)!({ request: request!, respondWith: p => { antwort = p },
                          waitUntil: p => { warten = p } })
    await warten
    return antwort === undefined ? undefined : await antwort
  }
  const abruf = (pfad: string, mode = 'cors', method = 'GET'): Abruf =>
    ({ url: 'https://app.staygrid.cloud' + pfad, method, mode })
  return { ereignis, abruf, speicher, abrufe }
}

describe('Service Worker', () => {
  it('speichert die Huelle und sonst nichts', async () => {
    const w = worker('an')
    await w.ereignis('install')
    expect([...w.speicher.get('staygrid-huelle-v1')!.keys()])
      .toEqual(['/', '/assets/index-abc.js'])
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
