import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Der Rahmen, in dem jede Maske steht.
 *
 * Geprueft wird nicht, wie er aussieht -- ein Test, der eine Kastenbreite
 * festhaelt, bricht bei jeder Gestaltungsaenderung und faengt nie einen
 * Fehler. Geprueft wird, was bei einer Maske Geld oder Arbeit kostet: dass
 * die Knoepfe nicht wegrollen, dass niemand seinen eigenen Rahmen baut, und
 * dass ausgerechnet der Check-in sich nicht nebenbei zuklappen laesst.
 */

const SRC = join(import.meta.dirname, '..')

function quellen(verzeichnis: string): string[] {
  return readdirSync(verzeichnis).flatMap(name => {
    const pfad = join(verzeichnis, name)
    if (statSync(pfad).isDirectory()) return quellen(pfad)
    return name.endsWith('.tsx') ? [pfad] : []
  })
}

describe('Der Rahmen einer Maske', () => {
  const dialog = readFileSync(join(SRC, 'components', 'Dialog.tsx'), 'utf8')

  it('baut keine Maske mehr ihren eigenen Rahmen', () => {
    /*
     * Vorher trug jede Maske ihre eigene Umrandung, und alle waren
     * `max-w-md` -- 448 Pixel, auf einem Rezeptionsbildschirm etwa ein
     * Fuenftel der Breite. Weil die Breite an sechs Stellen stand, aendert
     * sie niemand an sechs Stellen; sie bleibt, bis es eine Stelle gibt.
     */
    const eigene = quellen(SRC)
      .filter(p => readFileSync(p, 'utf8').includes('fixed inset-0'))
      .map(p => p.slice(SRC.length + 1))
    expect(eigene).toEqual(['components/Dialog.tsx'])
  })

  it('haelt die Knopfleiste ausserhalb des rollenden Teils', () => {
    /*
     * Vorher rollte der ganze Kasten. Bei einer langen Maske standen
     * "Buchen" und "Schliessen" unterhalb des sichtbaren Bereichs -- und wer
     * eine Maske fuer fertig haelt, sucht keinen Knopf, den er nicht sieht.
     * Gemeldet wurde das als "ich klicke und es passiert nichts".
     */
    expect(dialog).toContain('<footer')
    // Gerollt wird der Rumpf, nicht der Kasten.
    expect(dialog).toContain('grow overflow-y-auto')
  })

  it('schliesst mit Escape', () => {
    // Den Weg mit der Maus gab es, den mit der Tastatur nicht. An einer
    // Rezeption liegt die Hand auf der Tastatur.
    expect(dialog).toContain("e.key === 'Escape'")
  })

  it('laesst den Check-in nicht nebenbei zuklappen', () => {
    /*
     * Im Kasten steht eine gezeichnete Unterschrift, die nirgends
     * gespeichert ist. Ein Klick neben den Rand waere sie los, und der Gast
     * unterschriebe ein zweites Mal.
     */
    const checkin = readFileSync(join(SRC, 'routes', 'CheckIn.tsx'), 'utf8')
    expect(checkin).toContain('nebenbeiSchliessen={false}')
  })
})

describe('Die Gruppenmaske zeigt die Tage jedes Zimmers', () => {
  const gruppe = readFileSync(
    join(SRC, 'components', 'GroupBookingDialog.tsx'), 'utf8')

  it('stellt die Datumsfelder in jede Zeile, nicht hinter einen Knopf', () => {
    /*
     * Hinter einem Knopf "eigene Tage" standen sie, weil acht Zeilen mit je
     * zwei Datumsfeldern nicht in 448 Pixel passten. In einer breiten
     * Tabelle passen sie -- und dann verbirgt das Aufklappen nur, was
     * ohnehin jeder sehen will.
     */
    expect(gruppe).toContain("tagSetzen(z.resourceId, 'arrival', e.target.value)")
    expect(gruppe).toContain("tagSetzen(z.resourceId, 'departure', e.target.value)")
  })

  it('haelt im Zustand trotzdem nur die Abweichungen', () => {
    /*
     * Eine Zeile, die niemand angefasst hat, hat keinen Eintrag und zeigt
     * die Tage der Gruppe. Das ist der Unterschied zwischen "erbt" und "ist
     * zufaellig gleich": wer oben den Zeitraum verschiebt, nimmt die
     * erbenden Zimmer mit und laesst die abweichenden stehen.
     */
    expect(gruppe).toContain('const jetzt = v[resourceId] ?? { arrival, departure }')
    expect(gruppe).toContain('delete rest[z.resourceId]')
  })
})
