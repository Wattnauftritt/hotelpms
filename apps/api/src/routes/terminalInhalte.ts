import type { FastifyInstance } from 'fastify'
import { checkWebhookTargetUrl } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { bildAusRumpf, bildLesen, bildSenden } from '../platform/terminalBild.js'

/**
 * Was das Gaesteterminal zeigen darf, gepflegt vom Haus (Dokument 31, §11,
 * Migration 0062): Seiten, ihre Bilder, die Diashow des Ruhezustands und
 * die Freigabeliste externer Adressen.
 *
 * Alles unter `settings:property`: das Haus entscheidet vorher, was auf
 * einem Gastbildschirm erscheinen kann. Die Rezeption waehlt danach nur
 * noch aus (`POST /v1/terminal-jobs`).
 */

const TITEL_MAX = 120
const TEXT_MAX = 5000
const LABEL_MAX = 80
const URL_MAX = 2000
const DIASHOW_MAX = 20
const SEKUNDEN_MIN = 3
const SEKUNDEN_MAX = 600
/** Base64 eines Megabytes, dazu der Rahmen des JSON. */
const BILD_RUMPF_MAX = 1_500_000

function text(v: unknown, feld: string, max: number, pflicht: boolean): string | undefined {
  if (v === undefined && !pflicht) return undefined
  if (typeof v !== 'string' || (pflicht && v.trim() === '')) {
    throw Errors.validation({ [feld]: ['field.required'] })
  }
  if (v.trim().length > max) throw Errors.validation({ [feld]: ['field.maxLength'] }, { max })
  return v.trim()
}

export function terminalInhaltRoutes(app: FastifyInstance): void {
  /** Seiten und Adressen in einem Aufruf, fuer den Reiter in den Einstellungen. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/terminal-content',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Seiten, Diashow und freigegebene Adressen',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const seiten = await client.query(
          `SELECT c.public_ref AS "contentRef", c.title, c.body,
                  i.public_ref AS "imageRef",
                  c.idle_position AS "idlePosition", c.idle_seconds AS "idleSeconds"
             FROM terminal_content c
             LEFT JOIN terminal_content_image i ON i.content_id = c.id
            WHERE c.property_id = $1 AND c.archived_at IS NULL
            ORDER BY c.title, c.id`, [haus])
        const adressen = await client.query(
          `SELECT public_ref AS "urlRef", label, url FROM terminal_url
            WHERE property_id = $1 AND removed_at IS NULL
            ORDER BY label, id`, [haus])
        return { contents: seiten.rows, urls: adressen.rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terminal-content',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Seite anlegen',
    handler: async (req, reply) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { title?: unknown; body?: unknown }
      const titel = text(b.title, 'title', TITEL_MAX, true)!
      const inhalt = text(b.body, 'body', TEXT_MAX, false) ?? ''
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await client.query<{ public_ref: string }>(
          `INSERT INTO terminal_content (property_id, title, body, created_by)
           VALUES ($1,$2,$3,$4) RETURNING public_ref`,
          [haus, titel, inhalt, principal.userId])
        reply.status(201)
        return { contentRef: r.rows[0]!.public_ref, title: titel }
      })
    }
  })

  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/properties/:propertyId/terminal-content/:contentRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Seite aendern',
    handler: async (req) => {
      const { propertyId, contentRef } = req.params as { propertyId: string; contentRef: string }
      const b = (req.body ?? {}) as { title?: unknown; body?: unknown }
      const titel = text(b.title, 'title', TITEL_MAX, false)
      const inhalt = text(b.body, 'body', TEXT_MAX, false)
      if (titel === '') throw Errors.validation({ title: ['field.required'] })
      return tx(req.pool, req, async client => {
        const r = await client.query(
          `UPDATE terminal_content
              SET title = COALESCE($3, title), body = COALESCE($4, body), updated_at = now()
            WHERE public_ref = $1 AND property_id = $2 AND archived_at IS NULL`,
          [contentRef, Number(propertyId), titel ?? null, inhalt ?? null])
        if (r.rowCount === 0) throw Errors.notFound('res.terminalContent')
        return { contentRef }
      })
    }
  })

  /**
   * Archivieren, nicht loeschen: ein Auftrag verweist auf die Seite, und das
   * Protokoll soll sagen koennen, was gezeigt wurde. Aus der Diashow faellt
   * sie dabei.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/terminal-content/:contentRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Seite archivieren',
    handler: async (req) => {
      const { propertyId, contentRef } = req.params as { propertyId: string; contentRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query(
          `UPDATE terminal_content
              SET archived_at = now(), idle_position = NULL, idle_seconds = NULL,
                  updated_at = now()
            WHERE public_ref = $1 AND property_id = $2 AND archived_at IS NULL`,
          [contentRef, Number(propertyId)])
        if (r.rowCount === 0) throw Errors.notFound('res.terminalContent')
        return { contentRef, archived: true }
      })
    }
  })

  /**
   * Das Bild einer Seite setzen oder ersetzen. PNG, JPEG oder WebP, an den
   * Bytes erkannt; kein SVG (`platform/terminalBild.ts`).
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/terminal-content/:contentRef/image',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    bodyLimit: BILD_RUMPF_MAX,
    summary: 'Gaesteterminal: Bild einer Seite setzen',
    handler: async (req) => {
      const { propertyId, contentRef } = req.params as { propertyId: string; contentRef: string }
      const bild = bildAusRumpf(req.body)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const c = await client.query<{ id: string }>(
          `SELECT id FROM terminal_content
            WHERE public_ref = $1 AND property_id = $2 AND archived_at IS NULL`,
          [contentRef, Number(propertyId)])
        if (c.rowCount === 0) throw Errors.notFound('res.terminalContent')
        // Ersetzen heisst: das alte faellt, ein neues mit neuer Kennung
        // entsteht -- ein Terminal, das das alte noch zwischengespeichert
        // hat, fragt damit nach einer Kennung, die es nicht mehr gibt.
        await client.query(`DELETE FROM terminal_content_image WHERE content_id = $1`,
          [c.rows[0]!.id])
        const r = await client.query<{ public_ref: string }>(
          `INSERT INTO terminal_content_image (property_id, content_id, mime, bytes, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING public_ref`,
          [Number(propertyId), c.rows[0]!.id, bild.art, bild.bytes, principal.userId])
        await client.query(`UPDATE terminal_content SET updated_at = now() WHERE id = $1`,
          [c.rows[0]!.id])
        return { contentRef, imageRef: r.rows[0]!.public_ref, mime: bild.art }
      })
    }
  })

  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/terminal-content/:contentRef/image',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Bild einer Seite entfernen',
    handler: async (req) => {
      const { propertyId, contentRef } = req.params as { propertyId: string; contentRef: string }
      return tx(req.pool, req, async client => {
        await client.query(
          `DELETE FROM terminal_content_image i USING terminal_content c
            WHERE i.content_id = c.id AND c.public_ref = $1 AND c.property_id = $2`,
          [contentRef, Number(propertyId)])
        return { contentRef, imageRef: null }
      })
    }
  })

  /** Die Vorschau in den Einstellungen. Dasselbe Bild, dieselben Kopfzeilen. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/terminal-images/:imageRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Bild einer Seite (Vorschau)',
    handler: async (req, reply) => {
      const { propertyId, imageRef } = req.params as { propertyId: string; imageRef: string }
      const bild = await tx(req.pool, req, client =>
        bildLesen(client, imageRef, Number(propertyId)))
      return bildSenden(reply, bild)
    }
  })

  /**
   * Die Diashow des Ruhezustands, als ganze Folge gesetzt: Seiten in dieser
   * Reihenfolge, jede mit ihrer Dauer. Eine leere Folge heisst: Begruessung
   * statt Diashow. Zwei Anweisungen, nicht eine je Seite.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/terminal-slideshow',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Diashow des Ruhezustands festlegen',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const folie = (req.body as { slides?: unknown } | undefined)?.slides
      if (!Array.isArray(folie)) throw Errors.validation({ slides: ['field.required'] })
      if (folie.length > DIASHOW_MAX) {
        throw Errors.validation({ slides: ['field.maxValue'] }, { max: DIASHOW_MAX })
      }
      const refs: string[] = []
      const sekunden: number[] = []
      for (const f of folie as Array<{ contentRef?: unknown; seconds?: unknown }>) {
        if (typeof f?.contentRef !== 'string') {
          throw Errors.validation({ slides: ['field.required'] })
        }
        const s = Number(f.seconds)
        if (!Number.isInteger(s) || s < SEKUNDEN_MIN || s > SEKUNDEN_MAX) {
          throw Errors.validation({ seconds: ['field.maxValue'] }, { max: SEKUNDEN_MAX })
        }
        if (refs.includes(f.contentRef)) throw Errors.validation({ slides: ['field.invalid'] })
        refs.push(f.contentRef)
        sekunden.push(s)
      }
      return tx(req.pool, req, async client => {
        await client.query(
          `UPDATE terminal_content SET idle_position = NULL, idle_seconds = NULL
            WHERE property_id = $1 AND idle_position IS NOT NULL`, [haus])
        if (refs.length > 0) {
          const r = await client.query(
            `UPDATE terminal_content c
                SET idle_position = f.pos, idle_seconds = f.sek, updated_at = now()
               FROM unnest($2::text[], $3::int[]) WITH ORDINALITY AS f(ref, sek, pos)
              WHERE c.public_ref = f.ref AND c.property_id = $1 AND c.archived_at IS NULL`,
            [haus, refs, sekunden])
          // Eine Seite eines anderen Hauses oder eine archivierte faellt hier
          // auf, nicht erst am Terminal.
          if (r.rowCount !== refs.length) throw Errors.notFound('res.terminalContent')
        }
        return { slides: refs.length }
      })
    }
  })

  /**
   * Eine externe Seite freigeben.
   *
   * Nur `https`, keine Zugangsdaten im Adressteil, keine innere Adresse --
   * dieselbe Pruefung wie fuer das Ziel eines Webhooks
   * (`checkWebhookTargetUrl`), ohne freigegebene Netze. Eine Adresse im
   * Hotelnetz auf einem Gastbildschirm waere die Verwaltungsseite des
   * Routers.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terminal-urls',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: externe Seite freigeben',
    handler: async (req, reply) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { label?: unknown; url?: unknown }
      const label = text(b.label, 'label', LABEL_MAX, true)!
      const roh = text(b.url, 'url', URL_MAX, true)!
      const p = checkWebhookTargetUrl(roh)
      if ('problem' in p || p.target.url.protocol !== 'https:') {
        throw Errors.validation({ url: ['terminal.urlInvalid'] })
      }
      const url = p.target.url.toString()
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await client.query<{ public_ref: string }>(
          `INSERT INTO terminal_url (property_id, label, url, created_by)
           VALUES ($1,$2,$3,$4) RETURNING public_ref`, [haus, label, url, principal.userId])
        reply.status(201)
        return { urlRef: r.rows[0]!.public_ref, label, url }
      })
    }
  })

  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/terminal-urls/:urlRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Freigabe einer externen Seite zurueckziehen',
    handler: async (req) => {
      const { propertyId, urlRef } = req.params as { propertyId: string; urlRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query(
          `UPDATE terminal_url SET removed_at = now()
            WHERE public_ref = $1 AND property_id = $2 AND removed_at IS NULL`,
          [urlRef, Number(propertyId)])
        if (r.rowCount === 0) throw Errors.notFound('res.terminalUrl')
        return { urlRef, removed: true }
      })
    }
  })
}
