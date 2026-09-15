import { describe, it, expect } from 'vitest'
import { zugangAusAdresse } from '../routes/Zugang.tsx'
import { kennwortZuKurz, KENNWORT_MIN } from '@hotelpms/contracts'

/**
 * Die Auswertung der Adresse, ueber die Einladung und Kennwortruecksetzung
 * gefunden werden.
 *
 * Warum das geprueft gehoert: gibt diese Funktion faelschlich etwas zurueck,
 * ersetzt die Zugangsseite die **ganze** Anwendung -- sie steht in main.tsx
 * vor allem anderen, auch vor der Frage, wer angemeldet ist. Ein zu
 * grosszuegiger Vergleich waere damit kein Schoenheitsfehler, sondern ein
 * Ausfall der Rezeption.
 */

describe('Zugang aus der Adresse', () => {
  it('laesst jeden anderen Pfad in Ruhe', () => {
    expect(zugangAusAdresse('/', '')).toBeNull()
    expect(zugangAusAdresse('/', '?property=1&screen=tape')).toBeNull()
    // Kein Praefixvergleich: sonst faenge /kennwortliste die Anwendung ab.
    expect(zugangAusAdresse('/kennwortliste', '?token=x')).toBeNull()
    expect(zugangAusAdresse('/einladungen', '')).toBeNull()
  })

  it('erkennt Einladung und Ruecksetzung samt Token', () => {
    expect(zugangAusAdresse('/einladung', '?token=abc'))
      .toEqual({ art: 'invite', token: 'abc' })
    expect(zugangAusAdresse('/kennwort', '?token=abc'))
      .toEqual({ art: 'reset', token: 'abc' })
  })

  it('vertraegt einen abschliessenden Schraegstrich', () => {
    // Kommt aus Mailprogrammen haeufiger vor, als man denkt.
    expect(zugangAusAdresse('/kennwort/', '?token=abc'))
      .toEqual({ art: 'reset', token: 'abc' })
  })

  it('behandelt ein leeres Token wie keines', () => {
    // Sonst liefe der Benutzer in ein Formular, das beim Absenden sicher
    // scheitert -- und bei der Ruecksetzung ist "kein Token" ohnehin der
    // richtige Fall: dann wird einer angefordert.
    expect(zugangAusAdresse('/kennwort', '?token=')).toEqual({ art: 'reset', token: null })
    expect(zugangAusAdresse('/kennwort', '')).toEqual({ art: 'reset', token: null })
  })

  it('gibt ein Token mit Sonderzeichen unveraendert weiter', () => {
    // base64url enthaelt - und _; wer hier zu streng liest, macht aus jedem
    // zweiten Link einen ungueltigen.
    const token = 'aB3-_xY9zQ'
    expect(zugangAusAdresse('/einladung', `?token=${token}`)?.token).toBe(token)
  })
})

describe('Kennwortregel', () => {
  it('misst die Laenge und sonst nichts', () => {
    expect(kennwortZuKurz('x'.repeat(KENNWORT_MIN - 1))).toBe(true)
    expect(kennwortZuKurz('x'.repeat(KENNWORT_MIN))).toBe(false)
    // Keine Regeln ueber Zeichenarten: ein langer, merkbarer Satz genuegt.
    expect(kennwortZuKurz('richtiges pferd batterie klammer')).toBe(false)
    // Und ein kurzes Kunstwort mit allem Drum und Dran genuegt nicht.
    expect(kennwortZuKurz('Passwort1!')).toBe(true)
  })

  it('zaehlt Zeichen, nicht Speichereinheiten', () => {
    // Mit .length zaehlte ein Emoji als zwei -- ein Kennwort abzulehnen, das
    // die Regel erfuellt, ist schwer zu erklaeren; eines anzunehmen, das sie
    // verfehlt, ist schlimmer.
    expect(kennwortZuKurz('🔑'.repeat(KENNWORT_MIN - 1))).toBe(true)
    expect(kennwortZuKurz('🔑'.repeat(KENNWORT_MIN))).toBe(false)
  })
})
