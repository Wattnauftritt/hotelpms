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

/**
 * Warum eine Zustellung gescheitert ist -- als Art, nicht als Fehlertext.
 *
 * Bisher stand im Protokoll die Meldung von Node, und `GET
 * /v1/webhook-subscriptions/:ref/deliveries` gab sie heraus. Aus
 * `ECONNREFUSED 10.0.0.5:6379` gegen eine Zeitueberschreitung gegen
 * `HTTP 401` laesst sich ablesen, welcher Dienst an welcher inneren Adresse
 * horcht -- ein Portscan mit unserer Hilfe (Befund B1). Die Art sagt dem
 * Betreiber eines echten Empfaengers alles, was er zum Suchen braucht, und
 * verraet nichts darueber hinaus.
 */
export const WEBHOOK_FAILURE_KINDS = [
  'timeout', 'dns', 'refused', 'unreachable', 'reset', 'tls',
  'blockedTarget', 'httpStatus', 'other'
] as const

export type WebhookFailureKind = (typeof WEBHOOK_FAILURE_KINDS)[number]

export function isWebhookFailureKind(v: string): v is WebhookFailureKind {
  return (WEBHOOK_FAILURE_KINDS as readonly string[]).includes(v)
}

/**
 * Ordnet einen Fehler des Netzstapels einer Art zu.
 *
 * Gelesen wird `code`, nicht der Text: die Codes sind Teil der Node-API und
 * bleiben, die Saetze daneben aendern sich mit der Laufzeitversion.
 */
export function classifyDeliveryError(e: unknown): WebhookFailureKind {
  const code = String((e as { code?: unknown } | null)?.code
    ?? (e as { name?: unknown } | null)?.name ?? '')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN'
      || code === 'ENETDOWN') return 'unreachable'
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'TimeoutError'
      || code === 'ABORT_ERR' || code === 'AbortError') return 'timeout'
  // Alles aus dem TLS-Stapel traegt entweder ein ERR_TLS_-Praefix oder einen
  // der Zertifikatscodes von OpenSSL; die sind zahlreich, aber durchgaengig
  // in Grossbuchstaben mit CERT oder SIGNATURE darin.
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || code === 'EPROTO'
      || code.includes('CERT') || code.includes('SIGNATURE')) return 'tls'
  return 'other'
}
