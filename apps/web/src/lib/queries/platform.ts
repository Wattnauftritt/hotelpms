import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { EmailDomainRequest } from '@hotelpms/contracts'
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
  /** Dieselben Rollen strukturiert, fuer den Editor. */
  accountRoles: string[]
  propertyRoles: Array<{ propertyId: number; code: string; roleKeys: string[] }>
  /** Die letzte Einladung oder Ruecksetzung -- ob sie ankam. */
  lastMail: { kind: string; status: string; at: string; error: string | null } | null
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

export interface PlatformHealthGlobal {
  emailsPending: number
  emailsFailed: number
  emailsOldest: string | null
  /** Die Meldung des Mailanbieters zum letzten Fehlschlag. */
  emailsLastError: string | null
  deployment: { id: number; status: string; stuck: boolean } | null
}

export interface SupportAuditRow {
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
}

export function useUnlockUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, userId }: { accountId: number; userId: number }) =>
      api.post(`/v1/platform/accounts/${accountId}/users/${userId}/unlock`),
    onSuccess: (_r, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ['platform-account', accountId] })
    }
  })
}

export function useSendAccessLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, userId }: { accountId: number; userId: number }) =>
      api.post<{ kind: string }>(
        `/v1/platform/accounts/${accountId}/users/${userId}/access-link`),
    onSuccess: (_r, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ['platform-account', accountId] })
    }
  })
}

export function useRevokeSessions() {
  return useMutation({
    mutationFn: ({ accountId, userId }: { accountId: number; userId: number }) =>
      api.post<{ revoked: number }>(
        `/v1/platform/accounts/${accountId}/users/${userId}/sessions/revoke`)
  })
}

export function useInviteAccountUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, ...body }: {
      accountId: number; email: string; displayName: string; roleKey: string
      propertyId: number | null }) =>
      api.post(`/v1/platform/accounts/${accountId}/users`, body),
    onSuccess: (_r, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ['platform-account', accountId] })
      void qc.invalidateQueries({ queryKey: ['platform-accounts'] })
    }
  })
}

export function useSetCustomerPropertyRoles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, userId, ...body }: {
      accountId: number; userId: number; propertyId: number; roleKeys: string[] }) =>
      api.put(`/v1/platform/accounts/${accountId}/users/${userId}/roles`, body),
    onSuccess: (_r, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ['platform-account', accountId] })
    }
  })
}

export function useSetCustomerAccountRoles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, userId, roleKeys }: {
      accountId: number; userId: number; roleKeys: string[] }) =>
      api.put(`/v1/platform/accounts/${accountId}/users/${userId}/account-roles`,
        { roleKeys }),
    onSuccess: (_r, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ['platform-account', accountId] })
    }
  })
}

export function useAddProperty() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, ...body }: { accountId: number } & Record<string, unknown>) =>
      api.post(`/v1/platform/accounts/${accountId}/properties`, body),
    onSuccess: (_r, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ['platform-account', accountId] })
      void qc.invalidateQueries({ queryKey: ['platform-accounts'] })
    }
  })
}

export const useAccountSupportSessions = (accountId: number) =>
  useQuery<{ sessions: SupportAuditRow[] }>({
    queryKey: ['platform-account-sessions', accountId],
    queryFn: () => api.get(`/v1/platform/accounts/${accountId}/support-sessions`),
    refetchInterval: 60_000
  })

export const useSupportAudit = (enabled: boolean) =>
  useQuery<{ sessions: SupportAuditRow[] }>({
    queryKey: ['platform-support-audit'],
    queryFn: () => api.get('/v1/platform/support-audit'),
    enabled
  })

export const useSessionActivity = (sessionId: number | null) =>
  useQuery<{ activity: Array<{ table: string; action: string; count: number }> }>({
    queryKey: ['platform-session-activity', sessionId],
    queryFn: () => api.get(`/v1/platform/support-sessions/${sessionId!}/activity`),
    enabled: sessionId !== null
  })

export function useSetStaffRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, roleKey }: { id: number; roleKey: string }) =>
      api.put(`/v1/platform/staff/${id}/role`, { roleKey }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform-staff'] }) }
  })
}

export function useStaffAccessLink() {
  return useMutation({
    mutationFn: (id: number) =>
      api.post<{ kind: string }>(`/v1/platform/staff/${id}/access-link`)
  })
}

export const usePlatformHealth = () =>
  useQuery<{ platform: PlatformHealthGlobal; accounts: PlatformHealthRow[] }>({
    queryKey: ['platform-health'],
    queryFn: () => api.get('/v1/platform/health'),
    /*
     * Der Bildschirm, den man offen liegen laesst. Eine Warteschlange, die
     * sich fuellt, soll auffallen, ohne dass jemand neu laedt -- aber nicht
     * jede Sekunde: es sind Zahlen ueber alle Kunden, keine Kurve.
     */
    refetchInterval: 60_000
  })

// ------------------------------------------------------- Absenderdomains

/**
 * Antraege auf eine Absenderdomain.
 *
 * Ohne Filter: offene zuerst, danach die entschiedenen. Zwei Abfragen --
 * eine fuer offene, eine fuer entschiedene -- waeren zwei Runden fuer einen
 * Bildschirm, und die Liste ist klein genug, dass die Trennung in der
 * Anzeige genuegt.
 */
export const useEmailDomainRequests = () =>
  useQuery<{ requests: EmailDomainRequest[]; relayDomain: string }>({
    queryKey: ['platformEmailDomains'],
    queryFn: () => api.get('/v1/platform/email-domains')
  })

export function useApproveEmailDomain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (propertyId: number) =>
      api.post(`/v1/platform/email-domains/${propertyId}/approve`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platformEmailDomains'] })
    }
  })
}

export function useRejectEmailDomain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { propertyId: number; note: string }) =>
      api.post(`/v1/platform/email-domains/${v.propertyId}/reject`,
               { note: v.note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platformEmailDomains'] })
    }
  })
}
