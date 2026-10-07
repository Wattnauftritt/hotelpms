import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Reinigungsplan eines Tages (Migration 0106). Ein Aufruf liefert Zimmer,
 * Kraefte, Sollminuten und Verlauf -- der Bildschirm braucht nichts sonst.
 */
export type ReinigungsArt = 'departure' | 'stayover'

export interface PlanZimmer {
  /** Das Haus der Zeile; bei gemeinsamem Personal stehen mehrere im Plan (0116). */
  propertyId: number
  /** Ein Zimmer oder ein Reinigungsbereich wie das Bad, nie beides. */
  resourceId: number | null
  areaId: number | null
  code: string
  categoryId: number | null
  categoryCode: string | null
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

export interface PlanKraft {
  userId: number
  displayName: string
  active: boolean
  /** Was die Kraft am selben Tag in anderen Haeusern schon hat. */
  elsewhere: Array<{ propertyId: number; propertyName: string; rooms: number; minutes: number }>
}

export interface Bereich {
  id: number
  code: string
  building: string | null
  minutes: number
  active: boolean
}

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
  /** Gemeinsames Personal: ein Plan ueber alle Haeuser in `houses`. */
  shared: boolean
  houses: Array<{ id: number; name: string }>
  rooms: PlanZimmer[]
  areas: Bereich[]
  staff: PlanKraft[]
  norms: Sollminute[]
  defaults: Record<ReinigungsArt, number>
  log: PlanEintrag[]
}

export interface Zuteilung {
  resourceId?: number
  areaId?: number
  kind: ReinigungsArt
  assignedTo: number | null
}

/** Zimmer und Bereich in einem Schluessel -- ihre Nummern sind zwei Reihen. */
export const zielVon = (z: { resourceId?: number | null; areaId?: number | null }): string =>
  z.areaId != null ? `a${z.areaId}` : `r${z.resourceId}`

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

export function useBereicheSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (areas: Array<Omit<Bereich, 'id'> & { id: number | null }>) =>
      api.put<{ areas: Bereich[] }>(`/v1/properties/${propertyId}/cleaning-areas`, { areas }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cleaning-plan'] }) }
  })
}

/** Reinigung und Fruehstueck gemeinsam fuer den Betrieb oder je Haus (0116). */
export const usePersonalGemeinsam = (propertyId: number, darf: boolean) =>
  useQuery<{ shared: boolean }>({
    queryKey: ['staff-setting', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/staff-setting`),
    enabled: darf
  })

export function usePersonalGemeinsamSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (shared: boolean) =>
      api.put<{ shared: boolean }>(`/v1/properties/${propertyId}/staff-setting`, { shared }),
    onSuccess: neu => {
      qc.setQueryData(['staff-setting', propertyId], neu)
      // Wer was sieht, haengt daran: Plan, Kueche, Rechte im Kopf.
      void qc.invalidateQueries({ queryKey: ['cleaning-plan'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
    }
  })
}
