import type { JSX } from 'react'
import type { HousekeepingState, PlanPayment, PlanPaymentState } from '@hotelpms/contracts'
import { REINIGUNG, REINIGUNG_TEXT, ZAHLUNG, ZAHLUNG_TEXT, zahlungsTitel, balkenTitel,
         personenzahl, type BalkenAngaben } from '../lib/planStatus.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'

/**
 * Die beiden kleinen Zeichen im Belegungsplan und ihre Legende.
 *
 * Eigene Datei, damit der Plan selbst nur die Stelle kennt, an der ein
 * Zeichen steht, und nicht, wie es aussieht -- und weil am Plan mehrere
 * zugleich arbeiten.
 */

/**
 * Reinigungsstand an der Zimmernummer.
 *
 * `role="img"` mit Namen, weil das Zeichen allein fuer einen Bildschirmleser
 * "schwarzes Dreieck" hiesse. Ohne Recht (`housekeeping:read`) fehlt das
 * Feld, und dann steht hier nichts -- auch kein "unbekannt", das wie ein
 * Zustand aussaehe.
 */
export function ReinigungsZeichen({ stand }: { stand: HousekeepingState | undefined })
  : JSX.Element | null {
  const t = useT()
  if (stand === undefined) return null
  const text = t('ps.hk.title', { status: t(REINIGUNG_TEXT[stand]) })
  const z = REINIGUNG[stand]
  // "Belegt" ohne Zeichen, aber mit Titel: Begruendung an REINIGUNG.
  if (z === null) return <span className="sr-only">{text}</span>
  return (
    <span role="img" aria-label={text} title={text}
          className={`shrink-0 text-xs leading-none ${z.farbe}`}>
      {z.symbol}
    </span>
  )
}

/**
 * Zahlungsstand am Balken. Der Titel des Balkens traegt die Betraege; hier
 * steht nur, **dass** es etwas zu sagen gibt.
 */
export function ZahlungsZeichen({ zahlung }: { zahlung: PlanPayment | null | undefined })
  : JSX.Element | null {
  const t = useT()
  if (zahlung === null || zahlung === undefined) return null
  const z = ZAHLUNG[zahlung.state]
  if (z === null) return null
  return (
    <span role="img" aria-label={t(ZAHLUNG_TEXT[zahlung.state])}
          className={`inline-block align-middle mr-1 px-0.5 rounded-xs bg-white ring-1
                      text-[10px] leading-[14px] font-semibold tabular-nums ${z.farbe}`}>
      {z.symbol}
    </span>
  )
}

/** Der Titel eines Balkens, in der Sprache des Betrachters. */
export function useBalkenTitel(): (r: BalkenAngaben, zusatz?: string) => string {
  const t = useT()
  const locale = useLocale()
  return (r, zusatz) => balkenTitel(r, t, {
    geld: cent => formatMoney(cent, locale),
    datum: iso => formatDate(iso, locale)
  }, zusatz)
}

/**
 * Die Legende, rechts neben der des Reservierungszustands.
 *
 * Nur, was der Benutzer auch zu sehen bekommt: ohne Folio-Recht fehlt der
 * Zahlungsstand im Plan, und eine Legende fuer Zeichen, die nie erscheinen,
 * liesse nach ihnen suchen.
 */
export function PlanStatusLegende({ reinigung, zahlung }: {
  reinigung: boolean; zahlung: boolean
}): JSX.Element {
  const t = useT()
  const hk: HousekeepingState[] = ['dirty', 'clean', 'inspected']
  const pay: PlanPaymentState[] = ['open', 'requested', 'deposit', 'partial', 'paid']
  return (
    <>
      {reinigung && (
        <span className="flex items-center gap-2" title={t('ps.legend.hk')}>
          <span className="text-neutral-400">{t('ps.legend.hk')}:</span>
          {hk.map(s => (
            <span key={s} className="flex items-center gap-1">
              <span aria-hidden className={REINIGUNG[s]?.farbe}>{REINIGUNG[s]?.symbol}</span>
              {t(REINIGUNG_TEXT[s])}
            </span>
          ))}
        </span>
      )}
      {zahlung && (
        <span className="flex items-center gap-2" title={t('ps.legend.pay')}>
          <span className="text-neutral-400">{t('ps.legend.pay')}:</span>
          {pay.map(s => (
            <span key={s} className="flex items-center gap-1">
              <span aria-hidden
                    className={`px-0.5 rounded-xs bg-white ring-1 text-[10px] leading-[14px]
                                font-semibold ${ZAHLUNG[s]?.farbe ?? ''}`}>
                {ZAHLUNG[s]?.symbol}
              </span>
              {t(ZAHLUNG_TEXT[s])}
            </span>
          ))}
        </span>
      )}
    </>
  )
}

/**
 * Der Zahlungsstand im Seitenfenster, mit Betraegen.
 *
 * Aus dem Aufruf des Plans und nicht neu geholt: das Fenster liegt ueber
 * dem Plan, und dieselbe Zahl zweimal aus zwei Abfragen zu zeigen hiesse,
 * nach jeder Zahlung fuer einen Moment zwei verschiedene zu sehen. Die
 * Einzelheiten -- Positionen, Vermerke, Anzahlungsrechnung -- stehen im
 * Folio, einen Klick weiter.
 */
export function ZahlungsStand({ zahlung }: { zahlung: PlanPayment | null | undefined })
  : JSX.Element | null {
  const t = useT()
  const locale = useLocale()
  if (zahlung === null || zahlung === undefined) return null
  const zeilen = zahlungsTitel(zahlung, t, cent => formatMoney(cent, locale)).split('\n')
  return (
    <section className="bg-neutral-50 rounded-sm p-3 text-sm" data-zahlungsstand>
      <div className="flex items-center gap-2 font-medium">
        <ZahlungsZeichen zahlung={zahlung} />
        {zeilen[0]}
      </div>
      <ul className="mt-1 text-xs text-neutral-600 space-y-0.5">
        {zeilen.slice(1).map(z => <li key={z}>{z}</li>)}
      </ul>
    </section>
  )
}

/**
 * Die Personenzahl am Balken, "2 P.".
 *
 * Ganz rechts im Balken, ausserhalb des Teils, den `truncate` kuerzt: die
 * Zahl soll stehen bleiben, auch wenn vom Namen nur drei Buchstaben uebrig
 * sind. Erst stand sie vor dem Namen und schob ihn aus der Flucht der
 * Spalte (Sven, 04.10.2026). `ml-auto` haelt sie am Rand, auch wenn der
 * Name kurz ist, damit die Zahlen untereinander stehen.
 * Fett, damit das Auge sie beim Ueberfliegen einer Spalte vom Namen trennt.
 */
export function PersonenZeichen({ r }: {
  r: { guest_count: number | null; occupants: number; status: string
       adults: number | null; children: number | null }
}): JSX.Element | null {
  const t = useT()
  const n = personenzahl(r)
  if (n === null) return null
  const titel = r.adults !== null && r.children !== null && r.children > 0
    ? t('ps.personsSplit', { n, a: r.adults, k: r.children })
    : n === 1 ? t('ps.personOne') : t('ps.personsTitle', { n })
  return (
    <span title={titel} aria-label={titel}
          className="ml-auto shrink-0 pl-1 font-semibold tabular-nums">
      {t('ps.persons', { n })}
    </span>
  )
}
