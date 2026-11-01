import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { MCP_KLARTEXT_ZEILEN } from '@hotelpms/contracts'
import { anmelden, protokollieren, type Pool, type Verbindung } from './db.js'
import { journalctl, type JournalLeser } from './journal.js'
import { Eingabefehler, WERKZEUGE, type Umgebung, type Werkzeug } from './werkzeuge.js'
import { SqlAbgewiesen } from './sql.js'

/**
 * Der MCP-Endpunkt des Claude-Zugangs (Dokument 38).
 *
 * Von Hand statt mit dem SDK: der Dienst braucht genau vier Methoden
 * (`initialize`, `ping`, `tools/list`, `tools/call`) ueber Streamable HTTP
 * ohne Sitzung und ohne Rueckkanal. Das sind zweihundert Zeilen, die man
 * ganz lesen kann -- ein SDK braechte Sitzungen, SSE und Abhaengigkeiten
 * mit, die hier niemand braucht und jemand pruefen muesste.
 *
 * Der Dienst hoert nur auf 127.0.0.1; Caddy reicht `/mcp` und die
 * Metadaten weiter und laesst sie nur aus dem Netz von Anthropic zu
 * (ops/caddy/Caddyfile). Das Token pruefen trotzdem wir: die Netzsperre
 * ist die erste Linie, nicht die einzige.
 */

export const PROTOKOLL_VERSIONEN = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export interface Einstellungen {
  pool: Pool
  /** https://app.staygrid.cloud -- ohne Schraegstrich am Ende. */
  oeffentlicheAdresse: string
  journal?: JournalLeser
  protokollStufe?: string | false
}

interface JsonRpc {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

const FEHLER = { parse: -32700, anfrage: -32600, methode: -32601, parameter: -32602, intern: -32603 }

function antwort(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}
function fehler(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

export function buildMcp(e: Einstellungen): FastifyInstance {
  const app = Fastify({
    logger: e.protokollStufe === false ? false : {
      level: e.protokollStufe ?? 'info',
      // Kein Kopf, kein Rumpf ins Protokoll: der Kopf traegt das Token, der
      // Rumpf eine Abfrage, die einen Namen enthalten kann.
      serializers: { req: (r: FastifyRequest) => ({ method: r.method, url: r.url.split('?')[0] }) }
    },
    bodyLimit: 64 * 1024,
    trustProxy: '127.0.0.1'
  })
  const basis = e.oeffentlicheAdresse.replace(/\/+$/, '')
  const ressource = `${basis}/mcp`
  const metadaten = `${basis}/.well-known/oauth-protected-resource/mcp`
  const umgebung: Umgebung = { pool: e.pool, journal: e.journal ?? journalctl }

  // ------------------------------------------------------------ Metadaten

  const geschuetzt = () => ({
    resource: ressource,
    authorization_servers: [basis],
    bearer_methods_supported: ['header'],
    resource_name: 'StayGrid Claude-Zugang'
  })
  app.get('/.well-known/oauth-protected-resource', async () => geschuetzt())
  app.get('/.well-known/oauth-protected-resource/mcp', async () => geschuetzt())

  const autorisierung = () => ({
    issuer: basis,
    // Die Seite der Oberflaeche: dort meldet sich Sven mit Passkey an und
    // bestaetigt die Verbindung. Ein eigenes Formular hier waere eine zweite
    // Anmeldung, die neben der echten gepflegt werden muesste.
    authorization_endpoint: `${basis}/mcp-verbinden`,
    token_endpoint: `${basis}/v1/mcp/oauth/token`,
    registration_endpoint: `${basis}/v1/mcp/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['lesen']
  })
  app.get('/.well-known/oauth-authorization-server', async () => autorisierung())
  app.get('/.well-known/oauth-authorization-server/mcp', async () => autorisierung())

  // ------------------------------------------------------------- Endpunkt

  // Kein Rueckkanal, keine Sitzung: GET (SSE) und DELETE gibt es nicht.
  for (const m of ['GET', 'DELETE'] as const) {
    app.route({ method: m, url: '/mcp', handler: async (_q, r) => {
      return r.code(405).header('allow', 'POST').send()
    } })
  }

  const ohneAnmeldung = (r: FastifyReply) => r.code(401)
    .header('www-authenticate', `Bearer resource_metadata="${metadaten}"`)
    .send({ error: 'invalid_token' })

  app.post('/mcp', async (q, r) => {
    // Gegen DNS-Rebinding: ein Browser schickt Origin mit, Claude nicht.
    const origin = q.headers.origin
    if (origin !== undefined && origin !== basis && origin !== 'https://claude.ai') {
      return r.code(403).send({ error: 'origin' })
    }
    const kopf = q.headers.authorization ?? ''
    const m = /^Bearer\s+(sgmcp_[A-Za-z0-9_-]{20,100})$/.exec(kopf)
    if (m === null) return ohneAnmeldung(r)
    const v = await anmelden(e.pool, sha256(m[1]!))
    if (v === null) return ohneAnmeldung(r)

    const rumpf = q.body as unknown
    if (Array.isArray(rumpf)) {
      return r.code(400).send(fehler(null, FEHLER.anfrage, 'Keine Stapelanfragen.'))
    }
    if (rumpf === null || typeof rumpf !== 'object') {
      return r.code(400).send(fehler(null, FEHLER.parse, 'Kein JSON-RPC.'))
    }
    const n = rumpf as JsonRpc
    if (n.jsonrpc !== '2.0' || typeof n.method !== 'string') {
      return r.code(400).send(fehler(n.id, FEHLER.anfrage, 'Kein JSON-RPC 2.0.'))
    }
    // Eine Benachrichtigung hat keine id und bekommt keine Antwort.
    if (n.id === undefined) return r.code(202).send()

    const ergebnis = await bearbeiten(umgebung, v, n, q)
    return r.header('content-type', 'application/json').send(ergebnis)
  })

  return app
}

async function bearbeiten(u: Umgebung, v: Verbindung, n: JsonRpc, q: FastifyRequest) {
  const params = (n.params !== null && typeof n.params === 'object' ? n.params : {}) as
    Record<string, unknown>
  switch (n.method) {
    case 'initialize': {
      const gewuenscht = params.protocolVersion
      const version = PROTOKOLL_VERSIONEN.find(x => x === gewuenscht) ?? PROTOKOLL_VERSIONEN[0]
      return antwort(n.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'staygrid', title: 'StayGrid Claude-Zugang', version: '1' },
        instructions: ANLEITUNG
      })
    }
    case 'ping':
      return antwort(n.id, {})
    case 'tools/list':
      return antwort(n.id, { tools: WERKZEUGE.map(beschreibung) })
    case 'tools/call':
      return antwort(n.id, await aufrufen(u, v, params, q))
    default:
      return fehler(n.id, FEHLER.methode, `Unbekannte Methode: ${String(n.method).slice(0, 60)}`)
  }
}

function beschreibung(w: Werkzeug) {
  return {
    name: w.name, title: w.title, description: w.description, inputSchema: w.inputSchema,
    annotations: { readOnlyHint: w.readOnly, destructiveHint: false, idempotentHint: w.readOnly,
                   openWorldHint: false }
  }
}

/**
 * Ein Werkzeug ausfuehren und **jeden** Aufruf festhalten, auch den
 * gescheiterten. Ein Fehler geht als `isError` an Claude zurueck, nicht als
 * JSON-RPC-Fehler: so kann Claude die Meldung lesen und die Abfrage
 * richtigstellen, statt dass der Aufruf als Stoerung des Dienstes endet.
 */
async function aufrufen(u: Umgebung, v: Verbindung, params: Record<string, unknown>,
                        q: FastifyRequest) {
  const name = typeof params.name === 'string' ? params.name : ''
  const w = WERKZEUGE.find(x => x.name === name)
  const args = (params.arguments !== null && typeof params.arguments === 'object'
    && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>
  const beginn = performance.now()
  if (w === undefined) {
    await protokollieren(u.pool, v, { werkzeug: name.slice(0, 60) || '(leer)', haus: null,
      zeilen: 0, klartext: false, dauerMs: 0, ok: false, detail: 'unbekanntes Werkzeug' })
    return fehlerErgebnis(`Unbekanntes Werkzeug: ${name.slice(0, 60)}`)
  }
  try {
    const e = await w.ausfuehren(u, v, args)
    await protokollieren(u.pool, v, { werkzeug: w.name, haus: e.haus, zeilen: e.zeilen,
      klartext: e.klartext, dauerMs: performance.now() - beginn, ok: true, detail: e.detail })
    const textJson = JSON.stringify(e.daten, null, 1)
    return {
      content: [{ type: 'text', text: textJson }],
      structuredContent: { ergebnis: e.daten, klartext: e.klartext },
      isError: false
    }
  } catch (err) {
    const meldung = meldungAus(err)
    if (!(err instanceof Eingabefehler) && !(err instanceof SqlAbgewiesen)) {
      q.log.warn({ werkzeug: w.name, code: (err as { code?: unknown }).code },
                 'Werkzeug gescheitert')
    }
    await protokollieren(u.pool, v, { werkzeug: w.name, haus: null, zeilen: 0, klartext: false,
      dauerMs: performance.now() - beginn, ok: false, detail: meldung.slice(0, 500) })
      .catch(() => undefined)
    return fehlerErgebnis(meldung)
  }
}

/**
 * Die Meldung einer Datenbank ist fuer Claude das Wichtigste an einem
 * Fehler ("column xy does not exist"). Sie traegt keine Werte aus Zeilen --
 * PostgreSQL nennt einen Wert nur in `detail`, und das geben wir nicht
 * weiter.
 */
function meldungAus(err: unknown): string {
  if (err instanceof Eingabefehler || err instanceof SqlAbgewiesen) return err.message
  const p = err as { code?: unknown; message?: unknown }
  if (typeof p.code === 'string' && typeof p.message === 'string') {
    if (p.code === '57014') return 'Abgebrochen: laenger als fuenf Sekunden.'
    return `PostgreSQL ${p.code}: ${p.message.slice(0, 400)}`
  }
  return 'Interner Fehler im Claude-Zugang.'
}

function fehlerErgebnis(text: string) {
  return { content: [{ type: 'text', text }], isError: true }
}

const ANLEITUNG = [
  'Lesender Zugang zum Livesystem von StayGrid. Nichts hier aendert Daten.',
  'Personenbezogene Werte sind geschwaerzt ([geschwaerzt], IP als /24). Klartext gibt es nur fuer',
  'ein Haus und eine Stunde, wenn ein Mensch die Anfrage aus klartext_anfragen mit Passkey',
  `freigibt; je Freigabe hoechstens ${MCP_KLARTEXT_ZEILEN} Zeilen. Geheimnisse, Unterschriften und Dateien`,
  'gibt es nie. Jeder Aufruf wird protokolliert.',
  'Zum Einstieg: ueberblick, dann tabellen fuer die Spalten, dann sql_lesen.'
].join(' ')

