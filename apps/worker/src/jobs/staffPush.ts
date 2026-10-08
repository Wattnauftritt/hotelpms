import webpush from 'web-push'
import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { isPushEndpoint, pushTtlSeconds, PUSH_MAX_ATTEMPTS } from '@hotelpms/domain'
import { renderPushText, STAFF_LOCALES, type StaffLocale, type PushTextKey }
  from '@hotelpms/contracts'

/**
 * Push-Meldungen an das Personal senden (Aufgabe 18, Baustein 8; 0113).
 *
 * Wieder die drei Schritte der Webhook-Zustellung: beanspruchen in einer
 * Transaktion, senden ohne, vermerken in einer. Ein Push-Dienst, der zehn
 * Sekunden braucht, haelt sonst eine Sperre zehn Sekunden.
 *
 * Eine Meldung geht an jedes Telefon der Kraft, dessen Sitzung noch gilt.
 * Antwortet der Dienst 404 oder 410, gibt es das Abo nicht mehr (App
 * geloescht, Berechtigung entzogen), und es wird entfernt. Hat die Kraft
 * kein Telefon angemeldet, ist die Meldung erledigt, nicht gescheitert.
 */

export interface PushPayload {
  title: string
  body: string
  /** Wohin ein Tippen auf die Meldung fuehrt. */
  url: string
  /** Gleiche Kennung ersetzt die vorige Meldung auf dem Telefon. */
  tag: string
}

export interface PushTarget { endpoint: string; p256dh: string; auth: string }

/** Nur diese Fassade, damit ein Test einen Sender unterschieben kann. */
export interface PushSender {
  /** Liefert den Status des Dienstes; wirft nur, wenn keiner kam. */
  send(target: PushTarget, payload: PushPayload, ttlSeconds: number): Promise<number>
}

/**
 * Das VAPID-Schluesselpaar (0117). Die Umgebung gewinnt; sonst das Paar aus
 * der Datenbank, und gibt es dort keins, erzeugt der Worker eins und legt es
 * ab (Sven, 08.10.2026: ohne Terminal soll Push trotzdem gehen).
 *
 * `ON CONFLICT DO NOTHING` und danach neu lesen: starten zwei Worker
 * gleichzeitig, gewinnt einer, und beide benutzen dasselbe Paar. Zwei
 * verschiedene Paare hiessen, dass die Haelfte der Abos nicht zugestellt
 * wird. `owner` ist die Eigentuemerrolle -- nur sie liest den privaten
 * Schluessel.
 */
export async function vapidSchluessel(
  owner: Pool, env: { publicKey: string | null; privateKey: string | null }
): Promise<{ publicKey: string; privateKey: string; quelle: 'umgebung' | 'datenbank' | 'neu' }> {
  if (env.publicKey !== null && env.privateKey !== null) {
    return { publicKey: env.publicKey, privateKey: env.privateKey, quelle: 'umgebung' }
  }
  const lies = async (): Promise<{ publicKey: string; privateKey: string } | null> => {
    const { rows } = await owner.query<{ publicKey: string; privateKey: string }>(
      `SELECT public_key AS "publicKey", private_key AS "privateKey" FROM platform_vapid_key`)
    return rows[0] ?? null
  }
  const da = await lies()
  if (da !== null) return { ...da, quelle: 'datenbank' }
  const neu = webpush.generateVAPIDKeys()
  const r = await owner.query(
    `INSERT INTO platform_vapid_key (public_key, private_key) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`, [neu.publicKey, neu.privateKey])
  const jetzt = await lies()
  return { ...jetzt!, quelle: r.rowCount === 1 ? 'neu' : 'datenbank' }
}

export function createWebPushSender(vapid: {
  subject: string; publicKey: string; privateKey: string
}): PushSender {
  return {
    async send(target, payload, ttlSeconds) {
      try {
        const r = await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          { vapidDetails: vapid, TTL: ttlSeconds, timeout: 10_000, urgency: 'high' })
        return r.statusCode
      } catch (e) {
        // Eine Antwort ausserhalb der 2xx kommt bei web-push als Fehler mit
        // Status; nur ohne Status war es das Netz.
        const status = (e as { statusCode?: unknown }).statusCode
        if (typeof status === 'number') return status
        throw e
      }
    }
  }
}

type Art = 'plan' | 'room_free' | 'rework'

interface ClaimedPush {
  id: number
  user_id: number
  kind: Art
  params: Record<string, string>
  attempt: number
  locale: string | null
  targets: Array<PushTarget & { id: number }>
}

async function claim(
  client: PoolClient, propertyId: number, batchSize: number, leaseSeconds: number
): Promise<ClaimedPush[]> {
  const { rows } = await client.query<ClaimedPush>(
    `WITH faellig AS (
       SELECT p.id FROM staff_push p
        WHERE p.property_id = $1 AND p.status = 'pending' AND p.next_at <= now()
        ORDER BY p.id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), beansprucht AS (
       UPDATE staff_push p
          SET attempts = p.attempts + 1, next_at = now() + make_interval(secs => $3)
        WHERE p.id IN (SELECT id FROM faellig)
       RETURNING p.id, p.user_id, p.kind, p.params, p.attempts AS attempt
     )
     SELECT b.id::int, b.user_id::int, b.kind, b.params, b.attempt, u.locale,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint,
                                                          'p256dh', s.p256dh, 'auth', s.auth))
                        FROM push_subscription s
                        JOIN user_session us ON us.id = s.session_id
                       WHERE s.user_id = b.user_id AND us.revoked_at IS NULL
                         AND us.expires_at > now() AND us.absolute_expires_at > now()),
                     '[]'::jsonb) AS targets
       FROM beansprucht b
       JOIN app_user u ON u.id = b.user_id
      ORDER BY b.id`,
    [propertyId, batchSize, leaseSeconds])
  return rows
}

function sprache(locale: string | null): StaffLocale {
  return (STAFF_LOCALES as readonly string[]).includes(locale ?? '')
    ? locale as StaffLocale : 'de'
}

/** `Donnerstag, 8.10.` -- das Datum, wie die Kraft es sagt. */
function tagText(iso: string, locale: StaffLocale): string {
  const [j, m, t] = iso.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long', day: 'numeric', month: 'numeric', timeZone: 'UTC'
  }).format(new Date(Date.UTC(j, m - 1, t)))
}

export function buildPushPayload(
  kind: Art, params: Record<string, string>, locale: StaffLocale
): PushPayload {
  const werte = kind === 'plan' && params.date !== undefined
    ? { ...params, date: tagText(params.date, locale) } : params
  return {
    title: renderPushText(`${kind}.title` as PushTextKey, locale, werte),
    body: renderPushText(`${kind}.body` as PushTextKey, locale, werte),
    url: '/personal',
    tag: kind === 'plan' ? `plan-${params.date ?? ''}` : `${kind}-${params.room ?? ''}`
  }
}

interface Versand { gesendet: number; weg: number[]; fehler: string | null }

async function sende(sender: PushSender, p: ClaimedPush): Promise<Versand> {
  const payload = buildPushPayload(p.kind, p.params, sprache(p.locale))
  const v: Versand = { gesendet: 0, weg: [], fehler: null }
  for (const t of p.targets) {
    // Noch einmal gegen die Liste: was beim Anmelden durchging, soll auch
    // nach einer Aenderung der Liste nicht ins eigene Netz fuehren.
    if (!isPushEndpoint(t.endpoint)) { v.weg.push(t.id); continue }
    try {
      const status = await sender.send(t, payload, pushTtlSeconds(p.kind))
      if (status >= 200 && status < 300) v.gesendet++
      else if (status === 404 || status === 410) v.weg.push(t.id)
      else v.fehler = `http_${status}`
    } catch {
      v.fehler = 'network'
    }
  }
  return v
}

async function record(
  client: PoolClient, p: ClaimedPush, v: Versand | null, baseDelaySeconds: number
): Promise<'sent' | 'retrying' | 'failed'> {
  if (v !== null && v.weg.length > 0) {
    await client.query('DELETE FROM push_subscription WHERE id = ANY($1::bigint[])', [v.weg])
  }
  if (v !== null && v.gesendet > 0) {
    await client.query(
      `UPDATE push_subscription SET last_used_at = now()
        WHERE user_id = $1 AND NOT (id = ANY($2::bigint[]))`, [p.user_id, v.weg])
  }
  // Erreicht, oder niemand zu erreichen: erledigt. Nur wer gar nicht
  // durchkam, versucht es spaeter -- ein Telefon, das eine Meldung hat,
  // braucht sie nicht ein zweites Mal.
  if (v === null || v.fehler === null || v.gesendet > 0) {
    await client.query(
      `UPDATE staff_push SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
      [p.id])
    return 'sent'
  }
  const erschoepft = p.attempt >= PUSH_MAX_ATTEMPTS
  await client.query(
    `UPDATE staff_push
        SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
            next_at = CASE WHEN $2 THEN now() ELSE now() + make_interval(secs => $3) END,
            last_error = $4
      WHERE id = $1`,
    [p.id, erschoepft, baseDelaySeconds * 2 ** (p.attempt - 1), v.fehler])
  return erschoepft ? 'failed' : 'retrying'
}

export interface StaffPushResult { attempted: number; sent: number; retrying: number; failed: number }

export async function sendStaffPushes(
  pool: Pool, ctx: DbContext, propertyId: number, sender: PushSender,
  opts: { batchSize?: number; leaseSeconds?: number; baseDelaySeconds?: number } = {}
): Promise<StaffPushResult> {
  const claimed = await withTransaction(pool, ctx, async c => {
    // Erledigtes nach einem Monat weg: es sagt nur noch, wer wann welches
    // Zimmer gemeldet bekam, und das steht im Plan selbst.
    await c.query(
      `DELETE FROM staff_push WHERE property_id = $1 AND status <> 'pending'
          AND created_at < now() - interval '30 days'`, [propertyId])
    return claim(c, propertyId, opts.batchSize ?? 100, opts.leaseSeconds ?? 120)
  })
  const result: StaffPushResult = { attempted: claimed.length, sent: 0, retrying: 0, failed: 0 }
  for (const p of claimed) {
    const v = p.targets.length === 0 ? null : await sende(sender, p)
    result[await withTransaction(pool, ctx, c => record(c, p, v, opts.baseDelaySeconds ?? 30))]++
  }
  return result
}
