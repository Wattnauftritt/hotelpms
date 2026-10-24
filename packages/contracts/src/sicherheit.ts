/**
 * Arten von Sicherheitsereignissen (Migration 0209, Bedrohungsanalyse
 * 23.10.2026). Dieselbe Liste wie die CHECK-Bedingung an `security_event`;
 * ein Test vergleicht beide, damit eine neue Art nicht nur an einer Stelle
 * entsteht.
 */
export const SECURITY_EVENT_KINDS = [
  'bank_details_changed', 'payment_account_connected',
  'payment_account_disconnected', 'oauth_client_created',
  'oauth_client_changed', 'webhook_created', 'webhook_changed',
  'channel_connection_created', 'role_granted',
  'support_granted', 'export', 'deployment',
  'platform_role_changed', 'payment_provider_changed',
  'confirmation_failed', 'login_new_device',
  'access_volume', 'honeytoken', 'platform_passkey_changed',
  'client_origin_denied'
] as const
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number]

/**
 * Wie lange eine Bestaetigung mit Kennwort oder Passkey traegt. Kurz genug,
 * dass ein vorgefundener Rechner zehn Minuten spaeter wieder fragt, lang
 * genug fuer zwei Handlungen hintereinander (IBAN, dann Stripe).
 */
export const BESTAETIGUNG_MINUTEN = 5

/** Der Fehlertyp, an dem die Oberflaeche den Bestaetigungsdialog oeffnet. */
export const BESTAETIGUNG_FEHLT = 'urn:staygrid:confirmation_required'

/** Eine Zeile des Sicherheitsprotokolls (`GET /v1/security-events`). */
export interface SecurityEventRow {
  id: number
  accountId: number | null
  /** Nur in der Sicht der Plattform. */
  accountName?: string | null
  propertyId: number | null
  kind: SecurityEventKind
  actorKind: 'user' | 'client' | 'channel' | 'system'
  actorUserId: number | null
  actorName: string | null
  actorRef: string | null
  /** Ungekuerzt bis 180 Tage, danach das Netz (/24, /48). */
  origin: string | null
  originTruncated: boolean
  /** Nur Kennungen, Zahlen und gekuerzte Werte. */
  detail: Record<string, unknown>
  createdAt: string
}
