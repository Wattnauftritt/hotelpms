import { withTransaction, type Pool, type DbContext } from '@hotelpms/db'
import { EmailSendError, type DeliveryEvent, type DeliveryLookup } from '../email/brevo.js'
import type { TickBreaker } from './breaker.js'

/**
 * Was aus einer angenommenen Gastmail wurde (Migration 0187).
 *
 * `status = 'sent'` heisst: Brevo hat die Nachricht angenommen. Ob der
 * Server des Empfaengers sie nahm, steht erst danach fest, und genau das ist
 * die Frage, wenn ein Gast sagt, er habe nichts bekommen -- oder wenn bei
 * Booking.com kein einziges Meldeformular im Verlauf auftaucht, waehrend
 * StayGrid "Link verschickt" zeigt (19.10.2026).
 *
 * **Nachfragen in wachsenden Abstaenden.** Die meisten Mails sind nach
 * Sekunden zugestellt; eine verzoegerte versucht der Anbieter ueber Stunden
 * weiter. Danach wird nicht mehr gefragt -- der letzte Stand bleibt stehen.
 *
 * **Endgueltig heisst endgueltig.** Zugestellt, abgewiesen, ungueltig,
 * blockiert, Spam oder Fehler: dann ist nichts mehr nachzufragen. Eine
 * Spam-Meldung nach der Zustellung faengt nur, wer noch fragt; das ist der
 * Preis dafuer, keinen Webhook zu betreiben.
 *
 * Derselbe Dreischritt wie beim Versand: beanspruchen in einer Transaktion,
 * nachfragen ohne, vermerken in einer neuen.
 */

export type DeliveryStatus = 'accepted' | 'delivered' | 'deferred' | 'soft_bounce'
  | 'hard_bounce' | 'invalid' | 'blocked' | 'spam' | 'error'

/** Abstand vor der n-ten Nachfrage (ab 0), in Sekunden. Danach ist Schluss. */
export const DELIVERY_CHECK_DELAYS = [120, 600, 3600, 6 * 3600, 24 * 3600] as const

const ENDGUELTIG: ReadonlySet<DeliveryStatus> = new Set(
  ['delivered', 'hard_bounce', 'invalid', 'blocked', 'spam', 'error'])

/*
 * Rangfolge, wenn mehrere Ereignisse vorliegen. Ein Fehlschlag schlaegt die
 * Zustellung nicht -- beides zugleich gibt es nur bei der Spam-Meldung, und
 * die ist die spaetere, wichtigere Nachricht. Zustellung schlaegt eine
 * fruehere Verzoegerung.
 */
const RANG: Record<DeliveryStatus, number> = {
  accepted: 0, deferred: 1, soft_bounce: 2, delivered: 3,
  error: 4, invalid: 5, blocked: 6, hard_bounce: 7, spam: 8
}

/**
 * Brevo nennt dieselben Ereignisse je nach Schnittstelle verschieden
 * (`hardBounces`, `hard_bounce`, `hardBounce`). Verglichen wird deshalb
 * ohne Gross/klein und Trennzeichen. Gelesen, geklickt und vom Proxy
 * geladen heisst: angekommen.
 */
export function deliveryStatusOf(event: string): DeliveryStatus | null {
  const e = event.toLowerCase().replace(/[^a-z]/g, '')
  switch (e) {
    case 'request': case 'requests': case 'sent': return 'accepted'
    case 'delivered': case 'opened': case 'uniqueopened': case 'clicks': case 'click':
    case 'loadedbyproxy': case 'proxyopen': case 'uniqueproxyopen': return 'delivered'
    case 'deferred': return 'deferred'
    case 'softbounce': case 'softbounces': return 'soft_bounce'
    case 'hardbounce': case 'hardbounces': case 'bounce': case 'bounces': return 'hard_bounce'
    case 'invalid': case 'invalidemail': return 'invalid'
    case 'blocked': return 'blocked'
    case 'spam': case 'complaint': return 'spam'
    case 'error': return 'error'
    default: return null
  }
}

/**
 * Ein Abweisungsgrund nennt oft die Empfaengeradresse. Sie wird ersetzt,
 * bevor er geschrieben wird: so ist die Spalte kein Gastdatum, und weder
 * Loeschung noch Schwaerzung muessen sie kennen (Migration 0187).
 */
export function scrubReason(reason: string | null): string | null {
  if (reason === null) return null
  const t = reason.replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, '…@…').trim()
  return t === '' ? null : t.slice(0, 500)
}

export interface DeliveryVerdict {
  status: DeliveryStatus
  reason: string | null
  at: string | null
}

/** Der massgebliche Stand aus allen Ereignissen einer Nachricht. */
export function deliveryVerdict(events: DeliveryEvent[]): DeliveryVerdict | null {
  let best: DeliveryVerdict | null = null
  for (const e of events) {
    const status = deliveryStatusOf(e.event)
    if (status === null) continue
    if (best === null || RANG[status] > RANG[best.status]
        || (RANG[status] === RANG[best.status] && (e.date ?? '') > (best.at ?? ''))) {
      best = { status, reason: scrubReason(e.reason), at: e.date }
    }
  }
  return best
}

export interface DeliveryStatusOptions {
  batchSize?: number
  leaseSeconds?: number
  breaker?: TickBreaker
}

export interface DeliveryStatusResult {
  checked: number
  /** Endgueltig nicht angekommen: abgewiesen, ungueltig, blockiert, Spam, Fehler. */
  undelivered: number
}

interface Faellig { id: number; provider_message_id: string; delivery_checks: number }

export async function checkEmailDeliveries(
  pool: Pool, ctx: DbContext, propertyId: number,
  lookup: DeliveryLookup, opts: DeliveryStatusOptions = {}
): Promise<DeliveryStatusResult> {
  const result: DeliveryStatusResult = { checked: 0, undelivered: 0 }
  const breaker = opts.breaker
  if (breaker?.tripped() === true) return result

  const faellig = await withTransaction(pool, ctx, async c => (await c.query<Faellig>(
    `WITH f AS (
       SELECT e.id FROM outbound_email e
        WHERE e.property_id = $1
          AND e.delivery_next_check_at <= now()
          AND e.provider_message_id IS NOT NULL
        ORDER BY e.delivery_next_check_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE outbound_email e
        SET delivery_next_check_at = now() + make_interval(secs => $3)
      WHERE e.id IN (SELECT id FROM f)
     RETURNING e.id, e.provider_message_id, e.delivery_checks`,
    [propertyId, opts.batchSize ?? 50, opts.leaseSeconds ?? 300])).rows)

  for (const m of faellig) {
    if (breaker?.tripped() === true) break
    let events: DeliveryEvent[]
    try {
      events = await lookup.events(m.provider_message_id)
      breaker?.success()
    } catch (e) {
      // Ein Ausfall beim Anbieter verbraucht keine Nachfrage: die Frist aus
      // dem Beanspruchen holt die Zeile beim naechsten Tick wieder.
      const code = e instanceof EmailSendError ? e.statusCode : null
      if (code === null || code >= 500 || code === 429) breaker?.failure()
      continue
    }

    const urteil = deliveryVerdict(events)
    const checks = m.delivery_checks + 1
    const fertig = urteil !== null && ENDGUELTIG.has(urteil.status)
    const naechste = fertig || checks >= DELIVERY_CHECK_DELAYS.length
      ? null : DELIVERY_CHECK_DELAYS[checks]!
    await withTransaction(pool, ctx, c => c.query(
      `UPDATE outbound_email
          SET delivery_status = COALESCE($2, delivery_status),
              delivery_reason = CASE WHEN $2::text IS NULL THEN delivery_reason ELSE $3 END,
              delivery_event_at = CASE WHEN $2::text IS NULL THEN delivery_event_at
                                       ELSE $4::timestamptz END,
              delivery_checks = $5,
              delivery_next_check_at = CASE WHEN $6::int IS NULL THEN NULL
                                            ELSE now() + make_interval(secs => $6::int) END
        WHERE id = $1`,
      [m.id, urteil?.status ?? null, urteil?.reason ?? null,
       urteil?.at && !Number.isNaN(Date.parse(urteil.at)) ? urteil.at : null,
       checks, naechste]))
    result.checked++
    if (fertig && urteil.status !== 'delivered') result.undelivered++
  }
  return result
}
