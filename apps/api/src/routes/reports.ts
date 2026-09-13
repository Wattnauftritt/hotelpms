import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'

/** Kennzahlen ueber mehr als zwei Jahre gehoeren ins Berichtsreplikat. */
const MAX_DAYS = 800

function checkRange(from: string, to: string): number {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw Errors.validation({ from: ['Datum im Format YYYY-MM-DD erwartet'] })
  }
  const days = nightsBetween(from, to) + 1
  if (days <= 0) throw Errors.validation({ to: ['Muss auf oder nach from liegen'] })
  if (days > MAX_DAYS) throw Errors.rangeTooLarge(MAX_DAYS)
  return days
}

/** CSV nach RFC 4180. Semikolon, weil deutsche Tabellenkalkulationen das erwarten. */
function csv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const feld = (v: string | number | null): string => {
    if (v === null) return ''
    const s = String(v)
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map(r => r.map(feld).join(';')).join('\r\n') + '\r\n'
}

export function reportRoutes(app: FastifyInstance): void {
  /**
   * Der Tagesbericht der Rezeption: Anreisen, Abreisen, Hausliste.
   *
   * **Eine Anfrage, drei Abfragen.** Die drei Listen werden am Morgen
   * gemeinsam gebraucht und niemals einzeln; sie einzeln zu holen kostet
   * drei Runden fuer dieselbe Ansicht (P-Gesetz, Dokument 04).
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/daily-sheet',
    permission: 'report:operational',
    propertyParam: 'propertyId',
    summary: 'Anreisen, Abreisen und Hausliste eines Tages',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { date?: string }
      if (q.date !== undefined && !isIsoDate(q.date)) {
        throw Errors.validation({ date: ['Datum im Format YYYY-MM-DD erwartet'] })
      }
      const id = Number(propertyId)

      return tx(req.pool, req, async client => {
        const tag = await client.query<{ d: string }>(
          `SELECT COALESCE($2::date, (SELECT date FROM business_day
             WHERE property_id = $1 AND status = 'open' ORDER BY date LIMIT 1))::text AS d`,
          [id, q.date ?? null])
        const d = tag.rows[0]!.d
        if (d === null) throw Errors.unprocessable('Fuer die Property ist kein Tag geoeffnet.')

        const basis = `r.public_ref AS "reservationRef", r.arrival::text AS arrival,
                       r.departure::text AS departure, r.status::text AS status,
                       res.code AS "roomCode", c.code AS "categoryCode",
                       g.last_name AS "lastName", g.first_name AS "firstName",
                       (SELECT count(*) FROM reservation_occupant o
                         WHERE o.reservation_id = r.id)::int AS occupants`
        const von = `FROM reservation r
                     LEFT JOIN resource res ON res.id = r.resource_id
                     JOIN resource_category c ON c.id = r.category_id
                     LEFT JOIN guest g ON g.id = r.primary_guest_id`

        const arrivals = await client.query(
          `SELECT ${basis}, (reg.id IS NOT NULL) AS "registered"
             ${von}
             LEFT JOIN registration reg ON reg.reservation_id = r.id
                   AND reg.group_registration_id IS NULL
            WHERE r.property_id = $1 AND r.arrival = $2::date
              AND r.status IN ('Confirmed','InHouse')
            ORDER BY g.last_name NULLS LAST, res.code`, [id, d])

        const departures = await client.query(
          `SELECT ${basis},
                  (SELECT COALESCE(sum(ch.gross_cent),0)
                     - COALESCE((SELECT sum(s.amount_cent) FROM settlement s
                                  WHERE s.folio_id = f.id),0)
                     FROM charge ch WHERE ch.folio_id = f.id)::bigint AS "balanceCent"
             ${von}
             LEFT JOIN folio f ON f.reservation_id = r.id AND f.status = 'open'
            WHERE r.property_id = $1 AND r.departure = $2::date
              AND r.status IN ('InHouse','CheckedOut')
            ORDER BY res.code`, [id, d])

        const inHouse = await client.query(
          `SELECT ${basis} ${von}
            WHERE r.property_id = $1 AND r.status = 'InHouse'
              AND r.arrival <= $2::date AND r.departure > $2::date
            ORDER BY res.code`, [id, d])

        return { date: d, arrivals: arrivals.rows, departures: departures.rows,
                 inHouse: inHouse.rows }
      })
    }
  })

  /**
   * Kennzahlen je Tag: Belegung, ADR, RevPAR.
   *
   * Gerechnet wird auf `inventory_day` und den gebuchten Logiserloesen, nicht
   * auf den Reservierungen: der Zaehler ist bereits gefuehrt, und wer
   * Kennzahlen jedes Mal aus Reservierungen aggregiert, scannt bei drei
   * Jahren Historie Millionen Zeilen fuer eine Zahl.
   *
   * ADR ist der Logiserloes je verkaufter Einheit, RevPAR der Logiserloes je
   * **verfuegbarer** Einheit. Der Unterschied ist der ganze Punkt der
   * Kennzahl: ein Haus mit hohem ADR und leeren Zimmern verdient nichts.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/kpi',
    permission: 'report:revenue',
    propertyParam: 'propertyId',
    summary: 'Belegung, ADR und RevPAR je Tag',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string }
      checkRange(q.from, q.to)

      return tx(req.pool, req, async client => {
        // Vergangenheit aus der Aufzeichnung, Zukunft aus dem Zaehler, in
        // einer Abfrage zusammengesetzt. Die Grenze ist der offene
        // Geschaeftstag: alles davor ist festgehalten, alles ab heute ist
        // eine Vorschau auf den Stand der Buecher.
        const { rows } = await client.query<{
          date: string; capacity: number; sold: number; blocked: number
          revenue_cent: number; quelle: string }>(
          `WITH heute AS (
             SELECT COALESCE((SELECT min(date) FROM business_day
                               WHERE property_id = $1 AND status = 'open'),
                             current_date) AS d
           )
           SELECT s.date::text AS date, s.capacity, s.sold, s.blocked,
                  s.room_revenue_cent AS revenue_cent, 'aufgezeichnet' AS quelle
             FROM business_day_stat s, heute
            WHERE s.property_id = $1 AND s.date BETWEEN $2::date AND $3::date
              AND s.date < heute.d
           UNION ALL
           SELECT i.date::text, i.capacity, i.sold, i.blocked,
                  COALESCE((SELECT sum(c.net_cent) FROM charge c
                             WHERE c.property_id = $1 AND c.business_date = i.date
                               AND c.revenue_account = '8300'), 0)::bigint,
                  'auf den Buechern'
             FROM inventory_day i, heute
            WHERE i.property_id = $1 AND i.category_id = 0
              AND i.date BETWEEN $2::date AND $3::date
              AND i.date >= heute.d
           ORDER BY date`,
          [Number(propertyId), q.from, q.to])

        const days = rows.map(r => {
          const verfuegbar = r.capacity - r.blocked
          return {
            date: r.date,
            capacity: r.capacity,
            sold: r.sold,
            available: verfuegbar,
            occupancyPercent: verfuegbar === 0 ? 0
              : Math.round((r.sold / verfuegbar) * 10000) / 100,
            roomRevenueCent: r.revenue_cent,
            adrCent: r.sold === 0 ? 0 : Math.round(r.revenue_cent / r.sold),
            revparCent: verfuegbar === 0 ? 0 : Math.round(r.revenue_cent / verfuegbar),
            // Ehrlich benennen, woher die Zahl kommt: die Vergangenheit ist
            // festgehalten, die Zukunft ist ein Stand, der sich noch aendert.
            source: r.quelle
          }
        })

        const sold = days.reduce((s, d) => s + d.sold, 0)
        const available = days.reduce((s, d) => s + d.available, 0)
        const revenue = days.reduce((s, d) => s + d.roomRevenueCent, 0)
        return {
          from: q.from, to: q.to, days,
          total: {
            sold, available, roomRevenueCent: revenue,
            occupancyPercent: available === 0 ? 0
              : Math.round((sold / available) * 10000) / 100,
            adrCent: sold === 0 ? 0 : Math.round(revenue / sold),
            revparCent: available === 0 ? 0 : Math.round(revenue / available)
          }
        }
      })
    }
  })

  /**
   * Monatliche Beherbergungsstatistik nach dem Beherbergungsstatistikgesetz.
   *
   * Meldepflichtig sind Betriebe ab zehn Schlafgelegenheiten. Gemeldet werden
   * Ankuenfte und Uebernachtungen, getrennt nach Wohnsitzland des Gastes. Die
   * Uebermittlung laeuft ueber eSTATISTIK.core; dieses Endpunkt liefert die
   * Zahlen, nicht die Uebermittlung.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/accommodation-statistics',
    permission: 'report:export',
    propertyParam: 'propertyId',
    summary: 'Monatliche Beherbergungsstatistik',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { month: string }
      if (!/^\d{4}-\d{2}$/.test(q.month ?? '')) {
        throw Errors.validation({ month: ['Format YYYY-MM erwartet'] })
      }
      const von = `${q.month}-01`

      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{
          country: string | null; arrivals: number; nights: number }>(
          `WITH zeitraum AS (
             SELECT $2::date AS von, ($2::date + interval '1 month')::date AS bis
           ),
           gaeste AS (
             SELECT r.id, COALESCE(g.country, 'XX') AS country, r.arrival, r.departure
               FROM reservation r
               LEFT JOIN guest g ON g.id = r.primary_guest_id
               CROSS JOIN zeitraum z
              WHERE r.property_id = $1
                AND r.status IN ('InHouse','CheckedOut')
                AND r.arrival < z.bis AND r.departure > z.von
           )
           SELECT country,
                  count(*) FILTER (
                    WHERE arrival >= (SELECT von FROM zeitraum)
                      AND arrival <  (SELECT bis FROM zeitraum))::int AS arrivals,
                  COALESCE(sum((
                    SELECT count(*) FROM reservation_night n
                     WHERE n.reservation_id = gaeste.id
                       AND n.date >= (SELECT von FROM zeitraum)
                       AND n.date <  (SELECT bis FROM zeitraum))), 0)::int AS nights
             FROM gaeste GROUP BY country ORDER BY country`,
          [Number(propertyId), von])

        const kapazitaet = await client.query<{ beds: number; rooms: number }>(
          `SELECT COALESCE(sum(c.max_occupancy), 0)::int AS beds, count(*)::int AS rooms
             FROM resource r JOIN resource_category c ON c.id = r.category_id
            WHERE r.property_id = $1 AND r.active`, [Number(propertyId)])

        return {
          month: q.month,
          rooms: kapazitaet.rows[0]!.rooms,
          beds: kapazitaet.rows[0]!.beds,
          reportingRequired: kapazitaet.rows[0]!.beds >= 10,
          byCountry: rows,
          totals: {
            arrivals: rows.reduce((s, r) => s + r.arrivals, 0),
            nights: rows.reduce((s, r) => s + r.nights, 0)
          },
          hinweis: 'Uebermittlung an das Statistische Landesamt ueber eSTATISTIK.core. '
                 + 'Land XX bedeutet: kein Wohnsitzland erfasst.'
        }
      })
    }
  })

  /**
   * DATEV-Buchungsstapel im Format EXTF.
   *
   * Bewusst ein Export und keine Schnittstelle: die Anbindung an DATEV
   * Rechnungswesen kostet Lizenz und Onboarding, der Import einer CSV in
   * DATEV kostet nichts und kann jeder Steuerberater (Dokument 09).
   *
   * Gebucht wird je Rechnung gegen Erloeskonten, aufgeteilt nach Steuersatz.
   * Zahlungen stehen **nicht** im Stapel: sie laufen ueber die Kasse oder das
   * Bankkonto des Betriebs, und genau dort werden sie ohnehin gebucht
   * (Entscheidung 9).
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/exports/datev',
    permission: 'report:export',
    propertyParam: 'propertyId',
    summary: 'DATEV-Buchungsstapel als CSV',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string
                               consultantNumber?: string; clientNumber?: string
                               fiscalYearStart?: string }
      checkRange(q.from, q.to)
      const id = Number(propertyId)

      return tx(req.pool, req, async client => {
        const prop = await client.query<{ name: string }>(
          `SELECT name FROM property WHERE id = $1`, [id])
        if (prop.rowCount === 0) throw Errors.notFound('Property')

        const { rows } = await client.query<{
          number: string; issued_on: string; tax_rate_bp: number
          revenue_account: string; gross_cent: number
          recipient: string; kind: string }>(
          `SELECT i.number, i.issued_on::text AS issued_on, c.tax_rate_bp,
                  c.revenue_account, sum(c.gross_cent)::bigint AS gross_cent,
                  COALESCE(i.recipient_snapshot->>'name', 'Divers') AS recipient,
                  i.kind
             FROM invoice i JOIN charge c ON c.invoice_id = i.id
            WHERE i.property_id = $1 AND i.issued_on BETWEEN $2::date AND $3::date
            GROUP BY i.id, i.number, i.issued_on, c.tax_rate_bp, c.revenue_account,
                     i.recipient_snapshot, i.kind
            ORDER BY i.issued_on, i.number, c.revenue_account, c.tax_rate_bp`,
          [id, q.from, q.to])

        const jahr = (q.fiscalYearStart ?? q.from).slice(0, 4)
        const kopf = [
          'EXTF', 700, 21, 'Buchungsstapel', 9, '', '', '', '',
          q.consultantNumber ?? '', q.clientNumber ?? '',
          `${jahr}0101`, 4, q.from.replace(/-/g, ''), q.to.replace(/-/g, ''),
          `hotelpms ${prop.rows[0]!.name}`, '', 1, 0, '', 'EUR',
          '', '', '', '', '', '', '', '', ''
        ]
        const spalten = [
          'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz',
          'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz', 'Konto',
          'Gegenkonto (ohne BU-Schluessel)', 'BU-Schluessel', 'Belegdatum',
          'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext'
        ]

        // Debitorensammelkonto: ohne DATEV-Stammdaten je Gast waere jede
        // Rechnung ein eigener Debitor, und der Steuerberater haette die
        // Pflege am Hals.
        const DEBITOR_SAMMEL = '10000'
        const zeilen = rows.map(r => {
          const betrag = (r.gross_cent / 100).toFixed(2).replace('.', ',')
          const haben = r.kind === 'credit_note'
          return [
            betrag, haben ? 'H' : 'S', 'EUR', '', '', '',
            DEBITOR_SAMMEL, r.revenue_account, '', r.issued_on.slice(8, 10)
              + r.issued_on.slice(5, 7),
            r.number, '', '',
            `${r.recipient} ${r.tax_rate_bp / 100}%`.slice(0, 60)
          ]
        })

        reply.header('content-type', 'text/csv; charset=utf-8')
        reply.header('content-disposition',
          `attachment; filename="datev-${q.from}-${q.to}.csv"`)
        return csv([kopf, spalten, ...zeilen])
      })
    }
  })

  /**
   * GoBD-Export: die steuerlich relevanten Daten des Zeitraums in offener
   * Form, plus eine Beschreibung der Felder.
   *
   * Der Punkt ist die **Nachvollziehbarkeit**: eine Betriebspruefung muss
   * die Daten ohne dieses System lesen koennen. Deshalb CSV und kein
   * proprietaeres Format, und deshalb liegt die Feldbeschreibung bei.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/exports/gobd',
    permission: 'report:export',
    propertyParam: 'propertyId',
    summary: 'GoBD-Export der Umsaetze eines Zeitraums',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string }
      checkRange(q.from, q.to)
      const id = Number(propertyId)

      return tx(req.pool, req, async client => {
        const invoices = await client.query(
          `SELECT number, issued_on::text AS "issuedOn",
                  business_date::text AS "businessDate", kind,
                  issuer_snapshot AS issuer, recipient_snapshot AS recipient,
                  totals, currency, created_at::text AS "createdAt"
             FROM invoice
            WHERE property_id = $1 AND issued_on BETWEEN $2::date AND $3::date
            ORDER BY number`, [id, q.from, q.to])

        const charges = await client.query(
          `SELECT c.id, i.number AS "invoiceNumber", c.business_date::text AS "businessDate",
                  c.description, c.quantity, c.net_cent AS "netCent",
                  c.tax_cent AS "taxCent", c.gross_cent AS "grossCent",
                  c.tax_rate_bp AS "taxRateBp", c.revenue_account AS "revenueAccount",
                  c.reverses_id AS "reversesId", c.created_at::text AS "createdAt"
             FROM charge c LEFT JOIN invoice i ON i.id = c.invoice_id
            WHERE c.property_id = $1 AND c.business_date BETWEEN $2::date AND $3::date
            ORDER BY c.id`, [id, q.from, q.to])

        const settlements = await client.query(
          `SELECT s.id, i.number AS "invoiceNumber", s.business_date::text AS "businessDate",
                  s.amount_cent AS "amountCent", pm.code AS "paymentMethod",
                  s.external_reference AS "externalReference",
                  s.reverses_id AS "reversesId", s.created_at::text AS "createdAt"
             FROM settlement s
             JOIN payment_method pm ON pm.id = s.payment_method_id
             LEFT JOIN invoice i ON i.id = s.invoice_id
            WHERE s.property_id = $1 AND s.business_date BETWEEN $2::date AND $3::date
            ORDER BY s.id`, [id, q.from, q.to])

        return {
          from: q.from, to: q.to,
          invoices: invoices.rows,
          charges: charges.rows,
          settlements: settlements.rows,
          beschreibung: {
            charge: 'Einzelne Leistung auf einem Folio. Unveraenderlich. Eine Korrektur '
                  + 'ist eine zweite Zeile mit negativem Betrag und reversesId auf das '
                  + 'Original, nie eine Aenderung der ersten.',
            settlement: 'Verrechnung einer Zahlung. Die Zahlung selbst wird ausserhalb '
                      + 'dieses Systems abgewickelt und dort aufgezeichnet; '
                      + 'externalReference verweist darauf.',
            invoice: 'Rechnung mit lueckenloser Nummer je Property und Jahr. '
                   + 'issuer und recipient sind Momentaufnahmen zum Zeitpunkt der '
                   + 'Ausstellung, keine Verweise auf Stammdaten.',
            betraege: 'Alle Betraege in Cent als ganze Zahl. taxRateBp in Basispunkten, '
                    + '700 entspricht 7 Prozent.'
          }
        }
      })
    }
  })
}
