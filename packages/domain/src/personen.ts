import { DomainError } from './domainError.js'

/** Was an Personen in einer Reservierung steht, so wie es gespeichert wird. */
export interface Personen {
  guestCount: number | null
  adults: number | null
  children: number | null
}

/**
 * Personenzahl aus Gesamtzahl oder aus Erwachsenen und Kindern (0076).
 *
 * **Zwei Wege, ein Ergebnis.** Die Rezeption am Telefon kennt oft nur "zu
 * dritt", ein Kanal liefert Erwachsene und Kinder getrennt. Beides ist
 * richtig, und gespeichert wird die Gesamtzahl immer: Kurtaxe und Plan lesen
 * sie und wissen von der Aufteilung nichts. Wer beides schickt, muss
 * dasselbe meinen -- eine Gesamtzahl, die der Summe widerspricht, ist eine
 * Frage, und welche Zahl gilt, gehoert nicht geraten.
 *
 * Kinder ohne Erwachsene ergeben keine Summe und sind fast immer ein
 * vergessenes Feld, nicht eine Reservierung nur fuer Kinder.
 */
export function personenPruefen(body: {
  guestCount?: number; adults?: number; children?: number
}): Personen {
  if (body.guestCount !== undefined
      && (!Number.isInteger(body.guestCount)
          || body.guestCount < 1 || body.guestCount > 99)) {
    throw DomainError.validation({ guestCount: ['field.positiveInteger'] })
  }
  if (body.adults !== undefined
      && (!Number.isInteger(body.adults) || body.adults < 1 || body.adults > 99)) {
    throw DomainError.validation({ adults: ['field.positiveInteger'] })
  }
  if (body.children !== undefined
      && (!Number.isInteger(body.children) || body.children < 0 || body.children > 98)) {
    throw DomainError.validation({ children: ['field.nonNegativeInteger'] })
  }
  if (body.children !== undefined && body.adults === undefined) {
    throw DomainError.validation({ children: ['field.childrenNeedAdults'] })
  }
  if (body.adults === undefined) {
    return { guestCount: body.guestCount ?? null, adults: null, children: null }
  }
  const summe = body.adults + (body.children ?? 0)
  if (summe > 99) throw DomainError.validation({ children: ['field.maxValue'] }, { max: 99 })
  if (body.guestCount !== undefined && body.guestCount !== summe) {
    throw DomainError.validation({ guestCount: ['field.guestCountMismatch'] }, { sum: summe })
  }
  return { guestCount: summe, adults: body.adults, children: body.children ?? null }
}
