import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { hinweisText, type Meldung } from '../platform/texte.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Einrichtung des Hauses: Zimmergruppen und Zimmer.
 *
 * Jedes Hotel hat einen anderen Zuschnitt. Ein Ferienhaus hat drei Wohnungen
 * mit Namen, ein Stadthotel 180 Zimmer in sieben Kategorien mit Nummern nach
 * Etagen, ein Gutshof hat Zimmer, Ferienwohnungen und drei Tagungsräume in
 * einer Anlage. Es gibt keine Vorlage, die davon mehr als die Hälfte trifft.
 *
 * Daraus folgen vier Regeln für diesen Ablauf:
 *
 * 1. **Zimmer werden nicht gelöscht, sondern stillgelegt.** An einem Zimmer
 *    hängen Reservierungen, Rechnungen und Meldescheine. Ein DELETE würde
 *    entweder am Fremdschlüssel scheitern oder Geschichte vernichten. Ein
 *    stillgelegtes Zimmer zählt nicht mehr zur Kapazität, seine Vergangenheit
 *    bleibt lesbar.
 * 2. **Zimmer entstehen in Serie, nicht einzeln.** Niemand tippt 180 Zimmer.
 *    Die Rezeption sagt "101 bis 130, erste Etage, alles Doppelzimmer", und
 *    genau das nimmt dieser Ablauf entgegen.
 * 3. **Vorschau vor dem Anlegen.** Dieselbe Regel wie beim Import: ohne
 *    `commit` wird nichts geschrieben, aber alles geprüft, und der Bericht
 *    ist derselbe. Eine Serie von 180 Zimmern mit einem Zahlendreher im
 *    Muster ist mühsam zurückzunehmen.
 * 4. **Ein Prüfstand sagt, was noch fehlt.** Ein Haus kann erst buchen, wenn
 *    Kategorien, Zimmer, ein Ratenplan, materialisiertes Inventar und ein
 *    offener Geschäftstag da sind. Diese Liste im Kopf zu haben ist genau
 *    die Art Wissen, die beim ersten Kunden fehlt.
 */

/** Obergrenze je Serie. Schützt vor einem Tippfehler im Bereich. */
const MAX_SERIE = 500

interface CategoryBody {
  code: string
  name: string
  description?: string
  maxOccupancy?: number
  sortOrder?: number
  overbookingLimit?: number
  timeUnit?: 'night' | 'hour' | 'day' | 'month'
}

interface RoomSeries {
  propertyId: number
  categoryId: number
  /** Vorsatz vor der Nummer, etwa "1" für 101 oder "App " für "App 3". */
  prefix?: string
  from: number
  to: number
  /** Stellen der Nummer mit führenden Nullen. 3 ergibt 007. */
  pad?: number
  suffix?: string
  floor?: string
  attributes?: string[]
  /** Einzelne Nummern der Serie auslassen, etwa die 13. */
  skip?: number[]
  commit?: boolean
}

interface RoomPlan { code: string; exists: boolean; reason?: string }

function buildCodes(s: RoomSeries): string[] {
  if (!Number.isInteger(s.from) || !Number.isInteger(s.to)) {
    throw Errors.validation({ from: ['field.integer'], to: ['field.integer'] })
  }
  if (s.to < s.from) throw Errors.validation({ to: ['field.notBeforeFrom'] })
  const anzahl = s.to - s.from + 1
  if (anzahl > MAX_SERIE) throw Errors.rangeTooLarge(MAX_SERIE)
  const pad = s.pad ?? 0
  if (pad < 0 || pad > 6) throw Errors.validation({ pad: ['field.weekdayRange'] })
  const skip = new Set(s.skip ?? [])

  const codes: string[] = []
  for (let n = s.from; n <= s.to; n++) {
    if (skip.has(n)) continue
    codes.push(`${s.prefix ?? ''}${String(n).padStart(pad, '0')}${s.suffix ?? ''}`)
  }
  if (codes.length === 0) {
    throw Errors.validation({ skip: ['field.seriesEmpty'] })
  }
  return codes
}

/**
 * Die Kategorie muss zu **dieser** Property gehören. Die Zeilenrichtlinie
 * filtert nach Mandant, nicht nach Haus; bei einer Kette käme die Kategorie
 * eines Schwesterhauses sonst durch, und die Zimmer landeten im falschen Haus.
 */
async function assertCategory(
  client: PoolClient, propertyId: number, categoryId: number
): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2`,
    [categoryId, propertyId])
  if (rowCount === 0) throw Errors.notFound('res.category')
}

export function setupRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------------- Gruppen

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/categories',
    permission: 'inventory:read',
    propertyParam: 'propertyId',
    summary: 'Zimmergruppen mit Zimmerzahl',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        // Zimmerzahl gleich mit: eine Gruppenliste ohne die Zahl daneben ist
        // in der Einrichtung wertlos, und sie einzeln nachzuladen wären so
        // viele Runden wie Gruppen.
        const { rows } = await client.query(
          `SELECT c.id, c.public_ref AS "categoryRef", c.code, c.name, c.description,
                  c.max_occupancy AS "maxOccupancy", c.sort_order AS "sortOrder",
                  c.overbooking_limit AS "overbookingLimit", c.time_unit AS "timeUnit",
                  c.active,
                  count(r.id) FILTER (WHERE r.active)::int AS "activeRooms",
                  count(r.id) FILTER (WHERE NOT r.active)::int AS "inactiveRooms"
             FROM resource_category c
             LEFT JOIN resource r ON r.category_id = c.id
            WHERE c.property_id = $1
            GROUP BY c.id
            ORDER BY c.sort_order, c.code`, [Number(propertyId)])
        return { categories: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/categories',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Zimmergruppe anlegen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const body = req.body as CategoryBody
      if (!body.code?.trim() || !body.name?.trim()) {
        throw Errors.validation({ code: ['field.required'], name: ['field.required'] })
      }
      if (body.timeUnit !== undefined && body.timeUnit !== 'night') {
        // Das Feld steht von Anfang an im Modell, damit Tages- und
        // Stundennutzung später ohne Umbau möglich ist (Entscheidung 8).
        // Bedient wird im ersten Schritt bewusst nur die Nacht.
        throw Errors.unprocessable(
          'setup.onlyNightUnit')
      }
      return tx(req.pool, req, async client => {
        const da = await client.query(
          `SELECT 1 FROM resource_category WHERE property_id = $1 AND code = $2`,
          [Number(propertyId), body.code.trim()])
        if (da.rowCount && da.rowCount > 0) {
          throw Errors.conflict('setup.duplicateCategoryCode', { code: body.code })
        }
        const { rows } = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO resource_category (property_id, code, name, description,
                                          max_occupancy, sort_order, overbooking_limit)
           VALUES ($1,$2,$3,NULLIF($4,''),COALESCE($5,2),
                   COALESCE($6,(SELECT COALESCE(max(sort_order),0)+10
                                  FROM resource_category WHERE property_id = $1)),
                   COALESCE($7,0))
           RETURNING id, public_ref`,
          [Number(propertyId), body.code.trim(), body.name.trim(), body.description ?? '',
           body.maxOccupancy ?? null, body.sortOrder ?? null, body.overbookingLimit ?? null])
        reply.status(201)
        return { categoryId: rows[0]!.id, categoryRef: rows[0]!.public_ref,
                 code: body.code.trim() }
      })
    }
  })

  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/categories/:categoryId',
    permission: 'settings:property',
    summary: 'Zimmergruppe ändern',
    handler: async (req) => {
      const { categoryId } = req.params as { categoryId: string }
      const body = req.body as Partial<CategoryBody> & { active?: boolean }
      return tx(req.pool, req, async client => {
        const cur = await client.query<{ id: number; property_id: number; active: boolean }>(
          `SELECT id, property_id, active FROM resource_category WHERE id = $1 FOR UPDATE`,
          [Number(categoryId)])
        if (cur.rowCount === 0) throw Errors.notFound('res.category')

        // Stilllegen mit belegten Zimmern in der Zukunft würde Kapazität
        // unter gebuchten Reservierungen wegziehen. Erst umbuchen, dann
        // stilllegen.
        if (body.active === false && cur.rows[0]!.active) {
          const offen = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM reservation
              WHERE category_id = $1 AND status IN ('Optional','Confirmed','InHouse')
                AND departure > current_date`, [Number(categoryId)])
          if (Number(offen.rows[0]!.n) > 0) {
            throw Errors.conflict(
              'setup.categoryHasFutureReservations',
              { count: offen.rows[0]!.n })
          }
        }

        const { rows } = await client.query(
          `UPDATE resource_category SET
             code = COALESCE($2, code),
             name = COALESCE($3, name),
             description = COALESCE($4, description),
             max_occupancy = COALESCE($5, max_occupancy),
             sort_order = COALESCE($6, sort_order),
             overbooking_limit = COALESCE($7, overbooking_limit),
             active = COALESCE($8, active),
             updated_at = now()
           WHERE id = $1
           RETURNING code, name, max_occupancy AS "maxOccupancy", active`,
          [Number(categoryId), body.code?.trim() ?? null, body.name?.trim() ?? null,
           body.description ?? null, body.maxOccupancy ?? null, body.sortOrder ?? null,
           body.overbookingLimit ?? null, body.active ?? null])

        // Die Belegungszahl ändert die Kapazität nicht: Kapazität ist die
        // Zahl der Einheiten, nicht die Zahl der Betten.
        // Die Belegungszahl aendert die Kapazität nicht: Kapazität ist die
        // Zahl der Einheiten, nicht die Zahl der Betten.
        return { ...rows[0]!,
          hinweis: body.maxOccupancy !== undefined
            ? hinweisText('hint.occupancyNotCapacity') : undefined,
          hinweisKey: body.maxOccupancy !== undefined
            ? 'hint.occupancyNotCapacity' : undefined }
      })
    }
  })

  // ----------------------------------------------------------------- Zimmer

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/rooms',
    permission: 'inventory:read',
    propertyParam: 'propertyId',
    summary: 'Zimmer des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { categoryId?: string; includeInactive?: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT r.id, r.code, r.floor, r.attributes, r.active,
                  c.id AS "categoryId", c.code AS "categoryCode", c.name AS "categoryName",
                  (SELECT count(*) FROM maintenance_block m
                    WHERE m.resource_id = r.id AND m.kind = 'out_of_order'
                      AND m.to_date > current_date)::int AS "outOfOrderBlocks"
             FROM resource r
             JOIN resource_category c ON c.id = r.category_id
            WHERE r.property_id = $1
              AND ($2::bigint IS NULL OR r.category_id = $2)
              AND (r.active OR $3::boolean)
            ORDER BY c.sort_order, r.code`,
          [Number(propertyId),
           q.categoryId === undefined ? null : Number(q.categoryId),
           q.includeInactive === 'true'])
        return { rooms: rows }
      })
    }
  })

  /**
   * Zimmer in Serie anlegen.
   *
   * Der Kern der Einrichtung. Ohne `commit` ist es eine Vorschau: welche
   * Nummern entstünden, welche gibt es schon. Mit `commit` entsteht die
   * Serie in **einer** Anweisung, und der Kapazitätstrigger rechnet einmal
   * für die betroffene Gruppe nach statt einmal je Zimmer (Migration 0013).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/rooms/series',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Zimmerserie anlegen, mit Vorschau',
    handler: async (req) => {
      const body = req.body as RoomSeries
      const codes = buildCodes(body)

      return tx(req.pool, req, async client => {
        await assertCategory(client, body.propertyId, body.categoryId)

        const vorhanden = await client.query<{ code: string; category: string
                                               active: boolean }>(
          `SELECT r.code, c.code AS category, r.active
             FROM resource r JOIN resource_category c ON c.id = r.category_id
            WHERE r.property_id = $1 AND r.code = ANY($2::text[])`,
          [body.propertyId, codes])
        const belegt = new Map(vorhanden.rows.map(v => [v.code, v]))

        const plan: RoomPlan[] = codes.map(code => {
          const v = belegt.get(code)
          return v === undefined
            ? { code, exists: false }
            : { code, exists: true,
                reason: v.active
                  ? `Nummer ist bereits vergeben, Gruppe ${v.category}`
                  : `Nummer ist stillgelegt vorhanden, Gruppe ${v.category}` }
        })
        const neu = plan.filter(p => !p.exists).map(p => p.code)

        const bericht = {
          dryRun: body.commit !== true,
          planned: codes.length,
          created: 0,
          skipped: codes.length - neu.length,
          rooms: plan
        }
        if (body.commit !== true || neu.length === 0) return bericht

        // Eine Anweisung für die ganze Serie. Der Trigger auf Anweisungsebene
        // rechnet die Kapazität einmal nach, nicht einmal je Zimmer.
        const r = await client.query(
          `INSERT INTO resource (property_id, category_id, code, floor, attributes)
           SELECT $1, $2, code, NULLIF($4,''), COALESCE($5::text[], '{}')
             FROM unnest($3::text[]) AS code`,
          [body.propertyId, body.categoryId, neu, body.floor ?? '',
           body.attributes ?? null])
        return { ...bericht, created: r.rowCount ?? 0 }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/rooms',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Einzelnes Zimmer anlegen',
    handler: async (req, reply) => {
      const body = req.body as { propertyId: number; categoryId: number; code: string
                                 floor?: string; attributes?: string[] }
      if (!body.code?.trim()) throw Errors.validation({ code: ['field.required'] })
      return tx(req.pool, req, async client => {
        await assertCategory(client, body.propertyId, body.categoryId)
        const da = await client.query(
          `SELECT 1 FROM resource WHERE property_id = $1 AND code = $2`,
          [body.propertyId, body.code.trim()])
        if (da.rowCount && da.rowCount > 0) {
          throw Errors.conflict('setup.duplicateRoomCode', { code: body.code })
        }
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO resource (property_id, category_id, code, floor, attributes)
           VALUES ($1,$2,$3,NULLIF($4,''),COALESCE($5::text[],'{}')) RETURNING id`,
          [body.propertyId, body.categoryId, body.code.trim(), body.floor ?? '',
           body.attributes ?? null])
        reply.status(201)
        return { roomId: rows[0]!.id, code: body.code.trim() }
      })
    }
  })

  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/rooms/:roomId',
    permission: 'settings:property',
    summary: 'Zimmer ändern, umgruppieren oder stilllegen',
    handler: async (req) => {
      const { roomId } = req.params as { roomId: string }
      const body = req.body as { code?: string; floor?: string; attributes?: string[]
                                 categoryId?: number; active?: boolean }
      return tx(req.pool, req, async client => {
        const cur = await client.query<{ id: number; property_id: number
                                         category_id: number; active: boolean }>(
          `SELECT id, property_id, category_id, active FROM resource
            WHERE id = $1 FOR UPDATE`, [Number(roomId)])
        if (cur.rowCount === 0) throw Errors.notFound('res.room')
        const zimmer = cur.rows[0]!

        if (body.categoryId !== undefined && body.categoryId !== zimmer.category_id) {
          await assertCategory(client, zimmer.property_id, body.categoryId)
        }

        /*
         * Stilllegen zieht Kapazität ab. Liegt in der Zukunft eine
         * Reservierung auf genau diesem Zimmer, verlöre sie ihr Zimmer, ohne
         * dass es jemandem auffiele. Umzugehen ist das nur durch Umbuchen,
         * also wird hier abgewiesen statt still zugelassen.
         */
        if (body.active === false && zimmer.active) {
          const belegt = await client.query<{ ref: string; arrival: string }>(
            `SELECT public_ref AS ref, arrival::text AS arrival FROM reservation
              WHERE resource_id = $1 AND status IN ('Confirmed','InHouse')
                AND departure > current_date
              ORDER BY arrival LIMIT 5`, [Number(roomId)])
          if (belegt.rowCount && belegt.rowCount > 0) {
            throw Errors.conflict(
              'setup.roomHasFutureReservations',
              { reservations: belegt.rows.map(b => `${b.ref} ab ${b.arrival}`).join(', ') })
          }
        }

        const { rows } = await client.query(
          `UPDATE resource SET
             code = COALESCE($2, code),
             floor = COALESCE($3, floor),
             attributes = COALESCE($4::text[], attributes),
             category_id = COALESCE($5, category_id),
             active = COALESCE($6, active),
             updated_at = now()
           WHERE id = $1
           RETURNING code, floor, attributes, category_id AS "categoryId", active`,
          [Number(roomId), body.code?.trim() ?? null, body.floor ?? null,
           body.attributes ?? null, body.categoryId ?? null, body.active ?? null])

        // Ein Umzug zwischen Gruppen verschiebt Kapazität von der einen zur
        // anderen. Der Trigger rechnet beide Seiten nach (Migration 0013).
        return rows[0]!
      })
    }
  })

  // -------------------------------------------------------------- Prüfstand

  /**
   * Was fehlt dem Haus noch, bevor es buchen kann.
   *
   * Eine Einrichtung scheitert selten an einem schweren Fehler, sondern
   * daran, dass ein Schritt vergessen wurde und die erste Buchung dann mit
   * "nicht materialisiert" abgewiesen wird. Diese Liste macht den Zustand
   * sichtbar, bevor der erste Gast anruft.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/setup-status',
    permission: 'inventory:read',
    propertyParam: 'propertyId',
    summary: 'Einrichtungsstand des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{
          categories: number; rooms: number; rate_plans: number; priced_days: number
          horizon: string | null; open_day: string | null; payment_methods: number
          tax_rules: number }>(
          `SELECT
             (SELECT count(*)::int FROM resource_category
               WHERE property_id = $1 AND active) AS categories,
             (SELECT count(*)::int FROM resource
               WHERE property_id = $1 AND active) AS rooms,
             (SELECT count(*)::int FROM rate_plan
               WHERE property_id = $1 AND active) AS rate_plans,
             (SELECT count(*)::int FROM rate_day
               WHERE property_id = $1 AND date >= current_date) AS priced_days,
             (SELECT max(date)::text FROM inventory_day
               WHERE property_id = $1 AND category_id = 0) AS horizon,
             (SELECT min(date)::text FROM business_day
               WHERE property_id = $1 AND status = 'open') AS open_day,
             (SELECT count(*)::int FROM payment_method
               WHERE property_id = $1 AND active) AS payment_methods,
             (SELECT count(*)::int FROM tax_rule
               WHERE property_id = $1 AND active) AS tax_rules`,
          [Number(propertyId)])
        const s = rows[0]!

        /*
         * Jeder Schritt traegt seinen Schluessel und den deutschen Satz. Der
         * Schluessel ist ohnehin schon da -- `key` benennt den Schritt --,
         * aber die Saetze haengen nicht an ihm: zwei Schritte haben je nach
         * Stand einen anderen Hinweis, und der eine traegt ein Datum.
         */
        const schritt = (
          key: string, done: boolean, count: number,
          hintKey: Meldung, hintParams?: Record<string, string | number>
        ) => ({
          key, done, count,
          label: hinweisText(`setup.step.${key}` as Meldung),
          labelKey: `setup.step.${key}`,
          hint: hinweisText(hintKey, hintParams),
          hintKey,
          ...(hintParams === undefined ? {} : { hintParams })
        })

        const schritte = [
          schritt('categories', s.categories > 0, s.categories,
            'setup.step.categories.hint'),
          schritt('rooms', s.rooms > 0, s.rooms, 'setup.step.rooms.hint'),
          schritt('inventory', s.horizon !== null, 0,
            s.horizon === null
              ? 'setup.step.inventory.hint.missing'
              : 'setup.step.inventory.hint.until',
            s.horizon === null ? undefined : { date: s.horizon }),
          schritt('tax_rules', s.tax_rules > 0, s.tax_rules,
            'setup.step.tax_rules.hint'),
          schritt('rate_plans', s.rate_plans > 0, s.rate_plans,
            'setup.step.rate_plans.hint'),
          schritt('prices', s.priced_days > 0, s.priced_days,
            'setup.step.prices.hint'),
          schritt('payment_methods', s.payment_methods > 0, s.payment_methods,
            'setup.step.payment_methods.hint'),
          schritt('business_day', s.open_day !== null, 0,
            s.open_day === null
              ? 'setup.step.business_day.hint.missing'
              : 'setup.step.business_day.hint.since',
            s.open_day === null ? undefined : { date: s.open_day })
        ]

        const offen = schritte.filter(x => !x.done)
        return {
          // Buchbar ist das Haus, sobald Gruppen, Zimmer und Inventar stehen.
          // Der Rest ist wichtig, aber nicht Voraussetzung für die erste
          // Reservierung, und eine Liste, die alles gleich dringend macht,
          // wird nicht gelesen.
          bookable: s.categories > 0 && s.rooms > 0 && s.horizon !== null,
          complete: offen.length === 0,
          steps: schritte,
          nextStep: offen[0]?.label ?? null
        }
      })
    }
  })
}
