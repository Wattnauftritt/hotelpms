import type { FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { BESTAETIGUNG_FEHLT, BESTAETIGUNG_MINUTEN,
         type SecurityEventKind } from '@hotelpms/contracts'
import { renderSecurityNotice, type SecurityNoticeAction } from '@hotelpms/domain'
import { AppError } from './errors.js'
import type { Principal } from './context.js'
import { loadConfig } from './config.js'
import { tx } from './db.js'

/**
 * Kritische Handlungen: bestaetigen lassen und melden (Migration 0209,
 * Bedrohungsanalyse 23.10.2026, T3 und E3).
 *
 * **Was als kritisch gilt.** Was ein Angreifer mit einer geliehenen Sitzung
 * zuerst tun wuerde und was danach niemandem auffiele: Bankverbindung und
 * Zahlungskonto (wohin das Geld geht), Maschinenzugaenge, Webhooks und
 * Kanalzugaenge (Hintertueren, die einen Kennwortwechsel ueberleben),
 * Leitungsrollen und Support-Freigaben (wer sonst noch hineinkommt) und
 * Exporte (wo die Gaestedatei hinausgeht). Eine Reservierung zu aendern ist
 * es nicht: die Rezeption tut das hundertmal am Tag, und eine Huerde dort
 * waere Schaden ohne Gegenwert -- dieselbe Abwaegung wie bei der
 * Ratenbegrenzung.
 *
 * **Maschinen bestaetigen nicht.** Ein Zugang des Adminpanels hat kein
 * Kennwort, das es eingeben koennte. Er wird gemeldet wie ein Mensch, und
 * die Meldung ist bei ihm die eigentliche Sicherung.
 */

const config = loadConfig()

export function bestaetigungFehlt(): AppError {
  return new AppError(403, BESTAETIGUNG_FEHLT, 'error.confirmationRequired',
    'error.confirmationRequired.detail', undefined, { minutes: BESTAETIGUNG_MINUTEN })
}

/**
 * Ist die Sitzung in den letzten Minuten bestaetigt worden, und zwar von der
 * Person, die gerade handelt?
 *
 * Gelesen ueber den Pool und nicht in der Transaktion der Route:
 * `user_session` hat keine Zeilenrichtlinie, und die Pruefung soll vor jeder
 * fachlichen Arbeit scheitern, nicht danach.
 */
export async function istBestaetigt(req: FastifyRequest): Promise<boolean> {
  const p = req.principal as Principal
  if (p.userId === null || req.sitzung === null) return false
  const { rows } = await req.pool.query<{ ok: boolean }>(
    `SELECT confirmed_at > now() - make_interval(mins => $3)
            AND confirmed_user_id = $2 AS ok
       FROM user_session WHERE id = $1 AND revoked_at IS NULL`,
    [req.sitzung.id, p.userId, BESTAETIGUNG_MINUTEN])
  return rows[0]?.ok === true
}

/**
 * Am Anfang jeder kritischen Route. Ein Mensch muss bestaetigt haben; ein
 * Maschinenzugang kommt durch und wird gemeldet.
 */
export async function verlangeBestaetigung(req: FastifyRequest): Promise<void> {
  const p = req.principal as Principal
  if (p.userId === null) return
  if (!await istBestaetigt(req)) throw bestaetigungFehlt()
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

function taeter(p: Principal): { kind: 'user' | 'client' | 'system'; userId: number | null
                                 ref: string | null } {
  if (p.userId !== null) return { kind: 'user', userId: p.userId, ref: null }
  if (p.clientKey.startsWith('client:')) {
    return { kind: 'client', userId: null, ref: p.clientKey.slice(7) }
  }
  return { kind: 'system', userId: null, ref: p.clientKey.slice(0, 64) }
}

/** Die Arten, zu denen der Betrieb einen Hinweis bekommt. */
const HINWEIS: ReadonlySet<SecurityEventKind> = new Set<SecurityEventKind>([
  'bank_details_changed', 'payment_account_connected', 'payment_account_disconnected',
  'oauth_client_created', 'oauth_client_changed', 'webhook_created', 'webhook_changed',
  'channel_connection_created', 'role_granted', 'support_granted', 'export',
  'login_new_device', 'access_volume'
])

/**
 * Das Ereignis festhalten und Bescheid sagen: den Berechtigten im Betrieb
 * und dem Sicherheitspostfach der Plattform. In der Transaktion der Route,
 * damit eine Handlung, die zurueckrollt, auch keine Meldung hinterlaesst --
 * und eine, die gilt, nie ohne.
 */
export async function meldeSicherheitsereignis(
  client: PoolClient, req: FastifyRequest, e: Ereignis
): Promise<void> {
  const p = req.principal as Principal
  const t = taeter(p)
  await client.query(
    'SELECT security_event_record($1, $2, $3, $4, $5, $6, $7::inet, $8::jsonb)',
    [e.accountId, e.propertyId ?? null, e.kind, t.kind, t.userId, t.ref,
     req.ip || null, JSON.stringify(e.detail ?? {})])

  await benachrichtige(client, e, t, req.ip)
}

/**
 * Wie oben, aber ohne Anfrage: fuer den Worker (Mengenalarm, Koeder).
 */
export async function benachrichtige(
  client: PoolClient, e: Ereignis,
  t: { kind: string; userId: number | null; ref: string | null }, herkunft: string | null
): Promise<void> {
  const namen = await client.query<{ actor: string | null; account: string | null
                                     property: string | null }>(
    `SELECT (SELECT display_name FROM app_user WHERE id = $1) AS actor,
            (SELECT name FROM account WHERE id = $2) AS account,
            (SELECT name FROM property WHERE id = $3) AS property`,
    [t.userId, e.accountId, e.propertyId ?? null])
  const n = namen.rows[0]!
  const wer = n.actor ?? (t.kind === 'client' ? `Maschinenzugang ${t.ref ?? ''}`.trim()
                                              : 'StayGrid')
  const wann = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin'
  }).format(new Date())

  if (e.accountId !== null && HINWEIS.has(e.kind)) {
    const empfaenger = await client.query<{ user_id: number; email: string
                                            display_name: string | null; locale: string | null }>(
      'SELECT user_id, email, display_name, locale FROM security_notice_recipients($1)',
      [e.accountId])
    for (const r of empfaenger.rows) {
      const m = renderSecurityNotice({
        userName: r.display_name, accountName: n.account ?? '', propertyName: n.property,
        actorName: wer, when: wann, action: e.kind as SecurityNoticeAction,
        hint: e.hint ?? null
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
    `Betrieb: ${e.accountId ?? '-'} ${n.account ?? ''}`.trim(),
    `Haus: ${e.propertyId ?? '-'} ${n.property ?? ''}`.trim(),
    `Taeter: ${t.kind} ${t.userId ?? t.ref ?? ''}`.trim(),
    `Herkunft: ${herkunft ?? '-'}`,
    `Zeit: ${wann}`,
    `Angaben: ${JSON.stringify(e.detail ?? {})}`
  ]
  await client.query('SELECT platform_alert_enqueue($1, $2, $3, $4)',
    [config.platformNoticeEmail, `[StayGrid] Sicherheitsereignis: ${e.kind}`,
     zeilen.join('\n'), `${e.kind}:${e.accountId ?? 0}:${t.userId ?? t.ref ?? ''}`])
}

/** Die letzten vier Stellen, der Rest als Punkte. Fuer IBAN und Kennungen. */
export function kuerze(wert: string | null | undefined): string | null {
  if (!wert) return null
  const s = wert.replace(/\s+/g, '')
  return s.length <= 4 ? '…' : `…${s.slice(-4)}`
}

/** Der Betrieb eines Hauses, im Kontext der Route gelesen. */
export async function accountVonHaus(client: PoolClient, propertyId: number): Promise<number | null> {
  const { rows } = await client.query<{ account_id: number }>(
    'SELECT account_id FROM property WHERE id = $1', [propertyId])
  return rows[0]?.account_id ?? null
}

/** Ein Haus melden: Betrieb nachschlagen, dann wie oben. */
export async function meldeImHaus(
  client: PoolClient, req: FastifyRequest, propertyId: number,
  e: Omit<Ereignis, 'accountId' | 'propertyId'>
): Promise<void> {
  await meldeSicherheitsereignis(client, req,
    { ...e, accountId: await accountVonHaus(client, propertyId), propertyId })
}

/**
 * Die Rechte, die eine Rolle zur Leitungsrolle machen: wer sie hat, legt
 * Benutzer an, vergibt Rechte, oeffnet Schnittstellen oder zieht die
 * Gaestedatei. Eine Rezeptionsrolle zu vergeben ist Alltag und bleibt ohne
 * Huerde.
 */
export const LEITUNGSRECHTE = ['settings:account', 'user:manage', 'integration:manage',
                               'guest:export', 'report:export'] as const

/**
 * Welche Leitungsrechte bekaeme der Benutzer mit diesen Rollen neu hinzu --
 * im Haus (`propertyId`) oder fuer den ganzen Betrieb (`null`)? Leer heisst:
 * keine Bestaetigung noetig.
 */
export async function leitungsrechteNeu(
  client: PoolClient, userId: number, roleIds: readonly number[],
  accountId: number, propertyId: number | null
): Promise<string[]> {
  if (roleIds.length === 0) return []
  const { rows } = await client.query<{ k: string }>(
    `SELECT DISTINCT rp.permission_key AS k
       FROM role_permission rp
      WHERE rp.role_id = ANY($1::bigint[]) AND rp.permission_key = ANY($5::text[])
        AND NOT EXISTS (
          SELECT 1 FROM user_account_role ur
            JOIN role_permission x ON x.role_id = ur.role_id
           WHERE ur.user_id = $2 AND ur.account_id = $3
             AND x.permission_key = rp.permission_key)
        AND ($4::bigint IS NULL OR NOT EXISTS (
          SELECT 1 FROM user_property_role ur
            JOIN role_permission x ON x.role_id = ur.role_id
           WHERE ur.user_id = $2 AND ur.property_id = $4
             AND x.permission_key = rp.permission_key))
      ORDER BY 1`,
    [roleIds, userId, accountId, propertyId, LEITUNGSRECHTE])
  return rows.map(r => r.k)
}

/** Bestaetigen und melden, falls die Rollen Leitungsrechte hinzufuegen. */
export async function leitungsrolleAbsichern(
  client: PoolClient, req: FastifyRequest, ziel: { userId: number; userRef?: string },
  roleIds: readonly number[], accountId: number, propertyId: number | null
): Promise<void> {
  const neu = await leitungsrechteNeu(client, ziel.userId, roleIds, accountId, propertyId)
  if (neu.length === 0) return
  await verlangeBestaetigung(req)
  await meldeSicherheitsereignis(client, req, {
    kind: 'role_granted', accountId, propertyId,
    detail: { userId: ziel.userId, permissions: neu },
    hint: neu.join(', ') })
}

/**
 * Einen Export festhalten, bevor er laeuft (Bedrohungsanalyse 23.10.2026,
 * T3 und T5). Wo die Gaestedatei als Ganzes hinausgeht -- Mandantenexport,
 * GoBD-Archiv, Gaesteverzeichnis --, verlangt er ausserdem eine
 * Bestaetigung. DATEV, Kassenbuch und Arbeitszeit sind Monatsroutine fuer
 * die Buchhaltung; dort genuegt die Meldung.
 *
 * In einer eigenen Transaktion, nicht in der des Exports: der streamt seine
 * Datei, und ein Versuch, der unterwegs abbricht, ist trotzdem einer.
 */
export async function exportMelden(
  req: FastifyRequest, propertyId: number, art: string,
  opts: { bestaetigen: boolean; detail?: Record<string, unknown> }
): Promise<void> {
  if (opts.bestaetigen) await verlangeBestaetigung(req)
  await tx(req.pool, req, client => meldeImHaus(client, req, propertyId, {
    kind: 'export', detail: { art, ...opts.detail }, hint: art }))
}
