import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { sumInvoice, taxFromNet, blockingFindings, type Party } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'

export function billingRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/payment-methods',
    permission: 'folio:read',
    propertyParam: 'propertyId',
    summary: 'Zahlungsarten der Property',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT code, name, is_external AS "isExternal"
             FROM payment_method WHERE property_id = $1 AND active
            ORDER BY sort_order, code`, [Number(propertyId)])
        // Der Hinweis gehoert an die Liste, nicht in eine Fussnote: dieses
        // System wickelt keine Zahlung ab und fuehrt keinen Kassenbestand.
        // Es vermerkt, wo abgerechnet wurde (Entscheidung 9, Dokument 09).
        return {
          paymentMethods: rows,
          hinweis: 'Ein Zahlungsvermerk ordnet zu, er wickelt nicht ab. '
                 + 'Die Zahlung selbst laeuft ueber Kasse, Portal oder Bank des Betriebs.'
        }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/folios/:folioRef',
    permission: 'folio:read',
    summary: 'Folio mit Positionen und Saldo',
    handler: async (req) => {
      const { folioRef } = req.params as { folioRef: string }
      return tx(req.pool, req, async client => {
        const f = await client.query(
          `SELECT id, public_ref, property_id, reservation_id, kind, status, label
             FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('Folio')
        const folio = f.rows[0]!

        const charges = await client.query(
          `SELECT id, business_date::text, description, quantity,
                  net_cent, tax_cent, gross_cent, tax_rate_bp,
                  revenue_account, invoice_id, reverses_id
             FROM charge WHERE folio_id = $1 ORDER BY id`, [folio.id])
        const settlements = await client.query(
          `SELECT s.id, s.business_date::text, s.amount_cent, s.external_reference,
                  pm.code AS method, s.reverses_id
             FROM settlement s JOIN payment_method pm ON pm.id = s.payment_method_id
            WHERE s.folio_id = $1 ORDER BY s.id`, [folio.id])

        const charged = charges.rows.reduce((s, c) => s + Number(c.gross_cent), 0)
        const settled = settlements.rows.reduce((s, p) => s + Number(p.amount_cent), 0)
        return {
          folio, charges: charges.rows, settlements: settlements.rows,
          balanceCent: charged - settled
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/charges',
    permission: 'folio:post',
    summary: 'Leistung buchen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as {
        description: string; netCent: number; taxRateBp: number
        quantity?: number; revenueAccount?: string; productId?: number
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('Folio')
        if (f.rows[0]!.status === 'closed') throw Errors.conflict('Folio ist geschlossen.')
        const folio = f.rows[0]!

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [folio.property_id])
        const businessDate = bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10)

        const qty = body.quantity ?? 1
        const net = body.netCent * qty
        const tax = taxFromNet(net, body.taxRateBp)
        const r = await client.query<{ id: number }>(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp,
                               revenue_account, product_id, created_by)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [folio.property_id, folio.id, businessDate, body.description, qty,
           net, tax, net + tax, body.taxRateBp,
           body.revenueAccount ?? '8300', body.productId ?? null, principal.userId])

        const result = { chargeId: r.rows[0]!.id, netCent: net, taxCent: tax, grossCent: net + tax }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/settlements',
    permission: 'folio:post',
    summary: 'Zahlungsvermerk erfassen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as {
        amountCent: number; paymentMethodCode: string; externalReference?: string
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('Folio')
        const folio = f.rows[0]!

        const pm = await client.query<{ id: number }>(
          `SELECT id FROM payment_method WHERE property_id = $1 AND code = $2 AND active`,
          [folio.property_id, body.paymentMethodCode])
        if (pm.rowCount === 0) throw Errors.validation({ paymentMethodCode: ['Unbekannte Zahlart'] })

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [folio.property_id])

        const r = await client.query<{ id: number }>(
          `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                                   payment_method_id, external_reference, created_by)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7) RETURNING id`,
          [folio.property_id, folio.id, bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10),
           body.amountCent, pm.rows[0]!.id, body.externalReference ?? null, principal.userId])

        const result = { settlementId: r.rows[0]!.id, amountCent: body.amountCent }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Der Beleg zur Rechnung: PDF/A-3 mit eingebettetem CII-XML nach
   * EN 16931, also ZUGFeRD.
   *
   * Ausgeliefert wird, was der Worker erzeugt hat, und nichts wird hier
   * nachgerechnet oder neu gezeichnet. Ein Beleg, der bei jedem Abruf neu
   * entstuende, waere bei jedem Abruf ein anderer -- und der Gast haelt
   * eine Fassung in der Hand, die das Haus nicht mehr kennt.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/invoices/:invoiceRef/pdf',
    permission: 'folio:read',
    summary: 'Rechnung als PDF/A-3 mit eingebettetem ZUGFeRD-XML',
    handler: async (req, reply) => {
      const { invoiceRef } = req.params as { invoiceRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ number: string; pdf: Buffer | null }>(
          `SELECT i.number, d.pdf
             FROM invoice i
             LEFT JOIN invoice_document d ON d.invoice_id = i.id
            WHERE i.public_ref = $1`, [invoiceRef])
        if (r.rowCount === 0) throw Errors.notFound('Rechnung')
        const pdf = r.rows[0]!.pdf
        if (pdf === null) throw Errors.documentPending()

        // Die Rechnungsnummer kann einen Praefix aus den Stammdaten tragen;
        // was dort steht, gehoert nicht ungeprueft in einen Dateinamen.
        const name = `Rechnung-${r.rows[0]!.number.replace(/[^\w.-]/g, '-')}.pdf`
        reply.header('content-type', 'application/pdf')
        reply.header('content-disposition', `attachment; filename="${name}"`)
        return pdf
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/invoice',
    permission: 'invoice:issue',
    summary: 'Rechnung festschreiben',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as { kind?: 'final' | 'interim'; chargeIds?: number[] }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; guest_id: number | null
                                       company_id: number | null }>(
          `SELECT id, property_id, guest_id, company_id FROM folio WHERE public_ref = $1
             FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('Folio')
        const folio = f.rows[0]!

        // Eine Rechnung umfasst eine Menge von Charges, nicht ein Folio.
        // Damit sind Zwischenrechnungen und getrennte Rechnungen moeglich.
        const charges = await client.query<{ id: number; net_cent: number; tax_rate_bp: number
                                             description: string; quantity: number
                                             business_date: string }>(
          body.chargeIds?.length
            ? `SELECT id, net_cent, tax_rate_bp, description, quantity,
                      business_date::text FROM charge
                WHERE folio_id = $1 AND invoice_id IS NULL AND id = ANY($2) ORDER BY id`
            : `SELECT id, net_cent, tax_rate_bp, description, quantity,
                      business_date::text FROM charge
                WHERE folio_id = $1 AND invoice_id IS NULL ORDER BY id`,
          body.chargeIds?.length ? [folio.id, body.chargeIds] : [folio.id])
        if (charges.rowCount === 0) throw Errors.unprocessable('Keine offenen Positionen.')

        const totals = sumInvoice(
          charges.rows.map(c => ({ netCent: Number(c.net_cent), rateBp: c.tax_rate_bp })))

        /*
         * Aussteller und Empfaenger werden gleich in der Form gelesen, in der
         * sie geprueft und gespeichert werden. Eine Umbenennung zwischen
         * Datenbank und Pruefung ist eine Stelle, an der ein Feld lautlos
         * verschwindet: genau das ist hier einmal passiert, die Anschrift kam
         * als postal_code an und wurde als postalCode gesucht.
         */
        const prop = await client.query<Party>(
          `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
                  city, country, tax_number AS "taxNumber", vat_id AS "vatId"
             FROM property WHERE id = $1`, [folio.property_id])
        const recipient = folio.company_id
          ? await client.query<Party>(
              `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
                      city, country, vat_id AS "vatId"
                 FROM company WHERE id = $1`, [folio.company_id])
          : folio.guest_id
            ? await client.query<Party>(
                `SELECT trim(both ', ' from
                          coalesce(last_name,'') || ', ' || coalesce(first_name,'')) AS name,
                        address_line1 AS "addressLine1", postal_code AS "postalCode",
                        city, country
                   FROM guest WHERE id = $1`, [folio.guest_id])
            : { rows: [] as Party[] }

        const year = new Date().getUTCFullYear()
        const num = await client.query<{ next_invoice_number: string }>(
          `SELECT next_invoice_number($1, $2)`, [folio.property_id, year])

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [folio.property_id])
        const businessDate = bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10)

        /*
         * Leistungszeitraum nach § 14 Abs. 4 Nr. 6 UStG.
         *
         * Bei Beherbergung ist das der **Aufenthalt**, nicht das
         * Rechnungsdatum. Die Verwechslung ist der häufigste Mangel an
         * Hotelrechnungen. Er wird aus den Geschäftsdaten der abzurechnenden
         * Positionen abgeleitet und nicht vom Aufrufer entgegengenommen:
         * die Positionen wissen es, der Aufrufer könnte sich irren.
         */
        const daten = charges.rows.map(c => c.business_date).sort()
        const serviceFrom = daten[0]!
        const serviceTo = daten[daten.length - 1]!

        // Vor dem Festschreiben prüfen. Eine fehlende Pflichtangabe kostet
        // dem Empfänger den Vorsteuerabzug, und das merkt niemand beim
        // Ausstellen, sondern der Firmenkunde drei Monate später (E4).
        const maengel = blockingFindings({
          number: num.rows[0]!.next_invoice_number,
          issuedOn: new Date().toISOString().slice(0, 10),
          serviceFrom, serviceTo,
          issuer: prop.rows[0] ?? {},
          recipient: recipient.rows[0] ?? {},
          lines: charges.rows.map(c => ({
            description: c.description, quantity: c.quantity,
            netCent: Number(c.net_cent), rateBp: c.tax_rate_bp })),
          grossCent: totals.grossCent,
          kind: (body.kind ?? 'final') as 'final' | 'interim'
        })
        if (maengel.length > 0) {
          throw Errors.unprocessable(
            'Die Rechnung erfüllt die Pflichtangaben nicht: '
            + maengel.map(m => `${m.de} (${m.reference})`).join(' '))
        }

        const inv = await client.query<{ id: number; public_ref: string; number: string }>(
          `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                                service_from, service_to,
                                issuer_snapshot, recipient_snapshot, totals, created_by)
           VALUES ($1,$2,$3,current_date,$4::date,$5,$6::date,$7::date,$8,$9,$10,$11)
           RETURNING id, public_ref, number`,
          [folio.property_id, folio.id, num.rows[0]!.next_invoice_number, businessDate,
           body.kind ?? 'final', serviceFrom, serviceTo,
           JSON.stringify(prop.rows[0] ?? {}), JSON.stringify(recipient.rows[0] ?? {}),
           JSON.stringify(totals), principal.userId])

        // charge.invoice_id wird einmal gesetzt und nie geaendert. Die Tabelle
        // ist append-only, daher hebt der Trigger hier gezielt ab: das
        // Festschreiben ist die einzige erlaubte Zuordnung.
        await client.query(
          `UPDATE charge SET invoice_id = $2 WHERE id = ANY($1)`,
          [charges.rows.map(c => c.id), inv.rows[0]!.id])

        const result = {
          invoiceRef: inv.rows[0]!.public_ref,
          number: inv.rows[0]!.number,
          serviceFrom, serviceTo,
          totals
        }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })
}
