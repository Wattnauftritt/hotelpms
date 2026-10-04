import type { FastifyInstance, FastifyRequest } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import { nightsBetween, isIsoDate, paymentState, type PaymentState } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'

const MAX_AVAILABILITY_DAYS = 731   // P6, Dokument 12
const MAX_TAPE_CHART_DAYS = 92

/** Was der Balken ueber das Geld einer Reservierung sagt. */
interface PlanPayment {
  state: PaymentState
  charged_cent: number
  settled_cent: number
  balance_cent: number
  expected_cent: number
  unposted_nights: number
  deposit_cent: number
  requested_cent: number
  routed: boolean
  /** Nur bei einer Buchung mit mehreren Zimmern: dieselbe Rechnung ueber alle. */
  group: { state: PaymentState; rooms: number; expected_cent: number
           settled_cent: number; balance_cent: number } | null
}

interface Summen {
  reservation_id: number; booking_id: number
  charged: number; settled: number; deposit: number; requested: number
  unposted: number; unposted_nights: number; routed: boolean
}

/**
 * Der Zahlungsstand aller Reservierungen im Plan, in **einer** Anweisung.
 *
 * **Je Reservierung, ueber ihr eigenes Folio.** Jede Reservierung bekommt
 * beim Buchen ihr Folio (`folio.reservation_id`), auch jedes Zimmer einer
 * Gruppe; ein Sammelkonto fuer die Gruppe gibt es im Datenmodell nicht
 * (`folio.kind = 'group'` legt keine Route an). Abgerechnet und
 * ausgecheckt wird je Folio -- "bezahlt" am Balken muss deshalb heissen,
 * dass **dieses** Folio gedeckt ist. Zahlt der Bucher fuer alle auf sein
 * eigenes Zimmer, steht sein Balken auf bezahlt und die uebrigen auf offen;
 * genau das stuende auch auf ihren Rechnungen. Damit das nicht wie ein
 * Fehler aussieht, kommt bei einer Gruppe die Rechnung ueber alle Zimmer
 * daneben (`group`), fuer den Titel.
 *
 * **Die Gruppe ganz, nicht nur der sichtbare Ausschnitt.** Zimmer einer
 * Buchung duerfen eigene Tage haben und liegen dann womoeglich ausserhalb
 * des Zeitraums. Aus den sichtbaren Balken summiert ergaebe das eine
 * plausibel aussehende falsche Gruppensumme. Gelesen werden deshalb alle
 * Reservierungen der beteiligten Buchungen, auch abgereiste und
 * stornierte: deren Folio traegt womoeglich eine Gebuehr oder eine
 * Zahlung, die zur Gruppe gehoert.
 *
 * **Umleitung.** Eine Regel, die die Logis auf ein anderes Konto lenkt
 * (`routing_rule`, wie der Nachtlauf sie liest), nimmt die noch nicht
 * gebuchten Naechte aus der Erwartung: geschuldet werden sie dann
 * woanders. Was schon gebucht ist, steht ohnehin auf dem Zielkonto.
 *
 * **Verbund statt Schleife.** Jede Summe ist eine gruppierte Unterabfrage
 * im Verbund, keine korrelierte je Zeile -- bei 250 Zimmern und 92 Tagen
 * sind das einige tausend Reservierungen.
 */
async function planPayments(
  client: PoolClient, propertyId: number,
  imPlan: ReadonlyArray<{ id: number; booking_id: number }>
): Promise<Map<number, PlanPayment>> {
  const out = new Map<number, PlanPayment>()
  if (imPlan.length === 0) return out

  const { rows } = await client.query<Summen>(
    `WITH buchung AS (
       SELECT r.id, r.booking_id, r.status
         FROM reservation r
        WHERE r.property_id = $1
          AND r.booking_id = ANY($2::bigint[])
     ), konto AS (
       SELECT f.id AS folio_id, f.reservation_id
         FROM folio f JOIN buchung b ON b.id = f.reservation_id
     ), gebucht AS (
       SELECT k.reservation_id, sum(c.gross_cent)::bigint AS cent
         FROM charge c JOIN konto k ON k.folio_id = c.folio_id
        GROUP BY k.reservation_id
     ), gezahlt AS (
       SELECT k.reservation_id, sum(s.amount_cent)::bigint AS cent
         FROM settlement s JOIN konto k ON k.folio_id = s.folio_id
        GROUP BY k.reservation_id
     ), angezahlt AS (
       -- Nur die Vereinnahmung: eine Verrechnung in der Schlussrechnung
       -- aendert nichts daran, dass das Geld da ist.
       SELECT k.reservation_id, sum(d.amount_gross_cent)::bigint AS cent
         FROM deposit_ledger d JOIN konto k ON k.folio_id = d.folio_id
        WHERE d.kind = 'received'
        GROUP BY k.reservation_id
     ), angefordert AS (
       SELECT a.reservation_id, sum(a.cent)::bigint AS cent FROM (
         -- Seit 0068 bekommt der Gast einen Link von uns, der bis zur Frist
         -- gilt; der Checkout beim Anbieter entsteht erst beim Oeffnen.
         -- Angefordert ist also, was ein gueltiger, nicht widerrufener und
         -- noch nicht bezahlter Link verlangt -- gegen den Geschaeftstag,
         -- wie die Frist des Links selbst.
         SELECT k.reservation_id, l.amount_cent AS cent
           FROM payment_link l JOIN konto k ON k.folio_id = l.folio_id
           -- Bezahlte Links als Verbund gegen eine gruppierte Menge, nicht
           -- als Unterabfrage je Link.
           LEFT JOIN (SELECT DISTINCT payment_link_id FROM payment_intent
                       WHERE property_id = $1 AND status = 'succeeded'
                         AND payment_link_id IS NOT NULL) bz
                  ON bz.payment_link_id = l.id
          WHERE l.revoked_at IS NULL AND bz.payment_link_id IS NULL
            AND l.valid_until >= COALESCE(
                  (SELECT max(d.date) FROM business_day d
                    WHERE d.property_id = $1 AND d.status = 'open'), current_date)
         UNION ALL
         -- Checkouts von vor 0068, ohne Link von uns. payment_intent traegt
         -- keine Zeilenrichtlinie (0021); die Property wird deshalb von Hand
         -- mitgefiltert. Ein abgelaufener fordert nichts mehr an: Stripe
         -- haelt einen Checkout hoechstens 24 Stunden.
         SELECT k.reservation_id, p.amount_cent
           FROM payment_intent p JOIN konto k ON k.folio_id = p.folio_id
          WHERE p.status = 'pending' AND p.property_id = $1
            AND p.payment_link_id IS NULL
            AND (p.expires_at IS NULL OR p.expires_at > now())
       ) a
        GROUP BY a.reservation_id
     ), umgeleitet AS (
       SELECT DISTINCT x.reservation_id
         FROM routing_rule x JOIN buchung b ON b.id = x.reservation_id
        WHERE x.match_kind IN ('all', 'accommodation')
     ), ausstehend AS (
       -- Nur Reservierungen, die noch Bestand halten: eine stornierte
       -- schuldet ihre Naechte nicht, sondern hoechstens eine Gebuehr, und
       -- die steht dann als Position da.
       SELECT n.reservation_id, sum(n.price_cent)::bigint AS cent,
              count(*)::int AS naechte
         FROM reservation_night n JOIN buchung b ON b.id = n.reservation_id
        WHERE NOT n.posted AND b.status IN ('Optional','Confirmed','InHouse')
        GROUP BY n.reservation_id
     )
     SELECT b.id AS reservation_id, b.booking_id,
            COALESCE(g.cent, 0) AS charged, COALESCE(z.cent, 0) AS settled,
            COALESCE(a.cent, 0) AS deposit, COALESCE(f.cent, 0) AS requested,
            CASE WHEN u.reservation_id IS NULL THEN COALESCE(n.cent, 0) ELSE 0 END
              AS unposted,
            CASE WHEN u.reservation_id IS NULL THEN COALESCE(n.naechte, 0) ELSE 0 END
              AS unposted_nights,
            u.reservation_id IS NOT NULL AS routed
       FROM buchung b
       LEFT JOIN gebucht g ON g.reservation_id = b.id
       LEFT JOIN gezahlt z ON z.reservation_id = b.id
       LEFT JOIN angezahlt a ON a.reservation_id = b.id
       LEFT JOIN angefordert f ON f.reservation_id = b.id
       LEFT JOIN umgeleitet u ON u.reservation_id = b.id
       LEFT JOIN ausstehend n ON n.reservation_id = b.id`,
    // Die Buchungsnummern aus der Abfrage davor, nicht deren Reservierungen
    // noch einmal nachgeschlagen: gemessen am Saatlaufhaus kostete der
    // Umweg ueber die Reservierung rund ein Drittel dieser Anweisung.
    [propertyId, [...new Set(imPlan.map(r => r.booking_id))]])

  /*
   * Die Summen sind auf `bigint` gecastet, weil `sum()` sonst `numeric`
   * liefert und `numeric` als Zeichenkette ankommt -- `"100" + 50` ergaebe
   * dann `"10050"`. `bigint` wandelt der Pool in eine Zahl um
   * (`packages/db/src/pool.ts`).
   */
  const jeBuchung = new Map<number, Summen[]>()
  for (const r of rows) {
    const liste = jeBuchung.get(r.booking_id) ?? []
    liste.push(r)
    jeBuchung.set(r.booking_id, liste)
  }

  const sichtbar = new Set(imPlan.map(r => r.id))
  for (const liste of jeBuchung.values()) {
    const summe = (f: (r: Summen) => number): number =>
      liste.reduce((s, r) => s + f(r), 0)
    const gruppe = liste.length > 1
      ? paymentState({ chargedCent: summe(r => r.charged), settledCent: summe(r => r.settled),
                       unpostedCent: summe(r => r.unposted),
                       requestedCent: summe(r => r.requested) })
      : null
    for (const r of liste) {
      if (!sichtbar.has(r.reservation_id)) continue
      const s = paymentState({ chargedCent: r.charged, settledCent: r.settled,
                               unpostedCent: r.unposted, requestedCent: r.requested })
      out.set(r.reservation_id, {
        state: s.state,
        charged_cent: s.chargedCent,
        settled_cent: s.settledCent,
        balance_cent: s.balanceCent,
        expected_cent: s.expectedCent,
        unposted_nights: r.unposted_nights,
        deposit_cent: r.deposit,
        requested_cent: s.requestedCent,
        routed: r.routed,
        group: gruppe === null ? null : {
          state: gruppe.state, rooms: liste.length,
          expected_cent: gruppe.expectedCent, settled_cent: gruppe.settledCent,
          balance_cent: gruppe.balanceCent }
      })
    }
  }
  return out
}

function range(req: FastifyRequest, max: number): { from: string; to: string } {
  const q = req.query as { from?: string; to?: string }
  if (!q.from || !q.to || !isIsoDate(q.from) || !isIsoDate(q.to)) {
    throw Errors.validation({ from: ['field.isoDate'] })
  }
  const days = nightsBetween(q.from, q.to)
  if (days <= 0) throw Errors.validation({ to: ['field.afterFrom'] })
  if (days > max) throw Errors.rangeTooLarge(max)
  return { from: q.from, to: q.to }
}

export function availabilityRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/availability',
    permission: 'reservation:read',
    propertyParam: 'propertyId',
    summary: 'Verfuegbarkeit je Kategorie und Tag',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { from, to } = range(req, MAX_AVAILABILITY_DAYS)
      // Eine Abfrage, unabhaengig von der Zahl der Reservierungen.
      const rows = await tx(req.pool, req, client => client.query(
        // `category_code` im selben Verbund: ein fremdes System ordnet nach
        // dem Kuerzel zu, und eine zweite Runde nur fuer die Zuordnung
        // braeuchte es sonst bei jedem Abgleich.
        `SELECT i.category_id, c.code AS category_code, i.date::text,
                i.capacity, i.sold, i.blocked, i.overbooking,
                i.capacity - i.sold - i.blocked + i.overbooking AS available
           FROM inventory_day i
           JOIN resource_category c ON c.id = i.category_id
          WHERE i.property_id = $1 AND i.date >= $2::date AND i.date < $3::date
          ORDER BY i.category_id, i.date`,
        [Number(propertyId), from, to]))
      return { days: rows.rows }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/tape-chart',
    permission: 'reservation:read',
    propertyParam: 'propertyId',
    summary: 'Zimmerplan fuer einen Bildschirm',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { from, to } = range(req, MAX_TAPE_CHART_DAYS)
      const pid = Number(propertyId)
      const principal = req.principal as Principal
      /*
       * Zwei Teile des Plans haengen an einem weiteren Recht, und ohne es
       * **fehlen die Felder**, statt den ganzen Plan mit 403 abzuweisen.
       *
       * Der Zahlungsstand an `folio:read`: wer Belegung sieht, sieht damit
       * noch keine Betraege. Die Rolle "Reservierung" bucht und verschiebt,
       * Konten fuehrt sie nicht -- und Revenue sieht den Plan fuer die
       * Auslastung, nicht fuer die Rechnung einzelner Gaeste.
       *
       * Der Reinigungsstand an `housekeeping:read`, aus demselben Grund in
       * die andere Richtung: er ist kein Geheimnis, aber ein Recht ist ein
       * Recht, und eine zweite Tuer zu denselben Daten macht den
       * Rechtekatalog zur Behauptung.
       */
      const mitZahlung = can(principal, 'folio:read', pid)
      const mitReinigung = can(principal, 'housekeeping:read', pid)
      /*
       * Die Hausnotizen zum Gast an `guest:read`, wie im Gastprofil. Sie
       * stehen im Titel des Balkens, weil dort gefragt wird: wer am Plan
       * ein Zimmer zuweist, soll "ebenerdig" lesen, bevor er das Zimmer im
       * zweiten Stock nimmt, nicht erst im Profil.
       */
      const mitGastnotiz = can(principal, 'guest:read', pid)

      // Drei Abfragen, mit Zahlungsrecht vier -- unabhaengig von Haus- und
      // Belegungsgroesse. Ein Aggregat-Endpunkt statt 400 Einzelaufrufen.
      return tx(req.pool, req, async client => {
        const units = await client.query(
          // `max_occupancy` traegt die Warnung beim Verschieben: wer eine
          // Buchung fuer zwei Personen in ein Zimmer fuer eine zieht, soll
          // das vorher lesen. Ohne die Zahl koennte die Oberflaeche nur
          // "andere Zimmergruppe" sagen und nicht, in welche Richtung.
          //
          // Der Reinigungsstand im selben Verbund, nicht als eigene Runde:
          // eine Zeile je Zimmer, ueber den Primaerschluessel. Fehlt sie,
          // gilt "sauber" -- wie auf dem Housekeeping-Bildschirm, sonst
          // zeigten zwei Bildschirme fuer dasselbe Zimmer zweierlei.
          `SELECT r.id, r.code, r.floor, r.category_id, c.name AS category_name,
                  c.code AS category_code, c.max_occupancy, c.sort_order
                  ${mitReinigung ? `, COALESCE(h.status, 'clean') AS housekeeping` : ''}
             FROM resource r
             JOIN resource_category c ON c.id = r.category_id
             ${mitReinigung ? 'LEFT JOIN housekeeping_status h ON h.resource_id = r.id' : ''}
            WHERE r.property_id = $1 AND r.active
            ORDER BY c.sort_order, r.code`, [pid])

        const reservations = await client.query(
          `SELECT r.id, r.booking_id, r.public_ref, r.resource_id, r.category_id,
                  r.arrival::text, r.departure::text, r.status,
                  g.last_name, g.first_name,
                  -- Zwei Notizen, zwei Aufgaben. short_note ist das Merkmal
                  -- fuer den Balken (Balkon, 1. Stock, Spaetanreise) und
                  -- steht dort im Klartext: eine Notiz, die man erst nach
                  -- zwei Klicks sieht, wird nicht geschrieben.
                  --
                  -- notes ist der Vorgang. Der Balken ist bei einer Nacht
                  -- 44 Pixel breit; dort die ersten Zeichen eines Absatzes
                  -- zu zeigen hiesse, "Gast hat angerufen weg..." zu zeigen
                  -- und damit nichts. Deshalb nur im Titel und im
                  -- Seitenfenster.
                  --
                  -- Keine Backticks in diesem Kommentar: er steht **in**
                  -- einem Template-Literal, und ein Backtick beendet es.
                  r.short_note,
                  r.notes,
                  -- Die Buchungsreferenz traegt die Gruppe in den Plan.
                  -- Ohne sie sieht die Oberflaeche acht einzelne Balken und
                  -- kann nicht anbieten, sie gemeinsam zu verschieben --
                  -- genau das, was die Rezeption meint, wenn sie sagt, die
                  -- Gruppe komme einen Tag spaeter.
                  b.public_ref AS booking_ref,
                  -- Wie viele Zimmer in derselben Buchung liegen. Eine
                  -- Zahl statt einer Liste: die Oberflaeche braucht nur zu
                  -- wissen, ob es eine Gruppe ist -- welche Zimmer, steht
                  -- in denselben Daten, und die Maske holt den Rest.
                  (SELECT count(*) FROM reservation gr
                    WHERE gr.booking_id = r.booking_id) AS booking_rooms,
                  b.source, b.external_reference,
                  rp.code AS rate_code,
                  (SELECT count(*) FROM reservation_occupant o
                    WHERE o.reservation_id = r.id) AS occupants,
                  -- Die Personenzahl allein taugt als Mass nicht: eine
                  -- Buchung aus dem Channel traegt genau einen Belegten,
                  -- den Bucher, auch wenn zwei anreisen. Was feststeht, ist
                  -- das verkaufte Produkt -- ein Doppelzimmer bleibt fuer
                  -- zwei verkauft, auch wenn der zweite Name noch fehlt.
                  rc.max_occupancy AS category_max_occupancy
                  -- Der Preis der Naechte, wie bei der Buchung eingefroren,
                  -- am selben Recht wie der Zahlungsstand: wer Belegung
                  -- sieht, sieht damit noch keine Betraege. Min und Max
                  -- statt eines Durchschnitts: 89 und 119 am Wochenende
                  -- gemittelt ergaebe einen Preis, den es nie gab.
                  ${mitZahlung ? `, COALESCE(nt.nights, 0) AS nights,
                  COALESCE(nt.stay_cent, 0) AS stay_price_cent,
                  COALESCE(nt.min_cent, 0) AS night_price_min_cent,
                  COALESCE(nt.max_cent, 0) AS night_price_max_cent` : ''}
                  ${mitGastnotiz ? ', COALESCE(gn.notes, ARRAY[]::text[]) AS guest_notes' : ''}
             FROM reservation r
             JOIN booking b ON b.id = r.booking_id
             JOIN resource_category rc ON rc.id = r.category_id
             LEFT JOIN guest g ON g.id = r.primary_guest_id
             LEFT JOIN rate_plan rp ON rp.id = r.rate_plan_id
             -- Verbund gegen eine gruppierte Menge, nicht je Zeile: nur die
             -- Naechte der Reservierungen, die im Fenster liegen.
             ${mitZahlung ? `LEFT JOIN (
               SELECT n.reservation_id, count(*)::int AS nights,
                      sum(n.price_cent)::int AS stay_cent,
                      min(n.price_cent)::int AS min_cent,
                      max(n.price_cent)::int AS max_cent
                 FROM reservation_night n
                 JOIN reservation x ON x.id = n.reservation_id
                WHERE x.property_id = $1
                  AND x.arrival < $3::date AND x.departure > $2::date
                GROUP BY n.reservation_id
             ) nt ON nt.reservation_id = r.id` : ''}
             ${mitGastnotiz ? `LEFT JOIN (
               SELECT gpn.guest_id,
                      array_agg(gpn.note ORDER BY gpn.created_at, gpn.id) AS notes
                 FROM guest_property_note gpn
                WHERE gpn.property_id = $1
                GROUP BY gpn.guest_id
             ) gn ON gn.guest_id = r.primary_guest_id` : ''}
            WHERE r.property_id = $1
              AND r.arrival < $3::date AND r.departure > $2::date
              AND r.status IN ('Optional','Confirmed','InHouse')`, [pid, from, to])

        const blocks = await client.query(
          /*
           * `::text` ist hier nicht Geschmackssache. Eine `date`-Spalte kommt
           * ohne den Cast als `Date` zurueck und wird als voller Zeitstempel
           * serialisiert; die Oberflaeche rechnet damit `NaN` und setzt jeden
           * Balken auf `left: NaN`. Der Zimmerplan zeigte dann kein einziges
           * belegtes Zimmer, ohne dass irgendwo ein Fehler auftrat. Und ein
           * Zeitstempel verschiebt das Kalenderdatum je nach Zeitzone um
           * einen Tag (CLAUDE.md, "Geld und Datum").
           */
          `SELECT resource_id, from_date::text, to_date::text, kind, reason
             FROM maintenance_block
            WHERE property_id = $1 AND from_date < $3::date AND to_date > $2::date`,
          [pid, from, to])

        const zeilen = reservations.rows as Array<{ id: number; booking_id: number }>
        const zahlung = mitZahlung ? await planPayments(client, pid, zeilen) : null
        return {
          from, to, units: units.rows, blocks: blocks.rows,
          // `booking_id` traegt nur die Zahlungsabfrage; nach aussen geht
          // die Buchung als `booking_ref`, wie bisher.
          reservations: zeilen.map(({ booking_id: _b, ...r }) => zahlung === null ? r
            : { ...r, payment: zahlung.get(r.id) ?? null })
        }
      })
    }
  })
}
