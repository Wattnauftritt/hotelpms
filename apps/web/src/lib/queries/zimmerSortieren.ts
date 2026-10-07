import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Zimmer sortieren: die Einstellung des Hauses (Migration 0103).
 *
 * `weights` ist nur die Abweichung des Hauses, `effective` das, womit
 * gerechnet wird. Die Maske zeigt die Vorgabe als Platzhalter; ein leeres
 * Feld heisst "Vorgabe", nicht "null" -- so kommt eine spaeter verbesserte
 * Vorgabe auch bei einem Haus an, das sie nie abgeschrieben hat.
 */
export type SortierModus = 'off' | 'manual' | 'auto'

export interface SortierWunsch { keyword: string; attribute: string }

export type SortierGewichte = Record<string, number | string | SortierWunsch[]>

export interface SortierEinstellung {
  configured: boolean
  mode: SortierModus
  keepToday: boolean
  weights: SortierGewichte
  effective: SortierGewichte & { wishes: SortierWunsch[] }
}

export const useSortierEinstellung = (propertyId: number) =>
  useQuery<SortierEinstellung>({
    queryKey: ['room-sort-settings', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/room-sort-settings`)
  })

export function useSortierEinstellungSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { mode: SortierModus; keepToday: boolean; weights: SortierGewichte }) =>
      api.put<SortierEinstellung>(`/v1/properties/${propertyId}/room-sort-settings`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['room-sort-settings', propertyId] })
    }
  })
}
