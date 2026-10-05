import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { avsXml, avsDateiname, alterAm, type AvsMeldeschein, type AvsPerson }
  from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import { assertNotTraining, isTrainingProperty } from '../platform/training.js'
import { decryptIdDocument } from '../platform/crypto.js'
import { loadConfig } from '../platform/config.js'

/**
 * Meldeschein als Datei fuer AVS (Migration 0091).
 *
 * **Eine Datei je Aufenthalt, im Ablauf des Check-ins** (Sven, 05.10.2026):
 * die Rezeption klickt "Einchecken", erfasst den Meldeschein, falls er noch
 * fehlt, und laedt die Datei herunter, um sie sofort in AVS einzulesen --
 * dort entsteht in diesem Moment die Kurkarte. Eine Sammeldatei am
 * Monatsende kaeme fuer die Karte zu spaet.
 *
 * **Gemeldet ist endgueltig.** AVS hat keine Updateschnittstelle; ein zweiter
 * Import desselben Gastes waere dort ein zweiter Gast. Der erste Export
 * markiert den Schein (`avs_reported_at`, ein Trigger haelt es fest), jeder
 * weitere wird abgewiesen. Ging der Download schief, gibt es denselben
 * Inhalt noch einmal ueber `/file` -- ausdruecklich als Wiederholung, nicht
 * als neue Meldung.
 *
 * **Ausweisnummer nur mit `guest:read_identity`.** Die Datei ist ein Weg, an
 * die Nummer zu kommen; wer sie in der Gastanzeige nicht sehen darf, bekommt
 * sie auch hier nicht, und jeder Export mit Nummer steht im Protokoll.
 */

const config = loadConfig()

interface Einstellung {
  hotel_id: string; origin: string; user_name: string
  min_age: number; default_category: number; breakfast_cent: number
}

interface Zeile {
  reg_id: string; group_registration_id: string | null
  arrival: string; departure: string
  signature_required: boolean; signed_at: string | null
  avs_reported_at: string | null; avs_export_id: string | null
  digital_guest_card: boolean
  guest_id: string; last_name: string; first_name: string | null
  birth_date: string | null; nationality: string | null
  address_line1: string | null; postal_code: string | null
  city: string | null; country: string | null; email: string | null
  id_enc: Buffer | null; id_key: number | null
  avs_category: number | null
}

interface Aufenthalt {
  id: number; property_id: number; lodging_cent: number
}

async function aufenthalt(client: PoolClient, ref: string, principal: Principal
): Promise<Aufenthalt> {
  const r = await client.query<{ id: string; property_id: string; lodging_cent: string }>(
    `SELECT r.id, r.property_id,
            (SELECT COALESCE(sum(n.price_cent), 0) FROM reservation_night n
              WHERE n.reservation_id = r.id) AS lodging_cent
       FROM reservation r WHERE r.public_ref = $1`, [ref])
  if (r.rowCount === 0) throw Errors.notFound('res.reservation')
  const a = { id: Number(r.rows[0]!.id), property_id: Number(r.rows[0]!.property_id),
              lodging_cent: Number(r.rows[0]!.lodging_cent) }
  // Das Recht im Haus der Reservierung, nicht in irgendeinem: die Route
  // nimmt keine Property, und `registerRoute` prueft dann nur den Account.
  if (!can(principal, 'reservation:checkin', a.property_id)) {
    throw Errors.forbidden('access.missingPermission', { permission: 'reservation:checkin' })
  }
  return a
}

async function einstellung(client: PoolClient, propertyId: number): Promise<Einstellung | null> {
  const s = await client.query<Einstellung>(
    `SELECT hotel_id, origin, user_name, min_age, default_category, breakfast_cent
       FROM avs_setting WHERE property_id = $1`, [propertyId])
  return s.rows[0] ?? null
}

/** Hauptschein und Mitreisende in einer Abfrage, Hauptschein zuerst. */
async function scheine(client: PoolClient, reservationId: number): Promise<Zeile[]> {
  const { rows } = await client.query<Zeile>(
    `SELECT reg.id AS reg_id, reg.group_registration_id,
            reg.arrival::text, r.departure::text,
            reg.signature_required, reg.signed_at::text,
            reg.avs_reported_at::text, reg.avs_export_id, reg.digital_guest_card,
            g.id AS guest_id, g.last_name, g.first_name, g.birth_date::text,
            g.nationality, g.address_line1, g.postal_code, g.city, g.country, g.email,
            g.id_document_number_enc AS id_enc, g.id_document_key_version AS id_key,
            x.avs_category
       FROM registration reg
       JOIN reservation r ON r.id = reg.reservation_id
       JOIN guest g ON g.id = reg.guest_id
       LEFT JOIN city_tax_exemption_reason x ON x.id = reg.tax_exemption_reason_id
      WHERE reg.reservation_id = $1
      ORDER BY reg.group_registration_id NULLS FIRST, reg.id`, [reservationId])
  return rows
}

/**
 * Was die Datei enthaelt.
 *
 * Wer am Anreisetag unter dem Mindestalter ist, fehlt ganz, wie im
 * Adminpanel: die Gemeinde meldet ihn nicht (Cuxhaven: ab vollendetem
 * 16. Lebensjahr). Ist es der Hauptgast -- eine Mutter bucht fuer ihren
 * Sohn --, rueckt die erste meldepflichtige Begleitperson an seine Stelle;
 * die Anschrift bleibt die des Scheins. Wer kein Geburtsdatum hat, wird
 * gemeldet: lieber einer zu viel, den die Rezeption in AVS korrigiert, als
 * einer, der fehlt.
 *
 * Das Uebernachtungsentgelt ist das dieser Reservierung, also eines
 * Zimmers. Das Adminpanel meldet bei einer Gruppe den Gesamtpreis auf jedem
 * Schein und hat das selbst als Fehler benannt. Abgezogen wird der
 * Fruehstuecksanteil des Hauses je gemeldeter Person und Nacht, wie im
 * Adminpanel: Juengere zahlen keinen Kurbeitrag und zaehlen auch hier nicht.
 */
function inhalt(z: Zeile[], s: Einstellung, a: Aufenthalt, mitNummer: boolean
): { schein: AvsMeldeschein; personen: number } {
  const haupt = hauptschein(z)
  const meldepflichtig = (x: Zeile): boolean =>
    x.birth_date === null || alterAm(x.birth_date, haupt.arrival) >= s.min_age
  const person = (p: Zeile, email: string | null): AvsPerson => ({
    lastName: p.last_name, firstName: p.first_name, birthDate: p.birth_date,
    nationality: p.nationality,
    category: p.avs_category ?? s.default_category,
    email,
    idDocumentNumber: mitNummer && p.id_enc !== null && p.id_key !== null
      ? decryptIdDocument(p.id_enc, config.idDocumentKey, p.id_key) : null
  })
  const gemeldet = [haupt, ...z.filter(x => x.group_registration_id !== null)]
    .filter(meldepflichtig)
  const erster = gemeldet[0]
  if (erster === undefined) throw Errors.unprocessable('avs.nobodyToReport')
  // Die Einwilligung in die Karte per Mail gab der Hauptgast fuer sich.
  const email = erster === haupt && haupt.digital_guest_card ? haupt.email : null
  return {
    schein: {
      arrival: haupt.arrival, departure: haupt.departure,
      main: {
        ...person(erster, email),
        addressLine1: haupt.address_line1, postalCode: haupt.postal_code,
        city: haupt.city, country: haupt.country,
        lodgingCent: a.lodging_cent > 0
          ? Math.max(0, a.lodging_cent
              - s.breakfast_cent * naechte(haupt.arrival, haupt.departure) * gemeldet.length)
          : null
      },
      companions: gemeldet.slice(1).map(x => person(x, null))
    },
    personen: gemeldet.length
  }
}

/** Naechte zwischen zwei Kalenderdaten, mindestens eine. */
function naechte(von: string, bis: string): number {
  return Math.max(1, Math.round((Date.parse(`${bis}T00:00:00Z`)
    - Date.parse(`${von}T00:00:00Z`)) / 86_400_000))
}

function hauptschein(z: Zeile[]): Zeile {
  const h = z.find(x => x.group_registration_id === null)
  if (h === undefined) throw Errors.unprocessable('avs.noRegistration')
  return h
}

const NUMMER = /^[0-9]{1,10}$/
const BENUTZER = /^[A-Za-z0-9_-]{1,10}$/

export function avsRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/avs-settings',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'AVS-Meldeschein: Einstellung des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const s = await einstellung(client, Number(propertyId))
        return s === null ? { configured: false } : {
          configured: true, hotelId: s.hotel_id, origin: s.origin, userName: s.user_name,
          minAge: s.min_age, defaultCategory: s.default_category,
          breakfastCent: s.breakfast_cent }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/avs-settings',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'AVS-Meldeschein: Einstellung des Hauses setzen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = (req.body ?? {}) as Record<string, unknown>
      const f: Record<string, Meldung[]> = {}
      const hotelId = typeof b.hotelId === 'string' ? b.hotelId.trim() : ''
      if (!NUMMER.test(hotelId)) f.hotelId = ['field.invalid']
      const origin = typeof b.origin === 'string' && b.origin.trim() !== ''
        ? b.origin.trim() : 'StayGrid'
      if (origin.length > 40) f.origin = ['field.invalid']
      const userName = typeof b.userName === 'string' && b.userName.trim() !== ''
        ? b.userName.trim() : 'StayGrid'
      if (!BENUTZER.test(userName)) f.userName = ['field.invalid']
      const minAge = b.minAge === undefined ? 16 : b.minAge
      if (!Number.isInteger(minAge) || (minAge as number) < 0 || (minAge as number) > 30) {
        f.minAge = ['field.invalid']
      }
      const kat = b.defaultCategory === undefined ? 1 : b.defaultCategory
      if (!Number.isInteger(kat) || (kat as number) < 1 || (kat as number) > 99) {
        f.defaultCategory = ['field.invalid']
      }
      const fruehstueck = b.breakfastCent === undefined ? 0 : b.breakfastCent
      if (!Number.isInteger(fruehstueck) || (fruehstueck as number) < 0
          || (fruehstueck as number) > 100_000) {
        f.breakfastCent = ['field.invalid']
      }
      if (Object.keys(f).length > 0) throw Errors.validation(f)
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO avs_setting (property_id, hotel_id, origin, user_name, min_age,
                                    default_category, breakfast_cent)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (property_id) DO UPDATE
              SET hotel_id = EXCLUDED.hotel_id, origin = EXCLUDED.origin,
                  user_name = EXCLUDED.user_name, min_age = EXCLUDED.min_age,
                  default_category = EXCLUDED.default_category,
                  breakfast_cent = EXCLUDED.breakfast_cent, updated_at = now()`,
          [Number(propertyId), hotelId, origin, userName, minAge, kat, fruehstueck])
        return { configured: true, hotelId, origin, userName, minAge, defaultCategory: kat,
                 breakfastCent: fruehstueck }
      })
    }
  })

  /**
   * Der Stand an der Reservierung, fuer den Check-in-Dialog: ist das Haus
   * eingerichtet, liegt ein Schein vor, ist er gemeldet, fehlt die
   * Unterschrift. Ohne Gastdaten.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/avs-export',
    permission: 'reservation:checkin',
    summary: 'AVS-Meldeschein: Stand an der Reservierung',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const a = await aufenthalt(client, reservationRef, principal)
        const s = await einstellung(client, a.property_id)
        const z = await scheine(client, a.id)
        const h = z.find(x => x.group_registration_id === null)
        return {
          configured: s !== null,
          training: await isTrainingProperty(client, a.property_id),
          registered: h !== undefined,
          signaturePending: h !== undefined && h.signature_required && h.signed_at === null,
          reportedAt: h?.avs_reported_at ?? null,
          exportedHere: h !== undefined && h.avs_export_id !== null,
          digitalGuestCard: h?.digital_guest_card ?? false,
          hasEmail: h !== undefined && h.email !== null && h.email !== ''
        }
      })
    }
  })

  /**
   * Melden: die Datei erzeugen und den Schein als gemeldet markieren, in
   * einer Transaktion. `digitalGuestCard` traegt ein, was der Gast am Tresen
   * sagt; ohne Angabe gilt, was er im Online-Formular angekreuzt hat.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/avs-export',
    permission: 'reservation:checkin',
    summary: 'AVS-Meldeschein erzeugen und als gemeldet markieren',
    handler: async (req, reply) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      const b = (req.body ?? {}) as { digitalGuestCard?: unknown }
      if (b.digitalGuestCard !== undefined && typeof b.digitalGuestCard !== 'boolean') {
        throw Errors.validation({ digitalGuestCard: ['field.invalid'] })
      }
      return tx(req.pool, req, async client => {
        const a = await aufenthalt(client, reservationRef, principal)
        await assertNotTraining(client, a.property_id, 'training.what.avs')
        const s = await einstellung(client, a.property_id)
        if (s === null) throw Errors.unprocessable('avs.notConfigured')

        // Sperre auf dem Hauptschein: zwei Klicks gleichzeitig duerfen nicht
        // zwei Dateien ergeben.
        const lock = await client.query<{ id: string }>(
          `SELECT id FROM registration
            WHERE reservation_id = $1 AND group_registration_id IS NULL FOR UPDATE`, [a.id])
        if (lock.rowCount === 0) throw Errors.unprocessable('avs.noRegistration')
        // Beide Richtungen: der Gast kann am Tresen auch zuruecknehmen, was er
        // im Online-Formular angekreuzt hat. Ohne Angabe bleibt es dabei.
        if (typeof b.digitalGuestCard === 'boolean') {
          await client.query(
            `UPDATE registration SET digital_guest_card = $2 WHERE id = $1`,
            [lock.rows[0]!.id, b.digitalGuestCard])
        }

        const z = await scheine(client, a.id)
        const h = hauptschein(z)
        if (h.avs_reported_at !== null) throw Errors.conflict('avs.alreadyReported')
        if (h.signature_required && h.signed_at === null) {
          throw Errors.unprocessable('avs.signaturePending')
        }

        const mitNummer = can(principal, 'guest:read_identity', a.property_id)
        const { schein, personen } = inhalt(z, s, a, mitNummer)
        const datei = avsDateiname(s.user_name, new Date())
        const e = await client.query<{ id: string; created_at: string }>(
          `INSERT INTO avs_export (property_id, reservation_id, file_name, persons, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at::text`,
          [a.property_id, a.id, datei, personen, principal.userId])
        // Alle Zeilen des Scheins, auch die Mitreisenden unter dem
        // Mindestalter: gemeldet ist der Schein, nicht jede Zeile einzeln.
        await client.query(
          `UPDATE registration SET avs_reported_at = $2::timestamptz, avs_export_id = $3
            WHERE reservation_id = $1 AND avs_reported_at IS NULL`,
          [a.id, e.rows[0]!.created_at, e.rows[0]!.id])
        await protokolliereNummern(client, z, mitNummer, principal)

        reply.status(201)
        return { fileName: datei, xml: avsXml(
          { hotelId: s.hotel_id, origin: s.origin, userName: s.user_name }, [schein]),
                 reportedAt: e.rows[0]!.created_at, persons: personen }
      })
    }
  })

  /**
   * Dieselbe Datei noch einmal -- wenn der Download schiefging. Nur fuer
   * einen Schein, den StayGrid gemeldet hat; der Inhalt ist der von heute,
   * nicht ein gespeicherter (Migration 0091).
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/avs-export/file',
    permission: 'reservation:checkin',
    summary: 'AVS-Meldeschein erneut herunterladen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const a = await aufenthalt(client, reservationRef, principal)
        await assertNotTraining(client, a.property_id, 'training.what.avs')
        const s = await einstellung(client, a.property_id)
        if (s === null) throw Errors.unprocessable('avs.notConfigured')
        const z = await scheine(client, a.id)
        const h = hauptschein(z)
        if (h.avs_export_id === null) throw Errors.unprocessable('avs.notExportedHere')
        const ex = await client.query<{ file_name: string }>(
          `SELECT file_name FROM avs_export WHERE id = $1`, [h.avs_export_id])
        const mitNummer = can(principal, 'guest:read_identity', a.property_id)
        const { schein, personen } = inhalt(z, s, a, mitNummer)
        await protokolliereNummern(client, z, mitNummer, principal)
        return { fileName: ex.rows[0]!.file_name, xml: avsXml(
          { hotelId: s.hotel_id, origin: s.origin, userName: s.user_name }, [schein]),
                 reportedAt: h.avs_reported_at, persons: personen }
      })
    }
  })
}

/**
 * Jede Herausgabe einer Ausweisnummer steht im Protokoll, wie beim Lesen in
 * der Gastanzeige (`routes/guests.ts`).
 */
async function protokolliereNummern(
  client: PoolClient, z: Zeile[], mitNummer: boolean, principal: Principal
): Promise<void> {
  if (!mitNummer) return
  const ids = z.filter(x => x.id_enc !== null).map(x => Number(x.guest_id))
  if (ids.length === 0) return
  await client.query(
    `INSERT INTO audit_log (account_id, table_name, row_id, row_key, action,
                            changed, user_id, support_session_id)
     SELECT account_id, 'guest', id, jsonb_build_object('id', id), 'UPDATE',
            jsonb_build_object('id_document_number', 'an AVS ausgegeben'), $2, $3
       FROM guest WHERE id = ANY($1::bigint[])`,
    [ids, principal.userId, principal.supportSessionId])
}
