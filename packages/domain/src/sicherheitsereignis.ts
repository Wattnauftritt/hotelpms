import type { SecurityEventKind } from '@hotelpms/contracts'
import { renderSecurityNotice, type SecurityNoticeAction } from './email.js'

/**
 * Ein Sicherheitsereignis festhalten und Bescheid sagen (Migration 0209,
 * Bedrohungsanalyse 23.10.2026, E3).
 *
 * In der Domaene und nicht in der API, weil zwei Stellen melden: die API
 * bei einer kritischen Handlung, der Worker bei einem Mengenalarm oder
 * einem beruehrten Koeder. Zwei Fassungen derselben Benachrichtigung
 * liefen beim naechsten Empfaengerkreis auseinander, und dann erfuehre die
 * Leitung vom einen und nicht vom anderen.
 */

/** Wie `KanalClient`: die Domaene haengt nicht an `@hotelpms/db`. */
export interface EreignisClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

export interface Ereignis {
  kind: SecurityEventKind
  accountId: number | null
  propertyId?: number | null
  /** Nur Kennungen, Zahlen und gekuerzte Werte; nie ein Gastname. */
  detail?: Record<string, unknown>
  /** Kurz und ungefaehrlich fuer die Mail, etwa "…1234" einer IBAN. */
  hint?: string | null
}

export interface Taeter {
  kind: 'user' | 'client' | 'channel' | 'system'
  userId: number | null
  ref: string | null
}

/** Die Arten, zu denen der Betrieb einen Hinweis bekommt. */
export const HINWEIS_ARTEN: ReadonlySet<SecurityEventKind> = new Set<SecurityEventKind>([
  'bank_details_changed', 'payment_account_connected', 'payment_account_disconnected',
  'oauth_client_created', 'oauth_client_changed', 'webhook_created', 'webhook_changed',
  'channel_connection_created', 'role_granted', 'support_granted', 'export',
  'login_new_device', 'access_volume', 'honeytoken', 'client_origin_denied'
])

/**
 * Festhalten und melden, in der Transaktion des Aufrufers: eine Handlung,
 * die zurueckrollt, hinterlaesst keine Meldung, und eine, die gilt, nie
 * eine ohne. `alarmAn` ist das Sicherheitspostfach der Plattform.
 */
export async function sicherheitsereignisMelden(
  client: EreignisClient, e: Ereignis, t: Taeter, herkunft: string | null, alarmAn: string
): Promise<void> {
  await client.query(
    'SELECT security_event_record($1, $2, $3, $4, $5, $6, $7::inet, $8::jsonb)',
    [e.accountId, e.propertyId ?? null, e.kind, t.kind, t.userId, t.ref,
     herkunft || null, JSON.stringify(e.detail ?? {})])

  const namen = (await client.query(
    `SELECT (SELECT display_name FROM app_user WHERE id = $1) AS actor,
            (SELECT name FROM account WHERE id = $2) AS account,
            (SELECT name FROM property WHERE id = $3) AS property`,
    [t.userId, e.accountId, e.propertyId ?? null])).rows[0] as {
      actor: string | null; account: string | null; property: string | null }
  const wer = namen.actor ?? (t.kind === 'client'
    ? `Maschinenzugang ${t.ref ?? ''}`.trim() : 'StayGrid')
  const wann = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin'
  }).format(new Date())

  if (e.accountId !== null && HINWEIS_ARTEN.has(e.kind)) {
    const empfaenger = (await client.query(
      'SELECT user_id, email, display_name, locale FROM security_notice_recipients($1)',
      [e.accountId])).rows as Array<{ user_id: number; email: string
                                       display_name: string | null; locale: string | null }>
    for (const r of empfaenger) {
      const m = renderSecurityNotice({
        userName: r.display_name, accountName: namen.account ?? '',
        propertyName: namen.property, actorName: wer, when: wann,
        action: e.kind as SecurityNoticeAction, hint: e.hint ?? null
      }, r.locale === 'de' || r.locale === null ? 'de' : 'en')
      await client.query(
        `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                                     body_text, body_html)
         VALUES ($1, 'security_notice', $2, $3, $4, $5, $6)`,
        [r.user_id, r.email, r.display_name, m.subject, m.text, m.html])
    }
  }

  /*
   * An uns: knapp und ohne Personendaten ausser der Kennung. Gleiche Art,
   * gleicher Betrieb, gleicher Taeter binnen einer Stunde ist eine Mail.
   */
  const zeilen = [
    `Art: ${e.kind}`,
    `Betrieb: ${e.accountId ?? '-'} ${namen.account ?? ''}`.trim(),
    `Haus: ${e.propertyId ?? '-'} ${namen.property ?? ''}`.trim(),
    `Taeter: ${t.kind} ${t.userId ?? t.ref ?? ''}`.trim(),
    `Herkunft: ${herkunft ?? '-'}`,
    `Zeit: ${wann}`,
    `Angaben: ${JSON.stringify(e.detail ?? {})}`
  ]
  await client.query('SELECT platform_alert_enqueue($1, $2, $3, $4)',
    [alarmAn, `[StayGrid] Sicherheitsereignis: ${e.kind}`,
     zeilen.join('\n'), `${e.kind}:${e.accountId ?? 0}:${t.userId ?? t.ref ?? ''}`])
}
