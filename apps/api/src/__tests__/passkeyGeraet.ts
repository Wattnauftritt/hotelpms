import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { passkeyPartei } from '../platform/passkey.js'

/**
 * Ein Passkey aus Software, fuer die Tests der Passkey-Routen (0207) und
 * der Freigabe im Claude-Zugang (0222). Baut, was ein Telefon baut --
 * Schluesselpaar, Authenticator-Daten, CBOR, Unterschrift --, damit die
 * echte Pruefung der Bibliothek laeuft und nicht eine Attrappe davon.
 */

// ---------------------------------------------------------------- CBOR, knapp
function kopf(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b
}
function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? kopf(0, v) : kopf(1, -1 - v)
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([kopf(3, b.length), b]) }
  if (Buffer.isBuffer(v)) return Buffer.concat([kopf(2, v.length), v])
  if (v instanceof Map) {
    return Buffer.concat([kopf(5, v.size), ...[...v].flatMap(([k, w]) => [cbor(k), cbor(w)])])
  }
  throw new Error('nicht unterstuetzt')
}
const b64u = (b: Buffer): string => b.toString('base64url')
export const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest()

/** Ein Passkey aus Software, mit Pruefung des Benutzers. */
export class Geraet {
  readonly credId = randomBytes(16)
  readonly privat: KeyObject
  readonly oeffentlich: KeyObject
  zaehler = 0
  constructor(readonly herkunft = passkeyPartei().origin,
              readonly rpId = passkeyPartei().rpID) {
    const p = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privat = p.privateKey
    this.oeffentlich = p.publicKey
  }

  private coseSchluessel(): Buffer {
    const jwk = this.oeffentlich.export({ format: 'jwk' })
    return cbor(new Map<number, unknown>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]))
  }

  anlegen(options: { challenge: string; user: { id: string } }): unknown {
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.create', challenge: options.challenge, origin: this.herkunft,
      crossOrigin: false }))
    const laenge = Buffer.alloc(2); laenge.writeUInt16BE(this.credId.length)
    const authData = Buffer.concat([
      sha256(this.rpId), Buffer.from([0x45]) /* UP, UV, AT */, Buffer.alloc(4),
      Buffer.alloc(16), laenge, this.credId, this.coseSchluessel()])
    this.benutzer = options.user.id
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(cbor(new Map<string, unknown>([
          ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
        transports: ['internal']
      }
    }
  }

  benutzer = ''

  anmelden(challenge: string, flags = 0x05 /* UP, UV */): unknown {
    this.zaehler++
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge, origin: this.herkunft, crossOrigin: false }))
    const z = Buffer.alloc(4); z.writeUInt32BE(this.zaehler)
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([flags]), z])
    const signatur = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privat)
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData), authenticatorData: b64u(authData),
        signature: b64u(signatur), userHandle: this.benutzer
      }
    }
  }
}
