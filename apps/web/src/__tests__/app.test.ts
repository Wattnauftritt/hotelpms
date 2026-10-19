import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { StaygridNative } from '@hotelpms/native'

/**
 * Die Oberflaeche in der eigenen App (Plan app/plan.md, Bausteine 1 und 3).
 *
 * Festgehalten wird der Weg, den die Bruecke vorgibt: im Browser bleibt alles
 * beim Cookie, in der App geht jeder Abruf an die Herkunft der Schnittstelle
 * mit dem Token aus dem Schluesselbund und ohne Cookies, und Abmelden nimmt
 * das Token auch dann vom Telefon, wenn der Server nicht antwortet.
 */

interface Abruf { url: string; init: RequestInit }
let abrufe: Abruf[]
let antwort: () => Response
const g = globalThis as { window?: unknown; fetch: typeof fetch }
const echtesFetch = g.fetch

function bruecke(anfangs: string | null): StaygridNative & { ablage: { token: string | null } } {
  const ablage = { token: anfangs }
  return {
    plattform: 'ios', huelle: 1, api: 'https://app.staygrid.cloud', ablage,
    sitzung: {
      lesen: async () => ablage.token,
      speichern: async t => { ablage.token = t },
      loeschen: async () => { ablage.token = null }
    }
  }
}

beforeEach(() => {
  vi.resetModules()
  abrufe = []
  antwort = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  g.fetch = (async (url: string, init: RequestInit = {}) => {
    abrufe.push({ url, init })
    return antwort()
  }) as typeof fetch
})
afterEach(() => {
  g.fetch = echtesFetch
  delete g.window
})

const kopf = (a: Abruf, name: string): string | null => new Headers(a.init.headers).get(name)

describe('Schnittstelle in der App', () => {
  it('bleibt im Browser beim Cookie unter derselben Herkunft', async () => {
    g.window = {}
    const { api } = await import('../lib/api.js')
    await api.get('/v1/auth/me')
    expect(abrufe[0]!.url).toBe('/v1/auth/me')
    expect(abrufe[0]!.init.credentials).toBe('same-origin')
    expect(kopf(abrufe[0]!, 'authorization')).toBeNull()
  })

  it('meldet sich mit Token an und schickt es danach mit', async () => {
    const b = bruecke(null)
    g.window = { staygridNative: b }
    const { api, anmelden } = await import('../lib/api.js')

    antwort = () => new Response(JSON.stringify({ ok: true, token: 'sga_abc' }), { status: 200 })
    await anmelden('rez@test.de', 'kennwort')
    expect(abrufe[0]!.url).toBe('https://app.staygrid.cloud/v1/auth/login')
    expect(JSON.parse(String(abrufe[0]!.init.body))).toMatchObject({ client: 'app' })
    expect(b.ablage.token).toBe('sga_abc')

    antwort = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    await api.get('/v1/auth/me')
    expect(abrufe[1]!.url).toBe('https://app.staygrid.cloud/v1/auth/me')
    expect(kopf(abrufe[1]!, 'authorization')).toBe('Bearer sga_abc')
    expect(abrufe[1]!.init.credentials).toBe('omit')
  })

  it('nimmt beim Start das Token aus dem Schluesselbund', async () => {
    g.window = { staygridNative: bruecke('sga_vorher') }
    const { apiFetch } = await import('../lib/api.js')
    await apiFetch('/v1/invoices/abc/pdf')
    expect(kopf(abrufe[0]!, 'authorization')).toBe('Bearer sga_vorher')
  })

  it('nimmt das Token beim Abmelden auch ohne Antwort vom Telefon', async () => {
    const b = bruecke('sga_weg')
    g.window = { staygridNative: b }
    const { abmelden } = await import('../lib/api.js')
    g.fetch = (async () => { throw new TypeError('offline') }) as typeof fetch
    await expect(abmelden()).rejects.toThrow('offline')
    expect(b.ablage.token).toBeNull()
  })
})
