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
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hier = fileURLToPath(new URL('../', import.meta.url))
const web = fileURLToPath(new URL('../../web/', import.meta.url))
const api = process.env.STAYGRID_API ?? 'https://app.staygrid.cloud'
const env = { ...process.env, STAYGRID_API: api, VITE_STAYGRID_API: api }
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
console.log(`www fuer ${api} zusammengesetzt`)
