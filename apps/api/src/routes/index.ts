import type { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.js'
import { availabilityRoutes } from './availability.js'
import { reservationRoutes } from './reservations.js'
import { billingRoutes } from './billing.js'

export function registerAllRoutes(app: FastifyInstance): void {
  healthRoutes(app)
  availabilityRoutes(app)
  reservationRoutes(app)
  billingRoutes(app)
}
