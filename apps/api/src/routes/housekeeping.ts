import type { FastifyInstance, FastifyRequest } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'
import { zimmerNachNummer } from '../platform/zimmerReihenfolge.js'

const STATES = ['dirty', 'clean', 'inspected', 'occupied'] as const
type HousekeepingState = (typeof STATES)[number]

/**
 * Wie viele Zimmer eine Sperrung auf einmal treffen darf.
 *
 * Eine Etage sind zwanzig, ein Haus selten mehr als 250. Die Grenze steht
 * nicht gegen den Handwerker, sondern gegen die versehentliche Auswahl
 * "alles" -- und eine Sperrung ueber das ganze Haus ist eine Schliessung
 * und keine Wartungsmeldung.
 */
const SPERRE_MAX_ZIMMER = 100

/**
 * Wie viele Zimmer ein Aufruf zum Reinigungsstand setzen darf. Ein ganzes
 * Haus passt hinein, denn der naechtliche Abgleich schickt genau das.
 */
const STATUS_MAX_ZIMMER = 500

/**
 * Gemischte Staende, adressiert ueber die Zimmernummer.
 *
 * Eine unbekannte Nummer weist den ganzen Aufruf ab und nennt die Nummern.
 * Still uebersprungen hiesse: das andere System haelt ein Zimmer fuer
 * sauber, das hier nie angekommen ist, und merkt es nicht. Die Nummer wird
 * nur im Haus des Aufrufs gesucht -- dieselbe Nummer gibt es im
 * Nachbarhaus desselben Accounts, und die Zeilenrichtlinie trennt die
 * Haeuser nicht.
 *
 * `assigned_to` bleibt unberuehrt: ein fremdes System kennt unsere
 * Benutzer nicht und soll eine Zuteilung am Bildschirm nicht loeschen.
 */
async function setzeJeZimmernummer(
  req: FastifyRequest, propertyId: number,
  items: Array<{ roomCode: string; status: HousekeepingState }>, principal: Principal
): Promise<{ updated: number }> {
  if (!Array.isArray(items) || items.length === 0) {
    throw Errors.validation({ items: ['field.atLeastOneRoom'] })
  }
  if (items.length > STATUS_MAX_ZIMMER) throw Errors.rangeTooLarge(STATUS_MAX_ZIMMER)
  for (const i of items) {
    if (typeof i !== 'object' || i === null
        || typeof i.roomCode !== 'string' || i.roomCode.trim() === '') {
      throw Errors.validation({ roomCode: ['field.required'] })
    }
    if (!STATES.includes(i.status)) {
      throw Errors.validation({ status: ['field.allowedValues'] },
        { values: STATES.join(', ') })
    }
  }
  const codes = items.map(i => i.roomCode.trim())
  // Zweimal dasselbe Zimmer mit zwei Staenden: welcher gilt, waere Zufall.
  if (new Set(codes).size !== codes.length) {
    throw Errors.validation({ items: ['field.duplicateRoom'] })
  }

  return tx(req.pool, req, async client => {
    const { rows } = await client.query<{ code: string }>(
      `SELECT code FROM resource WHERE property_id = $1 AND code = ANY($2::text[])`,
      [propertyId, codes])
    if (rows.length !== codes.length) {
      const bekannt = new Set(rows.map(r => r.code))
      throw Errors.validation({ roomCode: ['field.unknownValues'] },
        { values: codes.filter(c => !bekannt.has(c)).join(', ') })
    }
    const { rowCount } = await client.query(
      `INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
       SELECT $1, r.id, i.status, $4
         FROM unnest($2::text[], $3::text[]) AS i(code, status)
         JOIN resource r ON r.property_id = $1 AND r.code = i.code
       ON CONFLICT (resource_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [propertyId, codes, items.map(i => i.status), principal.userId])
    return { updated: rowCount ?? 0 }
  })
}

export function housekeepingRoutes(app: FastifyInstance): void {
  /**
   * Der Zimmerplan des Tages in **einer** Abfrage.
   *
   * Housekeeping laeuft auf dem Telefon durchs Haus, oft ueber WLAN mit
   * schlechter Verbindung. Die Liste je Zimmer einzeln zu laden waere bei
   * 250 Zimmern 250 Runden. Zustand, Aufgabe, Abreise und Anreise kommen
   * deshalb zusammen (P-Gesetz, Dokument 04).
   *
   * **Fuer ein externes Reinigungssystem** stehen zwei Angaben mehr da, die
   * es heute vom Adminpanel bekommt: `departureCheckedOut` sagt, ob der
   * abreisende Gast schon ausgecheckt ist -- erst dann ist das Zimmer frei
   * zum Reinigen, vorher wartet die Reinigungskraft. `stayoverRef` nennt den
   * Bleiber, dessen Zimmer heute eine Zwischenreinigung bekommt. Mit beiden
   * zusammen ergibt sich der Tagesplan (Abreise, Bleiber, leer, frei) aus
   * diesem einen Aufruf.
   *
   * Eine Buchung zaehlt als angereist, auch ohne Check-in von Hand
   * (Grundregel, 05.10.2026): deshalb ist `Confirmed` bei Abreise und Bleiber
   * dabei. Fehlte es bei der Abreise, stuende ein nie eingecheckter Gast am
   * Abreisetag weder als Abreise noch als Bleiber da, und sein Zimmer fiele
   * aus dem Tagesplan.
   *
   * Der Bleiber kommt ueber `LATERAL ... LIMIT 1`: zwei Reservierungen auf
   * demselben Zimmer in derselben Nacht sind ein Datenfehler, und er soll
   * die Zimmerzeile nicht verdoppeln.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/housekeeping',
    permission: 'housekeeping:read',
    propertyParam: 'propertyId',
    summary: 'Zimmerplan des Tages',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { date?: string }
      const date = q.date ?? null
      if (date !== null && !isIsoDate(date)) {
        throw Errors.validation({ date: ['field.isoDate'] })
      }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `WITH tag AS (
             SELECT COALESCE($2::date,
                     (SELECT date FROM business_day
                       WHERE property_id = $1 AND status = 'open'
                       ORDER BY date LIMIT 1)) AS d
           )
           SELECT r.id AS "resourceId", r.code, c.code AS "categoryCode",
                  COALESCE(h.status, 'clean') AS status,
                  h.assigned_to AS "assignedTo",
                  h.updated_at::text AS "updatedAt",
                  t.kind AS "taskKind", t.status AS "taskStatus", t.id AS "taskId",
                  ab.public_ref AS "departureRef",
                  ab.departure::text AS "departureDate",
                  (ab.status = 'CheckedOut') AS "departureCheckedOut",
                  bl.public_ref AS "stayoverRef",
                  an.public_ref AS "arrivalRef",
                  (SELECT count(*) FROM maintenance_ticket m
                    WHERE m.resource_id = r.id AND m.status <> 'done')::int AS "openTickets"
             FROM resource r
             CROSS JOIN tag
             JOIN resource_category c ON c.id = r.category_id
             LEFT JOIN housekeeping_status h ON h.resource_id = r.id
             LEFT JOIN housekeeping_task t
                    ON t.resource_id = r.id AND t.business_date = tag.d
             LEFT JOIN reservation ab
                    ON ab.resource_id = r.id AND ab.departure = tag.d
                   AND ab.status IN ('Confirmed','InHouse','CheckedOut')
             LEFT JOIN reservation an
                    ON an.resource_id = r.id AND an.arrival = tag.d
                   AND an.status IN ('Confirmed','InHouse')
             LEFT JOIN LATERAL (
                    SELECT b.public_ref FROM reservation b
                     WHERE b.resource_id = r.id
                       AND b.arrival < tag.d AND b.departure > tag.d
                       AND b.status IN ('Confirmed','InHouse')
                     LIMIT 1) bl ON true
            WHERE r.property_id = $1 AND r.active
            ORDER BY ${zimmerNachNummer('r')}`,
          [Number(propertyId), date])
        return { date, rooms: rows }
      })
    }
  })

  /**
   * Reinigungsstand setzen, in zwei Formen.
   *
   * `resourceIds` mit **einem** Stand ist die Mehrfachmarkierung am
   * Bildschirm. `items` traegt je Zimmer einen eigenen Stand und nennt das
   * Zimmer bei seiner Nummer: so kommt der naechtliche Abgleich eines
   * externen Reinigungssystems mit gemischten Staenden in **einem** Aufruf
   * an, und das andere System muss unsere internen IDs nicht kennen
   * (Adminpanel, Abschnitt 3.5 des API-Entwurfs). Beide Formen gelten alle
   * oder keines.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/housekeeping/status',
    permission: 'housekeeping:write',
    propertyParam: 'propertyId',
    summary: 'Zimmerstatus setzen, auch fuer mehrere Zimmer und gemischt',
    handler: async (req) => {
      const body = req.body as {
        propertyId: number; resourceIds?: number[]; status?: HousekeepingState
        assignedTo?: number | null
        items?: Array<{ roomCode: string; status: HousekeepingState }> }
      const principal = req.principal as Principal
      if (body.items !== undefined) {
        if (body.resourceIds !== undefined || body.status !== undefined) {
          throw Errors.validation({ items: ['field.eitherRoomIdsOrItems'] })
        }
        return setzeJeZimmernummer(req, body.propertyId, body.items, principal)
      }
      if (body.status === undefined || !STATES.includes(body.status)) {
        throw Errors.validation({ status: ['field.allowedValues'] },
          { values: STATES.join(', ') })
      }
      if (!Array.isArray(body.resourceIds) || body.resourceIds.length === 0) {
        throw Errors.validation({ resourceIds: ['field.atLeastOneRoom'] })
      }
      if (body.resourceIds.length > STATUS_MAX_ZIMMER) {
        throw Errors.rangeTooLarge(STATUS_MAX_ZIMMER)
      }
      const resourceIds = body.resourceIds
      const status = body.status

      return tx(req.pool, req, async client => {
        // Die Zimmer muessen zur Property gehoeren. Die Zeilenrichtlinie
        // filtert nach Mandant, nicht nach Haus; bei mehreren Haeusern im
        // Account kaeme ein fremdes Zimmer sonst durch.
        const gueltig = await client.query<{ id: number }>(
          `SELECT id FROM resource WHERE property_id = $1 AND id = ANY($2::bigint[])`,
          [body.propertyId, resourceIds])
        if (gueltig.rowCount !== resourceIds.length) {
          throw Errors.notFound('res.room')
        }
        const { rowCount } = await client.query(
          `INSERT INTO housekeeping_status (property_id, resource_id, status,
                                            assigned_to, updated_by)
           SELECT $1, unnest($2::bigint[]), $3, $4, $5
           ON CONFLICT (resource_id) DO UPDATE SET
             status = EXCLUDED.status,
             assigned_to = EXCLUDED.assigned_to,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [body.propertyId, resourceIds, status,
           body.assignedTo ?? null, principal.userId])
        return { updated: rowCount ?? 0, status }
      })
    }
  })

  /**
   * Aufgabenliste des Tages erzeugen.
   *
   * Abreise, Bleibegast, sonst nichts. Idempotent ueber den eindeutigen
   * Schluessel: ein zweiter Aufruf am selben Tag legt nichts doppelt an,
   * sondern ergaenzt nur, was seither dazugekommen ist.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/housekeeping/tasks/generate',
    permission: 'housekeeping:write',
    propertyParam: 'propertyId',
    summary: 'Aufgaben des Tages erzeugen',
    handler: async (req) => {
      const body = req.body as { propertyId: number; date?: string }
      if (body.date !== undefined && !isIsoDate(body.date)) {
        throw Errors.validation({ date: ['field.isoDate'] })
      }
      return tx(req.pool, req, async client => {
        const { rowCount } = await client.query(
          `WITH tag AS (
             SELECT COALESCE($2::date,
                     (SELECT date FROM business_day WHERE property_id = $1
                       AND status = 'open' ORDER BY date LIMIT 1)) AS d
           )
           INSERT INTO housekeeping_task (property_id, resource_id, business_date, kind)
           SELECT $1, res.resource_id, tag.d, res.kind FROM tag, LATERAL (
             SELECT r.resource_id,
                    CASE WHEN r.departure = tag.d THEN 'departure' ELSE 'stayover' END AS kind
               FROM reservation r
              WHERE r.property_id = $1 AND r.resource_id IS NOT NULL
                AND r.status = 'InHouse'
                AND r.arrival <= tag.d AND r.departure >= tag.d
           ) res
           ON CONFLICT (resource_id, business_date, kind) DO NOTHING`,
          [body.propertyId, body.date ?? null])
        return { created: rowCount ?? 0 }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/housekeeping/tasks/:taskId/done',
    permission: 'housekeeping:write',
    summary: 'Aufgabe abschliessen',
    handler: async (req) => {
      const { taskId } = req.params as { taskId: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{ resource_id: number
                                                        property_id: number }>(
          `UPDATE housekeeping_task
              SET status = 'done', done_at = now(), outcome = 'cleaned', done_by = $2
            WHERE id = $1 AND status = 'open'
            RETURNING resource_id, property_id`, [Number(taskId), principal.userId])
        if (rowCount === 0) throw Errors.notFound('res.task')
        // Eine erledigte Reinigung setzt den Zimmerstatus mit, sonst muss
        // die Kraft zwei Dinge tippen und tippt eines davon nicht.
        await client.query(
          `INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
           VALUES ($1,$2,'clean',$3)
           ON CONFLICT (resource_id) DO UPDATE SET
             status = 'clean', updated_by = $3, updated_at = now()`,
          [rows[0]!.property_id, rows[0]!.resource_id, principal.userId])
        return { taskId: Number(taskId), status: 'done' }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/maintenance-tickets',
    permission: 'maintenance:write',
    propertyParam: 'propertyId',
    summary: 'Wartungsmeldung anlegen',
    handler: async (req, reply) => {
      const body = req.body as {
        propertyId: number; resourceId?: number; resourceIds?: number[]
        title: string; description?: string
        priority?: 'low' | 'normal' | 'high'
        outOfOrder?: { from: string; to: string }
        /**
         * Sperrung beider Arten. `outOfOrder` bleibt daneben bestehen: es
         * gibt Aufrufer, die es benutzen, und eine Kurzform fuer den
         * haeufigeren Fall schadet nicht.
         */
        block?: { from: string; to: string; kind?: 'out_of_order' | 'out_of_service' } }
      const principal = req.principal as Principal
      if (!body.title || body.title.trim() === '') {
        throw Errors.validation({ title: ['field.required'] })
      }
      const sperre = body.block ?? (body.outOfOrder === undefined ? undefined
        : { ...body.outOfOrder, kind: 'out_of_order' as const })

      /*
       * Ein Zimmer oder zwanzig -- derselbe Aufruf und dieselbe Transaktion.
       *
       * Der Handwerker sperrt eine Etage, und wer im Plan mehrere Zeilen
       * markiert hat, meint alle. Je Zimmer einen eigenen Aufruf zu
       * schicken hiesse: scheitert der dritte, ist die Haelfte gesperrt und
       * die andere nicht -- und an der Oberflaeche steht eine Fehlermeldung,
       * aus der nicht hervorgeht, welche.
       *
       * Doppelt genannte Zimmer fallen weg, statt zwei Meldungen und zwei
       * Riegel fuer dasselbe Zimmer anzulegen.
       */
      const genannt = body.resourceIds
        ?? (body.resourceId === undefined ? [] : [body.resourceId])
      if (genannt.some(z => !Number.isInteger(z))) {
        throw Errors.validation({ resourceIds: ['field.integer'] })
      }
      const zimmer = [...new Set(genannt)]
      if (zimmer.length > SPERRE_MAX_ZIMMER) {
        throw Errors.validation({ resourceIds: ['field.tooManyBlockedRooms'] },
          { max: SPERRE_MAX_ZIMMER })
      }
      if (sperre !== undefined) {
        if (zimmer.length === 0) {
          // Eine Sperrung ohne Zimmer waere eine Sperrung von nichts. Still zu
          // uebergehen hiesse: der Melder glaubt, das Zimmer sei gesperrt.
          throw Errors.validation({ resourceId: ['field.blockNeedsRoom'] })
        }
        if (!isIsoDate(sperre.from) || !isIsoDate(sperre.to)) {
          throw Errors.validation({ block: ['field.isoDate'] })
        }
      }
      return tx(req.pool, req, async client => {
        /*
         * Jedes Zimmer gegen **dieses** Haus pruefen.
         *
         * Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus, und
         * der Fremdschluessel sieht sie ohnehin nicht: eine fremde
         * Zimmer-Id ginge sonst durch und erzeugte eine Meldung, die im
         * eigenen Haus niemand findet.
         */
        if (zimmer.length > 0) {
          const { rowCount } = await client.query(
            `SELECT 1 FROM resource WHERE property_id = $1 AND id = ANY($2::int[])`,
            [body.propertyId, zimmer])
          if (rowCount !== zimmer.length) throw Errors.notFound('res.room')
        }

        /*
         * Ein Einfuegen fuer alle Zimmer, nicht eines je Zimmer. `unnest`
         * mit `[null]` deckt den Fall ohne Zimmer mit ab -- eine Meldung am
         * Haus, etwa fuer den Aufzug.
         */
        const zeilen = zimmer.length === 0 ? [null] : zimmer
        const t = await client.query<{ id: number }>(
          `INSERT INTO maintenance_ticket (property_id, resource_id, title, description,
                                           priority, created_by)
           SELECT $1, z.id, $3, $4, COALESCE($5,'normal'), $6
             FROM unnest($2::int[]) WITH ORDINALITY AS z(id, nr)
            ORDER BY z.nr
           RETURNING id`,
          [body.propertyId, zeilen, body.title.trim(),
           body.description ?? null, body.priority ?? null, principal.userId])

        // Out of Order senkt die Kapazitaet, Out of Service nicht. Der
        // Trigger auf maintenance_block rechnet inventory_day nach.
        if (sperre !== undefined) {
          await client.query(
            `INSERT INTO maintenance_block (property_id, resource_id, from_date, to_date,
                                            kind, reason)
             SELECT $1, z.id, $3::date, $4::date, COALESCE($5,'out_of_order'), $6
               FROM unnest($2::int[]) AS z(id)`,
            [body.propertyId, zimmer, sperre.from, sperre.to,
             sperre.kind ?? null, body.title.trim()])
        }
        reply.status(201)
        // `ticketId` bleibt: die Aufrufer von frueher lesen es, und bei
        // einem Zimmer ist es dasselbe wie der einzige Eintrag der Liste.
        return { ticketId: t.rows[0]!.id, ticketIds: t.rows.map(r => r.id) }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/maintenance-tickets',
    permission: 'housekeeping:read',
    propertyParam: 'propertyId',
    summary: 'Offene Wartungsmeldungen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { status?: string }
      return tx(req.pool, req, async client => {
        // Die Sperrungen des Zimmers kommen als Feld mit. Sie je Meldung
        // nachzuladen waere eine Runde je Zeile -- und ohne sie ist an der
        // Meldung nicht zu sehen, ob das Zimmer gerade Kapazitaet kostet.
        const { rows } = await client.query(
          `SELECT m.id, m.title, m.description, m.priority, m.status,
                  m.created_at::text AS "createdAt", m.closed_at AS "closedAt",
                  m.resource_id AS "resourceId", r.code AS "roomCode",
                  COALESCE(b.sperren, '[]'::jsonb) AS blocks,
                  tr.text AS "translationDe"
             FROM maintenance_ticket m
             LEFT JOIN resource r ON r.id = m.resource_id
             -- Meldungen aus der Personal-App, deutsch (0112). Nur solange
             -- die Uebersetzung zum aktuellen Text gehoert.
             LEFT JOIN staff_text_translation tr
                    ON tr.source_kind = 'problem' AND tr.source_id = m.id AND tr.lang = 'de'
                   AND tr.source_hash = digest(m.description, 'sha256')
             LEFT JOIN LATERAL (
               SELECT jsonb_agg(jsonb_build_object(
                        'kind', mb.kind, 'from', mb.from_date::text,
                        'to', mb.to_date::text, 'reason', mb.reason)
                      ORDER BY mb.from_date) AS sperren
                 FROM maintenance_block mb
                WHERE mb.resource_id = m.resource_id
                  AND mb.to_date > current_date
             ) b ON true
            WHERE m.property_id = $1
              AND ($2::text IS NULL OR m.status = $2)
            ORDER BY CASE m.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                     m.created_at
            LIMIT 500`,
          [Number(propertyId), q.status ?? null])
        return { tickets: rows }
      })
    }
  })

  /**
   * Stand einer Wartungsmeldung aendern.
   *
   * Es gibt bewusst **keinen Loeschknopf**: eine Meldung ist die
   * Aufzeichnung eines Befundes, und wer sie loescht, loescht die Frage, ob
   * das Zimmer je in Ordnung gebracht wurde. Erledigt ist ein Zustand, kein
   * Verschwinden.
   *
   * Die Sperrung bleibt, wo sie ist. Sie mit der Meldung aufzuheben waere
   * bequem und falsch: eine Meldung wird erledigt, wenn jemand die Arbeit
   * getan hat, und ob das Zimmer wieder verkaeuflich ist, entscheidet, wer
   * hineingesehen hat -- nicht die Software.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/maintenance-tickets/:ticketId',
    permission: 'maintenance:write',
    summary: 'Wartungsmeldung in Arbeit nehmen oder erledigen',
    handler: async (req) => {
      const { ticketId } = req.params as { ticketId: string }
      const body = req.body as { status?: string; priority?: string }
      const STAENDE = ['open', 'in_progress', 'done']
      const PRIORITAETEN = ['low', 'normal', 'high']
      if (body.status !== undefined && !STAENDE.includes(body.status)) {
        throw Errors.validation({ status: ['field.allowedValues'] },
          { values: STAENDE.join(', ') })
      }
      if (body.priority !== undefined && !PRIORITAETEN.includes(body.priority)) {
        throw Errors.validation({ priority: ['field.allowedValues'] },
          { values: PRIORITAETEN.join(', ') })
      }

      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query(
          `UPDATE maintenance_ticket SET
             status = COALESCE($2, status),
             priority = COALESCE($3, priority),
             -- Der Zeitpunkt haengt am Zustand, nicht am Aufruf: ein
             -- zweites "erledigt" darf ihn nicht nach hinten schieben.
             closed_at = CASE WHEN $2 = 'done' THEN COALESCE(closed_at, now())
                              WHEN $2 IS NOT NULL THEN NULL
                              ELSE closed_at END
           WHERE id = $1
           RETURNING id, status, priority, closed_at AS "closedAt"`,
          [Number(ticketId), body.status ?? null, body.priority ?? null])
        if (rowCount === 0) throw Errors.notFound('res.maintenanceTicket')
        return rows[0]!
      })
    }
  })
}
