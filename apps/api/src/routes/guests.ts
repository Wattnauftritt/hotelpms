import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { meldeSicherheitsereignis } from '../platform/bestaetigung.js'
import { hinweisText } from '../platform/texte.js'
import { loadConfig } from '../platform/config.js'
import { decryptIdDocument, maskIdDocument } from '../platform/crypto.js'
import { gastAnlegen, gastAendern } from '../platform/gast.js'
import { accountFor, accountsWith, canInAccount, type Principal } from '../platform/context.js'
import type { Permission } from '../platform/permissions.js'
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
                WHEN $3 <> '' AND email_lower = lower($3) THEN 1.0
                WHEN $4 <> '' AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g')
                     = regexp_replace($4, '[^0-9]', '', 'g') THEN 0.9
                ELSE similarity(last_name, $2)
                     * CASE WHEN $5::date IS NOT NULL AND birth_date = $5::date THEN 1.0
                            WHEN $6 <> '' AND lower(coalesce(first_name,'')) = lower($6) THEN 0.9
                            ELSE 0.6 END
              END AS score,
              CASE
                WHEN $3 <> '' AND email_lower = lower($3) THEN 'gleiche E-Mail'
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
               OR ($3 <> '' AND email_lower = lower($3))
               OR ($4 <> '' AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g')
                   = regexp_replace($4, '[^0-9]', '', 'g')))
     ) k
     WHERE score >= 0.55 ORDER BY score DESC LIMIT 5`,
    [accountId, g.lastName, g.email ?? '', g.phone ?? '',
     g.birthDate ?? null, g.firstName ?? '', excludeId ?? null])
  return rows.map(r => ({ guestRef: r.public_ref, score: Number(r.score), reason: r.reason }))
}

/** Wie viele Hausnotizen das Profil zeigt, die neuesten zuerst. */
const NOTIZEN_IM_PROFIL = 50
/**
 * Wie lang eine Hausnotiz sein darf. Sie haelt eine Anforderung fest, nicht
 * ihre Begruendung (Befund 4, Dokument 26); wer mehr schreiben will als
 * hier Platz hat, schreibt vermutlich gerade die Begruendung.
 */
const NOTIZ_MAX = 500

/**
 * Das Recht der Route im Account **dieses** Datensatzes.
 *
 * Die Gast- und Firmenrouten nehmen kein Haus, also prueft `registerRoute`
 * das Recht nur "irgendwo", und die Zeilenrichtlinie auf `guest` und
 * `company` filtert nur nach Account. Wer bei Kunde A Rezeption ist und bei
 * Kunde B nur putzt, hat beide Accounts im Kontext -- und konnte bei B Gaeste
 * lesen, umschreiben und anonymisieren (Sicherheitsaudit 2026-10-19, H1).
 * Fremd und nicht vorhanden bekommen dieselbe Antwort, damit sich keine
 * Referenzen abzaehlen lassen.
 */
function rechtImAccount(
  principal: Principal, permission: Permission, accountId: number | string,
  res: 'res.guest' | 'res.company'
): void {
  if (canInAccount(principal, permission, Number(accountId))) return
  // Ausgeschrieben statt `notFound(res)`: der Meldungstest liest die Quelle
  // und erkennt nur feste Schluessel.
  throw res === 'res.guest' ? Errors.notFound('res.guest') : Errors.notFound('res.company')
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
        throw Errors.validation({ q: ['field.minTwoChars'] })
      }
      const limit = Math.min(Number(q.limit ?? 20) || 20, 100)
      // Nur in den Accounts, in denen das Recht besteht (H1, Audit 2026-10-19).
      const accounts = accountsWith(req.principal as Principal, 'guest:read')
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
         * Die Schwelle steht **aussen**, nicht als `last_name % $1` im Scan.
         * `guest` steht unter erzwungener Zeilenrichtlinie, und PostgreSQL
         * laesst eine Bedingung des Aufrufers nur vor der Richtlinie laufen,
         * wenn ihr Operator LEAKPROOF ist; `%` ist es nicht. Innen stand sie
         * deshalb als Filter hinter dem Index, und bei einem Begriff ohne
         * Treffer griff das LIMIT nie: der Scan lief ueber jeden Gast des
         * Accounts. Aussen liest er hoechstens `limit` Zeilen. Das Ergebnis
         * ist dasselbe: die Zeilen kommen nach Abstand sortiert, also faellt
         * die erste ueber der Schwelle mit allen folgenden heraus.
         * `<= 0.7` ist `similarity >= 0.3`, der Standard von `%`.
         *
         * Der zweite Zweig findet Anfaenge ("Sonn" fuer "Sonnenschein"),
         * die `<->` als zu kurz verwirft: Wortaehnlichkeit, Schwelle 0,4.
         * Seine Treffer tragen denselben Abstand wie der erste Zweig und
         * stehen deshalb hinten; die Reihenfolge der Namenstreffer bleibt.
         *
         * Die E-Mail wird von vorn getippt, nicht unscharf gesucht, und
         * laeuft ueber einen eigenen, eigenstaendig begrenzten Zweig statt
         * ueber ein ODER, das beide Indizes ausschliessen wuerde. Sie laeuft
         * nur, wenn ein `@` im Begriff steht; ohne ist er ein Name, und
         * "anke" soll nicht jede Anke finden, deren Adresse so beginnt.
         *
         * Der Anfang ist ein **Bereich** auf der gespeicherten Spalte
         * `email_lower`, kein `lower(email) LIKE`: `lower()` und `LIKE` sind
         * nicht LEAKPROOF, liefen deshalb als Filter hinter der Richtlinie,
         * und ein Begriff ohne Treffer las jeden Gast des Accounts.
         * `~>=~` und `~<~` sind LEAKPROOF und werden Indexbedingung
         * (Migration 0069). Nebenbei sind `_` und `%` im Begriff damit
         * Zeichen und keine Platzhalter mehr.
         */
        const { rows } = await client.query<GuestRow & { dist: number }>(
          `WITH nach_name AS (
             SELECT * FROM (
               SELECT ${FIELDS}, (last_name <-> $1) AS dist
                 FROM guest
                WHERE status <> 'anonymized' AND account_id = ANY($4::bigint[])
                ORDER BY last_name <-> $1
                LIMIT $2
             ) k WHERE dist <= 0.7
           ), nach_anfang AS (
             SELECT ${FIELDS}, (last_name <-> $1) AS dist FROM (
               SELECT ${FIELDS}, ($1 <<-> last_name) AS wort
                 FROM guest
                WHERE status <> 'anonymized' AND account_id = ANY($4::bigint[])
                ORDER BY $1 <<-> last_name
                LIMIT $2
             ) k WHERE wort <= 0.6
           ), nach_email AS (
             SELECT ${FIELDS}, 0.0::real AS dist
               FROM guest
              WHERE $3 AND status <> 'anonymized' AND account_id = ANY($4::bigint[])
                AND email_lower ~>=~ lower($1)
                AND email_lower ~<~ text_prefix_end(lower($1))
              LIMIT $2
           ), zusammen AS (
             SELECT DISTINCT ON (id) *
               FROM (SELECT * FROM nach_name
                     UNION ALL SELECT * FROM nach_anfang
                     UNION ALL SELECT * FROM nach_email) k
              ORDER BY id, dist
           )
           SELECT * FROM zusammen ORDER BY dist, last_name LIMIT $2`,
          [term, limit, term.includes('@'), accounts])
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
        throw Errors.validation({ lastName: ['field.required'] })
      }
      const accountId = accountFor(principal, body.accountId, 'guest:write')

      return tx(req.pool, req, async client => {
        const duplicates = await findDuplicates(client, accountId, body)
        const angelegt = await gastAnlegen(client, accountId, body)

        reply.status(201)
        return { ...present(angelegt), possibleDuplicates: duplicates }
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
        const { rows, rowCount } = await client.query<GuestRow & { account_id: string }>(
          `SELECT ${FIELDS}, account_id FROM guest WHERE public_ref = $1`, [guestRef])
        if (rowCount === 0) throw Errors.notFound('res.guest')
        rechtImAccount(req.principal as Principal, 'guest:read', rows[0]!.account_id, 'res.guest')
        /*
         * Die Hausnotizen gehoeren ins Profil, nicht erst in die Auskunft
         * nach Art. 15: sie sind eine Anforderung des Gastes ("ebenerdiges
         * Zimmer"), und die Rezeption soll sie sehen, wenn sie ihn aufruft.
         * Im selben Aufruf, nicht in einem zweiten.
         *
         * Nur die Haeuser, die dieser Aufrufer sieht -- das erledigt die
         * Zeilenrichtlinie (Migration 0008: was ein Haus notiert, bleibt bei
         * diesem Haus). Eine Obergrenze, weil ein Stammgast in zwanzig
         * Jahren mehr ansammelt, als ein Profil zeigen sollte.
         */
        const notes = await client.query(
          `SELECT n.note, to_char(n.created_at AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
                  n.property_id AS "propertyId", p.name AS property,
                  u.display_name AS "createdBy"
             FROM guest_property_note n
             JOIN property p ON p.id = n.property_id
             LEFT JOIN app_user u ON u.id = n.created_by
            WHERE n.guest_id = $1
            ORDER BY n.created_at DESC, n.id DESC
            LIMIT $2`, [rows[0]!.id, NOTIZEN_IM_PROFIL])
        return { ...present(rows[0]!), notes: notes.rows }
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
        const cur = await client.query<{ id: number; status: string; account_id: string }>(
          `SELECT id, status, account_id FROM guest WHERE public_ref = $1 FOR UPDATE`,
          [guestRef])
        if (cur.rowCount === 0) throw Errors.notFound('res.guest')
        rechtImAccount(req.principal as Principal, 'guest:write', cur.rows[0]!.account_id,
          'res.guest')
        if (cur.rows[0]!.status === 'anonymized') {
          throw Errors.conflict('guest.anonymizedNotRevived')
        }
        // Dieselbe Anweisung wie auf der Gastseite des Online-Check-ins.
        const geaendert = await gastAendern(client, cur.rows[0]!.id, body)
        return present(geaendert)
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
          id: number; id_document_type: string | null; account_id: string
          id_document_number_enc: Buffer | null; id_document_key_version: number | null }>(
          `SELECT id, id_document_type, id_document_number_enc, id_document_key_version,
                  account_id
             FROM guest WHERE public_ref = $1`, [guestRef])
        if (rowCount === 0) throw Errors.notFound('res.guest')
        const g = rows[0]!
        rechtImAccount(principal, 'guest:read_identity', g.account_id, 'res.guest')
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
        const g = await client.query<GuestRow & { created_at: string; account_id: string }>(
          `SELECT ${FIELDS}, created_at::text, account_id FROM guest WHERE public_ref = $1`,
          [guestRef])
        if (g.rowCount === 0) throw Errors.notFound('res.guest')
        rechtImAccount(req.principal as Principal, 'guest:export', g.rows[0]!.account_id,
          'res.guest')
        const id = g.rows[0]!.id
        await meldeSicherheitsereignis(client, req, {
          kind: 'export', accountId: Number(g.rows[0]!.account_id),
          detail: { art: 'guest-data-export', guestRef }, hint: 'Auskunft Art. 15' })

        const stays = await client.query(
          `SELECT r.public_ref AS "reservationRef", p.name AS property,
                  r.arrival::text AS arrival, r.departure::text AS departure,
                  r.status::text AS status,
                  -- Die Weiterleitungsadresse des Portals (0214) ist seine
                  -- Adresse fuer diese Buchung, auch wenn sie nicht im Profil steht.
                  CASE WHEN r.primary_guest_id = $1 THEN r.booking_email END AS "bookingEmail"
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

        // Gastpost. Sie ist unstreitig seine Auskunft: Adresse, Betreff und
        // Text dessen, was an ihn hinausging (Befund 6, Dokument 26). Redigierte
        // Zustellungen sind mit aufgefuehrt, aber ohne Inhalt -- dass etwas
        // geschickt wurde, bleibt Teil der Antwort.
        const mails = await client.query(
          `SELECT e.created_at::text AS "sentAt", e.kind, e.status,
                  CASE WHEN e.redacted_at IS NULL THEN e.subject END AS subject,
                  CASE WHEN e.redacted_at IS NULL THEN e.body_text END AS "bodyText",
                  e.redacted_at IS NOT NULL AS redacted
             FROM outbound_email e
             LEFT JOIN reservation r ON r.id = e.reservation_id
             LEFT JOIN invoice i ON i.id = e.invoice_id
             LEFT JOIN folio f ON f.id = i.folio_id
             LEFT JOIN reservation r2 ON r2.id = f.reservation_id
            WHERE r.primary_guest_id = $1 OR r2.primary_guest_id = $1
            ORDER BY e.created_at DESC`, [id])

        // Einwilligungen: wann welcher Fassung zugestimmt wurde. Das Bild der
        // Unterschrift geht nicht mit hinaus -- es gehoert ihm, aber eine
        // Auskunft ist kein Anlass, es ein zweites Mal in Umlauf zu bringen.
        const agreements = await client.query(
          `SELECT ga.agreed_at::text AS "agreedAt", p.name AS property,
                  t.version, ga.signature_svg IS NOT NULL AS signed
             FROM guest_agreement ga
             JOIN property p ON p.id = ga.property_id
             JOIN property_terms t ON t.id = ga.terms_id
            WHERE ga.guest_id = $1 ORDER BY ga.agreed_at DESC`, [id])

        // Art. 15 Abs. 1 verlangt nicht nur die Daten, sondern die Angaben
        // nach lit. a bis h. Sie aendern sich je Betrieb kaum und gehoeren
        // deshalb als fester Kopf an die Auskunft -- wer sie jedesmal von Hand
        // dazuschreibt, vergisst sie eines Tages.
        const auskunft = {
          zwecke: 'zwecke.beherbergung',
          kategorien: 'kategorien.gast',
          empfaenger: 'empfaenger.gast',
          speicherdauer: 'speicherdauer.gast',
          rechte: 'rechte.betroffene',
          herkunft: 'herkunft.gast'
        }

        return {
          profile: present(g.rows[0]!),
          createdAt: g.rows[0]!.created_at,
          stays: stays.rows,
          invoices: invoices.rows,
          notes: notes.rows,
          registrations: registrations.rows,
          mails: mails.rows,
          agreements: agreements.rows,
          auskunft,
          auskunftTexte: Object.fromEntries(
            Object.entries(auskunft).map(([k, key]) => [k, hinweisText(key)])),
          hinweis: hinweisText('hint.invoiceRetention'),
          hinweisKey: 'hint.invoiceRetention'
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
        const cur = await client.query<{ id: number; status: string; account_id: string }>(
          `SELECT id, status, account_id FROM guest WHERE public_ref = $1 FOR UPDATE`,
          [guestRef])
        if (cur.rowCount === 0) throw Errors.notFound('res.guest')
        rechtImAccount(req.principal as Principal, 'guest:export', cur.rows[0]!.account_id,
          'res.guest')
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
            'guest.hasOpenReservations')
        }

        /*
         * Der Gaestebeitragsnachweis geht vor -- aber nur so weit, wie er
         * wirklich reicht.
         *
         * Kommunale Satzungen verlangen ein Gaesteverzeichnis mit Name,
         * Anschrift, Zeitraum, Naechten, Satz und Betrag -- die Stadt
         * Cuxhaven etwa sechs Jahre ab Beginn des Folgejahres, mit Geldbusse
         * bis 10 000 Euro (§ 9 Abs. 5 ihrer Gaestebeitragssatzung). Art. 17
         * Abs. 3 lit. b DSGVO nimmt deshalb aus, was diese Verpflichtung
         * fordert -- und nur das.
         *
         * Hier stand zuerst ein glattes 409. Das war zu viel: E-Mail,
         * Telefon, Geburtsdatum, Staatsangehoerigkeit, Vorlieben und
         * Hausnotizen braucht kein Verzeichnis, und sie jahrelang
         * liegenzulassen, weil ein Name bleiben muss, ist keine Erfuellung
         * einer Pflicht, sondern Bequemlichkeit.
         *
         * Also zwei Schritte: jetzt faellt alles, was der Nachweis nicht
         * braucht; der Rest faellt im Nachtlauf, sobald die Frist abgelaufen
         * ist. Dass das nicht vergessen wird, haengt nicht an einem
         * Menschen, sondern an `erasure_requested_at`.
         *
         * Seit Migration 0128 haelt auch der Meldeschein: ein Jahr nach der
         * Abreise (§ 30 Abs. 4 BMG). Die Funktion nennt die spaetere der
         * beiden Fristen.
         */
        const frist = await client.query<{ bis: string | null }>(
          `SELECT guest_retention_until($1)::text AS bis`, [id])
        const bis = frist.rows[0]?.bis ?? null

        if (bis !== null) {
          // Was Gaesteverzeichnis und Meldeschein brauchen, bleibt bis zum
          // Fristende. Alles uebrige faellt sofort.
          await client.query(`SELECT guest_erase_partial($1)`, [id])
          return { guestRef, status: 'partial', alreadyDone: false, completesAfter: bis }
        }

        // Eine Stelle, nicht drei. Welche Tabellen zu einem Gast gehoeren,
        // stand frueher hier, im aufgeschobenen Zweig und im Nachtlauf -- und
        // genau deshalb hat die Einwilligung gefehlt (Befund 5, Dokument 26).
        await client.query(`SELECT guest_erase_one($1)`, [id])

        return { guestRef, status: 'anonymized', alreadyDone: false }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/guests/:guestRef/notes',
    permission: 'guest:write',
    propertyParam: 'propertyId',
    summary: 'Hausnotiz zum Gast anlegen (Anforderung, nicht ihr Grund)',
    handler: async (req, reply) => {
      const { guestRef } = req.params as { guestRef: string }
      const { propertyId, note } = (req.body ?? {}) as { propertyId: number; note: unknown }
      const principal = req.principal as Principal
      if (typeof note !== 'string' || note.trim() === '') {
        throw Errors.validation({ note: ['field.required'] })
      }
      if (note.trim().length > NOTIZ_MAX) {
        throw Errors.validation({ note: ['field.maxLength'] }, { max: NOTIZ_MAX })
      }
      return tx(req.pool, req, async client => {
        // Der Gast im Betrieb des Hauses: das Haus prueft `propertyParam`, den
        // Gast fand bisher nur die Zeilenrichtlinie, und die Notiz eines Hauses
        // von A landete an einem Gast von B (H1, Audit 2026-10-19).
        const g = await client.query<{ id: number; status: string }>(
          `SELECT g.id, g.status FROM guest g
            WHERE g.public_ref = $1
              AND g.account_id = (SELECT p.account_id FROM property p WHERE p.id = $2)`,
          [guestRef, propertyId])
        if (g.rowCount === 0) throw Errors.notFound('res.guest')
        // Mitbehoben: an ein anonymisiertes Profil liess sich eine neue Notiz
        // haengen -- und damit genau das wieder anlegen, was die Loeschung
        // nach Art. 17 entfernt hatte (`guest_erase_one` loescht die Notizen).
        if (g.rows[0]!.status === 'anonymized') {
          throw Errors.conflict('guest.anonymizedNotRevived')
        }
        await client.query(
          `INSERT INTO guest_property_note (property_id, guest_id, note, created_by)
           VALUES ($1,$2,$3,$4)`,
          [propertyId, g.rows[0]!.id, note.trim(), principal.userId])
        reply.status(201)
        // Der Hinweis geht mit der Antwort hinaus und nicht nur in die
        // Beschreibung: eine Hausnotiz hat keine Maske, sie entsteht ueber
        // die Schnittstelle. Wer sie schreibt, liest kein Handbuch
        // (Befund 4, Dokument 26).
        return {
          guestRef, propertyId,
          hinweis: hinweisText('hint.noteNoHealthData'),
          hinweisKey: 'hint.noteNoHealthData'
        }
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
        paymentTermsDays?: number; invoiceEmail?: string; buyerReference?: string
        contactName?: string }
      const principal = req.principal as Principal
      if (!body.name || body.name.trim() === '') {
        throw Errors.validation({ name: ['field.required'] })
      }
      const leitweg = leitwegId(body.buyerReference)
      const ansprechpartner = ansprechpartnerName(body.contactName)
      const accountId = accountFor(principal, body.accountId, 'guest:write')
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ public_ref: string }>(
          `INSERT INTO company (account_id, name, vat_id, address_line1, postal_code,
                                city, country, payment_terms_days, invoice_email,
                                buyer_reference, contact_name)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'DE'),$8,$9,$10,$11)
           RETURNING public_ref`,
          [accountId, body.name.trim(), body.vatId ?? null, body.addressLine1 ?? null,
           body.postalCode ?? null, body.city ?? null, body.country ?? null,
           zahlungsziel(body.paymentTermsDays) ?? null, body.invoiceEmail ?? null,
           leitweg ?? null, ansprechpartner ?? null])
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
      if (term.length < 2) throw Errors.validation({ q: ['field.minTwoChars'] })
      // Nur in den Accounts, in denen das Recht besteht (H1, Audit 2026-10-19).
      const accounts = accountsWith(req.principal as Principal, 'guest:read')
      return tx(req.pool, req, async client => {
        /*
         * Wie die Gastsuche: die Schwelle steht aussen, weil `%` nicht
         * LEAKPROOF ist und unter der Zeilenrichtlinie von `company` sonst
         * hinter dem Index filtert -- ein Begriff ohne Treffer las jede
         * Firma des Accounts. Begruendung bei `GET /v1/guests`.
         */
        const { rows } = await client.query(
          `WITH nach_name AS (
             SELECT * FROM (
               SELECT id, (name <-> $1) AS abstand
                 FROM company WHERE active AND account_id = ANY($2::bigint[])
                ORDER BY name <-> $1 LIMIT 50
             ) k WHERE abstand <= 0.7
           ), nach_anfang AS (
             SELECT id, abstand FROM (
               SELECT id, (name <-> $1) AS abstand, ($1 <<-> name) AS wort
                 FROM company WHERE active AND account_id = ANY($2::bigint[])
                ORDER BY $1 <<-> name LIMIT 50
             ) k WHERE wort <= 0.6
           ), treffer AS (
             SELECT id, min(abstand) AS abstand
               FROM (SELECT * FROM nach_name UNION ALL SELECT * FROM nach_anfang) k
              GROUP BY id
           )
           SELECT c.public_ref AS "companyRef", c.name, c.vat_id AS "vatId", c.city,
                  c.payment_terms_days AS "paymentTermsDays"
             FROM treffer t JOIN company c ON c.id = t.id
            ORDER BY t.abstand, c.name LIMIT 50`, [term, accounts])
        return { companies: rows }
      })
    }
  })

  const COMPANY_FIELDS = `public_ref AS "companyRef", name, vat_id AS "vatId",
                           address_line1 AS "addressLine1", postal_code AS "postalCode",
                           city, country, payment_terms_days AS "paymentTermsDays",
                           invoice_email AS "invoiceEmail",
                           buyer_reference AS "buyerReference",
                           contact_name AS "contactName", active`

  registerRoute(app, {
    method: 'GET',
    url: '/v1/companies/:companyRef',
    permission: 'guest:read',
    summary: 'Firma lesen',
    handler: async (req) => {
      const { companyRef } = req.params as { companyRef: string }
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{ _account: string }>(
          `SELECT ${COMPANY_FIELDS}, account_id AS _account
             FROM company WHERE public_ref = $1`, [companyRef])
        if (rowCount === 0) throw Errors.notFound('res.company')
        const { _account, ...firma } = rows[0]!
        rechtImAccount(req.principal as Principal, 'guest:read', _account, 'res.company')
        return firma
      })
    }
  })

  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/companies/:companyRef',
    permission: 'guest:write',
    summary: 'Firma aendern',
    handler: async (req) => {
      const { companyRef } = req.params as { companyRef: string }
      const body = req.body as {
        name?: string; vatId?: string; addressLine1?: string; postalCode?: string
        city?: string; country?: string; paymentTermsDays?: number | null
        invoiceEmail?: string; active?: boolean; buyerReference?: string | null; contactName?: string | null
      }
      const leitweg = leitwegId(body.buyerReference)
      const ansprechpartner = ansprechpartnerName(body.contactName)
      const ziel = zahlungsziel(body.paymentTermsDays)
      return tx(req.pool, req, async client => {
        const cur = await client.query<{ id: number; account_id: string }>(
          `SELECT id, account_id FROM company WHERE public_ref = $1 FOR UPDATE`, [companyRef])
        if (cur.rowCount === 0) throw Errors.notFound('res.company')
        rechtImAccount(req.principal as Principal, 'guest:write', cur.rows[0]!.account_id,
          'res.company')

        const { rows } = await client.query(
          `UPDATE company SET
             name               = COALESCE($2, name),
             vat_id             = COALESCE($3, vat_id),
             address_line1      = COALESCE($4, address_line1),
             postal_code        = COALESCE($5, postal_code),
             city               = COALESCE($6, city),
             country            = COALESCE($7, country),
             payment_terms_days = CASE WHEN $15 THEN $8::int ELSE payment_terms_days END,
             invoice_email      = COALESCE($9, invoice_email),
             active             = COALESCE($10, active),
             buyer_reference    = CASE WHEN $11 THEN $12 ELSE buyer_reference END,
             contact_name       = CASE WHEN $13 THEN $14 ELSE contact_name END,
             updated_at         = now()
           WHERE id = $1 RETURNING ${COMPANY_FIELDS}`,
          [cur.rows[0]!.id, body.name ?? null, body.vatId ?? null, body.addressLine1 ?? null,
           body.postalCode ?? null, body.city ?? null, body.country ?? null,
           ziel ?? null, body.invoiceEmail ?? null, body.active ?? null,
           leitweg !== undefined, leitweg ?? null,
           ansprechpartner !== undefined, ansprechpartner ?? null, ziel !== undefined])
        return rows[0]
      })
    }
  })
}

/**
 * Zahlungsziel der Firma in Tagen. `undefined`: nicht genannt; `null`:
 * keines, es gilt die Vorgabe des Hauses, das die Rechnung ausstellt (0189).
 */
function zahlungsziel(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return v
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 365) {
    throw Errors.validation({ paymentTermsDays: ['field.range'] }, { min: 0, max: 365 })
  }
  return v
}

/**
 * Ansprechpartner der Firma (0171), etwa "Herr Max Mustermann".
 * `undefined`: nicht genannt; `null`: leer, also loeschen.
 */
function ansprechpartnerName(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string' || v.trim().length > 200) {
    throw Errors.validation({ contactName: ['field.invalid'] })
  }
  return v.trim() === '' ? null : v.trim()
}

/**
 * Leitweg-ID (BT-10) einer Behoerde, 0164. `undefined`: nicht genannt;
 * `null`: leer, also loeschen. Mit ihr wird die Rechnung eine XRechnung.
 */
function leitwegId(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') throw Errors.validation({ buyerReference: ['field.invalid'] })
  const t = v.trim()
  if (t === '') return null
  if (!/^[0-9A-Za-z-]{1,46}$/.test(t)) {
    throw Errors.validation({ buyerReference: ['field.invalid'] })
  }
  return t
}
