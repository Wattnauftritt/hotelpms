import { createHmac } from 'node:crypto'

/**
 * Ereignisarten und Signatur ausgehender Ereignisse (Aufgabe 4, Dokument 16).
 *
 * Liegt in der Domaene, weil beide Seiten sie brauchen: die API reiht
 * Ereignisse ein, der Worker stellt sie zu, und beide muessen sich ueber die
 * Namen und ueber das Signaturverfahren einig sein.
 */

export const WEBHOOK_EVENT_TYPES = [
  'reservation.created',
  'reservation.changed',
  'reservation.canceled',
  'reservation.checked_in',
  'reservation.checked_out',
  'invoice.finalized'
] as const

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]

export function isWebhookEventType(v: string): v is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v)
}

/** Kopfzeilen, unter denen Kennung, Art, Zeitstempel und Signatur reisen. */
export const WEBHOOK_HEADERS = {
  event: 'x-hotelpms-event',
  delivery: 'x-hotelpms-event-id',
  timestamp: 'x-hotelpms-timestamp',
  signature: 'x-hotelpms-signature'
} as const

/**
 * HMAC-SHA256 ueber `Zeitstempel.Rumpf`, nicht ueber den Rumpf allein.
 *
 * Der Zeitstempel steht deshalb **innerhalb** des signierten Textes: stuende
 * er nur in der Kopfzeile, koennte ein Mitschneider ihn auf jetzt setzen und
 * eine alte Zustellung erneut einspielen, ohne die Signatur zu brechen. So
 * bricht jede Aenderung an ihm die Signatur, und der Empfaenger kann
 * gefahrlos alles verwerfen, was aelter ist als sein Toleranzfenster.
 */
export function webhookSignature(
  secret: string, timestampSeconds: number, body: string
): string {
  return 'v1=' + createHmac('sha256', secret)
    .update(`${timestampSeconds}.${body}`)
    .digest('hex')
}

/**
 * Anzahl der Zustellversuche, bis ein Abonnement stillgelegt wird.
 *
 * Bewusst klein: ein Empfaenger, der dreimal mit wachsendem Abstand nicht
 * antwortet, ist nicht ueberlastet, sondern kaputt oder abgeschaltet. Weiter
 * zuzustellen hiesse, eine wachsende Warteschlange gegen eine Wand zu
 * fahren; der Betreiber des Abonnements soll es merken.
 */
export const WEBHOOK_MAX_ATTEMPTS = 3

/**
 * Abstand bis zur naechsten Wiederholung, exponentiell wachsend.
 * `attempts` ist die Zahl der bereits unternommenen Versuche.
 */
export function webhookRetryDelaySeconds(attempts: number, baseSeconds = 60): number {
  return baseSeconds * 2 ** Math.max(0, attempts - 1)
}

/** Antwortet der Empfaenger so, gilt die Zustellung als angekommen. */
export function webhookDelivered(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300
}
