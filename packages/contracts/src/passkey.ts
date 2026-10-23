/**
 * Passkeys (Migration 0207).
 *
 * Die Optionen fuer `navigator.credentials` reichen die Schnittstelle und die
 * Oberflaeche als JSON durch, wie WebAuthn sie beschreibt; die Oberflaeche
 * wandelt nur die base64url-Felder in Bytes und zurueck. Hier stehen deshalb
 * nur die Teile, die StayGrid selbst festlegt.
 */

/** Hoechstens so viele Passkeys je Zugang. Eine Liste, die niemand mehr ueberblickt, raeumt niemand auf. */
export const PASSKEY_MAX = 10

/** Laenge der frei getippten Bezeichnung. Die Datenbank prueft dieselbe Zahl. */
export const PASSKEY_NAME_MAX = 60

/** Ein Passkey in der Liste des eigenen Kontos. Der Schluessel selbst geht nie hinaus. */
export interface PasskeyInfo {
  id: number
  name: string
  /** Synchronisiert (iCloud, Google), kann also das Geraet verlassen. */
  backedUp: boolean
  createdAt: string
  lastUsedAt: string | null
}

/**
 * Antwort auf die Anforderung einer Herausforderung. `options` ist das JSON
 * fuer `navigator.credentials.create()` bzw. `.get()`; `challengeId` geht mit
 * der Antwort des Browsers zurueck.
 */
export interface PasskeyOptionen<T = Record<string, unknown>> {
  challengeId: string
  options: T
}
