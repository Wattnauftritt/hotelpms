import { randomBytes, randomInt } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { hashToken, DEVICE_COOKIE } from '../platform/auth.js'
import { limiters, tooManyRequests, KOPPLUNG_FEHLVERSUCHE } from '../platform/rateLimit.js'
import { hasProperty, type Principal } from '../platform/context.js'
import { geraetVon, pruefeHaus } from '../platform/terminal.js'
import { bildLesen, bildSenden } from '../platform/terminalBild.js'
import { ARTEN, TERMINAL_KINDS, istArt, angebote, inhalteDesHauses, zieheLinksZurueck,
         AUFTRAG_LABEL_JOINS, AUFTRAG_LABEL_SQL,
         type Auftrag, type Lage, type TerminalKind, type Wunsch }
  from '../platform/terminalArten.js'

/**
 * Gaesteterminal: ein Touchscreen an der Rezeption, an dem ein Gast den
 * Meldeschein ausfuellt und unterschreibt, Hausbedingungen zustimmt und
 * Seiten des Hauses sieht (Dokument 31, Migrationen 0070, 0071, 0072, 0073).
 * Was es zeigen kann, steht in `platform/terminalArten.ts`.
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
 * Auftrag je Geraet (Teilindex in 0071): zwei hiessen, dass der zweite Gast
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
/** Hoechstzahl der Seiten in der Diashow des Ruhezustands. */
const DIASHOW_MAX = 20
/**
 * Wie lange ein Freigabecode gilt (Migration 0103). Er wird am Rechner des
 * Masters abgelesen und in den Einstellungen des anderen Hauses
 * eingetragen, meist von derselben Person an derselben Rezeption -- ein
 * Tag laesst Zeit dafuer, ohne dass ein vergessener Code liegen bleibt.
 */
const FREIGABE_STUNDEN = 24
/**
 * Laenger als der Kopplungscode: er oeffnet ein Geraet fuer ein zweites
 * Haus, und eingetippt wird er an einem Rechner mit Tastatur, nicht am
 * Touchscreen. Sechzehn Zeichen aus dreissig, rund 4 · 10^23.
 */
const FREIGABE_LAENGE = 16

/**
 * Das Alphabet der Kopplungscodes: dasselbe wie bei den oeffentlichen
 * Referenzen (0001), ohne verwechselbare Zeichen. Wer am Touchscreen
 * abtippt, was auf dem Rezeptionsbildschirm steht, soll nicht zwischen O
 * und 0 raten muessen.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LAENGE = 8

function neuerCode(laenge = CODE_LAENGE): string {
  let c = ''
  for (let i = 0; i < laenge; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
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

/** In Vierergruppen: `ABCD-EFGH`, beim Freigabecode `ABCD-EFGH-JKLM-NPQR`. */
function codeAnzeigen(code: string): string {
  return code.match(/.{1,4}/g)!.join('-')
}

// ------------------------------------------------------------- Hilfen

/**
 * Der Zustand, wie er gilt -- nicht wie er zuletzt geschrieben wurde.
 * Ein offener Auftrag nach Fristablauf ist abgelaufen, auch wenn ihn noch
 * niemand umgeschrieben hat (Migration 0071).
 */
const ZUSTAND_SQL = `CASE WHEN j.state IN ('pending','opened') AND j.expires_at <= now()
                          THEN 'expired' ELSE j.state END`

/**
 * Die Reservierung samt Hauptschein, wie die Arten sie brauchen, in einer
 * Abfrage -- und gegen das Recht im Haus der Reservierung geprueft.
 *
 * Nur der Hauptschein: bei einer Gruppe unterschreibt die Reiseleitung,
 * nicht jeder Mitreisende einzeln (E6, Dokument 13). `signature_required`
 * und nicht `is_foreign`: ein auslaendischer Mitreisender verlangt die
 * Unterschrift auch, wenn der Hauptgast deutsch ist (platform/meldeschein.ts).
 */
async function lageZurReservierung(
  req: FastifyRequest, client: PoolClient, reservationRef: string
): Promise<Lage> {
  const { rows } = await client.query<{
    id: string; property_id: string; arrival: string; primary_guest_id: string | null
    reg_id: string | null; noetig: boolean | null; signed: boolean | null }>(
    `SELECT r.id, r.property_id, r.arrival::text, r.primary_guest_id,
            reg.id AS reg_id, reg.signature_required AS noetig,
            reg.signed_at IS NOT NULL AS signed
       FROM reservation r
       LEFT JOIN LATERAL (
              SELECT id, signature_required, signed_at FROM registration
               WHERE reservation_id = r.id AND group_registration_id IS NULL
               ORDER BY id LIMIT 1) reg ON true
      WHERE r.public_ref = $1`, [reservationRef])
  const r = rows[0]
  if (r === undefined) throw Errors.notFound('res.reservation')
  pruefeHaus(req, Number(r.property_id))
  return {
    reservationId: Number(r.id), propertyId: Number(r.property_id), arrival: r.arrival,
    primaryGuestId: r.primary_guest_id === null ? null : Number(r.primary_guest_id),
    registrationId: r.reg_id === null ? null : Number(r.reg_id),
    signatureRequired: r.noetig === true, signed: r.signed === true
  }
}

const AUFTRAG_SPALTEN = `j.id, j.property_id, j.kind, ${ZUSTAND_SQL} AS state,
  j.reservation_id, j.registration_id, j.terms_id, j.content_id, j.url_id,
  j.checkin_token_id, j.created_by`

interface AuftragZeile {
  id: string; property_id: string; kind: TerminalKind; state: string
  reservation_id: string | null; registration_id: string | null; terms_id: string | null
  content_id: string | null; url_id: string | null; checkin_token_id: string | null
  created_by: string | null
}

const zahl = (v: string | null): number | null => v === null ? null : Number(v)

function alsAuftrag(z: AuftragZeile): Auftrag {
  return {
    id: Number(z.id), propertyId: Number(z.property_id), kind: z.kind, state: z.state,
    reservationId: zahl(z.reservation_id), registrationId: zahl(z.registration_id),
    termsId: zahl(z.terms_id), contentId: zahl(z.content_id), urlId: zahl(z.url_id),
    checkinTokenId: zahl(z.checkin_token_id), createdBy: zahl(z.created_by)
  }
}

/**
 * Den eigenen Auftrag holen, mit dem Zustand, wie er gilt -- und sperren.
 * Ob er noch offen ist, entscheidet die aufrufende Route.
 */
async function eigenerAuftrag(
  client: PoolClient, deviceId: number, jobRef: string
): Promise<Auftrag> {
  const r = await client.query<AuftragZeile>(
    `SELECT ${AUFTRAG_SPALTEN} FROM terminal_job j
      WHERE j.public_ref = $1 AND j.device_id = $2
      FOR UPDATE`, [jobRef, deviceId])
  // Ein fremder Auftrag sieht aus wie keiner.
  if (r.rowCount === 0) throw Errors.notFound('res.terminalJob')
  return alsAuftrag(r.rows[0]!)
}

/**
 * Einen offenen Auftrag abbrechen -- es sei denn, der Gast hat schon
 * erledigt, was er sollte (`bereitsErledigt`). Dann steht er als erledigt
 * da, wer immer danach auf "Abbrechen" gedrueckt hat.
 */
async function abbrechen(
  client: PoolClient, a: Auftrag, canceledBy: 'reception' | 'terminal' | 'timeout'
): Promise<'done' | 'canceled'> {
  const erledigt = await ARTEN[a.kind].bereitsErledigt?.(client, a) ?? false
  await beenden(client, a.id, erledigt ? 'done' : 'canceled', erledigt ? null : canceledBy)
  return erledigt ? 'done' : 'canceled'
}

/** Einen Auftrag beenden: Zustand setzen und den Online-Check-in-Link zurueckziehen. */
async function beenden(
  client: PoolClient, jobId: number, state: 'done' | 'canceled' | 'expired',
  canceledBy: 'reception' | 'terminal' | 'timeout' | 'revoked' | null
): Promise<void> {
  await client.query(
    `UPDATE terminal_job SET state = $2, canceled_by = $3, finished_at = now()
      WHERE id = $1`, [jobId, state, state === 'canceled' ? canceledBy : null])
  await zieheLinksZurueck(client, [jobId])
}

/**
 * Liegt die Uhrzeit des Hauses in der Wachzeit des Geraets (Migration 0102)?
 * Ueber Mitternacht, wenn der Anfang nach dem Ende liegt. In der Zeitzone
 * des Hauses: die Uhr eines Kioskrechners stimmt nicht immer.
 */
const WACH_SQL = `CASE
    WHEN d.awake_from IS NULL THEN false
    WHEN d.awake_from < d.awake_until
      THEN (now() AT TIME ZONE p.timezone)::time >= d.awake_from
       AND (now() AT TIME ZONE p.timezone)::time <  d.awake_until
    ELSE (now() AT TIME ZONE p.timezone)::time >= d.awake_from
      OR (now() AT TIME ZONE p.timezone)::time <  d.awake_until
  END`

/** `HH:MM`, 00:00 bis 23:59, oder null. */
function uhrzeitAusRumpf(wert: unknown, feld: string): string | null {
  if (wert === null || wert === undefined || wert === '') return null
  if (typeof wert !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(wert)) {
    throw Errors.validation({ [feld]: ['field.invalid'] })
  }
  return wert
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

/** Ein Auftrag fuer die Rezeption: Art, Stand, was gezeigt wird, wo. */
const AUFTRAG_FUER_REZEPTION = `j.public_ref AS "jobRef", j.kind, ${ZUSTAND_SQL} AS state,
  j.canceled_by AS "canceledBy", d.name AS "deviceName", ${AUFTRAG_LABEL_SQL} AS label,
  to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"`

/**
 * Das Geraetecookie setzen -- nach der Kopplung per Code wie nach dem
 * Einloesen der Kiosk-Adresse.
 *
 * **Keine Mitarbeitersitzung am Terminal.** Liegt in diesem Browser noch
 * eine, wird sie hier beendet und ihr Cookie geloescht. Am Touchscreen
 * steht danach ein Gast, und die Anwendung unter `/` liegt eine
 * Adresszeile entfernt.
 */
async function geraetAnmelden(req: FastifyRequest, reply: FastifyReply,
                              geheimnis: string): Promise<void> {
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
    // es durch Neukoppeln, beendet durch Widerruf. Ein Kiosk, der es bei
    // jedem Neustart verliert, holt es sich ueber die Kiosk-Adresse wieder.
    maxAge: 365 * 24 * 3600
  })
}

/**
 * Die Geraete, an die ein Haus schicken kann: die eigenen und die, die es
 * ueber eine gueltige Freigabe mitnutzt (Migration 0103). `$1` ist das Haus.
 * Die Zeilenrichtlinie liesse jedes Haus des Aufrufers durch; die
 * Bedingung nennt deshalb genau dieses.
 */
const GERAET_DES_HAUSES = `d.revoked_at IS NULL AND (d.property_id = $1 OR EXISTS (
    SELECT 1 FROM terminal_share sh
     WHERE sh.device_id = d.id AND sh.guest_property_id = $1 AND sh.revoked_at IS NULL))`

/**
 * Die Form eines Geraetegeheimnisses: 32 Byte in base64url. Was anders
 * aussieht, braucht keinen Weg in die Datenbank.
 */
const GEHEIMNIS_FORM = /^[A-Za-z0-9_-]{43}$/

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
                    AS online,
                  to_char(d.awake_from, 'HH24:MI') AS "awakeFrom",
                  to_char(d.awake_until, 'HH24:MI') AS "awakeUntil"
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
   * Kiosk-Adresse: das Geraet direkt mit einem neuen Geheimnis koppeln und
   * dieses Geheimnis einmal zurueckgeben.
   *
   * Fuer einen Kiosk, der seine Cookies verwirft -- Edge im Kioskmodus von
   * Windows laeuft immer InPrivate. Die Rezeption traegt die Adresse
   * `/terminal#k=<geheimnis>` als Startseite des Kiosks ein, und das
   * Terminal meldet sich bei jedem Start damit an (`/v1/terminal/resume`).
   *
   * Wie beim Neukoppeln faellt das bisherige Geheimnis sofort, und ein
   * offener Kopplungscode mit ihm: ein Terminal soll nicht zweimal stehen.
   * Die Adresse steht genau einmal in der Antwort; danach liegt auch hier
   * nur der Hash. Wer sie verliert, erzeugt eine neue.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terminals/:deviceRef/kiosk-key',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Kiosk-Adresse fuer ein Gaesteterminal erzeugen',
    handler: async (req) => {
      const { propertyId, deviceRef } = req.params as { propertyId: string; deviceRef: string }
      const geheimnis = randomBytes(32).toString('base64url')
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{ name: string }>(
          `UPDATE terminal_device
              SET secret_hash = $3, paired_at = now(),
                  pairing_code_hash = NULL, pairing_expires_at = NULL
            WHERE public_ref = $1 AND property_id = $2 AND revoked_at IS NULL
           RETURNING name`,
          [deviceRef, Number(propertyId), hashToken(geheimnis)])
        if (rowCount === 0) throw Errors.notFound('res.terminal')
        return { deviceRef, name: rows[0]!.name, kioskKey: geheimnis }
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
        // Auch die offenen Auftraege der Haeuser, die das Geraet mitnutzen,
        // und deren Links -- die sieht der Master nicht (Migration 0103).
        await client.query(`SELECT terminal_device_jobs_end($1, NULL, false)`, [rows[0]!.id])
        await client.query(
          `UPDATE terminal_share
              SET revoked_at = now(), revoked_by = $2, token_hash = NULL, token_expires_at = NULL
            WHERE device_id = $1 AND revoked_at IS NULL`, [rows[0]!.id, principal.userId])
        return { deviceRef, revoked: true }
      })
    }
  })

  /**
   * Wachzeit eines Geraets setzen oder entfernen (Migration 0102). Beide
   * Zeiten oder keine; gleiche Zeiten waeren "nie" oder "immer" und werden
   * abgewiesen.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/terminals/:deviceRef/awake',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Wachzeit setzen',
    handler: async (req) => {
      const { propertyId, deviceRef } = req.params as { propertyId: string; deviceRef: string }
      const b = (req.body ?? {}) as { from?: unknown; until?: unknown }
      const von = uhrzeitAusRumpf(b.from, 'from')
      const bis = uhrzeitAusRumpf(b.until, 'until')
      if (von === null && bis !== null) throw Errors.validation({ from: ['field.required'] })
      if (von !== null && bis === null) throw Errors.validation({ until: ['field.required'] })
      if (von !== null && von === bis) throw Errors.validation({ until: ['field.invalid'] })
      return tx(req.pool, req, async client => {
        const { rowCount } = await client.query(
          `UPDATE terminal_device SET awake_from = $3::time, awake_until = $4::time
            WHERE public_ref = $1 AND property_id = $2 AND revoked_at IS NULL`,
          [deviceRef, Number(propertyId), von, bis])
        if (rowCount === 0) throw Errors.notFound('res.terminal')
        return { deviceRef, awakeFrom: von, awakeUntil: bis }
      })
    }
  })

  // ------------------------------------------------ Mitnutzung (Migration 0103)

  /*
   * Ein Haus ist Master eines Terminals und gibt fuer das Geraet einen
   * Freigabecode aus. Wer ihn in den Einstellungen eines anderen Hauses
   * desselben Accounts eintraegt, schickt von dort Auftraege an dasselbe
   * Geraet. Seiten, Diashow und Wachzeit bleiben beim Master; das andere
   * Haus schickt nur, was es selbst angelegt hat, und nur Gastdaten aus
   * dem eigenen Haus. Widerrufen koennen beide Seiten.
   */

  /** Die Freigaben eines Hauses: was es verleiht und was es mitnutzt. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/terminal-shares',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Freigaben an andere Haeuser und von anderen Haeusern',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{
          share_ref: string; device_ref: string; device_name: string; role: 'owner' | 'guest'
          owner_property: string; guest_property: string; redeemed_at: string }>(
          `SELECT share_ref, device_ref, device_name, role, owner_property, guest_property,
                  to_char(redeemed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                    AS redeemed_at
             FROM terminal_share_list($1)`, [haus])
        const zeile = (r: typeof rows[number]) => ({
          shareRef: r.share_ref, deviceRef: r.device_ref, deviceName: r.device_name,
          ownerProperty: r.owner_property, guestProperty: r.guest_property,
          since: r.redeemed_at })
        return {
          lent: rows.filter(r => r.role === 'owner').map(zeile),
          borrowed: rows.filter(r => r.role === 'guest').map(zeile)
        }
      })
    }
  })

  /**
   * Freigabecode fuer ein Geraet ausgeben -- nur das Haus, dem es gehoert.
   *
   * Der Code steht genau einmal in der Antwort, gilt einen Tag und genau
   * einmal. Ein neuer Code fuer dasselbe Geraet macht einen noch nicht
   * eingeloesten alten wertlos: nur der zuletzt ausgegebene gilt, wie beim
   * Neukoppeln.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terminals/:deviceRef/share-code',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Freigabecode fuer ein anderes Haus ausgeben',
    handler: async (req, reply) => {
      const { propertyId, deviceRef } = req.params as { propertyId: string; deviceRef: string }
      const principal = req.principal as Principal
      const code = neuerCode(FREIGABE_LAENGE)
      return tx(req.pool, req, async client => {
        const g = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM terminal_device
            WHERE public_ref = $1 AND property_id = $2 AND revoked_at IS NULL`,
          [deviceRef, Number(propertyId)])
        if (g.rowCount === 0) throw Errors.notFound('res.terminal')
        const deviceId = Number(g.rows[0]!.id)
        await client.query(
          `UPDATE terminal_share
              SET revoked_at = now(), revoked_by = $2, token_hash = NULL, token_expires_at = NULL
            WHERE device_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL`,
          [deviceId, principal.userId])
        const { rows } = await client.query<{ ablauf: string }>(
          `INSERT INTO terminal_share (device_id, property_id, token_hash, token_expires_at,
                                       created_by)
           VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5)
           RETURNING to_char(token_expires_at AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ablauf`,
          [deviceId, Number(propertyId), hashToken(code), FREIGABE_STUNDEN, principal.userId])
        reply.status(201)
        return { deviceRef, name: g.rows[0]!.name,
                 shareCode: codeAnzeigen(code), shareCodeExpiresAt: rows[0]!.ablauf }
      })
    }
  })

  /**
   * Einen Freigabecode einloesen: dieses Haus nutzt das Geraet ab jetzt mit.
   *
   * Prueft ein Geheimnis hinter einer Sitzung und zaehlt seine
   * Fehlversuche deshalb selbst (CLAUDE.md, Ratenbegrenzung): die
   * allgemeine Grenze erreicht eine angemeldete Anfrage nie. Gezaehlt je
   * Benutzer auf demselben Zaehler wie die Kopplung.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/terminal-shares',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal eines anderen Hauses mitnutzen (Freigabecode einloesen)',
    handler: async (req, reply) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const zaehler = `freigabe:${principal.userId ?? principal.clientKey}`
      if (limiters.kopplung.erschoepft(zaehler)) {
        throw tooManyRequests(Math.ceil(KOPPLUNG_FEHLVERSUCHE.windowMs / 1000))
      }
      const eingabe = (req.body as { code?: unknown } | undefined)?.code
      const code = typeof eingabe === 'string' ? codeNormalisieren(eingabe) : ''
      if (code.length !== FREIGABE_LAENGE) {
        limiters.kopplung.check(zaehler)
        throw Errors.unprocessable('terminal.shareCodeInvalid')
      }
      const r = await tx(req.pool, req, async client => {
        try {
          return await client.query<{ share_ref: string; device_ref: string
                                      device_name: string; property_name: string }>(
            `SELECT * FROM terminal_share_redeem($1, $2, $3)`,
            [hashToken(code), haus, principal.userId])
        } catch (e) {
          // Der Teilindex `terminal_share_once`: dieses Haus nutzt das
          // Geraet schon.
          if ((e as { code?: string }).code === '23505') {
            throw Errors.conflict('terminal.alreadyShared')
          }
          throw e
        }
      })
      if (r.rowCount === 0) {
        limiters.kopplung.check(zaehler)
        throw Errors.unprocessable('terminal.shareCodeInvalid')
      }
      const z = r.rows[0]!
      reply.status(201)
      return { shareRef: z.share_ref, deviceRef: z.device_ref, deviceName: z.device_name,
               ownerProperty: z.property_name }
    }
  })

  /**
   * Eine Freigabe beenden -- vom Master wie vom Haus, das mitnutzt.
   *
   * Ein offener Auftrag des mitnutzenden Hauses faellt mit, und sein
   * Online-Check-in-Link auch. Das Geraet sieht die Daten dieses Hauses ab
   * seiner naechsten Anfrage nicht mehr: sein Principal wird bei jeder
   * Anfrage neu aufgeloest, und die Freigabe gehoert dann nicht mehr dazu.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/terminal-shares/:shareRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Freigabe beenden',
    handler: async (req) => {
      const { propertyId, shareRef } = req.params as { propertyId: string; shareRef: string }
      const haus = Number(propertyId)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const f = await client.query<{ id: string; device_id: string; guest_property_id: string }>(
          `SELECT id, device_id, guest_property_id FROM terminal_share
            WHERE public_ref = $1 AND revoked_at IS NULL AND redeemed_at IS NOT NULL
              AND (property_id = $2 OR guest_property_id = $2)
            FOR UPDATE`, [shareRef, haus])
        if (f.rowCount === 0) throw Errors.notFound('res.terminalShare')
        const z = f.rows[0]!
        await client.query(`SELECT terminal_device_jobs_end($1, $2, false)`,
          [Number(z.device_id), Number(z.guest_property_id)])
        await client.query(
          `UPDATE terminal_share SET revoked_at = now(), revoked_by = $2 WHERE id = $1`,
          [Number(z.id), principal.userId])
        return { shareRef, revoked: true }
      })
    }
  })

  // ------------------------------------------------ Rezeption

  /**
   * Was an der Reservierung zum Terminal gehoert, in einem Aufruf: welche
   * Terminals es gibt, was sich anbietet (Meldeschein, Hausbedingungen,
   * Seiten, Adressen) und wie es um den letzten Auftrag steht. Die
   * Rezeption fragt das alle zwei Sekunden, solange ein Auftrag offen ist --
   * derselbe Aufruf, kein zweiter fuer den Zustand.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/terminal',
    permission: 'reservation:checkin',
    summary: 'Gaesteterminal: Angebote und Auftragsstand einer Reservierung',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const lage = await lageZurReservierung(req, client, reservationRef)
        // Belegt ist ein Geraet auch durch den Auftrag eines anderen Hauses,
        // das es mitnutzt; den sieht dieses Haus nicht, nur dass es belegt
        // ist (`terminal_device_busy`).
        const geraete = await client.query(
          `SELECT d.public_ref AS "deviceRef", d.name, d.property_id <> $1 AS shared,
                  coalesce(s.last_seen_at > now() - make_interval(secs => $2), false)
                    AS online,
                  terminal_device_busy(d.id) AS busy
             FROM terminal_device d
             LEFT JOIN terminal_device_seen s ON s.device_id = d.id
            WHERE ${GERAET_DES_HAUSES} AND d.paired_at IS NOT NULL
            ORDER BY d.property_id <> $1, d.name, d.id`, [lage.propertyId, ONLINE_SEKUNDEN])
        const auftrag = await client.query(
          `SELECT ${AUFTRAG_FUER_REZEPTION}
             FROM terminal_job j
             JOIN terminal_device d ON d.id = j.device_id
             ${AUFTRAG_LABEL_JOINS}
            WHERE j.reservation_id = $1 AND j.property_id = $2
              AND (j.finished_at > now() - make_interval(mins => $3)
                   OR (j.finished_at IS NULL
                       AND j.expires_at > now() - make_interval(mins => $3)))
            ORDER BY j.created_at DESC, j.id DESC
            LIMIT 1`, [lage.reservationId, lage.propertyId, AUFTRAG_SICHTBAR_MINUTEN])
        return {
          terminals: geraete.rows,
          offers: await angebote(client, lage),
          registration: lage.registrationId === null ? null : {
            registrationId: lage.registrationId,
            signatureRequired: lage.signatureRequired, signed: lage.signed },
          job: auftrag.rows[0] ?? null
        }
      })
    }
  })

  /**
   * Das Bedienfeld der Rezeption: alle Terminals des Hauses mit ihrem
   * laufenden oder eben beendeten Auftrag, dazu die Seiten und Adressen,
   * die sich ohne Reservierung zeigen lassen. Ein Aufruf fuer den
   * Bildschirm.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/terminal-desk',
    permission: 'reservation:checkin',
    propertyParam: 'propertyId',
    summary: 'Gaesteterminal: Bedienfeld der Rezeption',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        /*
         * Je Terminal der juengste Auftrag, der noch zaehlt -- als Verbund
         * mit LATERAL ueber den Index, nicht als Unterabfrage je Zeile ohne
         * Grenze. Es sind hoechstens zehn Terminals je Haus.
         */
        const geraete = await client.query(
          `SELECT d.public_ref AS "deviceRef", d.name, d.property_id <> $1 AS shared,
                  coalesce(s.last_seen_at > now() - make_interval(secs => $2), false)
                    AS online,
                  terminal_device_busy(d.id) AS busy,
                  CASE WHEN a."jobRef" IS NULL THEN NULL ELSE to_jsonb(a) END AS job
             FROM terminal_device d
             LEFT JOIN terminal_device_seen s ON s.device_id = d.id
             LEFT JOIN LATERAL (
                    SELECT ${AUFTRAG_FUER_REZEPTION}
                      FROM terminal_job j
                      ${AUFTRAG_LABEL_JOINS}
                     WHERE j.device_id = d.id AND j.property_id = $1
                       AND (j.finished_at > now() - make_interval(mins => $3)
                            OR (j.finished_at IS NULL
                                AND j.expires_at > now() - make_interval(mins => $3)))
                     ORDER BY j.created_at DESC, j.id DESC
                     LIMIT 1) a ON true
            WHERE ${GERAET_DES_HAUSES} AND d.paired_at IS NOT NULL
            ORDER BY d.property_id <> $1, d.name, d.id`,
          [haus, ONLINE_SEKUNDEN, AUFTRAG_SICHTBAR_MINUTEN])
        return { terminals: geraete.rows, offers: await inhalteDesHauses(client, haus) }
      })
    }
  })

  /**
   * Einen Auftrag schicken.
   *
   * Mit Reservierung fuer die Arten, die einen Gast betreffen; Seiten und
   * Adressen gehen auch ohne -- dann nennt der Rumpf das Haus. Was gezeigt
   * wird, steht nie im Auftrag selbst, sondern ist eine Kennung aus dem,
   * was das Haus angelegt hat (`termsRef`, `contentRef`, `urlRef`).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal-jobs',
    permission: 'reservation:checkin',
    summary: 'Auftrag an ein Gaesteterminal schicken',
    handler: async (req, reply) => {
      const body = (req.body ?? {}) as Wunsch & { deviceRef?: unknown; kind?: unknown
                                                  reservationRef?: unknown; propertyId?: unknown }
      if (!istArt(body.kind)) {
        throw Errors.validation({ kind: ['field.allowedValues'] },
          { values: TERMINAL_KINDS.join(', ') })
      }
      if (typeof body.deviceRef !== 'string' || body.deviceRef === '') {
        throw Errors.validation({ deviceRef: ['field.required'] })
      }
      const art = ARTEN[body.kind]
      const mitRes = typeof body.reservationRef === 'string' && body.reservationRef !== ''
      if (art.mitReservierung && !mitRes) {
        throw Errors.validation({ reservationRef: ['field.required'] })
      }
      const principal = req.principal as Principal
      const deviceRef = body.deviceRef
      const kind = body.kind

      return tx(req.pool, req, async client => {
        let lage: Lage | null = null
        let haus: number
        if (mitRes) {
          lage = await lageZurReservierung(req, client, body.reservationRef as string)
          haus = lage.propertyId
        } else {
          haus = Number(body.propertyId)
          if (!Number.isSafeInteger(haus)) {
            throw Errors.validation({ propertyId: ['field.required'] })
          }
          if (!hasProperty(principal, haus)) throw Errors.forbidden('access.propertyOutOfScope')
          pruefeHaus(req, haus)
        }

        // Das Geraet muss zum Haus **des Vorgangs** gehoeren oder von ihm
        // ueber eine gueltige Freigabe mitgenutzt werden: die
        // Zeilenrichtlinie laesst jedes Haus des Aufrufers durch.
        const geraet = await client.query<{ id: string; paired: boolean }>(
          `SELECT d.id, d.paired_at IS NOT NULL AS paired FROM terminal_device d
            WHERE ${GERAET_DES_HAUSES} AND d.public_ref = $2`,
          [haus, deviceRef])
        if (geraet.rowCount === 0) throw Errors.notFound('res.terminal')
        if (!geraet.rows[0]!.paired) throw Errors.unprocessable('terminal.notPaired')
        const deviceId = Number(geraet.rows[0]!.id)

        const bezug = await art.vorbereiten(client, haus, lage, body)

        // Was abgelaufen ist, steht dem naechsten Auftrag nicht im Weg -- und
        // sein Online-Check-in-Link faellt mit. Ueber die Funktion, weil der
        // abgelaufene Auftrag einem anderen Haus gehoeren kann, das dasselbe
        // Geraet nutzt (Migration 0103): unsichtbar, aber im Teilindex.
        await client.query(`SELECT terminal_device_jobs_end($1, NULL, true)`, [deviceId])

        const neu = await client.query<{ public_ref: string; ablauf: string }>(
          `INSERT INTO terminal_job (property_id, device_id, kind, reservation_id,
                                     registration_id, terms_id, content_id, url_id,
                                     created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(mins => $10))
           ON CONFLICT (device_id) WHERE state IN ('pending','opened') DO NOTHING
           RETURNING public_ref,
                     to_char(expires_at AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ablauf`,
          [haus, deviceId, kind, lage?.reservationId ?? null, bezug.registrationId,
           bezug.termsId, bezug.contentId, bezug.urlId, principal.userId,
           AUFTRAG_WARTET_MINUTEN])
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
        const j = await client.query<AuftragZeile>(
          `SELECT ${AUFTRAG_SPALTEN}
             FROM terminal_job j WHERE j.public_ref = $1 FOR UPDATE`, [jobRef])
        if (j.rowCount === 0) throw Errors.notFound('res.terminalJob')
        const auftrag = alsAuftrag(j.rows[0]!)
        pruefeHaus(req, auftrag.propertyId)
        if (auftrag.state !== 'pending' && auftrag.state !== 'opened') {
          throw Errors.conflict('terminal.jobNotOpen')
        }
        return { jobRef, state: await abbrechen(client, auftrag, 'reception') }
      })
    }
  })

  // ------------------------------------------------ Das Terminal selbst

  /**
   * Koppeln. Oeffentlich, denn das Terminal hat noch nichts, womit es sich
   * ausweisen koennte -- und deshalb mit eigenem Fehlversuchszaehler.
   * Eine Mitarbeitersitzung im selben Browser endet dabei (`geraetAnmelden`).
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

      await geraetAnmelden(req, reply, geheimnis)
      const g = gekoppelt.rows[0]!
      return { deviceRef: g.device_ref, name: g.device_name, property: g.property_name }
    }
  })

  /**
   * Die Kiosk-Adresse einloesen: das Geheimnis aus `/terminal#k=...` gegen
   * das Geraetecookie.
   *
   * Fuer einen Kiosk, der seine Cookies nicht behaelt. Edge im Kioskmodus
   * von Windows laeuft immer InPrivate und verwirft das Cookie bei jedem
   * Neustart und jedem Leerlauf-Reset; danach stuende wieder die
   * Codeeingabe da. Die hinterlegte Adresse traegt das Geheimnis deshalb
   * selbst, und die Seite tauscht es bei jedem Start hier ein. Es steht
   * hinter dem `#` und erreicht damit nie eine Protokollzeile -- nur diesen
   * Rumpf.
   *
   * Oeffentlich wie die Kopplung und mit demselben Fehlversuchszaehler.
   * Ein Geheimnis aus 32 Byte raet niemand; gezaehlt wird trotzdem, damit
   * keine oeffentliche Route ein Geheimnis unbegrenzt pruefen laesst.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/terminal/resume',
    permission: null,
    summary: 'Gaesteterminal ueber seine Kiosk-Adresse anmelden',
    handler: async (req, reply) => {
      const herkunft = req.ip
      if (limiters.kopplung.erschoepft(herkunft)) {
        throw tooManyRequests(Math.ceil(KOPPLUNG_FEHLVERSUCHE.windowMs / 1000))
      }
      const eingabe = (req.body as { key?: unknown } | undefined)?.key
      if (typeof eingabe !== 'string' || !GEHEIMNIS_FORM.test(eingabe)) {
        limiters.kopplung.check(herkunft)
        throw Errors.unprocessable('terminal.kioskKeyInvalid')
      }
      // Ueber dieselbe Aufloesung wie jede Anfrage des Terminals: was hier
      // traegt, traegt dort, und ein widerrufenes Geraet traegt nirgends.
      const gefunden = await tx(req.pool, req, client =>
        client.query<{ device_ref: string }>(
          `SELECT device_ref FROM terminal_device_principal($1)`, [hashToken(eingabe)]))
      if (gefunden.rowCount === 0) {
        limiters.kopplung.check(herkunft)
        throw Errors.unprocessable('terminal.kioskKeyInvalid')
      }
      await geraetAnmelden(req, reply, eingabe)
      return { deviceRef: gefunden.rows[0]!.device_ref }
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
   *
   * Der Hausname ist der des Auftrags, solange einer offen ist: schickt das
   * Haus, das das Geraet mitnutzt (Migration 0103), soll der Gast dessen
   * Namen lesen, und ein Uebungshaus soll als solches dastehen. Ohne
   * Auftrag der des Masters, wie die Diashow.
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
          kind: string | null; state: string | null; awake: boolean }>(
          `SELECT coalesce(jp.name, p.name) AS property,
                  coalesce(jp.is_training, p.is_training) AS is_training,
                  j.public_ref, j.kind, j.state, ${WACH_SQL} AS awake
             FROM property p
             JOIN terminal_device d ON d.id = $1
             LEFT JOIN terminal_job j
                    ON j.device_id = $1 AND j.state IN ('pending','opened')
                   AND j.expires_at > now()
             LEFT JOIN property jp ON jp.id = j.property_id
            WHERE p.id = $2`, [deviceId, propertyId])
        const r = rows[0]
        return {
          property: r?.property ?? '',
          isTraining: r?.is_training ?? false,
          awake: r?.awake ?? false,
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
    handler: async (req, reply) => {
      const { deviceId } = geraetVon(req)
      const { jobRef } = req.params as { jobRef: string }
      // Die Antwort kann einen Online-Check-in-Link tragen. Sie bleibt in
      // keinem Zwischenspeicher liegen (dieselbe Kopfzeile wie die Gastseite).
      void reply.header('cache-control', 'no-store')
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
        // die Daten wieder, statt den Gast vor einem leeren Bildschirm stehen
        // zu lassen.
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
        const ende = await ARTEN[auftrag.kind].abschliessen(client, auftrag, body)
        await beenden(client, auftrag.id, ende, ende === 'canceled' ? 'terminal' : null)
        return { jobRef, state: ende }
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
      return tx(req.pool, req, async client => {
        const auftrag = await eigenerAuftrag(client, deviceId, jobRef)
        if (auftrag.state !== 'pending' && auftrag.state !== 'opened') {
          // Schon zu: nichts zu tun, und kein Fehler -- das Terminal raeumt
          // ohnehin ab, und die Rezeption hat vielleicht gerade selbst
          // abgebrochen.
          return { jobRef, state: auftrag.state }
        }
        return { jobRef,
                 state: await abbrechen(client, auftrag,
                                        grund === 'timeout' ? 'timeout' : 'terminal') }
      })
    }
  })

  /**
   * Der Ruhezustand: die Diashow, die das Haus festgelegt hat. Seiten des
   * Hauses, keine Gastdaten. Das Terminal holt sie beim Eintritt in den
   * Ruhezustand und danach alle paar Minuten, nicht bei jeder Frage.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/terminal/idle',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Diashow des Ruhezustands',
    handler: async (req) => {
      const { propertyId } = geraetVon(req)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT c.title, c.body, c.idle_seconds AS seconds, i.public_ref AS "imageRef"
             FROM terminal_content c
             LEFT JOIN terminal_content_image i ON i.content_id = c.id
            WHERE c.property_id = $1 AND c.archived_at IS NULL
              AND c.idle_position IS NOT NULL
            ORDER BY c.idle_position
            LIMIT $2`, [propertyId, DIASHOW_MAX])
        return { slides: rows }
      })
    }
  })

  /**
   * Ein Bild einer Seite -- nur eines aus dem eigenen Haus oder einem, das
   * das Geraet mitnutzt. Ausgeliefert mit
   * der Art, die beim Hochladen an den ersten Bytes erkannt wurde, und so,
   * dass ein Browser es nicht als etwas anderes deutet.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/terminal/images/:imageRef',
    permission: 'terminal:device',
    summary: 'Gaesteterminal: Bild einer Seite',
    handler: async (req, reply) => {
      // Auch Bilder der Haeuser, die das Geraet mitnutzen: eine Seite, die
      // deren Rezeption schickt, bringt ihr Bild mit (Migration 0103).
      const { propertyIds } = geraetVon(req)
      const { imageRef } = req.params as { imageRef: string }
      const bild = await tx(req.pool, req, client => bildLesen(client, imageRef, propertyIds))
      return bildSenden(reply, bild)
    }
  })
}
