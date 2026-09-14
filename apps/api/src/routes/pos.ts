import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { taxFromGross } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'
import type { Principal } from '../platform/context.js'

/**
 * Kassenschnittstelle (Aufgabe 7, Dokument 09, Abschnitt 5).
 *
 * Das Haus hat eine Ladenkasse mit TSE, und dieses System wird keine. Was
 * es braucht, ist der Vertrag mit ihr, in beide Richtungen:
 *
 *   Kasse zum PMS   Ein Umsatz laeuft auf ein Zimmer, der klassische
 *                   Zimmerbon. Er wird hier zu einer gewoehnlichen Position
 *                   auf dem Gastkonto, mit einem Verweis auf den Beleg der
 *                   Kasse.
 *   PMS zur Kasse   Die offenen Folios mit Zimmernummer und Gastnamen,
 *                   damit die Kasse ueberhaupt zuordnen kann.
 *
 * **Was hier ausdruecklich nicht entsteht.** Kein Kassenbestand, kein Bon,
 * keine Zahlung. Ein Zimmerbon ist keine Abrechnung, sondern ihre
 * Verschiebung: der Gast zahlt beim Check-out, und bis dahin ist der Umsatz
 * eine Forderung. Wer hier eine Zahlung entgegennaehme, machte aus dem PMS
 * genau das Aufzeichnungssystem, das es nach Entscheidung 9 nicht sein
 * soll -- und zwar mit allen Folgen aus § 146a AO.
 *
 * **Kein eigener Zugangsweg.** Die Kasse bekommt einen Maschinenzugang mit
 * den Zugriffsbereichen `folio:read` und `folio:post` (Aufgabe 2). Ein
 * dritter Anmeldeweg neben Sitzung und Token waere eine dritte Stelle, an
 * der eine Berechtigungspruefung fehlen kann.
 */

/** Eine Liste offener Folios ist durch die Hausgroesse begrenzt -- aber nur
 *  fast: Haus- und Gruppenfolios sammeln sich ueber Jahre an. */
const MAX_FOLIOS = 500

interface ChargeBody {
  /** Zimmernummer, wie sie an der Kasse eingetippt wird. */
  room?: string
  /** Alternativ das Folio direkt, wenn die Kasse es aus der Liste kennt. */
  folioRef?: string
  /** Artikel aus den Stammdaten des Hauses. Bestimmt Erloeskonto und Satz. */
  productCode: string
  /** Belegnummer der Kasse. Dort liegt das Original. */
  reference: string
  /** Bruttobetrag der **ganzen** Position in Cent, nicht je Einheit.
   *  Eine Kasse rechnet brutto. */
  grossCent: number
  quantity?: number
  description?: string
  /** Ueberschreibt den Satz des Artikels, siehe unten. */
  taxRateBp?: number
}

interface FolioTreffer {
  id: number
  public_ref: string
  reservation_id: number | null
  bezeichnung: string
  room: string | null
}

/**
 * Sucht das Folio zur Zimmernummer.
 *
 * Zwei Faelle, die auseinandergehalten werden muessen, weil sie an der
 * Kasse verschiedene Handgriffe verlangen: ein Zimmer, das es nicht gibt
 * (vertippt), und ein Zimmer ohne angereisten Gast (falsches Zimmer, oder
 * der Check-in fehlt noch). Eine gemeinsame Meldung „nicht gefunden" liesse
 * den Kellner raten.
 */
async function folioByRoom(
  client: PoolClient, propertyId: number, room: string
): Promise<FolioTreffer[]> {
  const zimmer = await client.query<{ id: number }>(
    `SELECT id FROM resource WHERE property_id = $1 AND upper(code) = upper($2)`,
    [propertyId, room])
  if (zimmer.rowCount === 0) {
    throw Errors.unprocessable(`Zimmer ${room} gibt es in diesem Haus nicht.`)
  }

  const r = await client.query<FolioTreffer>(
    `SELECT f.id, f.public_ref, f.reservation_id,
            trim(both ', ' from
              coalesce(g.last_name,'') || ', ' || coalesce(g.first_name,'')) AS bezeichnung,
            res.code AS room
       FROM reservation r
       JOIN resource res ON res.id = r.resource_id
       JOIN folio f ON f.reservation_id = r.id AND f.status = 'open'
       LEFT JOIN guest g ON g.id = f.guest_id
      WHERE r.property_id = $1 AND res.id = $2 AND r.status = 'InHouse'
      ORDER BY f.id`,
    [propertyId, zimmer.rows[0]!.id])

  if (r.rowCount === 0) {
    throw Errors.unprocessable(
      `Auf Zimmer ${room} ist niemand angereist. Fehlt der Check-in?`)
  }
  return r.rows
}

async function folioByRef(
  client: PoolClient, propertyId: number, folioRef: string
): Promise<FolioTreffer> {
  const r = await client.query<FolioTreffer & { status: string }>(
    `SELECT f.id, f.public_ref, f.reservation_id, f.status,
            coalesce(c.name,
              trim(both ', ' from
                coalesce(g.last_name,'') || ', ' || coalesce(g.first_name,'')),
              f.label, '') AS bezeichnung,
            res.code AS room
       FROM folio f
       LEFT JOIN guest g ON g.id = f.guest_id
       LEFT JOIN company c ON c.id = f.company_id
       LEFT JOIN reservation r ON r.id = f.reservation_id
       LEFT JOIN resource res ON res.id = r.resource_id
      WHERE f.public_ref = $1 AND f.property_id = $2`,
    [folioRef, propertyId])
  if (r.rowCount === 0) throw Errors.notFound('Folio')
  if (r.rows[0]!.status === 'closed') {
    throw Errors.conflict('Das Folio ist geschlossen und nimmt nichts mehr auf.')
  }
  return r.rows[0]!
}

/**
 * Wendet die Umleitungsregeln der Reservierung an.
 *
 * Umleitung ist genau fuer diesen Fall gemacht: die Firma zahlt die
 * Uebernachtung, die Getraenke zahlt der Gast -- oder umgekehrt. Wenn eine
 * Regel hinterlegt ist und ausgerechnet die Kassenbuchung sie ignoriert,
 * muss die Rezeption beim Check-out jede Position von Hand umtragen, und
 * die Regel war wertlos.
 *
 * Die genauere Regel gewinnt: Artikel vor Erloeskonto vor „alles". Ein
 * geschlossenes Zielfolio bleibt unberuecksichtigt -- es ist bereits
 * abgerechnet, und ein spaeter Umsatz gehoert dann auf das Gastkonto und
 * nicht in eine Rechnung, die schon beim Kunden liegt.
 */
async function applyRouting(
  client: PoolClient, propertyId: number, reservationId: number | null,
  productCode: string, revenueAccount: string
): Promise<{ id: number; public_ref: string } | null> {
  if (reservationId === null) return null
  const r = await client.query<{ id: number; public_ref: string }>(
    // Haus ausdruecklich mitgeprueft: die Zeilenrichtlinie filtert nach
    // Mandant, und ein Account kann mehrere Haeuser haben.
    `SELECT tf.id, tf.public_ref
       FROM routing_rule x
       JOIN folio tf ON tf.id = x.target_folio_id AND tf.status = 'open'
                    AND tf.property_id = $4
      WHERE x.reservation_id = $1 AND x.property_id = $4
        AND (x.match_kind = 'all'
             OR (x.match_kind = 'product' AND x.match_value = $2)
             OR (x.match_kind = 'account' AND x.match_value = $3))
      ORDER BY CASE x.match_kind
                 WHEN 'product' THEN 0 WHEN 'account' THEN 1 ELSE 2 END, x.id
      LIMIT 1`,
    [reservationId, productCode, revenueAccount, propertyId])
  return r.rows[0] ?? null
}

async function businessDate(client: PoolClient, propertyId: number): Promise<string> {
  const bd = await client.query<{ date: string }>(
    `SELECT date::text FROM business_day
      WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
    [propertyId])
  return bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10)
}

export function posRoutes(app: FastifyInstance): void {
  /**
   * Richtung PMS zur Kasse: was ist offen, und wer liegt da.
   *
   * Ein Aufruf fuer den ganzen Bildschirm der Kasse, mit Saldo. Wer die
   * Salden je Zeile nachlaedt, macht aus einer Runde dreihundert -- und die
   * Kasse fragt diese Liste bei jedem Bon.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/pos/folios',
    permission: 'folio:read',
    propertyParam: 'propertyId',
    summary: 'Offene Folios fuer die Kasse, mit Zimmer und Gastname',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { room } = req.query as { room?: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT f.public_ref AS "folioRef",
                  res.code AS room,
                  coalesce(c.name,
                    trim(both ', ' from
                      coalesce(g.last_name,'') || ', ' || coalesce(g.first_name,'')),
                    f.label, '') AS name,
                  f.kind,
                  r.departure::text AS departure,
                  (coalesce(ch.gross, 0) - coalesce(st.betrag, 0))::bigint AS "balanceCent"
             FROM folio f
             LEFT JOIN guest g ON g.id = f.guest_id
             LEFT JOIN company c ON c.id = f.company_id
             LEFT JOIN reservation r ON r.id = f.reservation_id
             LEFT JOIN resource res ON res.id = r.resource_id
             LEFT JOIN LATERAL (
               SELECT sum(gross_cent) AS gross FROM charge WHERE folio_id = f.id
             ) ch ON true
             LEFT JOIN LATERAL (
               SELECT sum(amount_cent) AS betrag FROM settlement WHERE folio_id = f.id
             ) st ON true
            WHERE f.property_id = $1 AND f.status = 'open'
              AND ($2::text IS NULL OR upper(res.code) = upper($2::text))
            ORDER BY res.code NULLS LAST, f.id
            LIMIT ${MAX_FOLIOS}`,
          [Number(propertyId), room ?? null])
        return { folios: rows }
      })
    }
  })

  /**
   * Richtung Kasse zum PMS: der Zimmerbon.
   *
   * Doppelt gegen Doppelbuchung gesichert, und beide Sicherungen werden
   * gebraucht: der Idempotenzschluessel faengt die Wiederholung derselben
   * Anfrage, der eindeutige Index ueber die Belegnummer der Kasse faengt
   * auch die Wiederholung nach einem Neustart, bei der die Kasse einen
   * neuen Schluessel bildet, ihre Belegnummer aber behaelt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/pos/charges',
    permission: 'folio:post',
    propertyParam: 'propertyId',
    summary: 'Kassenumsatz auf ein Folio buchen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const body = req.body as ChargeBody
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })

      const fehler: Record<string, string[]> = {}
      if (!body.productCode) fehler.productCode = ['Pflichtfeld']
      if (!body.reference) fehler.reference = ['Belegnummer der Kasse ist Pflichtfeld']
      if (!Number.isInteger(body.grossCent) || body.grossCent <= 0) {
        fehler.grossCent = ['Ganze Cent, groesser als null. Eine Gutschrift laeuft ueber /reverse']
      }
      if (body.quantity !== undefined
          && (!Number.isInteger(body.quantity) || body.quantity <= 0)) {
        fehler.quantity = ['Ganze Zahl, groesser als null']
      }
      if (!body.room && !body.folioRef) {
        fehler.room = ['Zimmernummer oder folioRef noetig']
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const property = Number(propertyId)

        /*
         * Der Artikel kommt aus den Stammdaten des Hauses, nicht aus der
         * Anfrage: Erloeskonto und Steuersatz gehoeren dorthin, wo auch der
         * DATEV-Export und die Umsatzberichte sie lesen. Ein unbekanntes
         * Kuerzel wird abgewiesen und nicht auf ein Standardkonto gebucht --
         * derselbe Grund wie bei der No-Show-Gebuehr: auf dem Logiskonto
         * verfaelschte ein Getraenkeumsatz ADR und RevPAR.
         */
        const p = await client.query<{ id: number; name: string
                                       revenue_account: string; rate_bp: number | null }>(
          `SELECT p.id, p.name, p.revenue_account, tr.rate_bp
             FROM product p LEFT JOIN tax_rule tr ON tr.id = p.tax_rule_id
            WHERE p.property_id = $1 AND p.code = $2 AND p.active`,
          [property, body.productCode])
        if (p.rowCount === 0) {
          throw Errors.unprocessable(
            `Artikel ${body.productCode} ist in diesem Haus nicht eingerichtet. `
            + 'Er braucht ein Erloeskonto und einen Steuersatz, bevor die Kasse darauf buchen kann.')
        }
        const artikel = p.rows[0]!

        /*
         * Der Satz der Kasse gewinnt, wenn sie einen schickt. Sie kennt den
         * Vorgang genauer als die Stammdaten: dasselbe Getraenk ist im Haus
         * 19 und ausser Haus 7 Prozent, und die Kasse weiss, was der Gast
         * getan hat. Weicht ihr Beleg von unserer Rechnung ab, faellt das
         * bei einer Pruefung auf uns zurueck.
         */
        const rateBp = body.taxRateBp ?? artikel.rate_bp
        if (rateBp === null || !Number.isInteger(rateBp) || rateBp < 0) {
          throw Errors.unprocessable(
            `Fuer ${body.productCode} ist kein Steuersatz hinterlegt. `
            + 'Entweder am Artikel einrichten oder als taxRateBp mitschicken.')
        }

        const treffer = body.folioRef
          ? [await folioByRef(client, property, body.folioRef)]
          : await folioByRoom(client, property, body.room!)
        if (treffer.length > 1) {
          // Zwei angereiste Gaeste im selben Zimmer, etwa bei getrennter
          // Abrechnung. Raten waere hier die schlechteste Antwort: der
          // Umsatz landete beim Falschen, und auffallen wuerde es beim
          // Check-out des Anderen.
          throw Errors.conflict(
            `Auf Zimmer ${body.room} sind mehrere Gaeste angereist. `
            + 'Bitte folioRef mitschicken: '
            + treffer.map(t => `${t.public_ref} (${t.bezeichnung})`).join(', '))
        }
        const folio = treffer[0]!

        const ziel = await applyRouting(
          client, property, folio.reservation_id, body.productCode, artikel.revenue_account)
        const folioId = ziel?.id ?? folio.id

        const menge = body.quantity ?? 1
        const brutto = body.grossCent
        const steuer = taxFromGross(brutto, rateBp)

        /*
         * Brutto herein, netto und Steuer heraus. Eine Kasse rechnet in
         * Bruttopreisen, weil die Karte brutto ausgezeichnet ist; rechnete
         * sie selbst um, stuende auf der Hotelrechnung ein anderer Betrag
         * als auf dem Kassenbeleg, den der Gast in der Tasche hat.
         */
        const r = await client.query<{ id: number }>(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp,
                               revenue_account, product_id, reservation_id,
                               source, external_reference)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pos',$13)
           ON CONFLICT (property_id, source, external_reference)
             WHERE external_reference IS NOT NULL DO NOTHING
           RETURNING id`,
          [property, folioId, await businessDate(client, property),
           body.description?.trim() || artikel.name, menge,
           brutto - steuer, steuer, brutto, rateBp,
           // Der Bezug zur Reservierung bleibt auch dann erhalten, wenn die
           // Position auf ein fremdes Folio umgeleitet wurde: sonst fehlte
           // der Umsatz in jeder Auswertung je Aufenthalt.
           artikel.revenue_account, artikel.id, folio.reservation_id, body.reference])

        if (r.rowCount === 0) {
          /*
           * Die Kasse hat denselben Beleg schon einmal zugestellt. Das ist
           * kein Fehler, sondern der Regelfall nach einem Netzabbruch: sie
           * bekommt dieselbe Antwort wie beim ersten Mal und hoert auf zu
           * wiederholen. Ein 409 haette dieselbe Kasse in eine Schleife
           * geschickt oder den Umsatz verloren.
           */
          const vorhanden = await client.query<{ id: number; folio_ref: string
                                                 gross_cent: number }>(
            `SELECT c.id, f.public_ref AS folio_ref, c.gross_cent
               FROM charge c JOIN folio f ON f.id = c.folio_id
              WHERE c.property_id = $1 AND c.source = 'pos' AND c.external_reference = $2`,
            [property, body.reference])
          const doppelt = vorhanden.rows[0]!
          const antwort = {
            chargeId: doppelt.id, folioRef: doppelt.folio_ref,
            grossCent: doppelt.gross_cent, duplicate: true
          }
          await completeIdempotent(client, principal.clientKey, key, 200, antwort)
          return antwort
        }

        const result = {
          chargeId: r.rows[0]!.id,
          folioRef: ziel?.public_ref ?? folio.public_ref,
          routed: ziel !== null,
          grossCent: brutto,
          netCent: brutto - steuer,
          taxCent: steuer,
          taxRateBp: rateBp,
          revenueAccount: artikel.revenue_account,
          duplicate: false
        }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Der Storno der Kasse.
   *
   * Ein an der Bar vertipptes Zimmer ist Alltag, und die Korrektur muss
   * denselben Weg nehmen wie die Buchung -- sonst muss die Rezeption sie
   * von Hand nachbilden und merkt erst beim Check-out, dass sie es nicht
   * getan hat.
   *
   * Gegenbuchung, keine Aenderung: charge ist Haertegrad 1. Die
   * Gegenbuchung traegt die Stornonummer der Kasse und zeigt ueber
   * reverses_id auf das Original, damit beide Zeilen als Paar erkennbar
   * bleiben.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/pos/charges/reverse',
    permission: 'folio:post',
    propertyParam: 'propertyId',
    summary: 'Kassenumsatz stornieren, als Gegenbuchung',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const body = req.body as { reference: string; reversalReference: string; reason?: string }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })
      if (!body.reference || !body.reversalReference) {
        throw Errors.validation({
          reference: ['Belegnummer des Originals'],
          reversalReference: ['Belegnummer des Stornos']
        })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }
        const property = Number(propertyId)

        const o = await client.query<{
          id: number; folio_id: number; description: string; quantity: number
          net_cent: number; tax_cent: number; gross_cent: number; tax_rate_bp: number
          revenue_account: string; product_id: number | null; reservation_id: number | null
        }>(
          `SELECT id, folio_id, description, quantity, net_cent, tax_cent, gross_cent,
                  tax_rate_bp, revenue_account, product_id, reservation_id
             FROM charge
            WHERE property_id = $1 AND source = 'pos' AND external_reference = $2`,
          [property, body.reference])
        if (o.rowCount === 0) {
          throw Errors.notFound(`Kassenumsatz mit der Belegnummer ${body.reference}`)
        }
        const original = o.rows[0]!

        const schon = await client.query<{ id: number }>(
          `SELECT id FROM charge WHERE property_id = $1 AND reverses_id = $2`,
          [property, original.id])
        if (schon.rowCount !== 0) {
          // Wie bei der Buchung: eine Wiederholung ist kein Fehler.
          const antwort = { chargeId: schon.rows[0]!.id, reverses: original.id, duplicate: true }
          await completeIdempotent(client, principal.clientKey, key, 200, antwort)
          return antwort
        }

        const grund = body.reason?.trim()
        const r = await client.query<{ id: number }>(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp,
                               revenue_account, product_id, reservation_id,
                               source, external_reference, reverses_id)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pos',$13,$14)
           RETURNING id`,
          [property, original.folio_id, await businessDate(client, property),
           `Storno ${original.description}${grund ? ` (${grund})` : ''}`,
           original.quantity,
           -original.net_cent, -original.tax_cent, -original.gross_cent,
           original.tax_rate_bp, original.revenue_account, original.product_id,
           original.reservation_id, body.reversalReference, original.id])

        const result = {
          chargeId: r.rows[0]!.id, reverses: original.id,
          grossCent: -original.gross_cent, duplicate: false
        }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })
}
