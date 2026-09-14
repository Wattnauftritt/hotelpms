import type { Problem } from '@hotelpms/contracts'

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

async function request<T>(
  method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  if (res.status === 204) return undefined as T
  const text = await res.text()
  const parsed: unknown = text === '' ? null : safeJson(text)

  if (!res.ok) {
    const problem: Problem = isProblem(parsed) ? parsed : {
      type: 'urn:hotelpms:unknown',
      title: res.statusText || 'Unbekannter Fehler',
      status: res.status
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
  get: <T>(path: string) => request<T>('GET', path),
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
