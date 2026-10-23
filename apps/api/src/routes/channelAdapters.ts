import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { CHANNEL_CREDENTIALS_PURPOSE } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { verlangeBestaetigung, meldeSicherheitsereignis, meldeImHaus } from '../platform/bestaetigung.js'
import { encryptSecret } from '../platform/crypto.js'
import { loadConfig } from '../platform/config.js'
import { isTrainingProperty } from '../platform/training.js'
import type { Principal } from '../platform/context.js'

/*
 * Kanaladapter verwalten (Migration 0198, Thread "Anbindung weiterer
 * Channelmanager").
 *
 * Ein Adapter ist ein Zugang, ueber den **StayGrid** einen Channel Manager
 * anspricht -- anders als `channel-connections`, wo ein Umsystem StayGrid
 * mit einem Token ruft. Den Abgleich selbst macht der Worker
 * (`jobs/channelSync.ts`); hier wird eingerichtet, zugeordnet und
 * nachgesehen.
 *
 * **Zugangsdaten werden einmal angenommen und nie wieder ausgegeben.** Wie
 * beim Stripe-Schluessel (0168): gespeichert verschluesselt, angezeigt nur
 * Anfang und Ende. Wer sie aendern will, gibt neue ein.
 *
 * **Probebetrieb zuerst.** Ein neuer Adapter beginnt im Modus `shadow`,
 * wenn nichts anderes verlangt ist: erst die Zuordnung pruefen und im
 * Kanalprotokoll sehen, was er senden wuerde, dann umschalten. Solange ein
 * Adminpanel-Zugang im Haus aktiv ist, laesst sich ein RoomCloud-Adapter gar
 * nicht aktiv schalten -- beide sendeten dann an dasselbe RoomCloud-Haus
 * (Sven, 23.10.2026: die bisherige Verbindung bleibt im eigenen Hotel
 * parallel bestehen).
 */

const ANBIETER = ['roomcloud', 'channex'] as const
type Anbieter = (typeof ANBIETER)[number]
const MODI = ['shadow', 'active'] as const
type Modus = (typeof MODI)[number]

/** Zugangsdaten sind je Anbieter verschieden; ein Schluessel, ein JSON mit Benutzer und Kennwort. */
const MAX_CREDENTIALS = 2000
const MAX_MAP = 200
const config = loadConfig()

function hinweis(geheim: string): string {
  return geheim.length <= 8 ? '…' : `${geheim.slice(0, 4)}…${geheim.slice(-4)}`
}

function text(roh: unknown, feld: string, max: number): string {
  if (typeof roh !== 'string' || roh.trim() === '') {
    throw Errors.validation({ [feld]: ['field.required'] })
  }
  if (roh.length > max) throw Errors.validation({ [feld]: ['field.maxLength'] }, { max })
  return roh.trim()
}

function modus(roh: unknown): Modus {
  if (!MODI.includes(roh as Modus)) throw Errors.validation({ mode: ['field.invalid'] })
  return roh as Modus
}

interface AdapterZeile {
  id: number
  provider: Anbieter
}

async function adapterLesen(
  client: PoolClient, propertyId: number, ref: string, sperren = false
): Promise<AdapterZeile> {
  // channel_connection hat keine Zeilenrichtlinie (0023): das Haus aus der
  // Adresse wird hier geprueft, nicht nur ueber propertyParam.
  const r = await client.query<AdapterZeile>(
    `SELECT id, provider FROM channel_connection
      WHERE public_ref = $1 AND property_id = $2 AND kind = 'adapter' AND status = 'active'
      ${sperren ? 'FOR UPDATE' : ''}`, [ref, propertyId])
  if (r.rows[0] === undefined) throw Errors.notFound('res.connection')
  return r.rows[0]
}

/** RoomCloud aktiv, waehrend das Adminpanel noch mit RoomCloud spricht? */
async function adminpanelSperre(
  client: PoolClient, propertyId: number, provider: Anbieter, m: Modus
): Promise<void> {
  if (m !== 'active' || provider !== 'roomcloud') return
  const r = await client.query(
    `SELECT 1 FROM channel_connection
      WHERE property_id = $1 AND kind = 'inbound' AND provider = 'adminpanel'
        AND status = 'active' LIMIT 1`, [propertyId])
  if ((r.rowCount ?? 0) > 0) throw Errors.conflict('channel.adminpanelStillActive')
}

export function channelAdapterRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/channel-adapters',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Kanaladapter anlegen: StayGrid spricht einen Channel Manager selbst an',
    handler: async (req, reply) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!ANBIETER.includes(body.provider as Anbieter)) {
        throw Errors.validation({ provider: ['field.invalid'] })
      }
      const provider = body.provider as Anbieter
      const name = text(body.name, 'name', 100)
      const externalPropertyId = text(body.externalPropertyId, 'externalPropertyId', 100)
      const credentials = text(body.credentials, 'credentials', MAX_CREDENTIALS)
      const m = body.mode === undefined ? 'shadow' : modus(body.mode)
      const principal = req.principal as Principal
      await verlangeBestaetigung(req)

      return tx(req.pool, req, async client => {
        const prop = await client.query<{ account_id: number }>(
          `SELECT account_id FROM property WHERE id = $1`, [propertyId])
        if (prop.rowCount === 0) throw Errors.notFound('res.property')
        if (await isTrainingProperty(client, propertyId)) {
          throw Errors.unprocessable('training.noChannel')
        }
        await adminpanelSperre(client, propertyId, provider, m)
        const doppelt = await client.query(
          `SELECT 1 FROM channel_connection
            WHERE property_id = $1 AND provider = $2 AND kind = 'adapter' AND status = 'active'`,
          [propertyId, provider])
        if ((doppelt.rowCount ?? 0) > 0) throw Errors.conflict('channel.adapterExists')

        const r = await client.query<{ public_ref: string }>(
          `INSERT INTO channel_connection
             (property_id, account_id, provider, name, kind, sync_mode, credentials_enc,
              credentials_hint, external_property_id, created_by)
           VALUES ($1,$2,$3,$4,'adapter',$5,$6,$7,$8,$9) RETURNING public_ref`,
          [propertyId, prop.rows[0]!.account_id, provider, name, m,
           encryptSecret(credentials, config.idDocumentKey, CHANNEL_CREDENTIALS_PURPOSE),
           hinweis(credentials), externalPropertyId, principal.userId])
        await meldeSicherheitsereignis(client, req, {
          kind: 'channel_connection_created', accountId: prop.rows[0]!.account_id, propertyId,
          detail: { connectionRef: r.rows[0]!.public_ref, provider, externalPropertyId },
          hint: provider })
        reply.status(201)
        return { connectionRef: r.rows[0]!.public_ref, mode: m }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/channel-adapters',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Kanaladapter mit Zuordnung und Stand',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        // Ein Aufruf fuer den Bildschirm: Zugaenge, Zuordnungen und der
        // letzte Protokolleintrag je Zugang zusammen.
        const { rows } = await client.query(
          `SELECT c.public_ref AS "connectionRef", c.provider, c.name, c.sync_mode AS mode,
                  c.credentials_hint AS "credentialsHint",
                  c.external_property_id AS "externalPropertyId",
                  c.availability_sent_until AS "availabilitySentUntil",
                  c.full_sync_requested_at AS "fullSyncRequestedAt",
                  c.last_sync_at AS "lastSyncAt", c.last_error_key AS "lastErrorKey",
                  c.created_at AS "createdAt",
                  COALESCE((SELECT json_agg(json_build_object(
                              'categoryId', m.category_id, 'categoryCode', rc.code,
                              'externalRoomType', m.external_room_type) ORDER BY rc.code)
                              FROM channel_room_map m
                              JOIN resource_category rc ON rc.id = m.category_id
                             WHERE m.connection_id = c.id), '[]') AS "roomMap",
                  COALESCE((SELECT json_agg(json_build_object(
                              'ratePlanId', m.rate_plan_id, 'ratePlanCode', rp.code,
                              'externalRatePlan', m.external_rate_plan) ORDER BY rp.code)
                              FROM channel_rate_map m
                              JOIN rate_plan rp ON rp.id = m.rate_plan_id
                             WHERE m.connection_id = c.id), '[]') AS "rateMap"
             FROM channel_connection c
            WHERE c.property_id = $1 AND c.kind = 'adapter' AND c.status = 'active'
            ORDER BY c.created_at`, [propertyId])
        return { adapters: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/properties/:propertyId/channel-adapters/:connectionRef',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Kanaladapter aendern: Modus, Name, Zugangsdaten',
    handler: async (req) => {
      const { propertyId: p, connectionRef } = req.params as
        { propertyId: string; connectionRef: string }
      const propertyId = Number(p)
      const body = (req.body ?? {}) as Record<string, unknown>
      const m = body.mode === undefined ? null : modus(body.mode)
      const name = body.name === undefined ? null : text(body.name, 'name', 100)
      const externalPropertyId = body.externalPropertyId === undefined ? null
        : text(body.externalPropertyId, 'externalPropertyId', 100)
      const credentials = body.credentials === undefined ? null
        : text(body.credentials, 'credentials', MAX_CREDENTIALS)
      // Andere Zugangsdaten oder ein anderes Haus beim Anbieter lenken den
      // Abgleich um; Modus und Name nicht.
      if (credentials !== null || externalPropertyId !== null) await verlangeBestaetigung(req)

      return tx(req.pool, req, async client => {
        const a = await adapterLesen(client, propertyId, connectionRef, true)
        if (credentials !== null || externalPropertyId !== null) {
          await meldeImHaus(client, req, propertyId, {
            kind: 'channel_connection_created',
            detail: { connectionRef, changed: true, externalPropertyId },
            hint: a.provider })
        }
        if (m !== null) await adminpanelSperre(client, propertyId, a.provider, m)
        // Wer umschaltet oder ein anderes Haus beim Anbieter angibt, will den
        // ganzen Bestand drueben sehen, nicht nur, was sich ab jetzt aendert.
        const neuSenden = m === 'active' || externalPropertyId !== null || credentials !== null
        const r = await client.query<{ mode: Modus }>(
          `UPDATE channel_connection
              SET sync_mode = COALESCE($2, sync_mode), name = COALESCE($3, name),
                  external_property_id = COALESCE($4, external_property_id),
                  credentials_enc = COALESCE($5, credentials_enc),
                  credentials_hint = COALESCE($6, credentials_hint),
                  full_sync_requested_at = CASE WHEN $7 THEN now()
                                                ELSE full_sync_requested_at END,
                  last_error_key = CASE WHEN $5::bytea IS NULL THEN last_error_key END
            WHERE id = $1 RETURNING sync_mode AS mode`,
          [a.id, m, name, externalPropertyId,
           credentials === null ? null
             : encryptSecret(credentials, config.idDocumentKey, CHANNEL_CREDENTIALS_PURPOSE),
           credentials === null ? null : hinweis(credentials), neuSenden])
        return { connectionRef, mode: r.rows[0]!.mode }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/channel-adapters/:connectionRef/disable',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Kanaladapter stilllegen',
    handler: async (req) => {
      const { propertyId, connectionRef } = req.params as
        { propertyId: string; connectionRef: string }
      return tx(req.pool, req, async client => {
        const a = await adapterLesen(client, Number(propertyId), connectionRef, true)
        await client.query(`UPDATE channel_connection SET status = 'disabled' WHERE id = $1`,
          [a.id])
        return { ok: true }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/channel-adapters/:connectionRef/full-sync',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Verfuegbarkeit eines Jahres neu senden',
    handler: async (req) => {
      const { propertyId, connectionRef } = req.params as
        { propertyId: string; connectionRef: string }
      return tx(req.pool, req, async client => {
        const a = await adapterLesen(client, Number(propertyId), connectionRef)
        await client.query(
          `UPDATE channel_connection SET full_sync_requested_at = now() WHERE id = $1`, [a.id])
        return { ok: true }
      })
    }
  })

  /*
   * Die Zuordnung wird als Ganzes gesetzt, nicht Zeile fuer Zeile: die
   * Maske zeigt alle Gruppen mit ihrem Zimmertyp, und gespeichert wird, was
   * dort steht. Danach geht der ganze Bestand neu hinaus, denn eine neu
   * zugeordnete Gruppe hat seit Langem nichts geaendert und fiele sonst
   * durch die Grenze des Abgleichs.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/channel-adapters/:connectionRef/room-map',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Zimmergruppen den Zimmertypen beim Anbieter zuordnen',
    handler: async (req) => {
      const { propertyId: p, connectionRef } = req.params as
        { propertyId: string; connectionRef: string }
      const propertyId = Number(p)
      const eintraege = zuordnungLesen(req.body, 'categoryId', 'externalRoomType')
      return tx(req.pool, req, async client => {
        const a = await adapterLesen(client, propertyId, connectionRef, true)
        // Nur Gruppen dieses Hauses: die Zeilenrichtlinie trennt Mandanten,
        // nicht Haeuser eines Accounts (CLAUDE.md).
        const ids = eintraege.map(e => e.id)
        const da = await client.query<{ id: number }>(
          `SELECT id FROM resource_category WHERE property_id = $1 AND id = ANY($2::bigint[])`,
          [propertyId, ids])
        const gefunden = new Set(da.rows.map(r => Number(r.id)))
        const i = ids.findIndex(id => !gefunden.has(id))
        if (i >= 0) throw Errors.validation({ [`entries.${i}.categoryId`]: ['field.unknownCategory'] })
        await client.query(`DELETE FROM channel_room_map WHERE connection_id = $1`, [a.id])
        await client.query(
          `INSERT INTO channel_room_map (property_id, connection_id, category_id, external_room_type)
           SELECT $1, $2, x.id, x.ext FROM unnest($3::bigint[], $4::text[]) AS x(id, ext)`,
          [propertyId, a.id, ids, eintraege.map(e => e.extern)])
        await client.query(
          `UPDATE channel_connection SET full_sync_requested_at = now() WHERE id = $1`, [a.id])
        return { entries: eintraege.length }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/channel-adapters/:connectionRef/rate-map',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Ratenplaene den Raten beim Anbieter zuordnen',
    handler: async (req) => {
      const { propertyId: p, connectionRef } = req.params as
        { propertyId: string; connectionRef: string }
      const propertyId = Number(p)
      const eintraege = zuordnungLesen(req.body, 'ratePlanId', 'externalRatePlan')
      return tx(req.pool, req, async client => {
        const a = await adapterLesen(client, propertyId, connectionRef, true)
        const ids = eintraege.map(e => e.id)
        const da = await client.query<{ id: number }>(
          `SELECT id FROM rate_plan WHERE property_id = $1 AND id = ANY($2::bigint[])`,
          [propertyId, ids])
        const gefunden = new Set(da.rows.map(r => Number(r.id)))
        const i = ids.findIndex(id => !gefunden.has(id))
        if (i >= 0) throw Errors.validation({ [`entries.${i}.ratePlanId`]: ['field.unknownRatePlan'] })
        await client.query(`DELETE FROM channel_rate_map WHERE connection_id = $1`, [a.id])
        await client.query(
          `INSERT INTO channel_rate_map (property_id, connection_id, rate_plan_id, external_rate_plan)
           SELECT $1, $2, x.id, x.ext FROM unnest($3::bigint[], $4::text[]) AS x(id, ext)`,
          [propertyId, a.id, ids, eintraege.map(e => e.extern)])
        return { entries: eintraege.length }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/channel-adapters/:connectionRef/log',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Kanalprotokoll: was gesendet und abgeholt wurde',
    handler: async (req) => {
      const { propertyId, connectionRef } = req.params as
        { propertyId: string; connectionRef: string }
      const q = req.query as { limit?: string }
      const limit = q.limit === undefined ? 50 : Number(q.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw Errors.validation({ limit: ['field.maxValue'] }, { max: 200 })
      }
      return tx(req.pool, req, async client => {
        const a = await adapterLesen(client, Number(propertyId), connectionRef)
        const { rows } = await client.query(
          `SELECT kind, mode, status, items, differences, error_key AS "errorKey",
                  started_at AS "startedAt", finished_at AS "finishedAt"
             FROM channel_sync_log WHERE connection_id = $1
            ORDER BY finished_at DESC, id DESC LIMIT $2`, [a.id, limit])
        return { entries: rows }
      })
    }
  })
}

/** `{ entries: [{ <idFeld>: 12, <externFeld>: 'DZ' }] }`, ohne Doppelte auf beiden Seiten. */
function zuordnungLesen(
  roh: unknown, idFeld: string, externFeld: string
): Array<{ id: number; extern: string }> {
  const entries = (roh as { entries?: unknown } | null)?.entries
  if (!Array.isArray(entries)) throw Errors.validation({ entries: ['field.required'] })
  if (entries.length > MAX_MAP) {
    throw Errors.validation({ entries: ['field.maxValue'] }, { max: MAX_MAP })
  }
  const ids = new Set<number>()
  const externe = new Set<string>()
  return entries.map((e: Record<string, unknown>, i) => {
    const id = e?.[idFeld]
    if (!Number.isSafeInteger(id) || (id as number) <= 0) {
      throw Errors.validation({ [`entries.${i}.${idFeld}`]: ['field.invalid'] })
    }
    const extern = text(e[externFeld], `entries.${i}.${externFeld}`, 100)
    if (ids.has(id as number)) throw Errors.validation({ [`entries.${i}.${idFeld}`]: ['field.invalid'] })
    if (externe.has(extern)) {
      throw Errors.validation({ [`entries.${i}.${externFeld}`]: ['field.invalid'] })
    }
    ids.add(id as number)
    externe.add(extern)
    return { id: id as number, extern }
  })
}
