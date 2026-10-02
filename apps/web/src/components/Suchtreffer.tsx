import type { JSX } from 'react'
import type { SearchCustomerHit, SearchReservationHit } from '@hotelpms/contracts'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { marke, MARKEN } from '../lib/suche.js'

/**
 * Eine Trefferzeile der Suche -- dieselbe im Plan und hinter Strg+K.
 *
 * Zwei Listen, die dieselbe Reservierung verschieden zeigen, lehren die
 * Rezeption zweimal lesen. Die Zeile im Plan ist nur kuerzer (`knapp`).
 */

function name(nach: string | null, vor: string | null): string {
  return [nach, vor].filter(x => x !== null && x !== '').join(', ')
}

export function Statusmarke({ hit }: { hit: Pick<SearchReservationHit, 'status' | 'past'> }
): JSX.Element {
  const t = useT()
  const m = MARKEN[marke(hit)]
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${m.farbe}`}>
      {t(m.text)}
    </span>
  )
}

export function ReservierungsTreffer({ hit, knapp = false }: {
  hit: SearchReservationHit; knapp?: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <div className="min-w-0 grow">
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-medium">
          {name(hit.lastName, hit.firstName) || t('tape.noGuest')}
        </span>
        <Statusmarke hit={hit} />
        {/* Die Nummer rechts und in Festbreite: sie wird abgelesen und
            verglichen, Zeichen fuer Zeichen, mit dem Zettel in der Hand. */}
        {!knapp && (
          <span className="ml-auto shrink-0 font-mono text-xs text-neutral-500">
            {hit.reservationRef}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-neutral-500 min-w-0">
        <span className="shrink-0 tabular-nums">
          {formatDate(hit.arrival, locale)} – {formatDate(hit.departure, locale)}
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0">
          {hit.roomCode ?? t('suche.noRoom')} · {hit.categoryCode}
        </span>
        {/*
          * Die Begleitpersonen stehen in der Zeile, nicht erst im Detail:
          * wer "Anna" sucht und bei "Petersen, Jan" landet, muss sehen,
          * warum -- sonst haelt er den Treffer fuer einen Fehler der Suche.
          */}
        {hit.companions.length > 0 && (
          <span className={`truncate ${hit.matchedBy === 'companion'
                                        ? 'text-neutral-800 font-medium' : ''}`}>
            · {t('suche.with', { namen: hit.companions.join(', ') })}
          </span>
        )}
        {knapp && (
          <span className="ml-auto shrink-0 font-mono">{hit.reservationRef}</span>
        )}
        {!knapp && hit.externalReference !== null && hit.matchedBy === 'number' && (
          <span className="ml-auto shrink-0 font-mono">{hit.externalReference}</span>
        )}
      </div>
    </div>
  )
}

export function KundenTreffer({ hit }: { hit: SearchCustomerHit }): JSX.Element {
  const t = useT()
  const kontakt = [hit.email, hit.phone, hit.city].filter(x => x !== null && x !== '')
  return (
    <div className="min-w-0 grow">
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-medium">
          {hit.kind === 'guest' ? name(hit.name, hit.firstName) : hit.name}
        </span>
        {hit.kind === 'company' && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] bg-neutral-100
                           text-neutral-700">
            {t('suche.company')}
          </span>
        )}
        {hit.inHouse && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium
                           bg-emerald-100 text-emerald-900">
            {t('suche.inHouse')}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-neutral-500 tabular-nums">
          {t('suche.reservations', { n: hit.reservations })}
        </span>
      </div>
      {kontakt.length > 0 && (
        <div className="truncate text-xs text-neutral-500">{kontakt.join(' · ')}</div>
      )}
    </div>
  )
}
