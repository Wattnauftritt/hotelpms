import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Support-Sitzungen -- beide Seiten.
 *
 * Der Kunde sieht, wer um Zugriff bittet, und entscheidet. Die Plattform
 * sieht ihre eigenen Anfragen und deren Stand. Es gibt bewusst keinen
 * Aufruf, mit dem die Plattform fremde Sitzungen sieht: die Route dafuer
 * gibt es nicht, und die SQL-Funktion dahinter filtert auf den angemeldeten
 * Benutzer selbst.
 */

export interface SupportSession {
  id: number
  accountId: number
  accountName: string
  staffName: string
  grantedByName: string | null
  level: 'read' | 'write'
  reason: string
  isEmergency: boolean
  requestedAt: string
  grantedAt: string | null
  expiresAt: string
  revokedAt: string | null
  state: 'pending' | 'active' | 'expired' | 'revoked'
  /** Was die Stufe erlaubt -- damit die Maske zeigen kann, was freigegeben wird. */
  permissions: string[]
}

// ------------------------------------------------------------- Kundenseite

export const useSupportSessions = () =>
  useQuery<{ sessions: SupportSession[] }>({
    queryKey: ['support-sessions'],
    queryFn: () => api.get('/v1/support-sessions'),
    /*
     * Haeufiger nachladen als sonst ueblich. Eine laufende Sitzung ist ein
     * Zugriff auf die eigenen Daten; wer den Bildschirm offen hat, soll
     * sehen, dass sie abgelaufen ist, ohne neu zu laden.
     */
    refetchInterval: 60_000
  })

export function useGrantSupportSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.post<SupportSession>(`/v1/support-sessions/${id}/grant`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['support-sessions'] }) }
  })
}

export function useRevokeSupportSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.post<SupportSession>(`/v1/support-sessions/${id}/revoke`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['support-sessions'] }) }
  })
}

// ---------------------------------------------------------- Plattformseite

export const usePlatformSupportSessions = () =>
  useQuery<{ sessions: SupportSession[] }>({
    queryKey: ['platform-support-sessions'],
    queryFn: () => api.get('/v1/platform/support-sessions'),
    refetchInterval: 60_000
  })

export interface SupportRequest {
  accountId: number
  reason: string
  level: 'read' | 'write'
  hours: number
}

export function useRequestSupportSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SupportRequest) =>
      api.post<SupportSession>('/v1/platform/support-sessions', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform-support-sessions'] })
    }
  })
}
