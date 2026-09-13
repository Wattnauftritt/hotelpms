import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { createPool, type Pool } from '@hotelpms/db'
import { loadConfig, type Config } from './config.js'
import { AppError, Errors } from './errors.js'
import { ANONYMOUS, type Principal } from './context.js'
import { loadPrincipal, applySupportSession, loadPrincipalFromToken } from './auth.js'
import { registerRateLimit } from './rateLimit.js'

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal
    pool: Pool
    /** Roher Rumpf vor dem Parsen. Der Stripe-Webhook braucht genau diese
     *  Bytes fuer die Signaturpruefung; ein neu serialisiertes JSON waere
     *  nicht mehr dieselbe Zeichenkette. */
    rawBody: Buffer
  }
}

export interface Server {
  app: FastifyInstance
  pool: Pool
  config: Config
}

export async function buildServer(overrides: { pool?: Pool } = {}): Promise<Server> {
  const config = loadConfig()
  const pool = overrides.pool ?? createPool({ kind: 'app', max: 10, applicationName: 'hotelpms-api' })

  const app = Fastify({
    logger: config.logLevel === 'silent'
      ? false
      : {
          level: config.logLevel,
          // Gaestedaten gehoeren nicht ins Protokoll (C8, Dokument 13).
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie',
                    'req.body', 'res.body', '*.password', '*.idDocumentNumber'],
            remove: true
          }
        },
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576
  })

  await app.register(cookie, { secret: config.sessionSecret })

  // decorateRequest mit einem Wert teilt ihn zwischen Anfragen. Wir setzen
  // die Felder im onRequest-Hook, deklariert wird hier nur der Platz.
  app.decorateRequest('principal')
  app.decorateRequest('pool')
  app.decorateRequest('rawBody')

  // Ersetzt den eingebauten JSON-Parser nur soweit, dass der rohe Rumpf
  // zusaetzlich erhalten bleibt. Ohne das koennte kein Aufrufer, der eine
  // Signatur ueber den Rumpf prueft (Stripe-Webhook), das je nachweisen:
  // ein erneut serialisiertes JSON ist nicht mehr byteidentisch mit dem
  // signierten Original.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      req.rawBody = body
      if (body.length === 0) { done(null, undefined); return }
      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (err) {
        done(err as Error, undefined)
      }
    })

  /*
   * Der Tokenendpunkt nimmt formularkodierte Daten entgegen, nicht JSON.
   * RFC 6749 schreibt das so vor, und jede fremde OAuth-Bibliothek sendet
   * entsprechend; JSON zu verlangen machte aus jedem Standardclient einen
   * Sonderfall. Kein zusaetzliches Paket noetig, URLSearchParams genuegt.
   */
  app.addContentTypeParser('application/x-www-form-urlencoded',
    { parseAs: 'string' }, (_req, body: string, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)))
      } catch (err) {
        done(err as Error, undefined)
      }
    })

  app.addHook('onRequest', async (req) => {
    req.pool = pool
    req.principal = ANONYMOUS
  })

  // Nach dem Cookie-Plugin, weil die Grenze angemeldete Anfragen auslaesst.
  registerRateLimit(app)

  // Aufrufer bestimmen. Der Mandantenkontext kommt ausschliesslich von hier.
  app.addHook('preValidation', async (req) => {
    // Maschinen kommen mit einem Bearer-Token, Menschen mit dem Cookie. Das
    // Token zuerst: ein Client schickt kein Cookie, und wer beides schickt,
    // meint das Token.
    const bearer = req.headers.authorization
    if (bearer?.startsWith('Bearer ')) {
      req.principal = await loadPrincipalFromToken(pool, bearer.slice(7))
      return
    }

    const sessionId = req.cookies['hp_session']
    if (!sessionId) return
    const { rows } = await pool.query<{ user_id: number; active_user_id: number | null }>(
      `SELECT user_id, active_user_id FROM user_session
        WHERE id = $1 AND revoked_at IS NULL
          AND expires_at > now() AND absolute_expires_at > now()`, [sessionId])
    if (rows.length === 0) return
    const row = rows[0]!
    // Arbeitsplatz-PIN wechselt die handelnde Person, ohne Neuanmeldung.
    const effectiveUser = row.active_user_id ?? row.user_id
    let principal = await loadPrincipal(pool, effectiveUser)
    principal = await applySupportSession(pool, principal)
    req.principal = principal
    await pool.query(`UPDATE user_session SET last_seen_at = now() WHERE id = $1`, [sessionId])
  })

  app.setErrorHandler((err, req, reply) => {
    const instance = `urn:request:${req.id}`
    if (err instanceof AppError) {
      return reply.status(err.status).type('application/problem+json')
        .send(err.toProblem(instance))
    }
    const maybe = err as { validation?: unknown; message?: string }
    if (maybe.validation) {
      return reply.status(422).type('application/problem+json')
        .send(Errors.validation({ body: [maybe.message ?? 'ungueltig'] }).toProblem(instance))
    }
    req.log.error({ err }, 'Unbehandelter Fehler')
    // In Produktion keine Stapelspur, nur die Anfrage-ID fuer den Support.
    return reply.status(500).type('application/problem+json').send({
      type: 'urn:hotelpms:internal', title: 'Interner Fehler', status: 500,
      detail: config.nodeEnv === 'production' ? undefined : (err as Error).message,
      instance
    })
  })

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).type('application/problem+json')
      .send(Errors.notFound().toProblem(`urn:request:${req.id}`))
  })

  return { app, pool, config }
}
