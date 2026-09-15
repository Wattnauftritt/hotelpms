import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ChannelView, RateGrid, RatePlan, SetRates,
              SetRestrictions } from '@hotelpms/contracts'
import { api } from '../api.js'
import { addDays } from '../dates.js'

/**
 * Preise und Restriktionen.
 *
 * **Ein Aufruf für das ganze Jahr.** `rate-grid` liefert bis zu 400 Tage mal
 * allen Ratenplänen in einer Anfrage; genau dafür ist der Endpunkt gebaut.
 * Wer hier je Tag oder je Plan nachlädt, macht aus einer Runde vierhundert
 * (P-Gesetz, Dokument 04).
 */

/** Die Obergrenze des Endpunkts. Mehr nimmt er nicht an. */
export const MAX_RASTER_TAGE = 400

/**
 * Die Tage eines Rasters, **einschließlich** des letzten.
 *
 * `eachDay` in `lib/dates.ts` zählt Nächte und lässt den letzten Tag weg --
 * richtig für einen Aufenthalt, falsch für ein Preisraster: der 31. Dezember
 * ist ein Tag mit einem Preis, kein Abreisetag. Der Endpunkt rechnet ebenso
 * einschließlich, und eine Abweichung um einen Tag fiele erst auf, wenn an
 * Silvester kein Preis steht.
 */
export function tageInklusive(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export const useRatePlans = (propertyId: number) =>
  useQuery<{ ratePlans: RatePlan[] }>({
    queryKey: ['ratePlans', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/rate-plans`),
    // Ratenplaene aendern sich im Betrieb selten; die Preise darin taeglich.
    staleTime: 5 * 60_000
  })

export const useRateGrid = (
  propertyId: number, from: string, to: string, categoryId: number | null
) =>
  useQuery<RateGrid>({
    queryKey: ['rateGrid', propertyId, from, to, categoryId],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/rate-grid?from=${from}&to=${to}`
      + (categoryId === null ? '' : `&categoryId=${categoryId}`)),
    staleTime: 30_000
  })

/**
 * Preise setzen.
 *
 * Danach ist das Raster ungültig, und die abgeleiteten Raten sind es auch --
 * sie hängen an dieser Basis und werden erst durch `rebuild-derived` neu
 * gerechnet. Deshalb wird das ganze Raster verworfen und nicht nur die
 * geänderte Zeile.
 */
export function useSetRates(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SetRates) =>
      api.put<{ ratePlanId: number; days: number }>('/v1/rates/bulk', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] }) }
  })
}

/**
 * Einen Ratenplan anlegen.
 *
 * Abgeleitet oder eigenstaendig: eine abgeleitete Rate traegt ihre Preise
 * nicht als Formel, sondern materialisiert -- sonst kostete jede
 * Verfuegbarkeitsanfrage eine rekursive Aufloesung ueber die Kette. Nach dem
 * Anlegen steht sie deshalb **leer** da, bis einmal neu gerechnet wurde.
 */
export function useCreateRatePlan(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      code: string; name: string; categoryId: number
      baseRatePlanId?: number; deriveKind?: 'amount' | 'percent'; deriveValue?: number
    }) => api.post<{ ratePlanId: number; ratePlanRef: string }>(
      `/v1/properties/${propertyId}/rate-plans`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ratePlans', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] })
    }
  })
}

/** Abgeleitete Raten fuer einen Zeitraum neu rechnen. */
export function useRebuildDerived(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      api.post<{ plans: number; days: number }>(
        '/v1/rates/rebuild-derived', { propertyId, ...body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] }) }
  })
}

export function useSetRestrictions(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SetRestrictions) =>
      api.put<{ ratePlanId: number; days: number }>('/v1/restrictions/bulk', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] }) }
  })
}

// -------------------------------------- Was der Channel Manager sieht (B10)

/**
 * Dieselbe Antwort, die der Channel Manager bekommt.
 *
 * **Das Ende ist ausschliesslich, nicht einschliesslich.** ARI zaehlt
 * Naechte: `from` bis `to` sind die Naechte dazwischen, und der letzte Tag
 * gehoert nicht dazu. Das Raster daneben zeigt Tage einschliesslich.
 * Beides ungeprueft zu verbinden heisst, dass der letzte Tag des Zeitraums
 * in der Gegenueberstellung fehlt -- und genau dieser Tag ist es dann, an
 * dem beim Portal ein anderer Preis steht.
 */
export function kanalZeitraum(von: string, bis: string): { from: string; to: string } {
  return { from: von, to: addDays(bis, 1) }
}

export const useChannelView = (
  propertyId: number, von: string, bis: string, aktiv: boolean
) =>
  useQuery<ChannelView>({
    queryKey: ['channelView', propertyId, von, bis],
    queryFn: () => {
      const { from, to } = kanalZeitraum(von, bis)
      return api.get(`/v1/properties/${propertyId}/channel-view?from=${from}&to=${to}`)
    },
    enabled: aktiv,
    // Was hinausgeht, aendert sich mit jeder Preispflege. Kurz gehalten,
    // damit die Gegenueberstellung nicht einen alten Stand zeigt.
    staleTime: 10_000
  })
