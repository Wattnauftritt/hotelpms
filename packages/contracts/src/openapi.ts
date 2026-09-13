/**
 * OpenAPI-Dokument aus der Routenliste erzeugen.
 *
 * Der Punkt ist nicht, ein Dokument zu haben, sondern **kein zweites zu
 * pflegen**. Eine handgeschriebene Spezifikation weicht nach drei Monaten
 * von der Umsetzung ab, und dann glaubt ihr niemand mehr. Hier ist die
 * Registrierung der Route die einzige Quelle: was nicht registriert ist,
 * steht nicht im Dokument, und was registriert ist, steht darin samt der
 * Berechtigung, die es verlangt (API-first, Dokument 04).
 */

export interface RouteDescription {
  method: string
  url: string
  permission: string | null
  propertyParam?: string
  summary: string
  schema?: unknown
}

export interface OpenApiOptions {
  title?: string
  version?: string
  description?: string
  servers?: Array<{ url: string; description?: string }>
}

/** Fastify schreibt `:id`, OpenAPI schreibt `{id}`. */
export function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

export function pathParameters(url: string): string[] {
  return [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => m[1]!)
}

/** Kurzer, stabiler Bezeichner je Operation. */
export function operationId(method: string, url: string): string {
  const teile = url.split('/').filter(t => t !== '' && t !== 'v1')
  const name = teile.map(t => t.startsWith(':')
    ? 'By' + t.slice(1, 2).toUpperCase() + t.slice(2)
    : t.split('-').map(w => w.slice(0, 1).toUpperCase() + w.slice(1)).join(''))
    .join('')
  return method.toLowerCase() + name
}

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' }

/**
 * Fehler, die jede geschuetzte Route liefern kann. Sie hier einmal zu
 * beschreiben ist ehrlicher, als sie an jeder Operation zu wiederholen und
 * an der Haelfte zu vergessen.
 */
const GEMEINSAME_FEHLER: Record<string, { description: string }> = {
  '401': { description: 'Nicht angemeldet' },
  '403': { description: 'Keine Berechtigung fuer diese Property' },
  '422': { description: 'Eingabe ungueltig' },
  '500': { description: 'Unerwarteter Fehler' }
}

export function buildOpenApi(
  routes: readonly RouteDescription[], opts: OpenApiOptions = {}
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const r of [...routes].sort((a, b) =>
    a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url))) {
    const pfad = toOpenApiPath(r.url)
    paths[pfad] ??= {}

    const parameters = pathParameters(r.url).map(name => ({
      name, in: 'path', required: true,
      schema: { type: name.endsWith('Id') ? 'integer' : 'string' }
    }))

    const responses: Record<string, unknown> = {
      '200': { description: 'Erfolg' }
    }
    if (r.method === 'POST') {
      responses['201'] = { description: 'Angelegt' }
    }
    if (r.permission !== null) {
      for (const [code, v] of Object.entries(GEMEINSAME_FEHLER)) {
        responses[code] = {
          description: v.description,
          content: { 'application/problem+json': { schema: PROBLEM_REF } }
        }
      }
    }

    paths[pfad][r.method.toLowerCase()] = {
      operationId: operationId(r.method, r.url),
      summary: r.summary,
      tags: [r.url.split('/')[2] ?? 'sonstige'],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(r.schema !== undefined ? { requestBody: r.schema } : {}),
      responses,
      // Die Berechtigung steht am Endpunkt, nicht in einer Tabelle daneben.
      // Wer die Schnittstelle liest, sieht sofort, welche Rolle sie braucht.
      'x-required-permission': r.permission,
      ...(r.propertyParam !== undefined
        ? { 'x-property-parameter': r.propertyParam } : {}),
      security: r.permission === null ? [] : [{ sessionCookie: [] }]
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? 'hotelpms API',
      version: opts.version ?? '1.0.0',
      description: opts.description
        ?? 'Schnittstelle des Hotel-Property-Management-Systems. '
         + 'Jede Operation nennt die Berechtigung, die sie verlangt, '
         + 'unter x-required-permission. Fehler folgen RFC 9457.'
    },
    servers: opts.servers ?? [{ url: '/', description: 'Diese Instanz' }],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'hp_session' }
      },
      schemas: {
        Problem: {
          type: 'object',
          description: 'Fehlerdarstellung nach RFC 9457.',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string', examples: ['urn:hotelpms:sold_out'] },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string',
                        description: 'Anfrage-ID fuer den Support.' },
            errors: {
              type: 'object',
              additionalProperties: { type: 'array', items: { type: 'string' } },
              description: 'Feldbezogene Meldungen bei Status 422.'
            }
          }
        }
      }
    }
  }
}
