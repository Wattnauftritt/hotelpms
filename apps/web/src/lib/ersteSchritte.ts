import { createContext } from 'react'
import type { SetupStatus } from '@hotelpms/contracts'
import { centAusEingabe } from './preisraster.js'

/**
 * Erste Schritte: der Assistent für ein leeres Haus.
 *
 * Hier steht, was sich ohne Bildschirm prüfen lässt -- wann der Assistent
 * erscheint und wie aus den Zeilen der Maske die Nutzlast wird. Beides sind
 * Stellen, an denen ein Fehler nicht wie ein Fehler aussieht: ein Assistent,
 * der bei jedem Login wieder aufgeht, oder ein Preis, der als 129 Cent statt
 * 129 Euro ankommt.
 */

/** Eine Zeile der Maske: eine Zimmerart mit ihren Nummern und ihrem Preis. */
export interface ArtZeile {
  code: string
  name: string
  personen: number
  anzahl: number
  /** Erste Nummer der Serie. */
  ab: number
  /** Vorsatz vor der Nummer, etwa "App " für "App 1". */
  vorsatz: string
  /** Grundpreis je Nacht, wie eingetippt. Leer heißt: keine Rate. */
  preis: string
}

export interface FirstSetupBody {
  propertyId: number
  categories: Array<{
    code: string; name: string; maxOccupancy: number
    rooms: { prefix?: string; from: number; count: number }
    priceCent?: number
  }>
  ratePlanName?: string
  commit: boolean
}

export interface FirstSetupReport {
  dryRun: boolean
  categories: Array<{ code: string; name: string; maxOccupancy: number; rooms: string[]
                      ratePlanCode: string | null; priceCent: number | null }>
  roomCount: number
  ratePlanCount: number
  pricedFrom: string | null
  pricedTo: string | null
  created?: { categories: number; rooms: number; ratePlans: number; pricedDays: number
              inventoryDays: number }
}

/**
 * Der Bildschirm der Datenübernahme aus einem Altsystem. Wer von einem
 * anderen Programm kommt, legt seine Zimmer nicht von Hand an, sondern bringt
 * sie mit. Gibt es den Bildschirm (noch) nicht oder darf der Benutzer ihn
 * nicht sehen, entfällt der Hinweis.
 */
export const IMPORT_BILDSCHIRM = 'import'

/**
 * Ist das Haus leer?
 *
 * **Leer heißt: keine Zimmerart und kein Zimmer.** Nicht "nicht buchbar":
 * ein Haus, dem nur der Bestand fehlt, hat jemand schon eingerichtet, und
 * ihm einen Assistenten vorzusetzen, der alles von vorn anlegen will, wäre
 * Bevormundung. Der Assistent ist für den ersten Login, nicht für Lücken --
 * die zeigt der Einrichtungsstand.
 */
export function hausIstLeer(status: SetupStatus): boolean {
  const zahl = (key: string): number => status.steps.find(s => s.key === key)?.count ?? 0
  return zahl('categories') === 0 && zahl('rooms') === 0
}

/** Die Nummern einer Zeile, so wie die Schnittstelle sie bilden wird. */
export function zimmerNummern(z: Pick<ArtZeile, 'ab' | 'anzahl' | 'vorsatz'>): string[] {
  if (!Number.isInteger(z.ab) || !Number.isInteger(z.anzahl) || z.anzahl < 1) return []
  return Array.from({ length: Math.min(z.anzahl, 1000) },
                    (_, i) => `${z.vorsatz}${z.ab + i}`)
}

/**
 * Was an den Zeilen noch fehlt, bevor die Schnittstelle gefragt wird.
 *
 * Nur das, was man beim Hinsehen sieht -- leere Felder, ein Preis, der keine
 * Zahl ist. Doppelte Nummern gegen den Bestand prüft die Vorschau der
 * Schnittstelle; zwei Fassungen derselben Prüfung liefen auseinander.
 */
export function zeilenLuecken(zeilen: readonly ArtZeile[]): number[] {
  return zeilen.flatMap((z, i) =>
    z.code.trim() === '' || z.name.trim() === '' || z.anzahl < 1 || z.personen < 1
      || (z.preis.trim() !== '' && centAusEingabe(z.preis) === null)
      ? [i] : [])
}

/**
 * Aus den Zeilen die Nutzlast. Der Preis kommt als Cent, nie als Euro mit
 * Komma (Geld, CLAUDE.md); ohne Recht auf Preise fällt er ganz weg, sonst
 * weist die Schnittstelle die ganze Einrichtung ab.
 */
export function nutzlast(
  propertyId: number, zeilen: readonly ArtZeile[], ratenName: string,
  mitPreisen: boolean, commit: boolean
): FirstSetupBody {
  return {
    propertyId,
    categories: zeilen.map(z => {
      const cent = mitPreisen ? centAusEingabe(z.preis) : null
      return {
        code: z.code.trim(),
        name: z.name.trim(),
        maxOccupancy: z.personen,
        rooms: { ...(z.vorsatz === '' ? {} : { prefix: z.vorsatz }),
                 from: z.ab, count: z.anzahl },
        ...(cent === null ? {} : { priceCent: cent })
      }
    }),
    ...(ratenName.trim() === '' ? {} : { ratePlanName: ratenName.trim() }),
    commit
  }
}

/**
 * Öffnet den Assistenten von einem Bildschirm aus.
 *
 * Der Assistent hängt am Rahmen und nicht an einem Bildschirm: er erscheint
 * von selbst, wo immer der Benutzer landet, und muss einen Bildschirmwechsel
 * überleben. Die Einrichtung öffnet ihn über diesen Weg erneut, ohne eine
 * zweite Fassung von ihm zu halten.
 */
export const ErsteSchritteContext = createContext<{ oeffnen: () => void } | null>(null)
