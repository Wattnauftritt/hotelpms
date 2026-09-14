import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { emitEvent } from '../platform/events.js'
import { isTrainingProperty, TRAINING_PREFIX } from '../platform/training.js'
import { expectedRateMix, splitDeposit, depositTaxGroups, blockingFindings,
         type ExpectedItem, type RateGroupAmount, type DepositTaxGroup, type Party }
  from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'
import type { Principal } from '../platform/context.js'

/**
 * Anzahlungen (Aufgabe 3, B4 in Dokument 13).
 *
 * Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Umsatzsteuer auf eine
 * Anzahlung mit der **Vereinnahmung**. Das Haus schuldet sie also im Monat
 * des Geldeingangs, oft Monate bevor der Gast anreist. Drei Dinge folgen
 * daraus, und alle drei stehen hier:
 *
 * 1. Eine Anzahlung braucht eine **Rechnung** mit Steuerausweis je Satz
 *    (§ 14 Abs. 5 UStG), keinen blossen Zahlungsvermerk.
 * 2. Der Steuerzeitpunkt ist der **Eingang**, nicht die Ausstellung. Das
 *    Anzahlungsbuch haelt ihn fest, und der DATEV-Export bucht danach.
 * 3. Die Schlussrechnung lautet ueber den **vollen** Betrag und setzt die
 *    Anzahlung samt Steuer ab (§ 14 Abs. 5 Satz 2 UStG). Sie mindert die
 *    Rechnung, nicht die Leistung.
 */

/**
 * Erhaltene, versteuerte Anzahlungen (SKR03 1718, SKR04 3270).
 *
 * Bewusst **kein** Erloeskonto: eine Anzahlung ist eine Verbindlichkeit,
 * bis geleistet wurde. Auf einem Erloeskonto verfaelschte sie jede
 * Umsatzauswertung und liesse das Haus im Januar reich aussehen, weil im
 * Mai jemand anreist.
 */
export const ANZAHLUNG_KONTO = '1718'

/** Ermaessigter Satz als Rueckfall, wie im Nachtlauf. */
const VAT_FALLBACK = 700

interface DepositBody {
  grossCent: number
  description?: string
  revenueAccount?: string
  /** Ausdrueckliche Aufteilung. Ueberschreibt die Ableitung aus dem Aufenthalt. */
  lines?: Array<{ grossCent: number; taxRateBp: number }>
}

/**
 * Leitet die erwartete Zusammensetzung des Aufenthalts nach Steuersaetzen
 * ab: die Grundlage, in deren Verhaeltnis die Anzahlung aufgeteilt wird.
 *
 * Gerechnet wird mit dem **geplanten** Aufenthalt, nicht mit dem schon
 * Gebuchten. Fuer die Aufteilung zaehlt nur das Verhaeltnis, und der Plan
 * kennt es auch dann, wenn noch keine einzige Nacht gebucht ist -- der
 * Regelfall bei einer Anzahlung, die bei der Buchung gefordert wird.
 */
export async function expectedMixForFolio(
  client: PoolClient, propertyId: number, folioId: number
): Promise<RateGroupAmount[]> {
  const r = await client.query<{ reservation_id: number | null; rate_plan_id: number | null
                                 naechte: number; logis_cent: number; personen: number }>(
    `SELECT res.id AS reservation_id, res.rate_plan_id,
            (res.departure - res.arrival) AS naechte,
            COALESCE((SELECT sum(rn.price_cent) FROM reservation_night rn
                       WHERE rn.reservation_id = res.id), 0)::bigint AS logis_cent,
            GREATEST((SELECT count(*) FROM reservation_occupant o
                       WHERE o.reservation_id = res.id), 1)::int AS personen
       FROM folio f JOIN reservation res ON res.id = f.reservation_id
      WHERE f.id = $1 AND f.property_id = $2`,
    [folioId, propertyId])
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

/** Der Saldo des Anzahlungsbuchs zu einem Folio. */
async function ledgerBalance(
  client: PoolClient, folioId: number
): Promise<{ balanceCent: number; entries: unknown[] }> {
  const { rows } = await client.query(
    `SELECT d.kind, d.amount_cent AS "amountCent", d.business_date::text AS "businessDate",
            i.number AS "depositInvoiceNumber", i.public_ref AS "depositInvoiceRef"
       FROM deposit_ledger d JOIN invoice i ON i.id = d.deposit_invoice_id
      WHERE d.folio_id = $1 ORDER BY d.id`, [folioId])
  return {
    balanceCent: rows.reduce((s, e) => s + Number(e.amountCent), 0),
    entries: rows
  }
}

/**
 * Vermerkt die Vereinnahmung einer Anzahlung.
 *
 * Der Geschaeftstag dieser Zeile ist der Steuerzeitpunkt. Er kommt vom
 * Zahlungsvermerk und nicht von der Rechnung: die Anzahlungsrechnung kann
 * Wochen frueher ausgestellt sein, und bis zum Eingang ist nichts
 * geschuldet.
 */
export async function recordDepositReceipt(
  client: PoolClient, opts: {
    propertyId: number; folioId: number; depositInvoiceId: number
    settlementId: number; amountCent: number; businessDate: string; userId: number | null
  }
): Promise<void> {
  await client.query(
    `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                 amount_cent, business_date, settlement_id, created_by)
     VALUES ($1,$2,$3,'received',$4,$5::date,$6,$7)
     ON CONFLICT (deposit_invoice_id, kind) WHERE kind IN ('received','applied')
     DO NOTHING`,
    [opts.propertyId, opts.folioId, opts.depositInvoiceId, opts.amountCent,
     opts.businessDate, opts.settlementId, opts.userId])
}

export interface DepositDeduction {
  chargeIds: number[]
  grossCent: number
  invoiceIds: number[]
}

/**
 * Setzt vereinnahmte Anzahlungen auf der Schlussrechnung ab.
 *
 * Als eigene Positionen mit negativem Betrag und Verweis auf die
 * Anzahlungsrechnung, je Steuersatz getrennt: abgesetzt wird genau das,
 * was dort ausgewiesen wurde. Ein Sammelbetrag ohne Satzaufteilung waere
 * fuer den Empfaenger nicht nachvollziehbar und fuer das Finanzamt nicht
 * pruefbar.
 *
 * Ohne Zeilensperre auf dem Anzahlungsbuch, und das mit Absicht: die Tabelle
 * ist Haertegrad 1, die Anwendungsrolle hat kein UPDATE, und `FOR UPDATE`
 * verlangt genau dieses Recht. Serialisiert wird ueber das Folio, das der
 * Rechnungslauf ohnehin sperrt; die eindeutige Sperre im Anzahlungsbuch
 * faengt den Rest ab.
 */
export async function deductDeposits(
  client: PoolClient, opts: {
    propertyId: number; folioId: number; businessDate: string; userId: number | null
  }
): Promise<DepositDeduction> {
  const offen = await client.query<{ deposit_invoice_id: number; number: string
                                     totals: { groups: DepositTaxGroup[] } }>(
    `SELECT d.deposit_invoice_id, i.number, i.totals
       FROM deposit_ledger d
       JOIN invoice i ON i.id = d.deposit_invoice_id
      WHERE d.folio_id = $1 AND d.kind = 'received'
        AND NOT EXISTS (SELECT 1 FROM deposit_ledger a
                         WHERE a.deposit_invoice_id = d.deposit_invoice_id
                           AND a.kind = 'applied')
      ORDER BY d.id`,
    [opts.folioId])

  const chargeIds: number[] = []
  const invoiceIds: number[] = []
  let gesamt = 0

  for (const anzahlung of offen.rows) {
    for (const g of anzahlung.totals.groups) {
      const brutto = Number(g.grossCent)
      if (brutto === 0) continue
      const r = await client.query<{ id: number }>(
        `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                             net_cent, tax_cent, gross_cent, tax_rate_bp,
                             revenue_account, deposit_invoice_id, created_by)
         VALUES ($1,$2,$3::date,$4,1,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [opts.propertyId, opts.folioId, opts.businessDate,
         `Anrechnung Anzahlung ${anzahlung.number}`,
         -Number(g.netCent), -Number(g.taxCent), -brutto, g.rateBp,
         ANZAHLUNG_KONTO, anzahlung.deposit_invoice_id, opts.userId])
      chargeIds.push(r.rows[0]!.id)
      gesamt += brutto
    }
    invoiceIds.push(anzahlung.deposit_invoice_id)
  }

  return { chargeIds, grossCent: gesamt, invoiceIds }
}

/** Vermerkt die Anrechnung im Anzahlungsbuch. */
export async function recordDepositApplication(
  client: PoolClient, opts: {
    propertyId: number; folioId: number; depositInvoiceIds: number[]
    finalInvoiceId: number; businessDate: string; userId: number | null
  }
): Promise<void> {
  for (const id of opts.depositInvoiceIds) {
    await client.query(
      `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                   amount_cent, business_date, applied_invoice_id, created_by)
       SELECT $1, $2, $3, 'applied', -d.amount_cent, $4::date, $5, $6
         FROM deposit_ledger d
        WHERE d.deposit_invoice_id = $3 AND d.kind = 'received'`,
      [opts.propertyId, opts.folioId, id, opts.businessDate, opts.finalInvoiceId,
       opts.userId])
  }
}

export function depositRoutes(app: FastifyInstance): void {
  /**
   * Die Anzahlungsrechnung.
   *
   * Sie traegt eine Nummer aus **demselben** Zaehler wie jede andere
   * Rechnung: § 14 Abs. 4 Nr. 4 UStG verlangt eine einmalige, fortlaufende
   * Nummer, und ein zweiter Kreis fuer Anzahlungen waere genau die Luecke,
   * die ein Pruefer sucht.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/deposit-invoice',
    permission: 'invoice:issue',
    summary: 'Anzahlung anfordern, als Anzahlungsrechnung',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as DepositBody
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })

      if (!Number.isInteger(body.grossCent) || body.grossCent <= 0) {
        throw Errors.validation({ grossCent: ['Ganze Cent, groesser als null'] })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string
                                       guest_id: number | null; company_id: number | null }>(
          `SELECT id, property_id, status, guest_id, company_id FROM folio
            WHERE public_ref = $1 FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('Folio')
        const folio = f.rows[0]!
        if (folio.status === 'closed') {
          throw Errors.conflict('Das Folio ist geschlossen.')
        }

        /*
         * Die Aufteilung auf die Steuersaetze. Entweder ausdruecklich
         * angegeben -- dann hat jemand hingesehen -- oder im Verhaeltnis
         * der erwarteten Leistung abgeleitet.
         */
        let teile: RateGroupAmount[]
        if (body.lines?.length) {
          const summe = body.lines.reduce((s, l) => s + l.grossCent, 0)
          if (summe !== body.grossCent) {
            throw Errors.validation({ lines: [
              `Die Teile ergeben ${summe} Cent, angefordert sind ${body.grossCent}.`] })
          }
          teile = body.lines.map(l => ({ rateBp: l.taxRateBp, grossCent: l.grossCent }))
        } else {
          const mix = await expectedMixForFolio(client, folio.property_id, folio.id)
          if (mix.length === 0) {
            throw Errors.unprocessable(
              'Zu diesem Folio ist kein Aufenthalt mit Preisen hinterlegt, aus dem sich '
              + 'die Steuersaetze ableiten liessen. Bitte die Aufteilung als lines mitgeben.')
          }
          teile = splitDeposit(body.grossCent, mix)
        }

        /*
         * Brutto herein, Steuer heraus. Eine Anzahlung wird als
         * Bruttobetrag vereinbart -- der Gast ueberweist 200 Euro, nicht
         * 186,92 plus Steuer. Die Summe der Gruppen ist deshalb auf den
         * Cent der angeforderte Betrag; aus den Nettosummen zurueckgerechnet
         * waere sie es in Randfaellen nicht.
         */
        const gruppen = depositTaxGroups(teile)
        const totals = {
          groups: gruppen,
          netCent: gruppen.reduce((s, g) => s + g.netCent, 0),
          taxCent: gruppen.reduce((s, g) => s + g.taxCent, 0),
          grossCent: gruppen.reduce((s, g) => s + g.grossCent, 0)
        }

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

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [folio.property_id])
        const businessDate = bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10)

        /*
         * Leistungszeitraum der Anzahlung: der Aufenthalt, auf den sie sich
         * bezieht. § 14 Abs. 5 UStG verlangt bei einer Anzahlungsrechnung
         * den Zeitpunkt der Vereinnahmung **oder** den voraussichtlichen
         * Leistungszeitraum; der Aufenthalt sagt mehr.
         */
        const zeitraum = await client.query<{ arrival: string; departure: string }>(
          `SELECT res.arrival::text, (res.departure - 1)::text AS departure
             FROM folio f JOIN reservation res ON res.id = f.reservation_id
            WHERE f.id = $1`, [folio.id])
        const serviceFrom = zeitraum.rows[0]?.arrival ?? businessDate
        const serviceTo = zeitraum.rows[0]?.departure ?? businessDate

        const beschreibung = body.description?.trim()
          || `Anzahlung fuer den Aufenthalt ${serviceFrom} bis ${serviceTo}`

        const maengel = blockingFindings({
          number: 'wird gleich vergeben',
          issuedOn: new Date().toISOString().slice(0, 10),
          serviceFrom, serviceTo,
          issuer: prop.rows[0] ?? {},
          recipient: recipient.rows[0] ?? {},
          lines: gruppen.map(g => ({
            description: beschreibung, quantity: 1, netCent: g.netCent, rateBp: g.rateBp })),
          grossCent: totals.grossCent,
          kind: 'deposit'
        })
        if (maengel.length > 0) {
          throw Errors.unprocessable(
            'Die Anzahlungsrechnung erfüllt die Pflichtangaben nicht: '
            + maengel.map(m => `${m.de} (${m.reference})`).join(' '))
        }

        const year = new Date().getUTCFullYear()
        if (await isTrainingProperty(client, folio.property_id)) {
          await client.query(
            `INSERT INTO invoice_counter (property_id, year, prefix)
             VALUES ($1,$2,$3) ON CONFLICT (property_id, year) DO NOTHING`,
            [folio.property_id, year, TRAINING_PREFIX])
        }
        const num = await client.query<{ next_invoice_number: string }>(
          `SELECT next_invoice_number($1, $2)`, [folio.property_id, year])

        const inv = await client.query<{ id: number; public_ref: string; number: string }>(
          `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                                service_from, service_to,
                                issuer_snapshot, recipient_snapshot, totals, created_by)
           VALUES ($1,$2,$3,current_date,$4::date,'deposit',$5::date,$6::date,$7,$8,$9,$10)
           RETURNING id, public_ref, number`,
          [folio.property_id, folio.id, num.rows[0]!.next_invoice_number, businessDate,
           serviceFrom, serviceTo,
           JSON.stringify(prop.rows[0] ?? {}), JSON.stringify(recipient.rows[0] ?? {}),
           JSON.stringify(totals), principal.userId])

        /*
         * Die Anzahlung bekommt Positionen auf dem Anzahlungskonto, nicht
         * auf einem Erloeskonto. Ohne Positionen fiele sie aus dem
         * DATEV-Stapel heraus, der ueber charge geht -- die Steuer waere
         * ausgewiesen und nirgends gebucht.
         */
        const chargeIds: number[] = []
        for (const g of gruppen) {
          const c = await client.query<{ id: number }>(
            `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                                 net_cent, tax_cent, gross_cent, tax_rate_bp,
                                 revenue_account, created_by)
             VALUES ($1,$2,$3::date,$4,1,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [folio.property_id, folio.id, businessDate, beschreibung,
             g.netCent, g.taxCent, g.grossCent, g.rateBp,
             body.revenueAccount ?? ANZAHLUNG_KONTO, principal.userId])
          chargeIds.push(c.rows[0]!.id)
        }
        await client.query(
          `UPDATE charge SET invoice_id = $2 WHERE id = ANY($1)`,
          [chargeIds, inv.rows[0]!.id])

        const result = {
          invoiceRef: inv.rows[0]!.public_ref,
          number: inv.rows[0]!.number,
          grossCent: totals.grossCent,
          groups: gruppen,
          serviceFrom, serviceTo,
          hinweis: 'Die Steuer entsteht mit der Vereinnahmung, nicht mit dieser Rechnung '
                 + '(§ 13 Abs. 1 Nr. 1a UStG). Der Zahlungseingang wird als '
                 + 'Zahlungsvermerk mit invoiceRef erfasst.'
        }

        await emitEvent(client, folio.property_id, 'invoice.finalized', {
          invoiceRef: result.invoiceRef, number: result.number, folioRef,
          kind: 'deposit', serviceFrom, serviceTo, grossCent: totals.grossCent
        })

        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Der Anzahlungssaldo: was das Haus vereinnahmt hat, ohne geleistet zu
   * haben. Eine andere Frage als der Folio-Saldo, und deshalb eine eigene
   * Auskunft.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/folios/:folioRef/deposits',
    permission: 'folio:read',
    summary: 'Anzahlungen und ihr Saldo zu einem Folio',
    handler: async (req) => {
      const { folioRef } = req.params as { folioRef: string }
      return tx(req.pool, req, async client => {
        const f = await client.query<{ id: number }>(
          `SELECT id FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('Folio')
        return ledgerBalance(client, f.rows[0]!.id)
      })
    }
  })
}
