import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { DbContext, Pool } from '@hotelpms/db'
import { TRANSLATION_MAX_ATTEMPTS, type StaffTextLang } from '@hotelpms/domain'
import { translateStaffTexts, TranslationError,
         type Translator } from '../jobs/staffTranslation.js'
import { TickBreaker } from '../jobs/breaker.js'

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
function falscherUebersetzer(fehler?: () => Error | null): Translator & {
  aufrufe: string[]; anfragen: number } {
  const u = {
    aufrufe: [] as string[],
    anfragen: 0,
    async translate(texts: string[], target: StaffTextLang) {
      u.anfragen++
      for (const text of texts) u.aufrufe.push(`${target}:${text}`)
      const f = fehler?.() ?? null
      if (f !== null) throw f
      return texts.map(text => ({
        text: `[${target}] ${text}`,
        detectedSource: /^[A-Za-z ]+$/.test(text) ? 'DE' : 'RU' }))
    }
  }
  return u
}

async function eintrag(text: string, targets = '{de}'): Promise<number> {
  const { rows } = await owner.query<{ id: number }>(
    `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind, description,
                                   minutes, created_by)
     VALUES ($1, $2, '2026-10-01', 'extra', $3, 20, $2) RETURNING id::int`,
    [fx.propertyId, kraft, text])
  await owner.query(
    `INSERT INTO staff_text_job (property_id, source_kind, source_id, targets)
     VALUES ($1, 'work_entry', $2, $3::text[])`, [fx.propertyId, rows[0]!.id, targets])
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

  it('fragt DeepL einmal je Zielsprache, nicht einmal je Auftrag', async () => {
    await eintrag('Сложила бельё')
    await eintrag('Помыла окна')
    await eintrag('Убрала номер', '{de,en}')
    const u = falscherUebersetzer()
    const r = await translateStaffTexts(app, ctx, fx.propertyId, u)
    expect(r).toMatchObject({ attempted: 3, done: 3 })
    expect(u.anfragen).toBe(2)
    expect((await uebersetzungen()).map(x => x.text).sort()).toEqual([
      '[de] Помыла окна', '[de] Сложила бельё', '[de] Убрала номер', '[en] Убрала номер'])
  })

  /**
   * Befund 9: ein toter Dienst soll den Tick nicht fuer alle Haeuser
   * aufhalten. Nach dem Ausloesen wird nicht mehr gefragt, und was nicht
   * gefragt wurde, verliert keinen Versuch.
   */
  it('fragt nach ausgeloester Sicherung nicht weiter und gibt Ungefragtes zurueck', async () => {
    const a = await eintrag('Сложила бельё', '{de}')
    const b = await eintrag('Помыла окна', '{en}')
    const breaker = new TickBreaker(1)
    const u = falscherUebersetzer(() => new TranslationError('network'))
    const r = await translateStaffTexts(app, ctx, fx.propertyId, u, { breaker })
    expect(breaker.tripped()).toBe(true)
    expect(u.anfragen).toBe(1)
    expect(r).toMatchObject({ attempted: 1, retrying: 1 })

    const { rows } = await owner.query<{ source_id: number; status: string; attempts: number
                                         faellig: boolean }>(
      `SELECT source_id::int, status, attempts, next_at <= now() AS faellig
         FROM staff_text_job ORDER BY source_id`)
    expect(rows).toEqual([
      { source_id: a, status: 'pending', attempts: 1, faellig: false },
      { source_id: b, status: 'pending', attempts: 0, faellig: true }])

    // Im selben Tick fragt auch das naechste Haus nicht mehr.
    expect((await translateStaffTexts(app, ctx, fx.propertyId, u, { breaker })).attempted)
      .toBe(0)
    expect(u.anfragen).toBe(1)
  })

  it('zaehlt einen abgelehnten Text nicht als Ausfall des Dienstes', async () => {
    await eintrag('Сложила бельё')
    const breaker = new TickBreaker(1)
    await translateStaffTexts(app, ctx, fx.propertyId,
      falscherUebersetzer(() => new TranslationError('http_400')), { breaker })
    expect(breaker.tripped()).toBe(false)
  })
})
