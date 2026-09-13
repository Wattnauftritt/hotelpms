import type { FastifyInstance } from 'fastify'
import { registerRoute, registeredRoutes } from '../platform/routes.js'
import { buildOpenApi } from '@hotelpms/contracts'

/**
 * Die Schnittstellenbeschreibung entsteht aus der Registrierung der Routen,
 * nicht aus einer gepflegten Datei daneben. Was nicht registriert ist, steht
 * nicht darin; was registriert ist, steht darin samt der Berechtigung, die
 * es verlangt. Damit kann die Beschreibung nicht veralten.
 */
export function openApiRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/openapi.json',
    // Die Beschreibung nennt keine Daten, nur Endpunkte. Sie oeffentlich zu
    // halten ist der Sinn von API-first: eine Schnittstelle, die man erst
    // nach Anmeldung lesen kann, wird nicht benutzt.
    permission: null,
    summary: 'Schnittstellenbeschreibung nach OpenAPI 3.1',
    handler: async () => buildOpenApi(registeredRoutes())
  })
}
