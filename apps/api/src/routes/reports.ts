import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { hinweisText } from '../platform/texte.js'
import { isIsoDate, nightsBetween, businessDateFor } from '@hotelpms/domain'
import { assertNotTraining } from '../platform/training.js'

/** Kennzahlen ueber mehr als zwei Jahre gehoeren ins Berichtsreplikat. */
const MAX_DAYS = 800

/** So weit zurueck zeigt der Nachtlauf-Stand hoechstens. */
const NACHTLAUF_TAGE_MAX = 60

/**
 * Die Schritte, die ein vollstaendiger Lauf hinterlaesst. Steht hier, damit
 * die Oberflaeche einen unvollstaendigen Tag erkennt, ohne die Liste selbst
 * zu kennen; die Reihenfolge ist die des Laufs (B1, Dokument 13).
 */
const NACHTLAUF_SCHRITTE = [
  'rollover', 'post_accommodation', 'post_city_tax', 'no_shows', 'expire_options',
  'release_blocks', 'statistics'
] as const

interface KennzahlenTag {
  date: string; capacity: number; sold: number; available: number
  occupancyPercent: number; roomRevenueCent: number; adrCent: number
  revparCent: number; source: string
}

interface KennzahlenZeitraum {
  from: string; to: string
  days: KennzahlenTag[]
  total: { sold: number; available: number; roomRevenueCent: number
           occupancyPercent: number; adrCent: number; revparCent: number }
}

function checkRange(from: string, to: string): number {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw Errors.validation({ from: ['field.isoDate'] })
  }
  const days = nightsBetween(from, to) + 1
  if (days <= 0) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
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
        throw Errors.validation({ date: ['field.isoDate'] })
      }
      const id = Number(propertyId)

      return tx(req.pool, req, async client => {
        const tag = await client.query<{ d: string }>(
          `SELECT COALESCE($2::date, (SELECT date FROM business_day
             WHERE property_id = $1 AND status = 'open' ORDER BY date LIMIT 1))::text AS d`,
          [id, q.date ?? null])
        const d = tag.rows[0]!.d
        if (d === null) throw Errors.unprocessable('report.noOpenBusinessDay')

        // Der Folio-Verweis gehoert in jede Zeile: die Rezeption springt vom
        // Tagesgeschaeft zur Rechnung, und ihn einzeln nachzuladen waere je
        // Zeile eine Runde.
        const basis = `r.public_ref AS "reservationRef", r.arrival::text AS arrival,
                       r.departure::text AS departure, r.status::text AS status,
                       res.code AS "roomCode", c.code AS "categoryCode",
                       g.last_name AS "lastName", g.first_name AS "firstName",
                       fo.public_ref AS "folioRef",
                       (SELECT count(*) FROM reservation_occupant o
                         WHERE o.reservation_id = r.id)::int AS occupants`
        const von = `FROM reservation r
                     LEFT JOIN resource res ON res.id = r.resource_id
                     JOIN resource_category c ON c.id = r.category_id
                     LEFT JOIN guest g ON g.id = r.primary_guest_id
                     LEFT JOIN folio fo ON fo.reservation_id = r.id AND fo.kind = 'guest'`

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
                                  WHERE s.folio_id = fo.id),0)
                     FROM charge ch WHERE ch.folio_id = fo.id)::bigint AS "balanceCent"
             ${von}
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
   * Kennzahlen eines Zeitraums, Tag fuer Tag.
   *
   * Vergangenheit aus der Aufzeichnung, Zukunft aus dem Zaehler, in einer
   * Abfrage zusammengesetzt. Die Grenze ist der offene Geschaeftstag: alles
   * davor ist festgehalten, alles ab heute ist eine Vorschau auf den Stand
   * der Buecher.
   *
   * `jahreZurueck` verschiebt den Zeitraum in der Datenbank statt in
   * JavaScript. Ein Jahr von einem Kalenderdatum abzuziehen ist keine
   * Zeichenkettenrechnung: der 29. Februar hat im Vorjahr keine
   * Entsprechung, und PostgreSQL loest das nach derselben Regel wie der
   * Rest des Schemas.
   */
  async function kennzahlen(
    client: PoolClient, propertyId: number, from: string, to: string, jahreZurueck = 0
  ): Promise<KennzahlenZeitraum> {
    const { rows } = await client.query<{
      date: string; capacity: number; sold: number; blocked: number
      revenue_cent: number; quelle: string }>(
      `WITH zeitraum AS (
         SELECT ($2::date - make_interval(years => $4::int))::date AS von,
                ($3::date - make_interval(years => $4::int))::date AS bis
       ),
       heute AS (
         SELECT COALESCE((SELECT min(date) FROM business_day
                           WHERE property_id = $1 AND status = 'open'),
                         current_date) AS d
       )
       SELECT s.date::text AS date, s.capacity, s.sold, s.blocked,
              s.room_revenue_cent AS revenue_cent, 'aufgezeichnet' AS quelle
         FROM business_day_stat s, heute, zeitraum z
        WHERE s.property_id = $1 AND s.date BETWEEN z.von AND z.bis
          AND s.date < heute.d
       UNION ALL
       SELECT i.date::text, i.capacity, i.sold, i.blocked,
              COALESCE((SELECT sum(c.net_cent) FROM charge c
                         WHERE c.property_id = $1 AND c.business_date = i.date
                           AND c.revenue_account = '8300'), 0)::bigint,
              'auf den Buechern'
         FROM inventory_day i, heute, zeitraum z
        WHERE i.property_id = $1 AND i.category_id = 0
          AND i.date BETWEEN z.von AND z.bis
          AND i.date >= heute.d
       ORDER BY date`,
      [propertyId, from, to, jahreZurueck])

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
      // Der Zeitraum kommt aus den Zeilen, nicht aus der Anfrage: bei einem
      // verschobenen Vergleich ist er ein anderer, und die Oberflaeche soll
      // beschriften koennen, was sie zeigt.
      from: days[0]?.date ?? from, to: days[days.length - 1]?.date ?? to,
      days,
      total: {
        sold, available, roomRevenueCent: revenue,
        occupancyPercent: available === 0 ? 0
          : Math.round((sold / available) * 10000) / 100,
        adrCent: sold === 0 ? 0 : Math.round(revenue / sold),
        revparCent: available === 0 ? 0 : Math.round(revenue / available)
      }
    }
  }

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
   *
   * Der Vorjahresvergleich kommt im selben Aufruf mit. Ihn als zweite Anfrage
   * zu holen waere zwar moeglich, macht aber aus einem Bildschirm zwei Runden
   * -- und die Zahl, auf die es ankommt, ist ohnehin die Differenz.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/kpi',
    permission: 'report:revenue',
    propertyParam: 'propertyId',
    summary: 'Belegung, ADR und RevPAR je Tag, wahlweise mit Vorjahresvergleich',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string; compare?: string }
      checkRange(q.from, q.to)
      if (q.compare !== undefined && q.compare !== 'previous-year') {
        throw Errors.validation({ compare: ['field.onlyPreviousYear'] })
      }

      return tx(req.pool, req, async client => {
        const id = Number(propertyId)
        const jetzt = await kennzahlen(client, id, q.from, q.to)
        if (q.compare === undefined) return jetzt
        return { ...jetzt, comparison: await kennzahlen(client, id, q.from, q.to, 1) }
      })
    }
  })

  /**
   * Stand des Nachtlaufs.
   *
   * Der schlimmste Ausfall ist der stille: laeuft der Nachtlauf nicht, fehlt
   * die Logis auf den Folios, und bemerkt wird es vom Gast beim Check-out.
   * Der Worker meldet das ins Protokoll -- das liest an der Rezeption
   * niemand. Deshalb dieselbe Pruefung als Bildschirm.
   *
   * `daysBehind` wird gegen das **Geschaeftsdatum** der Property gerechnet,
   * nicht gegen `current_date`: ein Haus mit Tageswechsel um 04:00 Uhr ist um
   * 02:00 Uhr nicht im Rueckstand, sondern noch im Vortag.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/night-audit-status',
    permission: 'report:operational',
    propertyParam: 'propertyId',
    summary: 'Offener Geschaeftstag, Rueckstand und Schritte der letzten Laeufe',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { days?: string }
      const tage = Math.min(Math.max(Number(q.days) || 14, 1), NACHTLAUF_TAGE_MAX)

      return tx(req.pool, req, async client => {
        const id = Number(propertyId)
        const p = await client.query<{ timezone: string; rollover: string }>(
          `SELECT timezone, rollover_time::text AS rollover FROM property WHERE id = $1`,
          [id])
        if (p.rowCount === 0) throw Errors.notFound('res.property')
        const businessDate = businessDateFor(
          new Date(), p.rows[0]!.timezone, p.rows[0]!.rollover)

        const offen = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date LIMIT 1`, [id])
        const openDate = offen.rows[0]?.date ?? null

        // Ein Aufruf je Bildschirm: die Schrittmarken und die Kennzahlen des
        // Tages kommen als Feld mit, nicht als eine Nachfrage je Zeile.
        const { rows: days } = await client.query(
          `SELECT bd.date::text AS date, bd.status, bd.closed_at AS "closedAt",
                  COALESCE(s.schritte, '[]'::jsonb) AS steps,
                  st.sold, st.arrivals, st.departures,
                  st.room_revenue_cent AS "roomRevenueCent"
             FROM business_day bd
             LEFT JOIN LATERAL (
               SELECT jsonb_agg(jsonb_build_object(
                        'step', n.step, 'completedAt', n.completed_at,
                        'count', (n.detail->>'count')::int)
                      ORDER BY n.completed_at) AS schritte
                 FROM night_audit_step n
                WHERE n.property_id = bd.property_id AND n.business_date = bd.date
             ) s ON true
             LEFT JOIN business_day_stat st
                    ON st.property_id = bd.property_id AND st.date = bd.date
            WHERE bd.property_id = $1
            ORDER BY bd.date DESC
            LIMIT $2`,
          [id, tage])

        return {
          businessDate,
          openDate,
          // Kein offener Tag ist der schwerere Fall: dann laeuft im Haus
          // nichts mehr, was ein Geschaeftsdatum braucht.
          daysBehind: openDate === null ? null : nightsBetween(openDate, businessDate),
          overdue: openDate === null || nightsBetween(openDate, businessDate) > 1,
          expectedSteps: NACHTLAUF_SCHRITTE,
          days
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
        throw Errors.validation({ month: ['field.isoMonth'] })
      }
      const von = `${q.month}-01`

      return tx(req.pool, req, async client => {
        // Eine Meldung aus Uebungsdaten waere eine falsche Meldung an eine
        // Behoerde, nicht bloss eine falsche Zahl im Haus.
        await assertNotTraining(client, Number(propertyId), 'training.what.statistics')

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
          hinweis: hinweisText('hint.statisticsSubmission'),
          hinweisKey: 'hint.statisticsSubmission'
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
   *
   * Anzahlungen kommen aus dem Anzahlungsjournal und nicht aus `charge`: eine
   * Anzahlung ist keine Leistung und erzeugt deshalb keine Position. Ohne
   * diesen zweiten Zugriff stuende ihre Steuer auf dem Beleg und in keinem
   * Buchungsstapel -- und genau sie schuldet das Haus schon mit der
   * Vereinnahmung (§ 13 Abs. 1 Nr. 1a UStG, Aufgabe 3).
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
        // Ein Stapel aus Uebungsdaten landet in der echten Buchhaltung und
        // ist dort schwerer zu entfernen als hier zu verhindern (C11).
        await assertNotTraining(client, id, 'training.what.datev')

        const prop = await client.query<{ name: string }>(
          `SELECT name FROM property WHERE id = $1`, [id])
        if (prop.rowCount === 0) throw Errors.notFound('res.property')

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

        /*
         * Anzahlungen: die Vereinnahmung am Geschaeftstag des
         * Zahlungsvermerks, die Verrechnung am Tag der Schlussrechnung. Der
         * Buchungstag ist damit der Steuerzeitpunkt und nicht der
         * Ausstellungstag der Anzahlungsrechnung -- die kann Wochen frueher
         * geschrieben sein, und im Monat ihrer Ausstellung ist noch nichts
         * geschuldet.
         */
        const anzahlungen = await client.query<{
          kind: string; gross_cent: number; tax_rate_bp: number
          business_date: string; deposit_number: string
          applied_number: string | null; recipient: string }>(
          `SELECT d.kind, d.amount_gross_cent::bigint AS gross_cent, d.tax_rate_bp,
                  d.business_date::text AS business_date,
                  di.number AS deposit_number, fi.number AS applied_number,
                  COALESCE(di.recipient_snapshot->>'name', 'Divers') AS recipient
             FROM deposit_ledger d
             JOIN invoice di ON di.id = d.deposit_invoice_id
             LEFT JOIN invoice fi ON fi.id = d.applied_invoice_id
            WHERE d.property_id = $1
              AND d.business_date BETWEEN $2::date AND $3::date
            ORDER BY d.business_date, d.id`,
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

        /*
         * Erhaltene, versteuerte Anzahlungen (SKR03 1718). Bewusst kein
         * Erloeskonto: bis geleistet wurde, ist eine Anzahlung eine
         * Verbindlichkeit. Auf einem Erloeskonto verfaelschte sie jede
         * Umsatzauswertung und liesse das Haus im Januar reich aussehen,
         * weil im Mai jemand anreist.
         */
        const ANZAHLUNG_KONTO = '1718'

        /** Belegdatum im DATEV-Format: Tag und Monat, ohne Jahr. */
        const belegdatum = (iso: string): string => iso.slice(8, 10) + iso.slice(5, 7)

        /*
         * DATEV kennt keinen negativen Umsatz: die Richtung steht im
         * Soll/Haben-Kennzeichen, der Betrag ist immer positiv. Eine
         * stornierte Kassenposition ist eine negative charge, und ein Minus
         * im Betragsfeld liest der Import als Fehler oder, schlimmer, gar
         * nicht.
         */
        const zeile = (
          betragCent: number, haben: boolean, gegenkonto: string,
          datum: string, belegfeld: string, text: string
        ): { datum: string; felder: Array<string | number> } => ({
          datum,
          felder: [
            (Math.abs(betragCent) / 100).toFixed(2).replace('.', ','),
            (betragCent < 0) !== haben ? 'H' : 'S', 'EUR', '', '', '',
            DEBITOR_SAMMEL, gegenkonto, '', belegdatum(datum), belegfeld, '', '',
            text.slice(0, 60)
          ]
        })

        const gebucht = [
          ...rows.map(r => zeile(
            r.gross_cent, r.kind === 'credit_note', r.revenue_account,
            r.issued_on, r.number,
            `${r.recipient} ${r.tax_rate_bp / 100}%`)),
          /*
           * Die Vereinnahmung bucht auf das Anzahlungskonto, die Verrechnung
           * loest sie wieder auf. Die Verrechnung traegt die Nummer der
           * Schlussrechnung: sie gehoert zu deren Beleg, auf dem sie als
           * Position steht.
           */
          ...anzahlungen.rows.map(a => zeile(
            a.gross_cent, a.kind === 'applied', ANZAHLUNG_KONTO,
            a.business_date,
            a.kind === 'applied' ? (a.applied_number ?? a.deposit_number) : a.deposit_number,
            `${a.recipient} Anzahlung ${a.deposit_number} ${a.tax_rate_bp / 100}%`))
        ]

        // Der Stapel laeuft chronologisch, sonst stuenden die Anzahlungen
        // als Block hinter den Rechnungen. Sortiert wird nach dem
        // vollstaendigen Datum: das Belegfeld traegt nur Tag und Monat.
        const zeilen = gebucht
          .sort((a, b) => a.datum.localeCompare(b.datum))
          .map(z => z.felder)

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
        await assertNotTraining(client, id, 'training.what.gobd')

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

  /**
   * Gaesteverzeichnis: der Nachweis fuer den Gaestebeitrag.
   *
   * **Warum das ein eigener Export ist und nicht ein Bericht.** Kommunale
   * Satzungen verlangen ihn als Nachweis, nicht als Auskunft: die Stadt
   * Cuxhaven etwa "tagaktuell und kontrollfaehig", quartalsweise
   * uebermittelt und sechs Jahre aufbewahrt, mit Geldbusse bis 10 000 Euro
   * bei Verstoss (§ 9 Abs. 5 und § 12 ihrer Gaestebeitragssatzung).
   *
   * **Warum eine Liste und kein Anbieterformat.** Die Meldung an die
   * Gemeinde laeuft in Deutschland ueber verschiedene Wege -- AVS und
   * feratel decken zusammen einige hundert Orte ab, daneben gibt es
   * Gemeindeportale und Vordrucke. Ihre Schnittstellenbeschreibungen sind
   * nicht oeffentlich; wer ohne sie ein Format nachbaut, baut eine
   * Vermutung. Was dagegen ueberall gleich ist, ist der **Inhalt**: wer,
   * woher, wie lange, wie viele Naechte, welcher Satz, welcher Betrag. Das
   * liefert dieser Endpunkt -- als Liste, die jede Gemeinde annimmt, und
   * als Grundlage, auf der ein Anbieteradapter spaeter aufsetzt, statt die
   * Abfrage ein zweites Mal zu schreiben.
   *
   * **Eine Zeile je Aufenthalt und Abgabenart**, nicht je Nacht: die Satzung
   * fragt nach dem Beitragsschuldner und seinem Aufenthalt. Zwei Abgaben
   * nebeneinander -- Kurtaxe und Bettensteuer -- sind zwei Satzungen und
   * deshalb zwei Zeilen.
   *
   * **Was hier bewusst fehlt: die Gaestekartennummer.** Die vergibt das
   * System der Gemeinde, nicht das Haus. Sie hier zu erfinden hiesse, eine
   * Nummer in einen Nachweis zu schreiben, die nirgends sonst existiert.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/exports/guest-levy',
    permission: 'report:export',
    propertyParam: 'propertyId',
    summary: 'Gaesteverzeichnis fuer die Gaestebeitragsabrechnung',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string; format?: string }
      checkRange(q.from, q.to)
      const id = Number(propertyId)

      return tx(req.pool, req, async client => {
        // Ein Nachweis aus Uebungsdaten geht an eine Behoerde. Derselbe
        // Grund wie bei DATEV und der Beherbergungsstatistik (C11).
        await assertNotTraining(client, id, 'training.what.guestLevy')

        /*
         * Gerechnet wird aus den gebuchten Positionen, nicht aus der Regel.
         *
         * Der Unterschied ist der zwischen Zaehler und Aufzeichnung
         * (CLAUDE.md): die Regel sagt, was heute gelten wuerde; die Position
         * sagt, was damals berechnet wurde. Ein Satz, der zum Jahreswechsel
         * gestiegen ist, macht aus einer Neuberechnung eine plausibel
         * aussehende falsche Zahl -- und der Nachweis muss zur Rechnung
         * passen, die der Gast bekommen hat.
         *
         * Gegenbuchungen zaehlen mit ihrem Vorzeichen mit; eine stornierte
         * Abgabe verschwindet damit aus der Summe, ohne dass eine Zeile
         * verschwindet.
         */
        const { rows } = await client.query<{
          reservationRef: string; lastName: string | null; firstName: string | null
          street: string | null; postalCode: string | null; city: string | null
          country: string | null; arrival: string; departure: string
          levyCode: string; levyName: string; nights: number; persons: number
          amountCent: string; businessTrip: boolean; exemptChildren: number }>(
          `SELECT r.public_ref                        AS "reservationRef",
                  g.last_name                         AS "lastName",
                  g.first_name                        AS "firstName",
                  g.address_line1                     AS "street",
                  g.postal_code                       AS "postalCode",
                  g.city                              AS "city",
                  g.country                           AS "country",
                  r.arrival::text                     AS "arrival",
                  r.departure::text                   AS "departure",
                  t.code                              AS "levyCode",
                  t.name                              AS "levyName",
                  count(DISTINCT c.business_date)::int AS "nights",
                  COALESCE(max(c.quantity), 0)::int   AS "persons",
                  sum(c.gross_cent)::text             AS "amountCent",
                  r.business_trip                     AS "businessTrip",
                  (SELECT count(*) FROM reservation_occupant o
                    WHERE o.reservation_id = r.id
                      AND t.exempt_below_age IS NOT NULL
                      AND o.age_at_arrival IS NOT NULL
                      AND o.age_at_arrival < t.exempt_below_age)::int AS "exemptChildren"
             FROM charge c
             JOIN tax_rule t    ON t.id = c.tax_rule_id
             JOIN reservation r ON r.id = c.reservation_id
             LEFT JOIN guest g  ON g.id = r.primary_guest_id
            WHERE c.property_id = $1
              AND t.kind IN ('city_tax','bed_tax')
              AND c.business_date BETWEEN $2::date AND $3::date
            GROUP BY r.id, r.public_ref, g.last_name, g.first_name, g.address_line1,
                     g.postal_code, g.city, g.country, r.arrival, r.departure,
                     -- Die Regel-id und die Altersgrenze gehoeren mit hinein: die
                     -- Unterabfrage nach den befreiten Kindern greift auf sie
                     -- zu, und PostgreSQL erkennt die Abhaengigkeit dort
                     -- nicht von selbst.
                     t.id, t.code, t.name, t.exempt_below_age, r.business_trip
           HAVING sum(c.gross_cent) <> 0
            ORDER BY r.arrival, r.public_ref, t.code`,
          [id, q.from, q.to])

        const summe = rows.reduce((s, r) => s + Number(r.amountCent), 0)
        const naechte = rows.reduce((s, r) => s + r.nights, 0)

        if (q.format !== 'csv') {
          return {
            from: q.from, to: q.to,
            rows,
            totals: { rows: rows.length, nights: naechte, amountCent: summe },
            hinweis: 'Eine Zeile je Aufenthalt und Abgabenart. Betraege in Cent, '
                   + 'aus den gebuchten Positionen und nicht aus der heute '
                   + 'geltenden Regel gerechnet. Die Gaestekartennummer vergibt '
                   + 'das System der Gemeinde und steht deshalb nicht darin.'
          }
        }

        // Deutsche Ueberschriften, Semikolon, Komma als Dezimaltrenner: der
        // Empfaenger ist eine Gemeindeverwaltung mit einer deutschen
        // Tabellenkalkulation, kein Programm.
        const euro = (cent: number): string => (cent / 100).toFixed(2).replace('.', ',')
        const kopf = ['Nachname', 'Vorname', 'Strasse', 'PLZ', 'Ort', 'Land',
                      'Anreise', 'Abreise', 'Uebernachtungen', 'Personen',
                      'Abgabe', 'Betrag EUR', 'Geschaeftsreise', 'Kinder frei',
                      'Referenz']
        const zeilen = rows.map(r => [
          r.lastName, r.firstName, r.street, r.postalCode, r.city, r.country,
          r.arrival, r.departure, r.nights, r.persons,
          r.levyName, euro(Number(r.amountCent)),
          r.businessTrip ? 'ja' : 'nein', r.exemptChildren, r.reservationRef
        ])
        const fuss = ['Summe', null, null, null, null, null, null, null,
                      naechte, null, null, euro(summe), null, null, null]

        reply.header('content-type', 'text/csv; charset=utf-8')
        reply.header('content-disposition',
          `attachment; filename="gaesteverzeichnis-${q.from}-${q.to}.csv"`)
        return csv([kopf, ...zeilen, fuss])
      })
    }
  })

  /**
   * Mandantenexport für einen ausscheidenden Betrieb (E7, Dokument 13).
   *
   * **Warum das zum Produkt gehört und nicht zur Kulanz.** Ein Betrieb, der
   * kündigt, muss seine Daten mitnehmen können. Das ist erstens Art. 20
   * DSGVO für die personenbezogenen Teile, zweitens die steuerliche
   * Aufbewahrungspflicht, die beim Betrieb bleibt und nicht bei uns, und
   * drittens schlicht Anstand: ein Anbieter, der Daten als Geisel hält, wird
   * genau einmal empfohlen.
   *
   * Der Export ist deshalb **vollständig und offen**: alles, was zu dieser
   * Property gehört, in JSON, ohne dieses System lesbar. Keine Auswahl, kein
   * Format, das nur wir lesen können.
   *
   * Ausgenommen ist nur, was nicht zu ihr gehört: die Schlüsselversion der
   * Ausweisnummern wird mitgegeben, die Chiffrate nicht. Sie ohne den
   * Schlüssel zu exportieren wäre nutzlos, mit dem Schlüssel wäre es eine
   * Weitergabe des Schlüssels.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/exports/tenant',
    // Bewusst die Einstellungsberechtigung des Accounts, nicht die des
    // Hauses: wer das ganze Haus exportiert, beendet in der Regel den
    // Vertrag, und das ist keine Entscheidung der Rezeption.
    permission: 'settings:account',
    propertyParam: 'propertyId',
    summary: 'Vollstaendiger Mandantenexport einer Property',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const id = Number(propertyId)

      return tx(req.pool, req, async client => {
        const p = await client.query(
          `SELECT id, public_ref, code, name, timezone, currency, rollover_time::text,
                  checkin_time::text, checkout_time::text, address_line1, postal_code,
                  city, country, tax_number, vat_id, municipality_key, is_training,
                  status, created_at::text
             FROM property WHERE id = $1`, [id])
        if (p.rowCount === 0) throw Errors.notFound('res.property')

        // Je Tabelle eine Abfrage. Der Export ist selten und darf gruendlich
        // sein; er laeuft einmal je Vertragsende, nicht je Bildschirm.
        const hole = async (name: string, sql: string): Promise<[string, unknown[]]> =>
          [name, (await client.query(sql, [id])).rows]

        const teile = await Promise.all([
          hole('categories', `SELECT * FROM resource_category WHERE property_id = $1
                               ORDER BY id`),
          hole('rooms', `SELECT * FROM resource WHERE property_id = $1 ORDER BY id`),
          hole('maintenanceBlocks', `SELECT * FROM maintenance_block WHERE property_id = $1
                                      ORDER BY id`),
          hole('ratePlans', `SELECT * FROM rate_plan WHERE property_id = $1 ORDER BY id`),
          hole('rateDays', `SELECT * FROM rate_day WHERE property_id = $1
                             ORDER BY rate_plan_id, date`),
          hole('restrictions', `SELECT * FROM restriction_day WHERE property_id = $1
                                 ORDER BY rate_plan_id, date`),
          hole('taxRules', `SELECT * FROM tax_rule WHERE property_id = $1 ORDER BY id`),
          hole('cancellationPolicies', `SELECT * FROM cancellation_policy
                                         WHERE property_id = $1 ORDER BY id`),
          hole('products', `SELECT * FROM product WHERE property_id = $1 ORDER BY id`),
          hole('paymentMethods', `SELECT * FROM payment_method WHERE property_id = $1
                                   ORDER BY id`),
          hole('bookings', `SELECT * FROM booking WHERE property_id = $1 ORDER BY id`),
          hole('reservations', `SELECT * FROM reservation WHERE property_id = $1
                                 ORDER BY id`),
          hole('reservationNights', `SELECT * FROM reservation_night WHERE property_id = $1
                                      ORDER BY reservation_id, date`),
          hole('occupants', `SELECT * FROM reservation_occupant WHERE property_id = $1
                              ORDER BY id`),
          hole('availabilityBlocks', `SELECT * FROM availability_block WHERE property_id = $1
                                       ORDER BY id`),
          hole('folios', `SELECT * FROM folio WHERE property_id = $1 ORDER BY id`),
          hole('charges', `SELECT * FROM charge WHERE property_id = $1 ORDER BY id`),
          hole('settlements', `SELECT * FROM settlement WHERE property_id = $1 ORDER BY id`),
          hole('invoices', `SELECT * FROM invoice WHERE property_id = $1 ORDER BY id`),
          hole('invoiceCounters', `SELECT * FROM invoice_counter WHERE property_id = $1
                                    ORDER BY year`),
          hole('businessDays', `SELECT * FROM business_day WHERE property_id = $1
                                 ORDER BY date`),
          hole('dayStatistics', `SELECT * FROM business_day_stat WHERE property_id = $1
                                  ORDER BY date`),
          hole('housekeepingStatus', `SELECT * FROM housekeeping_status
                                       WHERE property_id = $1 ORDER BY resource_id`),
          hole('maintenanceTickets', `SELECT * FROM maintenance_ticket WHERE property_id = $1
                                       ORDER BY id`),
          hole('guestNotes', `SELECT * FROM guest_property_note WHERE property_id = $1
                               ORDER BY id`),
          // Gaeste haengen am Account, nicht am Haus (Entscheidung 13).
          // Mitgegeben werden die, die hier tatsaechlich waren.
          hole('guests', `SELECT g.id, g.public_ref, g.last_name, g.first_name, g.email,
                                 g.phone, g.birth_date, g.nationality, g.language,
                                 g.address_line1, g.postal_code, g.city, g.country,
                                 g.id_document_type, g.id_document_key_version,
                                 g.preferences, g.status, g.created_at
                            FROM guest g
                           WHERE EXISTS (SELECT 1 FROM reservation r
                                          WHERE r.property_id = $1
                                            AND r.primary_guest_id = g.id)
                           ORDER BY g.id`)
        ])

        const daten = Object.fromEntries(teile)
        const zeilen = Object.entries(daten)
          .map(([k, v]) => [k, (v as unknown[]).length] as const)

        return {
          exportedAt: new Date().toISOString(),
          property: p.rows[0],
          ...daten,
          zeilenzahl: Object.fromEntries(zeilen),
          hinweise: [
            'Alle Betraege in Cent als ganze Zahl. Steuersaetze in Basispunkten, '
            + '700 entspricht 7 Prozent.',
            'Aufenthaltsdaten sind Kalenderdaten in der Zeitzone der Property, '
            + 'keine Zeitpunkte.',
            'Ausweisnummern sind nicht enthalten. Sie liegen verschluesselt vor; '
            + 'sie ohne den Schluessel zu exportieren waere nutzlos, mit dem '
            + 'Schluessel waere es eine Weitergabe des Schluessels. Die '
            + 'Schluesselversion ist als id_document_key_version vermerkt.',
            'Meldescheine sind nicht enthalten: sie unterliegen der Jahresfrist '
            + 'nach § 30 BMG und werden vernichtet, nicht weitergegeben.',
            'Die steuerliche Aufbewahrungspflicht fuer Buchungsbelege liegt beim '
            + 'Betrieb und betraegt acht Jahre.'
          ]
        }
      })
    }
  })
}