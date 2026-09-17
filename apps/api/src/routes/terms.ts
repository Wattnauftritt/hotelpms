import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'

/**
 * Hausbedingungen: was ein Haus ueber den Meldeschein hinaus unterschreiben
 * laesst.
 *
 * **Warum das nicht auf den Meldeschein gehoert.** In der Praxis
 * unterschreibt der Gast an der Rezeption oft mehr als seine Meldedaten --
 * eine Pauschale bei Verlust der Zimmerkarte, die Hausordnung, die
 * Haftung fuer Schaeden. Das ist zulaessig, aber es ist eine andere Sache:
 *
 * - Der Meldeschein ist **oeffentlich-rechtlich**, zweckgebunden (Art. 5
 *   Abs. 1 lit. b DSGVO) und wird nach einem Jahr vernichtet (§ 30 Abs. 4
 *   BMG). Seit dem 1.1.2025 unterschreibt ihn nur noch, wer keine deutsche
 *   Staatsangehoerigkeit hat.
 * - Eine Vereinbarung ueber 50 Euro ist **privatrechtlich**, gilt fuer jeden
 *   Gast und muss ueber die Verjaehrung hinaus nachweisbar bleiben.
 *
 * Beides in ein Feld zu schreiben hiesse, entweder den Meldeschein zu lange
 * zu halten oder den Nachweis der Vereinbarung mit ihm zu vernichten. Der
 * inlaendische Gast unterschreibt deshalb weiterhin **keinen** Meldeschein
 * -- aber sehr wohl die Hausbedingung, und genau das ist der Unterschied,
 * den ein Haus in der Praxis braucht.
 *
 * **Versioniert, nicht geaendert.** Wer die Pauschale von 50 auf 60 Euro
 * setzt, legt eine neue Fassung an; die alte Unterschrift behaelt ihren
 * Text. Ein geaenderter Text unter einer alten Unterschrift waere als
 * Nachweis wertlos.
 */

interface TermsBody {
  propertyId: number
  code?: string
  title?: string
  body?: string
  requiresSignature?: boolean
  activeFrom?: string
}

const CODE_MAX = 40
const TITEL_MAX = 200
const TEXT_MAX = 20_000

export function termsRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/terms',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Hausbedingungen des Hauses, alle Fassungen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT public_ref AS "termsRef", code, version, title, body,
                  requires_signature AS "requiresSignature",
                  active_from::text AS "activeFrom", active_to::text AS "activeTo"
             FROM property_terms
            WHERE property_id = $1
            ORDER BY code, version DESC`, [Number(propertyId)])
        return { terms: rows }
      })
    }
  })

  /**
   * Die Fassungen, die am Anreisetag gelten -- das, was die Check-in-Maske
   * vorlegt. Eigene Route mit dem Check-in-Recht, weil die Rezeption sie
   * braucht und `settings:property` nicht hat.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/terms',
    permission: 'reservation:checkin',
    summary: 'Geltende Hausbedingungen und ihr Stand fuer diesen Aufenthalt',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number
                                       arrival: string }>(
          `SELECT id, property_id, arrival::text FROM reservation
            WHERE public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!

        /*
         * Je `code` die Fassung, die am Anreisetag gilt -- nicht die
         * neueste. Wer heute bucht und in drei Monaten anreist, unterschreibt
         * den Text, der dann haengt; ein zwischenzeitlich geaenderter Preis
         * gilt fuer ihn, weil er ihn bei der Ankunft vor sich hat.
         *
         * Ein Aufruf mit einem Verbund, nicht einer je Bedingung: es sind
         * wenige Zeilen, aber der Bildschirm soll nicht je Zeile nachladen.
         */
        const { rows } = await client.query(
          `SELECT DISTINCT ON (t.code)
                  t.public_ref AS "termsRef", t.code, t.version, t.title, t.body,
                  t.requires_signature AS "requiresSignature",
                  a.agreed_at IS NOT NULL AS "agreed",
                  a.agreed_at::text AS "agreedAt",
                  a.signature_svg IS NOT NULL AS "signed"
             FROM property_terms t
             LEFT JOIN guest_agreement a
                    ON a.terms_id = t.id AND a.reservation_id = $2
            WHERE t.property_id = $1
              AND t.active_from <= $3::date
              AND (t.active_to IS NULL OR t.active_to > $3::date)
            ORDER BY t.code, t.version DESC`,
          [res.property_id, res.id, res.arrival])
        return { reservationRef, terms: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terms',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Neue Fassung einer Hausbedingung anlegen',
    handler: async (req, reply) => {
      const body = req.body as TermsBody
      const principal = req.principal as Principal
      const { propertyId } = req.params as { propertyId: string }
      const fehler: Record<string, ['field.required' | 'field.maxLength']> = {}
      if (!body.code || body.code.length > CODE_MAX) fehler.code = ['field.required']
      if (!body.title || body.title.length > TITEL_MAX) fehler.title = ['field.required']
      if (!body.body) fehler.body = ['field.required']
      if (body.body && body.body.length > TEXT_MAX) fehler.body = ['field.maxLength']
      if (Object.keys(fehler).length > 0) {
        throw Errors.validation(fehler, { max: TEXT_MAX })
      }

      return tx(req.pool, req, async client => {
        /*
         * Die neue Fassung beendet die alte am selben Tag, an dem sie
         * beginnt. Ohne das gaelten zwei Fassungen gleichzeitig, und welche
         * der Gast unterschrieben hat, waere eine Frage der Sortierung.
         */
        const vorige = await client.query<{ id: number; version: number }>(
          `SELECT id, version FROM property_terms
            WHERE property_id = $1 AND code = $2 AND active_to IS NULL
            ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [Number(propertyId), body.code])

        const ab = body.activeFrom ?? null
        const neu = await client.query<{ public_ref: string; version: number
                                         active_from: string }>(
          `INSERT INTO property_terms
             (property_id, code, version, title, body, requires_signature,
              active_from, created_by)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, current_date), $8)
           RETURNING public_ref, version, active_from::text`,
          [Number(propertyId), body.code, (vorige.rows[0]?.version ?? 0) + 1,
           body.title, body.body, body.requiresSignature ?? true, ab,
           principal.userId])

        if (vorige.rowCount && vorige.rowCount > 0) {
          await client.query(
            `UPDATE property_terms SET active_to = $2::date WHERE id = $1`,
            [vorige.rows[0]!.id, neu.rows[0]!.active_from])
        }

        reply.status(201)
        return {
          termsRef: neu.rows[0]!.public_ref,
          version: neu.rows[0]!.version,
          activeFrom: neu.rows[0]!.active_from
        }
      })
    }
  })

  /**
   * Der Gast stimmt zu, und zwar zu einer **Fassung**.
   *
   * Die Unterschrift wird nur gespeichert, wenn die Fassung sie verlangt --
   * aus demselben Grund wie beim Meldeschein: eine Unterschrift ohne Anlass
   * ist eine Erhebung ohne Rechtsgrund. Umgekehrt wird eine Fassung, die
   * eine verlangt, ohne sie nicht angenommen; sonst stuende im Nachweis eine
   * Zustimmung, die niemand geleistet hat.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/terms/:termsRef/agree',
    permission: 'reservation:checkin',
    summary: 'Hausbedingung fuer diesen Aufenthalt zustimmen',
    handler: async (req, reply) => {
      const { reservationRef, termsRef } = req.params as
        { reservationRef: string; termsRef: string }
      const { signatureSvg } = req.body as { signatureSvg?: string }
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number
                                       primary_guest_id: number | null }>(
          `SELECT id, property_id, primary_guest_id FROM reservation
            WHERE public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!

        const t = await client.query<{ id: number; property_id: number
                                       requires_signature: boolean }>(
          `SELECT id, property_id, requires_signature FROM property_terms
            WHERE public_ref = $1`, [termsRef])
        if (t.rowCount === 0) throw Errors.notFound('res.terms')
        // Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus.
        if (t.rows[0]!.property_id !== res.property_id) throw Errors.notFound('res.terms')

        if (t.rows[0]!.requires_signature && !signatureSvg) {
          throw Errors.unprocessable('terms.signatureRequired')
        }
        const unterschrift = t.rows[0]!.requires_signature ? signatureSvg ?? null : null

        const a = await client.query<{ id: number; agreed_at: string }>(
          `INSERT INTO guest_agreement
             (property_id, reservation_id, terms_id, guest_id, signature_svg, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (reservation_id, terms_id) DO NOTHING
           RETURNING id, agreed_at::text`,
          [res.property_id, res.id, t.rows[0]!.id, res.primary_guest_id,
           unterschrift, principal.userId])
        // Zweimal zugestimmt ist keine Fehlbedienung, sondern ein zweiter
        // Klick. Die erste Zustimmung bleibt stehen -- sie ist der Nachweis.
        if (a.rowCount === 0) throw Errors.conflict('terms.alreadyAgreed')

        reply.status(201)
        return { reservationRef, termsRef, signed: unterschrift !== null,
                 agreedAt: a.rows[0]!.agreed_at }
      })
    }
  })
}
