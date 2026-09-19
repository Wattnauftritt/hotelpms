import { randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { hinweisText } from '../platform/texte.js'
import { hashToken } from '../platform/auth.js'
import { accountFor, type Principal } from '../platform/context.js'
import { isPermission, PERMISSIONS } from '../platform/permissions.js'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'

/**
 * Maschinenzugang mit Client Credentials (Aufgabe 2, Dokument 16).
 *
 * **Warum nicht das Sitzungscookie.** Ein Channel Manager ist kein Browser:
 * er hat keinen Nutzer, keine Untaetigkeitsfrist und keine Herkunft, gegen
 * die sich ein Cookie binden liesse.
 *
 * **Warum ein undurchsichtiges Token und kein JWT.** Ein JWT ist bis zum
 * Ablauf gueltig, auch nachdem der Kunde den Zugang entzogen hat; das
 * einzufangen braucht wieder eine Sperrliste, also wieder die Datenbank.
 * Dann kann die Pruefung auch gleich dort stattfinden. Der Preis ist eine
 * Abfrage je Anfrage, und die laeuft ohnehin fuer den Mandantenkontext.
 *
 * **Scopes sind Berechtigungsschluessel.** Kein zweiter Rechteweg
 * (Grundsatz 1, Dokument 14); `registerRoute` sieht keinen Unterschied
 * zwischen Mensch und Maschine.
 */

/** Eine Stunde. Kurz genug, dass ein entzogener Zugang schnell wirkt. */
const TOKEN_GUELTIG_SEKUNDEN = 3600

/**
 * Fehler am Tokenendpunkt folgen RFC 6749, nicht RFC 9457.
 *
 * Das ist die einzige Stelle, an der dieses System vom Problem-Format
 * abweicht, und sie hat einen Grund: hier spricht keine eigene Oberflaeche,
 * sondern eine fremde OAuth-Bibliothek, und die erwartet `error` und
 * `error_description`. Ein Problem-Dokument zurueckzugeben hiesse, jeden
 * Standardclient zum Sonderfall zu machen.
 */
function oauthFehler(
  reply: FastifyReply, status: number, error: string, beschreibung: string
): { error: string; error_description: string } {
  reply.status(status).type('application/json')
  if (status === 401) reply.header('www-authenticate', 'Basic realm="staygrid"')
  return { error, error_description: beschreibung }
}

interface ClientRow {
  id: number
  account_id: number
  secret_hash: string
  scopes: string[]
  property_ids: string[]
  status: string
}

/** Kennung und Geheimnis aus Kopfzeile oder Rumpf, in dieser Reihenfolge. */
function zugangsdaten(
  authorization: string | undefined, body: Record<string, string>
): { id: string; secret: string } | null {
  if (authorization?.startsWith('Basic ')) {
    const roh = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
    const trenner = roh.indexOf(':')
    if (trenner < 0) return null
    // Nach RFC 6749 sind beide Teile prozentkodiert.
    return {
      id: decodeURIComponent(roh.slice(0, trenner)),
      secret: decodeURIComponent(roh.slice(trenner + 1))
    }
  }
  const id = body.client_id
  const secret = body.client_secret
  return id && secret ? { id, secret } : null
}

export function oauthRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/oauth/token',
    // Oeffentlich, weil hier die Anmeldung erst stattfindet. Der Schutz sind
    // das Geheimnis, die enge Ratenbegrenzung und die Sperre des Clients.
    permission: null,
    summary: 'Zugriffstoken fuer eine Maschine ausgeben',
    handler: async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string>

      if (body.grant_type !== 'client_credentials') {
        return oauthFehler(reply, 400, 'unsupported_grant_type',
          'Dieser Server kennt nur client_credentials.')
      }
      const daten = zugangsdaten(req.headers.authorization, body)
      if (daten === null) {
        return oauthFehler(reply, 401, 'invalid_client',
          'Kennung und Geheimnis fehlen.')
      }

      // Ueber eine SECURITY-DEFINER-Funktion: `oauth_client` traegt eine
      // Zeilenrichtlinie ueber den Account, und den kennt man erst, wenn der
      // Client gefunden ist (Migration 0023).
      const gefunden = await withTransaction(req.pool, SYSTEM_CONTEXT, client =>
        client.query<ClientRow>(`SELECT * FROM oauth_client_for_auth($1)`, [daten.id]))

      /*
       * Rechenzeit auch dann verbrauchen, wenn es den Client nicht gibt --
       * sonst antwortet eine unbekannte Kennung in zwei Millisekunden und
       * eine bekannte in hundert, und damit laesst sich die Clientliste
       * abfragen, ohne ein einziges Geheimnis zu kennen.
       */
      const hash = gefunden.rows[0]?.secret_hash ?? BLIND_HASH
      let stimmt: boolean
      try { stimmt = await argonVerify(hash, daten.secret) } catch { stimmt = false }

      const c = gefunden.rows[0]
      if (c === undefined || !stimmt || c.status !== 'active') {
        return oauthFehler(reply, 401, 'invalid_client',
          'Kennung oder Geheimnis stimmt nicht.')
      }

      // Weniger anfragen als vereinbart ist erlaubt und gute Praxis; mehr
      // anfragen ist ein Fehler und nicht etwa eine stille Kuerzung.
      const erlaubt = new Set(c.scopes)
      const gewuenscht = body.scope?.trim()
        ? body.scope.trim().split(/\s+/)
        : c.scopes
      const zuviel = gewuenscht.filter(s => !erlaubt.has(s))
      if (zuviel.length > 0) {
        return oauthFehler(reply, 400, 'invalid_scope',
          `Nicht vereinbart: ${zuviel.join(' ')}`)
      }

      const token = randomBytes(32).toString('base64url')
      await withTransaction(req.pool, SYSTEM_CONTEXT, client =>
        client.query(
          `INSERT INTO oauth_access_token
             (client_id, account_id, token_hash, scopes, property_ids, expires_at)
           VALUES ($1,$2,$3,$4::text[],$5::bigint[], now() + make_interval(secs => $6))`,
          [c.id, c.account_id, hashToken(token), gewuenscht,
           c.property_ids.map(Number), TOKEN_GUELTIG_SEKUNDEN]))

      reply.header('cache-control', 'no-store')
      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: TOKEN_GUELTIG_SEKUNDEN,
        scope: gewuenscht.join(' ')
      }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/oauth-clients',
    permission: 'integration:manage',
    summary: 'Maschinenzugang anlegen',
    handler: async (req, reply) => {
      const body = req.body as {
        accountId?: number; name: string; scopes: string[]; propertyIds?: number[] }
      const principal = req.principal as Principal
      const accountId = accountFor(principal, body.accountId)

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw Errors.validation({ name: ['field.required'] })
      }
      if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
        throw Errors.validation({ scopes: ['field.atLeastOneScope'] })
      }
      const unbekannt = body.scopes.filter(s => !isPermission(s))
      if (unbekannt.length > 0) {
        throw Errors.validation({ scopes: ['field.unknownValues'] },
          { values: unbekannt.join(', ') })
      }
      /*
       * Plattformrechte sind keine Scopes. Sie gehoeren unserem eigenen
       * Personal und wirken ueber Mandanten hinweg; ein Kundenclient mit
       * `platform:accounts` haette Zugriff auf fremde Betriebe.
       */
      const plattform = body.scopes.filter(s => s.startsWith('platform:'))
      if (plattform.length > 0) {
        throw Errors.validation({ scopes: ['field.noPlatformScopes'] },
          { values: plattform.join(', ') })
      }

      // Das Geheimnis entsteht hier und wird genau einmal herausgegeben.
      const secret = randomBytes(32).toString('base64url')

      return tx(req.pool, req, async client => {
        const propertyIds = body.propertyIds ?? []
        if (propertyIds.length > 0) {
          const eigene = await client.query(
            `SELECT 1 FROM property WHERE account_id = $1 AND id = ANY($2::bigint[])`,
            [accountId, propertyIds])
          if (eigene.rowCount !== propertyIds.length) throw Errors.notFound('res.property')
        }

        const r = await client.query<{ public_ref: string }>(
          `INSERT INTO oauth_client (account_id, name, secret_hash, scopes, property_ids)
           VALUES ($1,$2,$3,$4::text[],$5::bigint[]) RETURNING public_ref`,
          [accountId, body.name.trim(),
           await argonHash(secret, { memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
           body.scopes, propertyIds])

        reply.status(201)
        return {
          clientId: r.rows[0]!.public_ref,
          clientSecret: secret,
          scopes: body.scopes,
          propertyIds,
          allProperties: propertyIds.length === 0,
          hinweis: hinweisText('hint.oauthSecretOnce'),
          hinweisKey: 'hint.oauthSecretOnce'
        }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/oauth-clients',
    permission: 'integration:manage',
    summary: 'Maschinenzugaenge auflisten',
    handler: async (req) => tx(req.pool, req, async client => {
      const { rows } = await client.query(
        `SELECT c.public_ref AS "clientId", c.name, c.scopes, c.property_ids AS "propertyIds",
                c.status, c.created_at AS "createdAt",
                count(t.id) FILTER (
                  WHERE t.revoked_at IS NULL AND t.expires_at > now())::int AS "activeTokens",
                max(t.last_used_at) AS "lastUsedAt"
           FROM oauth_client c
           LEFT JOIN oauth_access_token t ON t.client_id = c.id
          GROUP BY c.id
          ORDER BY c.id`)
      return { clients: rows, availableScopes: PERMISSIONS.filter(p => !p.startsWith('platform:')) }
    })
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/oauth-clients/:clientRef/revoke',
    permission: 'integration:manage',
    summary: 'Maschinenzugang sperren und seine Token entwerten',
    handler: async (req) => {
      const { clientRef } = req.params as { clientRef: string }
      return tx(req.pool, req, async client => {
        const c = await client.query<{ id: number }>(
          `SELECT id FROM oauth_client WHERE public_ref = $1 FOR UPDATE`, [clientRef])
        if (c.rowCount === 0) throw Errors.notFound('res.oauthClient')

        await client.query(
          `UPDATE oauth_client SET status = 'disabled' WHERE id = $1`, [c.rows[0]!.id])
        /*
         * Die bereits ausgegebenen Token mit entwerten. Nur den Client zu
         * sperren genuegte zwar -- die Aufloesung prueft seinen Status --,
         * aber ein gesperrter Zugang mit gueltigen Token in der Tabelle ist
         * ein Zustand, den beim naechsten Lesen niemand richtig deutet.
         */
        const entwertet = await client.query(
          `UPDATE oauth_access_token SET revoked_at = now()
            WHERE client_id = $1 AND revoked_at IS NULL`, [c.rows[0]!.id])

        return { clientId: clientRef, status: 'disabled', revokedTokens: entwertet.rowCount ?? 0 }
      })
    }
  })
}

/** Siehe `routes/auth.ts`: derselbe Zweck, dieselbe Begruendung. */
const BLIND_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsemVzYWx6ZXNhbHplcw$'
  + 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYg'
