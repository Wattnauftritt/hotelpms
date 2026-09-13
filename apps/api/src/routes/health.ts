import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'

export function healthRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET', url: '/health', permission: null, summary: 'Bereitschaft',
    handler: async (req) => {
      await req.pool.query('SELECT 1')
      return { status: 'ok' }
    }
  })
}
