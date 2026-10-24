import type { PasskeyInfo, PasskeyOptionen } from '@hotelpms/contracts'
import { nativ } from '@hotelpms/native'
import { api } from './api.js'

/**
 * Passkeys im Browser (Migration 0207).
 *
 * Die Schnittstelle liefert die Optionen als JSON, wie WebAuthn sie
 * beschreibt; Herausforderung und Kennungen stehen darin als base64url. Der
 * Browser will Bytes. Hier steht nur diese Uebersetzung, in beide
 * Richtungen, und sonst nichts -- die Pruefung macht die Schnittstelle.
 *
 * Ohne Bibliothek: `PublicKeyCredential.parseCreationOptionsFromJSON` naehme
 * genau das ab, fehlt aber in Safari vor 18.4 und in Firefox vor 119, und an
 * einer Rezeption laeuft der Browser, der vor drei Jahren installiert wurde.
 */

function zuBytes(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

function zuText(buf: ArrayBuffer | null): string | undefined {
  if (buf === null) return undefined
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Kann dieser Browser Passkeys, und sind wir im Browser?
 *
 * In der eigenen App nicht: die WebView laeuft unter einer anderen Herkunft
 * als app.staygrid.cloud, und ein Passkey dieser Domain gilt dort nicht. Die
 * App schuetzt sich mit Fingerabdruck oder Gesicht des Telefons.
 */
export function passkeyMoeglich(): boolean {
  return nativ() === undefined
    && typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function'
    && typeof navigator.credentials?.get === 'function'
}

/** Hat der Benutzer den Dialog des Browsers abgebrochen? Dann ist das kein Fehler. */
export function abgebrochen(err: unknown): boolean {
  return err instanceof DOMException
    && (err.name === 'NotAllowedError' || err.name === 'AbortError')
}

interface ErstellOptionen {
  challenge: string
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  timeout?: number
  excludeCredentials?: Array<{ id: string; type: 'public-key'; transports?: string[] }>
  authenticatorSelection?: AuthenticatorSelectionCriteria
  attestation?: AttestationConveyancePreference
}

interface AnfrageOptionen {
  challenge: string
  rpId?: string
  timeout?: number
  userVerification?: UserVerificationRequirement
  allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: string[] }>
}

/**
 * Herausforderung holen, den Browser nach dem Passkey fragen und die Antwort
 * an `ziel` schicken. Anmeldung und Bestaetigung unterscheiden sich nur in
 * den beiden Adressen.
 */
async function passkeyVorlegen(optionenUrl: string, ziel: string): Promise<void> {
  const { challengeId, options } = await api.post<PasskeyOptionen<AnfrageOptionen>>(optionenUrl)
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: zuBytes(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentials: (options.allowCredentials ?? []).map(c => ({
        id: zuBytes(c.id), type: c.type,
        transports: c.transports as AuthenticatorTransport[] | undefined }))
    }
  }) as PublicKeyCredential | null
  if (cred === null) throw new DOMException('kein Passkey', 'NotAllowedError')
  const r = cred.response as AuthenticatorAssertionResponse
  await api.post(ziel, {
    challengeId,
    response: {
      id: cred.id,
      rawId: zuText(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: zuText(r.clientDataJSON),
        authenticatorData: zuText(r.authenticatorData),
        signature: zuText(r.signature),
        userHandle: zuText(r.userHandle)
      }
    }
  })
}

/**
 * Mit Passkey anmelden. Der Browser fragt selbst, welcher Passkey es sein
 * soll; eine Adresse muss vorher niemand tippen.
 */
export function mitPasskeyAnmelden(): Promise<void> {
  return passkeyVorlegen('/v1/auth/passkey/login/options', '/v1/auth/passkey/login')
}

/** Eine kritische Handlung mit einem eigenen Passkey bestaetigen (0209). */
export function mitPasskeyBestaetigen(): Promise<void> {
  return passkeyVorlegen('/v1/auth/passkey/confirm/options', '/v1/auth/passkey/confirm')
}

/**
 * Einen Passkey fuer das eigene Konto anlegen. Das aktuelle Kennwort geht
 * mit, weil eine offene Sitzung allein nicht genuegt (siehe Schnittstelle).
 */
export async function passkeyAnlegen(currentPassword: string, name: string): Promise<PasskeyInfo> {
  const { challengeId, options } = await api.post<PasskeyOptionen<ErstellOptionen>>(
    '/v1/auth/passkey/register/options', { currentPassword })
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: zuBytes(options.challenge),
      rp: options.rp,
      user: { id: zuBytes(options.user.id), name: options.user.name,
              displayName: options.user.displayName },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      excludeCredentials: (options.excludeCredentials ?? []).map(c => ({
        id: zuBytes(c.id), type: c.type,
        transports: c.transports as AuthenticatorTransport[] | undefined })),
      authenticatorSelection: options.authenticatorSelection,
      attestation: options.attestation
    }
  }) as PublicKeyCredential | null
  if (cred === null) throw new DOMException('kein Passkey', 'NotAllowedError')
  const r = cred.response as AuthenticatorAttestationResponse
  return api.post<PasskeyInfo>('/v1/auth/passkey/register', {
    challengeId,
    name,
    response: {
      id: cred.id,
      rawId: zuText(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: zuText(r.clientDataJSON),
        attestationObject: zuText(r.attestationObject),
        // Ohne die Transportwege bietet der Browser den Passkey spaeter
        // nicht ueber Bluetooth oder USB an, nur auf diesem Geraet.
        transports: typeof r.getTransports === 'function' ? r.getTransports() : undefined
      }
    }
  })
}
