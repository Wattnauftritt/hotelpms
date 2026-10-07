import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import {
  CLEANING_KINDS, CLEANING_MINUTES_MAX, DEFAULT_CLEANING_MINUTES, isIsoDate,
  resolveCleaningMinutes, suggestCleaningPlan, type CleaningKind, type CleaningNorm
} from '@hotelpms/domain'

/**
 * Reinigungsplan (Aufgabe 18, Baustein 2; Migration 0106).
 *
 * Die Hausdame teilt je Tag die faelligen Zimmer -- Abreisen und Bleiber --
 * den Reinigungskraeften zu. StayGrid schlaegt die Zuteilung vor, sie
 * schiebt nach und speichert. Jede Zuteilung traegt die Sollminuten, nach
 * denen die Zeitarbeitsfirma abrechnet; sie werden beim Speichern
 * festgeschrieben (`housekeeping_task.minutes`), damit eine spaetere
 * Aenderung der Sollminuten keinen abgerechneten Monat verschiebt.
 *
 * Der Plan steht in `housekeeping_task`, nicht in einer zweiten Tabelle:
 * der Housekeeping-Bildschirm und die Personal-App lesen dieselben Zeilen,
 * und zwei Fassungen desselben Tagesplans liefen auseinander.
 *
 * **Wer Zimmer bekommt:** wer in diesem Haus die Rolle `housekeeping_staff`
 * (Reinigung) hat und nicht deaktiviert oder beim Betrieb gesperrt ist. An
 * der Rolle und nicht am Recht `staff:app`: das tragen auch Kueche, Hausdame
 * und Inhaber, und denen soll der Vorschlag keine Zimmer geben.
 */

interface Zimmer {
  resourceId: number
  code: string
  categoryId: number
  categoryCode: string
  building: string | null
  floor: string | null
  /** Was heute faellig ist, aus den Reservierungen. `null`: nichts. */
  due: CleaningKind | null
  departureCheckedOut: boolean
  arrivalToday: boolean
  taskId: number | null
  kind: CleaningKind | null
  assignedTo: number | null
  /** Festgeschrieben an der Aufgabe; ohne Aufgabe die Sollminuten. */
  minutes: number
  taskStatus: 'open' | 'done' | 'skipped' | null
  source: 'staygrid' | 'legacy' | null
}

interface Kraft { userId: number; displayName: string; active: boolean }

async function tagOderOffen(
  client: PoolClient, propertyId: number, date: string | undefined
): Promise<string> {
  if (date !== undefined) return date
  const { rows } = await client.query<{ d: string | null }>(
    `SELECT COALESCE(
       (SELECT date FROM business_day WHERE property_id = $1 AND status = 'open'
         ORDER BY date LIMIT 1),
       current_date)::text AS d`, [propertyId])
  return rows[0]!.d!
}

async function liesNormen(client: PoolClient, propertyId: number): Promise<CleaningNorm[]> {
  const { rows } = await client.query<CleaningNorm>(
    `SELECT kind, category_id::int AS "categoryId", resource_id::int AS "resourceId", minutes
       FROM cleaning_norm WHERE property_id = $1
      ORDER BY kind, category_id NULLS FIRST, resource_id NULLS FIRST`, [propertyId])
  return rows
}

/**
 * Die Kraefte des Hauses. Wer heute schon Zimmer hat, steht auch dann da,
 * wenn er die Rolle inzwischen nicht mehr hat -- sonst stuende an seinen
 * Zimmern eine Nummer statt eines Namens. `active` sagt, ob er neue
 * bekommen darf.
 *
 * `app_user` und `user_property_role` haben keine Zeilenrichtlinie; die
 * Grenze ist hier das Haus aus dem Pfad, das `propertyParam` gegen den
 * Kontext geprueft hat.
 */
async function liesKraefte(
  client: PoolClient, propertyId: number, date: string
): Promise<Kraft[]> {
  const { rows } = await client.query<Kraft>(
    `WITH aktiv AS (
       SELECT u.id
         FROM app_user u
         JOIN user_property_role upr ON upr.user_id = u.id AND upr.property_id = $1
         JOIN role ro ON ro.id = upr.role_id AND ro.key = 'housekeeping_staff'
         JOIN property p ON p.id = $1
        WHERE u.status <> 'disabled'
          AND NOT EXISTS (SELECT 1 FROM account_user_block b
                           WHERE b.account_id = p.account_id AND b.user_id = u.id)
     ), geplant AS (
       SELECT DISTINCT assigned_to AS id FROM housekeeping_task
        WHERE property_id = $1 AND business_date = $2::date AND assigned_to IS NOT NULL
     )
     SELECT u.id::int AS "userId", u.display_name AS "displayName",
            (u.id IN (SELECT id FROM aktiv)) AS active
       FROM app_user u
      WHERE u.id IN (SELECT id FROM aktiv UNION SELECT id FROM geplant)
      ORDER BY u.display_name`, [propertyId, date])
  return rows
}

/**
 * Alle aktiven Zimmer des Tages mit dem, was faellig ist, und dem, was
 * geplant ist -- in einer Abfrage (Projektregel: ein Aufruf je Bildschirm).
 *
 * Faellig wie im Housekeeping-Bildschirm: eine Buchung zaehlt als
 * angereist, auch ohne Check-in von Hand (Grundregel vom 05.10.2026),
 * deshalb `Confirmed` bei Abreise und Bleiber. Abreise vor Bleiber: wer am
 * Morgen abreist und am Abend kommt jemand Neues, bekommt eine
 * Abreisereinigung.
 *
 * Reihenfolge: Gebaeude, Etage, Nummer -- so geht man durchs Haus, und so
 * schneidet der Vorschlag die Abschnitte.
 */
async function liesZimmer(
  client: PoolClient, propertyId: number, date: string, norms: CleaningNorm[]
): Promise<Zimmer[]> {
  const { rows } = await client.query<Omit<Zimmer, 'minutes'> & { taskMinutes: number | null }>(
    `SELECT r.id::int AS "resourceId", r.code, r.category_id::int AS "categoryId",
            c.code AS "categoryCode", r.building, r.floor,
            CASE WHEN ab.status IS NOT NULL THEN 'departure'
                 WHEN bl.found THEN 'stayover' END AS due,
            COALESCE(ab.status = 'CheckedOut', false) AS "departureCheckedOut",
            EXISTS (SELECT 1 FROM reservation an
                     WHERE an.resource_id = r.id AND an.arrival = $2::date
                       AND an.status IN ('Confirmed','InHouse')) AS "arrivalToday",
            t.id::int AS "taskId", t.kind, t.assigned_to::int AS "assignedTo",
            t.minutes AS "taskMinutes", t.status AS "taskStatus", t.source
       FROM resource r
       JOIN resource_category c ON c.id = r.category_id
       LEFT JOIN LATERAL (
              SELECT a.status FROM reservation a
               WHERE a.resource_id = r.id AND a.departure = $2::date
                 AND a.status IN ('Confirmed','InHouse','CheckedOut')
               ORDER BY a.status = 'CheckedOut' DESC LIMIT 1) ab ON true
       LEFT JOIN LATERAL (
              SELECT true AS found FROM reservation b
               WHERE b.resource_id = r.id
                 AND b.arrival < $2::date AND b.departure > $2::date
                 AND b.status IN ('Confirmed','InHouse')
               LIMIT 1) bl ON true
       LEFT JOIN housekeeping_task t
              ON t.resource_id = r.id AND t.business_date = $2::date
             AND t.kind IN ('departure','stayover')
      WHERE r.property_id = $1 AND r.active
      ORDER BY r.building NULLS LAST,
               NULLIF(substring(r.floor from '^-?[0-9]+'), '')::numeric NULLS LAST, r.floor,
               NULLIF(substring(r.code from '^[0-9]+'), '')::numeric NULLS LAST, r.code`,
    [propertyId, date])
  return rows.map(({ taskMinutes, ...z }) => {
    const art = z.kind ?? z.due
    return {
      ...z,
      minutes: taskMinutes ?? (art === null ? 0 : resolveCleaningMinutes(norms, z, art))
    }
  })
}

/**
 * Der Verlauf des Tages mit Namen. Hoechstens 500 Eintraege: ein Tag mit
 * mehr Umteilungen ist kein Plan mehr, und die Antwort bleibt begrenzt.
 */
async function liesVerlauf(client: PoolClient, propertyId: number, date: string): Promise<unknown[]> {
  const { rows } = await client.query(
    `SELECT l.id::int, l.changed_at AS "changedAt", l.action, l.kind,
            r.code AS "roomCode",
            l.assigned_from::int AS "assignedFrom", l.assigned_to::int AS "assignedTo",
            l.minutes_from AS "minutesFrom", l.minutes_to AS "minutesTo",
            l.status_from AS "statusFrom", l.status_to AS "statusTo",
            u.display_name AS "changedBy"
       FROM housekeeping_task_log l
       LEFT JOIN resource r ON r.id = l.resource_id
       LEFT JOIN app_user u ON u.id = l.changed_by
      WHERE l.property_id = $1 AND l.business_date = $2::date
      ORDER BY l.id DESC LIMIT 500`, [propertyId, date])
  return rows
}

async function liesPlan(client: PoolClient, propertyId: number, date: string): Promise<{
  date: string; rooms: Zimmer[]; staff: Kraft[]; norms: CleaningNorm[]
  defaults: typeof DEFAULT_CLEANING_MINUTES; log: unknown[]
}> {
  const norms = await liesNormen(client, propertyId)
  // Nacheinander: eine Verbindung fuehrt ohnehin eine Anweisung nach der
  // anderen aus, und `pg` warnt vor dem Gleichzeitigen.
  const rooms = await liesZimmer(client, propertyId, date, norms)
  const staff = await liesKraefte(client, propertyId, date)
  const log = await liesVerlauf(client, propertyId, date)
  return { date, rooms, staff, norms, defaults: DEFAULT_CLEANING_MINUTES, log }
}

function pruefeDatum(date: unknown): string | undefined {
  if (date === undefined || date === null) return undefined
  if (typeof date !== 'string' || !isIsoDate(date)) {
    throw Errors.validation({ date: ['field.isoDate'] })
  }
  return date
}

export function cleaningPlanRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/cleaning-plan',
    permission: 'housekeeping:plan',
    propertyParam: 'propertyId',
    summary: 'Reinigungsplan eines Tages mit Kraeften, Sollminuten und Verlauf',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const date = pruefeDatum((req.query as { date?: string }).date)
      return tx(req.pool, req, async client =>
        liesPlan(client, propertyId, await tagOderOffen(client, propertyId, date)))
    }
  })

  /**
   * Ein Vorschlag, nichts gespeichert. Verteilt die faelligen und noch
   * offenen Zimmer auf die genannten Kraefte (`suggestCleaningPlan`);
   * erledigte bleiben, wo sie sind. Die Hausdame sieht ihn, schiebt nach
   * und speichert mit `PUT`.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/cleaning-plan/suggest',
    permission: 'housekeeping:plan',
    propertyParam: 'propertyId',
    summary: 'Zuteilung vorschlagen, ohne zu speichern',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const body = req.body as { date?: string; staff?: unknown }
      const date = pruefeDatum(body.date)
      if (!Array.isArray(body.staff) || body.staff.some(s => !Number.isInteger(s))) {
        throw Errors.validation({ staff: ['field.integer'] })
      }
      const gewaehlt = [...new Set(body.staff as number[])]
      return tx(req.pool, req, async client => {
        const tag = await tagOderOffen(client, propertyId, date)
        const norms = await liesNormen(client, propertyId)
        const kraefte = await liesKraefte(client, propertyId, tag)
        const erlaubt = new Set(kraefte.filter(k => k.active).map(k => k.userId))
        if (gewaehlt.some(s => !erlaubt.has(s))) {
          throw Errors.validation({ staff: ['cleaning.notStaff'] })
        }
        const zimmer = (await liesZimmer(client, propertyId, tag, norms))
          .filter(z => (z.kind ?? z.due) !== null && z.taskStatus !== 'done')
        const zuteilung = suggestCleaningPlan(zimmer, gewaehlt)
        return {
          date: tag,
          assignments: zimmer.map((z, i) => ({
            resourceId: z.resourceId, kind: (z.kind ?? z.due)!, assignedTo: zuteilung[i] ?? null
          }))
        }
      })
    }
  })

  /**
   * Den Plan eines Tages speichern.
   *
   * Die Liste ist der ganze Plan fuer Abreisen und Bleiber: was darin
   * steht, wird angelegt oder geaendert; offene Aufgaben dieser beiden
   * Arten, die fehlen, fallen weg. Erledigte bleiben immer -- an ihnen
   * haengen abgerechnete Minuten --, und eine erledigte umzuteilen weist
   * der Aufruf ab, statt es still zu uebergehen.
   *
   * Minuten: bleibt die Art gleich, bleiben die festgeschriebenen Minuten;
   * eine neue Aufgabe oder eine andere Art bekommt die aktuellen
   * Sollminuten. Eine Zeile aus der alten App behaelt ihre Minuten immer.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/cleaning-plan',
    permission: 'housekeeping:plan',
    propertyParam: 'propertyId',
    summary: 'Reinigungsplan eines Tages speichern',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const body = req.body as {
        date?: string
        assignments?: Array<{ resourceId: number; kind: CleaningKind; assignedTo: number | null }>
      }
      const date = pruefeDatum(body.date)
      if (date === undefined) throw Errors.validation({ date: ['field.required'] })
      const liste = body.assignments
      if (!Array.isArray(liste)) throw Errors.validation({ assignments: ['field.required'] })
      // Ein Haus hat selten mehr als 250 Zimmer; die Grenze steht gegen den
      // Aufruf, der aus Versehen eine Liste ohne Ende schickt.
      if (liste.length > 1000) throw Errors.rangeTooLarge(1000)
      for (const a of liste) {
        if (typeof a !== 'object' || a === null || !Number.isInteger(a.resourceId)) {
          throw Errors.validation({ resourceId: ['field.integer'] })
        }
        if (!CLEANING_KINDS.includes(a.kind)) {
          throw Errors.validation({ kind: ['field.allowedValues'] },
            { values: CLEANING_KINDS.join(', ') })
        }
        if (a.assignedTo !== null && !Number.isInteger(a.assignedTo)) {
          throw Errors.validation({ assignedTo: ['field.integer'] })
        }
      }
      if (new Set(liste.map(a => a.resourceId)).size !== liste.length) {
        throw Errors.validation({ assignments: ['cleaning.oneTaskPerRoom'] })
      }

      return tx(req.pool, req, async client => {
        // Die Zimmer muessen zu **diesem** Haus gehoeren: die
        // Zeilenrichtlinie trennt Mandanten, nicht Haeuser.
        const zimmerIds = liste.map(a => a.resourceId)
        const { rows: zimmer } = await client.query<{ id: number; category_id: number }>(
          `SELECT id::int, category_id::int FROM resource
            WHERE property_id = $1 AND id = ANY($2::bigint[])`, [propertyId, zimmerIds])
        if (zimmer.length !== zimmerIds.length) throw Errors.notFound('res.room')
        const kategorie = new Map(zimmer.map(z => [z.id, z.category_id]))

        const kraefte = await liesKraefte(client, propertyId, date)
        const aktiv = new Set(kraefte.filter(k => k.active).map(k => k.userId))
        const bisher = await client.query<{
          id: number; resource_id: number; kind: CleaningKind; assigned_to: number | null
          minutes: number | null; status: string; source: string; code: string }>(
          `SELECT t.id::int, t.resource_id::int, t.kind, t.assigned_to::int, t.minutes,
                  t.status, t.source, r.code
             FROM housekeeping_task t JOIN resource r ON r.id = t.resource_id
            WHERE t.property_id = $1 AND t.business_date = $2::date
              AND t.kind IN ('departure','stayover')
            FOR UPDATE OF t`, [propertyId, date])
        const jeZimmer = new Map(bisher.rows.map(t => [t.resource_id, t]))

        for (const a of liste) {
          const alt = jeZimmer.get(a.resourceId)
          const unveraendert = alt !== undefined && alt.kind === a.kind
            && alt.assigned_to === a.assignedTo
          // Wer schon Zimmer hat und die Rolle verloren hat, darf sie
          // behalten -- neu bekommt nur, wer die Rolle hat.
          if (a.assignedTo !== null && !aktiv.has(a.assignedTo) && !unveraendert) {
            throw Errors.validation({ assignedTo: ['cleaning.notStaff'] })
          }
          if (alt?.status === 'done' && !unveraendert) {
            throw Errors.conflict('cleaning.taskDone', { room: alt.code })
          }
        }
        const gewuenscht = new Set(liste.map(a => a.resourceId))
        for (const t of bisher.rows) {
          if (!gewuenscht.has(t.resource_id) && t.status === 'done') {
            throw Errors.conflict('cleaning.taskDone', { room: t.code })
          }
        }

        const norms = await liesNormen(client, propertyId)
        const zeilen = liste.map(a => {
          const alt = jeZimmer.get(a.resourceId)
          const behalten = alt !== undefined && alt.minutes !== null
            && (alt.kind === a.kind || alt.source === 'legacy')
          return {
            resourceId: a.resourceId, kind: a.kind, assignedTo: a.assignedTo,
            minutes: behalten ? alt.minutes! : resolveCleaningMinutes(norms,
              { resourceId: a.resourceId, categoryId: kategorie.get(a.resourceId)! }, a.kind)
          }
        })

        // Was wegfaellt: nicht mehr genannt, oder dasselbe Zimmer mit der
        // anderen Art. Nur offene oder uebersprungene -- erledigte sind oben
        // abgewiesen.
        const weg = bisher.rows.filter(t => {
          const neu = zeilen.find(z => z.resourceId === t.resource_id)
          return neu === undefined || neu.kind !== t.kind
        }).map(t => t.id)
        if (weg.length > 0) {
          await client.query(`DELETE FROM housekeeping_task WHERE id = ANY($1::bigint[])`, [weg])
        }

        /*
         * Ein Einfuegen fuer den ganzen Plan. `planned_by`/`planned_at`
         * aendern sich nur, wo sich an Kraft oder Minuten etwas aendert --
         * sonst stuende nach jedem Speichern die Hausdame an jedem Zimmer,
         * auch an denen, die sie nicht angefasst hat.
         */
        if (zeilen.length > 0) {
          await client.query(
            `INSERT INTO housekeeping_task AS t (property_id, resource_id, business_date, kind,
                                                 assigned_to, minutes, planned_by, planned_at)
             SELECT $1, z.resource_id, $2::date, z.kind, z.assigned_to, z.minutes, $7, now()
               FROM unnest($3::bigint[], $4::text[], $5::bigint[], $6::int[])
                    AS z(resource_id, kind, assigned_to, minutes)
             ON CONFLICT (resource_id, business_date, kind) DO UPDATE SET
               assigned_to = EXCLUDED.assigned_to,
               minutes = EXCLUDED.minutes,
               planned_by = CASE WHEN t.assigned_to IS DISTINCT FROM EXCLUDED.assigned_to
                                   OR t.minutes IS DISTINCT FROM EXCLUDED.minutes
                                 THEN EXCLUDED.planned_by ELSE t.planned_by END,
               planned_at = CASE WHEN t.assigned_to IS DISTINCT FROM EXCLUDED.assigned_to
                                   OR t.minutes IS DISTINCT FROM EXCLUDED.minutes
                                 THEN now() ELSE t.planned_at END`,
            [propertyId, date, zeilen.map(z => z.resourceId), zeilen.map(z => z.kind),
             zeilen.map(z => z.assignedTo), zeilen.map(z => z.minutes), principal.userId])
        }
        return liesPlan(client, propertyId, date)
      })
    }
  })

  /**
   * Sollminuten des Hauses ersetzen. Die Liste ist der ganze Stand: was
   * fehlt, faellt weg und damit auf die naechste Stufe zurueck (Kategorie,
   * Haus, Vorgabe). Bestehende Plaene aendert das nicht; ihre Minuten sind
   * festgeschrieben.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/cleaning-norms',
    permission: 'housekeeping:plan',
    propertyParam: 'propertyId',
    summary: 'Sollminuten der Reinigung ersetzen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const norms = (req.body as { norms?: CleaningNorm[] }).norms
      if (!Array.isArray(norms)) throw Errors.validation({ norms: ['field.required'] })
      if (norms.length > 1000) throw Errors.rangeTooLarge(1000)
      for (const n of norms) {
        if (typeof n !== 'object' || n === null || !CLEANING_KINDS.includes(n.kind)) {
          throw Errors.validation({ kind: ['field.allowedValues'] },
            { values: CLEANING_KINDS.join(', ') })
        }
        if (!Number.isInteger(n.minutes) || n.minutes < 0 || n.minutes > CLEANING_MINUTES_MAX) {
          throw Errors.validation({ minutes: ['field.range'] },
            { min: 0, max: CLEANING_MINUTES_MAX })
        }
        if ((n.categoryId ?? null) !== null && (n.resourceId ?? null) !== null) {
          throw Errors.validation({ resourceId: ['cleaning.normTarget'] })
        }
      }
      const schluessel = norms.map(n => `${n.kind}/${n.categoryId ?? ''}/${n.resourceId ?? ''}`)
      if (new Set(schluessel).size !== schluessel.length) {
        throw Errors.validation({ norms: ['cleaning.normTwice'] })
      }
      return tx(req.pool, req, async client => {
        const kategorien = norms.flatMap(n => n.categoryId ?? [])
        const zimmer = norms.flatMap(n => n.resourceId ?? [])
        const pruef = await client.query<{ k: number; z: number }>(
          `SELECT (SELECT count(*) FROM resource_category
                    WHERE property_id = $1 AND id = ANY($2::bigint[]))::int AS k,
                  (SELECT count(*) FROM resource
                    WHERE property_id = $1 AND id = ANY($3::bigint[]))::int AS z`,
          [propertyId, [...new Set(kategorien)], [...new Set(zimmer)]])
        if (pruef.rows[0]!.k !== new Set(kategorien).size) throw Errors.notFound('res.category')
        if (pruef.rows[0]!.z !== new Set(zimmer).size) throw Errors.notFound('res.room')

        await client.query(`DELETE FROM cleaning_norm WHERE property_id = $1`, [propertyId])
        if (norms.length > 0) {
          await client.query(
            `INSERT INTO cleaning_norm (property_id, kind, category_id, resource_id, minutes,
                                        updated_by)
             SELECT $1, n.kind, n.category_id, n.resource_id, n.minutes, $6
               FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::int[])
                    AS n(kind, category_id, resource_id, minutes)`,
            [propertyId, norms.map(n => n.kind), norms.map(n => n.categoryId ?? null),
             norms.map(n => n.resourceId ?? null), norms.map(n => n.minutes),
             principal.userId])
        }
        return { norms: await liesNormen(client, propertyId), defaults: DEFAULT_CLEANING_MINUTES }
      })
    }
  })
}
