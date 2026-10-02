import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import { requiresRegistrationSignature } from '@hotelpms/domain'
import { erfasseMeldeschein, unterschreibeMeldeschein, AUFBEWAHRUNG_MONATE }
  from '../platform/meldeschein.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Wie bei jedem anderen Zeitraumparameter im System (rates.ts, reports.ts,
 * availability.ts, channel.ts): eine Obergrenze, sonst ist der Endpunkt ein
 * Selbstangriff. Hier gefunden und behoben, weil sie als einzige unter den
 * vergleichbaren Endpunkten fehlte (Performanceaudit) -- das `LIMIT 5000`
 * unten schuetzt nur die Antwortgroesse, nicht die Breite des Bereichs, den
 * die Abfrage durchsuchen muss.
 */
const MAX_REGISTRATION_DAYS = 800

/*
 * Meldeschein nach §§ 29, 30 BMG. Die Regeln -- wer unterschreibt, wie
 * lange aufbewahrt wird, was mit Mitreisenden geschieht -- stehen in
 * `platform/meldeschein.ts`, weil seit dem Online-Check-in drei Wege einen
 * Schein erfassen (Tresen, Link, Station) und es eine Fassung der Regeln
 * geben soll, nicht drei (Dokument 30).
 */

interface RegistrationBody {
  propertyId: number
  reservationRef: string
  /** Weitere Mitreisende. Bei Gruppen entsteht daraus ein Sammelmeldeschein. */
  occupantGuestRefs?: string[]
  signatureSvg?: string
}

async function loadReservation(
  client: PoolClient, propertyId: number, reservationRef: string
): Promise<{ id: number; arrival: string; departure: string
            primary_guest_id: number | null }> {
  const { rows, rowCount } = await client.query<{
    id: number; arrival: string; departure: string; primary_guest_id: number | null }>(
    `SELECT id, arrival::text, departure::text, primary_guest_id
       FROM reservation WHERE public_ref = $1 AND property_id = $2`,
    [reservationRef, propertyId])
  if (rowCount === 0) throw Errors.notFound('res.reservation')
  return rows[0]!
}

export function registrationRoutes(app: FastifyInstance): void {
  /**
   * Vorbefuellter Meldeschein. Alles, was das Haus schon weiss, steht drin;
   * der Gast bestaetigt oder korrigiert. Eine Abfrage, damit der Schein am
   * Tresen ohne Wartezeit erscheint.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/registration-form',
    permission: 'reservation:checkin',
    summary: 'Vorbefuellten Meldeschein liefern',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{
          arrival: string; departure: string; property_name: string
          last_name: string | null; first_name: string | null
          birth_date: string | null; nationality: string | null
          address_line1: string | null; postal_code: string | null
          city: string | null; country: string | null
          guest_ref: string | null; occupants: number
          existing_id: number | null; signed_at: string | null
          signature_required: boolean | null; source: string | null }>(
          `SELECT r.arrival::text, r.departure::text, p.name AS property_name,
                  g.last_name, g.first_name, g.birth_date::text, g.nationality,
                  g.address_line1, g.postal_code, g.city, g.country,
                  g.public_ref AS guest_ref,
                  (SELECT count(*) FROM reservation_occupant o
                    WHERE o.reservation_id = r.id)::int AS occupants,
                  reg.id AS existing_id, reg.signed_at::text AS signed_at,
                  reg.signature_required, reg.source
             FROM reservation r
             JOIN property p ON p.id = r.property_id
             LEFT JOIN guest g ON g.id = r.primary_guest_id
             LEFT JOIN registration reg ON reg.reservation_id = r.id
                   AND reg.group_registration_id IS NULL
            WHERE r.public_ref = $1`, [reservationRef])
        if (rowCount === 0) throw Errors.notFound('res.reservation')
        const r = rows[0]!
        // Nach Staatsangehoerigkeit, hilfsweise Wohnsitz (requiresRegistrationSignature).
        const auslaendisch = requiresRegistrationSignature(r)
        // Liegt schon ein Schein vor, entscheidet, was dort steht -- ein
        // auslaendischer Mitreisender kann die Unterschrift verlangt haben,
        // obwohl der Hauptgast deutsch ist.
        const noetig = r.signature_required ?? auslaendisch

        return {
          reservationRef,
          property: r.property_name,
          arrival: r.arrival,
          plannedDeparture: r.departure,
          occupantCount: Math.max(r.occupants, 1),
          guest: r.guest_ref === null ? null : {
            guestRef: r.guest_ref, lastName: r.last_name, firstName: r.first_name,
            birthDate: r.birth_date, nationality: r.nationality,
            address: { line1: r.address_line1, postalCode: r.postal_code,
                       city: r.city, country: r.country }
          },
          isForeign: auslaendisch,
          // Der entscheidende Hinweis fuer die Oberflaeche: nur hier darf
          // ueberhaupt ein Unterschriftenfeld erscheinen.
          signatureRequired: noetig,
          alreadyRegistered: r.existing_id !== null,
          registrationId: r.existing_id === null ? null : Number(r.existing_id),
          signedAt: r.signed_at,
          /*
           * Vorab ueber den Link erfasst, unterschrieben wird am Anreisetag
           * (§ 29 Abs. 2 BMG). Die Maske zeigt dann das Unterschriftsfeld,
           * obwohl der Schein schon vorliegt.
           */
          signaturePending: r.existing_id !== null && noetig && r.signed_at === null,
          source: r.source
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/registrations',
    permission: 'reservation:checkin',
    propertyParam: 'propertyId',
    summary: 'Meldeschein erfassen',
    handler: async (req, reply) => {
      const body = req.body as RegistrationBody
      if (!body.reservationRef) {
        throw Errors.validation({ reservationRef: ['field.required'] })
      }

      return tx(req.pool, req, async client => {
        const res = await loadReservation(client, body.propertyId, body.reservationRef)
        if (res.primary_guest_id === null) {
          throw Errors.unprocessable(
            'registration.noPrimaryGuest')
        }
        // Mitreisende in einer Abfrage, in der Reihenfolge der Eingabe.
        const refs = body.occupantGuestRefs ?? []
        const m = await client.query<{ id: number; public_ref: string }>(
          `SELECT id, public_ref FROM guest WHERE public_ref = ANY($1::text[])`, [refs])
        const idNachRef = new Map(m.rows.map(r => [r.public_ref, Number(r.id)]))
        const mitreisende = refs.map(ref => {
          const id = idNachRef.get(ref)
          if (id === undefined) throw Errors.notFound('res.guest')
          return id
        })

        const ergebnis = await erfasseMeldeschein(client, {
          propertyId: body.propertyId, reservationId: res.id,
          arrival: res.arrival, departure: res.departure,
          primaryGuestId: res.primary_guest_id, mitreisende,
          // Am Tresen steht der Gast davor: jetzt oder gar nicht.
          unterschrift: { art: 'jetzt', svg: body.signatureSvg },
          quelle: 'desk'
        })

        reply.status(201)
        return {
          registrationId: ergebnis.registrationId,
          reservationRef: body.reservationRef,
          isForeign: ergebnis.isForeign,
          signatureStored: ergebnis.signatureStored,
          groupMembers: ergebnis.groupMembers,
          destroyAfterMonths: AUFBEWAHRUNG_MONATE
        }
      })
    }
  })

  /**
   * Nachtraegliche Unterschrift, etwa wenn der Gast bei der Ankunft in Eile
   * war. Nur fuer auslaendische Gaeste; fuer deutsche gibt es keine, die
   * geleistet werden koennte.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/registrations/:registrationId/sign',
    permission: 'reservation:checkin',
    summary: 'Meldeschein unterschreiben',
    handler: async (req) => {
      const { registrationId } = req.params as { registrationId: string }
      const { signatureSvg } = req.body as { signatureSvg: string }
      if (!signatureSvg) throw Errors.validation({ signatureSvg: ['field.required'] })
      return tx(req.pool, req, async client => {
        await unterschreibeMeldeschein(client, Number(registrationId), signatureSvg)
        return { registrationId: Number(registrationId), signed: true }
      })
    }
  })

  /**
   * Liste fuer eine Pruefung durch die Meldebehoerde. Enthaelt bewusst
   * keine Unterschriftsbilder: die werden vorgelegt, nicht exportiert.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/registrations',
    permission: 'report:operational',
    propertyParam: 'propertyId',
    summary: 'Meldescheine eines Zeitraums',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string }
      if (!q.from || !q.to || !isIsoDate(q.from) || !isIsoDate(q.to)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      const tage = nightsBetween(q.from, q.to)
      if (tage < 0) throw Errors.validation({ to: ['field.afterFrom'] })
      if (tage > MAX_REGISTRATION_DAYS) throw Errors.rangeTooLarge(MAX_REGISTRATION_DAYS)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT reg.id, reg.arrival::text AS arrival,
                  reg.planned_departure::text AS "plannedDeparture",
                  reg.occupant_count AS "occupantCount", reg.is_foreign AS "isForeign",
                  (reg.signed_at IS NOT NULL) AS signed,
                  reg.destroy_after::text AS "destroyAfter",
                  reg.group_registration_id AS "groupRegistrationId",
                  g.last_name AS "lastName", g.first_name AS "firstName",
                  g.nationality, g.city, g.country,
                  r.public_ref AS "reservationRef"
             FROM registration reg
             JOIN guest g ON g.id = reg.guest_id
             JOIN reservation r ON r.id = reg.reservation_id
            WHERE reg.property_id = $1
              AND reg.arrival BETWEEN $2::date AND $3::date
            ORDER BY reg.arrival, g.last_name
            LIMIT 5000`,
          [Number(propertyId), q.from, q.to])
        return { registrations: rows }
      })
    }
  })
}
