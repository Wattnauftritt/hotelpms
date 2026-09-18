import type { FastifyInstance } from 'fastify'
import { businessDateFor } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'
import { supportPermissions, type SupportLevel } from '../platform/support.js'
import { einmalTokenUndPost } from './auth.js'
import { kennung } from './platform.js'

/**
 * Das Adminpanel, zweiter Teil: die Handgriffe des Supports.
 *
 * Der erste Teil (platform.ts) zeigt Kunden, Haeuser und Benutzer und konnte
 * mit dem haeufigsten Anruf nichts anfangen -- "Frau X kommt nicht mehr
 * rein". Zu sehen war, dass sie gesperrt ist; zu tun war nichts. Hier steht,
 * was am Telefon gebraucht wird: entsperren, einen Zugangslink schicken,
 * Sitzungen beenden, einen Benutzer einladen, ein zweites Haus anlegen --
 * und die Aufsicht darueber, wer von uns wann in wessen Daten war.
 *
 * **Der Grundsatz bleibt.** Kein Gast, keine Buchung, kein Umsatz. Alles
 * hier betrifft Zugaenge und Stammdaten des Kunden, nicht seine Gaeste.
 */

interface SitzungZeile {
  id: number; account_id: number; account_name: string
  platform_user_id: number; staff_name: string; granted_by_name: string | null
  level: SupportLevel; reason: string; is_emergency: boolean
  requested_at: string; granted_at: string | null; expires_at: string
  revoked_at: string | null
}

/** Zustand fuer die Anzeige. Abgeleitet, nicht gespeichert: sonst altert er. */
function zustand(z: SitzungZeile, jetzt: number): string {
  if (z.revoked_at !== null) return 'revoked'
  if (Date.parse(z.expires_at) <= jetzt) return 'expired'
  return z.granted_at !== null ? 'active' : 'pending'
}

function sitzungNachAussen(z: SitzungZeile, jetzt: number): Record<string, unknown> {
  return {
    id: z.id, accountId: z.account_id, accountName: z.account_name,
    staffName: z.staff_name, grantedByName: z.granted_by_name,
    level: z.level, reason: z.reason, isEmergency: z.is_emergency,
    requestedAt: z.requested_at, grantedAt: z.granted_at,
    expiresAt: z.expires_at, revokedAt: z.revoked_at,
    state: zustand(z, jetzt),
    permissions: [...supportPermissions(z.level)].sort()
  }
}

/**
 * Gehoert dieser Benutzer zu diesem Kunden?
 *
 * Ueber platform_account_users(), nicht ueber eine eigene Abfrage: die
 * Funktion prueft das Recht selbst, und sie ist die eine Stelle, die sagt,
 * wer "zum Kunden gehoert". Ohne diese Frage waere jede Route hier der Weg,
 * mit einer beliebigen Kennung einen Benutzer eines **anderen** Kunden zu
 * entsperren oder abzumelden.
 */
async function benutzerDesKunden(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }> },
  accountId: number, userId: number
): Promise<{ id: number; email: string; display_name: string; status: string }> {
  const r = await client.query<{ id: number; email: string; display_name: string
                                 status: string }>(
    `SELECT id, email, display_name, status
       FROM platform_account_users($1) WHERE id = $2`, [accountId, userId])
  if (r.rowCount === 0) throw Errors.notFound('platform.userNotFound')
  return r.rows[0]!
}

/** Rollen, die das Panel an einen Kundenbenutzer vergeben darf. */
const ACCOUNT_ROLLEN = ['owner', 'account_admin', 'accounting', 'revenue',
  'tax_advisor', 'read_only'] as const
const HAUS_ROLLEN = ['hotel_director', 'front_office_mgr', 'reception',
  'reservations', 'night_audit', 'housekeeping', 'maintenance'] as const

export function platformSupportRoutes(app: FastifyInstance): void {
  /*
   * Entsperren.
   *
   * Ein Benutzer sperrt sich nach zu vielen Fehlversuchen selbst aus
   * (locked_until), und dasselbe gibt es getrennt fuer den Arbeitsplatz-PIN
   * (0035). Beides laeuft von allein ab -- aber "in zwanzig Minuten" ist am
   * Telefon die falsche Antwort, wenn an der Rezeption ein Gast steht.
   *
   * Kein Kennwort wird angefasst. Wer es vergessen hat, bekommt den Link
   * (unten); wer es weiss und nur die Sperre losbekommen will, braucht sonst
   * nichts.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/users/:userId/unlock',
    permission: 'platform:accounts',
    summary: 'Sperre nach Fehlversuchen aufheben',
    handler: async (req) => {
      const accountId = kennung(req)
      const userId = kennung(req, 'userId')
      return tx(req.pool, req, async client => {
        await benutzerDesKunden(client, accountId, userId)
        await client.query(
          `UPDATE app_user
              SET failed_login_count = 0, locked_until = NULL,
                  workstation_pin_failed_count = 0,
                  workstation_pin_locked_until = NULL,
                  updated_at = now()
            WHERE id = $1`, [userId])
        return { id: userId, unlocked: true }
      })
    }
  })

  /*
   * Einen Zugangslink schicken.
   *
   * Dieselbe Route fuer zwei Faelle, weil es am Telefon derselbe Satz ist:
   * "Ich schicke Ihnen einen Link." Ein Benutzer, der noch nie drin war
   * (`invited`), bekommt die Einladung erneut -- die erste ist nach sieben
   * Tagen verfallen oder im Spam gelandet. Ein aktiver bekommt die
   * Kennwort-Ruecksetzung. Beide Male dasselbe Einmaltoken, derselbe Weg
   * wie beim Selbstbedienungsfall ("Kennwort vergessen").
   *
   * Kein Kennwort im Klartext, nie: das ginge durch ein Telefonat oder einen
   * Chat und bliebe dort stehen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/users/:userId/access-link',
    permission: 'platform:accounts',
    summary: 'Einladung erneut oder Kennwort-Link schicken',
    handler: async (req, reply) => {
      const accountId = kennung(req)
      const userId = kennung(req, 'userId')
      const principal = req.principal as Principal
      const art = await tx(req.pool, req, async client => {
        const u = await benutzerDesKunden(client, accountId, userId)
        if (u.status === 'disabled') throw Errors.conflict('platform.userDisabled')
        const kind = u.status === 'invited' ? 'invite' : 'password_reset'
        await einmalTokenUndPost(client, {
          userId, name: u.display_name, email: u.email, kind,
          createdBy: principal.userId
        })
        return kind
      })
      reply.status(202)
      return { id: userId, kind: art }
    }
  })

  /*
   * Alle Sitzungen eines Benutzers beenden.
   *
   * Der Fall dahinter ist nicht der Alltag, sondern der Vorfall: ein
   * Mitarbeiter ist gegangen und sein Rechner steht noch angemeldet an der
   * Rezeption, oder ein Kennwort ist unterwegs. Der Kunde kann das heute
   * selbst nicht -- die Rollen nehmen ist der Weg, aber die laufende Sitzung
   * behaelt ihren Principal bis zum naechsten Aufbau.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/users/:userId/sessions/revoke',
    permission: 'platform:accounts',
    summary: 'Alle Sitzungen eines Benutzers beenden',
    handler: async (req) => {
      const accountId = kennung(req)
      const userId = kennung(req, 'userId')
      return tx(req.pool, req, async client => {
        await benutzerDesKunden(client, accountId, userId)
        const r = await client.query(
          `UPDATE user_session SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL`, [userId])
        return { id: userId, revoked: r.rowCount ?? 0 }
      })
    }
  })

  /*
   * Einen Benutzer beim Kunden einladen.
   *
   * **Der Befund dahinter.** Der Kunde kann heute keinen zweiten Benutzer
   * anlegen: es gibt nur die Rollenvergabe fuer Benutzer, die im Account
   * schon bekannt sind (users.ts) -- und bekannt wird man nur durch das
   * Onboarding. Ein Haus mit einer neuen Rezeptionistin hatte also keinen
   * Weg ausser einem Anruf bei uns, und wir hatten keinen ausser SQL.
   *
   * Entweder eine Account-Rolle (Inhaber, Buchhaltung ...) oder eine Rolle
   * in **einem** Haus. Das Haus muss zum Kunden gehoeren; die Frage stellt
   * platform_account_properties(), nicht diese Route.
   *
   * Eine vorhandene Adresse wird abgewiesen, auch wenn sie zu einem anderen
   * Kunden gehoert -- **gerade** dann. Ein Benutzer, der in zwei Betrieben
   * arbeitet, ist ein Fall fuer die Rollenvergabe des Kunden, nicht fuer
   * eine Route, mit der sich Kennungen fremder Betriebe erraten liessen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/users',
    permission: 'platform:accounts',
    summary: 'Benutzer beim Kunden anlegen und einladen',
    handler: async (req, reply) => {
      const accountId = kennung(req)
      const b = (req.body ?? {}) as {
        email?: string; displayName?: string; roleKey?: string
        propertyId?: number | null }
      const email = String(b.email ?? '').trim().toLowerCase()
      const name = String(b.displayName ?? '').trim()
      const roleKey = String(b.roleKey ?? '')
      const propertyId = b.propertyId == null ? null : Number(b.propertyId)
      const principal = req.principal as Principal

      const fehler: Record<string, string[]> = {}
      if (!email || !email.includes('@')) fehler.email = ['field.invalid']
      if (!name) fehler.displayName = ['field.required']
      const hausRolle = (HAUS_ROLLEN as readonly string[]).includes(roleKey)
      const accountRolle = (ACCOUNT_ROLLEN as readonly string[]).includes(roleKey)
      if (!hausRolle && !accountRolle) fehler.roleKey = ['field.invalid']
      if (hausRolle && (propertyId === null || !Number.isInteger(propertyId))) {
        fehler.propertyId = ['field.required']
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      const angelegt = await tx(req.pool, req, async client => {
        const konto = await client.query(
          `SELECT 1 FROM platform_accounts() WHERE id = $1`, [accountId])
        if (konto.rowCount === 0) throw Errors.notFound('platform.accountNotFound')

        if (hausRolle) {
          const haus = await client.query(
            `SELECT 1 FROM platform_account_properties($1) WHERE id = $2`,
            [accountId, propertyId])
          if (haus.rowCount === 0) {
            throw Errors.validation({ propertyId: ['field.invalid'] })
          }
        }

        const da = await client.query(
          `SELECT 1 FROM app_user WHERE lower(email) = $1`, [email])
        if (da.rowCount !== 0) throw Errors.conflict('platform.userExists')

        const rolle = await client.query<{ id: number }>(
          `SELECT id FROM role
            WHERE key = $1 AND account_id IS NULL AND level = $2`,
          [roleKey, hausRolle ? 'property' : 'account'])
        if (rolle.rowCount === 0) {
          throw Errors.validation({ roleKey: ['field.invalid'] })
        }

        const u = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO app_user (email, display_name, status)
           VALUES ($1, $2, 'invited') RETURNING id, public_ref`, [email, name])
        const userId = u.rows[0]!.id

        if (hausRolle) {
          await client.query(
            `INSERT INTO user_property_role (user_id, property_id, role_id, granted_by)
             VALUES ($1, $2, $3, $4)`,
            [userId, propertyId, rolle.rows[0]!.id, principal.userId])
        } else {
          await client.query(
            `INSERT INTO user_account_role (user_id, account_id, role_id)
             VALUES ($1, $2, $3)`, [userId, accountId, rolle.rows[0]!.id])
        }

        await einmalTokenUndPost(client, {
          userId, name, email, kind: 'invite', createdBy: principal.userId
        })
        return u.rows[0]!
      })

      reply.status(201)
      return { id: angelegt.id, ref: angelegt.public_ref, email,
               displayName: name, roleKey, propertyId, status: 'invited' }
    }
  })

  /*
   * Ein weiteres Haus.
   *
   * Dieselben Pflichtangaben wie beim Anlegen des Kunden (§ 14 UStG), und
   * der Geschaeftstag wird hier gerechnet, nicht in SQL -- die Regel haengt
   * an Zeitzone und rollover_time und steht schon in businessDateFor().
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/properties',
    permission: 'platform:accounts',
    summary: 'Weiteres Haus beim Kunden anlegen',
    handler: async (req, reply) => {
      const accountId = kennung(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const s = (k: string) => String(b[k] ?? '').trim()

      const fehler: Record<string, string[]> = {}
      for (const feld of ['code', 'name']) if (!s(feld)) fehler[feld] = ['field.required']
      const rechnungsfaehig = ['addressLine1', 'postalCode', 'city', 'taxNumber']
        .every(k => s(k) !== '')
      if (!rechnungsfaehig) {
        for (const feld of ['addressLine1', 'postalCode', 'city', 'taxNumber']) {
          fehler[feld] = ['onboarding.invoiceDataRequired']
        }
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      const timezone = s('timezone') || 'Europe/Berlin'
      const geschaeftstag = businessDateFor(new Date(), timezone, '04:00')

      const propertyId = await tx(req.pool, req, async client => {
        const doppelt = await client.query(
          `SELECT 1 FROM platform_account_properties($1) WHERE code = $2`,
          [accountId, s('code')])
        if (doppelt.rowCount !== 0) throw Errors.conflict('platform.propertyCodeTaken')

        const r = await client.query<{ platform_property_add: number }>(
          `SELECT platform_property_add($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date)`,
          [accountId, s('code'), s('name'), s('addressLine1'), s('postalCode'),
           s('city'), (s('country') || 'DE').toUpperCase(), s('taxNumber'),
           s('vatId') || null, timezone, (s('currency') || 'EUR').toUpperCase(),
           b.isTraining === true, geschaeftstag])
        return r.rows[0]!.platform_property_add
      })

      reply.status(201)
      return { accountId, propertyId, code: s('code') }
    }
  })

  /*
   * Die Support-Sitzungen eines Kunden -- fuer die Kundenkarte.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/accounts/:id/support-sessions',
    permission: 'platform:support_session',
    summary: 'Support-Sitzungen eines Kunden',
    handler: async (req) => {
      const accountId = kennung(req)
      const jetzt = Date.now()
      const rows = await tx(req.pool, req, client =>
        client.query<SitzungZeile>(
          `SELECT * FROM platform_account_support_sessions($1)`, [accountId]))
      return { sessions: rows.rows.map(z => sitzungNachAussen(z, jetzt)) }
    }
  })

  /*
   * Die Aufsicht: alle Sitzungen, aller Kollegen.
   *
   * Hinter platform:staff, nicht platform:support_session: Art. 5 Abs. 2
   * DSGVO verlangt, dass der Auftragsverarbeiter nachweisen kann, was er
   * getan hat -- und ein Nachweis, den nur der Handelnde selbst sieht, ist
   * keiner.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/support-audit',
    permission: 'platform:staff',
    summary: 'Alle Support-Sitzungen (Aufsicht)',
    handler: async (req) => {
      const jetzt = Date.now()
      const rows = await tx(req.pool, req, client =>
        client.query<SitzungZeile>(`SELECT * FROM platform_support_sessions()`))
      return { sessions: rows.rows.map(z => sitzungNachAussen(z, jetzt)) }
    }
  })

  /*
   * Was in einer Sitzung geschrieben wurde -- Zahlen je Tabelle.
   *
   * Die Funktion entscheidet selbst, wer das sehen darf: der Admin oder
   * der, dessen Sitzung es ist. Das Recht an der Route ist deshalb das
   * schwaechere der beiden; wer es hat und nicht der Handelnde ist, bekommt
   * eine leere Liste, keine fremde.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/support-sessions/:id/activity',
    permission: 'platform:support_session',
    summary: 'Aenderungen unter einer Support-Sitzung, gezaehlt je Tabelle',
    handler: async (req) => {
      const id = kennung(req)
      const rows = await tx(req.pool, req, client =>
        client.query<{ table_name: string; action: string; n: string }>(
          `SELECT * FROM platform_session_activity($1)`, [id]))
      return {
        sessionId: id,
        activity: rows.rows.map(r => ({
          table: r.table_name, action: r.action, count: Number(r.n)
        }))
      }
    }
  })

  /*
   * Rolle eines Plattformbenutzers aendern.
   *
   * Ersetzend: ein Plattformbenutzer hat genau eine Rolle. Die eigene Rolle
   * aendert niemand -- wer sich vom Admin zum Support macht, kann es nicht
   * zurueckdrehen, und wer der letzte Admin ist, laesst niemanden zurueck,
   * der es koennte.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/platform/staff/:id/role',
    permission: 'platform:staff',
    summary: 'Rolle eines Plattformbenutzers festlegen',
    handler: async (req) => {
      const id = kennung(req)
      const roleKey = String((req.body as { roleKey?: string } | undefined)?.roleKey ?? '')
      const principal = req.principal as Principal
      if (id === principal.userId) throw Errors.conflict('platform.staffSelf')

      return tx(req.pool, req, async client => {
        const u = await client.query(
          `SELECT 1 FROM app_user WHERE id = $1 AND is_platform_staff`, [id])
        if (u.rowCount === 0) throw Errors.notFound('platform.staffNotFound')

        const rolle = await client.query<{ id: number }>(
          `SELECT id FROM role
            WHERE key = $1 AND account_id IS NULL AND level = 'platform'`, [roleKey])
        if (rolle.rowCount === 0) throw Errors.validation({ roleKey: ['field.invalid'] })

        if (roleKey !== 'platform_admin') {
          const uebrig = await client.query<{ n: string }>(
            `SELECT count(*) AS n
               FROM app_user u
               JOIN user_platform_role upr ON upr.user_id = u.id
               JOIN role r ON r.id = upr.role_id
              WHERE u.is_platform_staff AND u.status = 'active'
                AND r.key = 'platform_admin' AND u.id <> $1`, [id])
          if (Number(uebrig.rows[0]!.n) === 0) {
            throw Errors.conflict('platform.staffLastAdmin')
          }
        }

        await client.query(`DELETE FROM user_platform_role WHERE user_id = $1`, [id])
        await client.query(
          `INSERT INTO user_platform_role (user_id, role_id) VALUES ($1, $2)`,
          [id, rolle.rows[0]!.id])
        return { id, roleKey }
      })
    }
  })

  /*
   * Einladung an einen Plattformbenutzer erneut schicken.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/staff/:id/access-link',
    permission: 'platform:staff',
    summary: 'Einladung oder Kennwort-Link an Plattformbenutzer schicken',
    handler: async (req, reply) => {
      const id = kennung(req)
      const principal = req.principal as Principal
      const art = await tx(req.pool, req, async client => {
        const u = await client.query<{ email: string; display_name: string; status: string }>(
          `SELECT email, display_name, status FROM app_user
            WHERE id = $1 AND is_platform_staff`, [id])
        if (u.rowCount === 0) throw Errors.notFound('platform.staffNotFound')
        const z = u.rows[0]!
        if (z.status === 'disabled') throw Errors.conflict('platform.userDisabled')
        const kind = z.status === 'invited' ? 'invite' : 'password_reset'
        await einmalTokenUndPost(client, {
          userId: id, name: z.display_name, email: z.email, kind,
          createdBy: principal.userId
        })
        return kind
      })
      reply.status(202)
      return { id, kind: art }
    }
  })
}
