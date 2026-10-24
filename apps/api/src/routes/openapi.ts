import type { FastifyInstance } from 'fastify'
import { registerRoute, registeredRoutes, type RouteSpec } from '../platform/routes.js'
import type { Principal } from '../platform/context.js'
import { buildOpenApi } from '@hotelpms/contracts'

/**
 * Die Schnittstellenbeschreibung entsteht aus der Registrierung der Routen,
 * nicht aus einer gepflegten Datei daneben. Was nicht registriert ist, steht
 * nicht darin; was registriert ist, steht darin samt der Berechtigung, die
 * es verlangt. Damit kann die Beschreibung nicht veralten.
 *
 * **Wer was sieht** (Bedrohungsanalyse 23.10.2026, T9). Die Fachrouten
 * bleiben oeffentlich beschrieben: eine Schnittstelle, die man erst nach
 * Anmeldung lesen kann, wird nicht benutzt. Die Routen der Plattform und
 * des Gaesteterminals aber sind keine Schnittstelle fuer Dritte, sondern
 * eine Landkarte fuer einen Angreifer -- welche Rechte es gibt, wie eine
 * Ausrollung angestossen wird, wie ein Geraet sich ausweist. Ein
 * Sprachmodell liest so eine Datei in Sekunden und schreibt daraus den
 * Angriff. Deshalb: anonym ohne beides, angemeldet ohne die Plattform,
 * Plattformpersonal vollstaendig.
 */
const PLATTFORM = /^\/v1\/platform(\/|$)/
const TERMINAL = /^\/v1\/terminal/

export function sichtbareRouten(
  routen: readonly RouteSpec[], p: Principal | undefined
): RouteSpec[] {
  const angemeldet = p !== undefined && (p.userId !== null || p.clientKey.startsWith('client:'))
  const personal = p?.isPlatformStaff === true
  return routen.filter(r =>
    (personal || !PLATTFORM.test(r.url)) && (angemeldet || !TERMINAL.test(r.url)))
}

export function openApiRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/openapi.json',
    permission: null,
    summary: 'Schnittstellenbeschreibung nach OpenAPI 3.1',
    handler: async (req) =>
      buildOpenApi(sichtbareRouten(registeredRoutes(), req.principal as Principal | undefined))
  })
}
