import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { createCheckinToken } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { geraetVon } from '../platform/terminal.js'
import { verzichtStand } from '../platform/reinigungsverzicht.js'
import { beendeSelbstbedienung, GAST_IM_ZIMMER_SQL, GESCHAEFTSTAG_SQL, HAEUSER_SQL }
  from '../platform/terminalSelbst.js'

/**
 * Selbstbedienung am Gaesteterminal (Dokument 31, Abschnitt 14; Migration
 * 0150).
 *
 * Ohne Auftrag der Rezeption tippt ein Gast am Touchscreen sein Zimmer an,
 * bestaetigt "Sind Sie Herr/Frau <Nachname>?" und verzichtet danach auf
 * die Reinigung einzelner Tage. Die Rueckfrage schuetzt vor einem
 * vertippten Zimmer, nicht vor Absicht: das Geraet steht im Haus (Sven,
 * 12.10.2026).
 *
 * **Drei Routen, kein zweiter Verzicht.** Nach "Ja" bekommt das Terminal
 * einen Check-in-Link (Kanal `terminal`) und ruft damit
 * `POST /v1/checkin/cleaning-waiver` -- denselben Endpunkt wie der Gast auf
 * seinem Telefon, mit derselben Sperre und demselben Push an die Kraft.
 *
 * **Was der Bildschirm preisgibt.** Vor "Ja" die Nummern belegter Zimmer
 * und den Nachnamen des Hauptgastes; keinen Vornamen, keine Daten, keine
 * Mitreisenden. Nach "Ja" die Bleibetage.
 */

/** Wie lange eine Sitzung ohne Bestaetigung gilt. */
const SITZUNG_MINUTEN = 3
/** Nach der Bestaetigung: das Terminal raeumt nach einer Minute Stille selbst ab. */
const BESTAETIGT_MINUTEN = 10
/** Hoechstens so viele Sitzungen ohne "Ja" ... */
const OHNE_JA_HOECHSTENS = 4
/** ... in diesem Fenster; danach eine Pause, bis die aelteste herausfaellt. */
const OHNE_JA_FENSTER_SEKUNDEN = 60

interface Sitzung {
  id: number; property_id: number; resource_id: number; reservation_id: number
  confirmed_at: string | null; offen: boolean
}

/**
 * Die Aufenthalte in einem Zimmer, in fester Reihenfolge. Es sollte einer
 * sein; bei einer Ueberbuchung fragt das Terminal nach dem naechsten,
 * wenn der Gast beim ersten "Nein" sagt.
 */
async function aufenthalte(
  client: PoolClient, propertyIds: number[], resourceId: number
): Promise<Array<{ id: number; property_id: number; last_name: string }>> {
  const { rows } = await client.query<{ id: string; property_id: string; last_name: string }>(
    `WITH tag AS (${HAEUSER_SQL})
     SELECT v.id, v.property_id, g.last_name
       FROM tag
       JOIN reservation v ON v.property_id = tag.id
       JOIN guest g ON g.id = v.primary_guest_id
      WHERE v.resource_id = $2 AND ${GAST_IM_ZIMMER_SQL}
      ORDER BY v.arrival DESC, v.id`, [propertyIds, resourceId])
  return rows.map(r => ({ id: Number(r.id), property_id: Number(r.property_id),
                          last_name: r.last_name }))
}

async function eigeneSitzung(
  client: PoolClient, deviceId: number, ref: string
): Promise<Sitzung> {
  const { rows } = await client.query<Sitzung>(
    `SELECT id, property_id, resource_id, reservation_id, confirmed_at,
            (ended_at IS NULL AND expires_at > now()) AS offen
       FROM terminal_self_session
      WHERE public_ref = $1 AND device_id = $2
      FOR UPDATE`, [ref, deviceId])
  const s = rows[0]
  // Eine fremde Sitzung sieht aus wie keine.
  if (s === undefined) throw Errors.notFound('res.terminalSelfSession')
  if (!s.offen) throw Errors.conflict('terminalSelf.sessionClosed')
  return { ...s, id: Number(s.id), property_id: Number(s.property_id),
           resource_id: Number(s.resource_id), reservation_id: Number(s.reservation_id) }
}

/** Das Ende einer Sitzung, wie das Terminal es meldet. */
const ENDE_GRUENDE = new Set(['done', 'canceled', 'timeout'])

export function terminalSelbstRoutes(app: FastifyInstance): void {
  // ------------------------------------------------ Einstellung des Hauses

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/terminal-self-service',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Einstellung zur Selbstbedienung',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ enabled: boolean; waiver: boolean }>(
          `SELECT coalesce((SELECT enabled FROM property_terminal_self_setting
                             WHERE property_id = $1), false) AS enabled,
                  coalesce((SELECT enabled FROM property_cleaning_waiver_setting
                             WHERE property_id = $1), false) AS waiver`, [propertyId])
        return { enabled: rows[0]!.enabled, cleaningWaiverEnabled: rows[0]!.waiver }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/terminal-self-service',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Selbstbedienung ein- oder ausschalten',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { enabled?: unknown }
      if (typeof b.enabled !== 'boolean') throw Errors.validation({ enabled: ['field.invalid'] })
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO property_terminal_self_setting (property_id, enabled, updated_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (property_id) DO UPDATE SET
             enabled = $2, updated_by = $3, updated_at = now()`,
          [propertyId, b.enabled, principal.userId])
        const w = await client.query<{ enabled: boolean }>(
          `SELECT enabled FROM property_cleaning_waiver_setting WHERE property_id = $1`,
          [propertyId])
        return { enabled: b.enabled, cleaningWaiverEnabled: w.rows[0]?.enabled ?? false }
      })
    }
  })

  // ------------------------------------------------------------- Terminal

  /**
   * Die belegten Zimmer aller Haeuser des Geraets, die die Selbstbedienung
   * anbieten -- Hotel und Gaestehaus an einem Touchscreen (0103). Nur
   * Nummern. Eine Anweisung; geholt wird beim Tipp auf "Service", nicht
   * mit der Frage alle zwei Sekunden.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/terminal/self/rooms',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: belegte Zimmer fuer die Selbstbedienung',
    handler: async (req, reply) => {
      const { propertyId, propertyIds } = geraetVon(req)
      void reply.header('cache-control', 'no-store')
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{
          property_id: string; property: string; resource_id: string
          code: string; floor: string | null }>(
          `WITH tag AS (${HAEUSER_SQL})
           SELECT tag.id AS property_id, tag.name AS property,
                  r.id AS resource_id, r.code, r.floor
             FROM tag
             JOIN resource r ON r.property_id = tag.id AND r.active
            WHERE EXISTS (SELECT 1 FROM reservation v
                           WHERE v.resource_id = r.id AND ${GAST_IM_ZIMMER_SQL})
            ORDER BY tag.id <> $2, tag.name, tag.id,
                     NULLIF(regexp_replace(r.code, '\\D', '', 'g'), '')::numeric NULLS LAST,
                     r.code`, [propertyIds, propertyId])
        const haeuser: Array<{ property: string
                               rooms: Array<{ resourceId: number; code: string
                                              floor: string | null }> }> = []
        let zuletzt: string | null = null
        for (const z of rows) {
          if (z.property_id !== zuletzt) {
            haeuser.push({ property: z.property, rooms: [] })
            zuletzt = z.property_id
          }
          haeuser[haeuser.length - 1]!.rooms.push(
            { resourceId: Number(z.resource_id), code: z.code, floor: z.floor })
        }
        return { properties: haeuser }
      })
    }
  })

  /**
   * Ein Zimmer antippen: die Sitzung entsteht, die Antwort traegt den
   * Nachnamen fuer die Rueckfrage. Eine noch offene Sitzung desselben
   * Geraets endet dabei -- es steht nur ein Gast am Touchscreen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/self/sessions',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Selbstbedienung fuer ein Zimmer beginnen',
    handler: async (req, reply) => {
      const { deviceId, propertyIds } = geraetVon(req)
      const raum = (req.body as { resourceId?: unknown } | undefined)?.resourceId
      if (typeof raum !== 'number' || !Number.isSafeInteger(raum) || raum <= 0) {
        throw Errors.validation({ resourceId: ['field.invalid'] })
      }
      void reply.header('cache-control', 'no-store')
      return tx(req.pool, req, async client => {
        /*
         * Wer Zimmer um Zimmer antippt, liest Namen, auch ohne je "Nein" zu
         * sagen. Deshalb zaehlen alle Sitzungen der letzten Minute ohne
         * "Ja": ab der vierten eine kurze Pause. Ein Gast, der sich einmal
         * vertippt, merkt davon nichts; vierzig Zimmer durchzulesen dauert
         * zehn Minuten vor dem Tresen. Gezaehlt am Geraet in der Datenbank:
         * die allgemeine Ratenbegrenzung erreicht ein gekoppeltes Terminal
         * nicht (Dokument 31, Abschnitt 2).
         */
        const pause = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM terminal_self_session
            WHERE device_id = $1 AND confirmed_at IS NULL
              AND created_at > now() - make_interval(secs => $2)`,
          [deviceId, OHNE_JA_FENSTER_SEKUNDEN])
        if (pause.rows[0]!.n >= OHNE_JA_HOECHSTENS) throw Errors.conflict('terminalSelf.pause')
        await beendeSelbstbedienung(client, deviceId, 'replaced')

        const gaeste = await aufenthalte(client, propertyIds, raum)
        const erster = gaeste[0]
        // Ein leeres oder fremdes Zimmer sieht aus wie keines.
        if (erster === undefined) throw Errors.notFound('res.resource')
        const s = await client.query<{ public_ref: string }>(
          `INSERT INTO terminal_self_session
             (property_id, device_id, resource_id, reservation_id, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
           RETURNING public_ref`,
          [erster.property_id, deviceId, raum, erster.id, SITZUNG_MINUTEN])
        return { sessionRef: s.rows[0]!.public_ref, lastName: erster.last_name }
      })
    }
  })

  /**
   * "Ja" oder "Nein". Auf "Ja" der Link und der Stand des Verzichts, in
   * einer Antwort. Auf "Nein" der naechste Aufenthalt im Zimmer, wenn es
   * einen gibt, sonst endet die Sitzung.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/self/sessions/:sessionRef/confirm',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Rueckfrage zum Zimmer beantworten',
    handler: async (req, reply) => {
      const { deviceId, propertyIds } = geraetVon(req)
      const { sessionRef } = req.params as { sessionRef: string }
      const ja = (req.body as { yes?: unknown } | undefined)?.yes
      if (typeof ja !== 'boolean') throw Errors.validation({ yes: ['field.invalid'] })
      // Die Antwort traegt den Link. Sie bleibt in keinem Zwischenspeicher.
      void reply.header('cache-control', 'no-store')
      return tx(req.pool, req, async client => {
        const s = await eigeneSitzung(client, deviceId, sessionRef)
        if (s.confirmed_at !== null) throw Errors.conflict('terminalSelf.sessionClosed')

        if (!ja) {
          const gaeste = await aufenthalte(client, propertyIds, s.resource_id)
          const i = gaeste.findIndex(g => g.id === s.reservation_id)
          const naechster = i < 0 ? undefined : gaeste[i + 1]
          if (naechster === undefined) {
            await beendeSelbstbedienung(client, deviceId, 'declined', s.id)
            return { confirmed: false, lastName: null }
          }
          await client.query(
            `UPDATE terminal_self_session SET reservation_id = $2, property_id = $3
              WHERE id = $1`, [s.id, naechster.id, naechster.property_id])
          return { confirmed: false, lastName: naechster.last_name }
        }

        // Noch derselbe Gast im Zimmer? Zwischen Antippen und "Ja" kann die
        // Rezeption umgesetzt oder storniert haben.
        const gaeste = await aufenthalte(client, propertyIds, s.resource_id)
        if (!gaeste.some(g => g.id === s.reservation_id)) {
          await beendeSelbstbedienung(client, deviceId, 'canceled', s.id)
          throw Errors.conflict('terminalSelf.sessionClosed')
        }
        const tag = await client.query<{ d: string }>(
          `SELECT ${GESCHAEFTSTAG_SQL}::text AS d FROM property p WHERE p.id = $1`,
          [s.property_id])
        const geschaeftstag = tag.rows[0]!.d
        const t = await createCheckinToken(client, {
          reservationId: s.reservation_id, channel: 'terminal', expiresOn: geschaeftstag })
        if (t === null) throw Errors.conflict('terminalSelf.sessionClosed')
        await client.query(
          `UPDATE terminal_self_session
              SET confirmed_at = now(), checkin_token_id = $2,
                  expires_at = now() + make_interval(mins => $3)
            WHERE id = $1`, [s.id, t.tokenId, BESTAETIGT_MINUTEN])
        return {
          confirmed: true,
          token: t.token,
          cleaningWaiver: await verzichtStand(client, s.reservation_id, s.property_id,
                                              geschaeftstag, true)
        }
      })
    }
  })

  /** Fertig, abgebrochen oder Stille: die Sitzung endet, der Link faellt. */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/self/sessions/:sessionRef/end',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Selbstbedienung beenden',
    handler: async (req) => {
      const { deviceId } = geraetVon(req)
      const { sessionRef } = req.params as { sessionRef: string }
      const grund = (req.body as { reason?: unknown } | undefined)?.reason
      const ende = typeof grund === 'string' && ENDE_GRUENDE.has(grund)
        ? grund as 'done' | 'canceled' | 'timeout' : 'canceled'
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM terminal_self_session WHERE public_ref = $1 AND device_id = $2`,
          [sessionRef, deviceId])
        // Schon zu oder fremd: nichts zu tun. Das Terminal raeumt ohnehin ab.
        if (rows[0] !== undefined) {
          await beendeSelbstbedienung(client, deviceId, ende, Number(rows[0].id))
        }
        return { ended: true }
      })
    }
  })
}
