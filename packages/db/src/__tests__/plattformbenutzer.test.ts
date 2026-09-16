import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { ensureSchema, truncateAll, ownerPool } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { plattformbenutzerAnlegen } from '../cli/plattformbenutzer.js'

/**
 * Der erste Plattformbenutzer.
 *
 * Geprueft wird vor allem, was das Skript **nicht** tut. Es ist die eine
 * Stelle, an der ein Versehen Plattformrechte vergibt, und die teuren
 * Fehler daran sind still: ein Benutzer ohne is_platform_staff kann sich
 * anmelden und sieht nichts, und wer den Fehler dort sucht, sucht in den
 * Berechtigungen.
 */

let owner: Pool
const umgebung = { ...process.env }

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
})
afterAll(async () => { await owner.end() })

beforeEach(async () => {
  await truncateAll()
  delete process.env.PLATTFORM_EMAIL
  delete process.env.PLATTFORM_PASSWORD
  delete process.env.PLATTFORM_ROLLE
  delete process.env.PLATTFORM_NAME
  process.exitCode = 0
})
afterEach(() => {
  process.env = { ...umgebung }
  process.exitCode = 0
})

async function anlegen(env: Record<string, string>): Promise<number | undefined> {
  Object.assign(process.env, env)
  await plattformbenutzerAnlegen()
  return process.exitCode
}

describe('Plattformbenutzer anlegen', () => {
  it('legt ihn mit Plattformkennzeichen und Rolle an', async () => {
    expect(await anlegen({
      PLATTFORM_EMAIL: 'betrieb@wir.de',
      PLATTFORM_PASSWORD: 'ein-langes-kennwort'
    })).toBe(0)

    const u = await owner.query<{ id: number; is_platform_staff: boolean
                                  status: string; password_hash: string | null }>(
      `SELECT id, is_platform_staff, status, password_hash FROM app_user`)
    expect(u.rows).toHaveLength(1)
    // Ohne das Kennzeichen kann er sich anmelden und sieht nichts -- und der
    // Fehler wird in den Berechtigungen gesucht.
    expect(u.rows[0]!.is_platform_staff).toBe(true)
    expect(u.rows[0]!.status).toBe('active')
    // Argon2id, nicht Klartext und nicht irgendein Hash.
    expect(u.rows[0]!.password_hash).toMatch(/^\$argon2id\$/)

    const r = await owner.query<{ key: string }>(
      `SELECT ro.key FROM user_platform_role upr
         JOIN role ro ON ro.id = upr.role_id WHERE upr.user_id = $1`,
      [u.rows[0]!.id])
    expect(r.rows.map(z => z.key)).toEqual(['platform_admin'])
  })

  it('gibt ihm keinen Mandanten und kein Haus', async () => {
    await anlegen({ PLATTFORM_EMAIL: 'betrieb@wir.de',
                    PLATTFORM_PASSWORD: 'ein-langes-kennwort' })
    // Plattformpersonal sieht Kundendaten ausschliesslich ueber eine
    // freigegebene Support-Sitzung. Eine Account- oder Hausrolle hier waere
    // genau die stille Uebernahme, die der Entwurf ausschliesst.
    expect((await owner.query(`SELECT 1 FROM user_account_role`)).rowCount).toBe(0)
    expect((await owner.query(`SELECT 1 FROM user_property_role`)).rowCount).toBe(0)
  })

  it('erhoeht einen vorhandenen Benutzer nicht nachtraeglich', async () => {
    await owner.query(
      `INSERT INTO app_user (email, display_name, status)
       VALUES ('inhaber@kunde.de','Inhaber','active')`)

    expect(await anlegen({
      PLATTFORM_EMAIL: 'inhaber@kunde.de',
      PLATTFORM_PASSWORD: 'ein-langes-kennwort'
    })).toBe(1)

    // Das waere der Weg, auf dem ein Kundenzugang unbemerkt zu einem
    // Plattformzugang wird -- etwa wenn jemand die Adresse eines Hoteliers
    // eintippt.
    const u = await owner.query<{ is_platform_staff: boolean }>(
      `SELECT is_platform_staff FROM app_user WHERE email = 'inhaber@kunde.de'`)
    expect(u.rows[0]!.is_platform_staff).toBe(false)
    expect((await owner.query(`SELECT 1 FROM user_platform_role`)).rowCount).toBe(0)
  })

  it('weist ein zu kurzes Kennwort ab, bevor etwas entsteht', async () => {
    expect(await anlegen({ PLATTFORM_EMAIL: 'b@wir.de', PLATTFORM_PASSWORD: 'kurz' }))
      .toBe(1)
    expect((await owner.query(`SELECT 1 FROM app_user`)).rowCount).toBe(0)
  })

  it('weist eine unbekannte Rolle ab', async () => {
    expect(await anlegen({
      PLATTFORM_EMAIL: 'b@wir.de', PLATTFORM_PASSWORD: 'ein-langes-kennwort',
      PLATTFORM_ROLLE: 'chef'
    })).toBe(1)
    expect((await owner.query(`SELECT 1 FROM app_user`)).rowCount).toBe(0)
  })

  it('nimmt eine andere Plattformrolle an', async () => {
    // Nicht jeder im Betrieb braucht platform_admin.
    expect(await anlegen({
      PLATTFORM_EMAIL: 'support@wir.de', PLATTFORM_PASSWORD: 'ein-langes-kennwort',
      PLATTFORM_ROLLE: 'platform_support'
    })).toBe(0)
    const r = await owner.query<{ key: string }>(
      `SELECT ro.key FROM user_platform_role upr
         JOIN role ro ON ro.id = upr.role_id`)
    expect(r.rows.map(z => z.key)).toEqual(['platform_support'])
  })

  it('verlangt eine Adresse', async () => {
    expect(await anlegen({})).toBe(1)
    expect((await owner.query(`SELECT 1 FROM app_user`)).rowCount).toBe(0)
  })
})
