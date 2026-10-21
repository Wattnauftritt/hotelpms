import { createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PushPayload, PushSender } from './staffPush.js'

/**
 * Push in die eigene App ueber Firebase Cloud Messaging (Migration 0193).
 *
 * In der App gibt es kein Web-Push: die WebView hat keinen Service Worker.
 * Das Telefon meldet sich mit einer Kennung von FCM an, und hier geht die
 * Meldung an die HTTP-v1-Schnittstelle von FCM, die sie an Android und,
 * mit dem Schluessel von Apple im Firebase-Projekt, an iOS weitergibt.
 *
 * Ohne Paket von Dritten, wie apps/mobile/scripts/play.mjs: ein signiertes
 * JWT, ein Token, ein POST. Das Admin-SDK von Firebase braeuchte dafuer
 * hundert Abhaengigkeiten im Prozess, der das Dienstkonto in der Hand haelt.
 *
 * **Das Dienstkonto liegt als Datei auf der Maschine**
 * (`FCM_SERVICE_ACCOUNT_FILE`, sonst `/opt/hotelpms/shared/fcm.json`),
 * nicht in der Umgebung: die liest auch die API, und die braucht es nicht.
 * Fehlt die Datei, bleibt Web-Push, wie es ist, und App-Abos warten.
 */

export interface FcmKonto {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

export async function fcmKontoLesen(pfad: string): Promise<FcmKonto | null> {
  let text: string
  try {
    text = await readFile(pfad, 'utf8')
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null
    throw e
  }
  const k = JSON.parse(text) as Partial<FcmKonto>
  if (typeof k.project_id !== 'string' || typeof k.client_email !== 'string'
      || typeof k.private_key !== 'string') {
    throw new Error(`${pfad} ist kein Schluessel eines Dienstkontos`)
  }
  return k as FcmKonto
}

const b64 = (s: string): string => Buffer.from(s).toString('base64url')

/**
 * Die Antwort von FCM in den Status, den staffPush.ts versteht. 404 und 410
 * heissen dort: das Abo gibt es nicht mehr. FCM sagt das mit `UNREGISTERED`
 * (404), bei einer verstuemmelten Kennung mit `INVALID_ARGUMENT` (400) und
 * bei einer Kennung aus einem fremden Firebase-Projekt mit
 * `SENDER_ID_MISMATCH` (403). Alles andere ist ein Fehler, der spaeter neu
 * versucht wird -- auch ein 400, der nicht die Kennung meint: dann ist die
 * Meldung falsch gebaut, und ein Abo deswegen zu loeschen, waere falsch.
 */
export function fcmStatus(status: number, rumpf: string): number {
  if (status === 404) return 404
  let code = ''
  let text = ''
  try {
    const j = JSON.parse(rumpf) as {
      error?: { message?: string; details?: Array<{ errorCode?: string }> }
    }
    code = j.error?.details?.find(d => d.errorCode !== undefined)?.errorCode ?? ''
    text = j.error?.message ?? ''
  } catch { /* kein JSON: bleibt beim Status */ }
  if (code === 'UNREGISTERED') return 410
  if (code === 'SENDER_ID_MISMATCH') return 410
  if (status === 400 && code === 'INVALID_ARGUMENT' && /registration token/i.test(text)) return 410
  return status
}

export function fcmNachricht(token: string, payload: PushPayload, ttlSeconds: number): unknown {
  // Auf dem Telefon ersetzt dieselbe Kennung die vorige Meldung, wie `tag`
  // im Browser. Apple nimmt hoechstens 64 Bytes.
  const tag = payload.tag.slice(0, 64)
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data: { url: payload.url, tag },
      android: {
        priority: 'HIGH',
        ttl: `${ttlSeconds}s`,
        collapse_key: tag,
        // Das Symbol in der Statusleiste: einfarbig, sonst zeichnet Android
        // ein weisses Quadrat (apps/mobile, res/drawable).
        notification: { tag, icon: 'ic_stat_staygrid' }
      },
      apns: {
        headers: {
          'apns-collapse-id': tag,
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSeconds)
        },
        payload: { aps: { sound: 'default' } }
      }
    }
  }
}

export function createFcmSender(konto: FcmKonto, abruf: typeof fetch = fetch): PushSender {
  const tokenUri = konto.token_uri ?? 'https://oauth2.googleapis.com/token'
  let zugang: { token: string; bis: number } | null = null

  async function token(): Promise<string> {
    const jetzt = Math.floor(Date.now() / 1000)
    // Eine Minute Luft: ein Token, das waehrend des Sendens ablaeuft, kostet
    // einen Fehlversuch und eine Wiederholung.
    if (zugang !== null && zugang.bis - 60 > jetzt) return zugang.token
    const kopf = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const rumpf = b64(JSON.stringify({
      iss: konto.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: tokenUri,
      iat: jetzt,
      exp: jetzt + 3600
    }))
    const signatur = createSign('RSA-SHA256').update(`${kopf}.${rumpf}`)
      .sign(konto.private_key, 'base64url')
    const r = await abruf(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${kopf}.${rumpf}.${signatur}`
      }),
      signal: AbortSignal.timeout(10_000)
    })
    const j = await r.json() as { access_token?: string; expires_in?: number; error?: string }
    if (!r.ok || j.access_token === undefined) {
      throw new Error(`Anmeldung bei Google abgewiesen: ${j.error ?? r.status}`)
    }
    zugang = { token: j.access_token, bis: jetzt + (j.expires_in ?? 3600) }
    return zugang.token
  }

  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(konto.project_id)}/messages:send`
  return {
    async send(target, payload, ttlSeconds) {
      if (target.art !== 'fcm') return null
      const r = await abruf(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
        body: JSON.stringify(fcmNachricht(target.token, payload, ttlSeconds)),
        signal: AbortSignal.timeout(10_000)
      })
      // Ein abgelaufenes Token beim naechsten Mal neu holen.
      if (r.status === 401) zugang = null
      return fcmStatus(r.status, r.ok ? '' : await r.text())
    }
  }
}
