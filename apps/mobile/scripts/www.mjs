// Setzt `www` fuer Capacitor zusammen: der Bau der Oberflaeche fuer die App
// (`apps/web`, `--mode app`) und davor die Bruecke (`src/bruecke.ts`).
//
// Die Bruecke steht als erstes Modul im Kopf der Seite. Module laufen in der
// Reihenfolge, in der sie im Dokument stehen; damit ist
// `window.staygridNative` gesetzt, bevor die Oberflaeche zum ersten Mal
// danach fragt.
//
// Beide Baue lesen dieselbe Herkunft der Schnittstelle aus `STAYGRID_API`:
// die Policy der Seite und die Bruecke muessen uebereinstimmen.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hier = fileURLToPath(new URL('../', import.meta.url))
const web = fileURLToPath(new URL('../../web/', import.meta.url))
const api = process.env.STAYGRID_API ?? 'https://app.staygrid.cloud'

// Der Stand, aus dem gebaut wird. Beim Ausrollen kommt er von deploy.sh,
// denn ein Release-Verzeichnis ist ein `git archive` ohne Geschichte. Die
// App vergleicht ihn mit dem Paket auf dem Server; derselbe Stand wird
// nicht noch einmal geladen.
const stand = process.env.STAYGRID_STAND
  ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hier, encoding: 'utf8' }).trim()

// Die Aktualisierung ohne Store laeuft nur mit oeffentlichem Schluessel
// (capacitor.config.ts). Ohne ihn naehme das Werkzeug ein Paket auch
// unsigniert an; dann soll die Bruecke gar nicht erst danach fragen.
const paket = existsSync(`${hier}paket-schluessel.pem`) ? '1' : ''

const env = {
  ...process.env, STAYGRID_API: api, VITE_STAYGRID_API: api,
  VITE_STAYGRID_STAND: stand, VITE_STAYGRID_PAKET: paket
}
const lauf = (cwd, ...args) => execFileSync('pnpm', args, { cwd, env, stdio: 'inherit' })

lauf(web, 'run', 'build:app')
lauf(hier, 'exec', 'vite', 'build')

const www = `${hier}www`
rmSync(www, { recursive: true, force: true })
cpSync(`${web}dist-app`, www, { recursive: true })
cpSync(`${hier}dist-bruecke/bruecke.js`, `${www}/bruecke.js`)

const seite = readFileSync(`${www}/index.html`, 'utf8')
const stelle = seite.indexOf('<script type="module"')
if (stelle < 0) throw new Error('index.html ohne Modul: Bau der Oberflaeche pruefen')
writeFileSync(`${www}/index.html`,
  seite.slice(0, stelle) + '<script type="module" src="/bruecke.js"></script>\n    '
  + seite.slice(stelle))

// Fuer scripts/paket.mjs: welche Fassung der Huelle diese Bruecke braucht.
const huelle = Number(/const HUELLE = (\d+)/.exec(readFileSync(`${hier}src/bruecke.ts`, 'utf8'))?.[1])
if (!Number.isInteger(huelle)) throw new Error('HUELLE in src/bruecke.ts nicht gefunden')
writeFileSync(`${www}/stand.json`, JSON.stringify({ stand, huelle }) + '\n')
console.log(`www fuer ${api} zusammengesetzt, Stand ${stand.slice(0, 7)}`)
