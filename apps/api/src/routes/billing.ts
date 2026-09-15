import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { hinweisText } from '../platform/texte.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { emitEvent } from '../platform/events.js'
import { sumInvoice, taxFromNet, blockingFindings, expectedRateMix,
         splitDeposit, depositLines, type RateGroupAmount, type ExpectedItem,
         type Party }
  from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'
import { isTrainingProperty, TRAINING_PREFIX } from '../platform/training.js'
import type { Principal } from '../platform/context.js'

/** Ermaessigter Satz als Rueckfall, wie im Nachtlauf. */
const VAT_FALLBACK = 700

/**
 * Die erwartete Zusammensetzung des Aufenthalts nach Steuersaetzen: die
 * Grundlage, in deren Verhaeltnis eine pauschale Anzahlung aufgeteilt wird.
 *
 * Gerechnet wird mit dem **geplanten** Aufenthalt, nicht mit dem schon
 * Gebuchten. Fuer die Aufteilung zaehlt nur das Verhaeltnis, und der Plan
 * kennt es auch dann, wenn noch keine einzige Nacht gebucht ist -- der
 * Regelfall bei einer Anzahlung, die bei der Buchung gefordert wird.
 */
async function erwarteteSaetze(
  client: PoolClient, propertyId: number, reservationId: number
): Promise<RateGroupAmount[]> {
  const r = await client.query<{ rate_plan_id: number | null; naechte: number
                                 logis_cent: number; personen: number }>(
    `SELECT res.rate_plan_id, (res.departure - res.arrival) AS naechte,
            COALESCE((SELECT sum(rn.price_cent) FROM reservation_night rn
                       WHERE rn.reservation_id = res.id), 0)::bigint AS logis_cent,
            GREATEST((SELECT count(*) FROM reservation_occupant o
                       WHERE o.reservation_id = res.id), 1)::int AS personen
       FROM reservation res WHERE res.id = $1 AND res.property_id = $2`,
    [reservationId, propertyId])
  if (r.rowCount === 0) return []
  const res = r.rows[0]!
  if (Number(res.logis_cent) <= 0) return []

  const steuer = await client.query<{ rate_bp: number }>(
    `SELECT COALESCE((SELECT rate_bp FROM tax_rule
                       WHERE property_id = $1 AND kind = 'vat' AND basis = 'percent'
                         AND active ORDER BY id LIMIT 1), $2) AS rate_bp`,
    [propertyId, VAT_FALLBACK])
  const logisSatz = steuer.rows[0]!.rate_bp

  /*
   * Im Ratenpreis enthaltene Leistungen. Das Fruehstueck steckt dann im
   * Zimmerpreis und muss herausgerechnet werden (Aufteilungsgebot): der
   * Preis der Uebernachtung traegt den ermaessigten Satz, das Fruehstueck
   * seinen eigenen -- und ein Buffet gleich zwei.
   */
  const enthalten = res.rate_plan_id === null ? { rows: [] } : await client.query<{
    price_cent: number; charge_mode: string; rate_bp: number | null
    split_rate_bp: number | null; split_share_bp: number | null }>(
    `SELECT p.price_cent, p.charge_mode, tr.rate_bp,
            sp.rate_bp AS split_rate_bp, p.split_share_bp
       FROM rate_plan_product rpp
       JOIN product p ON p.id = rpp.product_id AND p.active AND p.property_id = $2
       LEFT JOIN tax_rule tr ON tr.id = p.tax_rule_id
       LEFT JOIN tax_rule sp ON sp.id = p.split_tax_rule_id
      WHERE rpp.rate_plan_id = $1`,
    [res.rate_plan_id, propertyId])

  const naechte = Math.max(Number(res.naechte), 1)
  const personen = Number(res.personen)
  const posten: ExpectedItem[] = []
  let extras = 0

  for (const p of enthalten.rows) {
    const menge = p.charge_mode === 'once' ? 1
      : p.charge_mode === 'per_person_night' ? naechte * personen
        : naechte
    const brutto = Number(p.price_cent) * menge
    if (brutto <= 0) continue
    extras += brutto
    posten.push({
      grossCent: brutto,
      rateBp: p.rate_bp ?? logisSatz,
      splitShareBp: p.split_share_bp,
      splitRateBp: p.split_rate_bp
    })
  }

  // Was nach Abzug der enthaltenen Leistungen bleibt, ist Logis. Nie
  // negativ: ein Ratenpreis unter dem Wert der enthaltenen Leistungen ist
  // eine Frage an die Stammdaten, aber kein Grund, hier Unsinn zu rechnen.
  const logis = Math.max(Number(res.logis_cent) - extras, 0)
  if (logis > 0) posten.unshift({ grossCent: logis, rateBp: logisSatz })

  return expectedRateMix(posten)
}

export function billingRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/payment-methods',
    permission: 'folio:read',
    propertyParam: 'propertyId',
    summary: 'Zahlungsarten der Property',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { includeInactive?: string }
      return tx(req.pool, req, async client => {
        // `id`, `sortOrder` und `active` kommen immer mit: ohne sie ist die
        // Liste ansehbar, aber nicht pflegbar, und die Pflegemaske muesste
        // sie einzeln nachfragen.
        const { rows } = await client.query(
          `SELECT id, code, name, is_external AS "isExternal",
                  sort_order AS "sortOrder", active
             FROM payment_method
            WHERE property_id = $1 AND (active OR $2::boolean)
            ORDER BY sort_order, code`,
          [Number(propertyId), q.includeInactive === 'true'])
        // Der Hinweis gehoert an die Liste, nicht in eine Fussnote: dieses
        // System wickelt keine Zahlung ab und fuehrt keinen Kassenbestand.
        // Es vermerkt, wo abgerechnet wurde (Entscheidung 9, Dokument 09).
        return {
          paymentMethods: rows,
          hinweis: hinweisText('hint.settlementIsNotPayment'),
          hinweisKey: 'hint.settlementIsNotPayment'
        }
      })
    }
  })


  /**
   * Zahlungsart anlegen.
   *
   * Was hier **nicht** entsteht, ist eine Kasse. Ein Zahlungsvermerk ordnet
   * zu, er wickelt nicht ab: es gibt keinen Kassenbestand, keine TSE und
   * keinen Bon (Entscheidung 10, Dokument 09). `isExternal` sagt deshalb
   * nur, ob die Abwicklung ausser Haus liegt -- eine Buchungsregel ist es
   * nicht.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/payment-methods',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Zahlungsart anlegen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = req.body as { code: string; name: string; isExternal?: boolean
                              sortOrder?: number }
      const fehler: Record<string, string[]> = {}
      if (!b.code?.trim()) fehler.code = ['field.required']
      if (!b.name?.trim()) fehler.name = ['field.required']
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      return tx(req.pool, req, async client => {
        const da = await client.query(
          `SELECT 1 FROM payment_method WHERE property_id = $1 AND code = $2`,
          [Number(propertyId), b.code.trim()])
        if (da.rowCount && da.rowCount > 0) {
          throw Errors.conflict('paymentMethod.duplicateCode', { code: b.code })
        }
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO payment_method (property_id, code, name, is_external, sort_order)
           VALUES ($1,$2,$3,COALESCE($4,true),
                   COALESCE($5,(SELECT COALESCE(max(sort_order),0)+10
                                  FROM payment_method WHERE property_id = $1)))
           RETURNING id`,
          [Number(propertyId), b.code.trim(), b.name.trim(),
           b.isExternal ?? null, b.sortOrder ?? null])
        reply.status(201)
        return { paymentMethodId: rows[0]!.id, code: b.code.trim() }
      })
    }
  })

  /**
   * Zahlungsart aendern oder stilllegen.
   *
   * Es gibt **kein** Loeschen, und das ist keine Bequemlichkeit: an einer
   * Zahlungsart haengen Verrechnungen, und `settlement` ist Haertegrad 1.
   * Eine geloeschte Zahlungsart liesse Belege zurueck, deren Zahlungsweg
   * niemand mehr benennen kann. Stillgelegt verschwindet sie aus der Auswahl
   * und bleibt in der Geschichte.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/payment-methods/:paymentMethodId',
    permission: 'settings:property',
    summary: 'Zahlungsart aendern oder stilllegen',
    handler: async (req) => {
      const { paymentMethodId } = req.params as { paymentMethodId: string }
      const b = req.body as { name?: string; isExternal?: boolean
                              sortOrder?: number; active?: boolean }
      if (b.name !== undefined && b.name.trim() === '') {
        throw Errors.validation({ name: ['field.required'] })
      }
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query(
          `UPDATE payment_method SET
             name = COALESCE($2, name),
             is_external = COALESCE($3, is_external),
             sort_order = COALESCE($4, sort_order),
             active = COALESCE($5, active)
           WHERE id = $1
           RETURNING id, code, name, is_external AS "isExternal",
                     sort_order AS "sortOrder", active`,
          [Number(paymentMethodId), b.name?.trim() ?? null, b.isExternal ?? null,
           b.sortOrder ?? null, b.active ?? null])
        // Die Zeilenrichtlinie hat fremde Haeuser schon aussortiert; hier
        // bleibt nur "gibt es nicht".
        if (rowCount === 0) throw Errors.notFound('res.paymentMethod')
        return rows[0]!
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
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
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
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        if (f.rows[0]!.status === 'closed') throw Errors.conflict('folio.closed')
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
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!

        const pm = await client.query<{ id: number }>(
          `SELECT id FROM payment_method WHERE property_id = $1 AND code = $2 AND active`,
          [folio.property_id, body.paymentMethodCode])
        if (pm.rowCount === 0) throw Errors.validation({ paymentMethodCode: ['field.unknownPaymentMethod'] })

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
   * Anzahlungsrechnung: dokumentiert eine Vereinnahmung vor der Leistung.
   *
   * Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Steuer mit dem Zufluss, nicht
   * mit dem Aufenthalt. Der Zahlungsvermerk muss deshalb bereits existieren
   * (`POST .../settlements`); diese Route macht daraus die Rechnung, die
   * das Finanzamt verlangt, und traegt die Vereinnahmung ins Anzahlungs-
   * journal ein. Der Zahlungsvermerk selbst bleibt unangetastet: sein
   * `invoice_id` ist fuer eine andere, bereits bestehende Zuordnung reserviert
   * (Zahlung direkt der eigenen Rechnung zugeordnet, siehe BT-113) und wuerde
   * dort zu Verwirrung fuehren, wenn er hier zusaetzlich auf die
   * Anzahlungsrechnung zeigte.
   *
   * Der Steuersatz kommt entweder ausdruecklich mit -- dann hat jemand
   * hingesehen -- oder wird aus dem erwarteten Aufenthalt abgeleitet. Eine
   * Anzahlung ist ein pauschaler Betrag, die spaetere Leistung ist es
   * nicht: die Uebernachtung traegt den ermaessigten Satz, das Fruehstueck
   * seinen eigenen und ein Buffet gleich zwei. Ausgewiesen werden muss das
   * schon jetzt (§ 14 Abs. 5 UStG).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/deposit-invoice',
    permission: 'invoice:issue',
    summary: 'Anzahlungsrechnung erstellen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as {
        settlementId: number
        /** Ein einziger Satz fuer die ganze Anzahlung. */
        taxRateBp?: number
        /** Ausdrueckliche Aufteilung. Ueberschreibt die Ableitung. */
        lines?: Array<{ grossCent: number; taxRateBp: number }>
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; guest_id: number | null
                                       company_id: number | null; reservation_id: number | null }>(
          `SELECT id, property_id, guest_id, company_id, reservation_id
             FROM folio WHERE public_ref = $1 FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!

        // Der Leistungszeitraum nach § 14 Abs. 4 Nr. 6 UStG ist der
        // geplante Aufenthalt: die Leistung selbst steht noch aus, aber
        // wofuer angezahlt wird, muss feststehen.
        if (folio.reservation_id === null) {
          throw Errors.unprocessable(
            'deposit.needsReservation')
        }
        const res = await client.query<{ arrival: string; departure: string }>(
          `SELECT arrival::text, departure::text FROM reservation WHERE id = $1`,
          [folio.reservation_id])
        if (res.rowCount === 0) throw Errors.notFound('res.reservation')
        const { arrival, departure } = res.rows[0]!

        const s = await client.query<{ id: number; amount_cent: number; business_date: string }>(
          `SELECT id, amount_cent, business_date::text FROM settlement
            WHERE id = $1 AND folio_id = $2 FOR UPDATE`, [body.settlementId, folio.id])
        if (s.rowCount === 0) throw Errors.notFound('res.settlement')
        const settlement = s.rows[0]!

        /*
         * Eine Rueckzahlung ist keine Anzahlung. Negative Zahlungsvermerke
         * gibt es (Storno, Erstattung), und ohne diese Pruefung schlaegt
         * erst die Bedingung am Anzahlungsjournal zu -- als Fehler 500
         * statt als Antwort, die sagt, was falsch war.
         */
        if (settlement.amount_cent <= 0) {
          throw Errors.validation({ settlementId: [
            'field.notAnIncomingPayment'] })
        }

        const bereits = await client.query(
          `SELECT 1 FROM deposit_ledger WHERE settlement_id = $1`, [settlement.id])
        if ((bereits.rowCount ?? 0) > 0) {
          throw Errors.conflict('deposit.alreadyInvoiced')
        }

        /*
         * Die Aufteilung auf die Steuersaetze. Die Summe der Teile ist auf
         * den Cent der vereinnahmte Betrag: die Anzahlungsrechnung weist
         * diese Teile aus, und eine Differenz zum Zahlungseingang ist genau
         * die Art Fehler, die erst der Betriebspruefer findet.
         */
        let teile: RateGroupAmount[]
        if (body.lines?.length) {
          const summe = body.lines.reduce((acc, l) => acc + l.grossCent, 0)
          if (summe !== settlement.amount_cent) {
            throw Errors.validation({ lines: ['field.depositPartsMismatch'] },
              { sum: summe, received: settlement.amount_cent })
          }
          teile = body.lines.map(l => ({ rateBp: l.taxRateBp, grossCent: l.grossCent }))
        } else if (body.taxRateBp !== undefined) {
          teile = [{ rateBp: body.taxRateBp, grossCent: settlement.amount_cent }]
        } else {
          const mix = await erwarteteSaetze(client, folio.property_id, folio.reservation_id)
          if (mix.length === 0) {
            throw Errors.unprocessable(
              'deposit.noRatesForSplit')
          }
          teile = splitDeposit(settlement.amount_cent, mix)
        }

        /*
         * Brutto herein, netto heraus: eine Anzahlung wird brutto
         * vereinbart, der Gast ueberweist 200 Euro und nicht 186,92 plus
         * Steuer. Die Nettobetraege werden dabei so gewaehlt, dass die
         * Rechnung den vereinnahmten Betrag ausweist -- herausrechnen und
         * wieder daraufschlagen verfehlt ihn sonst um einen Cent, weil
         * beide Schritte runden.
         */
        const positionen = depositLines(settlement.amount_cent, teile)

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
        if (await isTrainingProperty(client, folio.property_id)) {
          await client.query(
            `INSERT INTO invoice_counter (property_id, year, prefix)
             VALUES ($1,$2,$3) ON CONFLICT (property_id, year) DO NOTHING`,
            [folio.property_id, year, TRAINING_PREFIX])
        }
        const num = await client.query<{ next_invoice_number: string }>(
          `SELECT next_invoice_number($1, $2)`, [folio.property_id, year])

        const totals = sumInvoice(positionen)

        const maengel = blockingFindings({
          number: num.rows[0]!.next_invoice_number,
          issuedOn: new Date().toISOString().slice(0, 10),
          serviceFrom: arrival, serviceTo: departure,
          issuer: prop.rows[0] ?? {},
          recipient: recipient.rows[0] ?? {},
          lines: positionen.map(pos => ({
            description: 'Anzahlung auf den Aufenthalt', quantity: 1,
            netCent: pos.netCent, rateBp: pos.rateBp })),
          // Geprueft wird, was der Beleg sagt, nicht was ueberwiesen wurde:
          // an der Grenze zur Kleinbetragsrechnung (§ 33 UStDV) entscheidet
          // der ausgewiesene Betrag.
          grossCent: totals.grossCent,
          kind: 'deposit'
        })
        if (maengel.length > 0) {
          throw Errors.unprocessable(
            'deposit.requirementsUnmet',
            { maengel: maengel.map(m => `${m.de} (${m.reference})`).join(' ') })
        }

        const inv = await client.query<{ id: number; public_ref: string; number: string }>(
          `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                                service_from, service_to,
                                issuer_snapshot, recipient_snapshot, totals, created_by)
           VALUES ($1,$2,$3,current_date,$4::date,'deposit',$5::date,$6::date,$7,$8,$9,$10)
           RETURNING id, public_ref, number`,
          [folio.property_id, folio.id, num.rows[0]!.next_invoice_number, settlement.business_date,
           arrival, departure, JSON.stringify(prop.rows[0] ?? {}),
           JSON.stringify(recipient.rows[0] ?? {}), JSON.stringify(totals), principal.userId])

        /*
         * Die Vereinnahmung ins Anzahlungsjournal eintragen, je Satzgruppe
         * eine Zeile. business_date ist das des Zahlungsvermerks, nicht das
         * der heutigen Ausstellung: die Steuer entsteht im Monat des
         * Zuflusses (§ 13 Abs. 1 Nr. 1a UStG), und der kann vor dem
         * Ausstellungstag dieser Rechnung liegen.
         *
         * Eingetragen wird, was der Beleg ausweist, und nicht noch einmal
         * gerechnet: aus dem Journal bucht der DATEV-Stapel, und ein Stapel,
         * der einen anderen Betrag traegt als der Beleg beim Gast, ist bei
         * der naechsten Pruefung ein Fund.
         */
        for (const g of totals.groups) {
          await client.query(
            `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                         amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                         business_date, settlement_id, created_by)
             VALUES ($1,$2,$3,'received',$4,$5,$6,$7,$8::date,$9,$10)`,
            [folio.property_id, folio.id, inv.rows[0]!.id, g.grossCent,
             g.netCent, g.taxCent, g.rateBp, settlement.business_date, settlement.id,
             principal.userId])
        }

        const result = {
          invoiceRef: inv.rows[0]!.public_ref, number: inv.rows[0]!.number,
          netCent: totals.netCent, taxCent: totals.taxCent, grossCent: totals.grossCent,
          groups: totals.groups
        }

        await emitEvent(client, folio.property_id, 'invoice.finalized', {
          invoiceRef: result.invoiceRef, number: result.number, folioRef,
          kind: 'deposit', serviceFrom: arrival, serviceTo: departure,
          grossCent: totals.grossCent
        })

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
        if (r.rowCount === 0) throw Errors.notFound('res.invoice')
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
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; guest_id: number | null
                                       company_id: number | null }>(
          `SELECT id, property_id, guest_id, company_id FROM folio WHERE public_ref = $1
             FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
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
        if (charges.rowCount === 0) throw Errors.unprocessable('folio.nothingOpen')

        /*
         * Offene Anzahlungen dieses Folios: Verrechnung als eigene Position
         * mit negativem Betrag und Verweis auf die Anzahlungsrechnung
         * (Aufgabe 3, § 13 Abs. 1 Nr. 1a UStG). Der Steuersatz der Position
         * bleibt der der Anzahlung, nicht der des Aufenthalts: verrechnet
         * wird, was schon versteuert wurde, zum Satz, zu dem es versteuert
         * wurde. Das Folio selbst bleibt unberuehrt, dessen Saldo kommt
         * allein aus charge und settlement; die Anzahlung stand dort schon
         * als settlement und wuerde sonst doppelt gezaehlt.
         *
         * Nur auf der Schlussrechnung ueber alle offenen Positionen. Eine
         * Zwischenrechnung ueber eine Auswahl darf die Anzahlung nicht
         * verbrauchen: sie gehoert zum ganzen Aufenthalt, nicht zu einer
         * Auswahl daraus. Sonst zoege eine Zwischenrechnung ueber ein
         * Mineralwasser die ganze Anzahlung ab -- und lautete ueber einen
         * negativen Betrag.
         */
        const schlussrechnung = (body.kind ?? 'final') === 'final' && !body.chargeIds?.length
        const deposits = schlussrechnung ? await client.query<{
          deposit_invoice_id: number; net_cent: string; tax_cent: string
          tax_rate_bp: number; amount_gross_cent: string
          deposit_number: string; deposit_issued_on: string
        }>(
          `SELECT dl.deposit_invoice_id, dl.net_cent, dl.tax_cent, dl.tax_rate_bp,
                  dl.amount_gross_cent, di.number AS deposit_number,
                  di.issued_on::text AS deposit_issued_on
             FROM deposit_ledger dl
             JOIN invoice di ON di.id = dl.deposit_invoice_id
            WHERE dl.folio_id = $1 AND dl.kind = 'received'
              AND NOT EXISTS (
                SELECT 1 FROM deposit_ledger a
                 WHERE a.deposit_invoice_id = dl.deposit_invoice_id AND a.kind = 'applied')
            ORDER BY dl.id`,
          [folio.id]) : { rows: [] as Array<{
            deposit_invoice_id: number; net_cent: string; tax_cent: string
            tax_rate_bp: number; amount_gross_cent: string
            deposit_number: string; deposit_issued_on: string }> }

        const totals = sumInvoice([
          ...charges.rows.map(c => ({ netCent: Number(c.net_cent), rateBp: c.tax_rate_bp })),
          ...deposits.rows.map(d => ({ netCent: -Number(d.net_cent), rateBp: d.tax_rate_bp }))
        ])

        /*
         * Mehr angezahlt als abzurechnen: das kommt vor, wenn der Gast
         * frueher abreist oder ein Teil des Aufenthalts schon
         * zwischenabgerechnet wurde. Dem Gast steht dann Geld zu -- und
         * dafuer ist eine Rechnung ueber einen negativen Betrag das falsche
         * Papier. Abgewiesen wird hier deshalb, solange es die Rueckzahlung
         * ('refunded' im Anzahlungsjournal) noch nicht gibt: lieber keine
         * Rechnung als eine, die niemand buchen kann.
         */
        if (deposits.rows.length > 0 && totals.grossCent < 0) {
          throw Errors.unprocessable(
            'deposit.exceedsServices', { cent: -totals.grossCent })
        }

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

        /*
         * Ein Uebungshaus bekommt ein sichtbares Kuerzel vor der Nummer.
         * Die Nummernfolge ist ohnehin je Property getrennt, aber eine
         * Uebungsrechnung muss man auch dann als solche erkennen, wenn sie
         * ausgedruckt auf dem Tresen liegt (C11, Dokument 13).
         *
         * Das Kuerzel wird einmal am Zaehler gesetzt, nicht bei jeder
         * Nummer: sonst haette dieselbe Property mal mit und mal ohne
         * Kuerzel numeriert, und die Folge waere nicht mehr lueckenlos
         * nachvollziehbar.
         */
        const year = new Date().getUTCFullYear()
        if (await isTrainingProperty(client, folio.property_id)) {
          await client.query(
            `INSERT INTO invoice_counter (property_id, year, prefix)
             VALUES ($1,$2,$3) ON CONFLICT (property_id, year) DO NOTHING`,
            [folio.property_id, year, TRAINING_PREFIX])
        }
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
            'invoice.requirementsUnmet',
            { maengel: maengel.map(m => `${m.de} (${m.reference})`).join(' ') })
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

        // Verrechnet, nicht mehr offen: eine Anzahlung wird genau einer
        // Schlussrechnung zugeordnet (deposit_ledger_applied_once).
        for (const d of deposits.rows) {
          await client.query(
            `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                         amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                         business_date, applied_invoice_id, created_by)
             VALUES ($1,$2,$3,'applied',$4,$5,$6,$7,$8::date,$9,$10)`,
            [folio.property_id, folio.id, d.deposit_invoice_id, d.amount_gross_cent,
             d.net_cent, d.tax_cent, d.tax_rate_bp, businessDate, inv.rows[0]!.id,
             principal.userId])
        }

        const result = {
          invoiceRef: inv.rows[0]!.public_ref,
          number: inv.rows[0]!.number,
          serviceFrom, serviceTo,
          totals,
          depositsApplied: deposits.rows.map(d => ({
            depositInvoiceNumber: d.deposit_number, amountGrossCent: Number(d.amount_gross_cent)
          }))
        }

        await emitEvent(client, folio.property_id, 'invoice.finalized', {
          invoiceRef: result.invoiceRef,
          number: result.number,
          folioRef,
          kind: body.kind ?? 'final',
          serviceFrom, serviceTo,
          grossCent: totals.grossCent
        })

        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })
}
