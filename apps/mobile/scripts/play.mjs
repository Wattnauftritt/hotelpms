// Laedt ein signiertes App-Bundle in den internen Test von Google Play
// (Freigabelauf `app-freigabe.yml`).
//
// Ohne Paket von Dritten: die Schnittstelle sind vier Aufrufe, und ein
// Werkzeug, das den Schluessel des Dienstkontos in der Hand hat, soll so
// wenig fremden Code wie moeglich mitbringen. Gebraucht wird nur, was Node
// selbst kann: ein signiertes JWT und `fetch`.
//
// Status `completed` im internen Test heisst: die Tester bekommen es sofort.
// Solange die App bei Google noch nie veroeffentlicht war, nimmt Google nur
// Entwuerfe an; dann legt der Lauf einen Entwurf an, und den gibt man einmal
// in der Play Console frei.
//
//   PLAY_SERVICE_ACCOUNT_JSON='…' node scripts/play.mjs <bundle.aab> [name]
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const PAKET = 'cloud.staygrid.app'
const SPUR = 'internal'
const BASIS = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PAKET}`
const HOCH = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PAKET}`

const [bundlePfad, name] = process.argv.slice(2)
if (!bundlePfad) throw new Error('Aufruf: play.mjs <bundle.aab> [name]')
const konto = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON ?? 'null')
if (!konto?.client_email || !konto?.private_key) {
  throw new Error('PLAY_SERVICE_ACCOUNT_JSON fehlt oder ist kein Schluessel eines Dienstkontos')
}

const b64 = s => Buffer.from(s).toString('base64url')

async function zugang() {
  const jetzt = Math.floor(Date.now() / 1000)
  const kopf = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const rumpf = b64(JSON.stringify({
    iss: konto.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: konto.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: jetzt,
    exp: jetzt + 600
  }))
  const signatur = createSign('RSA-SHA256').update(`${kopf}.${rumpf}`).sign(konto.private_key, 'base64url')
  const r = await fetch(konto.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${kopf}.${rumpf}.${signatur}`
    })
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`Anmeldung bei Google abgewiesen: ${j.error_description ?? j.error}`)
  return j.access_token
}

class GoogleFehler extends Error {}

async function aufruf(token, methode, url, rumpf, typ = 'application/json') {
  const r = await fetch(url, {
    method: methode,
    headers: { authorization: `Bearer ${token}`, 'content-type': typ },
    body: rumpf === undefined ? undefined : typ === 'application/json' ? JSON.stringify(rumpf) : rumpf
  })
  const text = await r.text()
  if (!r.ok) throw new GoogleFehler(`${methode} ${url.replace(BASIS, '').replace(HOCH, '')}: ${r.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

async function hochladen(token, status) {
  const edit = await aufruf(token, 'POST', `${BASIS}/edits`, {})
  const bundle = await aufruf(token, 'POST', `${HOCH}/edits/${edit.id}/bundles?uploadType=media`,
    readFileSync(bundlePfad), 'application/octet-stream')
  await aufruf(token, 'PUT', `${BASIS}/edits/${edit.id}/tracks/${SPUR}`, {
    track: SPUR,
    releases: [{ name: name ?? String(bundle.versionCode), versionCodes: [String(bundle.versionCode)], status }]
  })
  await aufruf(token, 'POST', `${BASIS}/edits/${edit.id}:commit`)
  return bundle.versionCode
}

const token = await zugang()
try {
  const code = await hochladen(token, 'completed')
  console.log(`Fassung ${code} im internen Test freigegeben`)
} catch (e) {
  // Eine App, die nie veroeffentlicht war, nimmt nur Entwuerfe an. Die
  // Bearbeitung von eben ist ohne Commit verfallen; neu anfangen.
  if (!(e instanceof GoogleFehler) || !/draft/i.test(e.message)) throw e
  const code = await hochladen(token, 'draft')
  console.log(`Fassung ${code} als Entwurf im internen Test angelegt: in der Play Console freigeben`)
}
