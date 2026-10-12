import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { folderLink, type GuestFolderStay, type GuestFolderView, type GuestFolderSettings,
         type GuestFolderCards } from '@hotelpms/contracts'
import { FOLDER_TRANSLATION_LANGS, TRANSLATION_MAX_ATTEMPTS } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import type { Principal } from '../platform/context.js'
import { mappeTx, wlan, wlanAusRumpf, aufenthaltDerSitzung, freischalten,
         freischaltungLoeschen, eigeneFreischaltungAufheben,
         mappeZumLink, aufenthaltAnsicht, AUFENTHALT_NEU } from '../platform/gaestemappe.js'
import { setzeVerzicht } from '../platform/reinigungsverzicht.js'
import { verzichtAusRumpf } from './checkin.js'
import { rechtImHaus } from './depositRequests.js'
import { checkinTx } from '../platform/checkin.js'
import { folderNameMatches, folderPostalMatches, FOLDER_UNLOCK_MAX_FAILURES,
         FOLDER_UNLOCK_WINDOW_SECONDS } from '@hotelpms/domain'
import { tooManyRequests } from '../platform/rateLimit.js'
import { bildSenden } from '../platform/terminalBild.js'

/**
 * Digitale Gaestemappe, Bausteine 1 und 2 (Migration 0143).
 *
 * **Die Seite des Gastes** (`/v1/mappe*`, oeffentlich). Der Ausweis ist die
 * Referenz des Zimmers in der Kopfzeile `x-staygrid-folder-room`. Sie zeigt
 * nur, was ohnehin auf der Karte im Zimmer steht oder dort ausliegen
 * koennte -- Hausinfos und WLAN, keinen Gast. Was einen Aufenthalt
 * betrifft, kommt mit der Freischaltung (Nachname oder PLZ).
 *
 * **Die Einstellungen** (`/v1/properties/:propertyId/guest-folder*`) unter
 * `settings:property` wie die Seiten des Gaesteterminals: das Haus
 * entscheidet vorher, was auf dem Telefon eines Gastes erscheinen kann.
 */

const config = loadConfig()
const SEITEN_MAX = 30
const TITEL_MAX = 300
const TEXT_MAX = 10000

/** Wie beim Online-Check-in: nichts davon gehoert in einen Zwischenspeicher. */
function nichtSpeichern(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store')
}

/**
 * Jedes aktive Zimmer des Hauses bekommt seine Referenz, beim ersten Bedarf.
 * Eine Anweisung fuer alle, nicht eine je Zimmer; ein spaeter angelegtes
 * Zimmer bekommt seine beim naechsten Aufruf der Karten.
 */
async function referenzenAnlegen(client: PoolClient, propertyId: number): Promise<void> {
  await client.query(
    `INSERT INTO guest_folder_room (resource_id, property_id)
     SELECT id, property_id FROM resource WHERE property_id = $1 AND active
     ON CONFLICT (resource_id) DO NOTHING`, [propertyId])
}

interface EinstellungZeile {
  enabled: boolean; wifi_ssid: string | null; wifi_password: string | null
  wifi_security: 'WPA' | 'WEP' | 'nopass'; wifi_hidden: boolean
}

async function einstellung(
  client: PoolClient, propertyId: number
): Promise<EinstellungZeile | undefined> {
  const { rows } = await client.query<EinstellungZeile>(
    `SELECT enabled, wifi_ssid, wifi_password, wifi_security, wifi_hidden
       FROM guest_folder_setting WHERE property_id = $1`, [propertyId])
  return rows[0]
}

async function einstellungAnsicht(
  client: PoolClient, propertyId: number
): Promise<GuestFolderSettings> {
  const e = await einstellung(client, propertyId)
  /*
   * Der Stand je Sprache, fuer die Seiten in der Mappe. Eine Uebersetzung
   * zaehlt nur, solange sie zur deutschen Fassung passt; sonst wartet sie,
   * oder sie ist nach dem letzten Versuch gescheitert (0144).
   */
  const seiten = await client.query<GuestFolderSettings['pages'][number]>(
    `SELECT c.public_ref AS "contentRef", c.title, c.body, c.folder_position AS "folderPosition",
            COALESCE(json_agg(json_build_object(
              'lang', l.lang,
              'state', CASE
                 WHEN t.source_hash = h.hash THEN t.origin
                 WHEN t.pending_hash = h.hash AND t.attempts >= $3
                      AND t.last_error IS NOT NULL THEN 'failed'
                 ELSE 'pending' END,
              'title', CASE WHEN t.source_hash = h.hash THEN t.title END,
              'body', CASE WHEN t.source_hash = h.hash THEN t.body END)
              ORDER BY l.n) FILTER (WHERE l.lang IS NOT NULL), '[]') AS translations
       FROM terminal_content c
      CROSS JOIN LATERAL (SELECT terminal_content_hash(c.title, c.body) AS hash) h
       LEFT JOIN unnest($2::text[]) WITH ORDINALITY AS l(lang, n)
              ON c.folder_position IS NOT NULL
       LEFT JOIN terminal_content_translation t ON t.content_id = c.id AND t.lang = l.lang
      WHERE c.property_id = $1 AND c.archived_at IS NULL
      GROUP BY c.id
      ORDER BY c.folder_position NULLS LAST, c.title, c.id`,
    [propertyId, FOLDER_TRANSLATION_LANGS, TRANSLATION_MAX_ATTEMPTS])
  return { enabled: e?.enabled ?? false, wifi: wlan(e), pages: seiten.rows }
}

function uebersetzungsParameter(p: unknown): {
  propertyId: number; contentRef: string; lang: string } {
  const { propertyId, contentRef, lang } = p as {
    propertyId: string; contentRef: string; lang: string }
  if (!(FOLDER_TRANSLATION_LANGS as readonly string[]).includes(lang)) {
    throw Errors.validation({ lang: ['field.invalid'] })
  }
  return { propertyId: Number(propertyId), contentRef, lang }
}

export function gaestemappeRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------- Gastseite

  registerRoute(app, {
    method: 'GET',
    url: '/v1/mappe',
    // Oeffentlich: die Zimmer-Referenz in der Kopfzeile ist der Ausweis (0143).
    permission: null,
    summary: 'Gaestemappe: was die Seite des Gastes zeigt',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      return mappeTx(req, async (client, k): Promise<GuestFolderView> => {
        const haus = await client.query<{
          property_name: string; room_name: string
          checkin_time: string; checkout_time: string } & EinstellungZeile>(
          `SELECT p.name AS property_name, COALESCE(res.name, res.code) AS room_name,
                  to_char(p.checkin_time, 'HH24:MI') AS checkin_time,
                  to_char(p.checkout_time, 'HH24:MI') AS checkout_time,
                  s.enabled, s.wifi_ssid, s.wifi_password, s.wifi_security, s.wifi_hidden
             FROM property p
             JOIN resource res ON res.id = $2 AND res.property_id = p.id
             JOIN guest_folder_setting s ON s.property_id = p.id
            WHERE p.id = $1`, [k.propertyId, k.resourceId])
        const h = haus.rows[0]
        if (h === undefined) throw Errors.gone('folder.closed')
        // Nur Uebersetzungen zur aktuellen deutschen Fassung: eine veraltete
        // nennt womoeglich die alte Fruehstueckszeit (0144).
        const seiten = await client.query<GuestFolderView['pages'][number]>(
          `SELECT c.public_ref AS "contentRef", c.title, c.body,
                  i.public_ref AS "imageRef",
                  COALESCE(json_object_agg(t.lang, json_build_object(
                    'title', t.title, 'body', t.body)) FILTER (WHERE t.lang IS NOT NULL),
                    '{}') AS translations
             FROM terminal_content c
             LEFT JOIN terminal_content_image i ON i.content_id = c.id
             LEFT JOIN terminal_content_translation t
                    ON t.content_id = c.id
                   AND t.source_hash = terminal_content_hash(c.title, c.body)
            WHERE c.property_id = $1 AND c.folder_position IS NOT NULL
              AND c.archived_at IS NULL
            GROUP BY c.id, i.public_ref
            ORDER BY c.folder_position, c.id`, [k.propertyId])
        const a = await aufenthaltDerSitzung(client, req, k)
        return {
          propertyName: h.property_name, roomName: h.room_name,
          checkinTime: h.checkin_time, checkoutTime: h.checkout_time,
          wifi: wlan(h), stay: a === null ? null : await aufenthaltAnsicht(client, k, a),
          pages: seiten.rows
        }
      })
    }
  })

  /**
   * Das Bild einer Seite. Nur einer Seite, die in der Mappe steht: was das
   * Haus nur fuer das Terminal angelegt hat, soll ueber die Karte im Zimmer
   * nicht zu holen sein. Die Seite des Gastes laedt es per `fetch` mit der
   * Kopfzeile, nicht als `<img src>` -- ein Bild-Element kann keine
   * Kopfzeile schicken, und die Referenz gehoert nicht in den Pfad.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/mappe/images/:imageRef',
    // Oeffentlich: die Zimmer-Referenz in der Kopfzeile ist der Ausweis (0143).
    permission: null,
    summary: 'Gaestemappe: Bild einer Seite',
    handler: async (req, reply) => {
      const { imageRef } = req.params as { imageRef: string }
      const bild = await mappeTx(req, async (client, k) => {
        const r = await client.query<{ mime: string; bytes: Buffer }>(
          `SELECT i.mime, i.bytes
             FROM terminal_content_image i
             JOIN terminal_content c ON c.id = i.content_id
            WHERE i.public_ref = $1 AND i.property_id = $2
              AND c.folder_position IS NOT NULL AND c.archived_at IS NULL`,
          [imageRef, k.propertyId])
        if (r.rowCount === 0) throw Errors.notFound('res.terminalContent')
        return r.rows[0]!
      })
      return bildSenden(reply, bild)
    }
  })


  /**
   * Freischalten mit Nachname oder PLZ (0147). Verglichen wird gegen jeden
   * Aufenthalt, der heute im Zimmer der Karte laeuft -- am Wechseltag zwei,
   * und die Freischaltung bindet sich an den, der passt. Gegen jede Person
   * daran: Hauptgast, Mitreisende, Meldescheine.
   *
   * Die Antwort auf einen Fehlversuch sagt nicht, ob das Zimmer belegt ist:
   * "passt nicht" fuer ein leeres wie fuer ein fremdes Zimmer.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mappe/unlock',
    // Oeffentlich: die Zimmer-Referenz ist der Ausweis, Nachname oder PLZ
    // die Bestaetigung; Fehlversuche zaehlen je Zimmer (0147).
    permission: null,
    summary: 'Gaestemappe: mit Nachname oder PLZ freischalten',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      const roh = (req.body as { value?: unknown } | undefined)?.value
      const wert = typeof roh === 'string' ? roh.trim() : ''
      if (wert === '' || wert.length > 100) throw Errors.validation({ value: ['field.required'] })

      /*
       * Der Fehlversuch muss gezaehlt bleiben, auch wenn die Antwort ein
       * Fehler ist. Ein `throw` in der Transaktion rollte den Zaehler mit
       * zurueck -- deshalb kommt das Ergebnis heraus und der Fehler danach.
       */
      const ergebnis = await mappeTx(req, async (client, k): Promise<
        { art: 'gesperrt' } | { art: 'falsch' } | { art: 'ok'; stay: GuestFolderStay }> => {
        const sperre = await client.query<{ failures: number }>(
          `SELECT failures FROM guest_folder_unlock_failure
            WHERE resource_id = $1
              AND window_start > now() - make_interval(secs => $2)`,
          [k.resourceId, FOLDER_UNLOCK_WINDOW_SECONDS])
        if ((sperre.rows[0]?.failures ?? 0) >= FOLDER_UNLOCK_MAX_FAILURES) {
          return { art: 'gesperrt' }
        }

        const kandidaten = await client.query<{
          id: number; arrival: string; last_names: string[]; postal_codes: string[] }>(
          `SELECT r.id::int, r.arrival::text,
                  array_remove(array_agg(DISTINCT g.last_name), NULL) AS last_names,
                  array_remove(array_agg(DISTINCT g.postal_code), NULL) AS postal_codes
             FROM reservation r
             LEFT JOIN LATERAL (
                    SELECT r.primary_guest_id AS guest_id
                    UNION SELECT o.guest_id FROM reservation_occupant o
                           WHERE o.reservation_id = r.id
                    UNION SELECT m.guest_id FROM registration m
                           WHERE m.reservation_id = r.id) p ON true
             LEFT JOIN guest g ON g.id = p.guest_id AND g.status = 'active'
            WHERE r.property_id = $1 AND r.resource_id = $2
              AND r.status::text = ANY ($4::text[])
              AND r.arrival <= $3::date AND r.departure >= $3::date
            GROUP BY r.id
            -- Am Wechseltag gewinnt bei Gleichstand der Ankommende.
            ORDER BY r.arrival DESC, r.id`,
          [k.propertyId, k.resourceId, k.businessDate, AUFENTHALT_NEU])
        const treffer = kandidaten.rows.find(c =>
          folderNameMatches(wert, c.last_names) || folderPostalMatches(wert, c.postal_codes))

        if (treffer === undefined) {
          await client.query(
            `INSERT INTO guest_folder_unlock_failure (resource_id, property_id, failures)
             VALUES ($1, $2, 1)
             ON CONFLICT (resource_id) DO UPDATE SET
               failures = CASE WHEN guest_folder_unlock_failure.window_start
                                    > now() - make_interval(secs => $3)
                               THEN guest_folder_unlock_failure.failures + 1 ELSE 1 END,
               window_start = CASE WHEN guest_folder_unlock_failure.window_start
                                        > now() - make_interval(secs => $3)
                                   THEN guest_folder_unlock_failure.window_start ELSE now() END,
               last_failure_at = now()`,
            [k.resourceId, k.propertyId, FOLDER_UNLOCK_WINDOW_SECONDS])
          return { art: 'falsch' }
        }
        await client.query(
          `DELETE FROM guest_folder_unlock_failure WHERE resource_id = $1`, [k.resourceId])
        const s = await freischalten(client, reply,
          { propertyId: k.propertyId, reservationId: treffer.id, channel: 'room' })
        return { art: 'ok',
                 stay: await aufenthaltAnsicht(client, k,
                   { reservationId: treffer.id, departure: s.departure }) }
      })
      if (ergebnis.art === 'gesperrt') throw tooManyRequests(FOLDER_UNLOCK_WINDOW_SECONDS)
      if (ergebnis.art === 'falsch') throw Errors.unprocessable('folder.unlockFailed')
      return { stay: ergebnis.stay }
    }
  })

  /**
   * Auf die Zwischenreinigung eines Tages verzichten oder es zuruecknehmen,
   * aus der Mappe im Zimmer (0148). Nur mit Freischaltung: die Karte allein
   * hat jeder, der je im Zimmer war, und ein frueherer Gast soll dem
   * jetzigen nicht die Reinigung abbestellen. Welche Tage gehen und bis
   * wann, entscheidet `setzeVerzicht` wie fuer die anderen beiden Tueren.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mappe/cleaning-waiver',
    // Oeffentlich: Zimmer-Referenz und Freischaltung im Cookie sind der
    // Ausweis; ohne Freischaltung 403 (0147, 0148).
    permission: null,
    summary: 'Gaestemappe: auf die Zwischenreinigung eines Tages verzichten',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      const { date, waived } = verzichtAusRumpf(req.body)
      return mappeTx(req, async (client, k) => {
        const a = await aufenthaltDerSitzung(client, req, k)
        if (a === null) throw Errors.forbidden('folder.unlockRequired')
        await setzeVerzicht(client, {
          reservationId: a.reservationId, propertyId: k.propertyId,
          businessDate: k.businessDate, date, waived, source: 'folder', userId: null })
        return (await aufenthaltAnsicht(client, k, a)).cleaningWaiver
      })
    }
  })

  /**
   * Die eigene Freischaltung aufheben -- wer das Telefon weitergibt oder an
   * einem fremden Geraet war. Das Cookie geht in jedem Fall.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mappe/lock',
    // Oeffentlich: hebt nur auf, was das Cookie dieses Telefons ausweist (0147).
    permission: null,
    summary: 'Gaestemappe: Freischaltung dieses Telefons aufheben',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      await mappeTx(req, (client, k) => eigeneFreischaltungAufheben(client, req, k.propertyId))
      freischaltungLoeschen(reply)
      return { stay: null }
    }
  })

  /**
   * Aus dem Online-Check-in in die Mappe (0147). Der Link aus der Mail ist
   * schon an genau diesen Aufenthalt gebunden und reicht als Freischaltung;
   * Nachname oder PLZ zu verlangen hiesse, dem Gast noch einmal zu sagen,
   * was er gerade eingetragen hat. Der Link am Terminal schaltet nichts
   * frei -- das Geraet gehoert dem naechsten Gast.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mappe/from-checkin',
    // Oeffentlich: der Link in der Kopfzeile ist der Ausweis (Dokument 30).
    permission: null,
    summary: 'Gaestemappe: ueber den Link zum Online-Check-in oeffnen',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      return checkinTx(req, async (client, k) => {
        const z = await mappeZumLink(client, k)
        if (z === null) throw Errors.unprocessable('folder.notAvailable')
        await freischalten(client, reply,
          { propertyId: k.propertyId, reservationId: k.reservationId, channel: 'mail' })
        return { link: folderLink(config.publicAppUrl, z.ref) }
      })
    }
  })

  /** Alle Freischaltungen einer Reservierung aufheben, an der Rezeption. */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/guest-folder/revoke',
    permission: 'reservation:checkin',
    summary: 'Gaestemappe: Freischaltungen einer Reservierung aufheben',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number }>(
          `SELECT id, property_id FROM reservation WHERE public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        rechtImHaus(principal, 'reservation:checkin', r.rows[0]!.property_id)
        const u = await client.query(
          `UPDATE guest_folder_session SET revoked_at = now(), revoked_by = $2
            WHERE reservation_id = $1 AND revoked_at IS NULL`,
          [r.rows[0]!.id, principal.userId])
        return { reservationRef, revoked: u.rowCount ?? 0 }
      })
    }
  })

  // --------------------------------------------------------- Einstellungen

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/guest-folder',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Einstellung, WLAN und Seiten des Hauses',
    handler: async (req): Promise<GuestFolderSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, client => einstellungAnsicht(client, propertyId))
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/guest-folder',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe ein- oder ausschalten, WLAN des Hauses setzen',
    handler: async (req): Promise<GuestFolderSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { enabled?: unknown; wifi?: unknown }
      if (typeof b.enabled !== 'boolean') throw Errors.validation({ enabled: ['field.invalid'] })
      const w = wlanAusRumpf(b.wifi)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO guest_folder_setting
             (property_id, enabled, wifi_ssid, wifi_password, wifi_security, wifi_hidden, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (property_id) DO UPDATE SET
             enabled = $2, wifi_ssid = $3, wifi_password = $4, wifi_security = $5,
             wifi_hidden = $6, updated_by = $7, updated_at = now()`,
          [propertyId, b.enabled, w?.ssid ?? null, w?.password ?? null,
           w?.security ?? 'WPA', w?.hidden ?? false, principal.userId])
        if (b.enabled) await referenzenAnlegen(client, propertyId)
        return einstellungAnsicht(client, propertyId)
      })
    }
  })

  /**
   * Welche Seiten in der Mappe stehen, als ganze Folge gesetzt -- wie die
   * Diashow des Terminals. Eine leere Folge heisst: nur WLAN und Zeiten.
   * Zwei Anweisungen, nicht eine je Seite.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/guest-folder/pages',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Seiten und ihre Reihenfolge festlegen',
    handler: async (req): Promise<GuestFolderSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const refs = (req.body as { contentRefs?: unknown } | undefined)?.contentRefs
      if (!Array.isArray(refs) || refs.some(r => typeof r !== 'string')
          || new Set(refs).size !== refs.length) {
        throw Errors.validation({ contentRefs: ['field.invalid'] })
      }
      if (refs.length > SEITEN_MAX) {
        throw Errors.validation({ contentRefs: ['field.maxValue'] }, { max: SEITEN_MAX })
      }
      return tx(req.pool, req, async client => {
        // Erst setzen, dann zaehlen: eine fremde oder archivierte Seite faellt
        // aus dem UPDATE heraus, und die Zahl verraet es.
        const gesetzt = await client.query(
          `UPDATE terminal_content c SET folder_position = n.pos
             FROM unnest($2::text[]) WITH ORDINALITY AS n(ref, pos)
            WHERE c.public_ref = n.ref AND c.property_id = $1 AND c.archived_at IS NULL`,
          [propertyId, refs])
        if (gesetzt.rowCount !== refs.length) {
          throw Errors.validation({ contentRefs: ['field.invalid'] })
        }
        await client.query(
          `UPDATE terminal_content SET folder_position = NULL
            WHERE property_id = $1 AND folder_position IS NOT NULL
              AND NOT (public_ref = ANY ($2::text[]))`, [propertyId, refs])
        return einstellungAnsicht(client, propertyId)
      })
    }
  })

  /**
   * Eine Uebersetzung von Hand (0144). Sie gilt fuer die deutsche Fassung
   * von jetzt; aendert jemand die Seite, uebersetzt DeepL die neue, und
   * die Berichtigung ist mit der alten Fassung hinfaellig -- sie stimmte
   * fuer einen Text, den es nicht mehr gibt.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/guest-folder/pages/:contentRef/translations/:lang',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Uebersetzung einer Seite von Hand setzen',
    handler: async (req): Promise<GuestFolderSettings> => {
      const { propertyId, contentRef, lang } = uebersetzungsParameter(req.params)
      const b = (req.body ?? {}) as { title?: unknown; body?: unknown }
      const titel = typeof b.title === 'string' ? b.title.trim() : ''
      if (titel === '') throw Errors.validation({ title: ['field.required'] })
      if (titel.length > TITEL_MAX) {
        throw Errors.validation({ title: ['field.maxLength'] }, { max: TITEL_MAX })
      }
      if (typeof b.body !== 'string') throw Errors.validation({ body: ['field.invalid'] })
      if (b.body.length > TEXT_MAX) {
        throw Errors.validation({ body: ['field.maxLength'] }, { max: TEXT_MAX })
      }
      const text = b.body
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await client.query(
          `INSERT INTO terminal_content_translation
                  (content_id, property_id, lang, title, body, source_hash, origin, updated_by)
           SELECT id, property_id, $3, $4, $5, terminal_content_hash(title, body), 'manual', $6
             FROM terminal_content
            WHERE public_ref = $2 AND property_id = $1 AND archived_at IS NULL
           ON CONFLICT (content_id, lang) DO UPDATE SET
             title = EXCLUDED.title, body = EXCLUDED.body, source_hash = EXCLUDED.source_hash,
             origin = 'manual', updated_by = EXCLUDED.updated_by, updated_at = now(),
             pending_hash = NULL, attempts = 0, next_at = NULL, last_error = NULL`,
          [propertyId, contentRef, lang, titel, text, principal.userId])
        if (r.rowCount === 0) throw Errors.notFound('res.terminalContent')
        return einstellungAnsicht(client, propertyId)
      })
    }
  })

  /**
   * Zurueck zur automatischen Uebersetzung: die von Hand verwerfen, oder
   * eine gescheiterte noch einmal versuchen. Der Worker findet die Seite
   * im naechsten Tick wieder faellig.
   */
  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/guest-folder/pages/:contentRef/translations/:lang',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Uebersetzung einer Seite neu von DeepL holen',
    handler: async (req): Promise<GuestFolderSettings> => {
      const { propertyId, contentRef, lang } = uebersetzungsParameter(req.params)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const seite = await client.query(
          `SELECT 1 FROM terminal_content
            WHERE public_ref = $2 AND property_id = $1 AND archived_at IS NULL`,
          [propertyId, contentRef])
        if (seite.rowCount === 0) throw Errors.notFound('res.terminalContent')
        await client.query(
          `UPDATE terminal_content_translation t
              SET title = NULL, body = NULL, source_hash = NULL, origin = NULL,
                  pending_hash = NULL, attempts = 0, next_at = NULL, last_error = NULL,
                  updated_by = $4, updated_at = now()
             FROM terminal_content c
            WHERE c.id = t.content_id AND c.public_ref = $2 AND c.property_id = $1
              AND t.lang = $3`, [propertyId, contentRef, lang, principal.userId])
        return einstellungAnsicht(client, propertyId)
      })
    }
  })

  /** Alles fuer die Zimmerkarten des Hauses in einem Aufruf. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/guest-folder/cards',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Zimmerkarten mit WLAN und Adresse der Mappe',
    handler: async (req): Promise<GuestFolderCards> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        /*
         * Ein GET, das schreibt -- mit Absicht. Wer Karten druckt, braucht fuer
         * jedes Zimmer eine Referenz, auch fuer eines, das nach dem
         * Einschalten angelegt wurde. Die Anweisung ist idempotent und legt
         * nur an, was fehlt; ein zweiter Knopf "Referenzen anlegen" waere
         * ein Schritt, den jemand vergisst.
         */
        await referenzenAnlegen(client, propertyId)
        const e = await einstellung(client, propertyId)
        const haus = await client.query<{ name: string }>(
          `SELECT name FROM property WHERE id = $1`, [propertyId])
        const zimmer = await client.query<{
          resourceId: number; code: string; name: string | null; ref: string }>(
          `SELECT r.id::int AS "resourceId", r.code, r.name, f.public_ref AS ref
             FROM resource r
             JOIN guest_folder_room f ON f.resource_id = r.id
            WHERE r.property_id = $1 AND r.active
            ORDER BY r.code`, [propertyId])
        return {
          propertyName: haus.rows[0]!.name,
          enabled: e?.enabled ?? false,
          wifi: wlan(e),
          rooms: zimmer.rows.map(z => ({
            resourceId: z.resourceId, code: z.code, name: z.name,
            link: folderLink(config.publicAppUrl, z.ref) }))
        }
      })
    }
  })

  /**
   * Neue Referenz fuer ein Zimmer: die alte Karte zeigt danach "unbekannt".
   * Fuer den Fall, dass eine Karte fotografiert und weitergegeben wurde.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/guest-folder/rooms/:resourceId/renew',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: neue Referenz fuer die Karte eines Zimmers',
    handler: async (req) => {
      const { propertyId, resourceId } = req.params as { propertyId: string; resourceId: string }
      const zimmer = Number(resourceId)
      if (!Number.isSafeInteger(zimmer) || zimmer <= 0) {
        throw Errors.validation({ resourceId: ['field.positiveInteger'] })
      }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        // Das Zimmer gegen das Haus pruefen: die Zeilenrichtlinie filtert nach
        // Mandant, nicht nach Haus (CLAUDE.md).
        const r = await client.query<{ ref: string }>(
          `INSERT INTO guest_folder_room (resource_id, property_id, renewed_at, renewed_by)
           SELECT id, property_id, now(), $3 FROM resource
            WHERE id = $2 AND property_id = $1 AND active
           ON CONFLICT (resource_id) DO UPDATE
             SET public_ref = generate_public_ref(12), renewed_at = now(), renewed_by = $3
           RETURNING public_ref AS ref`, [Number(propertyId), zimmer, principal.userId])
        if (r.rowCount === 0) throw Errors.notFound('res.resource')
        return { link: folderLink(config.publicAppUrl, r.rows[0]!.ref) }
      })
    }
  })
}
