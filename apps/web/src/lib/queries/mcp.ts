import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { McpOverview } from '@hotelpms/contracts'
import { api } from '../api.js'
import { claudeFreigabeMitPasskey } from '../passkey.js'

/** Der Claude-Zugang im Adminpanel (0222, Dokument 38). */

export const useMcpOverview = () =>
  useQuery<McpOverview>({
    queryKey: ['platform-mcp'],
    queryFn: () => api.get('/v1/platform/mcp'),
    // Eine Anfrage von Claude wartet auf eine Antwort; sie soll ohne
    // Neuladen erscheinen.
    refetchInterval: 15_000
  })

/**
 * Fuer den Hinweis oben im Adminpanel. Alle 15 Sekunden: eine Anfrage, die
 * eine Viertelstunde unbeantwortet bleibt, haelt Claude so lange auf.
 */
export const useMcpPending = (aktiv: boolean) =>
  useQuery<{ pending: number }>({
    queryKey: ['platform-mcp-pending'],
    queryFn: () => api.get('/v1/platform/mcp/pending'),
    enabled: aktiv,
    refetchInterval: 15_000
  })

function useNeu() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['platform-mcp'] })
    void qc.invalidateQueries({ queryKey: ['platform-mcp-pending'] })
  }
}

export function useMcpLock() {
  const neu = useNeu()
  return useMutation({
    mutationFn: (locked: boolean) => api.post('/v1/platform/mcp/lock', { locked }),
    onSettled: neu
  })
}

export function useMcpRevoke() {
  const neu = useNeu()
  return useMutation({
    mutationFn: (ref: string) =>
      api.post(`/v1/platform/mcp/connections/${encodeURIComponent(ref)}/revoke`),
    onSettled: neu
  })
}

export function useMcpGrant() {
  const neu = useNeu()
  return useMutation({ mutationFn: claudeFreigabeMitPasskey, onSettled: neu })
}

export function useMcpClose() {
  const neu = useNeu()
  return useMutation({
    mutationFn: (ref: string) =>
      api.post(`/v1/platform/mcp/releases/${encodeURIComponent(ref)}/close`),
    onSettled: neu
  })
}

export function useMcpConsent() {
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      api.post<{ redirectTo: string }>('/v1/platform/mcp/consent', body)
  })
}
