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

// ------------------------------------------------- Passkeys in der eigenen App

/**
 * Woran app.staygrid.cloud die eigene App erkennt.
 *
 * Ein Passkey haengt an der Domain. Das Telefon gibt ihn an eine App nur
 * heraus, wenn die Domain diese App ausdruecklich als ihre benennt: Android
 * liest dafuer `/.well-known/assetlinks.json`, iOS
 * `/.well-known/apple-app-site-association`. Beide Dateien erzeugt der Bau
 * der Oberflaeche aus den Werten hier (apps/web/vite.config.ts), und die
 * Schnittstelle nimmt dieselben Werte als zulaessige Herkunft einer Antwort
 * (apps/api/src/platform/passkey.ts). An einer Stelle, weil die beiden
 * Haelften nur zusammen tragen: steht ein Fingerabdruck in der Datei, aber
 * nicht in der Pruefung, bietet das Telefon den Passkey an, und die
 * Anmeldung scheitert trotzdem.
 *
 * Nichts davon ist geheim. Die Dateien sind oeffentlich, und wer sie liest,
 * erfaehrt nur, welche App sich hier anmelden darf.
 */
export const APP_PAKET = 'cloud.staygrid.app'

/**
 * SHA-256 der Zertifikate, mit denen die Android-App auf dem Telefon
 * ankommt, in der Schreibweise der Play Console (`AB:CD:…`). Das ist der
 * **App-Signaturschluessel von Google**, nicht unser Upload-Schluessel:
 * Google signiert jede App aus dem Play Store neu (App-Integritaet →
 * App-Signatur).
 *
 * Android meldet die Herkunft einer Antwort aus einer App nicht als
 * `https://…`, sondern als `android:apk-key-hash:` mit diesem Hash. Eine
 * nachgebaute App mit anderem Schluessel bekommt den Passkey nicht -- das
 * Telefon vergleicht mit assetlinks.json -- und ihre Antwort naehme die
 * Schnittstelle auch nicht an.
 */
export const APP_ANDROID_ZERTIFIKATE: readonly string[] = []

/**
 * Kennung der iOS-App fuer Apple, `TEAMID.cloud.staygrid.app`. Die Team-ID
 * steht erst fest, wenn das Konto im Apple Developer Program bezahlt ist.
 * iOS meldet die Herkunft als `https://app.staygrid.cloud`, wie der Browser;
 * fuer die Schnittstelle aendert sich unter iOS deshalb nichts.
 */
export const APP_APPLE_KENNUNGEN: readonly string[] = []

/** `AB:CD:…` in die Herkunft, die Android in `clientDataJSON` schreibt. */
export function androidHerkunft(sha256: string): string {
  const hex = sha256.replace(/:/g, '')
  if (!/^[0-9A-Fa-f]{64}$/.test(hex)) {
    throw new Error(`Kein SHA-256-Fingerabdruck: ${sha256}`)
  }
  // base64url von Hand: das Paket laeuft in Node und im Browser, und
  // `btoa` wie `Buffer` fehlen je auf einer Seite.
  const zeichen = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16))
  let aus = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const viele = Math.min(4, Math.ceil((bytes.length - i) * 4 / 3))
    for (let k = 0; k < viele; k++) aus += zeichen[(n >> (18 - 6 * k)) & 63]
  }
  return 'android:apk-key-hash:' + aus
}

function mitDoppelpunkten(sha256: string): string {
  androidHerkunft(sha256) // wirft bei allem, was kein SHA-256 ist
  return sha256.replace(/:/g, '').toUpperCase().match(/../g)!.join(':')
}

/**
 * Inhalt von assetlinks.json. Nur `get_login_creds`, nicht
 * `handle_all_urls`: die App soll Passkeys der Domain benutzen duerfen, aber
 * nicht jeden Link auf app.staygrid.cloud an sich ziehen -- ein Link aus
 * einer Mail an die Rezeption soll im Browser aufgehen, wie bisher.
 */
export function assetLinks(zertifikate: readonly string[] = APP_ANDROID_ZERTIFIKATE): unknown[] {
  if (zertifikate.length === 0) return []
  return [{
    relation: ['delegate_permission/common.get_login_creds'],
    target: {
      namespace: 'android_app',
      package_name: APP_PAKET,
      // Mit Doppelpunkten und gross: Android vergleicht die Zeichenkette,
      // nicht die Bytes, und nimmt sonst keinen Eintrag an.
      sha256_cert_fingerprints: zertifikate.map(mitDoppelpunkten)
    }
  }]
}

/** Inhalt von apple-app-site-association: nur Passkeys, keine Universal Links. */
export function appleAppSiteAssociation(
  kennungen: readonly string[] = APP_APPLE_KENNUNGEN
): { webcredentials: { apps: string[] } } {
  return { webcredentials: { apps: [...kennungen] } }
}
