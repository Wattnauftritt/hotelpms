import type { HousekeepingState, PlanPayment, PlanPaymentState } from '@hotelpms/contracts'
import type { TextKey } from './i18n/index.js'

/**
 * Wie der Plan Reinigungs- und Zahlungsstand zeichnet, ohne React.
 *
 * **Farbe und Form, nie Farbe allein.** Rund acht Prozent der Maenner
 * unterscheiden Rot und Gruen schlecht, und genau das waeren "schmutzig"
 * und "sauber", "offen" und "bezahlt". Jeder Zustand hat deshalb ein
 * eigenes Zeichen, das auch in Graustufen eindeutig bleibt, und den Satz in
 * Worten im Titel.
 *
 * Hier und nicht in der Komponente, damit die Zuordnung pruefbar ist: dass
 * zwei Zustaende dasselbe Zeichen bekommen, sieht man auf dem Bildschirm
 * erst, wenn beide nebeneinander stehen.
 */

export interface Zeichen {
  /** Das Symbol selbst. Eindeutig auch ohne Farbe. */
  symbol: string
  /** Tailwind-Klassen fuer die Farbe. */
  farbe: string
}

/**
 * Reinigungsstand an der Zimmernummer.
 *
 * **"Belegt" bekommt kein Zeichen.** Der Zustand entsteht beim Check-in
 * (Trigger aus 0011) und faellt beim Check-out auf "schmutzig" -- er sagt
 * also nichts, was der gruene Balken des angereisten Gastes in derselben
 * Zeile nicht schon sagt. Ein viertes Zeichen an jedem belegten Zimmer
 * waere eine Wiederholung, und Wiederholung macht die Zeichen daneben
 * schwerer zu finden. Im Titel steht der Zustand trotzdem in Worten, damit
 * er nicht verschwindet, wenn er einmal von Hand gesetzt wurde.
 */
export const REINIGUNG: Record<HousekeepingState, Zeichen | null> = {
  dirty: { symbol: '▲', farbe: 'text-red-700' },
  clean: { symbol: '✓', farbe: 'text-emerald-700' },
  inspected: { symbol: '★', farbe: 'text-sky-700' },
  occupied: null
}

/** Das Wort fuer den Zustand -- dasselbe wie auf dem Housekeeping-Bildschirm. */
export const REINIGUNG_TEXT: Record<HousekeepingState,
  'hk.dirty' | 'hk.clean' | 'hk.inspected' | 'hk.occupied'> = {
  dirty: 'hk.dirty', clean: 'hk.clean', inspected: 'hk.inspected', occupied: 'hk.occupied'
}

/**
 * Was das Kontextmenue anbieten darf. "Belegt" setzt der Check-in, nicht
 * ein Mensch -- von Hand gesetzt stuende es an einem leeren Zimmer.
 */
export const REINIGUNG_SETZBAR = ['clean', 'dirty', 'inspected'] as const
export type SetzbarerStand = (typeof REINIGUNG_SETZBAR)[number]

/**
 * Zahlungsstand am Balken.
 *
 * Ein Euro mit einem zweiten Zeichen, weiss hinterlegt: der Balken traegt
 * schon die Farbe des Reservierungszustands (Option, bestaetigt,
 * angereist), und ein farbiges Zeichen direkt darauf verschwaende auf
 * genau einem davon. Bei einer Nacht ist der Balken 44 Pixel breit; zwei
 * Zeichen in zehn Pixel Schrift lassen dem Namen den Rest.
 *
 * `none` hat kein Zeichen: vor dem ersten Nachtlauf schuldet niemand
 * etwas, und ein Zeichen an jeder kuenftigen Buchung waere Laerm.
 */
export const ZAHLUNG: Record<PlanPaymentState, Zeichen | null> = {
  none: null,
  requested: { symbol: '€?', farbe: 'text-neutral-700 ring-neutral-500' },
  open: { symbol: '€!', farbe: 'text-red-700 ring-red-600' },
  partial: { symbol: '€½', farbe: 'text-amber-700 ring-amber-600' },
  deposit: { symbol: '€↓', farbe: 'text-sky-700 ring-sky-600' },
  paid: { symbol: '€✓', farbe: 'text-emerald-700 ring-emerald-600' }
}

export const ZAHLUNG_TEXT: Record<PlanPaymentState, TextKey> = {
  none: 'ps.pay.none',
  requested: 'ps.pay.requested',
  open: 'ps.pay.open',
  partial: 'ps.pay.partial',
  deposit: 'ps.pay.deposit',
  paid: 'ps.pay.paid'
}

type Uebersetzer = (key: TextKey, params?: Record<string, string | number>) => string

/**
 * Der Titel zum Zahlungsstand, eine Zeile je Aussage.
 *
 * Betraege kommen als ganze Cent und werden erst hier formatiert -- mit dem
 * Formatierer der Sprache, nicht mit `toFixed`: der setzt einen Punkt, wo
 * hier ein Komma steht, und rundet ueber Fliesskomma.
 */
export function zahlungsTitel(p: PlanPayment, t: Uebersetzer,
                              geld: (cent: number) => string): string {
  const zeilen = [
    t('ps.pay.title', { state: t(ZAHLUNG_TEXT[p.state]) }),
    t('ps.pay.figures', { paid: geld(p.settled_cent), expected: geld(p.expected_cent),
                          balance: geld(p.balance_cent) })
  ]
  // Eine Nacht eigens: "1 Naechte" liest sich wie ein Fehler, und wer
  // einmal einen Fehler im Titel gesehen hat, traut der Zahl daneben nicht.
  if (p.unposted_nights === 1) zeilen.push(t('ps.pay.unpostedOne'))
  if (p.unposted_nights > 1) zeilen.push(t('ps.pay.unposted', { n: p.unposted_nights }))
  if (p.deposit_cent > 0) zeilen.push(t('ps.pay.depositPart', { amount: geld(p.deposit_cent) }))
  if (p.requested_cent > 0) zeilen.push(t('ps.pay.linkOpen', { amount: geld(p.requested_cent) }))
  if (p.routed) zeilen.push(t('ps.pay.routed'))
  if (p.group !== null) {
    zeilen.push(t('ps.pay.group', { n: p.group.rooms, state: t(ZAHLUNG_TEXT[p.group.state]),
                                    paid: geld(p.group.settled_cent),
                                    expected: geld(p.group.expected_cent) }))
  }
  return zeilen.join('\n')
}

/**
 * Die Zimmer, die ein Eintrag "als sauber markieren" trifft -- alle oder
 * keines.
 *
 * Liegt der Klick in einer Markierung, sind es alle markierten Zimmer, und
 * jedes einmal: eine Mehrfachmarkierung haelt je Zeile einen eigenen
 * Zeitraum, und zweimal dieselbe Zeile ist trotzdem ein Zimmer.
 */
export function reinigungsZiele(
  zimmer: ReadonlyArray<{ resourceId: number; roomCode: string }>
): Array<{ resourceId: number; roomCode: string }> {
  const gesehen = new Set<number>()
  return zimmer.filter(z => {
    if (gesehen.has(z.resourceId)) return false
    gesehen.add(z.resourceId)
    return true
  })
}

/**
 * Welche Zustaende ein Eintrag wert sind.
 *
 * Steht schon jedes betroffene Zimmer auf dem Zustand, aendert der Eintrag
 * nichts und bleibt weg -- ein Menue, das "als sauber markieren" an einem
 * sauberen Zimmer anbietet, laesst zweifeln, ob die Anzeige stimmt.
 */
export function angeboteneStaende(
  staende: ReadonlyArray<HousekeepingState | undefined>
): SetzbarerStand[] {
  return REINIGUNG_SETZBAR.filter(s => !staende.every(x => x === s))
}
