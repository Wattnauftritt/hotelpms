import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { SecurityEventRow } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Das Sicherheitsprotokoll (Migration 0209). Seitenweise ueber die Kennung,
 * nicht ueber einen Versatz: kommt waehrend des Blaetterns ein Ereignis
 * dazu, verschoebe ein Versatz alles um eine Zeile, und eine stuende
 * doppelt da.
 */
const SEITE = 100

export const useSecurityEvents = () =>
  useInfiniteQuery({
    queryKey: ['sicherheitsprotokoll'],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api.get<{ events: SecurityEventRow[] }>(
      `/v1/security-events?limit=${SEITE}` + (pageParam === null ? '' : `&before=${pageParam}`)),
    getNextPageParam: last =>
      last.events.length < SEITE ? undefined : last.events[last.events.length - 1]!.id
  })

export const usePlatformSecurityEvents = () =>
  useQuery({
    queryKey: ['sicherheitsprotokoll', 'plattform'],
    queryFn: () => api.get<{ events: SecurityEventRow[] }>('/v1/platform/security-events?limit=200')
  })
