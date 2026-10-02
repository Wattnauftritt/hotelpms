import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { SearchResult, SearchScope } from '@hotelpms/contracts'
import { api } from '../api.js'

/** Ab so vielen Zeichen wird gefragt. Die Schnittstelle weist weniger ab. */
export const SUCHE_MIN_ZEICHEN = 2

/**
 * Die Suche: ein Aufruf je (entprelltem) Tastendruck, nicht je Treffer.
 *
 * `placeholderData: keepPreviousData` haelt die vorige Liste stehen,
 * waehrend die naechste laedt. Ohne das springt die Liste bei jedem
 * Buchstaben auf "laedt" und wieder zurueck, und die Zeile, auf die man
 * gerade zeigen wollte, ist weg.
 *
 * Kein Zwischenspeicher ueber den Bildschirm hinaus (`gcTime` kurz): eine
 * Trefferliste mit Namen soll nicht im Speicher liegen bleiben, wenn der
 * Rechner an der Rezeption den Menschen wechselt.
 */
export const useSuche = (propertyId: number, begriff: string, scope: SearchScope,
                         limit: number, aktiv = true) =>
  useQuery<SearchResult>({
    queryKey: ['suche', propertyId, begriff, scope, limit],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/search?q=${encodeURIComponent(begriff)}`
      + `&scope=${scope}&limit=${limit}`),
    enabled: aktiv && begriff.trim().length >= SUCHE_MIN_ZEICHEN,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    gcTime: 60_000
  })
