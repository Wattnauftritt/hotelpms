import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import { isIsoDate } from '@hotelpms/domain'
import { geltendeBedingungen, stimmeBedingungZu } from '../platform/hausbedingungen.js'

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
  activeTo?: string | null
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
          `SELECT t.public_ref AS "termsRef", t.code, t.version, t.title, t.body,
                  t.requires_signature AS "requiresSignature",
                  t.active_from::text AS "activeFrom", t.active_to::text AS "activeTo",
                  -- Wie oft zugestimmt wurde: davon haengt ab, ob die Fassung
                  -- geloescht oder nur beendet werden kann.
                  COALESCE(a.n, 0)::int AS agreements
             FROM property_terms t
             LEFT JOIN (SELECT terms_id, count(*) AS n FROM guest_agreement
                         GROUP BY terms_id) a ON a.terms_id = t.id
            WHERE t.property_id = $1
            ORDER BY t.code, t.version DESC`, [Number(propertyId)])
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

        // Welche Fassung gilt, steht in platform/hausbedingungen.ts -- das
        // Gaesteterminal legt dieselbe vor.
        const rows = await geltendeBedingungen(client,
          { id: res.id, propertyId: res.property_id, arrival: res.arrival })
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
      const fehler: Record<string, ['field.required' | 'field.maxLength' | 'field.isoDate'
                                    | 'terms.activeToBeforeFrom']> = {}
      if (!body.code || body.code.length > CODE_MAX) fehler.code = ['field.required']
      if (!body.title || body.title.length > TITEL_MAX) fehler.title = ['field.required']
      if (!body.body) fehler.body = ['field.required']
      if (body.body && body.body.length > TEXT_MAX) fehler.body = ['field.maxLength']
      /*
       * Beide Tage duerfen in der Vergangenheit liegen: wer Fassungen aus
       * einem Umsystem uebernimmt, legt an, was dort ab Februar galt, damit
       * die alten Zustimmungen auf ihren Text zeigen. `activeTo` beendet
       * eine Fassung, die nur rueckwirkend gelten soll.
       */
      if (body.activeFrom !== undefined && !isIsoDate(body.activeFrom)) {
        fehler.activeFrom = ['field.isoDate']
      }
      if (body.activeTo !== undefined && body.activeTo !== null) {
        if (!isIsoDate(body.activeTo)) fehler.activeTo = ['field.isoDate']
        else if (body.activeFrom !== undefined && isIsoDate(body.activeFrom)
                 && body.activeTo < body.activeFrom) {
          fehler.activeTo = ['terms.activeToBeforeFrom']
        }
      }
      if (Object.keys(fehler).length > 0) {
        throw Errors.validation(fehler, { max: TEXT_MAX })
      }

      return tx(req.pool, req, async client => {
        /*
         * Die neue Fassung beendet die alte am selben Tag, an dem sie
         * beginnt. Ohne das gaelten zwei Fassungen gleichzeitig, und welche
         * der Gast unterschrieben hat, waere eine Frage der Sortierung.
         */
        // Die Nummer aus allen Fassungen, nicht nur der offenen: eine mit
        // `activeTo` angelegte ist beendet, ihre Nummer aber vergeben.
        const vorige = await client.query<{ id: number; version: number
                                            active_from: string; active_to: string | null }>(
          `SELECT id, version, active_from::text, active_to::text FROM property_terms
            WHERE property_id = $1 AND code = $2
            ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [Number(propertyId), body.code])
        const vor = vorige.rows[0]
        const ab = body.activeFrom ?? null
        const bis = body.activeTo ?? null

        /*
         * Fassungen folgen aufeinander. Eine, die vor ihrer Vorgaengerin
         * beginnt, liesse die Vorgaengerin enden, bevor sie anfaengt; und
         * fuer die Tage dazwischen gaelten zwei Fassungen.
         */
        if (vor !== undefined && (ab ?? new Date().toISOString().slice(0, 10)) < vor.active_from) {
          throw Errors.validation({ activeFrom: ['terms.activeFromBeforePrevious'] },
                                  { date: vor.active_from })
        }

        const neu = await client.query<{ public_ref: string; version: number
                                         active_from: string; active_to: string | null }>(
          `INSERT INTO property_terms
             (property_id, code, version, title, body, requires_signature,
              active_from, active_to, created_by)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, current_date), $8::date, $9)
           RETURNING public_ref, version, active_from::text, active_to::text`,
          [Number(propertyId), body.code, (vor?.version ?? 0) + 1,
           body.title, body.body, body.requiresSignature ?? true, ab, bis,
           principal.userId])

        if (vor !== undefined && (vor.active_to === null || vor.active_to > neu.rows[0]!.active_from)) {
          await client.query(
            `UPDATE property_terms SET active_to = $2::date WHERE id = $1`,
            [vor.id, neu.rows[0]!.active_from])
        }

        reply.status(201)
        return {
          termsRef: neu.rows[0]!.public_ref,
          version: neu.rows[0]!.version,
          activeFrom: neu.rows[0]!.active_from,
          activeTo: neu.rows[0]!.active_to
        }
      })
    }
  })

  /**
   * Eine Fassung loeschen -- nur, solange niemand ihr zugestimmt hat.
   *
   * Anlass (Sven, 05.10.2026): dieselbe Bedingung stand unter zwei Kuerzeln,
   * und der Check-in legte sie zweimal vor. Eine Fassung ohne Zustimmung ist
   * ein Entwurf, der nie Nachweis war; sie darf gehen. Eine mit Zustimmung
   * ist der Text, auf den eine Unterschrift zeigt -- sie wird beendet, nicht
   * geloescht (`/end`). Ein Auftrag ans Gaesteterminal, der auf sie zeigt,
   * haelt sie ebenfalls: sein Protokoll nennt ihren Titel.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/terms/:termsRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Hausbedingung loeschen, solange niemand zugestimmt hat',
    handler: async (req) => {
      const { propertyId, termsRef } = req.params as { propertyId: string; termsRef: string }
      return tx(req.pool, req, async client => {
        const t = await fassung(client, Number(propertyId), termsRef)
        const benutzt = await client.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM guest_agreement WHERE terms_id = $1)
                + (SELECT count(*) FROM terminal_job WHERE terms_id = $1) AS n`, [t.id])
        if (Number(benutzt.rows[0]!.n) > 0) throw Errors.conflict('terms.inUse')
        await client.query(`DELETE FROM property_terms WHERE id = $1`, [t.id])
        return { termsRef, deleted: true }
      })
    }
  })

  /**
   * Eine Fassung beenden: ab heute legt sie niemand mehr vor. Die
   * Zustimmungen bleiben und zeigen weiter auf ihren Text.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terms/:termsRef/end',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Hausbedingung ab heute beenden',
    handler: async (req) => {
      const { propertyId, termsRef } = req.params as { propertyId: string; termsRef: string }
      return tx(req.pool, req, async client => {
        const t = await fassung(client, Number(propertyId), termsRef)
        // Heute, aber nicht vor ihrem Beginn: eine Fassung, die erst
        // morgen gelten sollte, endet mit Laenge null und gilt nie.
        const r = await client.query<{ active_to: string }>(
          `UPDATE property_terms
              SET active_to = GREATEST(active_from, current_date)
            WHERE id = $1 AND (active_to IS NULL OR active_to > GREATEST(active_from, current_date))
            RETURNING active_to::text`, [t.id])
        return { termsRef, activeTo: r.rows[0]?.active_to ?? t.active_to }
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
      const { signatureSvg } = (req.body ?? {}) as { signatureSvg?: unknown }
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number
                                       primary_guest_id: number | null }>(
          `SELECT id, property_id, primary_guest_id FROM reservation
            WHERE public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!
        /*
         * Mitbehoben: das Recht im Haus der Reservierung, nicht in
         * irgendeinem. Die Route nimmt keine Property, und `registerRoute`
         * prueft dann nur "irgendwo im Account".
         */
        if (!can(principal, 'reservation:checkin', Number(res.property_id))) {
          throw Errors.forbidden('access.missingPermission',
            { permission: 'reservation:checkin' })
        }

        const t = await client.query<{ id: number }>(
          `SELECT id FROM property_terms WHERE public_ref = $1`, [termsRef])
        if (t.rowCount === 0) throw Errors.notFound('res.terms')

        // Die Regel selbst: platform/hausbedingungen.ts, dieselbe wie am
        // Gaesteterminal.
        const z = await stimmeBedingungZu(client, {
          reservationId: Number(res.id), propertyId: Number(res.property_id),
          primaryGuestId: res.primary_guest_id, termsId: Number(t.rows[0]!.id),
          signatureSvg, createdBy: principal.userId })

        reply.status(201)
        return { reservationRef, termsRef, signed: z.signed, agreedAt: z.agreedAt }
      })
    }
  })
}

/** Eine Fassung dieses Hauses, gesperrt fuer die Aenderung. */
async function fassung(client: import('@hotelpms/db').PoolClient, propertyId: number,
                       termsRef: string): Promise<{ id: number; active_to: string | null }> {
  const r = await client.query<{ id: number; active_to: string | null }>(
    `SELECT id, active_to::text FROM property_terms
      WHERE public_ref = $1 AND property_id = $2 FOR UPDATE`, [termsRef, propertyId])
  if (r.rowCount === 0) throw Errors.notFound('res.terms')
  return r.rows[0]!
}
