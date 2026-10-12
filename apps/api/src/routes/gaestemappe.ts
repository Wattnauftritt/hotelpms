import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { folderLink, type GuestFolderView, type GuestFolderSettings,
         type GuestFolderCards } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import type { Principal } from '../platform/context.js'
import { mappeTx, wlan, wlanAusRumpf } from '../platform/gaestemappe.js'
import { bildSenden } from '../platform/terminalBild.js'

/**
 * Digitale Gaestemappe, Bausteine 1 und 2 (Migration 0143).
 *
 * **Die Seite des Gastes** (`/v1/mappe*`, oeffentlich). Der Ausweis ist die
 * Referenz des Zimmers in der Kopfzeile `x-staygrid-folder-room`. Sie zeigt
 * nur, was ohnehin auf der Karte im Zimmer steht oder dort ausliegen
 * koennte -- Hausinfos und WLAN, keinen Gast. Was einen Aufenthalt
 * betrifft, kommt mit der Freischaltung (Nachname oder PLZ).
 *
 * **Die Einstellungen** (`/v1/properties/:propertyId/guest-folder*`) unter
 * `settings:property` wie die Seiten des Gaesteterminals: das Haus
 * entscheidet vorher, was auf dem Telefon eines Gastes erscheinen kann.
 */

const config = loadConfig()
const SEITEN_MAX = 30

/** Wie beim Online-Check-in: nichts davon gehoert in einen Zwischenspeicher. */
function nichtSpeichern(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store')
}

/**
 * Jedes aktive Zimmer des Hauses bekommt seine Referenz, beim ersten Bedarf.
 * Eine Anweisung fuer alle, nicht eine je Zimmer; ein spaeter angelegtes
 * Zimmer bekommt seine beim naechsten Aufruf der Karten.
 */
async function referenzenAnlegen(client: PoolClient, propertyId: number): Promise<void> {
  await client.query(
    `INSERT INTO guest_folder_room (resource_id, property_id)
     SELECT id, property_id FROM resource WHERE property_id = $1 AND active
     ON CONFLICT (resource_id) DO NOTHING`, [propertyId])
}

interface EinstellungZeile {
  enabled: boolean; wifi_ssid: string | null; wifi_password: string | null
  wifi_security: 'WPA' | 'WEP' | 'nopass'; wifi_hidden: boolean
}

async function einstellung(
  client: PoolClient, propertyId: number
): Promise<EinstellungZeile | undefined> {
  const { rows } = await client.query<EinstellungZeile>(
    `SELECT enabled, wifi_ssid, wifi_password, wifi_security, wifi_hidden
       FROM guest_folder_setting WHERE property_id = $1`, [propertyId])
  return rows[0]
}

async function einstellungAnsicht(
  client: PoolClient, propertyId: number
): Promise<GuestFolderSettings> {
  const e = await einstellung(client, propertyId)
  const seiten = await client.query<GuestFolderSettings['pages'][number]>(
    `SELECT public_ref AS "contentRef", title, folder_position AS "folderPosition"
       FROM terminal_content
      WHERE property_id = $1 AND archived_at IS NULL
      ORDER BY folder_position NULLS LAST, title, id`, [propertyId])
  return { enabled: e?.enabled ?? false, wifi: wlan(e), pages: seiten.rows }
}

export function gaestemappeRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------- Gastseite

  registerRoute(app, {
    method: 'GET',
    url: '/v1/mappe',
    // Oeffentlich: die Zimmer-Referenz in der Kopfzeile ist der Ausweis (0143).
    permission: null,
    summary: 'Gaestemappe: was die Seite des Gastes zeigt',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      return mappeTx(req, async (client, k): Promise<GuestFolderView> => {
        const haus = await client.query<{
          property_name: string; room_name: string
          checkin_time: string; checkout_time: string } & EinstellungZeile>(
          `SELECT p.name AS property_name, COALESCE(res.name, res.code) AS room_name,
                  to_char(p.checkin_time, 'HH24:MI') AS checkin_time,
                  to_char(p.checkout_time, 'HH24:MI') AS checkout_time,
                  s.enabled, s.wifi_ssid, s.wifi_password, s.wifi_security, s.wifi_hidden
             FROM property p
             JOIN resource res ON res.id = $2 AND res.property_id = p.id
             JOIN guest_folder_setting s ON s.property_id = p.id
            WHERE p.id = $1`, [k.propertyId, k.resourceId])
        const h = haus.rows[0]
        if (h === undefined) throw Errors.gone('folder.closed')
        const seiten = await client.query<GuestFolderView['pages'][number]>(
          `SELECT c.public_ref AS "contentRef", c.title, c.body,
                  i.public_ref AS "imageRef"
             FROM terminal_content c
             LEFT JOIN terminal_content_image i ON i.content_id = c.id
            WHERE c.property_id = $1 AND c.folder_position IS NOT NULL
              AND c.archived_at IS NULL
            ORDER BY c.folder_position, c.id`, [k.propertyId])
        return {
          propertyName: h.property_name, roomName: h.room_name,
          checkinTime: h.checkin_time, checkoutTime: h.checkout_time,
          wifi: wlan(h), pages: seiten.rows
        }
      })
    }
  })

  /**
   * Das Bild einer Seite. Nur einer Seite, die in der Mappe steht: was das
   * Haus nur fuer das Terminal angelegt hat, soll ueber die Karte im Zimmer
   * nicht zu holen sein. Die Seite des Gastes laedt es per `fetch` mit der
   * Kopfzeile, nicht als `<img src>` -- ein Bild-Element kann keine
   * Kopfzeile schicken, und die Referenz gehoert nicht in den Pfad.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/mappe/images/:imageRef',
    // Oeffentlich: die Zimmer-Referenz in der Kopfzeile ist der Ausweis (0143).
    permission: null,
    summary: 'Gaestemappe: Bild einer Seite',
    handler: async (req, reply) => {
      const { imageRef } = req.params as { imageRef: string }
      const bild = await mappeTx(req, async (client, k) => {
        const r = await client.query<{ mime: string; bytes: Buffer }>(
          `SELECT i.mime, i.bytes
             FROM terminal_content_image i
             JOIN terminal_content c ON c.id = i.content_id
            WHERE i.public_ref = $1 AND i.property_id = $2
              AND c.folder_position IS NOT NULL AND c.archived_at IS NULL`,
          [imageRef, k.propertyId])
        if (r.rowCount === 0) throw Errors.notFound('res.terminalContent')
        return r.rows[0]!
      })
      return bildSenden(reply, bild)
    }
  })

  // --------------------------------------------------------- Einstellungen

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/guest-folder',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Einstellung, WLAN und Seiten des Hauses',
    handler: async (req): Promise<GuestFolderSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, client => einstellungAnsicht(client, propertyId))
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/guest-folder',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe ein- oder ausschalten, WLAN des Hauses setzen',
    handler: async (req): Promise<GuestFolderSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { enabled?: unknown; wifi?: unknown }
      if (typeof b.enabled !== 'boolean') throw Errors.validation({ enabled: ['field.invalid'] })
      const w = wlanAusRumpf(b.wifi)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO guest_folder_setting
             (property_id, enabled, wifi_ssid, wifi_password, wifi_security, wifi_hidden, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (property_id) DO UPDATE SET
             enabled = $2, wifi_ssid = $3, wifi_password = $4, wifi_security = $5,
             wifi_hidden = $6, updated_by = $7, updated_at = now()`,
          [propertyId, b.enabled, w?.ssid ?? null, w?.password ?? null,
           w?.security ?? 'WPA', w?.hidden ?? false, principal.userId])
        if (b.enabled) await referenzenAnlegen(client, propertyId)
        return einstellungAnsicht(client, propertyId)
      })
    }
  })

  /**
   * Welche Seiten in der Mappe stehen, als ganze Folge gesetzt -- wie die
   * Diashow des Terminals. Eine leere Folge heisst: nur WLAN und Zeiten.
   * Zwei Anweisungen, nicht eine je Seite.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/guest-folder/pages',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Seiten und ihre Reihenfolge festlegen',
    handler: async (req): Promise<GuestFolderSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const refs = (req.body as { contentRefs?: unknown } | undefined)?.contentRefs
      if (!Array.isArray(refs) || refs.some(r => typeof r !== 'string')
          || new Set(refs).size !== refs.length) {
        throw Errors.validation({ contentRefs: ['field.invalid'] })
      }
      if (refs.length > SEITEN_MAX) {
        throw Errors.validation({ contentRefs: ['field.maxValue'] }, { max: SEITEN_MAX })
      }
      return tx(req.pool, req, async client => {
        // Erst setzen, dann zaehlen: eine fremde oder archivierte Seite faellt
        // aus dem UPDATE heraus, und die Zahl verraet es.
        const gesetzt = await client.query(
          `UPDATE terminal_content c SET folder_position = n.pos
             FROM unnest($2::text[]) WITH ORDINALITY AS n(ref, pos)
            WHERE c.public_ref = n.ref AND c.property_id = $1 AND c.archived_at IS NULL`,
          [propertyId, refs])
        if (gesetzt.rowCount !== refs.length) {
          throw Errors.validation({ contentRefs: ['field.invalid'] })
        }
        await client.query(
          `UPDATE terminal_content SET folder_position = NULL
            WHERE property_id = $1 AND folder_position IS NOT NULL
              AND NOT (public_ref = ANY ($2::text[]))`, [propertyId, refs])
        return einstellungAnsicht(client, propertyId)
      })
    }
  })

  /** Alles fuer die Zimmerkarten des Hauses in einem Aufruf. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/guest-folder/cards',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Zimmerkarten mit WLAN und Adresse der Mappe',
    handler: async (req): Promise<GuestFolderCards> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        /*
         * Ein GET, das schreibt -- mit Absicht. Wer Karten druckt, braucht fuer
         * jedes Zimmer eine Referenz, auch fuer eines, das nach dem
         * Einschalten angelegt wurde. Die Anweisung ist idempotent und legt
         * nur an, was fehlt; ein zweiter Knopf "Referenzen anlegen" waere
         * ein Schritt, den jemand vergisst.
         */
        await referenzenAnlegen(client, propertyId)
        const e = await einstellung(client, propertyId)
        const haus = await client.query<{ name: string }>(
          `SELECT name FROM property WHERE id = $1`, [propertyId])
        const zimmer = await client.query<{
          resourceId: number; code: string; name: string | null; ref: string }>(
          `SELECT r.id::int AS "resourceId", r.code, r.name, f.public_ref AS ref
             FROM resource r
             JOIN guest_folder_room f ON f.resource_id = r.id
            WHERE r.property_id = $1 AND r.active
            ORDER BY r.code`, [propertyId])
        return {
          propertyName: haus.rows[0]!.name,
          enabled: e?.enabled ?? false,
          wifi: wlan(e),
          rooms: zimmer.rows.map(z => ({
            resourceId: z.resourceId, code: z.code, name: z.name,
            link: folderLink(config.publicAppUrl, z.ref) }))
        }
      })
    }
  })

  /**
   * Neue Referenz fuer ein Zimmer: die alte Karte zeigt danach "unbekannt".
   * Fuer den Fall, dass eine Karte fotografiert und weitergegeben wurde.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/guest-folder/rooms/:resourceId/renew',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: neue Referenz fuer die Karte eines Zimmers',
    handler: async (req) => {
      const { propertyId, resourceId } = req.params as { propertyId: string; resourceId: string }
      const zimmer = Number(resourceId)
      if (!Number.isSafeInteger(zimmer) || zimmer <= 0) {
        throw Errors.validation({ resourceId: ['field.positiveInteger'] })
      }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        // Das Zimmer gegen das Haus pruefen: die Zeilenrichtlinie filtert nach
        // Mandant, nicht nach Haus (CLAUDE.md).
        const r = await client.query<{ ref: string }>(
          `INSERT INTO guest_folder_room (resource_id, property_id, renewed_at, renewed_by)
           SELECT id, property_id, now(), $3 FROM resource
            WHERE id = $2 AND property_id = $1 AND active
           ON CONFLICT (resource_id) DO UPDATE
             SET public_ref = generate_public_ref(12), renewed_at = now(), renewed_by = $3
           RETURNING public_ref AS ref`, [Number(propertyId), zimmer, principal.userId])
        if (r.rowCount === 0) throw Errors.notFound('res.resource')
        return { link: folderLink(config.publicAppUrl, r.rows[0]!.ref) }
      })
    }
  })
}
