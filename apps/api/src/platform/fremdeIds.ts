import type { PoolClient } from '@hotelpms/db'
import { Errors } from './errors.js'

/**
 * Kennungen aus dem Rumpf, bevor sie geschrieben werden.
 *
 * **Der Befund (M4, Sicherheitsaudit 2026-10-11).** Eine Fremdschluessel-
 * pruefung liest die Zieltabelle an der Zeilenrichtlinie vorbei: ein
 * `INSERT ... primary_guest_id = 4711` gelingt, sobald es den Gast 4711
 * **irgendwo** gibt, auch bei einem anderen Kunden. Lesen konnte der Aufrufer
 * ihn danach nicht -- aber er hing an seiner Reservierung, und
 * `guest_document_purge()` rechnete die Abreise dieser Reservierung in die
 * Frist der fremden Ausweisnummer ein. Im selben Betrieb flossen ausserdem
 * Preise aus dem Ratenplan eines anderen Hauses ein, weil die
 * Zeilenrichtlinie nach Mandant filtert und nicht nach Haus.
 *
 * **Darum hier aufgeloest, im Kontext.** Jede Pruefung laeuft in der
 * Transaktion der Route, also mit gesetztem Mandantenkontext, und fragt
 * zusaetzlich nach dem Haus bzw. dem Betrieb des Hauses. Was fremd ist und
 * was es gar nicht gibt, bekommt **dieselbe** Antwort: eine Meldung, die
 * beides unterscheidet, waere ein Werkzeug, fremde Kennungen abzuzaehlen.
 */

/**
 * Gaeste gehoeren zum Betrieb (Account) des Hauses.
 *
 * Gegen den Account des Hauses und nicht nur gegen die Zeilenrichtlinie:
 * wer in zwei Betrieben arbeitet, hat beide im Kontext, und die Richtlinie
 * liesse den Gast des einen an die Reservierung des anderen.
 */
export async function gaesteImBetrieb(
  client: PoolClient, propertyId: number, guestIds: Array<number | null | undefined>
): Promise<void> {
  const ids = [...new Set(guestIds.filter((g): g is number => g !== null && g !== undefined))]
  if (ids.length === 0) return
  if (ids.some(g => !Number.isSafeInteger(g))) throw Errors.notFound('res.guest')
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM guest g
      WHERE g.id = ANY($1::bigint[])
        AND g.account_id = (SELECT p.account_id FROM property p WHERE p.id = $2)`,
    [ids, propertyId])
  if (r.rows[0]!.n !== ids.length) throw Errors.notFound('res.guest')
}

/**
 * Einen Gast ueber seine oeffentliche Referenz finden -- im Betrieb des Hauses.
 * Aus demselben Grund wie oben: die Referenz allein findet auch den Gast des
 * zweiten Betriebs, in dem der Aufrufer arbeitet.
 */
export async function gastPerRefImBetrieb(
  client: PoolClient, propertyId: number, guestRef: string
): Promise<number> {
  const g = await client.query<{ id: number }>(
    `SELECT g.id FROM guest g
      WHERE g.public_ref = $1
        AND g.account_id = (SELECT p.account_id FROM property p WHERE p.id = $2)`,
    [guestRef, propertyId])
  if (g.rowCount === 0) throw Errors.notFound('res.guest')
  return g.rows[0]!.id
}

/** Der Ratenplan gehoert zu genau diesem Haus -- sein Preis gilt nur dort. */
export async function ratenplanImHaus(
  client: PoolClient, propertyId: number, ratePlanId: number | null | undefined
): Promise<void> {
  if (ratePlanId === null || ratePlanId === undefined) return
  if (!Number.isSafeInteger(ratePlanId)) throw Errors.notFound('res.ratePlan')
  const r = await client.query(
    `SELECT 1 FROM rate_plan WHERE id = $1 AND property_id = $2`, [ratePlanId, propertyId])
  if (r.rowCount === 0) throw Errors.notFound('res.ratePlan')
}

/** Die Firma gehoert zum Betrieb des Hauses; Firmen fuehrt der Account, nicht das Haus. */
export async function firmaImBetrieb(
  client: PoolClient, propertyId: number, companyId: number | null | undefined
): Promise<void> {
  if (companyId === null || companyId === undefined) return
  if (!Number.isSafeInteger(companyId)) throw Errors.notFound('res.company')
  const r = await client.query(
    `SELECT 1 FROM company c
      WHERE c.id = $1
        AND c.account_id = (SELECT p.account_id FROM property p WHERE p.id = $2)`,
    [companyId, propertyId])
  if (r.rowCount === 0) throw Errors.notFound('res.company')
}

/** Der Artikel gehoert zu genau diesem Haus -- Preis und Steuer sind je Haus gepflegt. */
export async function produktImHaus(
  client: PoolClient, propertyId: number, productId: number | null | undefined
): Promise<void> {
  if (productId === null || productId === undefined) return
  if (!Number.isSafeInteger(productId)) throw Errors.notFound('res.product')
  const r = await client.query(
    `SELECT 1 FROM product WHERE id = $1 AND property_id = $2`, [productId, propertyId])
  if (r.rowCount === 0) throw Errors.notFound('res.product')
}
