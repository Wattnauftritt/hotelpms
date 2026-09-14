import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { RateGrid, RatePlan, SetRates, SetRestrictions } from '@hotelpms/contracts'
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

/**
 * Die Rechte dieses Benutzers in diesem Haus.
 *
 * Sie stehen schon in der Antwort von `/v1/auth/me`, die der Rahmen beim
 * Start holt; hier wird nur derselbe Zwischenspeicher gelesen. Das kostet
 * keine zusaetzliche Runde und haelt die Maske ehrlich: wer nur lesen darf,
 * sieht keinen Knopf, der ihm eine 403 antwortet. Die Sicherheit liegt in
 * der API und nirgends sonst -- das hier ist Brauchbarkeit.
 */
export function useRechte(propertyId: number): readonly string[] {
  const me = useQuery<{ properties: Array<{ id: number; permissions: string[] }> }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/auth/me'),
    retry: false
  })
  return me.data?.properties.find(p => p.id === propertyId)?.permissions ?? []
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

export function useSetRestrictions(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SetRestrictions) =>
      api.put<{ ratePlanId: number; days: number }>('/v1/restrictions/bulk', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] }) }
  })
}
