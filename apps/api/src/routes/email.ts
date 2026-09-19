import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isSendableAddress, isFreemailDomain, domainOf, emailLanguage,
         renderInvoiceEmail, renderReservationEmail, renderDomainRequestNotice }
  from '@hotelpms/domain'
import { loadConfig } from '../platform/config.js'
import { createBrevoDomains, DomainApiError, type DomainVerwaltung }
  from '../platform/brevoDomains.js'
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

export interface EmailRouteOverrides {
  /** Fuer Tests: ein Client ohne echten Netzwerkzugriff auf den Anbieter. */
  domains?: DomainVerwaltung
}

export function emailRoutes(
  app: FastifyInstance, overrides: EmailRouteOverrides = {}
): void {
  const config = loadConfig()
  const brevoDomains = overrides.domains ?? null

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
      if (!isSendableAddress(b.fromEmail)) fehler.fromEmail = ['field.email']
      if (b.replyTo && !isSendableAddress(b.replyTo)) fehler.replyTo = ['field.email']
      if (b.bccEmail && !isSendableAddress(b.bccEmail)) fehler.bccEmail = ['field.email']
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      return tx(req.pool, req, async client => {
        // Ein Uebungshaus schickt keine Post; den Versand dort ueberhaupt
        // einschalten zu koennen, waere eine Falle mit Ansage.
        const t = await client.query<{ is_training: boolean }>(
          `SELECT is_training FROM property WHERE id = $1`, [Number(propertyId)])
        if (t.rowCount === 0) throw Errors.notFound('res.property')
        if (t.rows[0]!.is_training && b.enabled) {
          throw Errors.unprocessable(
            'training.noEmail')
        }

        /*
         * Einschalten geht nur mit freigeschalteter Absenderdomain.
         *
         * Die Datenbank prueft dasselbe noch einmal beim Einreihen jeder
         * Nachricht (email_enqueue), und das ist keine Doppelung aus
         * Versehen: dort ist es der Zaun, hier die Antwort an einen
         * Menschen. Wer nur den Zaun hat, schaltet ein, sieht keinen
         * Fehler, und merkt erst beim ersten Check-out, dass nichts geht.
         *
         * Zwei getrennte Meldungen, weil die beiden Faelle verschiedene
         * naechste Schritte haben: keine Domain heisst beantragen, falsche
         * Adresse heisst die Adresse aendern.
         */
        if (b.enabled) {
          const d = await client.query<{ domain: string; status: string
                                         erlaubt: boolean }>(
            `SELECT d.domain, d.status,
                    email_sender_allowed($1, $2) AS erlaubt
               FROM property_email_domain d WHERE d.property_id = $1`,
            [Number(propertyId), b.fromEmail.trim()])
          if (d.rowCount === 0 || d.rows[0]!.status !== 'active') {
            throw Errors.unprocessable('domain.notActive')
          }
          if (!d.rows[0]!.erlaubt) {
            throw Errors.unprocessable('domain.senderMismatch',
              { domain: d.rows[0]!.domain })
          }
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
        throw Errors.validation({ to: ['field.email'] })
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
        if (inv.rowCount === 0) throw Errors.notFound('res.invoice')
        const i = inv.rows[0]!

        // Schon heraus? Dann nicht noch einmal, ausser jemand sagt es
        // ausdruecklich. Ein zweiter Klick ist haeufiger als ein zweiter
        // Bedarf.
        const schon = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM outbound_email
            WHERE invoice_id = $1 AND status IN ('pending','sent')`, [i.id])
        if (Number(schon.rows[0]!.n) > 0 && b.resend !== true) {
          throw Errors.conflict(
            'mail.alreadySent')
        }

        const e = await invoiceRecipient(client, i.id)
        if (e.anonymized) {
          throw Errors.unprocessable(
            'mail.guestAnonymized')
        }
        const adresse = b.to ?? e.email
        if (!isSendableAddress(adresse)) {
          throw Errors.unprocessable(
            'mail.noInvoiceAddress')
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
        throw Errors.validation({ to: ['field.email'] })
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
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!

        if (res.anonymized) {
          throw Errors.unprocessable(
            'mail.guestAnonymized')
        }
        const adresse = b.to ?? res.email
        if (!isSendableAddress(adresse)) {
          throw Errors.unprocessable(
            'mail.noReservationAddress')
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
            'mail.onlyUnsentCancellable')
        }
        return { messageRef, status: 'canceled' }
      })
    }
  })

  // ------------------------------------------------ Absenderdomain des Hauses
  /*
   * Der Weg, den eine Domain nimmt: beantragen -> wir geben frei -> das Haus
   * traegt drei DNS-Eintraege ein -> nachsehen lassen -> Versand moeglich.
   *
   * **Warum eine Freigabe dazwischen steht.** Was ein Haus hier beantragt,
   * landet in unserem Konto beim Anbieter, kostet dort Kontingent und traegt
   * unseren Ruf als Versender. Selbstbedienung waere bequemer und hiesse,
   * dass ein falsch geschriebener oder fremder Domainname ungeprueft dorthin
   * durchschlaegt.
   *
   * **Das Haus bekommt unseren Zugang dabei nie zu sehen.** Angemeldet wird
   * mit unserem Schluessel, hier, nach der Freigabe; zurueck kommen drei
   * oeffentliche TXT-Eintraege, und die traegt das Haus bei seinem eigenen
   * DNS-Anbieter ein.
   */

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/email-domain',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Stand der Absenderdomain',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT mode, domain, local_part AS "localPart", status,
                  verified, authenticated, dns_records AS "dnsRecords",
                  requested_at AS "requestedAt", decided_at AS "decidedAt",
                  decision_note AS "decisionNote", checked_at AS "checkedAt"
             FROM property_email_domain WHERE property_id = $1`,
          [Number(propertyId)])
        // Kein 404: "noch nicht beantragt" ist ein gueltiger Zustand des
        // Hauses und keine fehlende Ressource -- wie bei den
        // Absenderangaben daneben.
        return rows[0] ?? {
          mode: null, domain: null, localPart: null, status: null,
          verified: false, authenticated: false, dnsRecords: [],
          requestedAt: null, decidedAt: null, decisionNote: null, checkedAt: null,
          relayDomain: config.relayEmailDomain
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/email-domain',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Absenderdomain beantragen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = req.body as { mode?: string; domain?: string; localPart?: string }
      const principal = req.principal as Principal
      const mode = b.mode === 'relay' ? 'relay' : 'own'

      let domain: string
      let localPart: string | null = null

      if (mode === 'relay') {
        if (config.relayEmailDomain.trim() === '') {
          throw Errors.notConfigured('domain.relayNotConfigured')
        }
        domain = config.relayEmailDomain.toLowerCase()
        localPart = (b.localPart ?? '').trim().toLowerCase()
        // Dieselbe Form wie in der Bedingung der Tabelle. Hier, weil eine
        // Meldung aus der Datenbank den Benutzer nicht erreicht.
        if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(localPart)) {
          throw Errors.validation({ localPart: ['field.required'] })
        }
      } else {
        // Wer eine ganze Adresse eintippt, meint ihre Domain. Das
        // abzuweisen waere formal richtig und praktisch aergerlich.
        domain = (domainOf(b.domain) || (b.domain ?? '').trim().toLowerCase())
        if (domain === '' || /[@\s]/.test(domain) || !domain.includes('.')) {
          throw Errors.validation({ domain: ['field.required'] })
        }
        /*
         * Freemail hier abfangen und nicht erst beim Anbieter: sonst wartet
         * ein Haus drei Tage auf eine Freigabe, um dann zu erfahren, dass
         * seine GMX-Adresse nie gehen konnte.
         */
        if (isFreemailDomain(domain)) {
          throw Errors.unprocessable('domain.freemail',
            { relay: config.relayEmailDomain })
        }
      }

      return tx(req.pool, req, async client => {
        const t = await client.query<{ is_training: boolean }>(
          `SELECT is_training FROM property WHERE id = $1`, [Number(propertyId)])
        if (t.rowCount === 0) throw Errors.notFound('res.property')
        // Ein Uebungshaus verschickt nichts, also braucht es auch keine
        // Domain -- und ein Antrag daraus kostete jemanden bei uns Zeit.
        if (t.rows[0]!.is_training) throw Errors.unprocessable('training.noEmail')

        const da = await client.query<{ status: string }>(
          `SELECT status FROM property_email_domain WHERE property_id = $1`,
          [Number(propertyId)])
        // Ein abgelehnter oder zurueckgenommener Antrag darf ersetzt werden;
        // ein offener oder laufender nicht, sonst verschwaende die Freigabe,
        // die gerade jemand bearbeitet.
        if (da.rows.length > 0 && da.rows[0]!.status !== 'rejected') {
          throw Errors.conflict('domain.alreadyRequested')
        }

        try {
          await client.query(
            `INSERT INTO property_email_domain
               (property_id, mode, domain, local_part, status, requested_by,
                requested_at, dns_records, verified, authenticated,
                provider_id, decided_by, decided_at, decision_note, checked_at)
             VALUES ($1,$2,$3,$4,'requested',$5, now(), '[]'::jsonb, false, false,
                     NULL, NULL, NULL, NULL, NULL)
             ON CONFLICT (property_id) DO UPDATE
               SET mode = EXCLUDED.mode, domain = EXCLUDED.domain,
                   local_part = EXCLUDED.local_part, status = 'requested',
                   requested_by = EXCLUDED.requested_by, requested_at = now(),
                   dns_records = '[]'::jsonb, verified = false,
                   authenticated = false, provider_id = NULL,
                   decided_by = NULL, decided_at = NULL, decision_note = NULL,
                   checked_at = NULL, updated_at = now()`,
            [Number(propertyId), mode, domain, localPart, principal.userId])
        } catch (e) {
          // Die beiden teilweisen eindeutigen Indizes. Welcher gegriffen
          // hat, sagt der Modus -- zwei Meldungen, weil "schon vergeben"
          // bei einer Domain etwas anderes heisst als bei einem Namensteil.
          if ((e as { code?: string }).code === '23505') {
            throw mode === 'relay'
              ? Errors.conflict('domain.localPartTaken',
                  { relay: config.relayEmailDomain })
              : Errors.conflict('domain.taken')
          }
          throw e
        }

        /*
         * Der Hinweis an uns. Hoechstens einer offen, darum kuemmert sich
         * platform_notice_enqueue -- zehn Antraege an einem Vormittag sollen
         * zehn Zeilen im Adminpanel ergeben und eine Mail, nicht zehn.
         *
         * SECURITY DEFINER, weil hier eine Kundensitzung laeuft: sie soll
         * weder einen Empfaenger bestimmen noch erfahren, wer bei uns
         * arbeitet.
         */
        const offen = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM property_email_domain WHERE status = 'requested'`)
        const text = renderDomainRequestNotice({
          offen: Number(offen.rows[0]!.n),
          link: `${config.publicAppUrl}/?screen=adminpanel`
        })
        await client.query(`SELECT platform_notice_enqueue($1,$2,$3)`,
          [config.platformNoticeEmail, text.subject, text.text])

        reply.status(202)
        return { propertyId: Number(propertyId), mode, domain, localPart,
                 status: 'requested' }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/email-domain/check',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Nachsehen, ob die DNS-Eintraege stehen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      // Wie bei der Freigabe: der Schluessel wird nur gebraucht, wenn
      // wirklich der echte Client entsteht.
      if (brevoDomains === null && config.brevoApiKey === null) {
        throw Errors.notConfigured('domain.providerNotConfigured')
      }

      const zeile = await tx(req.pool, req, async client => {
        const { rows } = await client.query<{ domain: string; status: string }>(
          `SELECT domain, status FROM property_email_domain WHERE property_id = $1`,
          [Number(propertyId)])
        if (rows.length === 0) throw Errors.notFound('domain.notRequested')
        if (rows[0]!.status !== 'dns_pending') {
          throw Errors.conflict('domain.onlyWhilePending')
        }
        return rows[0]!
      })

      /*
       * Der Aufruf nach draussen liegt **zwischen** den beiden
       * Transaktionen, nicht in einer: eine offene Transaktion haelt
       * Sperren, und der Anbieter braucht, was er braucht.
       */
      const anbieter = brevoDomains
        ?? createBrevoDomains(config.brevoApiKey as string)
      let stand
      try {
        stand = await anbieter.pruefenLassen(zeile.domain)
      } catch (e) {
        if (e instanceof DomainApiError) {
          throw Errors.upstreamFailed('domain.providerUnavailable')
        }
        throw e
      }

      return tx(req.pool, req, async client => {
        const fertig = stand.verified && stand.authenticated
        const { rows } = await client.query(
          `UPDATE property_email_domain
              SET verified = $2, authenticated = $3, dns_records = $4::jsonb,
                  checked_at = now(), updated_at = now(),
                  status = CASE WHEN $5 THEN 'active' ELSE status END
            WHERE property_id = $1
            RETURNING status, verified, authenticated,
                      dns_records AS "dnsRecords", checked_at AS "checkedAt"`,
          [Number(propertyId), stand.verified, stand.authenticated,
           JSON.stringify(stand.records), fertig])
        return rows[0]
      })
    }
  })

  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/email-domain',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Absenderdomain zuruecknehmen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        /*
         * Der Versand geht mit. Eine Domain zurueckzunehmen und den Versand
         * eingeschaltet zu lassen, hiesse: ab jetzt scheitert jede Rechnung
         * beim Einreihen, und zwar mit einer Meldung ueber eine Domain, die
         * niemand mehr sucht.
         *
         * Die Zeile beim Anbieter bleibt zunaechst stehen. Sie dort zu
         * entfernen ist Aufraeumen und gehoert nicht an eine Route, die ein
         * Mensch aus Versehen zweimal drueckt.
         */
        await client.query(
          `UPDATE property_email_setting SET enabled = false, updated_at = now()
            WHERE property_id = $1`, [Number(propertyId)])
        const r = await client.query(
          `DELETE FROM property_email_domain WHERE property_id = $1`,
          [Number(propertyId)])
        if (r.rowCount === 0) throw Errors.notFound('domain.notRequested')
        return { propertyId: Number(propertyId), status: null }
      })
    }
  })
}
