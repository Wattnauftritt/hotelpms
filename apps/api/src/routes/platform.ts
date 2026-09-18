import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'
import { einmalTokenUndPost } from './auth.js'

/**
 * Das Adminpanel: Kunden, Plattformbenutzer, Betriebszustand.
 *
 * **Warum jede Abfrage hier durch eine Funktion geht.** `account` und
 * `property` tragen eine erzwungene Zeilenrichtlinie, und Plattformpersonal
 * hat ohne freigegebene Support-Sitzung einen leeren Mandantenkontext. Eine
 * gewoehnliche Abfrage kaeme hier **still leer** zurueck -- der Fehler, der
 * in diesem System schon dreimal passiert ist (Migrationen 0014, 0018,
 * 0032). Die Funktionen aus Migration 0038 pruefen das Recht ein zweites
 * Mal, in der Datenbank; die Berechtigung an der Route ist die erste Tuer,
 * nicht die einzige.
 *
 * **Was hier bewusst NICHT herauskommt:** Gastdaten, Buchungen, Umsaetze.
 * Der Zugriff auf Kundendaten laeuft ueber eine vom Kunden freigegebene
 * Support-Sitzung und ausschliesslich darueber. Was dieses Panel zeigt, sind
 * Kennungen, Namen, Zustaende und Zahlen.
 */

interface KontoZeile {
  id: number; public_ref: string; name: string; legal_name: string | null
  status: string; properties: string; users: string
  created_at: string; last_login_at: string | null
}

interface HausZeile {
  id: number; public_ref: string; code: string; name: string; status: string
  is_training: boolean; timezone: string; rooms: string
}

interface BenutzerZeile {
  id: number; public_ref: string; email: string; display_name: string
  status: string; locked_until: string | null; last_login_at: string | null
  roles: string | null
}

/** Die letzte Einladung oder Ruecksetzung je Benutzer -- ob sie ankam. */
interface PostZeile {
  user_id: number; kind: string; status: string; created_at: string
  last_error: string | null
}

interface PersonalZeile {
  id: number; public_ref: string; email: string; display_name: string
  status: string; role_key: string | null; role_name: string | null
  last_login_at: string | null; created_at: string
}

interface ZustandZeile {
  account_id: number; account_name: string; account_status: string
  emails_pending: string; emails_failed: string; emails_oldest: string | null
  webhooks_failed: string; webhooks_oldest: string | null
  night_audit_last: string | null
}

/** Zustaende eines Kunden. `archived` heisst kein Zugang mehr, nicht "weg". */
const KONTO_ZUSTAENDE = ['active', 'suspended', 'archived'] as const
/** Zustaende eines Plattformbenutzers. `invited` vergibt nur die Einladung. */
const PERSONAL_ZUSTAENDE = ['active', 'disabled'] as const

const PLATTFORM_ROLLEN = [
  'platform_admin', 'platform_support', 'platform_billing', 'platform_ops'
] as const

export function kennung(req: { params?: unknown }, feld = 'id'): number {
  const roh = (req.params as Record<string, string> | undefined)?.[feld]
  const n = Number(roh)
  if (!Number.isInteger(n) || n <= 0) {
    throw Errors.validation({ [feld]: ['field.invalid'] })
  }
  return n
}

export function platformRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/accounts',
    permission: 'platform:accounts',
    summary: 'Kunden der Plattform',
    handler: async (req) => {
      const rows = await tx(req.pool, req, client =>
        client.query<KontoZeile>(`SELECT * FROM platform_accounts()`))
      return {
        accounts: rows.rows.map(a => ({
          id: a.id,
          ref: a.public_ref,
          name: a.name,
          legalName: a.legal_name,
          status: a.status,
          // `count(*)` kommt als bigint und damit als Zeichenkette aus dem
          // Treiber. Ungewandelt steht in der Oberflaeche "12" neben 12 und
          // jede Rechnung damit ergibt Unsinn.
          properties: Number(a.properties),
          users: Number(a.users),
          createdAt: a.created_at,
          lastLoginAt: a.last_login_at
        }))
      }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/accounts/:id',
    permission: 'platform:accounts',
    summary: 'Ein Kunde mit Haeusern und Benutzern',
    handler: async (req) => {
      const id = kennung(req)
      return tx(req.pool, req, async client => {
        const konto = await client.query<KontoZeile>(
          `SELECT * FROM platform_accounts() WHERE id = $1`, [id])
        if (konto.rowCount === 0) throw Errors.notFound('platform.accountNotFound')

        const haeuser = await client.query<HausZeile>(
          `SELECT * FROM platform_account_properties($1)`, [id])
        const benutzer = await client.query<BenutzerZeile>(
          `SELECT * FROM platform_account_users($1)`, [id])

        /*
         * Die letzte Post an jeden Benutzer. "Die Einladung ist nie
         * angekommen" ist der zweithaeufigste Anruf, und die Antwort steht
         * in platform_email: noch nicht versucht, gescheitert (mit dem
         * Fehler des Anbieters), oder gesendet -- dann liegt es im Spam.
         * platform_email traegt keine Zeilenrichtlinie und keine Gastdaten;
         * `last_error` ist die Meldung des Mailanbieters, sonst nichts.
         */
        const post = benutzer.rows.length === 0
          ? { rows: [] as PostZeile[] }
          : await client.query<PostZeile>(
              `SELECT DISTINCT ON (user_id) user_id, kind, status,
                      created_at::text, last_error
                 FROM platform_email
                WHERE user_id = ANY($1::bigint[])
                  AND kind IN ('invite', 'password_reset')
                ORDER BY user_id, created_at DESC`,
              [benutzer.rows.map(u => u.id)])
        const letztePost = new Map(post.rows.map(z => [z.user_id, z]))

        const a = konto.rows[0]!
        return {
          account: {
            id: a.id, ref: a.public_ref, name: a.name, legalName: a.legal_name,
            status: a.status, properties: Number(a.properties),
            users: Number(a.users), createdAt: a.created_at,
            lastLoginAt: a.last_login_at
          },
          properties: haeuser.rows.map(h => ({
            id: h.id, ref: h.public_ref, code: h.code, name: h.name,
            status: h.status, isTraining: h.is_training, timezone: h.timezone,
            rooms: Number(h.rooms)
          })),
          users: benutzer.rows.map(u => {
            const m = letztePost.get(u.id)
            return {
              id: u.id, ref: u.public_ref, email: u.email,
              displayName: u.display_name, status: u.status,
              lockedUntil: u.locked_until, lastLoginAt: u.last_login_at,
              roles: u.roles,
              lastMail: m === undefined ? null
                : { kind: m.kind, status: m.status, at: m.created_at,
                    error: m.last_error }
            }
          })
        }
      })
    }
  })

  /*
   * Sperren, entsperren, archivieren.
   *
   * **Das war bis Migration 0038 ein Knopf ohne Wirkung.** `account.status`
   * gibt es seit 0002, das Recht heisst seit 0003 "Accounts anlegen,
   * sperren" -- gelesen hat die Spalte niemand. Jetzt endet der
   * Zugriffsbereich der Kundenbenutzer daran (`user_property_scope`,
   * `user_account_scope`); eine laufende Sitzung sieht beim naechsten
   * Aufbau des Principals nichts mehr.
   *
   * Der Support bleibt ausdruecklich davon unberuehrt: wer gesperrt ist,
   * ist meist gerade der, dem geholfen werden muss.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/status',
    permission: 'platform:accounts',
    summary: 'Kunden sperren, entsperren oder archivieren',
    handler: async (req) => {
      const id = kennung(req)
      const b = (req.body ?? {}) as { status?: string }
      const status = String(b.status ?? '')
      if (!(KONTO_ZUSTAENDE as readonly string[]).includes(status)) {
        throw Errors.validation({ status: ['field.invalid'] })
      }

      return tx(req.pool, req, async client => {
        const r = await client.query<{ platform_account_set_status: string }>(
          `SELECT platform_account_set_status($1, $2)`, [id, status])
        return { id, previous: r.rows[0]!.platform_account_set_status, status }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/staff',
    permission: 'platform:staff',
    summary: 'Plattformbenutzer und ihre Rollen',
    handler: async (req) => {
      const rows = await tx(req.pool, req, client =>
        client.query<PersonalZeile>(`SELECT * FROM platform_staff()`))
      return {
        roles: PLATTFORM_ROLLEN,
        staff: rows.rows.map(p => ({
          id: p.id, ref: p.public_ref, email: p.email,
          displayName: p.display_name, status: p.status,
          roleKey: p.role_key, roleName: p.role_name,
          lastLoginAt: p.last_login_at, createdAt: p.created_at
        }))
      }
    }
  })

  /*
   * Einen Plattformbenutzer anlegen.
   *
   * **Kein Kennwort, sondern eine Einladung.** Wer hier ein Kennwort
   * vergaebe, muesste es weitergeben -- und ein Zugang mit Vollzugriff auf
   * die Plattform, dessen erstes Kennwort durch einen Chat gegangen ist, ist
   * ab dem ersten Tag kompromittiert.
   *
   * **Ein vorhandener Benutzer wird nicht erhoeht.** Dieselbe Regel wie im
   * Skript `db:plattformbenutzer`, und aus demselben Grund: es waere der
   * Weg, auf dem ein Kundenzugang unbemerkt zu einem Plattformzugang wird --
   * ein Tippfehler in der Adresse genuegte.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/staff',
    permission: 'platform:staff',
    summary: 'Plattformbenutzer anlegen und einladen',
    handler: async (req, reply) => {
      const b = (req.body ?? {}) as
        { email?: string; displayName?: string; roleKey?: string }
      const email = String(b.email ?? '').trim().toLowerCase()
      const name = String(b.displayName ?? '').trim()
      const roleKey = String(b.roleKey ?? '')
      const principal = req.principal as Principal

      const fehler: Record<string, string[]> = {}
      if (!email || !email.includes('@')) fehler.email = ['field.invalid']
      if (!name) fehler.displayName = ['field.required']
      if (!(PLATTFORM_ROLLEN as readonly string[]).includes(roleKey)) {
        fehler.roleKey = ['field.invalid']
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      const angelegt = await tx(req.pool, req, async client => {
        const da = await client.query(
          `SELECT 1 FROM app_user WHERE lower(email) = $1`, [email])
        if (da.rowCount !== 0) throw Errors.conflict('platform.staffExists')

        const rolle = await client.query<{ id: number }>(
          `SELECT id FROM role
            WHERE key = $1 AND account_id IS NULL AND level = 'platform'`,
          [roleKey])
        if (rolle.rowCount === 0) {
          throw Errors.validation({ roleKey: ['field.invalid'] })
        }

        const u = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO app_user (email, display_name, status, is_platform_staff)
           VALUES ($1, $2, 'invited', true) RETURNING id, public_ref`,
          [email, name])
        await client.query(
          `INSERT INTO user_platform_role (user_id, role_id) VALUES ($1, $2)`,
          [u.rows[0]!.id, rolle.rows[0]!.id])

        await einmalTokenUndPost(client, {
          userId: u.rows[0]!.id, name, email, kind: 'invite',
          createdBy: principal.userId
        })

        return u.rows[0]!
      })

      reply.status(201)
      return {
        id: angelegt.id, ref: angelegt.public_ref, email,
        displayName: name, roleKey, status: 'invited'
      }
    }
  })

  /*
   * Stilllegen und wieder freigeben.
   *
   * Zwei Sperren stehen davor, und beide sind schon einmal irgendwo
   * gebraucht worden: sich selbst stillzulegen heisst, sich auszusperren --
   * und niemand sonst kann es rueckgaengig machen, wenn man der letzte
   * Admin war. Genau das ist die zweite Sperre: der letzte aktive
   * Plattform-Admin bleibt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/staff/:id/status',
    permission: 'platform:staff',
    summary: 'Plattformbenutzer stilllegen oder freigeben',
    handler: async (req) => {
      const id = kennung(req)
      const b = (req.body ?? {}) as { status?: string }
      const status = String(b.status ?? '')
      const principal = req.principal as Principal

      if (!(PERSONAL_ZUSTAENDE as readonly string[]).includes(status)) {
        throw Errors.validation({ status: ['field.invalid'] })
      }
      if (id === principal.userId) {
        throw Errors.conflict('platform.staffSelf')
      }

      return tx(req.pool, req, async client => {
        const u = await client.query<{ status: string }>(
          `SELECT status FROM app_user WHERE id = $1 AND is_platform_staff`,
          [id])
        if (u.rowCount === 0) throw Errors.notFound('platform.staffNotFound')

        if (status === 'disabled') {
          /*
           * Der letzte aktive Admin bleibt. Gezaehlt wird ueber die Rolle
           * und nicht ueber das Recht: `platform:staff` haengt heute nur an
           * `platform_admin`, und wer das aendert, soll diese Sperre
           * bewusst mit anfassen muessen.
           */
          const uebrig = await client.query<{ n: string }>(
            `SELECT count(*) AS n
               FROM app_user u
               JOIN user_platform_role upr ON upr.user_id = u.id
               JOIN role r ON r.id = upr.role_id
              WHERE u.is_platform_staff AND u.status = 'active'
                AND r.key = 'platform_admin' AND u.id <> $1`, [id])
          const istAdmin = await client.query(
            `SELECT 1 FROM user_platform_role upr
               JOIN role r ON r.id = upr.role_id
              WHERE upr.user_id = $1 AND r.key = 'platform_admin'`, [id])
          if (istAdmin.rowCount !== 0 && Number(uebrig.rows[0]!.n) === 0) {
            throw Errors.conflict('platform.staffLastAdmin')
          }
        }

        await client.query(
          `UPDATE app_user SET status = $2, updated_at = now() WHERE id = $1`,
          [id, status])
        return { id, status, previous: u.rows[0]!.status }
      })
    }
  })

  /*
   * Betriebszustand je Kunde.
   *
   * Nur Zahlen und Zeitpunkte, keine Inhalte: eine Gastpost traegt Namen und
   * Adresse, ein Webhook den Rumpf einer Buchung. Was klemmt, sagt die Zahl;
   * alles Weitere gehoert in eine Support-Sitzung.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/health',
    permission: 'platform:operations',
    summary: 'Betriebszustand je Kunde',
    handler: async (req) => {
      const { rows, post, ausrollung } = await tx(req.pool, req, async client => ({
        rows: await client.query<ZustandZeile>(`SELECT * FROM platform_health()`),
        /*
         * Die Post der Plattform selbst: Einladungen, Kennwort-Links,
         * Support-Anfragen. Steht der Versand (Brevo) nicht, sammelt sich
         * hier alles, und der Kunde wartet auf eine Einladung, die nie
         * losging. Der letzte Fehler ist die Meldung des Anbieters -- die
         * eine Zeile, mit der man den Grund sieht, ohne auf die Maschine
         * zu muessen.
         */
        post: await client.query<{ pending: string; failed: string
                                   oldest: string | null; last_error: string | null }>(
          `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
                  count(*) FILTER (WHERE status = 'failed') AS failed,
                  min(created_at) FILTER (WHERE status IN ('pending','failed'))::text
                    AS oldest,
                  (SELECT last_error FROM platform_email
                    WHERE status = 'failed' ORDER BY created_at DESC LIMIT 1)
                    AS last_error
             FROM platform_email`),
        /*
         * Eine Ausrollung, die auf 'running' steht und nicht fertig wird,
         * sperrt ueber den eindeutigen Teilindex jede weitere -- und am
         * Knopf sieht man nur, dass er nicht mehr geht (Dokument 21 §8).
         * Fuenfzehn Minuten sind das Doppelte eines Baus.
         */
        ausrollung: await client.query<{ id: number; status: string; started_at: string | null
                                         requested_at: string }>(
          `SELECT id, status, started_at::text, requested_at::text
             FROM deploy_request
            WHERE status IN ('pending', 'running')
            ORDER BY id LIMIT 1`)
      }))
      const offen = ausrollung.rows[0]
      const haengt = offen !== undefined && (
        (offen.status === 'running' && offen.started_at !== null
          && Date.now() - Date.parse(offen.started_at) > 15 * 60_000)
        || (offen.status === 'pending'
          && Date.now() - Date.parse(offen.requested_at) > 5 * 60_000))
      return {
        platform: {
          emailsPending: Number(post.rows[0]!.pending),
          emailsFailed: Number(post.rows[0]!.failed),
          emailsOldest: post.rows[0]!.oldest,
          emailsLastError: post.rows[0]!.last_error,
          deployment: offen === undefined ? null
            : { id: offen.id, status: offen.status, stuck: haengt }
        },
        accounts: rows.rows.map(z => ({
          accountId: z.account_id,
          accountName: z.account_name,
          accountStatus: z.account_status,
          emailsPending: Number(z.emails_pending),
          emailsFailed: Number(z.emails_failed),
          emailsOldest: z.emails_oldest,
          webhooksFailed: Number(z.webhooks_failed),
          webhooksOldest: z.webhooks_oldest,
          nightAuditLast: z.night_audit_last
        }))
      }
    }
  })
}
