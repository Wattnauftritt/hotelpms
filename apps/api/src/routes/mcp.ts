import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'
import { MCP_CLIENT_ID, MCP_REDIRECT_URIS, MCP_VERBINDUNG_STUNDEN,
         type McpOverview } from '@hotelpms/contracts'
import { sicherheitsereignisMelden } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import { hashToken } from '../platform/auth.js'
import type { Principal } from '../platform/context.js'
import { loadConfig } from '../platform/config.js'
import { verlangeBestaetigung, meldeSicherheitsereignis } from '../platform/bestaetigung.js'
import { bestaetigungsOptionen, pruefePasskeyAntwort } from '../platform/passkey.js'

/**
 * Der lesende Zugang fuer Claude, die Seite der API (Migration 0222,
 * Dokument 38).
 *
 * Die API ist hier der Autorisierungsserver nach OAuth 2.1, den der
 * MCP-Dienst (apps/mcp) in seinen Metadaten nennt: claude.ai holt sich
 * einen Code ueber die Zustimmungsseite (`/mcp-verbinden` in der
 * Oberflaeche) und tauscht ihn hier gegen ein Token. Die Anmeldung dahinter
 * ist die gewoehnliche: eine Sitzung der Plattformleitung, die nur mit
 * Passkey Plattformrechte traegt (0211), und eine frische Bestaetigung.
 *
 * Dazu die Handgriffe des Adminpanels: Stand, Notschalter, Verbindung
 * beenden, Klartext freigeben oder ablehnen. Die Freigabe unterschreibt
 * der Passkey **fuer genau diese Anfrage** -- die Herausforderung haengt an
 * der Anfrage (`mcp_release_bind`), nicht an der Sitzung.
 */

const config = loadConfig()

/** Ein Token, das sich in Protokollen und Geheimnisscannern als unseres erkennen laesst. */
const TOKEN_PRAEFIX = 'sgmcp_'

function oauthFehler(reply: FastifyReply, status: number, error: string, beschreibung: string):
  { error: string; error_description: string } {
  reply.status(status).type('application/json').header('cache-control', 'no-store')
  return { error, error_description: beschreibung }
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** RFC 7636: 43 bis 128 Zeichen aus dem ungeschuetzten Alphabet. */
function istVerifier(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(v)
}

function istChallenge(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9\-_]{43,128}$/.test(v)
}

function eigeneId(req: FastifyRequest): number {
  const p = req.principal as Principal | undefined
  if (p?.userId == null) throw Errors.unauthorized()
  return p.userId
}

function ref(req: FastifyRequest): string {
  const r = String((req.params as { ref?: unknown }).ref ?? '')
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(r)) throw Errors.notFound()
  return r
}

export function mcpRoutes(app: FastifyInstance): void {
  /*
   * Dynamische Registrierung (RFC 7591). claude.ai registriert sich vor dem
   * ersten Verbinden; die Antwort ist immer dieselbe Kennung, solange die
   * Weiterleitung eine von claude.ai ist. Oeffentlich, weil sie vor jeder
   * Anmeldung kommt; sie legt nichts an.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mcp/oauth/register',
    permission: null,
    summary: 'Claude-Zugang: Client registrieren (RFC 7591)',
    handler: async (req, reply) => {
      const b = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown }
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : []
      if (uris.length === 0 || !uris.every(u => typeof u === 'string'
                                              && MCP_REDIRECT_URIS.includes(u))) {
        return oauthFehler(reply, 400, 'invalid_redirect_uri',
          'Nur claude.ai darf sich als Claude-Zugang anmelden.')
      }
      reply.status(201).header('cache-control', 'no-store')
      return {
        client_id: MCP_CLIENT_ID,
        client_id_issued_at: 1761955200,
        client_name: typeof b.client_name === 'string' ? b.client_name.slice(0, 100) : 'Claude',
        redirect_uris: uris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }
    }
  })

  /*
   * Code gegen Token. Oeffentlich: der Aufrufer ist claude.ai, nicht der
   * Browser. Der Schutz sind PKCE, die zwei Minuten des Codes, seine
   * Einmaligkeit und Caddy, der diesen Pfad nur aus dem Netz von Anthropic
   * durchlaesst.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mcp/oauth/token',
    permission: null,
    summary: 'Claude-Zugang: Code gegen Token tauschen',
    handler: async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      if (b.grant_type !== 'authorization_code') {
        return oauthFehler(reply, 400, 'unsupported_grant_type',
          'Nur authorization_code. Ein abgelaufenes Token wird durch neues Verbinden ersetzt.')
      }
      const code = typeof b.code === 'string' ? b.code : ''
      const redirect = typeof b.redirect_uri === 'string' ? b.redirect_uri : ''
      const clientId = typeof b.client_id === 'string' ? b.client_id : MCP_CLIENT_ID
      if (code === '' || !istVerifier(b.code_verifier)) {
        return oauthFehler(reply, 400, 'invalid_request', 'Code oder code_verifier fehlt.')
      }
      const token = TOKEN_PRAEFIX + randomBytes(32).toString('base64url')
      const r = await req.pool.query<{ connection_ref: string; user_id: string; expires_at: Date }>(
        'SELECT * FROM mcp_code_redeem($1, $2, $3, $4, $5)',
        [hashToken(code), clientId, redirect, s256(b.code_verifier), hashToken(token)])
      const v = r.rows[0]
      if (v === undefined) {
        return oauthFehler(reply, 400, 'invalid_grant', 'Code ungueltig, verbraucht oder abgelaufen.')
      }
      await withTransaction(req.pool, SYSTEM_CONTEXT, client => sicherheitsereignisMelden(client,
        { kind: 'mcp_connected', accountId: null, detail: { connection: v.connection_ref } },
        { kind: 'user', userId: Number(v.user_id), ref: `mcp:${v.connection_ref}` },
        req.ip || null, config.platformNoticeEmail))
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache')
      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: MCP_VERBINDUNG_STUNDEN * 3600
      }
    }
  })

  /*
   * Zustimmung auf der Seite `/mcp-verbinden`. Verlangt das Recht, eine
   * frische Bestaetigung -- an einem Rechner, an dem jemand kurz aufsteht,
   * soll niemand nebenbei Claude anschliessen -- und eine Weiterleitung an
   * claude.ai.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/mcp/consent',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang: Verbindung erlauben',
    handler: async (req) => {
      await verlangeBestaetigung(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const redirect = typeof b.redirectUri === 'string' ? b.redirectUri : ''
      const clientId = typeof b.clientId === 'string' ? b.clientId : ''
      const fehler: Record<string, string[]> = {}
      if (!MCP_REDIRECT_URIS.includes(redirect)) fehler.redirectUri = ['field.invalid']
      if (clientId !== MCP_CLIENT_ID) fehler.clientId = ['field.invalid']
      if (!istChallenge(b.codeChallenge)) fehler.codeChallenge = ['field.invalid']
      if (b.codeChallengeMethod !== 'S256') fehler.codeChallengeMethod = ['field.invalid']
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      const code = randomBytes(32).toString('base64url')
      try {
        await tx(req.pool, req, client => client.query(
          'SELECT mcp_code_issue($1, $2, $3, $4)',
          [hashToken(code), clientId, redirect, b.codeChallenge]))
      } catch (e) {
        if ((e as { message?: string }).message === 'mcp_locked') throw Errors.conflict('mcp.locked')
        throw e
      }
      const ziel = new URL(redirect)
      ziel.searchParams.set('code', code)
      if (typeof b.state === 'string' && b.state.length <= 500) ziel.searchParams.set('state', b.state)
      ziel.searchParams.set('iss', new URL(config.publicAppUrl).origin)
      return { redirectTo: ziel.toString() }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/mcp',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang: Verbindungen, Anfragen und Aufrufe',
    handler: async (req) => {
      const r = await tx(req.pool, req, client =>
        client.query<{ o: McpOverview }>('SELECT mcp_overview() AS o'))
      return r.rows[0]!.o
    }
  })

  /* Fuer den Hinweis oben im Adminpanel; die Seite fragt alle 15 Sekunden. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/mcp/pending',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang: offene Klartext-Anfragen zaehlen',
    handler: async (req) => {
      const r = await tx(req.pool, req, client =>
        client.query<{ n: number }>('SELECT mcp_pending_count() AS n'))
      return { pending: r.rows[0]!.n }
    }
  })

  /*
   * Der Notschalter. Sperren geht ohne Bestaetigung: wer ihn braucht, hat
   * keine Zeit fuer einen zweiten Passkey. Loesen verlangt sie.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/mcp/lock',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang sperren oder wieder erlauben',
    handler: async (req) => {
      const locked = (req.body as { locked?: unknown } | undefined)?.locked
      if (typeof locked !== 'boolean') throw Errors.validation({ locked: ['field.invalid'] })
      if (!locked) await verlangeBestaetigung(req)
      await tx(req.pool, req, async client => {
        await client.query('SELECT mcp_set_locked($1)', [locked])
        await meldeSicherheitsereignis(client, req,
          { kind: 'mcp_locked', accountId: null, detail: { locked } })
      })
      return { locked }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/mcp/connections/:ref/revoke',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang: eine Verbindung beenden',
    handler: async (req) => {
      const r = await tx(req.pool, req, client =>
        client.query<{ ok: boolean }>('SELECT mcp_connection_revoke($1) AS ok', [ref(req)]))
      if (!r.rows[0]!.ok) throw Errors.notFound()
      return { revoked: true }
    }
  })

  /*
   * Freigabe, erster Schritt: die Herausforderung fuer den Passkey holen und
   * an die Anfrage binden. Scheitert, wenn die Anfrage nicht mehr offen ist
   * oder das Haus einem fremden Betrieb ohne laufende Support-Freigabe
   * gehoert.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/mcp/releases/:ref/options',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang: Klartext freigeben, Herausforderung anfordern',
    handler: async (req) => {
      const r0 = ref(req)
      const optionen = await bestaetigungsOptionen(req, eigeneId(req))
      const r = await tx(req.pool, req, client => client.query<{ match_code: string }>(
        'SELECT * FROM mcp_release_bind($1, $2)', [r0, optionen.challengeId]))
      if (r.rows[0] === undefined) throw Errors.conflict('mcp.requestNotOpen')
      return { ...optionen, matchCode: r.rows[0].match_code }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/mcp/releases/:ref/grant',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang: Klartext mit Passkey freigeben',
    handler: async (req) => {
      const r0 = ref(req)
      const userId = eigeneId(req)
      const b = (req.body ?? {}) as { challengeId?: unknown; response?: unknown }
      await pruefePasskeyAntwort(req, b.challengeId, b.response, userId)
      const r = await tx(req.pool, req, async client => {
        const g = await client.query<{ property_id: string; account_id: string; expires_at: Date }>(
          'SELECT * FROM mcp_release_grant($1, $2)', [r0, b.challengeId])
        const z = g.rows[0]
        if (z !== undefined) {
          await meldeSicherheitsereignis(client, req, {
            kind: 'mcp_release_granted', accountId: Number(z.account_id),
            propertyId: Number(z.property_id), detail: { release: r0 } })
        }
        return z
      })
      if (r === undefined) throw Errors.conflict('mcp.requestNotOpen')
      return { expiresAt: new Date(r.expires_at).toISOString() }
    }
  })

  /* Ablehnen, solange offen; beenden, solange sie laeuft. */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/mcp/releases/:ref/close',
    permission: 'platform:mcp',
    summary: 'Claude-Zugang: Klartext ablehnen oder beenden',
    handler: async (req) => {
      const r = await tx(req.pool, req, client =>
        client.query<{ s: string | null }>('SELECT mcp_release_close($1) AS s', [ref(req)]))
      if (r.rows[0]!.s === null) throw Errors.conflict('mcp.requestNotOpen')
      return { state: r.rows[0]!.s }
    }
  })
}
