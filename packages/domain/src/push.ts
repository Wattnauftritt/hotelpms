/**
 * Web-Push an das Personal (Aufgabe 18, Baustein 8; Migration 0113).
 *
 * Ein Abo ist eine Adresse, die das Telefon nennt und an die der Worker
 * POST schickt. Ungeprueft waere das derselbe Weg ins eigene Netz, den die
 * Webhooks zugemacht haben (Befund B1). Zugelassen sind deshalb nur die
 * Push-Dienste der Browserhersteller -- eine kurze, feste Liste, denn jeder
 * Browser benutzt genau den Dienst seines Herstellers.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',            // Chrome, Edge auf Android, Samsung
  'android.googleapis.com',        // aeltere Chrome-Fassungen
  'updates.push.services.mozilla.com',
  'web.push.apple.com'             // Safari, auch die installierte App auf dem iPhone
] as const
const PUSH_SUFFIXES = ['.notify.windows.com', '.push.apple.com'] as const

export function isPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 1000) return false
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false
  }
  const host = url.hostname.toLowerCase()
  return (PUSH_HOSTS as readonly string[]).includes(host)
    || PUSH_SUFFIXES.some(s => host.endsWith(s))
}

/** Danach bleibt eine Meldung liegen: sie waere ohnehin veraltet. */
export const PUSH_MAX_ATTEMPTS = 4

/**
 * Wie lange der Dienst eine Meldung fuer ein ausgeschaltetes Telefon
 * aufhebt. Ein frei gewordenes Zimmer ist am naechsten Morgen keine
 * Nachricht mehr, ein geaenderter Plan fuer morgen schon.
 */
export function pushTtlSeconds(kind: 'plan' | 'room_free' | 'rework'): number {
  return kind === 'plan' ? 12 * 3600 : 4 * 3600
}
