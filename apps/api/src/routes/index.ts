import type { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.js'
import { availabilityRoutes } from './availability.js'
import { reservationRoutes } from './reservations.js'
import { billingRoutes } from './billing.js'
import { guestRoutes } from './guests.js'
import { rateRoutes } from './rates.js'
import { housekeepingRoutes } from './housekeeping.js'
import { registrationRoutes } from './registrations.js'
import { reportRoutes } from './reports.js'
import { importRoutes } from './import.js'

export function registerAllRoutes(app: FastifyInstance): void {
  healthRoutes(app)
  availabilityRoutes(app)
  reservationRoutes(app)
  billingRoutes(app)
  guestRoutes(app)
  rateRoutes(app)
  housekeepingRoutes(app)
  registrationRoutes(app)
  reportRoutes(app)
  importRoutes(app)
}
