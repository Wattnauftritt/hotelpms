import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Permission } from './permissions.js'
import { Errors } from './errors.js'
import { can, hasProperty, type Principal } from './context.js'

/**
 * Registrierung einer Route mit **deklarierter** Berechtigung.
 *
 * Es gibt keinen anderen Weg, eine Route anzulegen. Damit kann der generische
 * Berechtigungstest ueber alle Routen laufen, und eine Route ohne Angabe
 * bricht den Build (S13, Dokument 12).
 */
export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  /** null bedeutet ausdruecklich oeffentlich, etwa Anmeldung oder Health. */
  permission: Permission | null
  /** Name des Pfad- oder Query-Parameters, der die Property benennt. */
  propertyParam?: string
  summary: string
  /**
   * Abweichende Obergrenze fuer den Rumpf. Der Standard von einem Megabyte
   * ist fuer Fachaufrufe reichlich und fuer eine Importdatei zu wenig:
   * 20 000 Reservierungen als CSV sind mehrere Megabyte.
   */
  bodyLimit?: number
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: any
}

const registry: RouteSpec[] = []

export function registeredRoutes(): readonly RouteSpec[] {
  return registry
}

export function resolveProperty(req: FastifyRequest, spec: RouteSpec): number | undefined {
  if (!spec.propertyParam) return undefined
  const params = req.params as Record<string, string> | undefined
  const query = req.query as Record<string, string> | undefined
  const body = req.body as Record<string, unknown> | undefined
  const raw = params?.[spec.propertyParam]
    ?? query?.[spec.propertyParam]
    ?? (body?.[spec.propertyParam] as string | number | undefined)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export function registerRoute(app: FastifyInstance, spec: RouteSpec): void {
  registry.push(spec)
  app.route({
    method: spec.method,
    url: spec.url,
    ...(spec.schema ? { schema: spec.schema } : {}),
    ...(spec.bodyLimit !== undefined ? { bodyLimit: spec.bodyLimit } : {}),
    preHandler: async (req) => {
      if (spec.permission === null) return
      const principal = req.principal as Principal
      if (principal.userId === null && principal.clientKey === 'anonymous') {
        throw Errors.unauthorized()
      }
      const property = resolveProperty(req, spec)
      if (property !== undefined && !hasProperty(principal, property)) {
        // Bewusst nicht 404 gegen 403 unterscheiden: wer keinen Zugriff hat,
        // soll nicht erfahren, ob die Property existiert.
        throw Errors.forbidden('access.propertyOutOfScope')
      }
      if (!can(principal, spec.permission, property)) {
        throw Errors.forbidden('access.missingPermission',
          { permission: spec.permission })
      }
    },
    handler: spec.handler
  })
}
