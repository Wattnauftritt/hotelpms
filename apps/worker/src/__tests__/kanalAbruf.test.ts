import { describe, it, expect } from 'vitest'
import { kanalAbruf, kanalAdresse, KANAL_HOECHSTENS_BYTES } from '../channel/abruf.js'

/**
 * Ausgehend nur zu festen Zielen, mit Grenzen (Bedrohungsanalyse
 * 23.10.2026, T10). Ohne Netz: der Abruf ist austauschbar.
 */
describe('Kanalabruf', () => {
  it('bleibt beim festen Ziel des Anbieters', () => {
    expect(kanalAdresse('channex', 'bookings?x=1').href)
      .toBe('https://app.channex.io/api/v1/bookings?x=1')
    for (const pfad of ['https://evil.example/x', '//evil.example/x', '../../admin',
                        'http:x', '\\\\evil']) {
      expect(() => kanalAdresse('channex', pfad), pfad).toThrow('channel.badTarget')
    }
  })

  it('folgt keiner Weiterleitung und bricht eine zu grosse Antwort ab', async () => {
    let gesehen: RequestInit | undefined
    const klein: typeof fetch = async (_u, init) => {
      gesehen = init
      return new Response('{"ok":true}', { status: 200 })
    }
    const r = await kanalAbruf('channex-staging', 'ping', {}, klein)
    expect(r).toEqual({ status: 200, text: '{"ok":true}' })
    expect(gesehen?.redirect).toBe('error')
    expect(gesehen?.signal).toBeInstanceOf(AbortSignal)

    const riesig: typeof fetch = async () =>
      new Response(new Uint8Array(KANAL_HOECHSTENS_BYTES + 1), { status: 200 })
    await expect(kanalAbruf('channex', 'bookings', {}, riesig))
      .rejects.toThrow('channel.responseTooLarge')
  })
})
