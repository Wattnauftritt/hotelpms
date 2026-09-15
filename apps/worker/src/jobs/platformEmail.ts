import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { EMAIL_MAX_ATTEMPTS, emailRetryDelaySeconds, emailShouldRetry } from '@hotelpms/domain'
import { EmailSendError, type EmailAdapter, type EmailAddress } from '../email/brevo.js'

/**
 * Zustellung der Zugangspost (Einladung, Kennwortruecksetzung).
 *
 * Derselbe Dreischritt wie bei der Gastpost -- beanspruchen, versenden,
 * vermerken -- und aus demselben Grund: der Netzaufruf darf nicht in der
 * Transaktion liegen, die die Zeile sperrt. Drei Dinge sind anders, und
 * jedes davon folgt daraus, dass hier kein Gast, sondern ein Benutzer am
 * anderen Ende steht:
 *
 * **Kein Haus.** Der Absender kommt aus der Umgebung, nicht aus
 * `property_email_setting`. Ein Benutzer kann in mehreren Haeusern arbeiten
 * oder, beim Onboarding, noch in keinem; und ein Haus, das den Gastversand
 * nie eingeschaltet hat, darf seinen Leuten trotzdem Zugang geben.
 *
 * **Kein Anhang.** Was hier hinausgeht, ist ein Link und drei Saetze.
 *
 * **Der Rumpf wird nach dem Versand geloescht.** Das ist der eigentliche
 * Punkt dieser Datei. In `auth_token` steht bewusst nur der Hash des Tokens,
 * damit ein Datenbankauszug keinen Zugang verschafft -- im Rumpf der
 * Nachricht steht es im Klartext. Bliebe er stehen, waere die Vorsicht
 * nebenan wertlos, und zwar fuer die volle Frist des Tokens. Er bleibt
 * deshalb nur so lange, wie die Nachricht in der Warteschlange wartet.
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
}

interface AttemptResult {
  statusCode: number | null
  providerMessageId: string | null
  error: string | null
}

export interface PlatformEmailResult {
  attempted: number
  sent: number
  /** Fehlgeschlagen, aber es steht noch ein Versuch aus. */
  retrying: number
  /** Endgueltig aufgegeben, weil dauerhaft abgelehnt oder Versuche verbraucht. */
  failed: number
}

type Ausgang = 'sent' | 'retrying' | 'failed'

export interface PlatformEmailOptions {
  batchSize?: number
  leaseSeconds?: number
  baseDelaySeconds?: number
}

/** Absender der Plattform. Ohne ihn wird nichts verschickt (siehe worker.ts). */
export interface PlatformSender {
  from: EmailAddress
  /** Wohin eine Antwort geht. Ein Mensch antwortet auf so eine Mail. */
  replyTo?: EmailAddress | null
}

async function claim(
  client: PoolClient, batchSize: number, leaseSeconds: number
): Promise<ClaimedEmail[]> {
  /*
   * Der Versuchszaehler steigt beim Beanspruchen, nicht beim Vermerken: unter
   * der Sperre ist die Nummer eindeutig vergeben, und ein Versuch, dessen
   * Ergebnis ein Absturz verschluckt, zaehlt trotzdem -- abgeschickt wurde er
   * ja moeglicherweise.
   */
  const { rows } = await client.query<ClaimedEmail>(
    `WITH faellig AS (
       SELECT e.id
         FROM platform_email e
        WHERE e.status = 'pending'
          AND e.next_attempt_at <= now()
        ORDER BY e.id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE platform_email e
        SET attempts = e.attempts + 1,
            next_attempt_at = now() + make_interval(secs => $2)
      WHERE e.id IN (SELECT id FROM faellig)
     RETURNING e.id, e.public_ref, e.kind, e.to_email, e.to_name, e.subject,
               e.body_text, e.body_html, e.attempts AS attempt`,
    [batchSize, leaseSeconds])
  return rows
}

async function send(
  adapter: EmailAdapter, sender: PlatformSender, e: ClaimedEmail
): Promise<AttemptResult> {
  try {
    const r = await adapter.send({
      from: sender.from,
      to: { email: e.to_email, name: e.to_name },
      replyTo: sender.replyTo ?? null,
      subject: e.subject,
      text: e.body_text,
      html: e.body_html,
      attachments: []
    })
    return { statusCode: r.statusCode, providerMessageId: r.providerMessageId, error: null }
  } catch (err) {
    const se = err instanceof EmailSendError
      ? err
      : new EmailSendError(null, (err as Error).message.slice(0, 500))
    return {
      statusCode: se.statusCode,
      providerMessageId: null,
      error: se.message.slice(0, 1000)
    }
  }
}

async function record(
  client: PoolClient, e: ClaimedEmail, r: AttemptResult, baseDelaySeconds: number
): Promise<Ausgang> {
  if (r.error === null) {
    // Rumpf weg, Zeile bleibt: die Frage "ist die Einladung rausgegangen"
    // kommt noch Wochen spaeter und laesst sich ohne das Token beantworten.
    await client.query(
      `UPDATE platform_email
          SET status = 'sent', sent_at = now(), provider_message_id = $2,
              body_text = '', body_html = NULL, last_error = NULL
        WHERE id = $1`,
      [e.id, r.providerMessageId])
    return 'sent'
  }

  // Aufgegeben wird aus zwei Gruenden, und sie sind verschieden: die Versuche
  // sind verbraucht, oder ein weiterer Versuch waere sinnlos.
  const aufgeben = e.attempt >= EMAIL_MAX_ATTEMPTS || !emailShouldRetry(r.statusCode)

  /*
   * Auch beim endgueltigen Scheitern faellt der Rumpf weg. Das Token darin
   * hat dann niemanden erreicht und ist wertlos -- es liegenzulassen hiesse,
   * einen ungenutzten Zugang aufzubewahren, und zwar genau in den Faellen,
   * die ohnehin schon schiefgelaufen sind.
   */
  await client.query(
    `UPDATE platform_email
        SET status = CASE WHEN $3 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = CASE WHEN $3 THEN now()
                                   ELSE now() + make_interval(secs => $4) END,
            body_text = CASE WHEN $3 THEN '' ELSE body_text END,
            body_html = CASE WHEN $3 THEN NULL ELSE body_html END,
            last_error = $2
      WHERE id = $1`,
    [e.id, r.error, aufgeben, emailRetryDelaySeconds(e.attempt, baseDelaySeconds)])

  return aufgeben ? 'failed' : 'retrying'
}

export async function deliverPlatformEmails(
  pool: Pool, ctx: DbContext, adapter: EmailAdapter, sender: PlatformSender,
  opts: PlatformEmailOptions = {}
): Promise<PlatformEmailResult> {
  const batchSize = opts.batchSize ?? 25
  const leaseSeconds = opts.leaseSeconds ?? 300
  const baseDelaySeconds = opts.baseDelaySeconds ?? 120

  const claimed = await withTransaction(pool, ctx, c => claim(c, batchSize, leaseSeconds))
  const result: PlatformEmailResult = {
    attempted: claimed.length, sent: 0, retrying: 0, failed: 0 }

  for (const e of claimed) {
    const versuch = await send(adapter, sender, e)
    const ausgang = await withTransaction(pool, ctx, c =>
      record(c, e, versuch, baseDelaySeconds))
    result[ausgang]++
  }
  return result
}
