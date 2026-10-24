import type { Pool } from '@hotelpms/db'
import type { Principal } from './context.js'

/**
 * Koeder kennzeichnen (Migration 0213, Bedrohungsanalyse 23.10.2026, E5).
 *
 * Gespeichert ist die Adresse des Koedergastes als `<tag>@<domain>`. Jede
 * Ausgabe ersetzt sie durch eine Fassung, die den Aufrufer nennt:
 * `<tag>-c<ref>@` fuer einen Maschinenzugang, `<tag>-u<id>@` fuer einen
 * Menschen, `<tag>-e<id>@` fuer dessen Mandantenexport. Kommt an eine davon
 * Post, steht im Namen der Weg, auf dem die Daten hinausgingen; kommt sie
 * an die gespeicherte, war es die Datenbank oder eine Sicherung.
 *
 * Ersetzt wird im Text der Antwort, nicht in jeder Abfrage: der naechste
 * Endpunkt, der Gaeste liefert, kaeme sonst ohne Kennzeichnung dazu.
 */

const NEU_LADEN_MS = 5 * 60_000

let stand: { tags: string[]; geladen: number } = { tags: [], geladen: 0 }
let laden: Promise<void> | null = null

async function neuLaden(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tag: string; domain: string }>(
    'SELECT tag, domain FROM decoy_tags()')
  stand = { tags: rows.map(r => `${r.tag}@${r.domain}`), geladen: Date.now() }
}

/** Nach Anlegen oder Entfernen: sofort, nicht erst in fuenf Minuten. */
export async function koederNeuLaden(pool: Pool): Promise<void> {
  await neuLaden(pool)
}

/** Die gespeicherten Adressen, hoechstens fuenf Minuten alt. */
export async function koederAdressen(pool: Pool): Promise<readonly string[]> {
  if (Date.now() - stand.geladen > NEU_LADEN_MS) {
    laden ??= neuLaden(pool).finally(() => { laden = null })
    await laden
  }
  return stand.tags
}

/** Wer im Namen der Adresse steht. */
export function koederKennung(p: Principal | undefined, art: 'api' | 'export'): string | null {
  if (p === undefined) return null
  if (p.clientKey.startsWith('client:')) {
    return `c${p.clientKey.slice(7).toLowerCase().replace(/[^a-z0-9]/g, '')}`
  }
  if (p.userId !== null) return `${art === 'export' ? 'e' : 'u'}${p.userId}`
  if (p.terminalDeviceId !== null) return `t${p.terminalDeviceId}`
  return null
}

/** Ersetzt jede gespeicherte Koederadresse im Text durch die Fassung des Aufrufers. */
export function koederErsetzen(text: string, adressen: readonly string[], kennung: string): string {
  let aus = text
  for (const a of adressen) {
    if (!aus.includes(a)) continue
    const at = a.indexOf('@')
    aus = aus.split(a).join(`${a.slice(0, at)}-${kennung}${a.slice(at)}`)
  }
  return aus
}

/** Fuer einen Wert, der gleich zu JSON wird. Unveraendert, wenn nichts darin steht. */
export function koederInWert<T>(wert: T, adressen: readonly string[], kennung: string | null): T {
  if (kennung === null || adressen.length === 0) return wert
  const text = JSON.stringify(wert)
  if (text === undefined || !adressen.some(a => text.includes(a))) return wert
  return JSON.parse(koederErsetzen(text, adressen, kennung)) as T
}
