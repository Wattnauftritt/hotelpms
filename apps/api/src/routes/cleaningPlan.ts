import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { meldePush } from '../platform/push.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, propertyIds, type Principal } from '../platform/context.js'
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
 *
 * **Bereiche** (0116) stehen in derselben Liste wie die Zimmer: ein Bad
 * oder ein Flur, der gereinigt wird, aber kein Zimmer ist. Eine Zeile traegt
 * dann `areaId` statt `resourceId`. Ein aktiver Bereich ist jeden Tag
 * faellig -- er hat keinen Gast, der abreist oder bleibt; wer ihn an einem
 * Tag nicht reinigen laesst, teilt ihn niemandem zu.
 *
 * **Mehrere Haeuser, dasselbe Personal** (Sven, 07.10.2026: dieselben
 * Kraefte reinigen Hotel und Gaestehaus). Der Plan bleibt je Haus -- jedes
 * Haus hat seinen Geschaeftstag und seine Zimmer --, aber neben jeder Kraft
 * steht, was sie am selben Tag in den anderen Haeusern schon hat, soweit
 * die Hausdame dort ebenfalls planen darf. Sonst bekaeme eine Kraft im
 * Gaestehaus fuenf Zimmer obendrauf, ohne dass jemand ihre zwoelf im Hotel
 * sieht.
 */

interface Zimmer {
  /** Das Haus der Zeile; bei gemeinsamem Personal stehen mehrere im Plan. */
  propertyId: number
  /** Ein Zimmer oder ein Bereich, nie beides. */
  resourceId: number | null
  areaId: number | null
  code: string
  categoryId: number | null
  categoryCode: string | null
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
  /**
   * Der Gast verzichtet heute auf die Zwischenreinigung (0115). Gibt das
   * Haus dafuer Wasser, bleibt das Zimmer im Plan -- jemand muss die
   * Flasche hinstellen --, sonst ist nichts faellig.
   */
  waived: boolean
}

interface Kraft {
  userId: number
  displayName: string
  active: boolean
  /** Was die Kraft am selben Tag in anderen Haeusern hat (siehe oben). */
  elsewhere: Array<{ propertyId: number; propertyName: string; rooms: number; minutes: number }>
}

/** Zimmer und Bereich in einem Schluessel, fuer Maps ueber beide. */
const ziel = (z: { resourceId?: number | null; areaId?: number | null }): string =>
  z.areaId != null ? `a${z.areaId}` : `r${z.resourceId}`

export async function tagOderOffen(
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
 * Kontext geprueft hat -- und bei gemeinsamem Personal (0116) die Haeuser
 * seines Betriebs aus `staff_houses()`.
 */
async function liesKraefte(
  client: PoolClient, h: Haeuser, date: string
): Promise<Kraft[]> {
  const propertyId = h.propertyId
  const andere = h.andere
  const { rows } = await client.query<Omit<Kraft, 'elsewhere'>>(
    `WITH aktiv AS (
       SELECT u.id
         FROM app_user u
         JOIN user_property_role upr ON upr.user_id = u.id
                                    AND upr.property_id = ANY (staff_houses($1))
         JOIN role ro ON ro.id = upr.role_id AND ro.key = 'housekeeping_staff'
         JOIN property p ON p.id = $1
        WHERE u.status <> 'disabled'
          AND NOT EXISTS (SELECT 1 FROM account_user_block b
                           WHERE b.account_id = p.account_id AND b.user_id = u.id)
     ), geplant AS (
       SELECT DISTINCT assigned_to AS id FROM housekeeping_task
        WHERE property_id = ANY($3::bigint[]) AND business_date = $2::date
          AND assigned_to IS NOT NULL
     )
     SELECT u.id::int AS "userId", u.display_name AS "displayName",
            (u.id IN (SELECT id FROM aktiv)) AS active
       FROM app_user u
      WHERE u.id IN (SELECT id FROM aktiv UNION SELECT id FROM geplant)
      ORDER BY u.display_name`, [propertyId, date, h.plan.map(x => x.id)])
  const anderswo = andere.length === 0 || rows.length === 0 ? [] : (await client.query<{
    userId: number; propertyId: number; propertyName: string; rooms: number; minutes: number }>(
    `SELECT t.assigned_to::int AS "userId", t.property_id::int AS "propertyId",
            p.name AS "propertyName", count(*)::int AS rooms,
            COALESCE(sum(t.minutes), 0)::int AS minutes
       FROM housekeeping_task t JOIN property p ON p.id = t.property_id
      WHERE t.property_id = ANY($1::bigint[]) AND t.business_date = $2::date
        AND t.assigned_to = ANY($3::bigint[]) AND t.kind IN ('departure','stayover')
      GROUP BY 1, 2, 3
      ORDER BY 3`, [andere, date, rows.map(k => k.userId)])).rows
  return rows.map(k => ({
    ...k,
    elsewhere: anderswo.filter(a => a.userId === k.userId)
      .map(({ userId: _u, ...a }) => a)
  }))
}

/**
 * Welche Haeuser ein Plan umfasst.
 *
 * `plan`: getrennt nur das Haus aus dem Pfad; bei gemeinsamem Personal
 * (0116) alle Haeuser des Betriebs, in denen die Hausdame planen darf --
 * das Haus aus dem Pfad zuerst. Ein Plan, ein Vorschlag, ein Speichern.
 *
 * `andere`: Haeuser ausserhalb des Plans, in denen sie ebenfalls planen
 * darf. Dort steht nur, wie viel eine Kraft schon hat (`elsewhere`). Ein
 * Haus, in dem sie nichts zu sagen hat, verraet ihr auch nicht, wer dort
 * wie viel arbeitet.
 */
interface Haeuser {
  propertyId: number
  shared: boolean
  plan: Array<{ id: number; name: string }>
  andere: number[]
}

async function planHaeuser(client: PoolClient, p: Principal, propertyId: number): Promise<Haeuser> {
  const { rows } = await client.query<{ id: number; name: string }>(
    `SELECT q.id::int, q.name
       FROM unnest(staff_houses($1)) WITH ORDINALITY AS h(id, n)
       JOIN property q ON q.id = h.id
      ORDER BY h.n`, [propertyId])
  const plan = rows.filter(h => h.id === propertyId || can(p, 'housekeeping:plan', h.id))
  const drin = new Set(plan.map(h => h.id))
  return {
    propertyId,
    shared: rows.length > 1,
    plan,
    andere: propertyIds(p).filter(id => !drin.has(id) && can(p, 'housekeeping:plan', id))
  }
}

/**
 * Alle aktiven Zimmer und Bereiche des Tages mit dem, was faellig ist, und
 * dem, was geplant ist -- in einer Abfrage (Projektregel: ein Aufruf je
 * Bildschirm).
 *
 * Faellig wie im Housekeeping-Bildschirm: eine Buchung zaehlt als
 * angereist, auch ohne Check-in von Hand (Grundregel vom 05.10.2026),
 * deshalb `Confirmed` bei Abreise und Bleiber. Abreise vor Bleiber: wer am
 * Morgen abreist und am Abend kommt jemand Neues, bekommt eine
 * Abreisereinigung. Ein aktiver Bereich ist immer faellig (0116); ein
 * abgeschalteter steht nur da, wenn er an dem Tag schon geplant ist.
 *
 * Reihenfolge: Gebaeude, Etage, Nummer -- so geht man durchs Haus, und so
 * schneidet der Vorschlag die Abschnitte. Ein Bereich hat keine Etage und
 * steht deshalb am Ende seines Gebaeudes.
 */
async function liesZimmer(
  client: PoolClient, propertyId: number, date: string, norms: CleaningNorm[]
): Promise<Zimmer[]> {
  const { rows } = await client.query<Omit<Zimmer, 'minutes'> & { taskMinutes: number | null
                                                                   water: boolean
                                                                   areaMinutes: number | null }>(
    `SELECT * FROM (
       SELECT r.property_id::int AS "propertyId", r.id::int AS "resourceId",
              NULL::int AS "areaId", r.code,
              r.category_id::int AS "categoryId", c.code AS "categoryCode", r.building, r.floor,
              CASE WHEN ab.status IS NOT NULL THEN 'departure'
                   WHEN bl.found THEN 'stayover' END AS due,
              COALESCE(ab.status = 'CheckedOut', false) AS "departureCheckedOut",
              EXISTS (SELECT 1 FROM reservation an
                       WHERE an.resource_id = r.id AND an.arrival = $2::date
                         AND an.status IN ('Confirmed','InHouse')) AS "arrivalToday",
              t.id::int AS "taskId", t.kind, t.assigned_to::int AS "assignedTo",
              t.minutes AS "taskMinutes", t.status AS "taskStatus", t.source,
              COALESCE(bl.waived, false) AS waived,
              COALESCE((SELECT s.enabled AND s.water_gift FROM property_cleaning_waiver_setting s
                         WHERE s.property_id = $1), false) AS water,
              NULL::int AS "areaMinutes"
         FROM resource r
         JOIN resource_category c ON c.id = r.category_id
         LEFT JOIN LATERAL (
                SELECT a.status FROM reservation a
                 WHERE a.resource_id = r.id AND a.departure = $2::date
                   AND a.status IN ('Confirmed','InHouse','CheckedOut')
                 ORDER BY a.status = 'CheckedOut' DESC LIMIT 1) ab ON true
         LEFT JOIN LATERAL (
                SELECT true AS found,
                       EXISTS (SELECT 1 FROM cleaning_waiver w
                                WHERE w.reservation_id = b.id AND w.business_date = $2::date
                                  AND w.withdrawn_at IS NULL) AS waived
                  FROM reservation b
                 WHERE b.resource_id = r.id
                   AND b.arrival < $2::date AND b.departure > $2::date
                   AND b.status IN ('Confirmed','InHouse')
                 LIMIT 1) bl ON true
         LEFT JOIN housekeeping_task t
                ON t.resource_id = r.id AND t.business_date = $2::date
               AND t.kind IN ('departure','stayover')
        WHERE r.property_id = $1 AND r.active
       UNION ALL
       SELECT a.property_id::int, NULL, a.id::int, a.code, NULL, NULL, a.building, NULL,
              CASE WHEN a.active THEN 'departure' END, false, false,
              t.id::int, t.kind, t.assigned_to::int, t.minutes, t.status, t.source,
              false, false, a.minutes
         FROM cleaning_area a
         LEFT JOIN housekeeping_task t ON t.area_id = a.id AND t.business_date = $2::date
        WHERE a.property_id = $1 AND (a.active OR t.id IS NOT NULL)
     ) z
     ORDER BY building NULLS LAST,
              NULLIF(substring(floor from '^-?[0-9]+'), '')::numeric NULLS LAST, floor NULLS LAST,
              NULLIF(substring(code from '^[0-9]+'), '')::numeric NULLS LAST, code`,
    [propertyId, date])
  return rows.map(({ taskMinutes, water, areaMinutes, ...z }) => {
    if (z.areaId !== null) {
      return { ...z, minutes: taskMinutes ?? ((z.kind ?? z.due) === null ? 0 : areaMinutes!) }
    }
    const zimmer = { resourceId: z.resourceId!, categoryId: z.categoryId! }
    /*
     * Null Sollminuten fuer Bleiber heisst: hier gibt es keine
     * Zwischenreinigung. So stand es fuer das Gaestehaus fest im Code der
     * alten App; hier ist es eine Einstellung je Kategorie oder Zimmer, und
     * der Vorschlag laesst diese Zimmer aus. Eine schon geplante Aufgabe
     * bleibt sichtbar -- die hat jemand bewusst angelegt.
     *
     * Ebenso ein Bleiber, dessen Gast verzichtet, wenn es dafuer kein
     * Wasser gibt: dann ist dort nichts zu tun. Mit Wasser bleibt er
     * faellig, und die Kraft hakt die Flasche ab statt einer Reinigung.
     */
    const ohneReinigung = resolveCleaningMinutes(norms, zimmer, 'stayover') === 0
      || (z.waived && !water)
    const due = z.due === 'stayover' && z.kind === null && ohneReinigung ? null : z.due
    const art = z.kind ?? due
    return {
      ...z,
      due,
      minutes: taskMinutes ?? (art === null ? 0 : resolveCleaningMinutes(norms, zimmer, art))
    }
  })
}

/**
 * Der Verlauf des Tages mit Namen. Hoechstens 500 Eintraege: ein Tag mit
 * mehr Umteilungen ist kein Plan mehr, und die Antwort bleibt begrenzt.
 */
async function liesVerlauf(client: PoolClient, haeuser: number[], date: string): Promise<unknown[]> {
  const { rows } = await client.query(
    `SELECT l.id::int, l.changed_at AS "changedAt", l.action, l.kind,
            COALESCE(r.code, a.code) AS "roomCode",
            l.assigned_from::int AS "assignedFrom", l.assigned_to::int AS "assignedTo",
            l.minutes_from AS "minutesFrom", l.minutes_to AS "minutesTo",
            l.status_from AS "statusFrom", l.status_to AS "statusTo",
            u.display_name AS "changedBy"
       FROM housekeeping_task_log l
       LEFT JOIN resource r ON r.id = l.resource_id
       LEFT JOIN cleaning_area a ON a.id = l.area_id
       LEFT JOIN app_user u ON u.id = l.changed_by
      WHERE l.property_id = ANY($1::bigint[]) AND l.business_date = $2::date
      ORDER BY l.id DESC LIMIT 500`, [haeuser, date])
  return rows
}

interface Bereich {
  id: number; code: string; building: string | null; minutes: number; active: boolean
}

/** Alle Bereiche des Hauses, auch abgeschaltete -- fuer die Einstellung. */
async function liesBereiche(client: PoolClient, propertyId: number): Promise<Bereich[]> {
  const { rows } = await client.query<Bereich>(
    `SELECT id::int, code, building, minutes, active FROM cleaning_area
      WHERE property_id = $1 ORDER BY active DESC, building NULLS LAST, code`, [propertyId])
  return rows
}

/**
 * Der Plan eines Tages. Bei gemeinsamem Personal mit den Zimmern aller
 * Plan-Haeuser nacheinander, je Haus in Gehreihenfolge -- so schneidet der
 * Vorschlag am Ende des Hotels in das Gaestehaus hinein und nicht quer
 * durch beide. Sollminuten und Bereiche sind die des Hauses aus dem Pfad;
 * sie bleiben eine Einstellung je Haus.
 */
async function liesPlanZimmer(
  client: PoolClient, h: Haeuser, date: string
): Promise<Zimmer[]> {
  const rooms: Zimmer[] = []
  for (const haus of h.plan) {
    const norms = await liesNormen(client, haus.id)
    rooms.push(...await liesZimmer(client, haus.id, date, norms))
  }
  return rooms
}

async function liesPlan(client: PoolClient, h: Haeuser, date: string): Promise<{
  date: string; shared: boolean; houses: Array<{ id: number; name: string }>
  rooms: Zimmer[]; staff: Kraft[]; norms: CleaningNorm[]; areas: Bereich[]
  defaults: typeof DEFAULT_CLEANING_MINUTES; log: unknown[]
}> {
  // Nacheinander: eine Verbindung fuehrt ohnehin eine Anweisung nach der
  // anderen aus, und `pg` warnt vor dem Gleichzeitigen.
  const norms = await liesNormen(client, h.propertyId)
  const rooms = await liesPlanZimmer(client, h, date)
  const staff = await liesKraefte(client, h, date)
  const areas = await liesBereiche(client, h.propertyId)
  const log = await liesVerlauf(client, h.plan.map(x => x.id), date)
  return { date, shared: h.shared, houses: h.plan, rooms, staff, norms, areas,
           defaults: DEFAULT_CLEANING_MINUTES, log }
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
      return tx(req.pool, req, async client => {
        const h = await planHaeuser(client, req.principal as Principal, propertyId)
        return liesPlan(client, h, await tagOderOffen(client, propertyId, date))
      })
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
        const h = await planHaeuser(client, req.principal as Principal, propertyId)
        const kraefte = await liesKraefte(client, h, tag)
        const erlaubt = new Set(kraefte.filter(k => k.active).map(k => k.userId))
        if (gewaehlt.some(s => !erlaubt.has(s))) {
          throw Errors.validation({ staff: ['cleaning.notStaff'] })
        }
        const zimmer = (await liesPlanZimmer(client, h, tag))
          .filter(z => (z.kind ?? z.due) !== null && z.taskStatus !== 'done')
        const zuteilung = suggestCleaningPlan(zimmer, gewaehlt)
        return {
          date: tag,
          assignments: zimmer.map((z, i) => ({
            ...(z.areaId !== null ? { areaId: z.areaId } : { resourceId: z.resourceId! }),
            kind: (z.kind ?? z.due)!, assignedTo: zuteilung[i] ?? null
          }))
        }
      })
    }
  })

  /**
   * Den Plan eines Tages speichern.
   *
   * Die Liste ist der ganze Plan fuer Abreisen, Bleiber und Bereiche: was
   * darin steht, wird angelegt oder geaendert; offene Aufgaben, die fehlen,
   * fallen weg. Erledigte bleiben immer -- an ihnen haengen abgerechnete
   * Minuten --, und eine erledigte umzuteilen weist der Aufruf ab, statt es
   * still zu uebergehen.
   *
   * Eine Zeile nennt `resourceId` oder `areaId`. Ein Bereich hat immer die
   * Art `departure` (0116).
   *
   * Minuten: bleibt die Art gleich, bleiben die festgeschriebenen Minuten;
   * eine neue Aufgabe oder eine andere Art bekommt die aktuellen
   * Sollminuten, ein Bereich seine eigenen. Eine Zeile aus der alten App
   * behaelt ihre Minuten immer.
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
        assignments?: Array<{ resourceId?: number | null; areaId?: number | null
                              kind: CleaningKind; assignedTo: number | null }>
      }
      const date = pruefeDatum(body.date)
      if (date === undefined) throw Errors.validation({ date: ['field.required'] })
      const liste = body.assignments
      if (!Array.isArray(liste)) throw Errors.validation({ assignments: ['field.required'] })
      // Ein Haus hat selten mehr als 250 Zimmer; die Grenze steht gegen den
      // Aufruf, der aus Versehen eine Liste ohne Ende schickt.
      if (liste.length > 1000) throw Errors.rangeTooLarge(1000)
      for (const a of liste) {
        if (typeof a !== 'object' || a === null) {
          throw Errors.validation({ resourceId: ['field.integer'] })
        }
        const istBereich = a.areaId !== undefined && a.areaId !== null
        if (istBereich ? !Number.isInteger(a.areaId) || (a.resourceId ?? null) !== null
                       : !Number.isInteger(a.resourceId)) {
          throw Errors.validation({ resourceId: ['field.integer'] })
        }
        if (!CLEANING_KINDS.includes(a.kind) || (istBereich && a.kind !== 'departure')) {
          throw Errors.validation({ kind: ['field.allowedValues'] },
            { values: istBereich ? 'departure' : CLEANING_KINDS.join(', ') })
        }
        if (a.assignedTo !== null && !Number.isInteger(a.assignedTo)) {
          throw Errors.validation({ assignedTo: ['field.integer'] })
        }
      }
      if (new Set(liste.map(ziel)).size !== liste.length) {
        throw Errors.validation({ assignments: ['cleaning.oneTaskPerRoom'] })
      }

      return tx(req.pool, req, async client => {
        const h = await planHaeuser(client, principal, propertyId)
        const haeuser = h.plan.map(x => x.id)
        // Ein abgeschlossener Monat ist abgerechnet (Migration 0111); der
        // Trigger haelt es fest, hier bekommt die Hausdame den Satz dazu.
        const zu = await client.query<{ zu: boolean }>(
          `SELECT bool_or(staff_month_is_closed(h, $2::date)) AS zu
             FROM unnest($1::bigint[]) AS h`, [haeuser, date])
        if (zu.rows[0]!.zu) {
          throw Errors.conflict('worktime.monthClosed', { month: date.slice(0, 7) })
        }
        // Zimmer und Bereiche muessen zu den Haeusern **dieses** Plans
        // gehoeren: die Zeilenrichtlinie trennt Mandanten, nicht Haeuser.
        const zimmerIds = liste.flatMap(a => a.areaId != null ? [] : [a.resourceId!])
        const bereichIds = liste.flatMap(a => a.areaId != null ? [a.areaId] : [])
        const { rows: zimmer } = await client.query<{ id: number; category_id: number
                                                      property_id: number }>(
          `SELECT id::int, category_id::int, property_id::int FROM resource
            WHERE property_id = ANY($1::bigint[]) AND id = ANY($2::bigint[])`,
          [haeuser, zimmerIds])
        if (zimmer.length !== zimmerIds.length) throw Errors.notFound('res.room')
        const zimmerInfo = new Map(zimmer.map(z => [z.id, z]))
        const { rows: bereiche } = await client.query<{ id: number; minutes: number
                                                        property_id: number }>(
          `SELECT id::int, minutes, property_id::int FROM cleaning_area
            WHERE property_id = ANY($1::bigint[]) AND id = ANY($2::bigint[])`,
          [haeuser, bereichIds])
        if (bereiche.length !== bereichIds.length) throw Errors.notFound('res.cleaningArea')
        const bereichInfo = new Map(bereiche.map(b => [b.id, b]))

        const kraefte = await liesKraefte(client, h, date)
        const aktiv = new Set(kraefte.filter(k => k.active).map(k => k.userId))
        const bisher = await client.query<{
          id: number; property_id: number; resource_id: number | null; area_id: number | null
          kind: CleaningKind; assigned_to: number | null; minutes: number | null; status: string
          source: string; code: string }>(
          `SELECT t.id::int, t.property_id::int, t.resource_id::int, t.area_id::int, t.kind,
                  t.assigned_to::int, t.minutes, t.status, t.source,
                  COALESCE(r.code, a.code) AS code
             FROM housekeeping_task t
             LEFT JOIN resource r ON r.id = t.resource_id
             LEFT JOIN cleaning_area a ON a.id = t.area_id
            WHERE t.property_id = ANY($1::bigint[]) AND t.business_date = $2::date
              AND t.kind IN ('departure','stayover')
            FOR UPDATE OF t`, [haeuser, date])
        const schluesselAlt = (t: { resource_id: number | null; area_id: number | null }): string =>
          ziel({ resourceId: t.resource_id, areaId: t.area_id })
        const jeZiel = new Map(bisher.rows.map(t => [schluesselAlt(t), t]))

        for (const a of liste) {
          const alt = jeZiel.get(ziel(a))
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
        const gewuenscht = new Set(liste.map(ziel))
        for (const t of bisher.rows) {
          if (!gewuenscht.has(schluesselAlt(t)) && t.status === 'done') {
            throw Errors.conflict('cleaning.taskDone', { room: t.code })
          }
        }

        const normenJeHaus = new Map<number, CleaningNorm[]>()
        for (const haus of haeuser) normenJeHaus.set(haus, await liesNormen(client, haus))
        const zeilen = liste.map(a => {
          const k = ziel(a)
          const alt = jeZiel.get(k)
          const behalten = alt !== undefined && alt.minutes !== null
            && (alt.kind === a.kind || alt.source === 'legacy')
          if (a.areaId != null) {
            const b = bereichInfo.get(a.areaId)!
            return { key: k, propertyId: b.property_id, resourceId: null, areaId: a.areaId,
                     kind: a.kind, assignedTo: a.assignedTo,
                     minutes: behalten ? alt.minutes! : b.minutes }
          }
          const z = zimmerInfo.get(a.resourceId!)!
          return {
            key: k, propertyId: z.property_id, resourceId: z.id, areaId: null,
            kind: a.kind, assignedTo: a.assignedTo,
            minutes: behalten ? alt.minutes! : resolveCleaningMinutes(
              normenJeHaus.get(z.property_id)!, { resourceId: z.id, categoryId: z.category_id },
              a.kind)
          }
        })

        // Was wegfaellt: nicht mehr genannt, oder dasselbe Zimmer mit der
        // anderen Art. Nur offene oder uebersprungene -- erledigte sind oben
        // abgewiesen.
        const jeNeu = new Map(zeilen.map(z => [z.key, z]))
        const weg = bisher.rows.filter(t => {
          const neu = jeNeu.get(schluesselAlt(t))
          return neu === undefined || neu.kind !== t.kind
        }).map(t => t.id)
        if (weg.length > 0) {
          await client.query(`DELETE FROM housekeeping_task WHERE id = ANY($1::bigint[])`, [weg])
        }

        /*
         * Ein Einfuegen fuer alle Zimmer, eines fuer alle Bereiche -- je
         * ihr eigener eindeutiger Schluessel. `planned_by`/`planned_at`
         * aendern sich nur, wo sich an Kraft oder Minuten etwas aendert --
         * sonst stuende nach jedem Speichern die Hausdame an jedem Zimmer,
         * auch an denen, die sie nicht angefasst hat.
         */
        const aenderung = `
               assigned_to = EXCLUDED.assigned_to,
               minutes = EXCLUDED.minutes,
               planned_by = CASE WHEN t.assigned_to IS DISTINCT FROM EXCLUDED.assigned_to
                                   OR t.minutes IS DISTINCT FROM EXCLUDED.minutes
                                 THEN EXCLUDED.planned_by ELSE t.planned_by END,
               planned_at = CASE WHEN t.assigned_to IS DISTINCT FROM EXCLUDED.assigned_to
                                   OR t.minutes IS DISTINCT FROM EXCLUDED.minutes
                                 THEN now() ELSE t.planned_at END`
        const zimmerZeilen = zeilen.filter(z => z.areaId === null)
        if (zimmerZeilen.length > 0) {
          await client.query(
            `INSERT INTO housekeeping_task AS t (property_id, resource_id, business_date, kind,
                                                 assigned_to, minutes, planned_by, planned_at)
             SELECT z.property_id, z.resource_id, $1::date, z.kind, z.assigned_to, z.minutes,
                    $7, now()
               FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::bigint[], $6::int[])
                    AS z(property_id, resource_id, kind, assigned_to, minutes)
             ON CONFLICT (resource_id, business_date, kind) DO UPDATE SET ${aenderung}`,
            [date, zimmerZeilen.map(z => z.propertyId), zimmerZeilen.map(z => z.resourceId),
             zimmerZeilen.map(z => z.kind), zimmerZeilen.map(z => z.assignedTo),
             zimmerZeilen.map(z => z.minutes), principal.userId])
        }
        const bereichZeilen = zeilen.filter(z => z.areaId !== null)
        if (bereichZeilen.length > 0) {
          await client.query(
            `INSERT INTO housekeeping_task AS t (property_id, area_id, business_date, kind,
                                                 assigned_to, minutes, planned_by, planned_at)
             SELECT z.property_id, z.area_id, $1::date, 'departure', z.assigned_to, z.minutes,
                    $6, now()
               FROM unnest($2::bigint[], $3::bigint[], $4::bigint[], $5::int[])
                    AS z(property_id, area_id, assigned_to, minutes)
             ON CONFLICT (area_id, business_date) WHERE area_id IS NOT NULL
             DO UPDATE SET ${aenderung}`,
            [date, bereichZeilen.map(z => z.propertyId), bereichZeilen.map(z => z.areaId),
             bereichZeilen.map(z => z.assignedTo), bereichZeilen.map(z => z.minutes),
             principal.userId])
        }
        /*
         * Wessen Zimmer sich geaendert haben, der bekommt eine Meldung
         * (Baustein 8) -- auch wer Zimmer verloren hat. Nur fuer den offenen
         * Tag und spaeter: ein vergangener Plan interessiert niemanden mehr
         * auf dem Telefon. Je Haus, weil die Meldung zum Haus gehoert.
         */
        for (const haus of haeuser) {
          if (date < await tagOderOffen(client, haus, undefined)) continue
          const vorher = new Map<number, Set<string>>()
          const nachher = new Map<number, Set<string>>()
          const merke = (m: Map<number, Set<string>>, u: number | null, k: string): void => {
            if (u === null) return
            if (!m.has(u)) m.set(u, new Set())
            m.get(u)!.add(k)
          }
          for (const t of bisher.rows) {
            if (t.property_id === haus) merke(vorher, t.assigned_to, `${schluesselAlt(t)}:${t.kind}`)
          }
          for (const z of zeilen) {
            if (z.propertyId === haus) merke(nachher, z.assignedTo, `${z.key}:${z.kind}`)
          }
          const gleich = (a?: Set<string>, b?: Set<string>): boolean =>
            (a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every(k => b?.has(k) === true)
          const betroffen = [...new Set([...vorher.keys(), ...nachher.keys()])]
            .filter(u => !gleich(vorher.get(u), nachher.get(u)))
          await meldePush(client, haus, betroffen, 'plan', { date }, date)
        }
        return liesPlan(client, h, date)
      })
    }
  })

  /**
   * Die Bereiche des Hauses ersetzen (0116). Die Liste ist der ganze Stand;
   * was fehlt, wird abgeschaltet, nicht geloescht -- an alten Aufgaben
   * haengen abgerechnete Minuten. Eine neue Zeile kommt ohne `id`.
   *
   * Eine Kennung, die schon ein Zimmer traegt, weist der Aufruf ab: "12"
   * als Zimmer und als Bereich waere auf dem Telefon nicht zu
   * unterscheiden, und der Import ordnete nach der Kennung zu.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/cleaning-areas',
    permission: 'housekeeping:plan',
    propertyParam: 'propertyId',
    summary: 'Reinigungsbereiche ersetzen (Bad, Flur -- was kein Zimmer ist)',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const liste = (req.body as { areas?: unknown } | null)?.areas
      if (!Array.isArray(liste)) throw Errors.validation({ areas: ['field.required'] })
      if (liste.length > 100) throw Errors.rangeTooLarge(100)
      const bereiche = liste.map((x: unknown) => {
        const b = (x ?? {}) as { id?: unknown; code?: unknown; building?: unknown
                                minutes?: unknown; active?: unknown }
        if (b.id !== undefined && b.id !== null && !Number.isInteger(b.id)) {
          throw Errors.validation({ id: ['field.integer'] })
        }
        const code = typeof b.code === 'string' ? b.code.trim() : ''
        if (code === '') throw Errors.validation({ code: ['field.required'] })
        if (code.length > 20) throw Errors.validation({ code: ['field.maxLength'] }, { max: 20 })
        const building = typeof b.building === 'string' && b.building.trim() !== ''
          ? b.building.trim() : null
        if (building !== null && building.length > 40) {
          throw Errors.validation({ building: ['field.maxLength'] }, { max: 40 })
        }
        if (!Number.isInteger(b.minutes) || (b.minutes as number) < 0
            || (b.minutes as number) > CLEANING_MINUTES_MAX) {
          throw Errors.validation({ minutes: ['field.range'] },
            { min: 0, max: CLEANING_MINUTES_MAX })
        }
        return { id: (b.id as number | null | undefined) ?? null, code, building,
                 minutes: b.minutes as number, active: b.active !== false }
      })
      if (new Set(bereiche.map(b => b.code.toLowerCase())).size !== bereiche.length) {
        throw Errors.validation({ code: ['cleaning.areaTwice'] })
      }
      return tx(req.pool, req, async client => {
        const vorhanden = await liesBereiche(client, propertyId)
        const ids = new Set(vorhanden.map(b => b.id))
        if (bereiche.some(b => b.id !== null && !ids.has(b.id))) {
          throw Errors.notFound('res.cleaningArea')
        }
        const zimmer = await client.query<{ code: string }>(
          `SELECT code FROM resource WHERE property_id = $1 AND lower(code) = ANY($2::text[])`,
          [propertyId, bereiche.map(b => b.code.toLowerCase())])
        if (zimmer.rows.length > 0) {
          throw Errors.conflict('cleaning.areaIsRoom', { code: zimmer.rows[0]!.code })
        }
        // Erst alle abschalten und umbenennen lassen, dann setzen: zwei
        // Bereiche, die ihre Kennungen tauschen, stiessen sonst am
        // eindeutigen Index zusammen.
        const genannt = bereiche.flatMap(b => b.id ?? [])
        await client.query(
          `UPDATE cleaning_area SET active = false, code = '~' || id::text,
                                    updated_by = $3, updated_at = now()
            WHERE property_id = $1 AND id = ANY($2::bigint[])`,
          [propertyId, genannt, principal.userId])
        await client.query(
          `UPDATE cleaning_area SET active = false, updated_by = $3, updated_at = now()
            WHERE property_id = $1 AND active AND NOT (id = ANY($2::bigint[]))`,
          [propertyId, genannt, principal.userId])
        for (const b of bereiche) {
          if (b.id === null) {
            await client.query(
              `INSERT INTO cleaning_area (property_id, code, building, minutes, active, updated_by)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [propertyId, b.code, b.building, b.minutes, b.active, principal.userId])
          } else {
            await client.query(
              `UPDATE cleaning_area SET code = $2, building = $3, minutes = $4, active = $5,
                                        updated_by = $6, updated_at = now()
                WHERE id = $1`,
              [b.id, b.code, b.building, b.minutes, b.active, principal.userId])
          }
        }
        // Eine Kennung, die ein abgeschalteter, nicht genannter Bereich
        // noch traegt, ist vergeben -- der Index sagt es, hier mit Satz.
        return { areas: await liesBereiche(client, propertyId) }
      }).catch((e: unknown) => {
        if ((e as { code?: string }).code === '23505') throw Errors.conflict('cleaning.areaTaken')
        throw e
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
