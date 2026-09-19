import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { WebhookSubscription, WebhookDelivery, OAuthClient,
              ChannelConnection, PropertyRole, PropertyUser } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Abfragen fuer Schnittstellen: Webhooks, Maschinenzugaenge, Channel
 * Manager, Benutzer und Rollen.
 *
 * **Das Zustellprotokoll wird nur auf Verlangen geholt.** Es ist die eine
 * Liste hier, die je Abonnement auf hunderte Zeilen kommt; sie mit der
 * Uebersicht zu laden hiesse, sie fuer jeden zu holen, der nur nachsieht,
 * ob ein Abonnement aktiv ist.
 */

// ------------------------------------------------------------ Webhooks (C8)

export const useWebhookSubscriptions = () =>
  useQuery<{ subscriptions: WebhookSubscription[]; availableEventTypes: string[] }>({
    queryKey: ['webhooks'],
    queryFn: () => api.get('/v1/webhook-subscriptions')
  })

export const useWebhookDeliveries = (subscriptionRef: string | null) =>
  useQuery<{ subscriptionRef: string; deliveries: WebhookDelivery[] }>({
    queryKey: ['webhookDeliveries', subscriptionRef],
    queryFn: () => api.get(
      `/v1/webhook-subscriptions/${subscriptionRef!}/deliveries?limit=50`),
    enabled: subscriptionRef !== null
  })

export interface WebhookCreated extends WebhookSubscription {
  /** Nur bei der Anlage. Wird nie wieder ausgegeben. */
  signingSecret: string
  hinweis: string
  hinweisKey: string
}

export function useCreateWebhook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { url: string; eventTypes?: string[]; propertyIds?: number[] }) =>
      api.post<WebhookCreated>('/v1/webhook-subscriptions', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['webhooks'] }) }
  })
}

export function useSetWebhookStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, aktiv }: { ref: string; aktiv: boolean }) =>
      aktiv
        ? api.post(`/v1/webhook-subscriptions/${ref}/enable`)
        : api.delete(`/v1/webhook-subscriptions/${ref}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['webhooks'] })
      void qc.invalidateQueries({ queryKey: ['webhookDeliveries'] })
    }
  })
}

// ------------------------------------------- Maschinenzugaenge, Channel (C9)

export const useOAuthClients = () =>
  useQuery<{ clients: OAuthClient[]; availableScopes: string[] }>({
    queryKey: ['oauthClients'],
    queryFn: () => api.get('/v1/oauth-clients')
  })

export interface OAuthClientCreated {
  clientId: string
  /** Genau einmal. Danach nie wieder abrufbar. */
  clientSecret: string
  scopes: string[]
  propertyIds: number[]
  allProperties: boolean
  hinweis: string
  hinweisKey: string
}

export function useCreateOAuthClient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; scopes: string[]; propertyIds?: number[] }) =>
      api.post<OAuthClientCreated>('/v1/oauth-clients', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['oauthClients'] }) }
  })
}

export function useRevokeOAuthClient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (clientRef: string) =>
      api.post(`/v1/oauth-clients/${clientRef}/revoke`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['oauthClients'] }) }
  })
}

export const useChannelConnections = (propertyId: number) =>
  useQuery<{ connections: ChannelConnection[] }>({
    queryKey: ['channelConnections', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/channel-connections`)
  })

export function useCreateChannelConnection(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { provider: string; name: string }) =>
      api.post<{ connectionRef: string; token: string }>(
        `/v1/properties/${propertyId}/channel-connections`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channelConnections', propertyId] })
    }
  })
}

export function useDisableChannelConnection(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (connectionRef: string) =>
      api.post(
        `/v1/properties/${propertyId}/channel-connections/${connectionRef}/disable`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channelConnections', propertyId] })
    }
  })
}

// ------------------------------------------------- Benutzer und Rollen (C10)

export const usePropertyUsers = (propertyId: number) =>
  useQuery<{ users: PropertyUser[] }>({
    queryKey: ['propertyUsers', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/users`)
  })

export const useRoles = () =>
  useQuery<{ roles: PropertyRole[] }>({
    queryKey: ['roles'],
    queryFn: () => api.get('/v1/roles'),
    // Rollen aendern sich im Betrieb praktisch nie.
    staleTime: 30 * 60_000
  })

export function useSetUserRoles(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userRef, roleKeys }: { userRef: string; roleKeys: string[] }) =>
      api.put(`/v1/properties/${propertyId}/users/${userRef}/roles`, { roleKeys }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['propertyUsers', propertyId] })
      // Wer sich selbst umsortiert, sieht sonst weiter die alte Navigation.
      void qc.invalidateQueries({ queryKey: ['me'] })
    }
  })
}

/*
 * Selbstverwaltung des Kunden (0040): einladen, Link, entsperren, Name,
 * sperren, entfernen, Betriebsrollen. Jede Aenderung macht die Liste und
 * `me` ungueltig -- wer sich selbst umsortiert, saehe sonst die alte
 * Navigation.
 */
function nachBenutzeraenderung(qc: ReturnType<typeof useQueryClient>, propertyId: number) {
  return () => {
    void qc.invalidateQueries({ queryKey: ['propertyUsers', propertyId] })
    void qc.invalidateQueries({ queryKey: ['me'] })
  }
}

export function useInviteUser(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { email: string; displayName: string; roleKeys: string[] }) =>
      api.post<{ userRef: string }>(`/v1/properties/${propertyId}/users`, body),
    onSuccess: nachBenutzeraenderung(qc, propertyId)
  })
}

export function useUserAction(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userRef, action }: {
      userRef: string; action: 'access-link' | 'unlock' | 'block' | 'unblock' }) =>
      api.post<{ kind?: string; sessionsRevoked?: number }>(
        `/v1/properties/${propertyId}/users/${userRef}/${action}`),
    onSuccess: nachBenutzeraenderung(qc, propertyId)
  })
}

export function useRenameUser(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userRef, displayName }: { userRef: string; displayName: string }) =>
      api.patch(`/v1/properties/${propertyId}/users/${userRef}`, { displayName }),
    onSuccess: nachBenutzeraenderung(qc, propertyId)
  })
}

export function useRemoveUser(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userRef: string) =>
      api.delete(`/v1/properties/${propertyId}/users/${userRef}`),
    onSuccess: nachBenutzeraenderung(qc, propertyId)
  })
}

export const useAccountRoles = (propertyId: number, enabled: boolean) =>
  useQuery<{ roles: PropertyRole[] }>({
    queryKey: ['accountRoles', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/account-roles`),
    staleTime: 30 * 60_000,
    enabled
  })

export function useSetAccountRoles(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userRef, roleKeys }: { userRef: string; roleKeys: string[] }) =>
      api.put(`/v1/properties/${propertyId}/users/${userRef}/account-roles`, { roleKeys }),
    onSuccess: nachBenutzeraenderung(qc, propertyId)
  })
}
