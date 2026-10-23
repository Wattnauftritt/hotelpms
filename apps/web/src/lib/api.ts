import type { Problem } from '@hotelpms/contracts'
import { nativ, type StaygridNative } from '@hotelpms/native'
import { bestaetigen, verlangtBestaetigung } from './bestaetigung.js'

/**
 * Zugriff auf die Schnittstelle.
 *
 * Alle Typen kommen aus `@hotelpms/contracts`, keiner wird hier von Hand
 * geschrieben. Eine zweite Definition im Frontend ist nach dem dritten Feld
 * falsch, und der Fehler zeigt sich erst zur Laufzeit beim Gast am Tresen.
 *
 * Die Sitzung liegt im Cookie und wird vom Browser mitgeschickt. Es gibt
 * hier bewusst keine Kopfzeile mit einem Token: ein Token im JavaScript ist
 * ein Token, das ein eingeschleustes Skript lesen kann.
 *
 * **Die Ausnahme ist die eigene App** (Migration 0191, Plan app/plan.md).
 * Dort liegen die Seiten unter einer anderen Herkunft als die Schnittstelle,
 * und das `SameSite=Strict`-Cookie kommt nicht an. Die App weist sich mit
 * einem Token aus, das im Schluesselbund liegt; warum das dort vertretbar
 * ist, steht an der Anmeldung (`routes/auth.ts` der API). Im Browser fehlt
 * `window.staygridNative`, und alles hier laeuft wie bisher.
 */

export class ApiError extends Error {
  constructor(readonly problem: Problem, readonly status: number) {
    super(problem.detail ?? problem.title)
    this.name = 'ApiError'
  }
  /** Feldbezogene Meldungen bei Status 422, sonst leer. */
  get fieldErrors(): Record<string, string[]> {
    return this.problem.errors ?? {}
  }
}

/** Das Token der App, einmal aus dem Schluesselbund gelesen. */
let appToken: Promise<string | null> | null = null

function tokenDerApp(n: StaygridNative): Promise<string | null> {
  appToken ??= n.sitzung.lesen().catch(() => null)
  return appToken
}

/**
 * `fetch` gegen die Schnittstelle, fuer die wenigen Aufrufe, die eine Datei
 * statt JSON holen (Beleg, Export). Im Browser derselbe Aufruf wie bisher;
 * in der App mit der Herkunft der Schnittstelle davor und dem Token, ohne
 * Cookies.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const n = nativ()
  if (n === undefined) return fetch(path, { credentials: 'same-origin', ...init })
  const headers = new Headers(init.headers)
  const token = await tokenDerApp(n)
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  return fetch(n.api + path, { ...init, headers, credentials: 'omit' })
}

async function request<T>(
  method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {},
  wiederholt = false
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await apiFetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  if (res.status === 204) return undefined as T
  const text = await res.text()
  const parsed: unknown = text === '' ? null : safeJson(text)

  if (!res.ok) {
    const problem: Problem = isProblem(parsed) ? parsed : {
      type: 'urn:staygrid:unknown',
      title: res.statusText || 'Unbekannter Fehler',
      status: res.status
    }
    // Eine kritische Handlung ohne frische Bestaetigung: fragen und genau
    // einmal erneut senden (lib/bestaetigung.ts). Derselbe Rumpf, derselbe
    // Idempotenzschluessel -- es ist dieselbe Absicht.
    if (!wiederholt && verlangtBestaetigung(res.status, problem) && await bestaetigen()) {
      return request<T>(method, path, body, extraHeaders, true)
    }
    throw new ApiError(problem, res.status)
  }
  return parsed as T
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
function isProblem(v: unknown): v is Problem {
  return typeof v === 'object' && v !== null && 'title' in v && 'status' in v
}

export const api = {
  // Kopfzeilen nur fuer die Gastseite des Online-Check-ins: dort ist der
  // Link der Ausweis, nicht das Cookie (Dokument 30).
  get: <T>(path: string, headers?: Record<string, string>) =>
    request<T>('GET', path, undefined, headers),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>('POST', path, body ?? {}, headers),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  // Loescht in dieser API nie Fachdaten: DELETE steht dort, wo eine
  // Einrichtung abgeschaltet wird -- ein Webhook-Abonnement etwa. Belege,
  // Reservierungen und Gaeste kennen diesen Weg nicht.
  delete: <T>(path: string) => request<T>('DELETE', path)
}

/**
 * Anmelden, im Browser mit Cookie, in der App mit Token. An einer Stelle,
 * damit Rezeption und Personal-App nicht jede fuer sich wissen muessen, wo
 * sie laufen.
 */
export async function anmelden(login: string, password: string): Promise<void> {
  const n = nativ()
  if (n === undefined) {
    await api.post('/v1/auth/login', { login, password })
    return
  }
  const { token } = await api.post<{ token: string }>('/v1/auth/login',
    { login, password, client: 'app' })
  await n.sitzung.speichern(token)
  appToken = Promise.resolve(token)
}

/**
 * Abmelden. In der App geht das Token auch dann aus dem Schluesselbund,
 * wenn der Aufruf scheitert: ohne Netz bliebe sonst eine Sitzung auf dem
 * Telefon, von der der Benutzer glaubt, er habe sie beendet. Auf dem Server
 * laeuft sie dann aus wie jede andere.
 */
export async function abmelden(): Promise<void> {
  try {
    await api.post('/v1/auth/logout')
  } finally {
    const n = nativ()
    if (n !== undefined) {
      appToken = Promise.resolve(null)
      // Die Schnellaktionen gehoeren der Person, nicht dem Telefon.
      await n.kurzbefehle?.setzen([]).catch(() => { /* naechster Start */ })
      await n.sitzung.loeschen().catch(() => { /* naechster Start fragt neu */ })
    }
  }
}

/**
 * Idempotenzschlüssel für jede anlegende Anfrage.
 *
 * Die Rezeption drückt zweimal, wenn es einen Moment dauert. Ohne Schlüssel
 * entstehen dann zwei Reservierungen, und das Kontingent ist doppelt
 * gebunden. Der Schlüssel gehört zur fachlichen Absicht, nicht zum Versuch:
 * er wird einmal je Formular erzeugt und bei einem Wiederholungsversuch
 * **nicht** erneuert.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
