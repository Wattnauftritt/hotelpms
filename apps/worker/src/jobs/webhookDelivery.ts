import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { webhookSignature, webhookDelivered, webhookRetryDelaySeconds,
         WEBHOOK_MAX_ATTEMPTS, WEBHOOK_HEADERS } from '@hotelpms/domain'

/**
 * Zustellung ausgehender Ereignisse (Aufgabe 4, Dokument 16).
 *
 * Laeuft je Property im Kontext genau dieser Property, wie der Nachtlauf und
 * aus demselben Grund: ohne BYPASSRLS schraenkt die Zeilenrichtlinie auch den
 * Worker ein, und ein Programmfehler hier kann keine fremden Mandanten
 * beruehren.
 *
 * Drei Schritte, und die Aufteilung hat einen Grund: der Netzaufruf darf
 * nicht in der Transaktion liegen, die die Zeile sperrt. Ein Empfaenger, der
 * zehn Sekunden braucht, haelt sonst eine Sperre zehn Sekunden.
 *
 *   1. beanspruchen   Transaktion, Sperre, Versuchszaehler hoch, Frist setzen
 *   2. zustellen      ohne Transaktion, ueber HTTP
 *   3. vermerken      Transaktion, Ergebnis und Versuchsprotokoll
 *
 * Die Frist aus Schritt 1 ist der Grund, warum ein Absturz zwischen 2 und 3
 * nicht zum Stillstand fuehrt: nach ihrem Ablauf ist die Zustellung wieder
 * faellig. Zugestellt wird damit mindestens einmal, nicht genau einmal --
 * deshalb traegt jedes Ereignis eine Kennung, an der der Empfaenger eine
 * Wiederholung erkennt.
 */

interface ClaimedDelivery {
  id: number
  subscription_id: number
  event_type: string
  event_ref: string
  payload: unknown
  attempt: number
  url: string
  signing_secret: string
}

interface AttemptResult {
  statusCode: number | null
  error: string | null
  durationMs: number
}

export interface WebhookDeliveryResult {
  attempted: number
  delivered: number
  /** Fehlgeschlagen, aber es steht noch ein Versuch aus. */
  retrying: number
  /** Endgueltig aufgegeben. */
  failed: number
  /** Abonnements, die dieser Lauf stillgelegt hat. */
  disabled: number
}

type Ausgang = 'delivered' | 'retrying' | 'failed'

export interface WebhookDeliveryOptions {
  batchSize?: number
  /** Wie lange eine beanspruchte Zustellung fuer andere gesperrt bleibt. */
  leaseSeconds?: number
  requestTimeoutMs?: number
  /** Grundabstand der Wiederholung, der sich mit jedem Versuch verdoppelt. */
  baseDelaySeconds?: number
}

async function claim(
  client: PoolClient, propertyId: number, batchSize: number, leaseSeconds: number
): Promise<ClaimedDelivery[]> {
  /*
   * Der Versuchszaehler steigt hier, nicht erst beim Vermerken. Unter der
   * Zeilensperre ist die Nummer damit eindeutig vergeben, und ein Versuch,
   * dessen Ergebnis durch einen Absturz verloren geht, zaehlt trotzdem --
   * abgeschickt wurde er ja moeglicherweise.
   */
  const { rows } = await client.query<ClaimedDelivery>(
    `WITH faellig AS (
       SELECT d.id
         FROM webhook_delivery d
         JOIN webhook_subscription s ON s.id = d.subscription_id AND s.status = 'active'
        WHERE d.property_id = $1 AND d.status = 'pending' AND d.next_attempt_at <= now()
        ORDER BY d.id
        LIMIT $2
        FOR UPDATE OF d SKIP LOCKED
     ), beansprucht AS (
       UPDATE webhook_delivery d
          SET attempts = d.attempts + 1,
              next_attempt_at = now() + make_interval(secs => $3)
        WHERE d.id IN (SELECT id FROM faellig)
       RETURNING d.id, d.subscription_id, d.event_type, d.event_ref,
                 d.payload, d.attempts AS attempt
     )
     SELECT b.*, s.url, s.signing_secret
       FROM beansprucht b
       JOIN webhook_subscription s ON s.id = b.subscription_id
      ORDER BY b.id`,
    [propertyId, batchSize, leaseSeconds])
  return rows
}

async function send(d: ClaimedDelivery, timeoutMs: number): Promise<AttemptResult> {
  const body = JSON.stringify(d.payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const begonnen = Date.now()
  try {
    const res = await fetch(d.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_HEADERS.event]: d.event_type,
        [WEBHOOK_HEADERS.delivery]: d.event_ref,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: webhookSignature(d.signing_secret, timestamp, body)
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
    return {
      statusCode: res.status,
      error: webhookDelivered(res.status) ? null : `HTTP ${res.status}`,
      durationMs: Date.now() - begonnen
    }
  } catch (e) {
    // Zeitueberschreitung, Namensaufloesung, abgelehnte Verbindung: aus Sicht
    // der Wiederholung dasselbe wie eine 500.
    return {
      statusCode: null,
      error: (e as Error).message.slice(0, 500),
      durationMs: Date.now() - begonnen
    }
  }
}

async function record(
  client: PoolClient, propertyId: number,
  d: ClaimedDelivery, r: AttemptResult, baseDelaySeconds: number
): Promise<{ ausgang: Ausgang; stillgelegt: boolean }> {
  await client.query(
    `INSERT INTO webhook_delivery_attempt
       (delivery_id, property_id, attempt, status_code, error, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [d.id, propertyId, d.attempt, r.statusCode, r.error, r.durationMs])

  if (r.statusCode !== null && webhookDelivered(r.statusCode)) {
    await client.query(
      `UPDATE webhook_delivery
          SET status = 'delivered', delivered_at = now(),
              last_status_code = $2, last_error = NULL
        WHERE id = $1`, [d.id, r.statusCode])
    return { ausgang: 'delivered', stillgelegt: false }
  }

  const erschoepft = d.attempt >= WEBHOOK_MAX_ATTEMPTS
  // Ist der letzte Versuch verbraucht, steht keine Wiederholung mehr an. Die
  // Frist aus dem Beanspruchen stehen zu lassen, zeigte im Protokoll einen
  // Termin an, den niemand wahrnimmt.
  await client.query(
    `UPDATE webhook_delivery
        SET status = CASE WHEN $4 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = CASE WHEN $4 THEN now()
                                   ELSE now() + make_interval(secs => $5) END,
            last_status_code = $2, last_error = $3
      WHERE id = $1`,
    [d.id, r.statusCode, r.error, erschoepft,
     webhookRetryDelaySeconds(d.attempt, baseDelaySeconds)])

  if (!erschoepft) return { ausgang: 'retrying', stillgelegt: false }

  /*
   * Stilllegung. Ein Empfaenger, der auch nach der letzten Wiederholung nicht
   * annimmt, ist nicht ueberlastet, sondern kaputt oder abgeschaltet. Weiter
   * zuzustellen hiesse, eine wachsende Warteschlange gegen eine Wand zu
   * fahren; der Grund steht an der Zeile, damit die Frage "warum kommt nichts
   * mehr an" ohne Protokollsuche zu beantworten ist.
   */
  const stillgelegt = await client.query(
    `UPDATE webhook_subscription
        SET status = 'disabled', disabled_at = now(), disabled_reason = $2
      WHERE id = $1 AND status = 'active'`,
    [d.subscription_id,
     `Zustellung ${d.event_ref} nach ${d.attempt} Versuchen aufgegeben: ${r.error}`])
  // Hat eine andere Zustellung desselben Abonnements es schon stillgelegt,
  // aendert das hier nichts mehr und soll auch nicht noch einmal zaehlen.
  return { ausgang: 'failed', stillgelegt: stillgelegt.rowCount === 1 }
}

export async function deliverWebhooks(
  pool: Pool, ctx: DbContext, propertyId: number, opts: WebhookDeliveryOptions = {}
): Promise<WebhookDeliveryResult> {
  const batchSize = opts.batchSize ?? 50
  const leaseSeconds = opts.leaseSeconds ?? 300
  const timeoutMs = opts.requestTimeoutMs ?? 10_000
  const baseDelaySeconds = opts.baseDelaySeconds ?? 60

  const claimed = await withTransaction(pool, ctx, c =>
    claim(c, propertyId, batchSize, leaseSeconds))
  const result: WebhookDeliveryResult = {
    attempted: claimed.length, delivered: 0, retrying: 0, failed: 0, disabled: 0 }

  for (const d of claimed) {
    const versuch = await send(d, timeoutMs)
    const { ausgang, stillgelegt } = await withTransaction(pool, ctx, c =>
      record(c, propertyId, d, versuch, baseDelaySeconds))
    result[ausgang]++
    if (stillgelegt) result.disabled++
  }
  return result
}
