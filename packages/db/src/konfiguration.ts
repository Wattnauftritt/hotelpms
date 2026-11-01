import type { Pool } from './pool.js'

/**
 * Welche Einstellungen ein Dienst gesetzt hat -- die Namen, nie die Werte
 * (Migration 0222, Dokument 38).
 *
 * Der Claude-Zugang laeuft mit einer eigenen, kleinen Umgebung und kann
 * die Datei der Maschine nicht lesen; das ist Absicht. Die Frage "ist
 * BREVO_API_KEY eigentlich gesetzt?" ist bei der Fehlersuche trotzdem die
 * erste. API und Worker schreiben deshalb beim Start auf, was sie haben.
 *
 * Die Liste ist die aus .env.example. Eine Positivliste, damit kein
 * zufaelliger Name aus der Umgebung der Maschine in die Datenbank geraet.
 */
export const KONFIGURATION_NAMEN = [
  'DATABASE_URL', 'DATABASE_URL_DIRECT', 'DATABASE_URL_OWNER', 'NODE_ENV', 'LOG_LEVEL',
  'PORT', 'LISTEN_SOCKET', 'SESSION_SECRET', 'ID_DOCUMENT_KEY', 'ID_DOCUMENT_KEY_OLD',
  'ID_DOCUMENT_KEY_VERSION', 'RATE_LIMIT_LOGIN', 'RATE_LIMIT_ANON', 'DB_POOL_MAX',
  'DB_QUERY_WARN', 'PUBLIC_APP_URL', 'WEBHOOK_ALLOWED_PRIVATE_CIDRS',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID',
  'BREVO_API_KEY', 'DEEPL_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT', 'PLATFORM_NOTICE_EMAIL', 'PLATFORM_SUPPORT_EMAIL',
  'DECOY_EMAIL_DOMAIN', 'RELAY_EMAIL_DOMAIN', 'PLATFORM_EMAIL_FROM',
  'PLATFORM_EMAIL_FROM_NAME', 'PLATFORM_EMAIL_REPLY_TO'
] as const

/**
 * Den Stand eines Dienstes ersetzen. Ein Fehler hier haelt keinen Start
 * auf: die Angabe ist eine Hilfe fuer die Fehlersuche, kein Betrieb.
 */
export async function konfigurationMelden(
  pool: Pool, service: 'api' | 'worker', env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const namen = [...KONFIGURATION_NAMEN]
  const gesetzt = namen.map(n => (env[n] ?? '').trim() !== '')
  await pool.query(
    `INSERT INTO service_config_presence (service, name, is_set)
     SELECT $1, n, s FROM unnest($2::text[], $3::boolean[]) AS x(n, s)
     ON CONFLICT (service, name) DO UPDATE
        SET is_set = EXCLUDED.is_set, reported_at = now()`,
    [service, namen, gesetzt])
}
