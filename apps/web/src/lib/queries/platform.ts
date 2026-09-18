import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Das Adminpanel: Kunden, Plattformbenutzer, Betriebszustand.
 *
 * **Keine Kundendaten.** Was hier hereinkommt, sind Kennungen, Namen von
 * Haeusern und Mitarbeitern des Kunden, Zustaende und Zahlen. Wer in die
 * Daten eines Kunden sehen muss, fragt eine Support-Sitzung an; der Weg
 * dorthin fuehrt ueber dieselbe Liste, aber nicht an ihr vorbei.
 */

export interface PlatformAccount {
  id: number
  ref: string
  name: string
  legalName: string | null
  status: 'active' | 'suspended' | 'archived'
  properties: number
  users: number
  createdAt: string
  /** Wann zuletzt jemand dieses Kunden angemeldet war. Null: noch nie. */
  lastLoginAt: string | null
}

export interface PlatformProperty {
  id: number
  ref: string
  code: string
  name: string
  status: string
  /** Ein Schulungshaus exportiert nichts und verschickt keine Gastpost. */
  isTraining: boolean
  timezone: string
  rooms: number
}

export interface PlatformAccountUser {
  id: number
  ref: string
  email: string
  displayName: string
  status: string
  lockedUntil: string | null
  lastLoginAt: string | null
  roles: string | null
}

export interface PlatformStaff {
  id: number
  ref: string
  email: string
  displayName: string
  status: string
  roleKey: string | null
  roleName: string | null
  lastLoginAt: string | null
  createdAt: string
}

export interface PlatformHealthRow {
  accountId: number
  accountName: string
  accountStatus: string
  emailsPending: number
  emailsFailed: number
  emailsOldest: string | null
  webhooksFailed: number
  webhooksOldest: string | null
  nightAuditLast: string | null
}

export const usePlatformAccounts = () =>
  useQuery<{ accounts: PlatformAccount[] }>({
    queryKey: ['platform-accounts'],
    queryFn: () => api.get('/v1/platform/accounts')
  })

export const usePlatformAccount = (id: number | null) =>
  useQuery<{
    account: PlatformAccount
    properties: PlatformProperty[]
    users: PlatformAccountUser[]
  }>({
    queryKey: ['platform-account', id],
    queryFn: () => api.get(`/v1/platform/accounts/${id!}`),
    enabled: id !== null
  })

export function useSetAccountStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post(`/v1/platform/accounts/${id}/status`, { status }),
    onSuccess: (_r, { id }) => {
      void qc.invalidateQueries({ queryKey: ['platform-accounts'] })
      void qc.invalidateQueries({ queryKey: ['platform-account', id] })
      void qc.invalidateQueries({ queryKey: ['platform-health'] })
    }
  })
}

export function useCreateAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ accountId: number; propertyId: number; userId: number }>(
        '/v1/platform/accounts', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform-accounts'] }) }
  })
}

export const usePlatformStaff = () =>
  useQuery<{ roles: string[]; staff: PlatformStaff[] }>({
    queryKey: ['platform-staff'],
    queryFn: () => api.get('/v1/platform/staff')
  })

export function useCreateStaff() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { email: string; displayName: string; roleKey: string }) =>
      api.post<PlatformStaff>('/v1/platform/staff', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform-staff'] }) }
  })
}

export function useSetStaffStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post(`/v1/platform/staff/${id}/status`, { status }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform-staff'] }) }
  })
}

export const usePlatformHealth = () =>
  useQuery<{ accounts: PlatformHealthRow[] }>({
    queryKey: ['platform-health'],
    queryFn: () => api.get('/v1/platform/health'),
    /*
     * Der Bildschirm, den man offen liegen laesst. Eine Warteschlange, die
     * sich fuellt, soll auffallen, ohne dass jemand neu laedt -- aber nicht
     * jede Sekunde: es sind Zahlen ueber alle Kunden, keine Kurve.
     */
    refetchInterval: 60_000
  })
