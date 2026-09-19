import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
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

/**
 * Meldeschein nach §§ 29, 30 BMG.
 *
 * Drei Regeln bestimmen alles Weitere:
 *
 * 1. **Seit dem 1.1.2025 unterschreiben nur noch auslaendische Gaeste.** Fuer
 *    deutsche Gaeste entfaellt die Unterschrift ersatzlos; ein System, das
 *    sie trotzdem verlangt, haelt die Rezeption ohne Rechtsgrund auf.
 * 2. **Keine Ausweiskopie.** § 30 erlaubt es, Angaben zu erheben und die
 *    Ausweisnummer zu notieren. Eine Kopie oder ein Scan ist unzulaessig.
 *    Es gibt in diesem System deshalb kein Feld dafuer.
 * 3. **Ein Jahr Aufbewahrung, danach Vernichtung.** Die Frist laeuft
 *    "vom Tag der Abreise der beherbergten Person an" (§ 30 Abs. 4 BMG),
 *    nicht ab Anreise -- hier stand das Gegenteil, und bei einem Aufenthalt
 *    von drei Naechten wurde der Schein drei Tage zu frueh vernichtet, bei
 *    einem Langzeitgast Wochen. Das Vernichten ist Pflicht, nicht Ermessen,
 *    und laeuft deshalb automatisch im Worker, nicht auf Zuruf.
 *
 * **Was nicht hierher gehoert.** Kommunale Gaestebeitragssatzungen verlangen
 * laengere Aufbewahrung -- die Stadt Cuxhaven etwa sechs Jahre fuer das
 * Gaesteverzeichnis (§ 9 Abs. 5 ihrer Satzung). Das ist ein **anderer**
 * Nachweis: Name, Anschrift, Zeitraum, Naechte, Satz, Betrag, also das, was
 * in Beleg und Rechnung steht. Der Meldeschein traegt darueber hinaus
 * Ausweisnummer und Staatsangehoerigkeit, und fuer die gibt es nach einem
 * Jahr keinen Rechtsgrund mehr. Die laengere Frist haengt deshalb am Haus
 * (`property.guest_levy_retention_years`) und bremst die Anonymisierung,
 * nicht diese Tabelle.
 */
const AUFBEWAHRUNG_MONATE = 12

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
          existing_id: number | null; signed_at: string | null }>(
          `SELECT r.arrival::text, r.departure::text, p.name AS property_name,
                  g.last_name, g.first_name, g.birth_date::text, g.nationality,
                  g.address_line1, g.postal_code, g.city, g.country,
                  g.public_ref AS guest_ref,
                  (SELECT count(*) FROM reservation_occupant o
                    WHERE o.reservation_id = r.id)::int AS occupants,
                  reg.id AS existing_id, reg.signed_at::text AS signed_at
             FROM reservation r
             JOIN property p ON p.id = r.property_id
             LEFT JOIN guest g ON g.id = r.primary_guest_id
             LEFT JOIN registration reg ON reg.reservation_id = r.id
                   AND reg.group_registration_id IS NULL
            WHERE r.public_ref = $1`, [reservationRef])
        if (rowCount === 0) throw Errors.notFound('res.reservation')
        const r = rows[0]!
        const auslaendisch = r.country !== null && r.country !== 'DE'

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
          signatureRequired: auslaendisch,
          alreadyRegistered: r.existing_id !== null,
          signedAt: r.signed_at
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
        const vorhanden = await client.query(
          `SELECT 1 FROM registration WHERE reservation_id = $1 LIMIT 1`, [res.id])
        if (vorhanden.rowCount && vorhanden.rowCount > 0) {
          throw Errors.conflict('registration.alreadyExists')
        }

        const g = await client.query<{ country: string | null }>(
          `SELECT country FROM guest WHERE id = $1`, [res.primary_guest_id])
        const auslaendisch = g.rows[0]?.country != null && g.rows[0].country !== 'DE'

        // Die Unterschrift ist nur fuer auslaendische Gaeste Pflicht, und
        // nur dort wird sie ueberhaupt gespeichert. Eine Unterschrift ohne
        // Rechtsgrund waere eine Datenerhebung ohne Rechtsgrund.
        if (auslaendisch && !body.signatureSvg) {
          throw Errors.unprocessable(
            'registration.signatureRequired')
        }
        const signatur = auslaendisch ? body.signatureSvg ?? null : null

        const mitreisende = body.occupantGuestRefs ?? []
        const haupt = await client.query<{ id: number }>(
          `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                     planned_departure, occupant_count, is_foreign,
                                     signature_svg, signed_at, destroy_after)
           VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8::text,
                   CASE WHEN $8::text IS NULL THEN NULL ELSE now() END,
                   -- Ab Abreise, nicht ab Anreise: § 30 Abs. 4 BMG.
                   ($5::date + ($9 || ' months')::interval)::date)
           RETURNING id`,
          [body.propertyId, res.id, res.primary_guest_id, res.arrival, res.departure,
           mitreisende.length + 1, auslaendisch, signatur, AUFBEWAHRUNG_MONATE])
        const hauptId = haupt.rows[0]!.id

        /**
         * Sammelmeldeschein fuer Reisegruppen (E6, Dokument 13). Jeder
         * Mitreisende bekommt einen eigenen Datensatz, der auf den Haupt-
         * schein zeigt: die Meldepflicht gilt je Person, die Unterschrift
         * leistet bei Gruppen der Reiseleiter.
         */
        let angelegt = 0
        for (const ref of mitreisende) {
          const m = await client.query<{ id: number; country: string | null }>(
            `SELECT id, country FROM guest WHERE public_ref = $1`, [ref])
          if (m.rowCount === 0) throw Errors.notFound('res.guest')
          await client.query(
            `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                       planned_departure, occupant_count, is_foreign,
                                       group_registration_id, destroy_after)
             VALUES ($1,$2,$3,$4::date,$5::date,1,$6,$7,
                     ($5::date + ($8 || ' months')::interval)::date)`,
            [body.propertyId, res.id, m.rows[0]!.id, res.arrival, res.departure,
             m.rows[0]!.country != null && m.rows[0]!.country !== 'DE',
             hauptId, AUFBEWAHRUNG_MONATE])

          /*
           * Wer gemeldet ist, wohnt auch im Zimmer.
           *
           * Bisher entstand hier **nur** der Meldeschein. Die Kurtaxe rechnet
           * aber aus `reservation_occupant`, und so meldete das Haus zwei
           * Personen und berechnete eine -- ohne Fehlermeldung, mit einer
           * Rechnung, die plausibel aussieht. Aufgefallen ist es erst, als
           * die Maske ueberhaupt anfing, Mitreisende zu schicken.
           *
           * Nur, wenn diese Person nicht schon in der Liste steht: bei einer
           * Buchung koennen Mitreisende bereits angegeben sein, und ein
           * zweiter Eintrag zaehlte denselben Menschen doppelt. Verglichen
           * wird ueber den Gast; ein Eintrag, der nur ein Alter traegt und
           * keinen Gast, bleibt deshalb unberuehrt.
           */
          await client.query(
            `INSERT INTO reservation_occupant
               (property_id, reservation_id, guest_id, is_primary)
             SELECT $1,$2,$3,false
              WHERE NOT EXISTS (SELECT 1 FROM reservation_occupant o
                                 WHERE o.reservation_id = $2 AND o.guest_id = $3)`,
            [body.propertyId, res.id, m.rows[0]!.id])
          angelegt++
        }

        reply.status(201)
        return {
          registrationId: hauptId,
          reservationRef: body.reservationRef,
          isForeign: auslaendisch,
          signatureStored: signatur !== null,
          groupMembers: angelegt,
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
        const cur = await client.query<{ is_foreign: boolean; signed_at: string | null }>(
          `SELECT is_foreign, signed_at::text FROM registration WHERE id = $1 FOR UPDATE`,
          [Number(registrationId)])
        if (cur.rowCount === 0) throw Errors.notFound('res.registration')
        if (!cur.rows[0]!.is_foreign) {
          throw Errors.unprocessable(
            'registration.signatureNotForeseen')
        }
        if (cur.rows[0]!.signed_at !== null) {
          throw Errors.conflict('registration.alreadySigned')
        }
        await client.query(
          `UPDATE registration SET signature_svg = $2, signed_at = now() WHERE id = $1`,
          [Number(registrationId), signatureSvg])
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
