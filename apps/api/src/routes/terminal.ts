import { randomBytes, randomInt } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { hashToken, DEVICE_COOKIE } from '../platform/auth.js'
import { limiters, tooManyRequests, KOPPLUNG_FEHLVERSUCHE } from '../platform/rateLimit.js'
import { can, type Principal } from '../platform/context.js'
import { signRegistration } from './registrations.js'

/**
 * Gaesteterminal: ein Touchscreen an der Rezeption, an dem ein Gast den
 * Meldeschein unterschreibt (Dokument 31, Migrationen 0063 und 0064).
 *
 * **Geraet statt Sitzung.** Am Touchscreen steht ein Gast. Eine
 * Mitarbeitersitzung dort oeffnete ihm das Haus, sobald er die Adresszeile
 * anfasst. Das Terminal wird deshalb einmal gekoppelt und weist sich danach
 * mit einem eigenen Geheimnis aus; sein Principal traegt genau ein Recht in
 * genau einem Haus (`loadPrincipalFromDevice`).
 *
 * **Ein Auftrag zur Zeit.** Die Rezeption schickt einen Auftrag, das
 * Terminal fragt alle zwei Sekunden danach, oeffnet ihn, der Gast handelt,
 * und das Terminal kehrt in den Ruhezustand zurueck. Hoechstens ein offener
 * Auftrag je Geraet (Teilindex in 0063): zwei hiessen, dass der zweite Gast
 * die Daten des ersten sieht.
 */

const config = loadConfig()

/** Wie lange ein Kopplungscode gilt. Lang genug, um zum Touchscreen zu gehen. */
const KOPPLUNG_MINUTEN = 10
/**
 * Wie lange ein Auftrag auf das Terminal wartet. Ein erreichbares Terminal
 * oeffnet ihn binnen zwei Sekunden; wer nach drei Minuten noch wartet,
 * wartet auf ein Geraet, das aus ist.
 */
const AUFTRAG_WARTET_MINUTEN = 3
/**
 * Wie lange ein geoeffneter Auftrag offen bleiben darf, falls das Terminal
 * ihn nicht selbst schliesst -- Strom weg, Browser zu. Das Terminal raeumt
 * nach neunzig Sekunden ohne Beruehrung selbst ab; das hier ist die
 * Sicherung dahinter.
 */
const AUFTRAG_OFFEN_MINUTEN = 15
/** Wie lange ein abgeschlossener Auftrag an der Reservierung sichtbar bleibt. */
const AUFTRAG_SICHTBAR_MINUTEN = 10
/** Ein Geraet, das so lange nicht gefragt hat, gilt als nicht erreichbar. */
const ONLINE_SEKUNDEN = 60
/** Obergrenze je Haus, damit die Kopplung kein Weg wird, Zeilen zu erzeugen. */
const GERAETE_JE_HAUS = 10
const NAME_MAX = 60

/**
 * Das Alphabet der Kopplungscodes: dasselbe wie bei den oeffentlichen
 * Referenzen (0001), ohne verwechselbare Zeichen. Wer am Touchscreen
 * abtippt, was auf dem Rezeptionsbildschirm steht, soll nicht zwischen O
 * und 0 raten muessen.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LAENGE = 8

function neuerCode(): string {
  let c = ''
  for (let i = 0; i < CODE_LAENGE; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return c
}

/**
 * Was jemand eingetippt hat, in die Form, in der der Code entstand.
 * Bindestrich und Leerzeichen sind Lesehilfe (`ABCD-EFGH`), keine Zeichen
 * des Codes; Kleinschreibung auf einem Touchscreen ist kein Fehler.
 */
export function codeNormalisieren(eingabe: string): string {
  return eingabe.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function codeAnzeigen(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

// ------------------------------------------------------------- Arten

export const TERMINAL_KINDS = ['registration_sign', 'registration_fill'] as const
export type TerminalKind = (typeof TERMINAL_KINDS)[number]

function istArt(v: unknown): v is TerminalKind {
  return typeof v === 'string' && (TERMINAL_KINDS as readonly string[]).includes(v)
}

/** Der Meldeschein einer Reservierung, wie ihn die Arten brauchen. */
interface Lage {
  registrationId: number | null
  isForeign: boolean
  signed: boolean
}

interface Auftrag {
  id: number
  propertyId: number
  registrationId: number | null
  reservationId: number | null
}

/**
 * Eine Art von Auftrag.
 *
 * **Erweiterbar gebaut.** Eine neue Art ist ein Eintrag hier, ein Wert in
 * der Pruefbedingung von `terminal_job.kind` und eine Ansicht am Terminal
 * (`apps/web/src/routes/Terminal.tsx`). Abfrage, Oeffnen, Abbrechen und
 * Ablauf sind fuer alle Arten dieselben und stehen deshalb nicht hier.
 */
interface ArtDefinition {
  /** Kann die Rezeption sie heute anlegen? */
  verfuegbar: boolean
  /** Wird sie fuer diese Reservierung angeboten? Ein Knopf, der 422 antwortet, ist schlechter als keiner. */
  angeboten: (lage: Lage) => boolean
  /** Prueft beim Anlegen und liefert den Bezug. Wirft, wenn es nicht passt. */
  vorbereiten: (lage: Lage) => { registrationId: number | null }
  /** Was das Terminal zeigen muss -- und nichts darueber hinaus. */
  nutzlast: (client: PoolClient, auftrag: Auftrag) => Promise<Record<string, unknown>>
  /** Was der Gast am Terminal abschliesst. */
  abschliessen: (client: PoolClient, auftrag: Auftrag, body: Record<string, unknown>)
    => Promise<void>
}

const ARTEN: Record<TerminalKind, ArtDefinition> = {
  /**
   * Meldeschein unterschreiben, fuer einen bereits angelegten Schein.
   *
   * Seit dem 1.1.2025 unterschreiben nur auslaendische Gaeste. Fuer einen
   * inlaendischen wird die Art gar nicht angeboten, und die Schnittstelle
   * weist sie ab -- mit derselben Meldung wie der Weg am Tresen, denn es ist
   * dieselbe Regel (`signRegistration`).
   */
  registration_sign: {
    verfuegbar: true,
    angeboten: lage => lage.registrationId !== null && lage.isForeign && !lage.signed,
    vorbereiten: lage => {
      if (lage.registrationId === null) throw Errors.unprocessable('terminal.noRegistration')
      if (!lage.isForeign) throw Errors.unprocessable('registration.signatureNotForeseen')
      if (lage.signed) throw Errors.conflict('registration.alreadySigned')
      return { registrationId: lage.registrationId }
    },
    nutzlast: async (client, auftrag) => {
      if (auftrag.registrationId === null) throw Errors.notFound('res.registration')
      /*
       * Datenminimierung: was auf dem Meldeschein steht und was der Gast
       * mit seiner Unterschrift bestaetigt -- nicht Mailadresse, Telefon,
       * Preis oder Buchungsnummer. Die Ausweisnummer ebenfalls nicht: sie
       * liegt verschluesselt am Profil, und ein Touchscreen im Foyer ist
       * nicht der Ort, sie zu entschluesseln.
       */
      const { rows, rowCount } = await client.query<{
        arrival: string; planned_departure: string; occupant_count: number
        last_name: string; first_name: string | null; birth_date: string | null
        nationality: string | null; address_line1: string | null
        postal_code: string | null; city: string | null; country: string | null }>(
        `SELECT reg.arrival::text, reg.planned_departure::text, reg.occupant_count,
                g.last_name, g.first_name, g.birth_date::text, g.nationality,
                g.address_line1, g.postal_code, g.city, g.country
           FROM registration reg
           JOIN guest g ON g.id = reg.guest_id
          WHERE reg.id = $1 AND reg.property_id = $2`,
        [auftrag.registrationId, auftrag.propertyId])
      if (rowCount === 0) throw Errors.notFound('res.registration')
      /*
       * Mitreisende eines Sammelmeldescheins stehen mit Namen da: wer
       * unterschreibt, unterschreibt fuer sie mit (E6, Dokument 13), und
       * soll sehen, fuer wen.
       */
      const mit = await client.query<{ last_name: string; first_name: string | null }>(
        `SELECT g.last_name, g.first_name
           FROM registration reg JOIN guest g ON g.id = reg.guest_id
          WHERE reg.group_registration_id = $1 AND reg.property_id = $2
          ORDER BY reg.id`, [auftrag.registrationId, auftrag.propertyId])
      const r = rows[0]!
      return {
        arrival: r.arrival,
        plannedDeparture: r.planned_departure,
        occupantCount: r.occupant_count,
        guest: {
          lastName: r.last_name, firstName: r.first_name, birthDate: r.birth_date,
          nationality: r.nationality,
          address: { line1: r.address_line1, postalCode: r.postal_code,
                     city: r.city, country: r.country }
        },
        companions: mit.rows.map(m => ({ lastName: m.last_name, firstName: m.first_name }))
      }
    },
    abschliessen: async (client, auftrag, body) => {
      if (auftrag.registrationId === null) throw Errors.notFound('res.registration')
      // Derselbe Weg wie am Tresen, mit dem Haus des Auftrags als einzigem
      // erlaubten -- nicht mit allen Haeusern des Geraets, auch wenn es nur
      // eines hat: die Regel soll nicht an dieser Zufaelligkeit haengen.
      await signRegistration(client, auftrag.registrationId, body.signatureSvg,
        haus => haus === auftrag.propertyId)
    }
  },

  /**
   * Meldeformular ausfuellen -- **noch nicht verfuegbar**.
   *
   * TODO(checkin): Das Formular baut die parallele Arbeit am Online-Check-in.
   * Vertrag: sie liefert eine Funktion, die fuer eine Reservierung einen
   * Check-in-Token mit dem Kanal `terminal` erzeugt, und eine einbettbare
   * Komponente `<GastCheckin token=… modus="terminal" onFertig=… />`. Sobald
   * sie gemergt ist: `verfuegbar` auf true, `angeboten` nach dem Stand des
   * Scheins, `nutzlast` liefert den Token (und nur ihn), `abschliessen`
   * bleibt leer, weil das Formular selbst ueber seinen Token schreibt, und
   * die Ansicht am Terminal bettet die Komponente ein.
   */
  registration_fill: {
    verfuegbar: false,
    angeboten: () => false,
    vorbereiten: () => { throw Errors.unprocessable('terminal.kindUnavailable') },
    nutzlast: async () => { throw Errors.unprocessable('terminal.kindUnavailable') },
    abschliessen: async () => { throw Errors.unprocessable('terminal.kindUnavailable') }
  }
}

// ------------------------------------------------------------- Hilfen

/**
 * Der Zustand, wie er gilt -- nicht wie er zuletzt geschrieben wurde.
 * Ein offener Auftrag nach Fristablauf ist abgelaufen, auch wenn ihn noch
 * niemand umgeschrieben hat (Migration 0063).
 */
const ZUSTAND_SQL = `CASE WHEN j.state IN ('pending','opened') AND j.expires_at <= now()
                          THEN 'expired' ELSE j.state END`

async function lageDerReservierung(
  client: PoolClient, reservationId: number
): Promise<Lage> {
  // Nur der Hauptschein: bei einer Gruppe unterschreibt die Reiseleitung,
  // nicht jeder Mitreisende einzeln (E6, Dokument 13).
  const { rows } = await client.query<{ id: string; is_foreign: boolean; signed: boolean }>(
    `SELECT id, is_foreign, signed_at IS NOT NULL AS signed
       FROM registration
      WHERE reservation_id = $1 AND group_registration_id IS NULL
      ORDER BY id LIMIT 1`, [reservationId])
  const r = rows[0]
  return r === undefined
    ? { registrationId: null, isForeign: false, signed: false }
    : { registrationId: Number(r.id), isForeign: r.is_foreign, signed: r.signed }
}

/**
 * Das Recht im Haus des Vorgangs, nicht in irgendeinem.
 *
 * Die Routen der Rezeption nehmen eine Reservierung oder einen Auftrag
 * entgegen und keine Property -- das Seitenfenster der Reservierung kennt
 * sein Haus nicht, und es dafuer umzubauen hiesse, den Plan anzufassen.
 * `registerRoute` prueft das Recht dann nur "in irgendeinem Haus"; bei zwei
 * Haeusern im Account genuegte das Recht in Haus A fuer einen Vorgang in
 * Haus B. Deshalb hier noch einmal, am Haus der gefundenen Zeile.
 */
function pruefeHaus(req: FastifyRequest, propertyId: number): void {
  if (!can(req.principal as Principal, 'reservation:checkin', propertyId)) {
    throw Errors.forbidden('access.missingPermission',
      { permission: 'reservation:checkin' })
  }
}

async function reservierungPerRef(
  req: FastifyRequest, client: PoolClient, reservationRef: string
): Promise<{ id: number; propertyId: number }> {
  const r = await client.query<{ id: string; property_id: string }>(
    `SELECT id, property_id FROM reservation WHERE public_ref = $1`, [reservationRef])
  if (r.rowCount === 0) throw Errors.notFound('res.reservation')
  const propertyId = Number(r.rows[0]!.property_id)
  pruefeHaus(req, propertyId)
  return { id: Number(r.rows[0]!.id), propertyId }
}

/** Nur ein gekoppeltes Geraet. Das Recht allein genuegt nie. */
function geraetVon(req: FastifyRequest): { deviceId: number; propertyId: number } {
  const p = req.principal as Principal
  if (p.terminalDeviceId === null) throw Errors.forbidden('terminal.deviceOnly')
  const haus = [...p.permissionsByProperty.keys()][0]
  if (haus === undefined) throw Errors.forbidden('terminal.deviceOnly')
  return { deviceId: p.terminalDeviceId, propertyId: haus }
}

/** Den eigenen, offenen, nicht abgelaufenen Auftrag holen -- und sperren. */
async function eigenerAuftrag(
  client: PoolClient, deviceId: number, jobRef: string
): Promise<Auftrag & { kind: TerminalKind; state: string }> {
  const r = await client.query<{
    id: string; property_id: string; registration_id: string | null
    reservation_id: string | null; kind: TerminalKind; state: string }>(
    `SELECT j.id, j.property_id, j.registration_id, j.reservation_id, j.kind,
            ${ZUSTAND_SQL} AS state
       FROM terminal_job j
      WHERE j.public_ref = $1 AND j.device_id = $2
      FOR UPDATE`, [jobRef, deviceId])
  // Ein fremder Auftrag sieht aus wie keiner.
  if (r.rowCount === 0) throw Errors.notFound('res.terminalJob')
  const j = r.rows[0]!
  return {
    id: Number(j.id), propertyId: Number(j.property_id),
    registrationId: j.registration_id === null ? null : Number(j.registration_id),
    reservationId: j.reservation_id === null ? null : Number(j.reservation_id),
    kind: j.kind, state: j.state
  }
}

function nameAusRumpf(body: unknown): string {
  const name = (body as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string' || name.trim() === '') {
    throw Errors.validation({ name: ['field.required'] })
  }
  if (name.trim().length > NAME_MAX) {
    throw Errors.validation({ name: ['field.maxLength'] }, { max: NAME_MAX })
  }
  return name.trim()
}

// ------------------------------------------------------------- Routen

export function terminalRoutes(app: FastifyInstance): void {
  // ------------------------------------------------ Einstellungen des Hauses

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/terminals',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminals des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT d.public_ref AS "deviceRef", d.name,
                  CASE WHEN d.paired_at IS NOT NULL THEN 'paired'
                       WHEN d.pairing_expires_at > now() THEN 'pairing'
                       ELSE 'pairing_expired' END AS state,
                  to_char(d.pairing_expires_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "pairingExpiresAt",
                  to_char(d.paired_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "pairedAt",
                  to_char(s.last_seen_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastSeenAt",
                  coalesce(s.last_seen_at > now() - make_interval(secs => $2), false)
                    AS online
             FROM terminal_device d
             LEFT JOIN terminal_device_seen s ON s.device_id = d.id
            WHERE d.property_id = $1 AND d.revoked_at IS NULL
            ORDER BY d.name, d.id`, [Number(propertyId), ONLINE_SEKUNDEN])
        return { terminals: rows }
      })
    }
  })

  /**
   * Terminal anlegen und Kopplungscode erzeugen.
   *
   * Der Code steht genau einmal in der Antwort und danach nur noch als Hash
   * in der Datenbank. Er gilt zehn Minuten und genau einmal.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terminals',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal anlegen und Kopplungscode erzeugen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const name = nameAusRumpf(req.body)
      const principal = req.principal as Principal
      const code = neuerCode()
      return tx(req.pool, req, async client => {
        const n = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM terminal_device
            WHERE property_id = $1 AND revoked_at IS NULL`, [Number(propertyId)])
        if (Number(n.rows[0]!.n) >= GERAETE_JE_HAUS) {
          throw Errors.unprocessable('terminal.deviceLimit', { max: GERAETE_JE_HAUS })
        }
        const { rows } = await client.query<{ public_ref: string; ablauf: string }>(
          `INSERT INTO terminal_device (property_id, name, pairing_code_hash,
                                        pairing_expires_at, created_by)
           VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)
           RETURNING public_ref,
                     to_char(pairing_expires_at AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ablauf`,
          [Number(propertyId), name, hashToken(code), KOPPLUNG_MINUTEN, principal.userId])
        reply.status(201)
        return { deviceRef: rows[0]!.public_ref, name,
                 pairingCode: codeAnzeigen(code), pairingExpiresAt: rows[0]!.ablauf }
      })
    }
  })

  /**
   * Neu koppeln: neuer Code fuer ein vorhandenes Terminal.
   *
   * Fuer zwei Faelle: der Code ist abgelaufen, bevor jemand am Touchscreen
   * war, oder der Browser dort hat seine Daten verloren. Das alte Geheimnis
   * faellt dabei sofort -- ein Terminal, das neu gekoppelt wird, soll nicht
   * zweimal stehen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terminals/:deviceRef/pairing-code',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal neu koppeln',
    handler: async (req) => {
      const { propertyId, deviceRef } = req.params as { propertyId: string; deviceRef: string }
      const code = neuerCode()
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{ name: string; ablauf: string }>(
          `UPDATE terminal_device
              SET pairing_code_hash = $3,
                  pairing_expires_at = now() + make_interval(mins => $4),
                  secret_hash = NULL, paired_at = NULL
            WHERE public_ref = $1 AND property_id = $2 AND revoked_at IS NULL
           RETURNING name, to_char(pairing_expires_at AT TIME ZONE 'UTC',
                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ablauf`,
          [deviceRef, Number(propertyId), hashToken(code), KOPPLUNG_MINUTEN])
        if (rowCount === 0) throw Errors.notFound('res.terminal')
        return { deviceRef, name: rows[0]!.name,
                 pairingCode: codeAnzeigen(code), pairingExpiresAt: rows[0]!.ablauf }
      })
    }
  })

  /**
   * Widerrufen. Wirkt mit der naechsten Anfrage des Terminals: sein
   * Principal wird bei jeder Anfrage neu aufgeloest, und ein widerrufenes
   * Geraet hat kein Geheimnis mehr, gegen das sich eines pruefen liesse.
   * Ein offener Auftrag faellt mit.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/terminals/:deviceRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal widerrufen',
    handler: async (req) => {
      const { propertyId, deviceRef } = req.params as { propertyId: string; deviceRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{ id: string }>(
          `UPDATE terminal_device
              SET revoked_at = now(), revoked_by = $3,
                  secret_hash = NULL, pairing_code_hash = NULL, pairing_expires_at = NULL
            WHERE public_ref = $1 AND property_id = $2 AND revoked_at IS NULL
           RETURNING id`, [deviceRef, Number(propertyId), principal.userId])
        if (rowCount === 0) throw Errors.notFound('res.terminal')
        await client.query(
          `UPDATE terminal_job
              SET state = 'canceled', canceled_by = 'revoked', finished_at = now()
            WHERE device_id = $1 AND state IN ('pending','opened')`, [rows[0]!.id])
        return { deviceRef, revoked: true }
      })
    }
  })

  // ------------------------------------------------ Rezeption

  /**
   * Was an der Reservierung zum Terminal gehoert, in einem Aufruf: welche
   * Terminals es gibt, welche Auftraege sich anbieten und wie es um den
   * letzten steht. Die Rezeption fragt das alle zwei Sekunden, solange ein
   * Auftrag offen ist -- derselbe Aufruf, kein zweiter fuer den Zustand.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/terminal',
    permission: 'reservation:checkin',
    summary: 'Gaesteterminal: Angebote und Auftragsstand einer Reservierung',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const { id: reservierung, propertyId: haus } =
          await reservierungPerRef(req, client, reservationRef)
        const lage = await lageDerReservierung(client, reservierung)
        const geraete = await client.query(
          `SELECT d.public_ref AS "deviceRef", d.name,
                  coalesce(s.last_seen_at > now() - make_interval(secs => $2), false)
                    AS online,
                  EXISTS (SELECT 1 FROM terminal_job j
                           WHERE j.device_id = d.id AND j.state IN ('pending','opened')
                             AND j.expires_at > now()) AS busy
             FROM terminal_device d
             LEFT JOIN terminal_device_seen s ON s.device_id = d.id
            WHERE d.property_id = $1 AND d.revoked_at IS NULL AND d.paired_at IS NOT NULL
            ORDER BY d.name, d.id`, [haus, ONLINE_SEKUNDEN])
        const auftrag = await client.query(
          `SELECT j.public_ref AS "jobRef", j.kind, ${ZUSTAND_SQL} AS state,
                  j.canceled_by AS "canceledBy", d.name AS "deviceName",
                  to_char(j.created_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
             FROM terminal_job j
             JOIN terminal_device d ON d.id = j.device_id
            WHERE j.reservation_id = $1 AND j.property_id = $2
              AND (j.finished_at > now() - make_interval(mins => $3)
                   OR (j.finished_at IS NULL
                       AND j.expires_at > now() - make_interval(mins => $3)))
            ORDER BY j.created_at DESC, j.id DESC
            LIMIT 1`, [reservierung, haus, AUFTRAG_SICHTBAR_MINUTEN])
        return {
          terminals: geraete.rows,
          offers: TERMINAL_KINDS.filter(k => ARTEN[k].verfuegbar && ARTEN[k].angeboten(lage)),
          registration: lage.registrationId === null ? null : lage,
          job: auftrag.rows[0] ?? null
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal-jobs',
    permission: 'reservation:checkin',
    summary: 'Auftrag an ein Gaesteterminal schicken',
    handler: async (req, reply) => {
      const body = (req.body ?? {}) as { deviceRef?: unknown; kind?: unknown
                                         reservationRef?: unknown }
      if (!istArt(body.kind)) {
        throw Errors.validation({ kind: ['field.allowedValues'] },
          { values: TERMINAL_KINDS.join(', ') })
      }
      if (typeof body.deviceRef !== 'string' || body.deviceRef === '') {
        throw Errors.validation({ deviceRef: ['field.required'] })
      }
      if (typeof body.reservationRef !== 'string' || body.reservationRef === '') {
        throw Errors.validation({ reservationRef: ['field.required'] })
      }
      const art = ARTEN[body.kind]
      if (!art.verfuegbar) throw Errors.unprocessable('terminal.kindUnavailable')
      const principal = req.principal as Principal
      const deviceRef = body.deviceRef
      const reservationRef = body.reservationRef
      const kind = body.kind

      return tx(req.pool, req, async client => {
        const { id: reservierung, propertyId: haus } =
          await reservierungPerRef(req, client, reservationRef)
        // Das Geraet muss zum Haus **der Reservierung** gehoeren: die
        // Zeilenrichtlinie filtert nach Mandant, und bei zwei Haeusern im
        // Account saehe sie das Terminal des anderen.
        const geraet = await client.query<{ id: string; paired: boolean }>(
          `SELECT id, paired_at IS NOT NULL AS paired FROM terminal_device
            WHERE public_ref = $1 AND property_id = $2 AND revoked_at IS NULL`,
          [deviceRef, haus])
        if (geraet.rowCount === 0) throw Errors.notFound('res.terminal')
        if (!geraet.rows[0]!.paired) throw Errors.unprocessable('terminal.notPaired')
        const deviceId = Number(geraet.rows[0]!.id)

        const bezug = art.vorbereiten(await lageDerReservierung(client, reservierung))

        // Was abgelaufen ist, steht dem naechsten Auftrag nicht im Weg.
        await client.query(
          `UPDATE terminal_job SET state = 'expired', finished_at = now()
            WHERE device_id = $1 AND state IN ('pending','opened') AND expires_at <= now()`,
          [deviceId])
        const neu = await client.query<{ public_ref: string; ablauf: string }>(
          `INSERT INTO terminal_job (property_id, device_id, kind, reservation_id,
                                     registration_id, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
           ON CONFLICT (device_id) WHERE state IN ('pending','opened') DO NOTHING
           RETURNING public_ref,
                     to_char(expires_at AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ablauf`,
          [haus, deviceId, kind, reservierung, bezug.registrationId,
           principal.userId, AUFTRAG_WARTET_MINUTEN])
        if (neu.rowCount === 0) throw Errors.conflict('terminal.deviceBusy')
        reply.status(201)
        return { jobRef: neu.rows[0]!.public_ref, kind, state: 'pending',
                 expiresAt: neu.rows[0]!.ablauf }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal-jobs/:jobRef/cancel',
    permission: 'reservation:checkin',
    summary: 'Auftrag an ein Gaesteterminal abbrechen',
    handler: async (req) => {
      const { jobRef } = req.params as { jobRef: string }
      return tx(req.pool, req, async client => {
        const j = await client.query<{ id: string; property_id: string; state: string }>(
          `SELECT j.id, j.property_id, ${ZUSTAND_SQL} AS state
             FROM terminal_job j WHERE j.public_ref = $1 FOR UPDATE`, [jobRef])
        if (j.rowCount === 0) throw Errors.notFound('res.terminalJob')
        pruefeHaus(req, Number(j.rows[0]!.property_id))
        if (j.rows[0]!.state !== 'pending' && j.rows[0]!.state !== 'opened') {
          throw Errors.conflict('terminal.jobNotOpen')
        }
        await client.query(
          `UPDATE terminal_job
              SET state = 'canceled', canceled_by = 'reception', finished_at = now()
            WHERE id = $1`, [j.rows[0]!.id])
        return { jobRef, state: 'canceled' }
      })
    }
  })

  // ------------------------------------------------ Das Terminal selbst

  /**
   * Koppeln. Oeffentlich, denn das Terminal hat noch nichts, womit es sich
   * ausweisen koennte -- und deshalb mit eigenem Fehlversuchszaehler.
   *
   * **Keine Mitarbeitersitzung am Terminal.** Liegt in diesem Browser noch
   * eine, wird sie hier beendet und ihr Cookie geloescht. Am Touchscreen
   * steht danach ein Gast, und die Anwendung unter `/` liegt eine
   * Adresszeile entfernt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/pair',
    permission: null,
    summary: 'Gaesteterminal mit einem Kopplungscode koppeln',
    handler: async (req, reply) => {
      const herkunft = req.ip
      if (limiters.kopplung.erschoepft(herkunft)) {
        throw tooManyRequests(Math.ceil(KOPPLUNG_FEHLVERSUCHE.windowMs / 1000))
      }
      const eingabe = (req.body as { code?: unknown } | undefined)?.code
      const code = typeof eingabe === 'string' ? codeNormalisieren(eingabe) : ''
      if (code.length !== CODE_LAENGE) {
        limiters.kopplung.check(herkunft)
        throw Errors.unprocessable('terminal.pairingInvalid')
      }
      const geheimnis = randomBytes(32).toString('base64url')
      const gekoppelt = await tx(req.pool, req, client =>
        client.query<{ device_ref: string; device_name: string; property_name: string }>(
          `SELECT * FROM terminal_device_pair($1, $2)`,
          [hashToken(code), hashToken(geheimnis)]))
      if (gekoppelt.rowCount === 0) {
        limiters.kopplung.check(herkunft)
        throw Errors.unprocessable('terminal.pairingInvalid')
      }

      const sitzung = req.cookies['hp_session']
      if (sitzung !== undefined) {
        await req.pool.query(
          `UPDATE user_session SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL`, [sitzung])
        reply.clearCookie('hp_session', { path: '/' })
      }
      reply.setCookie(DEVICE_COOKIE, geheimnis, {
        httpOnly: true,
        // `strict` wie bei der Sitzung (H6, Dokument 25): niemand verlinkt
        // von aussen auf das Terminal.
        sameSite: 'strict',
        secure: config.nodeEnv === 'production',
        // Nur an die Routen des Terminals. Die Anwendung unter `/v1/*`
        // bekommt es nie zu sehen, auch nicht versehentlich.
        path: '/v1/terminal',
        // Ein Jahr. Das Terminal steht fest an seinem Platz; erneuert wird
        // es durch Neukoppeln, beendet durch Widerruf.
        maxAge: 365 * 24 * 3600
      })
      const g = gekoppelt.rows[0]!
      return { deviceRef: g.device_ref, name: g.device_name, property: g.property_name }
    }
  })

  /**
   * Die Frage des Terminals, alle zwei Sekunden: steht etwas an?
   *
   * Billig gebaut, weil sie dauernd kommt: eine Anweisung nach der
   * Aufloesung des Geraets, ueber den Teilindex `terminal_job_one_open`.
   * Sie liefert keinen Gastdatensatz, nur Art und Kennung des Auftrags --
   * die Daten kommen erst mit dem Oeffnen, also erst, wenn sie gezeigt
   * werden.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/terminal/job',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: anstehenden Auftrag abfragen',
    handler: async (req) => {
      const { deviceId, propertyId } = geraetVon(req)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{
          property: string; is_training: boolean; public_ref: string | null
          kind: string | null; state: string | null }>(
          `SELECT p.name AS property, p.is_training,
                  j.public_ref, j.kind, j.state
             FROM property p
             LEFT JOIN terminal_job j
                    ON j.device_id = $1 AND j.state IN ('pending','opened')
                   AND j.expires_at > now()
            WHERE p.id = $2`, [deviceId, propertyId])
        const r = rows[0]
        return {
          property: r?.property ?? '',
          isTraining: r?.is_training ?? false,
          job: r === undefined || r.public_ref === null ? null
            : { jobRef: r.public_ref, kind: r.kind, state: r.state }
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/job/:jobRef/open',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Auftrag oeffnen und seine Daten holen',
    handler: async (req) => {
      const { deviceId } = geraetVon(req)
      const { jobRef } = req.params as { jobRef: string }
      return tx(req.pool, req, async client => {
        const auftrag = await eigenerAuftrag(client, deviceId, jobRef)
        if (auftrag.state !== 'pending' && auftrag.state !== 'opened') {
          throw Errors.conflict('terminal.jobNotOpen')
        }
        if (auftrag.state === 'pending') {
          await client.query(
            `UPDATE terminal_job
                SET state = 'opened', opened_at = now(),
                    expires_at = now() + make_interval(mins => $2)
              WHERE id = $1`, [auftrag.id, AUFTRAG_OFFEN_MINUTEN])
        }
        // Ein zweites Oeffnen -- das Terminal wurde neu geladen -- liefert
        // dieselben Daten wieder, statt den Gast vor einem leeren
        // Bildschirm stehen zu lassen.
        return { jobRef, kind: auftrag.kind,
                 data: await ARTEN[auftrag.kind].nutzlast(client, auftrag) }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/job/:jobRef/complete',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Auftrag abschliessen',
    handler: async (req) => {
      const { deviceId } = geraetVon(req)
      const { jobRef } = req.params as { jobRef: string }
      const body = (req.body ?? {}) as Record<string, unknown>
      return tx(req.pool, req, async client => {
        const auftrag = await eigenerAuftrag(client, deviceId, jobRef)
        // Erst oeffnen, dann abschliessen: ein Auftrag, den das Terminal nie
        // gezeigt hat, hat auch niemand unterschrieben.
        if (auftrag.state !== 'opened') throw Errors.conflict('terminal.jobNotOpen')
        await ARTEN[auftrag.kind].abschliessen(client, auftrag, body)
        await client.query(
          `UPDATE terminal_job SET state = 'done', finished_at = now() WHERE id = $1`,
          [auftrag.id])
        return { jobRef, state: 'done' }
      })
    }
  })

  /**
   * Am Terminal abbrechen: der Gast tippt auf "Abbrechen", oder die Seite
   * raeumt nach einer Weile ohne Beruehrung selbst ab. Beides soll die
   * Rezeption sehen, und beides unterscheidbar -- ein Gast, der ablehnt,
   * ist etwas anderes als einer, der gegangen ist.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/job/:jobRef/abort',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Auftrag abbrechen',
    handler: async (req) => {
      const { deviceId } = geraetVon(req)
      const { jobRef } = req.params as { jobRef: string }
      const grund = (req.body as { reason?: unknown } | undefined)?.reason
      const canceledBy = grund === 'timeout' ? 'timeout' : 'terminal'
      return tx(req.pool, req, async client => {
        const auftrag = await eigenerAuftrag(client, deviceId, jobRef)
        if (auftrag.state !== 'pending' && auftrag.state !== 'opened') {
          // Schon zu: nichts zu tun, und kein Fehler -- das Terminal raeumt
          // ohnehin ab, und die Rezeption hat vielleicht gerade selbst
          // abgebrochen.
          return { jobRef, state: auftrag.state }
        }
        await client.query(
          `UPDATE terminal_job
              SET state = 'canceled', canceled_by = $2, finished_at = now()
            WHERE id = $1`, [auftrag.id, canceledBy])
        return { jobRef, state: 'canceled' }
      })
    }
  })
}
