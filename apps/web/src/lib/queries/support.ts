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

// ------------------------------------------------------------- Ausrollen

export interface Deployment {
  id: number
  kind: 'deploy' | 'rollback'
  /** Leer heisst: von Hand auf der Maschine gestartet. */
  requestedBy: string | null
  requestedAt: string
  targetRef: string
  status: 'pending' | 'running' | 'done' | 'failed'
  startedAt: string | null
  finishedAt: string | null
  commitBefore: string | null
  commitAfter: string | null
  log: string | null
}

export const useDeployments = () =>
  useQuery<{ deployments: Deployment[]; currentCommit: string | null
             currentBuiltAt: string | null
             rollbackTargets: { commit: string; builtAt: string | null }[] }>({
    queryKey: ['deployments'],
    queryFn: () => api.get('/v1/platform/deployments'),
    /*
     * Waehrend eines Laufs haeufiger nachsehen als sonst. Ein Ausrollen
     * dauert ein bis zwei Minuten, und wer den Knopf gedrueckt hat, will
     * sehen, dass etwas passiert -- ein Bildschirm, der drei Minuten
     * unveraendert dasteht, sieht aus wie ein Fehler.
     */
    refetchInterval: (q) => {
      const laeuft = q.state.data?.deployments.some(
        d => d.status === 'pending' || d.status === 'running')
      return laeuft === true ? 5_000 : 60_000
    }
  })

export function useRequestDeployment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<Deployment>('/v1/platform/deployments'),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['deployments'] }) }
  })
}

/**
 * Zurueckrollen auf einen frueheren Stand.
 *
 * Kein Bau, nur Umschalten und Neustart -- deshalb in Sekunden durch, wo ein
 * Ausrollen ein bis zwei Minuten braucht. Was es nicht zurueckdreht, sind
 * Migrationen; das Schema bleibt auf dem Stand des neueren Codes.
 */
export function useRollbackDeployment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (commit: string) =>
      api.post<Deployment>('/v1/platform/deployments/rollback', { commit }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['deployments'] }) }
  })
}
