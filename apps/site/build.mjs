/**
 * Baut die oeffentliche Seite unter staygrid.cloud.
 *
 * Absichtlich ohne Werkzeug: die Seite ist eine Handvoll HTML-Dateien mit
 * gemeinsamem Kopf und Fuss, und jede Abhaengigkeit hier waere eine mehr im
 * `pnpm audit`, nur um zwei Textbausteine einzusetzen. Die Datenschutz-
 * erklaerung steht in den Stores von Apple und Google verlinkt; was sie
 * ausliefert, soll ohne Bauwerkzeug nachzulesen sein.
 *
 * Kopf und Fuss stehen einmal in `src/teile/`, nicht in jeder Seite: zwei
 * Fassungen desselben Impressum-Links laufen auseinander, und eine davon
 * ist irgendwann falsch.
 *
 * Jede Seite wird ein Ordner mit `index.html` (`datenschutz.html` ->
 * `datenschutz/index.html`). Die Seite liegt auf dem Plesk-Host, nicht auf
 * unserer Maschine, und so findet jeder Webserver `/datenschutz` ohne
 * Umschreiberegel -- die Adresse steht in App Store und Google Play und
 * darf nicht davon abhaengen, ob dort mod_rewrite an ist.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const hier = dirname(fileURLToPath(import.meta.url))
const quelle = join(hier, 'src')
const ziel = join(hier, 'dist')

rmSync(ziel, { recursive: true, force: true })
mkdirSync(ziel, { recursive: true })

const teile = {}
for (const datei of readdirSync(join(quelle, 'teile'))) {
  teile[datei.replace(/\.html$/, '')] = readFileSync(join(quelle, 'teile', datei), 'utf8')
}

function seiten(ordner) {
  return readdirSync(ordner).flatMap(name => {
    const pfad = join(ordner, name)
    return statSync(pfad).isDirectory() ? seiten(pfad) : name.endsWith('.html') ? [pfad] : []
  })
}

for (const pfad of seiten(join(quelle, 'seiten'))) {
  const html = readFileSync(pfad, 'utf8').replace(/<!--#(\w[\w-]*)-->/g, (_, name) => {
    // Ein vertippter Baustein soll den Bau abbrechen, nicht eine Seite
    // ohne Impressum-Link ausliefern.
    if (!(name in teile)) throw new Error(`Baustein ${name} fehlt (${relative(quelle, pfad)})`)
    return teile[name]
  })
  const rel = relative(join(quelle, 'seiten'), pfad)
  const aus = /^(index|404)\.html$/.test(rel) ? join(ziel, rel)
    : join(ziel, rel.replace(/\.html$/, ''), 'index.html')
  mkdirSync(dirname(aus), { recursive: true })
  writeFileSync(aus, html)
}

for (const name of ['.htaccess', 'stil.css', 'icon.svg', 'apple-touch-icon.png', 'bilder']) {
  cpSync(join(quelle, name), join(ziel, name), { recursive: true })
}
console.log('Seite gebaut:', relative(process.cwd(), ziel))
