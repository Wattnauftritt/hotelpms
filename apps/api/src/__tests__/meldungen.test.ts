import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MESSAGE_KEYS, isMessageKey, renderMessage } from '@hotelpms/contracts'

/**
 * Der Test, der die Uebersetzung vollstaendig haelt.
 *
 * Ein Meldungskatalog verfaellt auf zwei Weisen, und beide still: jemand
 * schreibt einen deutschen Satz direkt in einen `Errors.*`-Aufruf, oder
 * jemand traegt einen Schluessel nur in einer Sprache nach. Das eine faellt
 * erst auf, wenn ein englischsprachiger Benutzer einen deutschen Satz sieht;
 * das andere gar nicht, weil ein fehlender Schluessel unveraendert
 * durchgereicht wird.
 *
 * Deshalb liest dieser Test die **Quelle** und nicht nur den Katalog.
 */

const WURZEL = join(import.meta.dirname, '..')

function quellDateien(verzeichnis: string): string[] {
  return readdirSync(verzeichnis).flatMap(name => {
    const pfad = join(verzeichnis, name)
    if (statSync(pfad).isDirectory()) {
      return name === '__tests__' ? [] : quellDateien(pfad)
    }
    return name.endsWith('.ts') ? [pfad] : []
  })
}

/** Der Rumpf eines Aufrufs, von der oeffnenden bis zur passenden Klammer. */
function argumenteVon(quelle: string, aufruf: RegExp): string[] {
  const rumpfe: string[] = []
  for (const m of quelle.matchAll(aufruf)) {
    const start = m.index + m[0].length
    let i = start
    let tiefe = 1
    while (i < quelle.length && tiefe > 0) {
      if (quelle[i] === '(') tiefe++
      else if (quelle[i] === ')') tiefe--
      i++
    }
    rumpfe.push(quelle.slice(start, i - 1))
  }
  return rumpfe
}

/** Das erste Argument, bis zum Komma auf oberster Ebene. */
function erstesArgument(rumpf: string): string {
  let tiefe = 0
  for (let i = 0; i < rumpf.length; i++) {
    const z = rumpf[i]!
    if ('([{`'.includes(z)) tiefe++
    else if (')]}'.includes(z)) tiefe--
    else if (z === ',' && tiefe === 0) return rumpf.slice(0, i)
  }
  return rumpf
}

/**
 * Die Meldungen eines `Errors.*`-Aufrufs.
 *
 * Nur die Stellen, an denen eine Meldung steht -- nicht die Feldnamen einer
 * Validierung und nicht die Trennzeichen, mit denen eine Liste fuer einen
 * Platzhalter zusammengesetzt wird. Ein Test, der die mitzaehlt, meldet
 * Fehler, die keine sind, und wird abgeschaltet.
 */
function fehlermeldungenIn(quelle: string): string[] {
  const gefunden: string[] = []
  for (const rumpf of argumenteVon(quelle, /Errors\.validation\(/g)) {
    // Feldfehler stehen als Liste hinter dem Feldnamen: `{ code: ['...'] }`.
    for (const liste of erstesArgument(rumpf).matchAll(/\[([^\]]*)\]/g)) {
      for (const lit of liste[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
        gefunden.push(lit[1]!)
      }
    }
  }
  // Nur die Fabriken, deren erstes Argument eine Meldung ist. `rangeTooLarge`
  // nimmt eine Zahl, `soldOut` gar nichts -- sie hier mitzulesen ergaebe
  // Fehler, die keine sind.
  const MIT_MELDUNG =
    /Errors\.(unauthorized|forbidden|notFound|conflict|unprocessable|notConfigured|invalidSignature)\(/g
  for (const rumpf of argumenteVon(quelle, MIT_MELDUNG)) {
    const arg = erstesArgument(rumpf).trim()
    if (arg === '') continue
    const literal = /^'((?:[^'\\]|\\.)*)'$/.exec(arg)
    gefunden.push(literal !== null ? literal[1]! : arg)
  }
  return gefunden
}

/**
 * Die Hinweise: immer das erste Argument.
 *
 * Ein blosser Bezeichner -- `hinweisText(hintKey)` -- faellt heraus: der
 * Schluessel kommt dann von der aufrufenden Stelle, und dort wird er
 * geprueft. Ihn hier zu melden hiesse, jede Weitergabe zu verbieten.
 */
function hinweiseIn(quelle: string): string[] {
  return argumenteVon(quelle, /hinweisText\(/g).flatMap(r => {
    const arg = erstesArgument(r).trim()
    const literal = /^'((?:[^'\\]|\\.)*)'$/.exec(arg)
    if (literal !== null) return [literal[1]!]
    return /^[A-Za-z_$][\w$]*$/.test(arg) ? [] : [arg]
  })
}

const quellen = quellDateien(WURZEL).map(p => readFileSync(p, 'utf8'))

describe('Meldungskatalog', () => {
  it('uebersetzt jeden Schluessel in beide Sprachen', () => {
    for (const key of MESSAGE_KEYS) {
      const de = renderMessage(key, 'de')
      const en = renderMessage(key, 'en')
      expect(de.length, `${key} hat keinen deutschen Satz`).toBeGreaterThan(0)
      expect(en.length, `${key} hat keinen englischen Satz`).toBeGreaterThan(0)
      // Ein Schluessel, der unveraendert zurueckkommt, steht nicht im
      // Katalog -- dann waere `MESSAGE_KEYS` nicht die Wahrheit.
      expect(de, `${key} faellt auf sich selbst zurueck`).not.toBe(key)
    }
  })

  /**
   * Ein Platzhalter, der nur in einer Sprache steht, ist der teure Fall: der
   * deutsche Satz nennt die Zahl, der englische verschweigt sie, und niemand
   * merkt es, bis ein Gast fragt, wie viele Tage denn erlaubt sind.
   */
  it('haelt die Platzhalter in beiden Sprachen gleich', () => {
    const platzhalter = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort()
    for (const key of MESSAGE_KEYS) {
      expect(platzhalter(renderMessage(key, 'en')), `${key}`)
        .toEqual(platzhalter(renderMessage(key, 'de')))
    }
  })

  it('setzt Werte ein und laesst einen Platzhalter ohne Wert stehen', () => {
    expect(renderMessage('error.rangeTooLarge.detail', 'de', { max: 800 }))
      .toContain('800')
    expect(renderMessage('error.rangeTooLarge.detail', 'en', { max: 800 }))
      .toContain('800')
    // Ein Loch im Satz waere schlimmer als ein sichtbarer Platzhalter.
    expect(renderMessage('error.rangeTooLarge.detail', 'de')).toContain('{max}')
  })
})

describe('Die Quelle benutzt nur Schluessel', () => {
  /**
   * Kein deutscher Satz mehr in einem Fehler. Die Ausnahmen sind benannt und
   * begruendet -- was sie nicht sind, ist stillschweigend erlaubt.
   */
  it('gibt keine Fehlermeldung als deutschen Satz aus', () => {
    const erlaubt = new Set([
      // Durchgereichte Meldungen aus der Fachlogik und von aussen. Sie
      // entstehen dort, wo sie entstehen, und tragen keinen Schluessel.
      'e.message', '(err as Error).message'
    ])
    const uebrig: string[] = []
    for (const quelle of quellen) {
      for (const m of fehlermeldungenIn(quelle)) {
        if (isMessageKey(m) || erlaubt.has(m)) continue
        uebrig.push(m)
      }
    }
    expect(uebrig, 'Diese Meldungen gehoeren in den Katalog').toEqual([])
  })

  it('gibt keinen Hinweis als deutschen Satz aus', () => {
    const uebrig: string[] = []
    for (const quelle of quellen) {
      for (const m of hinweiseIn(quelle)) {
        // Der Einrichtungsstand setzt seinen Schluessel zusammen; der Test
        // prueft die Bestandteile weiter unten.
        if (isMessageKey(m) || m.startsWith('`setup.step.')) continue
        uebrig.push(m)
      }
    }
    expect(uebrig, 'Diese Hinweise gehoeren in den Katalog').toEqual([])
  })

  it('kennt jeden Schritt des Einrichtungsstands', () => {
    for (const schritt of ['categories', 'rooms', 'inventory', 'tax_rules',
                           'rate_plans', 'prices', 'payment_methods',
                           'business_day']) {
      expect(isMessageKey(`setup.step.${schritt}`), schritt).toBe(true)
    }
  })
})
