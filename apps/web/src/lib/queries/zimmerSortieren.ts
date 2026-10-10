import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Zimmer sortieren: die Einstellung des Hauses (Migration 0104).
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

export const useSortierEinstellung = (propertyId: number, enabled = true) =>
  useQuery<SortierEinstellung>({
    queryKey: ['room-sort-settings', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/room-sort-settings`),
    enabled
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

/**
 * Sortieren im Zimmerplan (Migration 0121): erst die Vorschau, dann genau
 * deren Zuege uebernehmen, und ein Lauf laesst sich zuruecknehmen.
 *
 * `basis` ist der Fingerabdruck des Plans zur Zeit der Vorschau. Die API
 * schreibt nichts, wenn sich seitdem etwas geaendert hat -- sonst haette
 * die Rezeption einen Plan bestaetigt, den sie nie gesehen hat.
 */
export interface SortierZug {
  reservationRef: string
  guestName: string | null
  arrival: string
  departure: string
  fromRoomId: number | null
  fromRoomCode: string | null
  toRoomId: number
  toRoomCode: string | null
}

export interface SortierVorschau {
  from: string
  to: string
  basis: string
  moves: SortierZug[]
  unplaced: { reservationRef: string; guestName: string | null
              arrival: string; departure: string }[]
  fixed: number
  costBefore: number
  costAfter: number
}

export function useSortierVorschau(propertyId: number) {
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      api.post<SortierVorschau>(`/v1/properties/${propertyId}/room-sort/preview`, body)
  })
}

export function useSortierenUebernehmen(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: SortierVorschau) =>
      api.post<{ runRef: string; moved: number }>(
        `/v1/properties/${propertyId}/room-sort/apply`,
        { from: v.from, to: v.to, basis: v.basis,
          moves: v.moves.map(m => ({ reservationRef: m.reservationRef, toRoomId: m.toRoomId })) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tape'] }) }
  })
}

export function useSortierenZuruecknehmen(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runRef: string) =>
      api.post<{ runRef: string; undone: number }>(
        `/v1/properties/${propertyId}/room-sort/runs/${runRef}/undo`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tape'] }) }
  })
}
