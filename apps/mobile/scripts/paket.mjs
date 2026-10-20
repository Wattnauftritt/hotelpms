// Packt `www` als signiertes Paket fuer die Aktualisierung ohne Store (Plan
// app/plan.md §4). Laeuft beim Ausrollen auf der Maschine (deploy.sh):
//
//   HOTELPMS_APP_PAKET_SCHLUESSEL=<pfad.pem> node scripts/paket.mjs <ziel>
//
// Legt in <ziel> `<stand>.zip` und `paket.json` ab. Die App liest
// `paket.json`, laedt das Zip und prueft die Signatur selbst
// (`@capawesome/capacitor-live-update`, SHA256withRSA ueber die Datei);
// ohne gueltige Signatur nimmt sie es nicht an.
//
// **Der Schluessel liegt nur auf der Maschine, und dort nicht fuer die API.**
// Wer ihn hat, kann Code in jede installierte App legen, der dort bleibt,
// auch nachdem der Server wieder sauber ist -- mehr als ein Einbruch in die
// API sonst bewirkt. Die Units von API und Worker sperren die Datei deshalb
// aus (`InaccessiblePaths`), und signiert wird nur hier, aus dem Stand, den
// der Git-Tag `produktion` vorgibt.
//
// Ohne Paket von Dritten, aus demselben Grund wie play.mjs: ein Zip ohne
// Verzeichnisse ist drei feste Satzarten, und ein Werkzeug mit dem
// Schluessel in der Hand soll keinen fremden Code mitbringen. Zeitstempel
// und Reihenfolge sind fest, damit derselbe Stand dasselbe Paket ergibt.
import { createHash, createSign } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const www = fileURLToPath(new URL('../www/', import.meta.url))
const [ziel] = process.argv.slice(2)
if (!ziel) throw new Error('Aufruf: paket.mjs <zielverzeichnis>')
const schluesselPfad = process.env.HOTELPMS_APP_PAKET_SCHLUESSEL
if (!schluesselPfad) throw new Error('HOTELPMS_APP_PAKET_SCHLUESSEL fehlt')

// www.mjs legt Stand und Fassung der Bruecke daneben ab.
const { stand, huelle } = JSON.parse(readFileSync(join(www, 'stand.json'), 'utf8'))
if (!/^[0-9a-f]{7,40}$/.test(stand)) throw new Error(`Stand ohne Commit: ${stand}`)
if (!Number.isInteger(huelle)) throw new Error('stand.json ohne Fassung der Huelle')

function dateien(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? dateien(join(dir, e.name)) : [join(dir, e.name)])
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// 1.1.1980 00:00, der kleinste Wert, den das Format kennt.
const ZEIT = 0
const DATUM = (1 << 5) | 1

const lokal = []
const zentral = []
let versatz = 0
// Ohne Quellkarten: sie sind die Haelfte des Pakets, und am Telefon liest
// sie niemand.
const pfade = dateien(www).filter(p => !p.endsWith('.map')).sort()
for (const pfad of pfade) {
  const name = Buffer.from(relative(www, pfad).split(sep).join('/'))
  const daten = readFileSync(pfad)
  const gepackt = deflateRawSync(daten, { level: 9 })
  const crc = crc32(daten)

  const kopf = Buffer.alloc(30)
  kopf.writeUInt32LE(0x04034b50, 0)
  kopf.writeUInt16LE(20, 4)         // benoetigte Fassung
  kopf.writeUInt16LE(0x0800, 6)     // Namen in UTF-8
  kopf.writeUInt16LE(8, 8)          // deflate
  kopf.writeUInt16LE(ZEIT, 10)
  kopf.writeUInt16LE(DATUM, 12)
  kopf.writeUInt32LE(crc, 14)
  kopf.writeUInt32LE(gepackt.length, 18)
  kopf.writeUInt32LE(daten.length, 22)
  kopf.writeUInt16LE(name.length, 26)
  lokal.push(kopf, name, gepackt)

  const eintrag = Buffer.alloc(46)
  eintrag.writeUInt32LE(0x02014b50, 0)
  eintrag.writeUInt16LE(20, 4)
  eintrag.writeUInt16LE(20, 6)
  eintrag.writeUInt16LE(0x0800, 8)
  eintrag.writeUInt16LE(8, 10)
  eintrag.writeUInt16LE(ZEIT, 12)
  eintrag.writeUInt16LE(DATUM, 14)
  eintrag.writeUInt32LE(crc, 16)
  eintrag.writeUInt32LE(gepackt.length, 20)
  eintrag.writeUInt32LE(daten.length, 24)
  eintrag.writeUInt16LE(name.length, 28)
  eintrag.writeUInt32LE(versatz, 42)
  zentral.push(eintrag, name)

  versatz += kopf.length + name.length + gepackt.length
}
const verzeichnis = Buffer.concat(zentral)
const ende = Buffer.alloc(22)
ende.writeUInt32LE(0x06054b50, 0)
ende.writeUInt16LE(pfade.length, 8)
ende.writeUInt16LE(pfade.length, 10)
ende.writeUInt32LE(verzeichnis.length, 12)
ende.writeUInt32LE(versatz, 16)
const zip = Buffer.concat([...lokal, verzeichnis, ende])

const signatur = createSign('RSA-SHA256').update(zip).sign(readFileSync(schluesselPfad), 'base64')

mkdirSync(ziel, { recursive: true })
const datei = `${stand}.zip`
writeFileSync(join(ziel, datei), zip)
// `huelle`: die Fassung der Huelle, die die Bruecke in diesem Paket
// braucht. Eine aeltere App laedt es nicht und bittet um den Store.
writeFileSync(join(ziel, 'paket.json'), JSON.stringify({
  stand, huelle, datei,
  pruefsumme: createHash('sha256').update(zip).digest('hex'),
  signatur
}) + '\n')
console.log(`App-Paket ${stand} (Huelle ${huelle}, ${pfade.length} Dateien, ${zip.length} Bytes)`)
