/**
 * Ein eingetippter Name, aufgeteilt in Nach- und Vorname.
 *
 * **Warum es das gibt.** In der Buchungsmaske genügt es, den Namen ins
 * Gastfeld zu tippen und zu speichern; findet sich kein Gast, legt die
 * Maske ihn selbst an. Vorher verlangte sie dafür zwei Klicks mehr („neuer
 * Gast", „anlegen"), und wer sie nicht kannte, stand vor einem gesperrten
 * Knopf, obwohl der Name doch dastand.
 *
 * Die Regeln sind die, nach denen an der Rezeption geschrieben wird:
 *
 * - „Meier, Max" -- mit Komma steht der Nachname vorn. So steht es auf
 *   Listen und Meldescheinen.
 * - „Max Meier" -- ohne Komma ist das letzte Wort der Nachname.
 * - „Hans von der Meier" -- klein geschriebene Wörter vor dem letzten
 *   gehören zum Nachnamen. Das erste Wort bleibt immer Vorname, sonst würde
 *   aus „max meier" ein Gast ohne Vornamen namens „max meier".
 * - „Meier" -- ein Wort ist der Nachname. Mehr weiß die Rezeption in dem
 *   Moment oft nicht, und mehr zu verlangen hieße, sie zum Erfinden zu
 *   bringen.
 *
 * Liegt die Aufteilung daneben, ist das im Gastprofil eine Korrektur, keine
 * verlorene Buchung -- und die Maske zeigt vor dem Speichern, wie sie
 * aufteilt.
 */
export interface GastName {
  lastName: string
  firstName?: string
}

export function nameAufteilen(text: string): GastName | null {
  const sauber = text.replace(/\s+/g, ' ').trim()
  if (sauber === '') return null

  const komma = sauber.indexOf(',')
  if (komma >= 0) {
    const nach = sauber.slice(0, komma).trim()
    const vor = sauber.slice(komma + 1).replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
    if (nach === '') return vor === '' ? null : nameAufteilen(vor)
    return vor === '' ? { lastName: nach } : { lastName: nach, firstName: vor }
  }

  const woerter = sauber.split(' ')
  if (woerter.length === 1) return { lastName: sauber }

  let beginn = woerter.length - 1
  while (beginn > 1 && istKlein(woerter[beginn - 1]!)) beginn--
  return {
    lastName: woerter.slice(beginn).join(' '),
    firstName: woerter.slice(0, beginn).join(' ')
  }
}

/** So, wie die Maske einen Gast überall sonst zeigt: „Meier, Max". */
export function gastNameAnzeige(name: GastName): string {
  return name.firstName ? `${name.lastName}, ${name.firstName}` : name.lastName
}

function istKlein(wort: string): boolean {
  const erstes = wort.charAt(0)
  return erstes !== erstes.toUpperCase() && erstes === erstes.toLowerCase()
}
