import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkinLink, checkinTokenAusFragment, istAuslaendisch, istUnterschriftSvg }
  from '@hotelpms/contracts'
import { checkinAusAdresse } from '../routes/GastCheckin.tsx'

/**
 * Die Gastseite des Online-Check-ins (Dokument 30).
 *
 * Quelltextbasiert wie die anderen Tests der Oberflaeche: eine DOM-Umgebung
 * ist hier nicht eingerichtet. Geprueft wird, was still schiefginge --
 * dass die Seite die Anwendung nicht ersetzt, wo sie nicht gemeint ist; dass
 * nichts vom Gast im Browser liegen bleibt; und dass Maske und Schnittstelle
 * dieselbe Unterschrift fuer gueltig halten.
 */

const quelle = (datei: string): string =>
  readFileSync(join(import.meta.dirname, '..', datei), 'utf8')

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456'

describe('Gastseite aus der Adresse', () => {
  it('erkennt den Link aus der Mail, das Token im Fragment', () => {
    const link = checkinLink('https://app.staygrid.test/', TOKEN)
    expect(link).toBe(`https://app.staygrid.test/checkin#${TOKEN}`)
    const url = new URL(link)
    expect(checkinAusAdresse(url.pathname, url.hash)).toEqual({ token: TOKEN })
    // Das Token steht nicht in Pfad oder Abfrage, also in keinem Protokoll.
    expect(url.pathname + url.search).not.toContain(TOKEN)
  })

  it('laesst jeden anderen Pfad in Ruhe', () => {
    expect(checkinAusAdresse('/', '')).toBeNull()
    expect(checkinAusAdresse('/checkins', `#${TOKEN}`)).toBeNull()
    expect(checkinAusAdresse('/einladung', `#${TOKEN}`)).toBeNull()
  })

  it('nimmt ein verstuemmeltes Token nicht als Token', () => {
    expect(checkinAusAdresse('/checkin/', `#${TOKEN.slice(0, 30)}`)).toEqual({ token: null })
    expect(checkinTokenAusFragment('')).toBeNull()
  })
})

describe('Nichts bleibt im Browser', () => {
  const seite = quelle('routes/GastCheckin.tsx')
  const ohneKommentare = seite.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('legt weder Token noch Gastdaten im Speicher des Browsers ab', () => {
    expect(ohneKommentare).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
  })

  it('haelt Gastdaten nicht im Zwischenspeicher der Abfragen', () => {
    // TanStack Query behielte die Antwort nach dem Schliessen noch Minuten;
    // am Terminal steht danach der Naechste vor demselben Browser.
    expect(ohneKommentare).not.toMatch(/useQuery|useMutation|queryClient/i)
  })

  it('fuehrt nirgends nach aussen', () => {
    // Am Terminal gibt es keinen Weg aus der Seite heraus, und per Mail
    // braucht der Gast keinen.
    expect(ohneKommentare).not.toMatch(/href=|window\.open|target="_blank"/)
  })

  it('bietet kein Feld fuer eine Ausweiskopie an', () => {
    expect(ohneKommentare).not.toMatch(/type="file"|FileReader|capture=/)
  })

  it('steht in main.tsx vor der Anmeldung', () => {
    const main = quelle('main.tsx')
    const gast = main.indexOf('if (gastCheckin !== null)')
    expect(gast).toBeGreaterThan(0)
    expect(gast).toBeLessThan(main.indexOf("queryKey: ['me']"))
  })
})

describe('Maske und Schnittstelle sind sich einig', () => {
  it('zeichnet genau die Unterschrift, die die Schnittstelle annimmt', () => {
    const feld = quelle('components/Unterschriftsfeld.tsx')
    // Die Vorlage aus dem Zeichenfeld, mit Werten eingesetzt.
    const m = /onChange\(`(<svg[^`]*)`\s*\+\s*`([^`]*)`\s*\+\s*`([^`]*)`\)/.exec(feld)
    expect(m).not.toBeNull()
    const svg = (m![1]! + m![2]! + m![3]!)
      .replaceAll('${canvas.width}', '720').replaceAll('${canvas.height}', '240')
      .replace('${png}', 'data:image/png;base64,iVBORw0KGgo=')
    expect(istUnterschriftSvg(svg)).toBe(true)
  })

  it('entscheidet "auslaendisch" nach Staatsangehoerigkeit, hilfsweise nach Wohnsitz', () => {
    expect(istAuslaendisch({ nationality: 'DE', country: 'AT' })).toBe(false)
    expect(istAuslaendisch({ nationality: 'TR', country: 'DE' })).toBe(true)
    expect(istAuslaendisch({ nationality: null, country: 'NL' })).toBe(true)
    expect(istAuslaendisch({ nationality: null, country: null })).toBe(false)
  })

  it('fragt am Tresen dieselbe Regel ab', () => {
    expect(quelle('routes/CheckIn.tsx')).toContain('istAuslaendisch(')
  })
})
