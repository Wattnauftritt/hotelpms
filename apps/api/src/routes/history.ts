import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Der Aenderungsverlauf -- die erste Route, die `audit_log` **liest**.
 *
 * **Warum es ihn braucht.** Am Zimmerplan wird den ganzen Tag geschoben, von
 * mehreren Menschen an mehreren Rechnern. Die Frage "wer hat das verlegt, und
 * worauf stand es vorher" war bisher nur in der Datenbank zu beantworten --
 * also gar nicht. Sie kommt nicht aus Neugier: wenn ein Gast an der Rezeption
 * steht und sein Zimmer belegt ist, entscheidet die Antwort darueber, ob der
 * Fehler rueckgaengig gemacht oder wiederholt wird.
 *
 * **Woher die Daten kommen.** Nirgendwoher sonst: der Trigger aus Migration
 * 0001 schreibt jede Aenderung mit, seit es das Schema gibt. Es wird hier
 * nichts zusaetzlich protokolliert -- es wird zum ersten Mal gelesen.
 * Migration 0045 hat dafuer die Zeilenrichtlinie gesetzt und 0048 die
 * Partitionsrechte entzogen, ausdruecklich damit diese Route gebaut werden
 * kann: gelesen wird ueber die Elterntabelle, wo die Richtlinie greift.
 *
 * **Was nicht drinsteht.** Was `audit_redaction` redigiert, hat nie einen
 * Wert im Protokoll gehabt -- Name, Anschrift, Notiz, Unterschrift. Die
 * Antwort lautet dort "Notiz geaendert" und nicht, was darin stand. Das ist
 * Absicht und bleibt so (Befund 1, Dokument 26); der Verlauf beantwortet
 * **wer wann welches Feld**, nicht welchen Inhalt.
 */

/**
 * Welche Tabellen am Zimmerplan haengen.
 *
 * Die Auswahl ist der Unterschied zwischen einem brauchbaren Verlauf und
 * einem Datenstrom: wer wissen will, was am Plan passiert ist, meint nicht
 * den Zimmerstatus und nicht die Ratenpflege. Beides hat seinen eigenen
 * Bildschirm.
 *
 * **`reservation_night` steht hier bewusst nicht**, obwohl der Preis dort
 * liegt. Eine Buchung ueber sieben Naechte schreibt sieben Zeilen, und ein
 * verschobener Aufenthalt loescht und legt noch einmal so viele an -- im
 * hausweiten Verlauf stuende dann zwischen zwei interessanten Zeilen ein
 * Dutzend, das dasselbe Ereignis zum zwoelften Mal erzaehlt. Am Verlauf
 * **einer** Buchung sind sie dagegen genau das, wonach gefragt wird: dort
 * kommen sie mit (siehe `verlauf()`).
 */
const PLAN_TABELLEN = ['reservation', 'booking', 'charge',
                       'maintenance_block'] as const

/**
 * Welche Felder ein Mensch lesen will -- je Tabelle.
 *
 * **Eine Positivliste, und hier ausnahmsweise die richtige Richtung.** Bei
 * der Redaktion waere sie falsch (ein neues Feld rutscht durch); hier ist das
 * Schlimmste, was ein vergessenes Feld anrichtet, dass es nicht angezeigt
 * wird. Umgekehrt stuende ohne sie in jedem Eintrag `updated_at` -- und eine
 * Liste, in der neunzig Prozent Rauschen ist, liest niemand zweimal.
 */
const FELDER: Record<string, readonly string[]> = {
  reservation: ['arrival', 'departure', 'resource_id', 'category_id', 'status',
                'rate_plan_id', 'primary_guest_id', 'guaranteed', 'option_expires_at',
                'cancellation_fee_cent', 'notes', 'short_note'],
  booking: ['booker_guest_id', 'booker_company_id', 'source', 'channel_code',
            'external_reference', 'market_segment', 'commission_bp'],
  /*
   * Der Preis je Nacht. `posted` steht ausdruecklich nicht dabei: der
   * Nachtlauf setzt es jede Nacht fuer jedes belegte Zimmer, und eine Liste,
   * in der das steht, besteht aus nichts anderem mehr.
   */
  reservation_night: ['price_cent', 'rate_plan_id'],
  charge: ['description', 'quantity', 'net_cent', 'tax_cent', 'gross_cent',
           'business_date', 'reverses_id', 'invoice_id'],
  maintenance_block: ['from_date', 'to_date', 'kind', 'reason', 'resource_id']
}

interface ProtokollZeile {
  id: string
  occurred_at: string
  table_name: string
  row_id: number | null
  row_key: Record<string, unknown> | null
  action: string
  changed: Record<string, unknown> | null
  user_name: string | null
  reservation_ref: string | null
  booking_ref: string | null
  guest_name: string | null
  room_code: string | null
}

export interface Aenderung {
  id: string
  occurredAt: string
  /** Die Tabelle, unuebersetzt: die Oberflaeche entscheidet, wie sie heisst. */
  table: string
  action: string
  /** Wer. `null` heisst: der Nachtlauf, ein Import oder die Schnittstelle. */
  user: string | null
  reservationRef: string | null
  bookingRef: string | null
  /** Der Gast **von heute**, damit die Zeile zuzuordnen ist. */
  guest: string | null
  roomCode: string | null
  /**
   * Der Primaerschluessel der geaenderten Zeile.
   *
   * Fuer alles mit einer `id` ist das wenig interessant; fuer eine Nacht ist
   * es die Angabe, ohne die der Eintrag nichts sagt: "Preis 90 → 100" ohne
   * den Tag ist keine Auskunft.
   */
  rowKey: Record<string, unknown>
  /**
   * Je Feld der Wert davor und danach.
   *
   * Redigierte Felder tragen `[redigiert]` -- so schreibt der Trigger es seit
   * Migration 0044. Der Schluessel bleibt, der Wert faellt: der Verlauf
   * beantwortet "wer hat die Notiz geaendert", nicht "was stand darin".
   */
  fields: Record<string, { von: unknown; nach: unknown }>
}

/**
 * Das Rohprotokoll in etwas verwandeln, das in einer Zeile lesbar ist.
 *
 * Zeilen, von denen nach der Positivliste nichts uebrig bleibt, fallen ganz
 * weg: ein `UPDATE`, das nur `updated_at` gesetzt hat, ist keine Aenderung,
 * ueber die jemand etwas erfahren will.
 */
function aufbereiten(zeilen: ProtokollZeile[]): Aenderung[] {
  const raus: Aenderung[] = []
  for (const z of zeilen) {
    const erlaubt = FELDER[z.table_name] ?? []
    const felder: Record<string, { von: unknown; nach: unknown }> = {}
    const roh = (z.changed ?? {}) as Record<string, unknown>
    for (const name of erlaubt) {
      if (!(name in roh)) continue
      const wert = roh[name]
      /*
       * Bei INSERT und DELETE schreibt der Trigger die Zeile selbst, bei
       * UPDATE ein Paar aus `von` und `nach`. Beides kommt hier als dasselbe
       * Format heraus, damit die Oberflaeche nicht zwei Faelle kennen muss.
       */
      if (z.action === 'UPDATE' && wert !== null && typeof wert === 'object'
          && 'von' in (wert as object)) {
        felder[name] = wert as { von: unknown; nach: unknown }
      } else if (z.action === 'INSERT') {
        felder[name] = { von: null, nach: wert ?? null }
      } else {
        felder[name] = { von: wert ?? null, nach: null }
      }
    }
    if (Object.keys(felder).length === 0 && z.action === 'UPDATE') continue
    raus.push({
      id: String(z.id), occurredAt: z.occurred_at, table: z.table_name,
      action: z.action, user: z.user_name, rowKey: z.row_key ?? {},
      reservationRef: z.reservation_ref, bookingRef: z.booking_ref,
      guest: z.guest_name, roomCode: z.room_code, fields: felder
    })
  }
  return raus
}

/**
 * Die Namen hinter den Kennungen -- einmal, nicht je Zeile.
 *
 * Im Protokoll steht `resource_id: {von: 7, nach: 9}`. Daraus "203 → 205" zu
 * machen, braucht die Zimmerliste; sie je Eintrag nachzuschlagen waere eine
 * Abfrage je Zeile fuer Daten, die in einen Satz passen.
 */
async function namen(client: PoolClient, propertyId: number): Promise<{
  rooms: Record<string, string>; categories: Record<string, string>
}> {
  const z = await client.query<{ id: number; code: string }>(
    `SELECT id, code FROM resource WHERE property_id = $1`, [propertyId])
  const k = await client.query<{ id: number; name: string }>(
    `SELECT id, name FROM resource_category WHERE property_id = $1`, [propertyId])
  return {
    rooms: Object.fromEntries(z.rows.map(r => [String(r.id), r.code])),
    categories: Object.fromEntries(k.rows.map(r => [String(r.id), r.name]))
  }
}

/**
 * Der gemeinsame Rumpf beider Abfragen.
 *
 * `reservation_id` steht an `charge`, nicht am Protokolleintrag -- die
 * Verknuepfung entsteht deshalb hier ueber die Zeile, auf die sich der
 * Eintrag bezieht. Dass die Zeile inzwischen anders aussieht, ist dabei
 * richtig: die Zuordnung soll sagen, **welche Buchung** gemeint ist, und das
 * ist die von heute.
 *
 * Der Gastname kommt aus der lebenden Reservierung und nicht aus dem
 * Protokoll -- dort steht er nicht und soll dort nicht stehen. Gezeigt wird
 * damit genau das, was im Plan ohnehin auf dem Balken steht.
 */
const RUMPF = `
  SELECT a.id,
         -- Ausdruecklich als ISO mit Z und nicht als Text: PostgreSQL
         -- schriebe "2026-10-01 14:04:52+00", und das ist in JavaScript
         -- nicht genormt -- es laeuft im Browser und bricht im naechsten.
         to_char(a.occurred_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
         a.table_name, a.row_id, a.row_key,
         a.action, a.changed, u.display_name AS user_name,
         COALESCE(r.public_ref, cr.public_ref, nr.public_ref)   AS reservation_ref,
         COALESCE(b.public_ref, rb.public_ref, crb.public_ref,
                  nrb.public_ref)                               AS booking_ref,
         COALESCE(g.last_name, cg.last_name, ng.last_name)      AS guest_name,
         COALESCE(res.code, nres.code, mres.code)               AS room_code
    FROM audit_log a
    LEFT JOIN app_user u ON u.id = a.user_id
    LEFT JOIN reservation r  ON a.table_name = 'reservation' AND r.id = a.row_id
    LEFT JOIN booking    rb  ON rb.id = r.booking_id
    LEFT JOIN booking    b   ON a.table_name = 'booking' AND b.id = a.row_id
    LEFT JOIN charge     c   ON a.table_name = 'charge' AND c.id = a.row_id
    LEFT JOIN reservation cr ON cr.id = c.reservation_id
    LEFT JOIN booking    crb ON crb.id = cr.booking_id
    -- Die Nacht hat einen zusammengesetzten Schluessel, also keine row_id:
    -- der Trigger legt ihn als row_key ab (Migration 0001).
    LEFT JOIN reservation nr ON a.table_name = 'reservation_night'
                            AND nr.id = (a.row_key ->> 'reservation_id')::bigint
    LEFT JOIN booking    nrb ON nrb.id = nr.booking_id
    LEFT JOIN guest      g   ON g.id = r.primary_guest_id
    LEFT JOIN guest      cg  ON cg.id = cr.primary_guest_id
    LEFT JOIN guest      ng  ON ng.id = nr.primary_guest_id
    LEFT JOIN resource   res ON res.id = r.resource_id
    LEFT JOIN resource   nres ON nres.id = nr.resource_id
    LEFT JOIN maintenance_block mb ON a.table_name = 'maintenance_block' AND mb.id = a.row_id
    LEFT JOIN resource   mres ON mres.id = mb.resource_id`

export function historyRoutes(app: FastifyInstance): void {
  /**
   * Was zuletzt im Haus geaendert wurde.
   *
   * **Eine Obergrenze, zwei Richtungen.** `limit` begrenzt die Zeilen,
   * `before` blaettert weiter. Ohne beides waere der Endpunkt ein
   * Selbstangriff: das Protokoll eines Hauses waechst monatlich
   * sechsstellig, und "alles" ist nie die Frage.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/changes',
    permission: 'reservation:read',
    propertyParam: 'propertyId',
    summary: 'Aenderungen am Zimmerplan, neueste zuerst',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { limit?: string; before?: string }
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
      const before = q.before === undefined || q.before === '' ? null : Number(q.before)
      if (before !== null && !Number.isFinite(before)) {
        throw Errors.validation({ before: ['field.integer'] })
      }
      const id = Number(propertyId)

      return tx(req.pool, req, async client => {
        /*
         * Nach `id` geblaettert und nicht nach Zeitstempel: zwei Aenderungen
         * in derselben Transaktion tragen dieselbe Zeit, und ein Cursor auf
         * der Zeit uebersprunge die zweite oder zeigte die erste doppelt.
         */
        const { rows } = await client.query<ProtokollZeile>(
          `${RUMPF}
            WHERE a.property_id = $1
              AND a.table_name = ANY($2::text[])
              AND ($3::bigint IS NULL OR a.id < $3)
            ORDER BY a.occurred_at DESC, a.id DESC
            LIMIT $4`,
          [id, PLAN_TABELLEN, before, limit])
        return { changes: aufbereiten(rows), ...(await namen(client, id)) }
      })
    }
  })

  /**
   * Der Verlauf **einer** Buchung -- mit allen ihren Zimmern.
   *
   * Eine Gruppe ist der Fall, fuer den das gebraucht wird: acht Zimmer, drei
   * Umbuchungen, und niemand weiss mehr, welche davon zusammengehoerten. Die
   * Positionen des Folios kommen mit, weil "Preis geaendert" genau dort
   * steht -- eine Korrektur ist eine Gegenbuchung, und ohne sie sieht der
   * Verlauf nach einer unveraenderten Buchung aus.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/bookings/:bookingRef/history',
    permission: 'reservation:read',
    summary: 'Aenderungsverlauf einer Buchung',
    handler: async (req) => {
      const { bookingRef } = req.params as { bookingRef: string }
      return tx(req.pool, req, async client => {
        const b = await client.query<{ id: number; property_id: number }>(
          `SELECT id, property_id FROM booking WHERE public_ref = $1`, [bookingRef])
        if (b.rowCount === 0) throw Errors.notFound('res.booking')
        return await verlauf(client, b.rows[0]!.property_id,
          { bookingId: b.rows[0]!.id })
      })
    }
  })

  /** Derselbe Verlauf, aber nur dieses eine Zimmer der Buchung. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/history',
    permission: 'reservation:read',
    summary: 'Aenderungsverlauf einer Reservierung',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number }>(
          `SELECT id, property_id FROM reservation WHERE public_ref = $1`,
          [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        return await verlauf(client, r.rows[0]!.property_id,
          { reservationId: r.rows[0]!.id })
      })
    }
  })
}

/**
 * Die Eintraege zu einer Buchung oder einer Reservierung.
 *
 * **Eine Abfrage, nicht vier.** Welche Zeilen zur Buchung gehoeren, steht in
 * der Datenbank; sie einzeln zu holen und dann je Gruppe ein Protokoll
 * nachzuladen waere eine Runde je Zimmer. Die Vorauswahl laeuft deshalb als
 * `WITH` im selben Aufruf.
 *
 * Das Haus steht als erste Bedingung dabei, obwohl die Zeilenrichtlinie es
 * ohnehin erzwingt: ohne sie muesste PostgreSQL fuer den Zweig ueber
 * `row_key` -- der keine `row_id` hat und damit keinen Index findet -- das
 * Protokoll aller Haeuser durchsehen.
 */
async function verlauf(client: PoolClient, propertyId: number,
                       was: { bookingId?: number; reservationId?: number }) {
  const { rows } = await client.query<ProtokollZeile>(
    `WITH ziel AS (
       SELECT r.id, r.booking_id
         FROM reservation r
        WHERE ($1::bigint IS NULL OR r.booking_id = $1)
          AND ($2::bigint IS NULL OR r.id = $2)
     )
     ${RUMPF}
     WHERE a.property_id = $3
       AND (
         (a.table_name = 'reservation'
            AND a.row_id IN (SELECT id FROM ziel))
         -- Einmal, nicht je Zimmer: acht Reservierungen zeigten den
         -- Eintrag der Buchung sonst achtmal.
         OR (a.table_name = 'booking'
            AND a.row_id IN (SELECT DISTINCT booking_id FROM ziel))
         OR (a.table_name = 'charge'
            AND a.row_id IN (SELECT c.id FROM charge c
                              WHERE c.reservation_id IN (SELECT id FROM ziel)))
         -- Zusammengesetzter Schluessel: die Nacht steht in row_key.
         OR (a.table_name = 'reservation_night'
            AND (a.row_key ->> 'reservation_id')::bigint IN (SELECT id FROM ziel))
       )
     ORDER BY a.occurred_at DESC, a.id DESC
     LIMIT 500`,
    [was.bookingId ?? null, was.reservationId ?? null, propertyId])
  return { changes: aufbereiten(rows), ...(await namen(client, propertyId)) }
}
