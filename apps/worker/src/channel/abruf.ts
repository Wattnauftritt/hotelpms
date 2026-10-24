import { AdapterError } from '@hotelpms/domain'

/**
 * Der einzige Weg, auf dem ein Kanaladapter ins Netz geht (Bedrohungsanalyse
 * 23.10.2026, T10).
 *
 * **Feste Ziele.** Die Adresse des Anbieters steht hier im Code, nicht in
 * den Zugangsdaten. Stuende sie dort, waere `credentials` ein Feld, mit dem
 * jeder, der einen Kanalzugang anlegen darf, den Worker beliebige Adressen
 * abrufen liesse -- auch `169.254.169.254` oder die Datenbank am selben
 * Rechner (SSRF). Ein Adapter nennt nur noch Anbieter und Pfad.
 *
 * **Grenzen.** Keine Weiterleitung (sie fuehrte zu einem Ziel, das hier
 * nicht steht), eine Zeitgrenze je Anfrage und hoechstens 4 MB Antwort, wie
 * beim Preiskalender. Ein Anbieter, der haengt oder ohne Ende liefert, haelt
 * sonst den Nachtlauf an.
 */

export const KANAL_ZIELE = {
  channex: 'https://app.channex.io/api/v1/',
  'channex-staging': 'https://staging.channex.io/api/v1/'
} as const satisfies Record<string, `https://${string}/`>

export type KanalZiel = keyof typeof KANAL_ZIELE

export const KANAL_ZEITGRENZE_MS = 20_000
export const KANAL_HOECHSTENS_BYTES = 4 * 1024 * 1024

/** Die volle Adresse zu einem Pfad. Ein Pfad, der das Ziel verlaesst, wird abgewiesen. */
export function kanalAdresse(ziel: KanalZiel, pfad: string): URL {
  const basis = new URL(KANAL_ZIELE[ziel])
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(pfad)) throw new AdapterError('channel.badTarget')
  const url = new URL(pfad.replace(/^\/+/, ''), basis)
  if (url.origin !== basis.origin || !url.pathname.startsWith(basis.pathname)) {
    throw new AdapterError('channel.badTarget')
  }
  return url
}

export interface KanalAntwort {
  status: number
  /** Der Rumpf als Text, hoechstens `KANAL_HOECHSTENS_BYTES`. */
  text: string
}

/**
 * Eine Anfrage an den Anbieter. `abruf` ist fuer Tests austauschbar; im
 * Betrieb `fetch`.
 */
export async function kanalAbruf(
  ziel: KanalZiel, pfad: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  abruf: typeof fetch = fetch
): Promise<KanalAntwort> {
  const url = kanalAdresse(ziel, pfad)
  let res: Response
  try {
    res = await abruf(url, { ...init, redirect: 'error',
                             signal: AbortSignal.timeout(KANAL_ZEITGRENZE_MS) })
  } catch (e) {
    throw new AdapterError('channel.unreachable', e)
  }
  const laenge = Number(res.headers.get('content-length') ?? '0')
  if (laenge > KANAL_HOECHSTENS_BYTES) {
    await res.body?.cancel()
    throw new AdapterError('channel.responseTooLarge')
  }
  return { status: res.status, text: await begrenztLesen(res) }
}

/** Liest den Rumpf und bricht ab, sobald er die Grenze ueberschreitet. */
async function begrenztLesen(res: Response): Promise<string> {
  if (res.body === null) return ''
  const leser = res.body.getReader()
  const teile: Uint8Array[] = []
  let n = 0
  try {
    for (;;) {
      const { done, value } = await leser.read()
      if (done) break
      n += value.byteLength
      if (n > KANAL_HOECHSTENS_BYTES) {
        await leser.cancel()
        throw new AdapterError('channel.responseTooLarge')
      }
      teile.push(value)
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e
    throw new AdapterError('channel.unreachable', e)
  }
  return new TextDecoder().decode(Buffer.concat(teile))
}
