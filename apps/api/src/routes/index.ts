import type { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.js'
import { authRoutes } from './auth.js'
import { availabilityRoutes } from './availability.js'
import { reservationRoutes } from './reservations.js'
import { billingRoutes } from './billing.js'
import { guestRoutes } from './guests.js'
import { rateRoutes } from './rates.js'
import { housekeepingRoutes } from './housekeeping.js'
import { registrationRoutes } from './registrations.js'
import { reportRoutes } from './reports.js'
import { importRoutes } from './import.js'
import { legacyImportRoutes } from './legacyImport.js'
import { setupRoutes } from './setup.js'
import { blockRoutes } from './blocks.js'
import { oauthRoutes } from './oauth.js'
import { paymentsRoutes, type PaymentRouteOverrides } from './payments.js'
import { webhookRoutes } from './webhooks.js'
import { channelRoutes } from './channel.js'
import { posRoutes } from './pos.js'
import { emailRoutes } from './email.js'
import { userRoutes } from './users.js'
import { onboardingRoutes } from './onboarding.js'
import { supportRoutes } from './support.js'
import { deploymentRoutes } from './deployments.js'
import { openApiRoutes } from './openapi.js'

export interface RouteOverrides {
  /** Nur fuer Tests: ersetzt Aussenanbindungen, ohne echte Netzwerkaufrufe. */
  payments?: PaymentRouteOverrides
}

export function registerAllRoutes(app: FastifyInstance, overrides: RouteOverrides = {}): void {
  healthRoutes(app)
  authRoutes(app)
  availabilityRoutes(app)
  reservationRoutes(app)
  billingRoutes(app)
  guestRoutes(app)
  rateRoutes(app)
  housekeepingRoutes(app)
  registrationRoutes(app)
  reportRoutes(app)
  importRoutes(app)
  legacyImportRoutes(app)
  setupRoutes(app)
  blockRoutes(app)
  oauthRoutes(app)
  paymentsRoutes(app, overrides.payments)
  webhookRoutes(app)
  channelRoutes(app)
  posRoutes(app)
  emailRoutes(app)
  userRoutes(app)
  onboardingRoutes(app)
  supportRoutes(app)
  deploymentRoutes(app)
  // Zuletzt: die Beschreibung liest die Registrierung aller Routen.
  openApiRoutes(app)
}
