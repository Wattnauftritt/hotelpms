import type { FastifyInstance } from 'fastify'
import { isIsoDate } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'

/**
 * Die Reservierungsliste fuer angebundene Systeme, mit Aenderungscursor.
 *
 * **Wofuer.** Das Adminpanel (API-Entwurf, Abschnitt 3.1) haelt eine Kopie
 * der Reservierungen und gleicht sie ab: einmal am Tag alles, dazwischen nur,
 * was sich geaendert hat. Die Bildschirmaggregate (`tape-chart`, `search`)
 * passen dafuer nicht -- sie liefern, was ein Mensch sieht, nicht was ein
 * Abgleich braucht --, und `/changes` ist ein Protokoll mit redigierten
 * Namen, keine Liste.
 *
 * **Der Cursor.** Kommt aus `reservation_change` (Migration 0075) und ist das
 * Paar (Transaktionsnummer, laufende Nummer) der letzten Aenderung.
 * Ausgeliefert wird nur, was unter `pg_snapshot_xmin` liegt -- also aus
 * Transaktionen, die sicher abgeschlossen sind. Warum ein Zeitstempel oder
 * eine Sequenz allein Zeilen verlieren, steht in der Migration. Fuer den
 * Aufrufer ist der Cursor undurchsichtig: zurueckgeben, was in `nextCursor`
 * stand, und dieselben Filter wieder mitschicken.
 *
 * **Eine Zeile kann mehrfach kommen.** Aendert sich eine Reservierung,
 * waehrend jemand blaettert, rueckt sie ans Ende und kommt dort noch einmal.
 * Das ist richtig: der Empfaenger ueberschreibt seine Kopie, und die zweite
 * Fassung ist die neuere. Verloren geht keine.
 *
 * **Keine Zeitraumgrenze wie sonst.** `stayFrom` und `stayTo` engen nur ein;
 * die Obergrenze der Antwort ist `limit`. Ein Vollabzug seit 2023 ist der
 * vorgesehene Gebrauch und blaettert in Seiten zu hoechstens 1000.
 */

const LIMIT_VORGABE = 500
const LIMIT_MAX = 1000

/**
 * Welche Zustaende zu welcher Gruppe gehoeren.
 *
 * Ersetzt die Codelisten des Altsystems (im Adminpanel: aktiv 0, 1, 2, 4;
 * storniert 10-14, 19, 22). `Inquired` ist eine Anfrage, noch keine Buchung,
 * und gehoert zu keiner der beiden Gruppen.
 */
const STATUS_GRUPPEN = {
  active: ['Optional', 'Confirmed', 'InHouse', 'CheckedOut'],
  canceled: ['Canceled', 'NoShow']
} as const

type StatusFilter = 'active' | 'canceled' | 'all'

interface Zeile {
  xid: string
  seq: string
  reservationRef: string
  status: string
  guestAnonymized: boolean
  guestEmail?: string | null
  totalCent: string
  [feld: string]: unknown
}

/** `<xid>.<seq>` -- beide als Ziffernfolge, damit nichts anderes in die Abfrage kommt. */
function cursorLesen(roh: string | undefined): { xid: string; seq: string } | null {
  if (roh === undefined || roh === '') return null
  const m = /^(\d{1,20})\.(\d{1,20})$/.exec(roh)
  if (m === null) throw Errors.validation({ changedSince: ['field.cursor'] })
  return { xid: m[1]!, seq: m[2]! }
}

export function reservationListRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/reservations',
    permission: 'reservation:read',
    propertyParam: 'propertyId',
    summary: 'Reservierungen eines Hauses, inkrementell ueber einen Aenderungscursor',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as {
        changedSince?: string; stayFrom?: string; stayTo?: string
        status?: string; include?: string; limit?: string
      }

      const cursor = cursorLesen(q.changedSince)
      if (q.stayFrom !== undefined && !isIsoDate(q.stayFrom)) {
        throw Errors.validation({ stayFrom: ['field.isoDate'] })
      }
      if (q.stayTo !== undefined && !isIsoDate(q.stayTo)) {
        throw Errors.validation({ stayTo: ['field.isoDate'] })
      }
      if (q.stayFrom !== undefined && q.stayTo !== undefined && q.stayTo < q.stayFrom) {
        throw Errors.validation({ stayTo: ['field.notBeforeFrom'] })
      }
      const status = (q.status ?? 'all') as StatusFilter
      if (!['active', 'canceled', 'all'].includes(status)) {
        throw Errors.validation({ status: ['field.allowedValues'] },
          { values: 'active, canceled, all' })
      }
      let limit = LIMIT_VORGABE
      if (q.limit !== undefined) {
        limit = Number(q.limit)
        if (!Number.isInteger(limit) || limit < 1) {
          throw Errors.validation({ limit: ['field.positiveInteger'] })
        }
        if (limit > LIMIT_MAX) {
          throw Errors.validation({ limit: ['field.maxValue'] }, { max: LIMIT_MAX })
        }
      }
      const include = new Set((q.include ?? '').split(',').map(s => s.trim())
        .filter(s => s !== ''))
      const unbekannt = [...include].filter(s => s !== 'guestEmail')
      if (unbekannt.length > 0) {
        throw Errors.validation({ include: ['field.unknownValues'] },
          { values: unbekannt.join(', ') })
      }
      /*
       * Die Mailadresse nur mit eigenem Recht. `reservation:read` bekommt
       * jeder, der eine Buchung sehen darf; eine Liste aller Adressen eines
       * Hauses ist etwas anderes als die eine im Seitenfenster. Ausdruecklich
       * angefordert, damit ein Zugang, der sie nicht braucht, sie auch nicht
       * bekommt -- selbst wenn er das Recht haette.
       */
      const mitMail = include.has('guestEmail')
      if (mitMail && !can(req.principal as Principal, 'guest:read', propertyId)) {
        throw Errors.forbidden('access.missingPermission', { permission: 'guest:read' })
      }

      return tx(req.pool, req, async client => {
        const { rows } = await client.query<Zeile>(
          `SELECT rc.change_xid::text     AS xid,
                  rc.change_seq::text     AS seq,
                  r.public_ref            AS "reservationRef",
                  b.public_ref            AS "bookingRef",
                  b.external_reference    AS "externalReference",
                  -- Die Nummer im Altsystem, getrennt von der Kanalnummer
                  -- (Migration 0078). Das Adminpanel findet daran jede
                  -- Zeile wieder, die es unter ihrer KWHotel-Nummer kennt.
                  r.legacy_system         AS "legacySystem",
                  r.legacy_reference      AS "legacyReference",
                  b.source,
                  b.channel_code          AS "channelCode",
                  r.status,
                  r.arrival::text,
                  r.departure::text,
                  (r.departure - 1)::text AS "lastNight",
                  c.code                  AS "categoryCode",
                  c.name                  AS "categoryName",
                  u.code                  AS "roomCode",
                  -- Unter welchem Code ein Kanal den Aufenthalt verkauft
                  -- (Migration 0090): der des Zimmers, ohne Zimmer der
                  -- gebuchte, sonst keiner -- dann gilt die Gruppe.
                  COALESCE(u.sales_code, r.sales_code) AS "salesCode",
                  CASE WHEN g.status = 'anonymized' THEN NULL
                       ELSE nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '')
                  END                     AS "guestName",
                  COALESCE(g.status = 'anonymized', false) AS "guestAnonymized",
                  CASE WHEN $8 THEN g.email END AS "guestEmail",
                  r.guest_count           AS "guestCount",
                  r.adults, r.children,
                  n.total::text           AS "totalCent",
                  p.currency,
                  r.notes,
                  r.short_note            AS "shortNote",
                  r.created_at            AS "createdAt",
                  rc.changed_at           AS "changedAt",
                  r.canceled_at           AS "canceledAt"
             FROM reservation_change rc
             JOIN reservation r       ON r.id = rc.reservation_id
             JOIN booking b           ON b.id = r.booking_id
             JOIN resource_category c ON c.id = r.category_id
             JOIN property p          ON p.id = r.property_id
             LEFT JOIN resource u     ON u.id = r.resource_id
             LEFT JOIN guest g        ON g.id = r.primary_guest_id
             LEFT JOIN LATERAL (
               SELECT COALESCE(sum(price_cent), 0)::bigint AS total
                 FROM reservation_night WHERE reservation_id = r.id) n ON true
            WHERE rc.property_id = $1
              AND rc.change_xid < pg_snapshot_xmin(pg_current_snapshot())
              AND ($2::xid8 IS NULL OR (rc.change_xid, rc.change_seq) > ($2::xid8, $3::bigint))
              AND ($4::date IS NULL OR r.departure > $4::date)
              AND ($5::date IS NULL OR r.arrival <= $5::date)
              AND ($6::text[] IS NULL OR r.status::text = ANY ($6::text[]))
            ORDER BY rc.change_xid, rc.change_seq
            LIMIT $7`,
          [propertyId, cursor?.xid ?? null, cursor?.seq ?? '0',
           q.stayFrom ?? null, q.stayTo ?? null,
           status === 'all' ? null : [...STATUS_GRUPPEN[status]],
           limit + 1, mitMail])

        const hasMore = rows.length > limit
        const seite = hasMore ? rows.slice(0, limit) : rows

        /*
         * Wo es weitergeht. Gibt es mehr, nach der letzten gelieferten
         * Zeile. Gibt es nichts mehr, am Horizont: alles unter xmin ist
         * gesehen, auch was die Filter ausgeschlossen haben. Sonst bliebe
         * der Cursor bei einem Filter, der lange nichts findet, stehen, und
         * jeder Abruf liefe dieselbe Strecke noch einmal ab.
         */
        let nextCursor: string | null
        if (hasMore) {
          const letzte = seite[seite.length - 1]!
          nextCursor = `${letzte.xid}.${letzte.seq}`
        } else {
          const h = await client.query<{ xid: string }>(
            `SELECT GREATEST(pg_snapshot_xmin(pg_current_snapshot()),
                             COALESCE($1::xid8, '0'::xid8))::text AS xid`,
            [cursor?.xid ?? null])
          const horizont = h.rows[0]!.xid
          // Jede gelieferte Zeile liegt unter xmin, also vor dem Horizont.
          // Steht der Cursor schon dort (xmin hat sich nicht bewegt), bleibt
          // er, wie er ist -- mit seiner laufenden Nummer.
          nextCursor = cursor !== null && horizont === cursor.xid
            ? `${cursor.xid}.${cursor.seq}`
            : `${horizont}.0`
        }

        return {
          reservations: seite.map(({ xid: _x, seq: _s, ...z }) => {
            const gruppe = (Object.keys(STATUS_GRUPPEN) as Array<keyof typeof STATUS_GRUPPEN>)
              .find(k => (STATUS_GRUPPEN[k] as readonly string[]).includes(z.status)) ?? null
            const { guestEmail, ...rest } = z
            return {
              ...rest,
              ...(mitMail ? { guestEmail: guestEmail ?? null } : {}),
              statusGroup: gruppe,
              totalCent: Number(z.totalCent)
            }
          }),
          nextCursor,
          hasMore
        }
      })
    }
  })
}
