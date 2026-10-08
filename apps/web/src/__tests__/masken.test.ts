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
      .sort()
    /*
     * Die eine Ausnahme ist die Detailsuche (Strg+K), und sie ist keine
     * Maske: kein Titel, keine Knopfleiste, nur ein Feld und eine Liste. Sie
     * steht oben und nicht in der Mitte, weil die Liste mit jedem Anschlag
     * waechst und schrumpft -- mittig ausgerichtet sprang das Feld dabei auf
     * und ab, unter dem Cursor weg.
     *
     * Die zweite ist die Seite "Neue Buchung" des Kassenbuchs am Telefon:
     * keine Maske ueber dem Bildschirm, sondern eine ganze Seite ohne Rand,
     * damit das Belegfoto die volle Breite hat (Sven, 07.10.2026). Eine
     * Kastenbreite gibt es dort nicht, die hier auseinanderlaufen koennte.
     *
     * Die dritte ist das Ruhebild am Gaesteterminal: ebenfalls keine Maske,
     * sondern der ganze Bildschirm, solange niemand etwas ausfuellt.
     */
    expect(eigene).toEqual(['components/Detailsuche.tsx', 'components/Dialog.tsx',
                            'components/Ruhebild.tsx', 'components/mobil/MobilKasse.tsx'])
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
    expect(dialog).toContain('useEscape(onClose)')
  })

  it('haengt Escape nicht daran, ob ein Klick daneben schliesst', () => {
    /*
     * Beides hing einmal an demselben Schalter, und damit war der
     * Check-in die eine Maske, die auf Escape nicht hoerte. Ein Griff, der
     * ueberall hilft und an einer Stelle nicht, ist schlechter als keiner:
     * wer nicht mehr weiss, wo er ist, drueckt genau dort weiter.
     *
     * Der Klick daneben bleibt gesperrt -- er ist ein Ausrutscher, Escape
     * ist eine Entscheidung.
     */
    expect(dialog).not.toMatch(/if \(!nebenbeiSchliessen\) return/)
    expect(dialog).toContain('onClick={nebenbeiSchliessen ? onClose : undefined}')
  })

  it('laesst den Check-in nicht nebenbei zuklappen', () => {
    /*
     * Waehrend der Gast am Terminal das Meldeformular ausfuellt, zeigt der
     * Dialog den Stand des Auftrags. Ein Klick neben den Rand waere er los,
     * und die Rezeption saehe nicht, wann der Schein steht.
     */
    const checkin = readFileSync(join(SRC, 'routes', 'CheckIn.tsx'), 'utf8')
    expect(checkin).toContain('nebenbeiSchliessen={false}')
  })

  it('laesst "Nur einchecken" ohne Meldeschein zu', () => {
    /*
     * Der Ausweg hing an derselben Sperre wie "Einchecken und AVS-Datei" --
     * die verlangt einen Meldeschein. Solange das Formular noch ans Terminal
     * gehen sollte, war "Nur einchecken" deshalb tot und sah klickbar aus
     * (Sven, 08.10.2026).
     */
    const checkin = readFileSync(join(SRC, 'routes', 'CheckIn.tsx'), 'utf8')
    const sperre = checkin.match(/const nurEincheckenGesperrt = ([^\n]+)/)?.[1] ?? ''
    expect(sperre).not.toBe('')
    expect(sperre).not.toContain('angemeldet')
    expect(sperre).not.toContain('unterschriftOffen')
    expect(checkin).toContain('disabled={nurEincheckenGesperrt}')
    // Ein gesperrter leiser Knopf muss auch so aussehen.
    const dialog = readFileSync(join(SRC, 'components', 'Dialog.tsx'), 'utf8')
    expect(dialog).toMatch(/KNOPF_LEISE = [^;]*disabled:opacity/)
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

/**
 * Escape ist ueberall der Weg hinaus -- und nimmt genau eine Lage.
 *
 * Gemeldet wurde das als "ich habe drei Zimmer markiert, das Menue
 * aufgemacht, Escape gedrueckt, und jetzt ist alles weg". Jede Lage horchte
 * fuer sich am Fenster; solange nur eine offen war, ging das gut, und
 * sobald zwei uebereinanderlagen, schlossen beide.
 */
describe('Escape nimmt die oberste Lage', () => {
  const escape = readFileSync(join(SRC, 'lib', 'tasten.ts'), 'utf8')

  it('haelt einen Stapel und gibt den Druck nur nach oben', () => {
    expect(escape).toContain('const stapel: Array<() => void> = []')
    expect(escape).toContain('const oben = stapel[stapel.length - 1]')
  })

  it('haengt genau einen Horcher ans Fenster', () => {
    // Nicht die Ersparnis ist der Punkt: das ist die einzige Stelle, an
    // der die Reihenfolge entschieden wird. Zwanzig Horcher entscheiden
    // sie gar nicht.
    expect(escape.match(/addEventListener/g)).toHaveLength(1)
    expect(escape).toContain('if (!horcht) {')
  })

  it('meldet sich nicht bei jedem Bild neu an', () => {
    /*
     * Sonst legte sich die Lage jedes Mal **ueber** eine Maske, die
     * laengst darueber liegt -- und Escape schloesse den Plan darunter
     * statt der Maske davor. Der Rueckruf liegt deshalb im `ref` und die
     * Anmeldung haengt nur an `aktiv`.
     */
    expect(escape).toContain('halter.current = onEscape')
    expect(escape).toContain('}, [aktiv])')
  })

  it('raeumt sich beim Abhaengen aus dem Stapel', () => {
    // `lastIndexOf` und nicht `indexOf`: zwei Lagen koennen denselben
    // Rueckruf tragen, und wer geht, ist die obere.
    expect(escape).toContain('stapel.lastIndexOf(eintrag)')
  })

  it('haelt ein Ankreuzfeld nicht fuer eine Texteingabe', () => {
    /*
     * Enter und Strg+Z gehoeren dem Feld, in dem jemand tippt -- aber nur
     * dort. Mit einer Pruefung auf `HTMLInputElement` allein war Strg+Z
     * tot, sobald jemand den Planungsmodus angeklickt hatte: das
     * Ankreuzfeld behaelt den Fokus, und gebraucht wird die Taste genau
     * dann.
     */
    expect(escape).toContain("const OHNE_TEXT = new Set(['checkbox'")
    expect(escape).toContain('return !OHNE_TEXT.has(ziel.type)')
    expect(escape).toContain('ziel.isContentEditable')
  })

  it('benutzen alle Lagen, die sich schliessen lassen', () => {
    /*
     * Die vollstaendige Liste ist der Punkt: eine Lage mit eigenem Horcher
     * ist genau der Fehler, um den es hier geht, und faellt an ihr selbst
     * nicht auf -- sondern an der Lage darunter.
     */
    for (const [datei, ordner] of [['Dialog.tsx', 'components'],
                                   ['Kontextmenue.tsx', 'components'],
                                   ['Hauswahl.tsx', 'components'],
                                   ['ReservationPanel.tsx', 'components'],
                                   ['TapeChart.tsx', 'components']] as const) {
      const quelle = readFileSync(join(SRC, ordner, datei), 'utf8')
      expect(quelle, datei).toContain('useEscape(')
      expect(quelle, datei).not.toContain("e.key === 'Escape'")
    }
  })
})

/**
 * Nach dem Anlegen ist alles getan (Sven, 05.10.2026).
 *
 * Die Maske blieb offen und zeigte "angelegt" neben einem Knopf "Zurueck"
 * -- ein Klick, der nichts mehr entschied. Jetzt schliesst sie sich, und
 * der Balken im Plan ist die Bestaetigung.
 */
describe('Buchungsmasken schliessen nach dem Anlegen', () => {
  for (const datei of ['BookingDialog.tsx', 'GroupBookingDialog.tsx']) {
    it(datei, () => {
      const quelle = readFileSync(join(SRC, 'components', datei), 'utf8')
      expect(quelle).toMatch(/onSuccess: onClose/)
      expect(quelle).not.toContain('buchen.isSuccess ?')
    })
  }
})
