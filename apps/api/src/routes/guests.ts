import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { encryptIdDocument, decryptIdDocument, maskIdDocument } from '../platform/crypto.js'
import type { Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

const config = loadConfig()

interface GuestBody {
  accountId?: number
  lastName: string
  firstName?: string
  email?: string
  phone?: string
  birthDate?: string
  nationality?: string
  language?: string
  addressLine1?: string
  postalCode?: string
  city?: string
  country?: string
  idDocumentType?: 'passport' | 'id_card' | 'other'
  idDocumentNumber?: string
  preferences?: Record<string, unknown>
}

const FIELDS = `id, public_ref, last_name, first_name, email, phone,
                birth_date::text AS birth_date, nationality, language,
                address_line1, postal_code, city, country,
                id_document_type, id_document_key_version, preferences, status`

interface GuestRow {
  id: number; public_ref: string; last_name: string; first_name: string | null
  email: string | null; phone: string | null; birth_date: string | null
  nationality: string | null; language: string; address_line1: string | null
  postal_code: string | null; city: string | null; country: string | null
  id_document_type: string | null; id_document_key_version: number | null
  preferences: Record<string, unknown>; status: string
}

function present(r: GuestRow): Record<string, unknown> {
  return {
    guestRef: r.public_ref,
    lastName: r.last_name, firstName: r.first_name,
    email: r.email, phone: r.phone, birthDate: r.birth_date,
    nationality: r.nationality, language: r.language,
    address: { line1: r.address_line1, postalCode: r.postal_code,
               city: r.city, country: r.country },
    idDocumentType: r.id_document_type,
    // Ob eine Nummer hinterlegt ist, darf jeder sehen; die Nummer selbst
    // braucht guest:read_identity und eine eigene Anfrage.
    hasIdDocumentNumber: r.id_document_key_version !== null,
    preferences: r.preferences,
    status: r.status
  }
}

/**
 * Der einzige Account, in dem dieser Aufrufer schreiben darf.
 * Wer mehrere Accounts sieht, muss ihn angeben; sonst landet ein Gast im
 * falschen Mandanten und die Zeilenrichtlinie bemerkt es nicht, weil beide
 * im Kontext stehen.
 */
function accountFor(principal: Principal, given: number | undefined): number {
  if (given !== undefined) {
    if (!principal.accountIds.includes(given)) {
      throw Errors.forbidden('Account liegt nicht im Zugriffsbereich.')
    }
    return given
  }
  if (principal.accountIds.length === 1) return principal.accountIds[0]!
  throw Errors.validation({ accountId: ['Pflichtfeld bei mehreren Accounts'] })
}

/**
 * Dublettensuche. Nicht blockierend, sondern hinweisend: die Rezeption
 * entscheidet. Ein System, das das Anlegen verweigert, wird mit
 * "Mueller2" umgangen und hat dann zwei Profile statt einer Warnung.
 */
async function findDuplicates(
  client: PoolClient, accountId: number, g: GuestBody, excludeId?: number
): Promise<Array<{ guestRef: string; score: number; reason: string }>> {
  const { rows } = await client.query<{ public_ref: string; score: string; reason: string }>(
    `SELECT public_ref, score::text, reason FROM (
       SELECT public_ref,
              CASE
                WHEN $3 <> '' AND lower(email) = lower($3) THEN 1.0
                WHEN $4 <> '' AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g')
                     = regexp_replace($4, '[^0-9]', '', 'g') THEN 0.9
                ELSE similarity(last_name, $2)
                     * CASE WHEN $5::date IS NOT NULL AND birth_date = $5::date THEN 1.0
                            WHEN $6 <> '' AND lower(coalesce(first_name,'')) = lower($6) THEN 0.9
                            ELSE 0.6 END
              END AS score,
              CASE
                WHEN $3 <> '' AND lower(email) = lower($3) THEN 'gleiche E-Mail'
                WHEN $4 <> '' AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g')
                     = regexp_replace($4, '[^0-9]', '', 'g') THEN 'gleiche Telefonnummer'
                WHEN $5::date IS NOT NULL AND birth_date = $5::date
                     THEN 'gleicher Name und Geburtsdatum'
                ELSE 'aehnlicher Name'
              END AS reason
         FROM guest
        WHERE account_id = $1 AND status = 'active'
          AND ($7::bigint IS NULL OR id <> $7)
          AND (last_name % $2
               OR ($3 <> '' AND lower(email) = lower($3))
               OR ($4 <> '' AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g')
                   = regexp_replace($4, '[^0-9]', '', 'g')))
     ) k
     WHERE score >= 0.55 ORDER BY score DESC LIMIT 5`,
    [accountId, g.lastName, g.email ?? '', g.phone ?? '',
     g.birthDate ?? null, g.firstName ?? '', excludeId ?? null])
  return rows.map(r => ({ guestRef: r.public_ref, score: Number(r.score), reason: r.reason }))
}

export function guestRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/guests',
    permission: 'guest:read',
    summary: 'Gaeste suchen',
    handler: async (req) => {
      const q = req.query as { q?: string; limit?: string }
      const term = (q.q ?? '').trim()
      if (term.length < 2) {
        throw Errors.validation({ q: ['Mindestens zwei Zeichen'] })
      }
      const limit = Math.min(Number(q.limit ?? 20) || 20, 100)
      return tx(req.pool, req, async client => {
        /*
         * Eine Abfrage, feste Obergrenze, und vor allem: **kein
         * Sortierschritt ueber alle Treffer**.
         *
         * `ORDER BY last_name <-> $1` laesst den GiST-Trigramm-Index die
         * naechsten Nachbarn der Reihe nach liefern; der Scan hoert nach
         * `limit` Zeilen auf. Die Vorgaengerfassung sortierte nach
         * `similarity(...) DESC` und musste dafuer jeden Treffer holen: bei
         * einem haeufigen Namen Tausende Zeilen fuer zwanzig Ausgaben, und
         * ausgerechnet bei "Mueller" am langsamsten (Migration 0015).
         *
         * Die E-Mail wird nicht unscharf gesucht, sondern von vorn getippt,
         * und laeuft deshalb ueber einen eigenen, eigenstaendig begrenzten
         * Zweig statt ueber ein ODER, das beide Indizes ausschliessen wuerde.
         */
        const { rows } = await client.query<GuestRow & { dist: number }>(
          `WITH nach_name AS (
             SELECT ${FIELDS}, (last_name <-> $1) AS dist
               FROM guest
              WHERE status <> 'anonymized' AND last_name % $1
              ORDER BY last_name <-> $1
              LIMIT $2
           ), nach_email AS (
             SELECT ${FIELDS}, 0.0 AS dist
               FROM guest
              WHERE status <> 'anonymized' AND email IS NOT NULL
                AND lower(email) LIKE lower($1) || '%'
              LIMIT $2
           ), zusammen AS (
             SELECT DISTINCT ON (id) *
               FROM (SELECT * FROM nach_name UNION ALL SELECT * FROM nach_email) k
              ORDER BY id, dist
           )
           SELECT * FROM zusammen ORDER BY dist, last_name LIMIT $2`,
          [term, limit])
        return { guests: rows.map(present) }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/guests',
    permission: 'guest:write',
    summary: 'Gast anlegen',
    handler: async (req, reply) => {
      const body = req.body as GuestBody
      const principal = req.principal as Principal
      if (!body.lastName || body.lastName.trim() === '') {
        throw Errors.validation({ lastName: ['Pflichtfeld'] })
      }
      const accountId = accountFor(principal, body.accountId)

      return tx(req.pool, req, async client => {
        const duplicates = await findDuplicates(client, accountId, body)
        const enc = body.idDocumentNumber
          ? encryptIdDocument(body.idDocumentNumber, config.idDocumentKey) : null

        const { rows } = await client.query<GuestRow>(
          `INSERT INTO guest (account_id, last_name, first_name, email, phone, birth_date,
                              nationality, language, address_line1, postal_code, city, country,
                              id_document_type, id_document_number_enc, id_document_key_version,
                              preferences)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING ${FIELDS}`,
          [accountId, body.lastName.trim(), body.firstName ?? null, body.email ?? null,
           body.phone ?? null, body.birthDate ?? null, body.nationality ?? null,
           body.language ?? 'de', body.addressLine1 ?? null, body.postalCode ?? null,
           body.city ?? null, body.country ?? null, body.idDocumentType ?? null,
           enc?.ciphertext ?? null, enc?.keyVersion ?? null,
           JSON.stringify(body.preferences ?? {})])

        reply.status(201)
        return { ...present(rows[0]!), possibleDuplicates: duplicates }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/guests/:guestRef',
    permission: 'guest:read',
    summary: 'Gast lesen',
    handler: async (req) => {
      const { guestRef } = req.params as { guestRef: string }
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<GuestRow>(
          `SELECT ${FIELDS} FROM guest WHERE public_ref = $1`, [guestRef])
        if (rowCount === 0) throw Errors.notFound('Gast')
        return present(rows[0]!)
      })
    }
  })

  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/guests/:guestRef',
    permission: 'guest:write',
    summary: 'Gast aendern',
    handler: async (req) => {
      const { guestRef } = req.params as { guestRef: string }
      const body = req.body as Partial<GuestBody>
      return tx(req.pool, req, async client => {
        const cur = await client.query<{ id: number; status: string }>(
          `SELECT id, status FROM guest WHERE public_ref = $1 FOR UPDATE`, [guestRef])
        if (cur.rowCount === 0) throw Errors.notFound('Gast')
        if (cur.rows[0]!.status === 'anonymized') {
          throw Errors.conflict('Ein anonymisiertes Profil wird nicht wiederbelebt.')
        }
        const enc = body.idDocumentNumber
          ? encryptIdDocument(body.idDocumentNumber, config.idDocumentKey) : null

        const { rows } = await client.query<GuestRow>(
          `UPDATE guest SET
             last_name     = COALESCE($2, last_name),
             first_name    = COALESCE($3, first_name),
             email         = COALESCE($4, email),
             phone         = COALESCE($5, phone),
             birth_date    = COALESCE($6::date, birth_date),
             nationality   = COALESCE($7, nationality),
             language      = COALESCE($8, language),
             address_line1 = COALESCE($9, address_line1),
             postal_code   = COALESCE($10, postal_code),
             city          = COALESCE($11, city),
             country       = COALESCE($12, country),
             id_document_type = COALESCE($13, id_document_type),
             id_document_number_enc  = COALESCE($14, id_document_number_enc),
             id_document_key_version = COALESCE($15, id_document_key_version),
             preferences   = COALESCE($16::jsonb, preferences),
             updated_at    = now()
           WHERE id = $1 RETURNING ${FIELDS}`,
          [cur.rows[0]!.id, body.lastName ?? null, body.firstName ?? null, body.email ?? null,
           body.phone ?? null, body.birthDate ?? null, body.nationality ?? null,
           body.language ?? null, body.addressLine1 ?? null, body.postalCode ?? null,
           body.city ?? null, body.country ?? null, body.idDocumentType ?? null,
           enc?.ciphertext ?? null, enc?.keyVersion ?? null,
           body.preferences ? JSON.stringify(body.preferences) : null])
        return present(rows[0]!)
      })
    }
  })

  /**
   * Die Ausweisnummer liegt hinter einer eigenen Berechtigung und einer
   * eigenen Anfrage, damit sie nicht bei jeder Gastanzeige mitlaeuft und
   * jeder Abruf einzeln im Protokoll steht.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/guests/:guestRef/id-document',
    permission: 'guest:read_identity',
    summary: 'Ausweisnummer lesen',
    handler: async (req) => {
      const { guestRef } = req.params as { guestRef: string }
      const q = req.query as { full?: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{
          id: number; id_document_type: string | null
          id_document_number_enc: Buffer | null; id_document_key_version: number | null }>(
          `SELECT id, id_document_type, id_document_number_enc, id_document_key_version
             FROM guest WHERE public_ref = $1`, [guestRef])
        if (rowCount === 0) throw Errors.notFound('Gast')
        const g = rows[0]!
        if (g.id_document_number_enc === null || g.id_document_key_version === null) {
          return { guestRef, idDocumentType: g.id_document_type, number: null }
        }
        const klar = decryptIdDocument(
          g.id_document_number_enc, config.idDocumentKey, g.id_document_key_version)

        // Jeder Abruf wird protokolliert, auch der maskierte: der Zugriff auf
        // ein Ausweismerkmal ist die Tatsache, die nachweisbar sein muss.
        await client.query(
          `INSERT INTO audit_log (account_id, table_name, row_id, row_key, action,
                                  changed, user_id, support_session_id)
           SELECT account_id, 'guest', id, jsonb_build_object('id', id), 'UPDATE',
                  jsonb_build_object('id_document_number', 'gelesen'), $2, $3
             FROM guest WHERE id = $1`,
          [g.id, principal.userId, principal.supportSessionId])

        return {
          guestRef,
          idDocumentType: g.id_document_type,
          number: q.full === 'true' ? klar : maskIdDocument(klar)
        }
      })
    }
  })

  /**
   * Auskunft nach Art. 15 DSGVO. Liefert alles, was ueber diesen Gast
   * gespeichert ist, in einer Anfrage, damit die Frist von einem Monat
   * nicht an Handarbeit scheitert.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/guests/:guestRef/data-export',
    permission: 'guest:export',
    summary: 'Datenauskunft nach Art. 15 DSGVO',
    handler: async (req) => {
      const { guestRef } = req.params as { guestRef: string }
      return tx(req.pool, req, async client => {
        const g = await client.query<GuestRow & { created_at: string }>(
          `SELECT ${FIELDS}, created_at::text FROM guest WHERE public_ref = $1`, [guestRef])
        if (g.rowCount === 0) throw Errors.notFound('Gast')
        const id = g.rows[0]!.id

        const stays = await client.query(
          `SELECT r.public_ref AS "reservationRef", p.name AS property,
                  r.arrival::text AS arrival, r.departure::text AS departure,
                  r.status::text AS status
             FROM reservation r
             JOIN property p ON p.id = r.property_id
            WHERE r.primary_guest_id = $1
               OR EXISTS (SELECT 1 FROM reservation_occupant o
                           WHERE o.reservation_id = r.id AND o.guest_id = $1)
            ORDER BY r.arrival DESC`, [id])
        const invoices = await client.query(
          `SELECT i.number, i.issued_on::text AS "issuedOn",
                  (i.totals->>'grossCent')::bigint AS "grossCent"
             FROM invoice i JOIN folio f ON f.id = i.folio_id
            WHERE f.guest_id = $1 ORDER BY i.issued_on DESC`, [id])
        const notes = await client.query(
          `SELECT n.note, n.created_at::text AS "createdAt", p.name AS property
             FROM guest_property_note n JOIN property p ON p.id = n.property_id
            WHERE n.guest_id = $1 ORDER BY n.created_at DESC`, [id])
        const registrations = await client.query(
          `SELECT arrival::text AS arrival, planned_departure::text AS "plannedDeparture",
                  destroy_after::text AS "destroyAfter"
             FROM registration WHERE guest_id = $1 ORDER BY arrival DESC`, [id])

        return {
          profile: present(g.rows[0]!),
          createdAt: g.rows[0]!.created_at,
          stays: stays.rows,
          invoices: invoices.rows,
          notes: notes.rows,
          registrations: registrations.rows,
          hinweis: 'Rechnungen unterliegen der steuerlichen Aufbewahrungsfrist '
                 + 'und werden bei einer Loeschung nicht entfernt.'
        }
      })
    }
  })

  /**
   * Loeschung nach Art. 17 DSGVO, umgesetzt als Anonymisierung.
   *
   * Ein echtes DELETE ist nicht moeglich und nicht zulaessig: Rechnungen und
   * Buchungsbelege unterliegen der Aufbewahrungsfrist von acht Jahren. Das
   * Profil wird daher entpersonalisiert, die Belege bleiben unveraendert.
   * Ihre Empfaengerangaben stehen ohnehin als Momentaufnahme in der Rechnung
   * und nicht als Verweis auf das Profil (B6, Dokument 13).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/guests/:guestRef/anonymize',
    permission: 'guest:export',
    summary: 'Gast anonymisieren (Art. 17 DSGVO)',
    handler: async (req) => {
      const { guestRef } = req.params as { guestRef: string }
      return tx(req.pool, req, async client => {
        const cur = await client.query<{ id: number; status: string }>(
          `SELECT id, status FROM guest WHERE public_ref = $1 FOR UPDATE`, [guestRef])
        if (cur.rowCount === 0) throw Errors.notFound('Gast')
        const id = cur.rows[0]!.id
        if (cur.rows[0]!.status === 'anonymized') {
          return { guestRef, status: 'anonymized', alreadyDone: true }
        }

        // Ein laufender Aufenthalt blockiert: solange der Gast im Haus ist,
        // braucht der Betrieb die Daten fuer den Meldeschein.
        const aktiv = await client.query(
          `SELECT 1 FROM reservation r
            WHERE (r.primary_guest_id = $1
                   OR EXISTS (SELECT 1 FROM reservation_occupant o
                               WHERE o.reservation_id = r.id AND o.guest_id = $1))
              AND r.status IN ('Optional','Confirmed','InHouse') LIMIT 1`, [id])
        if (aktiv.rowCount && aktiv.rowCount > 0) {
          throw Errors.conflict(
            'Es gibt noch offene oder laufende Reservierungen fuer diesen Gast.')
        }

        await client.query(
          `UPDATE guest SET
             last_name = 'Anonymisiert', first_name = NULL, email = NULL, phone = NULL,
             birth_date = NULL, nationality = NULL, address_line1 = NULL,
             postal_code = NULL, city = NULL, country = NULL,
             id_document_type = NULL, id_document_number_enc = NULL,
             id_document_key_version = NULL, preferences = '{}',
             status = 'anonymized', anonymized_at = now(), updated_at = now()
           WHERE id = $1`, [id])
        // Hausnotizen sind freier Text und koennen alles enthalten.
        await client.query(`DELETE FROM guest_property_note WHERE guest_id = $1`, [id])
        // Meldescheine haben eine eigene, kuerzere Frist und gehen mit.
        await client.query(`DELETE FROM registration WHERE guest_id = $1`, [id])

        return { guestRef, status: 'anonymized', alreadyDone: false }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/guests/:guestRef/notes',
    permission: 'guest:write',
    propertyParam: 'propertyId',
    summary: 'Hausnotiz zum Gast anlegen',
    handler: async (req, reply) => {
      const { guestRef } = req.params as { guestRef: string }
      const { propertyId, note } = req.body as { propertyId: number; note: string }
      const principal = req.principal as Principal
      if (!note || note.trim() === '') throw Errors.validation({ note: ['Pflichtfeld'] })
      return tx(req.pool, req, async client => {
        const g = await client.query<{ id: number }>(
          `SELECT id FROM guest WHERE public_ref = $1`, [guestRef])
        if (g.rowCount === 0) throw Errors.notFound('Gast')
        await client.query(
          `INSERT INTO guest_property_note (property_id, guest_id, note, created_by)
           VALUES ($1,$2,$3,$4)`,
          [propertyId, g.rows[0]!.id, note.trim(), principal.userId])
        reply.status(201)
        return { guestRef, propertyId }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/companies',
    permission: 'guest:write',
    summary: 'Firma anlegen',
    handler: async (req, reply) => {
      const body = req.body as {
        accountId?: number; name: string; vatId?: string; addressLine1?: string
        postalCode?: string; city?: string; country?: string
        paymentTermsDays?: number; invoiceEmail?: string }
      const principal = req.principal as Principal
      if (!body.name || body.name.trim() === '') {
        throw Errors.validation({ name: ['Pflichtfeld'] })
      }
      const accountId = accountFor(principal, body.accountId)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ public_ref: string }>(
          `INSERT INTO company (account_id, name, vat_id, address_line1, postal_code,
                                city, country, payment_terms_days, invoice_email)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'DE'),COALESCE($8,14),$9)
           RETURNING public_ref`,
          [accountId, body.name.trim(), body.vatId ?? null, body.addressLine1 ?? null,
           body.postalCode ?? null, body.city ?? null, body.country ?? null,
           body.paymentTermsDays ?? null, body.invoiceEmail ?? null])
        reply.status(201)
        return { companyRef: rows[0]!.public_ref, name: body.name.trim() }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/companies',
    permission: 'guest:read',
    summary: 'Firmen suchen',
    handler: async (req) => {
      const q = req.query as { q?: string }
      const term = (q.q ?? '').trim()
      if (term.length < 2) throw Errors.validation({ q: ['Mindestens zwei Zeichen'] })
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT public_ref AS "companyRef", name, vat_id AS "vatId", city,
                  payment_terms_days AS "paymentTermsDays"
             FROM company WHERE active AND name % $1
            ORDER BY name <-> $1 LIMIT 50`, [term])
        return { companies: rows }
      })
    }
  })
}
