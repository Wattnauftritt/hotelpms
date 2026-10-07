import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Reinigungsplan eines Tages (Migration 0106). Ein Aufruf liefert Zimmer,
 * Kraefte, Sollminuten und Verlauf -- der Bildschirm braucht nichts sonst.
 */
export type ReinigungsArt = 'departure' | 'stayover'

export interface PlanZimmer {
  resourceId: number
  code: string
  categoryId: number
  categoryCode: string
  building: string | null
  floor: string | null
  due: ReinigungsArt | null
  departureCheckedOut: boolean
  arrivalToday: boolean
  taskId: number | null
  kind: ReinigungsArt | null
  assignedTo: number | null
  minutes: number
  taskStatus: 'open' | 'done' | 'skipped' | null
  source: 'staygrid' | 'legacy' | null
  /** Der Gast verzichtet heute auf die Zwischenreinigung (0115). */
  waived: boolean
}

export interface PlanKraft { userId: number; displayName: string; active: boolean }

export interface Sollminute {
  kind: ReinigungsArt
  categoryId: number | null
  resourceId: number | null
  minutes: number
}

export interface PlanEintrag {
  id: number
  changedAt: string
  action: 'created' | 'changed' | 'deleted'
  kind: ReinigungsArt
  roomCode: string | null
  assignedFrom: number | null
  assignedTo: number | null
  minutesFrom: number | null
  minutesTo: number | null
  statusFrom: string | null
  statusTo: string | null
  changedBy: string | null
}

export interface Reinigungsplan {
  date: string
  rooms: PlanZimmer[]
  staff: PlanKraft[]
  norms: Sollminute[]
  defaults: Record<ReinigungsArt, number>
  log: PlanEintrag[]
}

export interface Zuteilung { resourceId: number; kind: ReinigungsArt; assignedTo: number | null }

const schluessel = (propertyId: number, datum: string) => ['cleaning-plan', propertyId, datum]

export const useReinigungsplan = (propertyId: number, datum: string) =>
  useQuery<Reinigungsplan>({
    queryKey: schluessel(propertyId, datum),
    queryFn: () => api.get(`/v1/properties/${propertyId}/cleaning-plan?date=${datum}`)
  })

export function usePlanSpeichern(propertyId: number, datum: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (assignments: Zuteilung[]) =>
      api.put<Reinigungsplan>(`/v1/properties/${propertyId}/cleaning-plan`,
        { date: datum, assignments }),
    // Die Antwort ist der gespeicherte Plan; ein zweiter Abruf waere eine
    // Runde ohne neuen Inhalt.
    onSuccess: plan => { qc.setQueryData(schluessel(propertyId, datum), plan) }
  })
}

export const usePlanVorschlag = (propertyId: number, datum: string) =>
  useMutation({
    mutationFn: (staff: number[]) =>
      api.post<{ assignments: Zuteilung[] }>(
        `/v1/properties/${propertyId}/cleaning-plan/suggest`, { date: datum, staff })
  })

export function useSollminutenSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (norms: Sollminute[]) =>
      api.put(`/v1/properties/${propertyId}/cleaning-norms`, { norms }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cleaning-plan', propertyId] }) }
  })
}
