import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CheckinLink, CheckinMailPreview, CheckinSettings } from '@hotelpms/contracts'
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
 * Vorschau der Einladung mit Beispieldaten. Haengt an der Einstellung: wer
 * die Tage vor Anreise aendert, sieht danach ein anderes Anreisedatum.
 */
export const useCheckinMailPreview = (propertyId: number, language: string) =>
  useQuery<CheckinMailPreview>({
    queryKey: ['checkinSettings', propertyId, 'preview', language],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/online-checkin-settings/preview?language=${language}`)
  })

export function useSendCheckinTestMail(propertyId: number) {
  return useMutation({
    mutationFn: (body: { to: string; language: string }) =>
      api.post<{ messageRef: string }>(
        `/v1/properties/${propertyId}/online-checkin-settings/test-mail`, body)
  })
}

/**
 * Wie es um die Testmail steht, aus dem Postausgang.
 *
 * Fragt nach, solange sie wartet: zugestellt wird im Takt des Workers, und
 * "eingereiht" allein beantwortet nicht, ob der Anbieter sie genommen hat.
 * Wer den Postausgang nicht lesen darf, sieht weiter "eingereiht".
 */
export const useTestMailStatus = (propertyId: number, messageRef: string | null) =>
  useQuery<{ status: string; lastError: string | null } | null>({
    queryKey: ['outbox', propertyId, 'test', messageRef],
    queryFn: async () => {
      const r = await api.get<{ emails: Array<{ messageRef: string; status: string
                                                 lastError: string | null }> }>(
        `/v1/properties/${propertyId}/outbound-emails?limit=50`)
      return r.emails.find(e => e.messageRef === messageRef) ?? null
    },
    enabled: messageRef !== null,
    retry: false,
    refetchInterval: q => (q.state.data?.status ?? 'pending') === 'pending' ? 10_000 : false
  })

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
