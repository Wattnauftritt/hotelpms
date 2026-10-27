import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT, type PoolClient } from '@hotelpms/db'
import { encryptSecret, decryptSecret, isIsoDate, addDays,
         PORTAL_NUMMER } from '@hotelpms/domain'
import { MAX_MITREISENDE, type MeldescheinPortalView, type MeldescheinPortalSubmitted,
         type CheckinPortalSubmission, type CheckinPortalCandidate } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'
import { rechtImHaus } from './depositRequests.js'
import { AppError, Errors, type Meldung } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { tooManyRequests } from '../platform/rateLimit.js'
import { geltendeBedingungen } from '../platform/hausbedingungen.js'
import { reservierungLaden, meldescheinEinreichen, pruefe, befreiungsgruende,
         meldetAnAvs, type Einreichung } from './checkin.js'

/**
 * Meldeschein ueber den festen Link je Haus (Migration 0216).
 *
 * Booking.com stellt die Einladung an seine Weiterleitungsadressen nicht zu.
 * Gaeste von Booking.com bekommen den Link deshalb ueber eine
 * Nachrichtenvorlage von Booking.com, geben Buchungsnummer und Anreisetag ein
 * und fuellen den Meldeschein aus. StayGrid ordnet ihn der Reservierung zu,
 * sobald es die Nummer kennt (0215) -- sofort, wenn sie schon da ist.
 */

/** Zweck in der Schluesselableitung: ein Chiffrat hier ist keines anderswo. */
const ZWECK = 'meldeschein-portal'

/** Zustaende, in denen ein Meldeschein noch erfasst werden kann; wie `OFFEN` am Link. */
const OFFEN = ['Optional', 'Confirmed', 'InHouse']

export interface PortalKontext {
  propertyId: number
  accountId: number
  /** Der offene Geschaeftstag des Hauses, gegen ihn laufen alle Fristen. */
  businessDate: string
}

/**
 * Eine Transaktion im Kontext des Hauses zum Link, wie `mappeTx`: die
 * Datenbank loest die Kennung mit leerem Kontext ein und setzt ihn auf genau
 * dieses Haus (`checkin_portal_open`). Alles danach laeuft unter der
 * Zeilenrichtlinie.
 */
export function portalTx<T>(
  req: FastifyRequest, ref: string,
  fn: (client: PoolClient, k: PortalKontext) => Promise<T>
): Promise<T> {
  // Die Form von generate_public_ref; alles andere fragt die Datenbank nicht.
  if (!/^[0-9A-Z]{8,32}$/.test(ref)) throw Errors.notFound('res.property')
  return withTransaction(req.pool, SYSTEM_CONTEXT, async client => {
    const r = await client.query<{
      out_property_id: number; out_account_id: number
      out_business_date: string; out_state: string }>(
      `SELECT out_property_id::int, out_account_id::int, out_business_date::text, out_state
         FROM checkin_portal_open($1)`, [ref])
    const z = r.rows[0]
    if (z === undefined || z.out_state !== 'valid') throw Errors.notFound('res.property')
    return fn(client, { propertyId: z.out_property_id, accountId: z.out_account_id,
                        businessDate: z.out_business_date })
  }, b => {
    req.dbKosten.anweisungen += b.anweisungen
    req.dbKosten.dauerMs += b.dauerMs
  })
}

export function abgabeVerschluesseln(e: Einreichung): Buffer {
  return encryptSecret(JSON.stringify(e), loadConfig().idDocumentKey, ZWECK)
}

function abgabeEntschluesseln(b: Buffer): Einreichung {
  return JSON.parse(decryptSecret(b, loadConfig().idDocumentKey, ZWECK)) as Einreichung
}

export type Zuordnung = 'assigned' | 'waiting' | 'registered' | 'rejected'

/**
 * Eine abgegebene Meldung einer Reservierung zuordnen.
 *
 * Gesucht wird ueber die Nummer beim Portal und den Anreisetag, beide genau.
 * Laut Sven stimmt die Nummer immer; ein vertippter Anreisetag landet bei der
 * Rezeption, nicht an einer Reservierung, die nur ungefaehr passt. Bei einer
 * Buchung mit mehreren Zimmern bekommt die erste ohne Meldeschein ihn.
 *
 * **In einem Sicherungspunkt.** Passt der Schein nicht (eine Hausbedingung
 * kam neu dazu, ein Befreiungsgrund wird nicht mehr angeboten), bleibt er
 * liegen und die Rezeption sieht den Grund. Der Aufrufer -- ein Push des
 * Umsystems etwa -- soll daran nicht scheitern.
 *
 * `reservationId` setzt die Rezeption, wenn sie von Hand zuordnet.
 */
export async function abgabeZuordnen(
  client: PoolClient, submissionId: number, reservationId?: number
): Promise<Zuordnung> {
  const s = (await client.query<{
    id: number; property_id: number; booking_number: string; arrival: string
    payload_enc: Buffer }>(
    `SELECT id, property_id, booking_number, arrival::text, payload_enc
       FROM checkin_portal_submission WHERE id = $1 FOR UPDATE`, [submissionId])).rows[0]
  if (s === undefined) return 'assigned'

  let ziel: number | undefined = reservationId
  if (ziel === undefined) {
    const kandidaten = (await client.query<{ id: number; registriert: boolean }>(
      `SELECT r.id::int,
              EXISTS (SELECT 1 FROM registration g WHERE g.reservation_id = r.id) AS registriert
         FROM reservation r JOIN booking b ON b.id = r.booking_id
        WHERE b.property_id = $1 AND b.channel_booking_number = $2
          AND r.arrival = $3::date AND r.status::text = ANY ($4::text[])
          AND r.primary_guest_id IS NOT NULL
        ORDER BY r.id`,
      [s.property_id, s.booking_number, s.arrival, OFFEN])).rows
    if (kandidaten.length === 0) return 'waiting'
    ziel = kandidaten.find(k => !k.registriert)?.id
    if (ziel === undefined) {
      await client.query(
        `UPDATE checkin_portal_submission SET hold_reason = 'registered' WHERE id = $1`, [s.id])
      return 'registered'
    }
  }

  const r = await reservierungLaden(client, ziel)
  if (r === null || r.property_id !== s.property_id) throw Errors.notFound('res.reservation')
  if (r.reg_id !== null && reservationId !== undefined) throw Errors.conflict('checkin.alreadyDone')
  if (r.reg_id !== null) {
    await client.query(
      `UPDATE checkin_portal_submission SET hold_reason = 'registered' WHERE id = $1`, [s.id])
    return 'registered'
  }

  await client.query('SAVEPOINT portal_zuordnen')
  try {
    // Ueber den Link aus der Mail: unterschrieben wird am Anreisetag im Haus.
    await meldescheinEinreichen(client, r, abgabeEntschluesseln(s.payload_enc),
      { hier: false, quelle: 'online' })
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT portal_zuordnen')
    // Von Hand soll die Rezeption den Grund sehen, nicht nur "liegt weiter".
    if (reservationId !== undefined) throw e
    await client.query(
      `UPDATE checkin_portal_submission SET hold_reason = 'rejected' WHERE id = $1`, [s.id])
    return 'rejected'
  }
  await client.query('RELEASE SAVEPOINT portal_zuordnen')
  // Jetzt steht alles am Meldeschein; die Abgabe hier ist nur noch eine Kopie.
  await client.query(`DELETE FROM checkin_portal_submission WHERE id = $1`, [s.id])
  return 'assigned'
}

/**
 * Was zu dieser Nummer wartet, zuordnen -- wenn das Umsystem sie meldet.
 * Eine Anweisung fuer die Suche, eine Zuordnung je Abgabe; an einer Nummer
 * haengen eine oder zwei, nicht hundert.
 */
export async function abgabenZurNummer(
  client: PoolClient, propertyId: number, nummer: string
): Promise<void> {
  const { rows } = await client.query<{ id: number }>(
    `SELECT id::int FROM checkin_portal_submission
      WHERE property_id = $1 AND booking_number = $2 ORDER BY id`, [propertyId, nummer])
  for (const z of rows) await abgabeZuordnen(client, z.id)
}

// ------------------------------------------------------------------ Gastseite

/**
 * Wie weit der Anreisetag vom Geschaeftstag abweichen darf. Zwei Tage
 * zurueck fuer den Gast, der spaet ankam und am naechsten Morgen ausfuellt;
 * gut ein Jahr voraus, so weit verkaufen die Portale. Ohne Grenze waere das
 * Feld ein Weg, Abgaben anzulegen, die die Loeschung nach sieben Tagen nie
 * erreicht.
 */
const ANREISE_ZURUECK = 2
const ANREISE_VORAUS = 400

/**
 * Abgaben je Herkunft und Tag. Eine Familie hinter einer Adresse gibt drei,
 * vier Scheine ab, ein Reisebuero vielleicht zehn. Wer mehr schickt, legt
 * Datensaetze an, die niemand zuordnet.
 */
const ABGABEN_JE_HERKUNFT = 20
const HERKUNFT_FENSTER_SEKUNDEN = 24 * 3600

/**
 * Wartende Abgaben je Nummer. Eine Buchung mit mehreren Zimmern hat eine
 * Nummer; fuenf reichen fuer die groessten, die ueber ein Portal kommen.
 */
const WARTEND_JE_NUMMER = 5

function nichtSpeichern(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store')
}

function anreisePruefen(roh: unknown, heute: string, feld: string): string {
  if (typeof roh !== 'string' || !isIsoDate(roh)
      || roh < addDays(heute, -ANREISE_ZURUECK) || roh > addDays(heute, ANREISE_VORAUS)) {
    throw Errors.validation({ [feld]: ['field.invalid'] })
  }
  return roh
}

function nummerPruefen(roh: unknown): string {
  const t = typeof roh === 'number' && Number.isSafeInteger(roh) && roh >= 0 ? String(roh)
    : typeof roh === 'string' ? roh.trim() : ''
  if (!PORTAL_NUMMER.test(t)) throw Errors.validation({ bookingNumber: ['field.invalid'] })
  return t
}

export function meldescheinPortalRoutes(app: FastifyInstance): void {
  /**
   * Was das Formular braucht: Hausbedingungen, Befreiungsgruende, ob das
   * Haus die digitale Gaestekarte anbietet. Nichts ueber eine Buchung --
   * die Seite fragt nach keiner, bevor der Gast abgibt.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/meldeschein/:portalRef/form',
    // Oeffentlich: der Link steht in einer Vorlage, die jeder Gast des Hauses
    // bekommt, und die Antwort traegt nur, was das Haus jedem Gast zeigt.
    permission: null,
    summary: 'Meldeschein ueber den festen Link: was das Formular braucht',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      const { portalRef } = req.params as { portalRef: string }
      const q = req.query as { arrival?: unknown }
      return portalTx(req, portalRef, async (client, k): Promise<MeldescheinPortalView> => {
        const anreise = q.arrival === undefined ? k.businessDate
          : anreisePruefen(q.arrival, k.businessDate, 'arrival')
        const haus = await client.query<{ name: string }>(
          `SELECT name FROM property WHERE id = $1`, [k.propertyId])
        // Reservierung 0 gibt es nicht: alle Bedingungen des Tages, keine zugestimmt.
        const bedingungen = await geltendeBedingungen(client,
          { id: 0, propertyId: k.propertyId, arrival: anreise })
        return {
          propertyName: haus.rows[0]!.name,
          maxCompanions: MAX_MITREISENDE,
          terms: bedingungen.map(b => ({
            termsRef: b.termsRef, title: b.title, body: b.body,
            requiresSignature: b.requiresSignature })),
          digitalGuestCardOffered: await meldetAnAvs(client, k.propertyId),
          exemptionReasons: (await befreiungsgruende(client, k.propertyId)).map(g => ({
            code: g.code, label: g.label, needsProof: g.needs_proof }))
        }
      })
    }
  })

  /**
   * Einen Meldeschein abgeben. Die Antwort ist immer dieselbe, ob es die
   * Buchung gibt oder nicht, ob sie schon einen Meldeschein hat oder nicht:
   * mit Nummer und Anreisetag allein soll sich nichts erfahren lassen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/meldeschein/:portalRef',
    // Oeffentlich wie das Formular. Gelesen wird hier nichts; die Grenzen je
    // Herkunft und je Nummer halten die Tabelle klein.
    permission: null,
    summary: 'Meldeschein ueber den festen Link abgeben',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      const { portalRef } = req.params as { portalRef: string }
      const b = req.body
      if (typeof b !== 'object' || b === null || Array.isArray(b)) {
        throw Errors.validation({ body: ['field.bodyMissing'] })
      }
      const { bookingNumber, arrival, ...rest } = b as Record<string, unknown>
      const herkunft = createHash('sha256').update(req.ip).digest('hex')

      return portalTx(req, portalRef, async (client, k): Promise<MeldescheinPortalSubmitted> => {
        const f: Record<string, Meldung[]> = {}
        let nummer = '', anreise = ''
        try { nummer = nummerPruefen(bookingNumber) } catch { f.bookingNumber = ['field.invalid'] }
        try { anreise = anreisePruefen(arrival, k.businessDate, 'arrival') } catch { f.arrival = ['field.invalid'] }
        let e: Einreichung
        try {
          // Wie der Link aus der Mail: unterschrieben wird im Haus, die
          // Ankunftszeit ist gefragt.
          e = pruefe(rest, k.businessDate, 'mail')
        } catch (err) {
          // Alle Fehler auf einmal, nicht erst die Nummer und dann den Rest.
          if (!(err instanceof AppError) || err.errorKeys === undefined) throw err
          throw Errors.validation({ ...err.errorKeys, ...f } as Record<string, Meldung[]>,
            { max: MAX_MITREISENDE })
        }
        if (Object.keys(f).length > 0) throw Errors.validation(f)

        const stand = await client.query<{ submissions: number }>(
          `INSERT INTO checkin_portal_origin AS o (property_id, origin_hash, submissions)
           VALUES ($1, $2, 1)
           ON CONFLICT (property_id, origin_hash) DO UPDATE SET
             submissions  = CASE WHEN o.window_start > now() - make_interval(secs => $3)
                                 THEN o.submissions + 1 ELSE 1 END,
             window_start = CASE WHEN o.window_start > now() - make_interval(secs => $3)
                                 THEN o.window_start ELSE now() END
           RETURNING submissions`,
          [k.propertyId, herkunft, HERKUNFT_FENSTER_SEKUNDEN])
        if (stand.rows[0]!.submissions > ABGABEN_JE_HERKUNFT) {
          throw tooManyRequests(HERKUNFT_FENSTER_SEKUNDEN)
        }
        const wartend = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM checkin_portal_submission
            WHERE property_id = $1 AND booking_number = $2`, [k.propertyId, nummer])
        if (wartend.rows[0]!.n >= WARTEND_JE_NUMMER) throw tooManyRequests(HERKUNFT_FENSTER_SEKUNDEN)

        const neu = await client.query<{ id: number }>(
          `INSERT INTO checkin_portal_submission
                  (property_id, booking_number, arrival, payload_enc, last_name)
           VALUES ($1, $2, $3::date, $4, $5) RETURNING id::int`,
          [k.propertyId, nummer, anreise, abgabeVerschluesseln(e), e.guest.lastName])
        await abgabeZuordnen(client, neu.rows[0]!.id)
        reply.status(201)
        return { state: 'received' }
      })
    }
  })
}

// ------------------------------------------------------------------ Rezeption

/** Wie weit die Rezeption beim Zuordnen von Hand um den angegebenen Anreisetag sucht. */
const KANDIDATEN_TAGE = 3

export function meldescheinPortalRezeptionRoutes(app: FastifyInstance): void {
  /**
   * Was am festen Link abgegeben wurde und noch keiner Reservierung gehoert.
   * Nur Nachname, Nummer, Anreisetag und Grund: mehr braucht die Rezeption
   * nicht, um zu sehen, wessen Schein es ist. Der Inhalt steht danach am
   * Meldeschein, hinter dessen eigenem Recht.
   *
   * Unter `reservation:checkin` wie das Erfassen am Tresen: zuordnen heisst
   * einen Meldeschein anlegen.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/checkin-portal/submissions',
    permission: 'reservation:checkin',
    propertyParam: 'propertyId',
    summary: 'Meldescheine vom festen Link, die noch keiner Reservierung gehoeren',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<CheckinPortalSubmission>(
          `SELECT public_ref AS ref, last_name AS "lastName", booking_number AS "bookingNumber",
                  arrival::text, created_at AS "createdAt", hold_reason AS "holdReason"
             FROM checkin_portal_submission
            WHERE property_id = $1
            ORDER BY arrival, id`, [Number(propertyId)])
        return { submissions: rows }
      })
    }
  })

  /**
   * Reservierungen, zu denen ein wartender Schein gehoeren koennte: um den
   * angegebenen Anreisetag, noch offen, noch ohne Meldeschein. Die mit
   * derselben Nummer oder demselben Nachnamen zuerst.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/checkin-portal/submissions/:ref/candidates',
    permission: 'reservation:checkin',
    summary: 'Reservierungen, denen ein Meldeschein vom festen Link gehoeren koennte',
    handler: async (req) => {
      const { ref } = req.params as { ref: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const s = await abgabeZurKennung(client, ref, principal)
        const { rows } = await client.query<CheckinPortalCandidate>(
          `SELECT r.public_ref AS "reservationRef", r.arrival::text, r.departure::text,
                  g.last_name AS "lastName", g.first_name AS "firstName",
                  x.code AS room, b.channel_booking_number AS "bookingNumber"
             FROM reservation r
             JOIN booking b ON b.id = r.booking_id
             JOIN guest g ON g.id = r.primary_guest_id
             LEFT JOIN resource x ON x.id = r.resource_id
            WHERE r.property_id = $1 AND r.status::text = ANY ($2::text[])
              AND r.arrival BETWEEN $3::date - $4::int AND $3::date + $4::int
              AND NOT EXISTS (SELECT 1 FROM registration m WHERE m.reservation_id = r.id)
            ORDER BY (b.channel_booking_number IS NOT DISTINCT FROM $5) DESC,
                     (lower(g.last_name) = lower($6)) DESC,
                     abs(r.arrival - $3::date), g.last_name, r.id
            LIMIT 100`,
          [s.property_id, OFFEN, s.arrival, KANDIDATEN_TAGE, s.booking_number, s.last_name])
        return { candidates: rows }
      })
    }
  })

  /**
   * Von Hand zuordnen. Laeuft ueber dieselbe Zuordnung wie der Abgleich,
   * nur dass ein Fehler hier zur Rezeption geht, statt den Schein liegen zu
   * lassen: sie soll sehen, warum es nicht geht.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/checkin-portal/submissions/:ref/assign',
    permission: 'reservation:checkin',
    summary: 'Meldeschein vom festen Link einer Reservierung zuordnen',
    handler: async (req) => {
      const { ref } = req.params as { ref: string }
      const b = req.body as { reservationRef?: unknown } | undefined
      if (typeof b?.reservationRef !== 'string') {
        throw Errors.validation({ reservationRef: ['field.required'] })
      }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const s = await abgabeZurKennung(client, ref, principal)
        const r = await client.query<{ id: number; property_id: number }>(
          `SELECT id::int, property_id::int FROM reservation WHERE public_ref = $1`,
          [b.reservationRef])
        // Die Zeilenrichtlinie laesst jedes Haus des Kontos durch, nicht nur dieses.
        if (r.rows[0] === undefined || r.rows[0].property_id !== s.property_id) {
          throw Errors.notFound('res.reservation')
        }
        await abgabeZuordnen(client, s.id, r.rows[0].id)
        return { reservationRef: b.reservationRef }
      })
    }
  })

  /**
   * Verwerfen, etwa einen doppelt abgegebenen Schein. Bis zum siebten Tag
   * nach der Anreise verschwaende er ohnehin; hier geht es frueher.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/checkin-portal/submissions/:ref',
    permission: 'reservation:checkin',
    summary: 'Meldeschein vom festen Link verwerfen',
    handler: async (req, reply) => {
      const { ref } = req.params as { ref: string }
      const principal = req.principal as Principal
      await tx(req.pool, req, async client => {
        const s = await abgabeZurKennung(client, ref, principal)
        await client.query(`DELETE FROM checkin_portal_submission WHERE id = $1`, [s.id])
      })
      reply.status(204)
    }
  })
}

/**
 * Eine wartende Abgabe zur oeffentlichen Kennung, mit dem Recht im Haus:
 * die Routen nehmen keine Property, und `registerRoute` prueft dann nur
 * "irgendwo".
 */
async function abgabeZurKennung(
  client: PoolClient, ref: string, principal: Principal
): Promise<{ id: number; property_id: number; booking_number: string; arrival: string
             last_name: string }> {
  const { rows } = await client.query<{ id: number; property_id: number
    booking_number: string; arrival: string; last_name: string }>(
    `SELECT id::int, property_id::int, booking_number, arrival::text, last_name
       FROM checkin_portal_submission WHERE public_ref = $1`, [ref])
  const s = rows[0]
  if (s === undefined) throw Errors.notFound('res.registration')
  rechtImHaus(principal, 'reservation:checkin', s.property_id)
  return s
}
