import type { FastifyInstance } from 'fastify'
import { randomBytes, randomInt } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { verlangeBestaetigung } from '../platform/bestaetigung.js'
import { tx } from '../platform/db.js'
import { loadConfig } from '../platform/config.js'
import { koederNeuLaden } from '../platform/koeder.js'
import { kennung } from './platform.js'

const config = loadConfig()

/**
 * Koeder anlegen und entfernen, nur fuer uns (Migration 0213,
 * Bedrohungsanalyse 23.10.2026, E5).
 *
 * **Warum nicht der Kunde selbst.** Ein Koeder taugt so lange, wie ihn
 * niemand kennt, der Daten abziehen koennte -- und dazu gehoert jeder mit
 * einem Zugang beim Kunden, auch ein uebernommener. Der Kunde erfaehrt von
 * seinem Koeder, wenn er anschlaegt.
 */

/*
 * Namen, die in einer Gaestedatei an der Nordsee niemandem auffallen. Ohne
 * Umlaute, weil sie den Anfang der Adresse bilden; der Nachname ist mit
 * Absicht selten genug, dass kein echter Gast denselben traegt.
 */
const VORNAMEN = ['jonas', 'lena', 'tobias', 'miriam', 'felix', 'carla', 'henrik',
  'svenja', 'malte', 'ines', 'bastian', 'kerstin', 'lukas', 'anke', 'moritz', 'birte']
const NACHNAMEN = ['kerber', 'wiesener', 'hollmann', 'tewes', 'brockhoff', 'lindemeyer',
  'rautenberg', 'osterkamp', 'fehrmann', 'walterscheid', 'kampmeier', 'ruhnau']
const ORTE = ['Kassel', 'Bielefeld', 'Osnabrück', 'Hildesheim', 'Paderborn', 'Göttingen',
  'Marburg', 'Detmold']

const gross = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const eins = <T>(xs: readonly T[]): T => xs[randomInt(xs.length)]!

/** Etwa "jonas.kerber47": sieht aus wie jede andere Adresse, s. Migration 0213. */
function erfinden(): { tag: string; vorname: string; nachname: string; ort: string } {
  const vorname = eins(VORNAMEN)
  const nachname = eins(NACHNAMEN)
  return {
    tag: `${vorname}.${nachname}${randomInt(10, 99)}`,
    vorname: gross(vorname), nachname: gross(nachname), ort: eins(ORTE)
  }
}

export function koederRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/accounts/:id/decoys',
    permission: 'platform:accounts',
    summary: 'Koeder eines Kunden',
    handler: async (req) => {
      const accountId = kennung(req)
      return tx(req.pool, req, async client => {
        const decoys = await client.query(
          `SELECT property_id AS "propertyId", address, created_at AS "createdAt"
             FROM platform_decoys($1)`, [accountId])
        const clients = await client.query(
          `SELECT client_id AS "clientId", name, created_at AS "createdAt"
             FROM platform_decoy_clients($1)`, [accountId])
        return { decoys: decoys.rows, clients: clients.rows,
                 domainConfigured: config.decoyEmailDomain !== null }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/properties/:propertyId/decoy',
    permission: 'platform:accounts',
    summary: 'Koedergast in einem Haus anlegen',
    handler: async (req, reply) => {
      const accountId = kennung(req)
      const propertyId = kennung(req, 'propertyId')
      const domain = config.decoyEmailDomain
      if (domain === null) throw Errors.conflict('platform.decoyDomainMissing')
      await verlangeBestaetigung(req)

      const angelegt = await tx(req.pool, req, async client => {
        const haus = await client.query(
          `SELECT 1 FROM platform_account_properties($1) WHERE id = $2`,
          [accountId, propertyId])
        if (haus.rowCount === 0) throw Errors.notFound('res.property')
        const schon = await client.query(
          `SELECT 1 FROM platform_decoys($1) WHERE property_id = $2`, [accountId, propertyId])
        if (schon.rowCount !== 0) throw Errors.conflict('platform.decoyExists')

        // Ein Name kann schon vergeben sein; einige Wuerfe genuegen bei
        // rund fuenfzehntausend Moeglichkeiten, danach meldet UNIQUE.
        for (let versuch = 0; ; versuch++) {
          const n = erfinden()
          const vergeben = await client.query(
            `SELECT 1 FROM decoy_tags() WHERE tag = $1`, [n.tag])
          if (vergeben.rowCount !== 0 && versuch < 5) continue
          const r = await client.query<{ address: string }>(
            `SELECT address FROM decoy_plant($1, $2, $3, $4, $5, $6)`,
            [propertyId, domain, n.tag, n.vorname, n.nachname, n.ort])
            .catch((err: unknown) => {
              // Ohne Kategorie keine Buchung; s. decoy_plant().
              if ((err as { code?: string }).code === 'P0002') {
                throw Errors.conflict('platform.decoyNoCategory')
              }
              throw err
            })
          return r.rows[0]!
        }
      })
      await koederNeuLaden(req.pool)
      // Ins Protokoll, nicht ins Sicherheitsprotokoll des Kunden: dort laese
      // jeder mit einem Zugang beim Kunden, dass es einen Koeder gibt.
      req.log.info({ accountId, propertyId }, 'koeder angelegt')
      reply.status(201)
      return { propertyId, address: angelegt.address }
    }
  })

  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/platform/accounts/:id/properties/:propertyId/decoy',
    permission: 'platform:accounts',
    summary: 'Koedergast eines Hauses entfernen',
    handler: async (req) => {
      const accountId = kennung(req)
      const propertyId = kennung(req, 'propertyId')
      await tx(req.pool, req, async client => {
        const haus = await client.query(
          `SELECT 1 FROM platform_account_properties($1) WHERE id = $2`,
          [accountId, propertyId])
        if (haus.rowCount === 0) throw Errors.notFound('res.property')
        const r = await client.query<{ ok: boolean }>(
          'SELECT decoy_remove($1) AS ok', [propertyId])
        if (r.rows[0]?.ok !== true) throw Errors.notFound('res.decoy')
      })
      req.log.info({ accountId, propertyId }, 'koeder entfernt')
      await koederNeuLaden(req.pool)
      return { propertyId, removed: true }
    }
  })

  /*
   * Ein Koederzugang. Das Geheimnis geht genau einmal hinaus, wie bei jedem
   * Maschinenzugang -- nur dass es nicht in ein Umsystem kommt, sondern
   * dorthin, wo ein Angreifer suchen wuerde (Dokument 16, Fuenfter Teil).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/accounts/:id/decoy-clients',
    permission: 'platform:accounts',
    summary: 'Koederzugang anlegen',
    handler: async (req, reply) => {
      const accountId = kennung(req)
      const name = String((req.body as { name?: unknown } | null)?.name ?? '').trim()
      if (name.length === 0 || name.length > 100) {
        throw Errors.validation({ name: ['field.required'] })
      }
      await verlangeBestaetigung(req)
      const secret = randomBytes(32).toString('base64url')
      const clientId = await tx(req.pool, req, async client => {
        const konto = await client.query(
          `SELECT 1 FROM platform_accounts() WHERE id = $1`, [accountId])
        if (konto.rowCount === 0) throw Errors.notFound('platform.accountNotFound')
        const r = await client.query<{ ref: string }>(
          'SELECT decoy_client_create($1, $2, $3) AS ref',
          [accountId, name,
           await argonHash(secret, { memoryCost: 19_456, timeCost: 2, parallelism: 1 })])
        return r.rows[0]!.ref
      })
      reply.status(201)
      return { clientId, clientSecret: secret, name }
    }
  })
}
