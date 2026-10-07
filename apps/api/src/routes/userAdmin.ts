import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { einmalTokenUndPost, einmalLink } from './auth.js'

/**
 * Der Kunde verwaltet sein Personal selbst.
 *
 * **Der Befund.** users.ts konnte Rollen aendern -- fuer Menschen, die es im
 * Account schon gab. Bekannt wurde man nur durch das Onboarding oder ueber
 * unser Adminpanel. Jede neue Rezeptionistin war damit ein Anruf bei uns;
 * bei hundert Haeusern sind wir dann keine Plattform mehr, sondern deren
 * Personalabteilung.
 *
 * **So autark wie moeglich, so eingeschraenkt wie noetig.** Zwei Ebenen, zwei
 * Rechte, und die Grenze dazwischen ist das Eigentliche:
 *
 * - `user:manage` am Haus: einladen, Hausrollen vergeben, entsperren, Link
 *   schicken, Name aendern, sperren, entfernen -- fuer Menschen, deren
 *   Rollen **im Haus** liegen.
 * - `settings:account` am Betrieb: dasselbe fuer Menschen mit einer Rolle
 *   fuer den ganzen Betrieb (Inhaber, Buchhaltung, Steuerberatung), und die
 *   Vergabe dieser Rollen.
 *
 * Ohne diese Grenze koennte eine Hoteldirektion den Inhaber aussperren. Mit
 * ihr kann sie es nicht -- und der Inhaber kann sich nicht selbst
 * aussperren, weil der letzte Mensch mit `settings:account` bleibt. Er ist
 * der, der Support-Sitzungen freigibt; ohne ihn bliebe der Betrieb stumm.
 *
 * **Was "sperren" hier heisst.** Die Sperre haengt am Paar (Kunde, Benutzer),
 * nicht am Benutzer (Migration 0040): eine Aushilfe in zwei Betrieben darf
 * vom einen gesperrt werden, ohne dass der andere sie verliert -- und ohne
 * dass der eine vom anderen erfaehrt. Deshalb steht hier nirgends
 * `app_user.status = 'disabled'`, ausser wenn ein Entfernter nirgends mehr
 * eine Rolle hat.
 *
 * **Die Mandantengrenze ist von Hand gezogen.** app_user, role und die
 * Rollentabellen tragen keine Zeilenrichtlinie; jede Abfrage hier haengt an
 * der property_id aus dem Pfad -- die registerRoute gegen den Kontext prueft
 * -- oder an der daraus abgeleiteten account_id. Nie an einem Wert aus dem
 * Rumpf.
 */

interface Ziel {
  id: number
  /** Fehlt bei Personal ohne Mailadresse (Migration 0105). */
  email: string | null
  display_name: string
  status: string
  /** Hat eine Rolle fuer den ganzen Betrieb -- dann entscheidet settings:account. */
  hat_account_rolle: boolean
}

/**
 * Der Name des Kunden fuer Anrede und Betreff der Einladung. Ueber das Haus,
 * weil die Route im Kontext eines Hauses laeuft: die Zeile in `property` ist
 * damit sichtbar, die in `account` haengt am Kontext des Accounts.
 */
async function kundenName(client: PoolClient, propertyId: number): Promise<string | null> {
  const r = await client.query<{ name: string }>(
    `SELECT a.name FROM property p JOIN account a ON a.id = p.account_id
      WHERE p.id = $1`, [propertyId])
  return r.rows[0]?.name ?? null
}

async function hausUndAccount(client: PoolClient, propertyId: number): Promise<number> {
  const p = await client.query<{ account_id: number }>(
    `SELECT account_id FROM property WHERE id = $1`, [propertyId])
  if (p.rowCount === 0) throw Errors.notFound('res.property')
  return p.rows[0]!.account_id
}

/**
 * Der Benutzer, um den es geht -- und ob er zum Betrieb gehoert.
 *
 * "Gehoert" heisst: hat eine Rolle im Betrieb oder in einem seiner Haeuser.
 * Ohne diese Frage waere jede Route hier der Weg, mit einer erratenen
 * Kennung beim Nachbarn zu arbeiten. Die Antwort verraet nicht, ob es die
 * Kennung ueberhaupt gibt.
 */
async function benutzerImBetrieb(
  client: PoolClient, accountId: number, userRef: string
): Promise<Ziel> {
  const u = await client.query<Ziel>(
    `SELECT u.id, u.email, u.display_name, u.status,
            EXISTS (SELECT 1 FROM user_account_role uar
                     WHERE uar.user_id = u.id AND uar.account_id = $2) AS hat_account_rolle
       FROM app_user u
      WHERE u.public_ref = $1
        AND (EXISTS (SELECT 1 FROM user_account_role uar
                      WHERE uar.user_id = u.id AND uar.account_id = $2)
          OR EXISTS (SELECT 1 FROM user_property_role upr
                       JOIN property p ON p.id = upr.property_id
                      WHERE upr.user_id = u.id AND p.account_id = $2))`,
    [userRef, accountId])
  if (u.rowCount === 0) throw Errors.notFound('res.user')
  return u.rows[0]!
}

/**
 * Wer eine Rolle fuer den ganzen Betrieb traegt, wird nur von jemandem mit
 * settings:account angefasst. Sonst koennte die Hoteldirektion eines Hauses
 * den Inhaber sperren.
 */
function verlangtBetriebsrecht(ziel: Ziel, principal: Principal): void {
  if (ziel.hat_account_rolle && !principal.accountPermissions.has('settings:account')) {
    throw Errors.forbidden('user.accountRoleNeedsAccountRight')
  }
}

/**
 * Der letzte Mensch, der den Betrieb verwalten kann, bleibt.
 *
 * Er ist der, der Support-Sitzungen freigibt und Rollen fuer den Betrieb
 * vergibt. Ohne ihn koennte der Kunde weder sich selbst helfen noch uns
 * hereinlassen -- und dann sind wir wieder bei SQL.
 */
export async function nichtDenLetztenVerwalter(
  client: PoolClient, accountId: number, userId: number
): Promise<void> {
  const andere = await client.query<{ n: string }>(
    `SELECT count(DISTINCT u.id) AS n
       FROM app_user u
       JOIN user_account_role uar ON uar.user_id = u.id
       JOIN role_permission rp ON rp.role_id = uar.role_id
      WHERE uar.account_id = $1 AND rp.permission_key = 'settings:account'
        AND u.status = 'active' AND u.id <> $2
        AND NOT EXISTS (SELECT 1 FROM account_user_block b
                         WHERE b.account_id = $1 AND b.user_id = u.id)`,
    [accountId, userId])
  const selbst = await client.query(
    `SELECT 1 FROM user_account_role uar
       JOIN role_permission rp ON rp.role_id = uar.role_id
      WHERE uar.account_id = $1 AND uar.user_id = $2
        AND rp.permission_key = 'settings:account'`, [accountId, userId])
  if (selbst.rowCount !== 0 && Number(andere.rows[0]!.n) === 0) {
    throw Errors.conflict('user.lastAccountAdmin')
  }
}

/**
 * Der Benutzername, wie er gespeichert wird: klein, ohne Leerraum. Die Form
 * prueft die Datenbank (0105) noch einmal; hier steht sie, damit die
 * Meldung am Feld haengt und nicht als Constraint-Verletzung kommt.
 */
const BENUTZERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/

/**
 * Wie der Zugang die Person erreicht: per Mail, oder als Link, den die
 * Leitung persoenlich weitergibt -- als QR-Code am Handy oder als
 * Nachricht. Ohne Angabe per Mail, wenn es eine Adresse gibt.
 */
type Zustellung = 'email' | 'link'

/**
 * Rollen, deren Menschen in der Personal-App arbeiten und nicht in der
 * Oberflaeche der Rezeption. Wer nur solche Rollen hat, bekommt seinen
 * Zugangslink in die Personal-App -- dort ist die Seite in seiner Sprache.
 */
const PERSONALROLLEN = ['housekeeping_staff', 'kitchen']

async function nurPersonal(client: PoolClient, userId: number): Promise<boolean> {
  const r = await client.query<{ nur: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM user_property_role upr JOIN role ro ON ro.id = upr.role_id
        WHERE upr.user_id = $1 AND ro.key <> ALL($2::text[])
       UNION ALL
       SELECT 1 FROM user_account_role uar WHERE uar.user_id = $1) AS nur`,
    [userId, PERSONALROLLEN])
  return r.rows[0]!.nur
}

function zustellung(wert: unknown, hatMail: boolean): Zustellung {
  if (wert === undefined || wert === null) return hatMail ? 'email' : 'link'
  if (wert !== 'email' && wert !== 'link') {
    throw Errors.validation({ delivery: ['field.allowedValues'] }, { values: 'email, link' })
  }
  if (wert === 'email' && !hatMail) {
    throw Errors.validation({ delivery: ['user.noEmailForMail'] })
  }
  return wert
}

async function sitzungenBeenden(client: PoolClient, userId: number): Promise<number> {
  const r = await client.query(
    `UPDATE user_session SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`, [userId])
  return r.rowCount ?? 0
}

export function userAdminRoutes(app: FastifyInstance): void {
  /*
   * Einladen.
   *
   * Eine neue Adresse bekommt einen Zugang mit den gewaehlten Hausrollen und
   * eine Einladung; das Kennwort setzt die Person selbst.
   *
   * Gehoert die Adresse schon zum eigenen Betrieb, bekommt die Person die
   * Rollen in **diesem** Haus dazu, ohne neue Einladung. Frueher wurde sie
   * abgewiesen mit dem Rat, die Rollen zu aendern -- aber die Liste eines
   * Hauses zeigt nur, wer dort schon eine Rolle hat. Die Rezeptionistin aus
   * dem ersten Haus war im zweiten damit weder einzuladen noch zu finden.
   *
   * Gehoert sie einem anderen Kunden, bleibt es bei der Abweisung, mit
   * demselben Satz wie fuer jede vergebene Adresse: eine Route, die dann
   * anders antwortet, verriete, wer sonst noch Kunde ist.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/users',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Benutzer einladen, mit Rollen in diesem Haus',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { email?: string; username?: string; displayName?: string
                                       roleKeys?: string[]; delivery?: string }
      const email = String(b.email ?? '').trim().toLowerCase()
      const username = String(b.username ?? '').trim().toLowerCase()
      const name = String(b.displayName ?? '').trim()
      const principal = req.principal as Principal

      /*
       * Mailadresse **oder** Benutzername (Migration 0105). Das Personal
       * einer Zeitarbeitsfirma hat oft keine Adresse, und eine erfundene
       * waere schlimmer als keine: an sie ginge jede Ruecksetzung.
       */
      const fehler: Record<string, string[]> = {}
      if (!email && !username) fehler.username = ['user.needsEmailOrUsername']
      if (email && !email.includes('@')) fehler.email = ['field.invalid']
      if (username && !BENUTZERNAME.test(username)) fehler.username = ['field.username']
      if (!name) fehler.displayName = ['field.required']
      if (!Array.isArray(b.roleKeys) || b.roleKeys.length === 0) {
        fehler.roleKeys = ['field.roleKeyList']
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)
      const gewuenscht = [...new Set(b.roleKeys as string[])]
      const weg = zustellung(b.delivery, email !== '')

      const angelegt = await tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, propertyId)

        const rollen = await client.query<{ id: number; key: string }>(
          `SELECT id, key FROM role
            WHERE level = 'property' AND key = ANY($1::text[])
              AND (account_id IS NULL OR account_id = $2)`, [gewuenscht, accountId])
        if (rollen.rows.length !== gewuenscht.length) {
          const gefunden = new Set(rollen.rows.map(r => r.key))
          throw Errors.validation({ roleKeys: ['field.unknownRole'] },
            { values: gewuenscht.filter(k => !gefunden.has(k)).join(', ') })
        }

        /*
         * Gibt es die Person schon? Ueber die Adresse, wenn eine kam, sonst
         * ueber den Benutzernamen. Passt der Benutzername zu jemand
         * anderem als die Adresse, ist er vergeben -- sonst bekaeme der
         * Kollege mit diesem Namen die Rollen der neuen Kraft.
         */
        const da = await client.query<Ziel & { public_ref: string; im_betrieb: boolean
                                               username: string | null }>(
          `SELECT u.id, u.public_ref, u.email, u.username, u.display_name, u.status,
                  EXISTS (SELECT 1 FROM user_account_role uar
                           WHERE uar.user_id = u.id AND uar.account_id = $3) AS hat_account_rolle,
                  (EXISTS (SELECT 1 FROM user_account_role uar
                            WHERE uar.user_id = u.id AND uar.account_id = $3)
                   OR EXISTS (SELECT 1 FROM user_property_role upr
                               WHERE upr.user_id = u.id
                                 AND upr.property_id IN
                                     (SELECT id FROM account_active_properties($3)))) AS im_betrieb
             FROM app_user u
            WHERE ($1 <> '' AND lower(u.email) = $1)
               OR ($2 <> '' AND u.username = $2)`, [email, username, accountId])
        /*
         * Die anderen Haeuser ueber account_active_properties(), nicht ueber
         * einen Verbund mit `property`: dessen Zeilenrichtlinie zeigt nur die
         * Haeuser, in denen der Einladende selbst Rechte hat -- eine
         * Direktion nur ihr eigenes. Die Aushilfe aus dem Nachbarhaus waere
         * damit wieder "vergeben" gewesen.
         */
        if (da.rowCount !== 0) {
          const perMail = email !== '' ? da.rows.find(r => r.email === email) : undefined
          const ziel = perMail ?? da.rows[0]!
          // Zwei verschiedene Menschen, oder ein Name, der zu einer anderen
          // Adresse gehoert: der Name ist vergeben. Kommt eine bekannte
          // Adresse mit einem neuen Namen, bleibt es bei der bekannten
          // Person und ihrer Anmeldung; der Name wird nicht nachgetragen.
          if (da.rows.length > 1 || (perMail === undefined && email !== '')) {
            throw Errors.conflict('user.usernameTaken')
          }
          if (!ziel.im_betrieb) {
            if (perMail !== undefined) throw Errors.conflict('user.emailTaken')
            throw Errors.conflict('user.usernameTaken')
          }
          verlangtBetriebsrecht(ziel, principal)
          // Hinzu, nicht ersetzen: wer im Haus schon Rollen hat, verliert
          // durch eine zweite Einladung keine davon.
          await client.query(
            `INSERT INTO user_property_role (user_id, property_id, role_id, granted_by)
             SELECT $1, $2, unnest($3::bigint[]), $4
             ON CONFLICT DO NOTHING`,
            [ziel.id, propertyId, rollen.rows.map(r => r.id), principal.userId])
          return { ...ziel, hinzugefuegt: true as const, link: null }
        }

        const u = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO app_user (email, username, display_name, status)
           VALUES (NULLIF($1, ''), NULLIF($2, ''), $3, 'invited')
           RETURNING id, public_ref`, [email, username, name])
        await client.query(
          `INSERT INTO user_property_role (user_id, property_id, role_id, granted_by)
           SELECT $1, $2, unnest($3::bigint[]), $4`,
          [u.rows[0]!.id, propertyId, rollen.rows.map(r => r.id), principal.userId])

        const personal = gewuenscht.every(k => PERSONALROLLEN.includes(k))
        if (weg === 'link') {
          const l = await einmalLink(client, { userId: u.rows[0]!.id, kind: 'invite',
                                               createdBy: principal.userId, personal })
          return { ...u.rows[0]!, hinzugefuegt: false as const, link: l }
        }
        await einmalTokenUndPost(client, {
          userId: u.rows[0]!.id, name, email, kind: 'invite',
          createdBy: principal.userId,
          accountName: await kundenName(client, Number(propertyId)),
          personal
        })
        return { ...u.rows[0]!, hinzugefuegt: false as const, link: null }
      }).catch((e: unknown) => {
        // Zwei Einladungen mit demselben Namen gleichzeitig: die zweite
        // scheitert am eindeutigen Index, nicht an der Abfrage davor.
        if ((e as { code?: string; constraint?: string }).code === '23505'
            && (e as { constraint?: string }).constraint === 'app_user_username') {
          throw Errors.conflict('user.usernameTaken')
        }
        throw e
      })

      if (angelegt.hinzugefuegt) {
        return { userRef: angelegt.public_ref, email: angelegt.email,
                 username: angelegt.username, displayName: angelegt.display_name,
                 roleKeys: gewuenscht, status: angelegt.status, addedToProperty: true }
      }
      reply.status(201)
      return { userRef: angelegt.public_ref, email: email || null, username: username || null,
               displayName: name, roleKeys: gewuenscht, status: 'invited',
               addedToProperty: false, delivery: weg,
               ...(angelegt.link !== null
                 ? { link: angelegt.link.link,
                     linkExpiresAt: new Date(Date.now() + angelegt.link.gueltigMs).toISOString() }
                 : {}) }
    }
  })

  /*
   * Einen Zugangslink schicken: die Einladung erneut, oder die
   * Kennwort-Ruecksetzung. Kein Kennwort im Klartext, nie -- es ginge durch
   * ein Gespraech an der Rezeption und bliebe dort stehen.
   *
   * Fuer Personal ohne Mailadresse und offene Einladungen auch als Link zum
   * Weitergeben (`delivery: 'link'`, Migration 0105).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/users/:userRef/access-link',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Einladung erneut oder Kennwort-Link schicken',
    handler: async (req, reply) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const principal = req.principal as Principal
      const gewuenschterWeg = (req.body as { delivery?: string } | undefined)?.delivery
      const ergebnis = await tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const ziel = await benutzerImBetrieb(client, accountId, userRef)
        verlangtBetriebsrecht(ziel, principal)
        const gesperrt = await client.query(
          `SELECT 1 FROM account_user_block WHERE account_id = $1 AND user_id = $2`,
          [accountId, ziel.id])
        if (gesperrt.rowCount !== 0) throw Errors.conflict('user.blocked')
        const art = ziel.status === 'invited' ? 'invite' : 'password_reset'
        const weg = zustellung(gewuenschterWeg, ziel.email !== null)

        if (weg === 'link') {
          /*
           * Den Link sieht hier der Aufrufende. Das ist der Zweck bei einer
           * offenen Einladung und bei Personal ohne Adresse -- bei einem
           * benutzten Zugang mit Adresse waere es der Weg, ihn zu
           * uebernehmen: Link erzeugen, Kennwort setzen, fertig. Der geht
           * deshalb an seine Adresse, wie bisher.
           */
          if (ziel.status !== 'invited' && ziel.email !== null) {
            throw Errors.conflict('user.linkOnlyWithoutEmail')
          }
          const l = await einmalLink(client, { userId: ziel.id, kind: art,
                                               createdBy: principal.userId,
                                               personal: await nurPersonal(client, ziel.id) })
          return { art, weg, link: l }
        }
        await einmalTokenUndPost(client, {
          userId: ziel.id, name: ziel.display_name, email: ziel.email!, kind: art,
          createdBy: principal.userId,
          accountName: await kundenName(client, Number(propertyId)),
          personal: await nurPersonal(client, ziel.id)
        })
        return { art, weg, link: null }
      })
      if (ergebnis.link !== null) {
        return { userRef, kind: ergebnis.art, delivery: 'link', link: ergebnis.link.link,
                 linkExpiresAt: new Date(Date.now() + ergebnis.link.gueltigMs).toISOString() }
      }
      reply.status(202)
      return { userRef, kind: ergebnis.art, delivery: 'email' }
    }
  })

  /*
   * Entsperren nach Fehlversuchen. Laeuft von allein ab -- aber "in zwanzig
   * Minuten" ist die falsche Antwort, wenn ein Gast an der Rezeption steht.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/users/:userRef/unlock',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Sperre nach Fehlversuchen aufheben',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const ziel = await benutzerImBetrieb(client, accountId, userRef)
        verlangtBetriebsrecht(ziel, principal)
        await client.query(
          `UPDATE app_user
              SET failed_login_count = 0, locked_until = NULL,
                  workstation_pin_failed_count = 0, workstation_pin_locked_until = NULL,
                  updated_at = now()
            WHERE id = $1`, [ziel.id])
        // Auch die Sperren je Herkunft (H3, Dokument 25). Ohne das hiesse
        // "entsperrt" nur, dass die Sperre am Konto weg ist, waehrend der
        // Arbeitsplatz, an dem sich jemand vertippt hat, weiter zu bleibt --
        // und genau von dort versucht er es wieder.
        await client.query(`DELETE FROM login_failure WHERE user_id = $1`, [ziel.id])
        return { userRef, unlocked: true }
      })
    }
  })

  /*
   * Name aendern. Die Adresse nicht: sie ist die Anmeldung, und wer sie
   * aendern koennte, koennte einen Zugang auf sich umleiten. Eine neue
   * Adresse ist ein neuer Zugang.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/properties/:propertyId/users/:userRef',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Anzeigename eines Benutzers aendern',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const name = String((req.body as { displayName?: string } | undefined)?.displayName ?? '')
        .trim()
      if (!name) throw Errors.validation({ displayName: ['field.required'] })
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const ziel = await benutzerImBetrieb(client, accountId, userRef)
        verlangtBetriebsrecht(ziel, principal)
        await client.query(
          `UPDATE app_user SET display_name = $2, updated_at = now() WHERE id = $1`,
          [ziel.id, name])
        return { userRef, displayName: name }
      })
    }
  })

  /*
   * Sperren und entsperren -- bei diesem Kunden.
   *
   * Die Rollen bleiben stehen; der Zugriffsbereich endet an der Sperre. Wer
   * zurueckkommt, hat alles wieder, ohne dass jemand die Rollen neu
   * zusammensucht. Beim Sperren enden die laufenden Sitzungen: ein Rechner,
   * der noch angemeldet an der Rezeption steht, ist der Fall, fuer den man
   * sperrt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/users/:userRef/block',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Benutzer bei diesem Betrieb sperren',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const ziel = await benutzerImBetrieb(client, accountId, userRef)
        if (ziel.id === principal.userId) throw Errors.conflict('user.notYourself')
        verlangtBetriebsrecht(ziel, principal)
        await nichtDenLetztenVerwalter(client, accountId, ziel.id)
        await client.query(
          `INSERT INTO account_user_block (account_id, user_id, blocked_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [accountId, ziel.id, principal.userId])
        const beendet = await sitzungenBeenden(client, ziel.id)
        return { userRef, blocked: true, sessionsRevoked: beendet }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/users/:userRef/unblock',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Sperre bei diesem Betrieb aufheben',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const ziel = await benutzerImBetrieb(client, accountId, userRef)
        verlangtBetriebsrecht(ziel, principal)
        await client.query(
          `DELETE FROM account_user_block WHERE account_id = $1 AND user_id = $2`,
          [accountId, ziel.id])
        return { userRef, blocked: false }
      })
    }
  })

  /*
   * Entfernen: alle Rollen bei diesem Betrieb, in allen seinen Haeusern.
   *
   * Der Benutzer selbst bleibt -- das Protokoll verweist auf ihn, und ein
   * Nachweis, dessen Handelnder verschwunden ist, ist keiner. Hat er
   * danach nirgends mehr eine Rolle, wird der Zugang stillgelegt: ein
   * Konto ohne Betrieb hat nichts, wo es sich anmelden koennte, und ein
   * Kennwort, das trotzdem gilt, ist ein Einfallstor ohne Zweck.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/users/:userRef',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Benutzer aus dem Betrieb entfernen',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const ziel = await benutzerImBetrieb(client, accountId, userRef)
        if (ziel.id === principal.userId) throw Errors.conflict('user.notYourself')
        verlangtBetriebsrecht(ziel, principal)
        await nichtDenLetztenVerwalter(client, accountId, ziel.id)

        await client.query(
          `DELETE FROM user_property_role
            WHERE user_id = $1
              AND property_id IN (SELECT id FROM property WHERE account_id = $2)`,
          [ziel.id, accountId])
        await client.query(
          `DELETE FROM user_account_role WHERE user_id = $1 AND account_id = $2`,
          [ziel.id, accountId])
        await client.query(
          `DELETE FROM account_user_block WHERE user_id = $1 AND account_id = $2`,
          [ziel.id, accountId])
        const beendet = await sitzungenBeenden(client, ziel.id)

        const anderswo = await client.query(
          `SELECT 1 FROM user_account_role WHERE user_id = $1
           UNION ALL
           SELECT 1 FROM user_property_role WHERE user_id = $1
           UNION ALL
           SELECT 1 FROM user_platform_role WHERE user_id = $1
           LIMIT 1`, [ziel.id])
        if (anderswo.rowCount === 0) {
          await client.query(
            `UPDATE app_user SET status = 'disabled', updated_at = now() WHERE id = $1`,
            [ziel.id])
        }
        return { userRef, removed: true, sessionsRevoked: beendet }
      })
    }
  })

  /*
   * Rollen fuer den ganzen Betrieb: Inhaber, Buchhaltung, Steuerberatung.
   *
   * Hinter settings:account, nicht user:manage -- diese Rollen wirken in
   * jedem Haus, auch in denen, die der Vergebende nicht fuehrt. Ersetzend
   * wie die Hausrollen. Und der letzte Verwalter bleibt: wer sich selbst das
   * Recht nimmt, den Betrieb zu verwalten, koennte es niemandem
   * zurueckgeben.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/users/:userRef/account-roles',
    permission: 'settings:account',
    propertyParam: 'propertyId',
    summary: 'Rollen eines Benutzers fuer den ganzen Betrieb festlegen',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const body = req.body as { roleKeys?: string[] }
      const principal = req.principal as Principal
      if (!Array.isArray(body.roleKeys)) {
        throw Errors.validation({ roleKeys: ['field.roleKeyList'] })
      }
      const gewuenscht = [...new Set(body.roleKeys)]

      return tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const ziel = await benutzerImBetrieb(client, accountId, userRef)

        const rollen = gewuenscht.length === 0
          ? { rows: [] as Array<{ id: number; key: string }> }
          : await client.query<{ id: number; key: string }>(
              `SELECT id, key FROM role
                WHERE level = 'account' AND key = ANY($1::text[])
                  AND (account_id IS NULL OR account_id = $2)`, [gewuenscht, accountId])
        if (rollen.rows.length !== gewuenscht.length) {
          const gefunden = new Set(rollen.rows.map(r => r.key))
          throw Errors.validation({ roleKeys: ['field.unknownRole'] },
            { values: gewuenscht.filter(k => !gefunden.has(k)).join(', ') })
        }

        const behaeltRecht = rollen.rows.length === 0 ? { rows: [{ n: '0' }] }
          : await client.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM role_permission
                WHERE role_id = ANY($1::bigint[]) AND permission_key = 'settings:account'`,
              [rollen.rows.map(r => r.id)])
        if (Number(behaeltRecht.rows[0]!.n) === 0) {
          // Der Betroffene verloere das Verwaltungsrecht -- darf nicht der
          // letzte sein, und nicht man selbst.
          if (ziel.id === principal.userId) throw Errors.conflict('user.wouldLockYourselfOut')
          await nichtDenLetztenVerwalter(client, accountId, ziel.id)
        }

        await client.query(
          `DELETE FROM user_account_role WHERE user_id = $1 AND account_id = $2`,
          [ziel.id, accountId])
        if (rollen.rows.length > 0) {
          await client.query(
            `INSERT INTO user_account_role (user_id, account_id, role_id)
             SELECT $1, $2, unnest($3::bigint[])`,
            [ziel.id, accountId, rollen.rows.map(r => r.id)])
        }
        return { userRef, roleKeys: rollen.rows.map(r => r.key) }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/account-roles',
    permission: 'settings:account',
    propertyParam: 'propertyId',
    summary: 'Rollen auf Betriebsebene mit ihren Rechten',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const accountId = await hausUndAccount(client, Number(propertyId))
        const { rows } = await client.query(
          `SELECT ro.key, ro.name, ro.level, ro.is_system AS "isSystem",
                  COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
                             FILTER (WHERE rp.permission_key IS NOT NULL),
                           '{}'::text[]) AS permissions
             FROM role ro
             LEFT JOIN role_permission rp ON rp.role_id = ro.id
            WHERE ro.level = 'account'
              AND (ro.account_id IS NULL OR ro.account_id = $1)
            GROUP BY ro.id
            ORDER BY ro.is_system DESC, ro.key`, [accountId])
        return { roles: rows }
      })
    }
  })
}
