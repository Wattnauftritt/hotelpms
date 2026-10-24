import { describe, it, expect, afterEach, vi } from 'vitest'
import { BESTAETIGUNG_FEHLT } from '@hotelpms/contracts'
import { api, ApiError } from '../lib/api.js'
import { bestaetigungAnmelden } from '../lib/bestaetigung.js'

/**
 * Eine kritische Handlung ohne frische Bestaetigung fragt nach dem
 * Kennwort und laeuft danach **einmal** erneut (Migration 0209). Der
 * Bildschirm, der sie ausloest, bekommt davon nichts mit.
 */

const verlangt = () => new Response(JSON.stringify({
  type: BESTAETIGUNG_FEHLT, title: 'Bitte bestaetigen', status: 403 }), { status: 403 })

afterEach(() => { vi.unstubAllGlobals() })

describe('Bestaetigung in der Oberflaeche', () => {
  it('fragt einmal und sendet dieselbe Anfrage erneut', async () => {
    const rumpfe: string[] = []
    let n = 0
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      rumpfe.push(String(init.body))
      return ++n === 1 ? verlangt() : new Response('{"ok":true}', { status: 200 })
    })
    let gefragt = 0
    const ab = bestaetigungAnmelden(async () => { gefragt++; return true })
    try {
      await expect(api.put('/v1/x', { iban: 'DE89' })).resolves.toEqual({ ok: true })
    } finally { ab() }
    expect(gefragt).toBe(1)
    expect(rumpfe).toEqual(['{"iban":"DE89"}', '{"iban":"DE89"}'])
  })

  it('bleibt bei der Meldung, wenn abgebrochen wird, und fragt nicht im Kreis', async () => {
    let n = 0
    vi.stubGlobal('fetch', async () => { n++; return verlangt() })
    const ab = bestaetigungAnmelden(async () => false)
    try {
      const e = await api.put('/v1/x', {}).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).problem.type).toBe(BESTAETIGUNG_FEHLT)
    } finally { ab() }
    expect(n).toBe(1)

    // Auch nach einem Ja wird nur einmal wiederholt.
    n = 0
    const ab2 = bestaetigungAnmelden(async () => true)
    try {
      await expect(api.put('/v1/x', {})).rejects.toBeInstanceOf(ApiError)
    } finally { ab2() }
    expect(n).toBe(2)
  })
})
