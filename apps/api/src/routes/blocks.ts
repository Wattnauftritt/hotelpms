import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Kontingente und Gruppen (Aufgabe 10, Dokument 16).
 *
 * Ein Kontingent haelt Zimmer einer Kategorie fuer einen Zeitraum, ohne sie
 * einzeln zu verkaufen: `inventory_day.blocked` steigt, die Kapazitaet sinkt
 * fuer den freien Verkauf, aber verkauft ist noch nichts. Ein **Abruf** ist
 * eine Reservierung gegen dieses Kontingent -- der Platz wandert von
 * `blocked` nach `sold`, die Summe bleibt gleich.
 *
 * Der nicht abgerufene Rest faellt zum Freigabedatum zurueck in den freien
 * Verkauf. Das tut der Nachtlauf (Schritt 6) und tat es schon, bevor es
 * ueberhaupt einen Weg gab, etwas abzurufen.
 */

export interface BlockRow {
  id: number
  property_id: number
  category_id: number
  from_date: string
  to_date: string
  quantity: number
  picked_up: number
  status: string
  rate_plan_id: number | null
}

const FIELDS = `id, property_id, public_ref, name, category_id, company_id, rate_plan_id,
                from_date::text AS from_date, to_date::text AS to_date,
                quantity, picked_up, release_date::text AS release_date, status`

/** Laedt ein Kontingent unter Zeilensperre. Die Zeilenrichtlinie filtert den Mandanten. */
export async function loadBlock(client: PoolClient, ref: string): Promise<BlockRow> {
  const { rows, rowCount } = await client.query<BlockRow>(
    `SELECT ${FIELDS} FROM availability_block WHERE public_ref = $1 FOR UPDATE`, [ref])
  if (rowCount === 0) throw Errors.notFound('res.block')
  return rows[0]!
}

export function blockRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/blocks',
    permission: 'inventory:write',
    propertyParam: 'propertyId',
    summary: 'Kontingent anlegen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const pid = Number(propertyId)
      const body = req.body as {
        name: string; categoryId: number; fromDate: string; toDate: string
        quantity: number; companyId?: number; ratePlanId?: number; releaseDate?: string
      }
      const principal = req.principal as Principal

      if (!isIsoDate(body.fromDate) || !isIsoDate(body.toDate)) {
        throw Errors.validation({ fromDate: ['field.isoDate'] })
      }
      if (nightsBetween(body.fromDate, body.toDate) <= 0) {
        throw Errors.validation({ toDate: ['field.afterFromDate'] })
      }
      if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
        throw Errors.validation({ quantity: ['field.positiveInteger'] })
      }
      if (body.releaseDate !== undefined && !isIsoDate(body.releaseDate)) {
        throw Errors.validation({ releaseDate: ['field.isoDate'] })
      }

      return tx(req.pool, req, async client => {
        // Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus. Wer eine
        // Kategorie entgegennimmt, prueft zusaetzlich die Property.
        const k = await client.query(
          `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2`,
          [body.categoryId, pid])
        if (k.rowCount === 0) throw Errors.notFound('res.category')

        // Kontingent zuerst binden. Schlaegt das fehl, wird alles
        // zurueckgerollt und es entsteht kein Kontingent ohne Deckung.
        const inv = await client.query<{ e: string | null }>(
          `SELECT inventory_block($1,$2,$3::date,$4::date,$5) AS e`,
          [pid, body.categoryId, body.fromDate, body.toDate, body.quantity])
        if (inv.rows[0]!.e === 'sold_out') throw Errors.soldOut()
        if (inv.rows[0]!.e !== null) {
          throw Errors.conflict('inventory.unknownError', { code: inv.rows[0]!.e })
        }

        const r = await client.query<{ public_ref: string }>(
          `INSERT INTO availability_block
             (property_id, name, category_id, company_id, rate_plan_id,
              from_date, to_date, quantity, release_date)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9::date)
           RETURNING public_ref`,
          [pid, body.name, body.categoryId, body.companyId ?? null,
           body.ratePlanId ?? null, body.fromDate, body.toDate, body.quantity,
           body.releaseDate ?? null])

        reply.status(201)
        return {
          blockRef: r.rows[0]!.public_ref,
          quantity: body.quantity,
          pickedUp: 0,
          by: principal.userId
        }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/blocks',
    permission: 'inventory:read',
    propertyParam: 'propertyId',
    summary: 'Kontingente mit Abrufstand',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { status } = req.query as { status?: string }

      return tx(req.pool, req, async client => {
        /*
         * Ein Aufruf je Bildschirm. Die Abrufe kommen als Feld mit, nicht als
         * eine Nachfrage je Kontingent: sonst kostet die Gruppenliste eine
         * Runde je Zeile. Die Menge ist durch `quantity` begrenzt und damit
         * klein.
         */
        const { rows } = await client.query(
          `SELECT b.public_ref AS "blockRef", b.name, b.category_id AS "categoryId",
                  c.name AS "categoryName", co.name AS "companyName",
                  b.from_date::text AS "fromDate", b.to_date::text AS "toDate",
                  b.quantity, b.picked_up AS "pickedUp",
                  (b.quantity - b.picked_up) AS "remaining",
                  b.release_date::text AS "releaseDate", b.status,
                  COALESCE(p.abrufe, '[]'::jsonb) AS pickups
             FROM availability_block b
             JOIN resource_category c ON c.id = b.category_id
             LEFT JOIN company co ON co.id = b.company_id
             LEFT JOIN LATERAL (
               SELECT jsonb_agg(jsonb_build_object(
                        'reservationRef', r.public_ref,
                        'status', r.status,
                        'arrival', r.arrival::text,
                        'departure', r.departure::text,
                        'guest', trim(both ', ' from
                                   coalesce(g.last_name,'') || ', ' || coalesce(g.first_name,''))
                      ) ORDER BY r.id) AS abrufe
                 FROM reservation r
                 LEFT JOIN guest g ON g.id = r.primary_guest_id
                WHERE r.block_id = b.id
             ) p ON true
            WHERE b.property_id = $1
              AND ($2::text IS NULL OR b.status = $2)
            ORDER BY b.from_date, b.id`,
          [Number(propertyId), status ?? null])
        return { blocks: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/blocks/:blockRef/release',
    permission: 'inventory:write',
    summary: 'Nicht abgerufenen Rest eines Kontingents freigeben',
    handler: async (req) => {
      const { blockRef } = req.params as { blockRef: string }
      return tx(req.pool, req, async client => {
        const b = await loadBlock(client, blockRef)
        if (b.status !== 'active') {
          throw Errors.conflict('block.alreadyStatus', { status: b.status })
        }

        // Nur der Rest. Die abgerufenen Plaetze sind verkauft und stehen in
        // `sold`; sie hier mit freizugeben, zaehlte sie doppelt zurueck.
        const rest = b.quantity - b.picked_up
        if (rest > 0) {
          await client.query(`SELECT inventory_unblock($1,$2,$3::date,$4::date,$5)`,
            [b.property_id, b.category_id, b.from_date, b.to_date, rest])
        }
        await client.query(
          `UPDATE availability_block SET status = 'released' WHERE id = $1`, [b.id])

        return { blockRef, released: rest, pickedUp: b.picked_up, status: 'released' }
      })
    }
  })
}
