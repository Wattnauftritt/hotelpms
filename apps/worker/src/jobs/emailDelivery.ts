import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { EMAIL_MAX_ATTEMPTS, emailRetryDelaySeconds, emailShouldRetry } from '@hotelpms/domain'
import { EmailSendError, type EmailAdapter, type EmailAttachment } from '../email/brevo.js'

/**
 * Zustellung ausgehender Gastpost (Brevo).
 *
 * Derselbe Dreischritt wie bei den Webhooks, und aus demselben Grund: der
 * Netzaufruf darf nicht in der Transaktion liegen, die die Zeile sperrt.
 *
 *   1. beanspruchen   Transaktion, Sperre, Versuchszaehler hoch, Frist setzen
 *   2. versenden      ohne Transaktion, ueber die API des Anbieters
 *   3. vermerken      Transaktion, Ergebnis und Versuchsprotokoll
 *
 * Zwei Dinge sind hier anders als beim Webhook, und beide folgen daraus,
 * dass am anderen Ende ein Mensch sitzt:
 *
 * **Ein dauerhafter Fehler wird nicht wiederholt.** Eine abgelehnte Adresse
 * ist beim fuenften Versuch genauso abgelehnt wie beim ersten;
 * `emailShouldRetry` trennt das vom ueberlasteten Anbieter.
 *
 * **Ein Abonnement wird nie stillgelegt.** Beim Webhook ist das richtig --
 * dort steht eine kaputte Gegenstelle. Hier wuerde es bedeuten, dass eine
 * einzige falsch getippte Gastadresse den Rechnungsversand des ganzen
 * Hauses anhaelt. Die einzelne Nachricht scheitert, das Haus versendet
 * weiter.
 */

interface ClaimedEmail {
  id: number
  public_ref: string
  kind: string
  to_email: string
  to_name: string | null
  subject: string
  body_text: string
  body_html: string | null
  attempt: number
  from_name: string
  from_email: string
  reply_to: string | null
  bcc_email: string | null
  invoice_number: string | null
  attachment: Buffer | null
  attachment_sha256: string | null
}

interface AttemptResult {
  statusCode: number | null
  providerMessageId: string | null
  error: string | null
  durationMs: number
}

export interface EmailDeliveryResult {
  attempted: number
  sent: number
  /** Fehlgeschlagen, aber es steht noch ein Versuch aus. */
  retrying: number
  /** Endgueltig aufgegeben, weil dauerhaft abgelehnt oder Versuche verbraucht. */
  failed: number
}

type Ausgang = 'sent' | 'retrying' | 'failed'

export interface EmailDeliveryOptions {
  batchSize?: number
  leaseSeconds?: number
  baseDelaySeconds?: number
}

async function claim(
  client: PoolClient, propertyId: number, batchSize: number, leaseSeconds: number
): Promise<ClaimedEmail[]> {
  /*
   * Die Bedingung auf den Anhang ist der eigentliche Kniff dieser Abfrage.
   *
   * Eine Rechnungsmail darf eingereiht werden, bevor der Beleg existiert --
   * das PDF entsteht erst im naechsten Lauf von `invoiceDocument`, und
   * darauf in der Routentransaktion zu warten hiesse, den Check-out
   * anzuhalten. Geholt wird sie deshalb erst, wenn der Anhang bereitsteht.
   *
   * Das ist bewusst keine Wiederholung mit verbrauchtem Versuch: die
   * Nachricht ist nicht fehlgeschlagen, sie ist noch nicht dran. Wer sie
   * trotzdem holte und am fehlenden Anhang scheitern liesse, haette nach
   * fuenf Minuten eine Rechnung ohne Anhang aufgegeben, deren Beleg
   * inzwischen fertig ist.
   *
   * Der Versuchszaehler steigt beim Beanspruchen, nicht beim Vermerken:
   * unter der Sperre ist die Nummer eindeutig vergeben, und ein Versuch,
   * dessen Ergebnis ein Absturz verschluckt, zaehlt trotzdem -- abgeschickt
   * wurde er ja moeglicherweise. Zugestellt wird damit mindestens einmal.
   */
  const { rows } = await client.query<ClaimedEmail>(
    `WITH faellig AS (
       SELECT e.id
         FROM outbound_email e
         JOIN property_email_setting s
           ON s.property_id = e.property_id AND s.enabled
        WHERE e.property_id = $1
          AND e.status = 'pending'
          AND e.next_attempt_at <= now()
          AND (e.invoice_id IS NULL
               OR EXISTS (SELECT 1 FROM invoice_document d WHERE d.invoice_id = e.invoice_id))
        ORDER BY e.id
        LIMIT $2
        FOR UPDATE OF e SKIP LOCKED
     ), beansprucht AS (
       UPDATE outbound_email e
          SET attempts = e.attempts + 1,
              next_attempt_at = now() + make_interval(secs => $3)
        WHERE e.id IN (SELECT id FROM faellig)
       RETURNING e.id, e.public_ref, e.kind, e.to_email, e.to_name, e.subject,
                 e.body_text, e.body_html, e.attempts AS attempt,
                 e.property_id, e.invoice_id
     )
     SELECT b.id, b.public_ref, b.kind, b.to_email, b.to_name, b.subject,
            b.body_text, b.body_html, b.attempt,
            s.from_name, s.from_email, s.reply_to, s.bcc_email,
            i.number AS invoice_number,
            d.pdf    AS attachment,
            d.sha256 AS attachment_sha256
       FROM beansprucht b
       JOIN property_email_setting s ON s.property_id = b.property_id
       LEFT JOIN invoice i          ON i.id = b.invoice_id
       LEFT JOIN invoice_document d ON d.invoice_id = b.invoice_id
      ORDER BY b.id`,
    [propertyId, batchSize, leaseSeconds])
  return rows
}

/** Dateiname im Postfach des Gastes. Die Rechnungsnummer, nicht die id. */
function attachments(e: ClaimedEmail): EmailAttachment[] {
  if (e.attachment === null) return []
  const name = e.invoice_number
    ? `Rechnung-${e.invoice_number.replace(/[^\w.-]/g, '-')}.pdf`
    : `Rechnung-${e.public_ref}.pdf`
  return [{ name, content: e.attachment }]
}

async function send(adapter: EmailAdapter, e: ClaimedEmail): Promise<AttemptResult> {
  const begonnen = Date.now()
  try {
    const r = await adapter.send({
      from: { email: e.from_email, name: e.from_name },
      to: { email: e.to_email, name: e.to_name },
      replyTo: e.reply_to ? { email: e.reply_to } : null,
      bcc: e.bcc_email ? { email: e.bcc_email } : null,
      subject: e.subject,
      text: e.body_text,
      html: e.body_html,
      attachments: attachments(e)
    })
    return {
      statusCode: r.statusCode,
      providerMessageId: r.providerMessageId,
      error: null,
      durationMs: Date.now() - begonnen
    }
  } catch (err) {
    const se = err instanceof EmailSendError
      ? err
      : new EmailSendError(null, (err as Error).message.slice(0, 500))
    return {
      statusCode: se.statusCode,
      providerMessageId: null,
      error: se.message.slice(0, 1000),
      durationMs: Date.now() - begonnen
    }
  }
}

async function record(
  client: PoolClient, propertyId: number,
  e: ClaimedEmail, r: AttemptResult, baseDelaySeconds: number
): Promise<Ausgang> {
  await client.query(
    `INSERT INTO outbound_email_attempt
       (email_id, property_id, attempt, status_code, error, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.id, propertyId, e.attempt, r.statusCode, r.error, r.durationMs])

  if (r.error === null) {
    await client.query(
      `UPDATE outbound_email
          SET status = 'sent', sent_at = now(), provider_message_id = $2,
              attachment_sha256 = $3, last_error = NULL
        WHERE id = $1`,
      [e.id, r.providerMessageId, e.attachment_sha256])
    return 'sent'
  }

  // Aufgegeben wird aus zwei Gruenden, und sie sind verschieden: die
  // Versuche sind verbraucht, oder ein weiterer Versuch waere sinnlos.
  const aufgeben = e.attempt >= EMAIL_MAX_ATTEMPTS || !emailShouldRetry(r.statusCode)

  // Der Statuscode steht im Versuchsprotokoll, nicht noch einmal an der
  // Zeile: ihn hier als Parameter mitzufuehren, ohne ihn zu benutzen, kostet
  // eine Fehlermeldung ueber einen Parameter unbekannten Typs.
  await client.query(
    `UPDATE outbound_email
        SET status = CASE WHEN $3 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = CASE WHEN $3 THEN now()
                                   ELSE now() + make_interval(secs => $4) END,
            last_error = $2
      WHERE id = $1`,
    [e.id, r.error, aufgeben, emailRetryDelaySeconds(e.attempt, baseDelaySeconds)])

  return aufgeben ? 'failed' : 'retrying'
}

export async function deliverEmails(
  pool: Pool, ctx: DbContext, propertyId: number,
  adapter: EmailAdapter, opts: EmailDeliveryOptions = {}
): Promise<EmailDeliveryResult> {
  const batchSize = opts.batchSize ?? 25
  const leaseSeconds = opts.leaseSeconds ?? 300
  const baseDelaySeconds = opts.baseDelaySeconds ?? 120

  const claimed = await withTransaction(pool, ctx, c =>
    claim(c, propertyId, batchSize, leaseSeconds))
  const result: EmailDeliveryResult = {
    attempted: claimed.length, sent: 0, retrying: 0, failed: 0 }

  for (const e of claimed) {
    const versuch = await send(adapter, e)
    const ausgang = await withTransaction(pool, ctx, c =>
      record(c, propertyId, e, versuch, baseDelaySeconds))
    result[ausgang]++
  }
  return result
}
