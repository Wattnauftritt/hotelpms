import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { DbContext, Pool } from '@hotelpms/db'
import { FOLDER_TRANSLATION_LANGS, TRANSLATION_MAX_ATTEMPTS, folderTextFromDeeplXml,
         folderTextToDeeplXml } from '@hotelpms/domain'
import { TranslationError, type TranslateOptions,
         type Translator } from '../jobs/staffTranslation.js'
import { translateFolderPages } from '../jobs/folderTranslation.js'
import { TickBreaker } from '../jobs/breaker.js'

/**
 * Uebersetzung der Hausseiten fuer die Gaestemappe (0144) mit einem
 * untergeschobenen Uebersetzer: die Datenbank ist echt, DeepL nicht.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let chef: number

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(4)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  chef = (await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })).userId
  await owner.query(
    `INSERT INTO guest_folder_setting (property_id, enabled) VALUES ($1, true)`, [fx.propertyId])
})

/** Setzt `[lang]` vor jedes Element, laesst das XML sonst stehen. */
function falscherUebersetzer(fehler?: () => Error | null): Translator & {
  anfragen: Array<{ target: string; opts: TranslateOptions | undefined; texts: string[] }> } {
  const u = {
    anfragen: [] as Array<{ target: string; opts: TranslateOptions | undefined; texts: string[] }>,
    async translate(texts: string[], target: string, opts?: TranslateOptions) {
      u.anfragen.push({ target, opts, texts })
      const f = fehler?.() ?? null
      if (f !== null) throw f
      return texts.map(t => ({
        text: t.replace(/(<z(?: l="1")?>)/g, `$1[${target}] `), detectedSource: 'DE' }))
    }
  }
  return u
}

async function seite(title: string, body: string, position: number | null = 1): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO terminal_content (property_id, title, body, folder_position)
     VALUES ($1, $2, $3, $4) RETURNING id::int`, [fx.propertyId, title, body, position])
  return r.rows[0]!.id
}

const zeilen = async () => (await owner.query<{
  content_id: number; lang: string; title: string | null; body: string | null
  origin: string | null; attempts: number; last_error: string | null }>(
  `SELECT content_id::int, lang, title, body, origin, attempts, last_error
     FROM terminal_content_translation ORDER BY content_id, lang`)).rows

describe('Format einer Seite fuer DeepL', () => {
  it('kommt Zeile fuer Zeile zurueck, mit Aufzaehlung, Fettem und Absaetzen', () => {
    const text = 'Frühstück **7 bis 10 Uhr**\n\n- Brötchen & Kaffee\n- Eier <frisch>\nEnde'
    const xml = folderTextToDeeplXml(text)
    expect(xml).toBe('<z>Frühstück <b>7 bis 10 Uhr</b></z>\n<z></z>\n'
      + '<z l="1">Brötchen &amp; Kaffee</z>\n<z l="1">Eier &lt;frisch&gt;</z>\n<z>Ende</z>')
    expect(folderTextFromDeeplXml(xml, 5)).toBe(text)
    // Eine Antwort mit einer Zeile zu wenig ist nicht zuzuordnen.
    expect(folderTextFromDeeplXml('<z>a</z>', 2)).toBeNull()
  })
})

describe('translateFolderPages', () => {
  it('uebersetzt jede Seite der Mappe in jede Sprache der Mappe, mit Deutsch als Quelle', async () => {
    const id = await seite('Frühstück', '- **7** bis 10 Uhr')
    await seite('Nur am Terminal', 'x', null)
    const u = falscherUebersetzer()
    const r = await translateFolderPages(app, ctx, fx.propertyId, u)
    // Alle Sprachen der Mappe ohne die deutsche Vorlage (0145, 0150).
    expect(FOLDER_TRANSLATION_LANGS).toHaveLength(32)
    expect(FOLDER_TRANSLATION_LANGS).not.toContain('de')
    expect(r).toEqual({ attempted: 32, done: 32, retrying: 0, failed: 0 })
    // Ein Aufruf je Sprache, Titel und Text darin.
    expect(u.anfragen.map(a => a.target)).toEqual([...FOLDER_TRANSLATION_LANGS])
    expect(u.anfragen[0]!.opts).toEqual({ source: 'de', xml: true })
    expect(u.anfragen[0]!.texts).toHaveLength(2)
    const z = await zeilen()
    expect(z.map(x => [x.content_id, x.lang, x.origin])).toEqual(
      [...FOLDER_TRANSLATION_LANGS].sort().map(l => [id, l, 'machine']))
    const pl = z.find(x => x.lang === 'pl')!
    expect(pl.title).toBe('[pl] Frühstück')
    expect(pl.body).toBe('- [pl] **7** bis 10 Uhr')

    // Im naechsten Tick ist nichts mehr faellig.
    expect((await translateFolderPages(app, ctx, fx.propertyId, u)).attempted).toBe(0)
  })

  it('uebersetzt neu, wenn die deutsche Seite sich aendert, und laesst Handarbeit zur selben Fassung', async () => {
    const id = await seite('Frühstück', '7 bis 10 Uhr')
    const u = falscherUebersetzer()
    await translateFolderPages(app, ctx, fx.propertyId, u)
    await owner.query(
      `UPDATE terminal_content_translation SET title = 'Breakfast', body = 'from 7',
              origin = 'manual', updated_by = $2 WHERE content_id = $1 AND lang = 'en'`,
      [id, chef])
    expect((await translateFolderPages(app, ctx, fx.propertyId, u)).attempted).toBe(0)

    await owner.query(`UPDATE terminal_content SET body = '7:30 bis 10 Uhr' WHERE id = $1`, [id])
    const r = await translateFolderPages(app, ctx, fx.propertyId, u)
    expect(r.done).toBe(32)
    const en = (await zeilen()).find(x => x.lang === 'en')!
    expect(en).toMatchObject({ origin: 'machine', body: '[en] 7:30 bis 10 Uhr' })
  })

  it('uebersetzt nichts, solange die Mappe aus ist', async () => {
    await seite('Frühstück', '7 bis 10 Uhr')
    await owner.query(`UPDATE guest_folder_setting SET enabled = false`)
    const u = falscherUebersetzer()
    expect((await translateFolderPages(app, ctx, fx.propertyId, u)).attempted).toBe(0)
    expect(u.anfragen).toEqual([])
  })

  it('versucht es spaeter noch einmal und gibt nach dem letzten Versuch auf', async () => {
    await seite('Frühstück', '7 bis 10 Uhr')
    const u = falscherUebersetzer(() => new TranslationError('http_400'))
    for (let i = 1; i <= TRANSLATION_MAX_ATTEMPTS; i++) {
      const r = await translateFolderPages(app, ctx, fx.propertyId, u, { baseDelaySeconds: 0 })
      expect(r.attempted).toBe(32)
      expect(r.failed).toBe(i === TRANSLATION_MAX_ATTEMPTS ? 32 : 0)
      await owner.query(`UPDATE terminal_content_translation SET next_at = now()`)
    }
    expect((await translateFolderPages(app, ctx, fx.propertyId, u)).attempted).toBe(0)
    const z = await zeilen()
    expect(z.every(x => x.title === null && x.last_error === 'http_400'
      && x.attempts === TRANSLATION_MAX_ATTEMPTS)).toBe(true)
  })

  it('verbraucht keinen Versuch, wenn die Sicherung schon ausgeloest hat', async () => {
    await seite('Frühstück', '7 bis 10 Uhr')
    const breaker = new TickBreaker(1)
    const u = falscherUebersetzer(() => new TranslationError('http_503'))
    const r = await translateFolderPages(app, ctx, fx.propertyId, u, { breaker })
    // Der erste Aufruf (en) scheitert und loest aus; die anderen Sprachen werden nicht gefragt.
    expect(r).toMatchObject({ attempted: 1, retrying: 1 })
    expect(u.anfragen).toHaveLength(1)
    const z = await zeilen()
    expect(z.find(x => x.lang === 'nl')!.attempts).toBe(0)
  })
})
