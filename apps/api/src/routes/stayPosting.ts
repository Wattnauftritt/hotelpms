import type { FastifyInstance } from 'fastify'
import { postNights } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { geschaeftstag, rechtImHaus } from './depositRequests.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Aufenthalt beim Check-in vorab buchen (Sven, 15.10.2026, Migration 0176).
 *
 * Viele Geschaeftsreisende zahlen beim Check-in voll und wollen die Rechnung
 * sofort. Die Rechnung entsteht aus dem Folio, und die Logis bucht der
 * Nachtlauf Nacht fuer Nacht -- am Anreisetag steht dort nichts. Sven: "normal
 * bucht der nachtlauf und wenn gäste beim checkin sofort eine rechnung wollen
 * drücken wir unseren neuen button".
 *
 * **Warum nicht immer.** Solange eine Nacht nicht gebucht ist, ist sie ein
 * Preis an der Reservierung, und Verlaengern, Kuerzen oder Umziehen aendern
 * ihn einfach mit. Eine gebuchte Nacht ist ein Beleg (Haertegrad 1); steht
 * sie auf einer Rechnung, wird aus jeder Aenderung Storno und neue Rechnung.
 * Bei Anlage der Reservierung zu buchen, wie manche Systeme es tun, hiesse
 * ausserdem, jede Stornierung als Paar aus Buchung und Gegenbuchung im
 * Folio stehen zu lassen.
 *
 * **Was gebucht wird.** Dasselbe wie im Nachtlauf, ueber dieselbe Stelle:
 * Logis, Fruehstueck und Inklusivleistungen (`postNights`, domain), dann
 * die Kurtaxe (`post_city_tax`). Jede Nacht mit ihrem eigenen Tag; der
 * Nachtlauf findet sie gebucht und laesst sie aus. Die Kurtaxe steht auf
 * keiner Rechnung (0157), aber im Saldo -- ohne sie haette der Gast, der beim
 * Check-in alles bezahlt hat, am naechsten Morgen wieder einen offenen
 * Betrag.
 */
export function stayPostingRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/post-stay',
    permission: 'folio:post',
    summary: 'Alle offenen Naechte des Aufenthalts jetzt buchen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await aufenthalt(client, principal, reservationRef)
        // Vor dem Check-in steht nicht fest, dass der Gast kommt. Wer schon
        // vor der Anreise zahlt, bekommt eine Anzahlungsrechnung.
        if (r.status !== 'InHouse') throw Errors.conflict('stay.postAheadNotInHouse')
        const f = await client.query<{ status: string }>(
          `SELECT status FROM folio
            WHERE reservation_id = $1 AND kind = 'guest' ORDER BY id LIMIT 1`, [r.id])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        if (f.rows[0]!.status !== 'open') throw Errors.conflict('folio.closed')

        // Ein zweiter Klick findet keine offene Nacht mehr und bucht nichts:
        // `posted` und die Sperre auf der Reservierung machen die Route ohne
        // Idempotenzschluessel wiederholbar.
        const naechte = await postNights(client, r.property_id, { reservationId: r.id })
        let kurtaxe = 0
        if (naechte.length > 0) {
          const k = await client.query<{ n: number }>(
            `SELECT COALESCE(sum(post_city_tax($1, d, $2)), 0)::int AS n
               FROM unnest($3::date[]) AS d`,
            [r.property_id, r.id, naechte])
          kurtaxe = k.rows[0]!.n
        }
        return { reservationRef, postedNights: naechte, cityTaxCharges: kurtaxe }
      })
    }
  })

  /**
   * Vorausbuchung zuruecknehmen: die Naechte ab dem Geschaeftstag gehen per
   * Gegenbuchung zurueck und werden wieder offen. Danach bucht sie der
   * Nachtlauf, wie bei jedem anderen Gast.
   *
   * Gebraucht, wenn der Gast frueher abreist: gekuerzt wird nur, was nicht
   * gebucht ist, und eine gebuchte Nacht ohne Aufenthalt stuende sonst fuer
   * immer im Folio. Die Gegenbuchung traegt den Tag der Nacht, wie bei der
   * Stornorechnung: die Tagesstatistik sieht netto nichts.
   *
   * Erkannt wird, was `postNights` und die Kurtaxe buchen: an dieser
   * Reservierung, Logis auf 8300, ein Paketteil oder eine Abgabe mit
   * Steuerregel. Was jemand von Hand gebucht hat, traegt keine Reservierung
   * und bleibt stehen. Steht etwas davon auf einer Rechnung, wird
   * abgewiesen: erst stornieren, sonst sagten Folio und Rechnung
   * Verschiedenes.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/unpost-stay',
    permission: 'folio:post',
    summary: 'Vorab gebuchte Naechte zuruecknehmen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await aufenthalt(client, principal, reservationRef)
        const heute = await geschaeftstag(client, r.property_id)
        const offen = await client.query<{ id: number; invoice_id: number | null }>(
          `SELECT c.id, c.invoice_id
             FROM charge c
            WHERE c.reservation_id = $1 AND c.reverses_id IS NULL
              AND (c.revenue_account = '8300' OR c.tax_rule_id IS NOT NULL
                   OR c.package_part IS NOT NULL)
              AND c.business_date IN (SELECT date FROM reservation_night
                                       WHERE reservation_id = $1 AND posted
                                         AND date >= $2::date)
              AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id)
            ORDER BY c.id
            FOR UPDATE OF c`,
          [r.id, heute])
        if (offen.rows.some(c => c.invoice_id !== null)) {
          throw Errors.unprocessable('stay.postedAheadInvoiced')
        }
        if (offen.rowCount !== 0) {
          // Steuerbetrag der Position uebernommen, nicht neu gerechnet:
          // sonst bliebe ein Cent Steuer stehen.
          await client.query(
            `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                                 net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                                 revenue_account, product_id, reservation_id, reverses_id,
                                 created_by, package_part)
             SELECT c.property_id, c.folio_id, c.business_date, 'Storno ' || c.description,
                    c.quantity, -c.net_cent, -c.tax_cent, -c.gross_cent, c.tax_rate_bp,
                    c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id, c.id,
                    $2, c.package_part
               FROM charge c WHERE c.id = ANY($1::bigint[])
              ORDER BY c.id`,
            [offen.rows.map(c => c.id), principal.userId])
        }
        const frei = await client.query<{ date: string }>(
          `UPDATE reservation_night SET posted = false
            WHERE reservation_id = $1 AND posted AND date >= $2::date
            RETURNING date::text`,
          [r.id, heute])
        return { reservationRef, reopenedNights: frei.rows.map(n => n.date).sort() }
      })
    }
  })
}

async function aufenthalt(
  client: PoolClient, principal: Principal, reservationRef: string
): Promise<{ id: number; property_id: number; status: string }> {
  const r = await client.query<{ id: number; property_id: number; status: string }>(
    `SELECT id, property_id, status FROM reservation WHERE public_ref = $1 FOR UPDATE`,
    [reservationRef])
  if (r.rowCount === 0) throw Errors.notFound('res.reservation')
  const res = r.rows[0]!
  // Das Recht im Haus der Reservierung: die Route nimmt keine Property, und
  // `registerRoute` prueft dann nur "irgendwo".
  rechtImHaus(principal, 'folio:post', Number(res.property_id))
  return { id: Number(res.id), property_id: Number(res.property_id), status: res.status }
}
