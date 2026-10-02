import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CheckinLink, CheckinSettings } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Online-Check-in auf der Seite der Rezeption (Dokument 30).
 *
 * Die Gastseite selbst steht nicht hier: sie haelt ihren Zustand bewusst
 * ausserhalb des Zwischenspeichers (`routes/GastCheckin.tsx`), weil der
 * eine Antwort mit Gastdaten nach dem Schliessen noch minutenlang behielte.
 */

export const useCheckinSettings = (propertyId: number) =>
  useQuery<CheckinSettings>({
    queryKey: ['checkinSettings', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/online-checkin-settings`)
  })

export function useSaveCheckinSettings(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CheckinSettings) =>
      api.put<CheckinSettings>(`/v1/properties/${propertyId}/online-checkin-settings`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['checkinSettings', propertyId] })
    }
  })
}

/**
 * Den Link fuer die Zwischenablage. **Nicht** im Zwischenspeicher: er ist
 * ein Zugang zum Meldeschein des Gastes und soll nach dem Kopieren nirgends
 * mehr liegen als dort, wohin die Rezeption ihn gibt.
 */
export function useCheckinLink(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<CheckinLink>(`/v1/reservations/${reservationRef}/online-checkin/link`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
    }
  })
}

export function useSendCheckinLink(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ messageRef: string }>(`/v1/reservations/${reservationRef}/online-checkin/send`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
    }
  })
}

export function useRevokeCheckinLinks(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ revoked: number }>(`/v1/reservations/${reservationRef}/online-checkin/revoke`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
    }
  })
}
