import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Ticketsystem (Migration 0208) -- beide Seiten.
 *
 * Der Kunde sieht seine Anfragen, die Kontoverwaltung alle des Betriebs. Die
 * Plattform sieht den Eingang aller Kunden samt interner Notizen. Was der
 * Kunde **nicht** sieht, steht nicht in seiner Antwort: die Notizen blendet
 * die Zeilenrichtlinie aus, nicht diese Datei.
 */

export type TicketStatus = 'open' | 'waiting_customer' | 'closed'
export type TicketArt = 'question' | 'bug' | 'wish' | 'billing'
export type TicketFilter = 'active' | 'closed' | 'all'

export interface TicketAnhang { id: number; name: string | null; mime: string; size: number }

export interface Ticket {
  id: number
  accountId: number
  propertyName: string | null
  createdByName: string
  mine: boolean
  subject: string
  category: TicketArt
  urgency: 'normal' | 'down'
  status: TicketStatus
  createdAt: string
  updatedAt: string
  lastCustomerAt: string
  lastStaffAt: string | null
  closedAt: string | null
}

export interface TicketNachricht {
  id: number
  side: 'customer' | 'platform'
  /** Beim Support null: der Kunde spricht mit StayGrid, nicht mit einem Namen. */
  authorName: string | null
  body: string
  createdAt: string
  attachments: TicketAnhang[]
}

export interface TicketSitzung {
  id: number
  level: 'read' | 'write'
  requestedAt: string
  grantedAt: string | null
  expiresAt: string
  state: 'pending' | 'active' | 'expired' | 'revoked'
}

export interface TicketDetail extends Ticket {
  messages: TicketNachricht[]
  sessions: TicketSitzung[]
  canGrant: boolean
}

/** Bild oder PDF, als Datenadresse -- wie die Kassenbelege. */
export interface NeuerAnhang { data: string; name?: string }

export interface NeuesTicket {
  propertyId: number
  subject: string
  category: TicketArt
  urgency: 'normal' | 'down'
  body: string
  screen: string | null
  clientVersion: string | null
  attachments: NeuerAnhang[]
}

// ------------------------------------------------------------- Kundenseite

export const useTickets = (filter: TicketFilter) =>
  useQuery<{ tickets: Ticket[] }>({
    queryKey: ['support-tickets', filter],
    queryFn: () => api.get(`/v1/support-tickets?status=${filter}`),
    // Eine Antwort soll ankommen, ohne dass jemand neu laedt.
    refetchInterval: 60_000
  })

export const useTicket = (id: number | null) =>
  useQuery<TicketDetail>({
    queryKey: ['support-ticket', id],
    queryFn: () => api.get(`/v1/support-tickets/${id!}`),
    enabled: id !== null,
    refetchInterval: 60_000
  })

function useNeuLaden() {
  const qc = useQueryClient()
  return (id?: number) => {
    void qc.invalidateQueries({ queryKey: ['support-tickets'] })
    if (id !== undefined) void qc.invalidateQueries({ queryKey: ['support-ticket', id] })
  }
}

export function useCreateTicket() {
  const neu = useNeuLaden()
  return useMutation({
    mutationFn: (body: NeuesTicket) => api.post<{ id: number }>('/v1/support-tickets', body),
    onSuccess: () => { neu() }
  })
}

export function useReplyTicket(id: number) {
  const neu = useNeuLaden()
  return useMutation({
    mutationFn: (body: { body: string; attachments: NeuerAnhang[] }) =>
      api.post(`/v1/support-tickets/${id}/messages`, body),
    onSuccess: () => { neu(id) }
  })
}

export function useCloseTicket(id: number) {
  const neu = useNeuLaden()
  return useMutation({
    mutationFn: () => api.post(`/v1/support-tickets/${id}/close`),
    onSuccess: () => { neu(id) }
  })
}

// ---------------------------------------------------------- Plattformseite

export interface PlattformTicket extends Omit<Ticket, 'mine'> {
  accountName: string
  assignedTo: number | null
  assignedName: string | null
  screen: string | null
  clientVersion: string | null
  messages: number
}

export interface PlattformNachricht extends TicketNachricht { internal: boolean }

export interface PlattformTicketDetail extends Omit<PlattformTicket, 'messages'> {
  messages: PlattformNachricht[]
  sessions: Array<TicketSitzung & { staffName: string }>
}

export const usePlatformTickets = (filter: TicketFilter) =>
  useQuery<{ tickets: PlattformTicket[] }>({
    queryKey: ['platform-tickets', filter],
    queryFn: () => api.get(`/v1/platform/tickets?status=${filter}`),
    refetchInterval: 60_000
  })

export const usePlatformTicket = (id: number | null) =>
  useQuery<PlattformTicketDetail>({
    queryKey: ['platform-ticket', id],
    queryFn: () => api.get(`/v1/platform/tickets/${id!}`),
    enabled: id !== null,
    refetchInterval: 60_000
  })

function usePlattformNeuLaden() {
  const qc = useQueryClient()
  return (id: number) => {
    void qc.invalidateQueries({ queryKey: ['platform-tickets'] })
    void qc.invalidateQueries({ queryKey: ['platform-ticket', id] })
  }
}

export function usePlatformReply(id: number) {
  const neu = usePlattformNeuLaden()
  return useMutation({
    mutationFn: (body: { body: string; internal: boolean }) =>
      api.post(`/v1/platform/tickets/${id}/messages`, body),
    onSuccess: () => { neu(id) }
  })
}

export function usePlatformSetTicket(id: number) {
  const neu = usePlattformNeuLaden()
  return useMutation({
    mutationFn: (body: { status?: TicketStatus; assign?: 'me' | 'none' }) =>
      api.patch(`/v1/platform/tickets/${id}`, body),
    onSuccess: () => { neu(id) }
  })
}

export function useRequestSessionFromTicket(id: number) {
  const neu = usePlattformNeuLaden()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { accountId: number; reason: string; level: 'read' | 'write' }) =>
      api.post('/v1/platform/support-sessions', { ...body, ticketId: id }),
    onSuccess: () => {
      neu(id)
      void qc.invalidateQueries({ queryKey: ['platform-support-sessions'] })
    }
  })
}
