import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { DbContext, Pool } from '@hotelpms/db'
import { TRANSLATION_MAX_ATTEMPTS, type StaffTextLang } from '@hotelpms/domain'
import { translateStaffTexts, TranslationError,
         type Translator } from '../jobs/staffTranslation.js'

/**
 * Der Uebersetzungslauf (0112, Baustein 7) mit einem untergeschobenen
 * Uebersetzer -- die Datenbank ist echt, DeepL nicht: geprueft wird, was
 * wir mit der Antwort tun, nicht was DeepL antwortet.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let kraft: number

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
  kraft = (await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })).userId
})

/** Haengt `[de]` an und tut, als waere alles russisch -- ausser Deutschem. */
function falscherUebersetzer(fehler?: () => Error | null): Translator & { aufrufe: string[] } {
  const aufrufe: string[] = []
  return {
    aufrufe,
    async translate(text: string, target: StaffTextLang) {
      aufrufe.push(`${target}:${text}`)
      const f = fehler?.() ?? null
      if (f !== null) throw f
      const deutsch = /^[A-Za-z ]+$/.test(text)
      return { text: `[${target}] ${text}`, detectedSource: deutsch ? 'DE' : 'RU' }
    }
  }
}

async function eintrag(text: string): Promise<number> {
  const { rows } = await owner.query<{ id: number }>(
    `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind, description,
                                   minutes, created_by)
     VALUES ($1, $2, '2026-10-01', 'extra', $3, 20, $2) RETURNING id::int`,
    [fx.propertyId, kraft, text])
  await owner.query(
    `INSERT INTO staff_text_job (property_id, source_kind, source_id, targets)
     VALUES ($1, 'work_entry', $2, '{de}')`, [fx.propertyId, rows[0]!.id])
  return rows[0]!.id
}

const uebersetzungen = async () => (await owner.query<{ source_id: number; text: string
                                                        origin: string; source_lang: string }>(
  `SELECT source_id::int, text, origin, source_lang FROM staff_text_translation
    ORDER BY source_id`)).rows

describe('translateStaffTexts', () => {
  it('uebersetzt, laesst Deutsches ohne Zeile und erledigt den Auftrag', async () => {
    const ru = await eintrag('Сложила бельё')
    await eintrag('Waesche gelegt')
    const u = falscherUebersetzer()
    const r = await translateStaffTexts(app, ctx, fx.propertyId, u)
    expect(r).toEqual({ attempted: 2, done: 2, retrying: 0, failed: 0 })
    expect(await uebersetzungen()).toEqual([
      { source_id: ru, text: '[de] Сложила бельё', origin: 'machine', source_lang: 'ru' }])
    const offen = await owner.query(`SELECT 1 FROM staff_text_job WHERE status <> 'done'`)
    expect(offen.rowCount).toBe(0)
    // Ein zweiter Lauf findet nichts mehr.
    expect((await translateStaffTexts(app, ctx, fx.propertyId, u)).attempted).toBe(0)
  })

  it('ueberschreibt eine Berichtigung von Hand nur, wenn sich der Text geaendert hat', async () => {
    const id = await eintrag('Сложила бельё')
    await owner.query(
      `INSERT INTO staff_text_translation (property_id, source_kind, source_id, source_hash,
                                           lang, text, origin)
       VALUES ($1, 'work_entry', $2, digest('Сложила бельё', 'sha256'), 'de',
               'Bettwaesche gelegt', 'manual')`, [fx.propertyId, id])
    await translateStaffTexts(app, ctx, fx.propertyId, falscherUebersetzer())
    expect((await uebersetzungen())[0]).toMatchObject({ text: 'Bettwaesche gelegt', origin: 'manual' })

    await owner.query(`UPDATE staff_work_entry SET description = 'Сложила полотенца' WHERE id = $1`, [id])
    await owner.query(`UPDATE staff_text_job SET status = 'pending', attempts = 0, next_at = now()`)
    await translateStaffTexts(app, ctx, fx.propertyId, falscherUebersetzer())
    expect((await uebersetzungen())[0]).toMatchObject({
      text: '[de] Сложила полотенца', origin: 'machine' })
  })

  it('wiederholt mit Abstand und gibt nach dem letzten Versuch auf, ohne Text im Fehler', async () => {
    await eintrag('Сложила бельё')
    const u = falscherUebersetzer(() => new TranslationError('http_503'))
    for (let i = 1; i <= TRANSLATION_MAX_ATTEMPTS; i++) {
      await owner.query(`UPDATE staff_text_job SET next_at = now()`)
      const r = await translateStaffTexts(app, ctx, fx.propertyId, u)
      expect(r[i < TRANSLATION_MAX_ATTEMPTS ? 'retrying' : 'failed']).toBe(1)
    }
    const { rows } = await owner.query<{ status: string; attempts: number; last_error: string }>(
      'SELECT status, attempts, last_error FROM staff_text_job')
    expect(rows[0]).toEqual({ status: 'failed', attempts: TRANSLATION_MAX_ATTEMPTS,
                              last_error: 'http_503' })
    expect(await uebersetzungen()).toEqual([])
  })

  it('erledigt einen Auftrag ohne Quelle, ohne DeepL zu fragen', async () => {
    await owner.query(
      `INSERT INTO staff_text_job (property_id, source_kind, source_id, targets)
       VALUES ($1, 'inspection_note', 999999, '{ru}')`, [fx.propertyId])
    const u = falscherUebersetzer()
    expect(await translateStaffTexts(app, ctx, fx.propertyId, u)).toMatchObject({ done: 1 })
    expect(u.aufrufe).toEqual([])
  })

  it('sieht keine Auftraege eines anderen Hauses', async () => {
    await eintrag('Сложила бельё')
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const r = await translateStaffTexts(app,
      { accountIds: [fremd.accountId], propertyIds: [fremd.propertyId], userId: null },
      fremd.propertyId, falscherUebersetzer())
    expect(r.attempted).toBe(0)
  })
})
