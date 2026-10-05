import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'

/**
 * Befreiungsgruende fuer die Kurtaxe, je Haus (Migration 0089).
 *
 * Was eine Befreiung begruendet, regelt die Satzung der Gemeinde, und die
 * AVS-Kategorie dazu gilt nur dort. Deshalb pflegt das Haus die Liste, und
 * das Meldeformular bietet genau sie an.
 *
 * Kein Loeschen: ein Meldeschein zeigt auf den Grund, den der Gast gewaehlt
 * hat. Was das Haus nicht mehr anbietet, wird abgeschaltet.
 */

interface ReasonBody {
  code?: unknown
  label?: unknown
  needsProof?: unknown
  avsCategory?: unknown
  active?: unknown
  sort?: unknown
}

const LABEL_MAX = 120

interface Geprueft {
  label?: string
  needsProof?: boolean
  avsCategory?: number | null
  active?: boolean
  sort?: number
}

function pruefe(b: ReasonBody, neu: boolean): Geprueft & { code?: string } {
  const f: Record<string, Meldung[]> = {}
  const out: Geprueft & { code?: string } = {}
  if (neu) {
    if (typeof b.code !== 'string' || !/^[a-z0-9_]{1,40}$/.test(b.code)) {
      f.code = ['field.invalid']
    } else out.code = b.code
  }
  if (b.label !== undefined || neu) {
    if (typeof b.label !== 'string' || b.label.trim() === '') f.label = ['field.required']
    else if (b.label.length > LABEL_MAX) f.label = ['field.maxLength']
    else out.label = b.label.trim()
  }
  if (b.needsProof !== undefined) {
    if (typeof b.needsProof !== 'boolean') f.needsProof = ['field.invalid']
    else out.needsProof = b.needsProof
  }
  if (b.avsCategory !== undefined) {
    if (b.avsCategory === null) out.avsCategory = null
    else if (!Number.isInteger(b.avsCategory) || (b.avsCategory as number) < 1
             || (b.avsCategory as number) > 99) f.avsCategory = ['field.invalid']
    else out.avsCategory = b.avsCategory as number
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') f.active = ['field.invalid']
    else out.active = b.active
  }
  if (b.sort !== undefined) {
    if (!Number.isInteger(b.sort) || Math.abs(b.sort as number) > 1000) f.sort = ['field.invalid']
    else out.sort = b.sort as number
  }
  if (Object.keys(f).length > 0) throw Errors.validation(f, { max: LABEL_MAX })
  return out
}

const SPALTEN = `public_ref AS "reasonRef", code, label, needs_proof AS "needsProof",
                 avs_category AS "avsCategory", active, sort`

export function taxExemptionRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/city-tax-exemptions',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Befreiungsgruende fuer die Kurtaxe, auch abgeschaltete',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT ${SPALTEN} FROM city_tax_exemption_reason
            WHERE property_id = $1 ORDER BY sort, label`, [Number(propertyId)])
        return { reasons: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/city-tax-exemptions',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Befreiungsgrund anlegen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = pruefe((req.body ?? {}) as ReasonBody, true)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `INSERT INTO city_tax_exemption_reason
             (property_id, code, label, needs_proof, avs_category, active, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (property_id, code) DO NOTHING
           RETURNING ${SPALTEN}`,
          [Number(propertyId), b.code, b.label, b.needsProof ?? false,
           b.avsCategory ?? null, b.active ?? true, b.sort ?? 0])
        if (rows.length === 0) throw Errors.conflict('exemption.codeTaken')
        reply.status(201)
        return rows[0]
      })
    }
  })

  /**
   * Beschriftung, Nummernfeld, AVS-Kategorie, Reihenfolge, an/aus. Das
   * Kuerzel bleibt: es ist der Schluessel, unter dem ein Umsystem den Grund
   * schickt.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/properties/:propertyId/city-tax-exemptions/:reasonRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Befreiungsgrund aendern oder abschalten',
    handler: async (req) => {
      const { propertyId, reasonRef } = req.params as { propertyId: string; reasonRef: string }
      const b = pruefe((req.body ?? {}) as ReasonBody, false)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `UPDATE city_tax_exemption_reason
              SET label        = COALESCE($3, label),
                  needs_proof  = COALESCE($4, needs_proof),
                  avs_category = CASE WHEN $5::boolean THEN $6::smallint ELSE avs_category END,
                  active       = COALESCE($7, active),
                  sort         = COALESCE($8, sort)
            WHERE property_id = $1 AND public_ref = $2
            RETURNING ${SPALTEN}`,
          [Number(propertyId), reasonRef, b.label ?? null, b.needsProof ?? null,
           b.avsCategory !== undefined, b.avsCategory ?? null, b.active ?? null,
           b.sort ?? null])
        if (rows.length === 0) throw Errors.notFound('res.exemption')
        return rows[0]
      })
    }
  })
}
