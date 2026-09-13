import { useQuery, useMutation, useQueryClient, type UseQueryResult }
  from '@tanstack/react-query'
import type { TapeChart, DailySheet, HousekeepingBoard, Category, Room,
              SetupStatus, RoomSeries, RoomSeriesReport, CreateCategory,
              HousekeepingState } from '@hotelpms/contracts'
import { api } from './api.js'
import { cacheRead, cacheWrite } from './offline.js'

/**
 * Ein Aufruf je Bildschirm, nicht je Zeile.
 *
 * Die Endpunkte sind bewusst Aggregate: der Zimmerplan kommt in einer
 * Anfrage, das Tagesgeschäft in einer, der Zimmerstatus in einer. Die
 * Oberfläche darf diese Bündelung nicht wieder auflösen, indem sie je Zeile
 * nachlädt; sonst kostet ein Bildschirm 400 Runden statt einer
 * (P-Gesetz, Dokument 04).
 */

/** Betriebslisten werden zusätzlich lokal gehalten (E5). */
function useCachedQuery<T>(
  key: unknown[], path: string, cacheKey: string | null
): UseQueryResult<T> {
  return useQuery<T>({
    queryKey: key,
    queryFn: async () => {
      const data = await api.get<T>(path)
      if (cacheKey !== null) cacheWrite(cacheKey, data)
      return data
    },
    initialData: cacheKey === null
      ? undefined
      : () => cacheRead<T>(cacheKey)?.data,
    // Der lokale Stand ist sofort sichtbar, wird aber gleich nachgeladen.
    initialDataUpdatedAt: 0,
    staleTime: 30_000,
    retry: 1
  })
}

export const useTapeChart = (propertyId: number, from: string, to: string) =>
  useCachedQuery<TapeChart>(
    ['tape', propertyId, from, to],
    `/v1/properties/${propertyId}/tape-chart?from=${from}&to=${to}`,
    null)

export const useDailySheet = (propertyId: number, date: string) =>
  useCachedQuery<DailySheet>(
    ['daily', propertyId, date],
    `/v1/properties/${propertyId}/daily-sheet?date=${date}`,
    `daily.${propertyId}.${date}`)

export const useHousekeeping = (propertyId: number, date: string) =>
  useCachedQuery<HousekeepingBoard>(
    ['hk', propertyId, date],
    `/v1/properties/${propertyId}/housekeeping?date=${date}`,
    `hk.${propertyId}.${date}`)

export const useCategories = (propertyId: number) =>
  useQuery<{ categories: Category[] }>({
    queryKey: ['categories', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/categories`)
  })

export const useRooms = (propertyId: number, includeInactive = false) =>
  useQuery<{ rooms: Room[] }>({
    queryKey: ['rooms', propertyId, includeInactive],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/rooms?includeInactive=${includeInactive}`)
  })

export const useSetupStatus = (propertyId: number) =>
  useQuery<SetupStatus>({
    queryKey: ['setup', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/setup-status`)
  })

export function useCreateCategory(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateCategory) =>
      api.post<{ categoryId: number }>(`/v1/properties/${propertyId}/categories`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories', propertyId] })
      void qc.invalidateQueries({ queryKey: ['setup', propertyId] })
    }
  })
}

/**
 * Zimmerserie. Ohne `commit` ist es eine Vorschau, die nichts schreibt, und
 * die Zwischenspeicher bleiben deshalb unberührt.
 */
export function useRoomSeries(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RoomSeries) => api.post<RoomSeriesReport>('/v1/rooms/series', body),
    onSuccess: (_r, body) => {
      if (body.commit !== true) return
      void qc.invalidateQueries({ queryKey: ['rooms', propertyId] })
      void qc.invalidateQueries({ queryKey: ['categories', propertyId] })
      void qc.invalidateQueries({ queryKey: ['setup', propertyId] })
    }
  })
}

export function useReservationAction(propertyId: number, date: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, action }: { ref: string; action: 'check-in' | 'check-out' }) =>
      api.post(`/v1/reservations/${ref}/${action}`),
    onSuccess: () => {
      // Nach Check-in oder Check-out ändern sich Tagesliste, Zimmerplan und
      // Zimmerstatus gemeinsam. Sie einzeln nachzuladen zeigte kurzzeitig
      // widersprüchliche Bildschirme.
      void qc.invalidateQueries({ queryKey: ['daily', propertyId, date] })
      void qc.invalidateQueries({ queryKey: ['hk', propertyId, date] })
      void qc.invalidateQueries({ queryKey: ['tape'] })
    }
  })
}

export function useSetHousekeeping(propertyId: number, date: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { resourceIds: number[]; status: HousekeepingState }) =>
      api.put('/v1/housekeeping/status', { propertyId, ...body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hk', propertyId, date] })
    }
  })
}
