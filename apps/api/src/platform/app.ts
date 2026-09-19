import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { createPool, type Pool } from '@hotelpms/db'
import { loadConfig, type Config } from './config.js'
import { renderMessage } from '@hotelpms/contracts'
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

/**
 * Abfrageparameter, die ins Protokoll duerfen (Befund B2, Dokument 25).
 *
 * Eine Positivliste, nicht eine Sperrliste: was neu hinzukommt, ist
 * stillschweigend **nicht** dabei, und der schlechtere Fall ist ein Protokoll
 * ohne Zeitraum, nicht ein Protokoll mit einem Gastnamen. Drin sind die
 * Parameter, die bei der Fehlersuche wirklich helfen und keine Person
 * bezeichnen; `q` ist der Nachname eines Gastes und deshalb draussen.
 */
const PROTOKOLL_PARAMETER = new Set([
  'from', 'to', 'date', 'since', 'month', 'days', 'limit', 'status',
  'kind', 'format', 'full', 'compare', 'includeInactive'
])

/**
 * Serialisierer der Anfrage fuers Protokoll (Befund B2, Dokument 25).
 *
 * Der Befund: die Redaktionsliste deckte Kopfzeilen, Rumpf, Kennwort und
 * Ausweisnummer ab, nicht aber die Adresse selbst -- und Fastify protokolliert
 * sie mitsamt Abfragezeichenfolge. `GET /v1/guests?q=Petersen` schrieb damit
 * bei jeder Suche den Nachnamen eines Gastes ins Protokoll, mit Zeitstempel
 * und Anfrage-ID daneben. Ein Protokoll geht andere Wege als eine Datenbank:
 * es wird eingesammelt, weitergeleitet, laenger aufbewahrt und von mehr
 * Leuten gelesen, und die Anonymisierung eines Gastes erreicht es nicht --
 * nach der Loeschung stand der Name dort weiter.
 *
 * Der Serialisierer ist die richtige Stelle, weil er greift, ohne dass jede
 * Route daran denken muss.
 */
function protokollAnfrage(req: {
  method: string; url: string; hostname?: string; ip?: string
  routeOptions?: { url?: string }
  socket?: { remotePort?: number }
}): Record<string, unknown> {
  const [pfad = '', abfrage] = req.url.split('?')
  const behalten: string[] = []
  let entfernt = 0
  if (abfrage !== undefined && abfrage !== '') {
    for (const [k, v] of new URLSearchParams(abfrage)) {
      if (PROTOKOLL_PARAMETER.has(k)) behalten.push(`${k}=${v}`)
      else entfernt++
    }
  }
  // Dass etwas entfernt wurde, steht als Zahl dabei. Ohne diesen Hinweis
  // sieht eine Suche im Protokoll wie ein Aufruf ohne Parameter aus, und die
  // Fehlersuche sucht an der falschen Stelle.
  if (entfernt > 0) behalten.push(`[${entfernt} entfernt]`)

  return {
    method: req.method,
    url: behalten.length > 0 ? `${pfad}?${behalten.join('&')}` : pfad,
    // Das Routenmuster, nicht der ausgefuellte Pfad: damit sind Aufrufe
    // derselben Route zusammenzaehlbar, ohne die Kennungen darin zu lesen.
    routerPath: req.routeOptions?.url,
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort
  }
}

export async function buildServer(
  overrides: { pool?: Pool; logStream?: NodeJS.WritableStream } = {}
): Promise<Server> {
  const config = loadConfig()
  const pool = overrides.pool ?? createPool({ kind: 'app', max: 10, applicationName: 'hotelpms-api' })

  const logOptions = {
    level: overrides.logStream === undefined ? config.logLevel : 'info',
    // Gaestedaten gehoeren nicht ins Protokoll (C8, Dokument 13).
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie',
              'req.body', 'res.body', '*.password', '*.idDocumentNumber'],
      remove: true
    },
    serializers: { req: protokollAnfrage },
    // Ein Ziel, das der Aufrufer vorgibt: nur ein Test setzt es, und er
    // braucht es, weil sich nur am geschriebenen Protokoll zeigt, was
    // wirklich darin steht (Befund B2, Dokument 25).
    ...(overrides.logStream === undefined ? {} : { stream: overrides.logStream })
  }

  const app = Fastify({
    logger: config.logLevel === 'silent' && overrides.logStream === undefined
      ? false
      : logOptions,
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
    // Wer sich angemeldet hat, bleibt bekannt, auch wenn gerade jemand
    // anderes handelt: die Oberflaeche zeigt den Wechsel damit an.
    principal = { ...principal, sessionUserId: row.user_id }
    req.principal = principal
    await pool.query(`UPDATE user_session SET last_seen_at = now() WHERE id = $1`, [sessionId])
  })

  // Erst jetzt, nicht vorher: ausnehmen laesst sich nur, wer sich
  // tatsaechlich ausgewiesen hat, und das steht erst hier fest.
  registerRateLimit(app)

  app.setErrorHandler((err, req, reply) => {
    const instance = `urn:request:${req.id}`
    if (err instanceof AppError) {
      return reply.status(err.status).type('application/problem+json')
        .send(err.toProblem(instance))
    }
    const maybe = err as { validation?: unknown; message?: string }
    if (maybe.validation) {
      return reply.status(422).type('application/problem+json')
        .send(Errors.validation({ body: [maybe.message ?? 'field.invalid'] })
          .toProblem(instance))
    }
    req.log.error({ err }, 'Unbehandelter Fehler')
    // In Produktion keine Stapelspur, nur die Anfrage-ID fuer den Support.
    return reply.status(500).type('application/problem+json').send({
      type: 'urn:hotelpms:internal', title: renderMessage('error.internal', 'de'),
      code: 'error.internal', status: 500,
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
