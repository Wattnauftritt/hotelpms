import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isSendableAddress, emailLanguage, renderInvoiceEmail, renderReservationEmail }
  from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Gastpost: Einstellungen, Versand, Postausgang.
 *
 * **Die API verschickt nichts.** Sie rendert das Anschreiben und reiht es in
 * der laufenden Transaktion ein; zugestellt wird im Worker. Das ist nicht
 * nur Arbeitsteilung: ein Versand in der Routentransaktion haette die Wahl
 * zwischen einer Rechnung ohne Mail und einer Mail ohne Rechnung, und er
 * haenge am langsamsten Glied -- ein Anbieter, der drei Sekunden braucht,
 * liesse den Check-out drei Sekunden warten.
 *
 * **Der Aufrufer bestimmt den Empfaenger, nie den Inhalt.** Das ist die
 * Grenze, an der aus einem Rechnungsversand ein Versandapparat fuer
 * beliebige Post wuerde. Betreff und Rumpf entstehen hier aus dem Fachdatum;
 * uebergeben werden kann nur, an welche Adresse es geht -- und auch das nur,
 * weil es der Alltag verlangt: die Firma will die Rechnung in der
 * Buchhaltung, nicht beim Reisenden.
 */

interface SendInvoiceBody {
  /** Abweichende Adresse. Ohne Angabe die des Rechnungsempfaengers. */
  to?: string
  /**
   * Erneut schicken, obwohl die Rechnung schon heraus ist. Ausdruecklich,
   * damit ein doppelter Klick keine zweite Mail erzeugt.
   */
  resend?: boolean
}

/** Mailadresse und Anrede zu einer Rechnung, aus dem Fachdatum. */
async function invoiceRecipient(
  client: PoolClient, invoiceId: number
): Promise<{ email: string | null; name: string | null; language: string
             anonymized: boolean }> {
  const { rows } = await client.query<{
    email: string | null; name: string | null; language: string | null
    anonymized: boolean }>(
    `SELECT COALESCE(c.invoice_email, g.email)                       AS email,
            COALESCE(c.name, nullif(trim(concat_ws(' ', g.first_name, g.last_name)), ''))
                                                                     AS name,
            g.language,
            COALESCE(g.status = 'anonymized', false)                 AS anonymized
       FROM invoice i
       LEFT JOIN folio   f ON f.id = i.folio_id
       LEFT JOIN guest   g ON g.id = f.guest_id
       LEFT JOIN company c ON c.id = f.company_id
      WHERE i.id = $1`, [invoiceId])
  const r = rows[0]
  return { email: r?.email ?? null, name: r?.name ?? null,
           language: r?.language ?? 'de', anonymized: r?.anonymized ?? false }
}

export function emailRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/email-settings',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Absenderangaben des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT from_name AS "fromName", from_email AS "fromEmail",
                  reply_to AS "replyTo", bcc_email AS "bccEmail", enabled,
                  updated_at AS "updatedAt"
             FROM property_email_setting WHERE property_id = $1`, [Number(propertyId)])
        // Kein 404: "noch nicht eingerichtet" ist ein gueltiger Zustand des
        // Hauses und keine fehlende Ressource.
        return rows[0] ?? { fromName: null, fromEmail: null, replyTo: null,
                            bccEmail: null, enabled: false, updatedAt: null }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/email-settings',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Absenderangaben festlegen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = req.body as { fromName: string; fromEmail: string
                             replyTo?: string | null; bccEmail?: string | null
                             enabled?: boolean }
      const principal = req.principal as Principal

      const fehler: Record<string, string[]> = {}
      if (!b.fromName?.trim()) fehler.fromName = ['Pflichtangabe']
      if (!isSendableAddress(b.fromEmail)) fehler.fromEmail = ['Keine brauchbare Adresse']
      if (b.replyTo && !isSendableAddress(b.replyTo)) fehler.replyTo = ['Keine brauchbare Adresse']
      if (b.bccEmail && !isSendableAddress(b.bccEmail)) fehler.bccEmail = ['Keine brauchbare Adresse']
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      return tx(req.pool, req, async client => {
        // Ein Uebungshaus schickt keine Post; den Versand dort ueberhaupt
        // einschalten zu koennen, waere eine Falle mit Ansage.
        const t = await client.query<{ is_training: boolean }>(
          `SELECT is_training FROM property WHERE id = $1`, [Number(propertyId)])
        if (t.rowCount === 0) throw Errors.notFound('Property')
        if (t.rows[0]!.is_training && b.enabled) {
          throw Errors.unprocessable(
            'Ein Uebungshaus verschickt keine E-Mail. Der Versand bleibt ausgeschaltet.')
        }

        await client.query(
          `INSERT INTO property_email_setting
             (property_id, from_name, from_email, reply_to, bcc_email, enabled, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (property_id) DO UPDATE
             SET from_name = EXCLUDED.from_name, from_email = EXCLUDED.from_email,
                 reply_to = EXCLUDED.reply_to, bcc_email = EXCLUDED.bcc_email,
                 enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by,
                 updated_at = now()`,
          [Number(propertyId), b.fromName.trim(), b.fromEmail.trim(),
           b.replyTo?.trim() || null, b.bccEmail?.trim() || null,
           b.enabled ?? false, principal.userId])
        return { propertyId: Number(propertyId), enabled: b.enabled ?? false }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/invoices/:invoiceRef/send',
    permission: 'email:send',
    summary: 'Rechnung an den Gast schicken',
    handler: async (req, reply) => {
      const { invoiceRef } = req.params as { invoiceRef: string }
      const b = (req.body ?? {}) as SendInvoiceBody
      const principal = req.principal as Principal
      if (b.to !== undefined && !isSendableAddress(b.to)) {
        throw Errors.validation({ to: ['Keine brauchbare Adresse'] })
      }

      return tx(req.pool, req, async client => {
        /*
         * Der offene Betrag kommt aus den Zahlungsvermerken dieser Rechnung,
         * nicht aus `totals`: dort steht, was berechnet wurde, nicht was
         * bezahlt ist. Und das Zahlungsziel steht nirgends als Spalte --
         * es ergibt sich aus den Zahlungsbedingungen der Firma. Bei einem
         * Privatgast gibt es keines, weil beim Check-out gezahlt wird.
         */
        const inv = await client.query<{
          id: number; property_id: number; number: string; currency: string
          gross_cent: string | number; open_cent: string | number
          due_date: string | null; property_name: string }>(
          `SELECT i.id, i.property_id, i.number, i.currency,
                  (i.totals->>'grossCent')::bigint AS gross_cent,
                  (i.totals->>'grossCent')::bigint
                    - COALESCE((SELECT sum(s.amount_cent) FROM settlement s
                                 WHERE s.invoice_id = i.id), 0) AS open_cent,
                  CASE WHEN c.payment_terms_days IS NULL THEN NULL
                       ELSE to_char(i.issued_on + c.payment_terms_days, 'DD.MM.YYYY')
                  END AS due_date,
                  p.name AS property_name
             FROM invoice i
             JOIN property p   ON p.id = i.property_id
             JOIN folio f      ON f.id = i.folio_id
             LEFT JOIN company c ON c.id = f.company_id
            WHERE i.public_ref = $1`, [invoiceRef])
        if (inv.rowCount === 0) throw Errors.notFound('Rechnung')
        const i = inv.rows[0]!

        // Schon heraus? Dann nicht noch einmal, ausser jemand sagt es
        // ausdruecklich. Ein zweiter Klick ist haeufiger als ein zweiter
        // Bedarf.
        const schon = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM outbound_email
            WHERE invoice_id = $1 AND status IN ('pending','sent')`, [i.id])
        if (Number(schon.rows[0]!.n) > 0 && b.resend !== true) {
          throw Errors.conflict(
            'Diese Rechnung ist bereits verschickt oder eingereiht. '
            + 'Zum erneuten Versand resend=true angeben.')
        }

        const e = await invoiceRecipient(client, i.id)
        if (e.anonymized) {
          throw Errors.unprocessable(
            'Der Gast ist anonymisiert. An eine geloeschte Adresse wird nicht versandt.')
        }
        const adresse = b.to ?? e.email
        if (!isSendableAddress(adresse)) {
          throw Errors.unprocessable(
            'Zu dieser Rechnung ist keine brauchbare Empfaengeradresse hinterlegt. '
            + 'Adresse am Gast- oder Firmenprofil ergaenzen oder mit to angeben.')
        }

        const text = renderInvoiceEmail({
          propertyName: i.property_name,
          guestName: e.name,
          invoiceNumber: i.number,
          grossCent: Number(i.gross_cent),
          openCent: Number(i.open_cent),
          currency: i.currency,
          dueDate: i.due_date
        }, emailLanguage(e.language))

        const q = await client.query<{ ref: string }>(
          `SELECT email_enqueue($1,'invoice',$2,$3,$4,$5,$6,$7,NULL,$8) AS ref`,
          [i.property_id, adresse, e.name, text.subject, text.text, text.html,
           i.id, principal.userId])

        reply.status(202)
        return {
          messageRef: q.rows[0]!.ref,
          invoiceRef,
          // Die Adresse geht bewusst nicht zurueck: sie stuende sonst in
          // jeder Antwort, und Antworten landen in Protokollen (C8).
          status: 'pending'
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/send-confirmation',
    permission: 'email:send',
    summary: 'Buchungsbestaetigung an den Gast schicken',
    handler: async (req, reply) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const b = (req.body ?? {}) as { to?: string }
      const principal = req.principal as Principal
      if (b.to !== undefined && !isSendableAddress(b.to)) {
        throw Errors.validation({ to: ['Keine brauchbare Adresse'] })
      }

      return tx(req.pool, req, async client => {
        const r = await client.query<{
          id: number; property_id: number; arrival: string; departure: string
          property_name: string; checkin_time: string; checkout_time: string
          currency: string; category_name: string
          email: string | null; name: string | null; language: string | null
          anonymized: boolean; total_cent: string | number }>(
          `SELECT r.id, r.property_id, r.arrival::text, r.departure::text,
                  p.name AS property_name, p.currency,
                  to_char(p.checkin_time,  'HH24:MI') AS checkin_time,
                  to_char(p.checkout_time, 'HH24:MI') AS checkout_time,
                  rc.name AS category_name,
                  g.email, g.language,
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name,
                  COALESCE(g.status = 'anonymized', false) AS anonymized,
                  COALESCE((SELECT sum(n.price_cent) FROM reservation_night n
                             WHERE n.reservation_id = r.id), 0) AS total_cent
             FROM reservation r
             JOIN property p        ON p.id = r.property_id
             JOIN resource_category rc ON rc.id = r.category_id
             LEFT JOIN guest g      ON g.id = r.primary_guest_id
            WHERE r.public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('Reservierung')
        const res = r.rows[0]!

        if (res.anonymized) {
          throw Errors.unprocessable(
            'Der Gast ist anonymisiert. An eine geloeschte Adresse wird nicht versandt.')
        }
        const adresse = b.to ?? res.email
        if (!isSendableAddress(adresse)) {
          throw Errors.unprocessable(
            'Zu dieser Reservierung ist keine brauchbare Empfaengeradresse hinterlegt.')
        }

        const text = renderReservationEmail({
          propertyName: res.property_name,
          guestName: res.name,
          reservationRef,
          arrival: res.arrival,
          departure: res.departure,
          categoryName: res.category_name,
          totalCent: Number(res.total_cent),
          currency: res.currency,
          checkinTime: res.checkin_time,
          checkoutTime: res.checkout_time
        }, emailLanguage(res.language))

        const q = await client.query<{ ref: string }>(
          `SELECT email_enqueue($1,'reservation_confirmation',$2,$3,$4,$5,$6,NULL,$7,$8) AS ref`,
          [res.property_id, adresse, res.name, text.subject, text.text, text.html,
           res.id, principal.userId])

        reply.status(202)
        return { messageRef: q.rows[0]!.ref, reservationRef, status: 'pending' }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/outbound-emails',
    permission: 'email:send',
    propertyParam: 'propertyId',
    summary: 'Postausgang des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { status?: string; limit?: string }
      // Obergrenze, wie bei jedem Listenendpunkt: ohne sie ist er ein
      // Selbstangriff.
      const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500)

      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT e.public_ref AS "messageRef", e.kind, e.subject, e.status,
                  e.attempts, e.created_at AS "createdAt", e.sent_at AS "sentAt",
                  e.next_attempt_at AS "nextAttemptAt",
                  e.provider_message_id AS "providerMessageId",
                  e.last_error AS "lastError",
                  e.redacted_at IS NOT NULL AS "redacted",
                  i.public_ref AS "invoiceRef", r.public_ref AS "reservationRef",
                  -- Die vollstaendige Adresse steht in der Zeile, hier geht
                  -- nur so viel hinaus, wie zum Wiedererkennen noetig ist.
                  CASE WHEN e.redacted_at IS NOT NULL THEN NULL
                       ELSE regexp_replace(e.to_email, '(^.).*(@.*$)', '\\1***\\2')
                  END AS "toMasked"
             FROM outbound_email e
             LEFT JOIN invoice i     ON i.id = e.invoice_id
             LEFT JOIN reservation r ON r.id = e.reservation_id
            WHERE e.property_id = $1
              AND ($2::text IS NULL OR e.status = $2)
            ORDER BY e.id DESC
            LIMIT $3`, [Number(propertyId), q.status ?? null, limit])
        return { emails: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/outbound-emails/:messageRef/cancel',
    permission: 'email:send',
    summary: 'Eingereihte Nachricht zurueckziehen',
    handler: async (req) => {
      const { messageRef } = req.params as { messageRef: string }
      return tx(req.pool, req, async client => {
        // Nur was noch nicht heraus ist. Eine zugestellte Nachricht
        // zurueckzuziehen ist nicht moeglich, und so zu tun als ob waere
        // schlimmer als die Absage.
        const r = await client.query(
          `UPDATE outbound_email SET status = 'canceled'
            WHERE public_ref = $1 AND status = 'pending'`, [messageRef])
        if (r.rowCount === 0) {
          throw Errors.conflict(
            'Nur eine noch nicht abgeschickte Nachricht laesst sich zurueckziehen.')
        }
        return { messageRef, status: 'canceled' }
      })
    }
  })
}
