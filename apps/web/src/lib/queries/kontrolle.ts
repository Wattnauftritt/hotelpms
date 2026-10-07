import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Kontrolle des Tages (Migration 0109). Dieselbe Schnittstelle wie die
 * Personal-App; die Antwort jeder Aenderung ist die ganze Liste.
 */
export interface KontrollZimmer {
  taskId: number
  resourceId: number
  code: string
  categoryCode: string
  kind: 'departure' | 'stayover'
  assignedTo: number | null
  staffName: string | null
  status: 'open' | 'done' | 'skipped'
  outcome: 'cleaned' | 'declined' | 'was_clean' | null
  inspection: 'passed' | 'rework' | null
  inspectionNote: string | null
  inspectedBy: string | null
  free: boolean
  arrivalToday: boolean
  openProblems: number
}
export interface KontrollTag { date: string; rooms: KontrollZimmer[] }

const schluessel = (propertyId: number) => ['inspection', propertyId]

export const useKontrolle = (propertyId: number) =>
  useQuery<KontrollTag>({
    queryKey: schluessel(propertyId),
    queryFn: () => api.get(`/v1/properties/${propertyId}/inspection`),
    // Die Kraefte melden laufend; die Hausdame soll nicht neu laden muessen.
    refetchInterval: 60_000
  })

export function useKontrollieren(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: { taskId: number; result: 'passed' | 'rework' | null; note?: string }) =>
      api.post<KontrollTag>(`/v1/properties/${propertyId}/inspection/${a.taskId}`,
        { result: a.result, note: a.note }),
    onSuccess: tag => {
      qc.setQueryData(schluessel(propertyId), tag)
      // Der Zimmerstand hat sich mit geaendert -- im Zimmerplan und im
      // Housekeeping-Bildschirm.
      void qc.invalidateQueries({ queryKey: ['tape', propertyId] })
      void qc.invalidateQueries({ queryKey: ['hk', propertyId] })
    }
  })
}
