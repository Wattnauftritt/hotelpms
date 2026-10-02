import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Gaesteterminal (Dokument 31): Einstellungen und der Auftrag an der
 * Reservierung. Die Seite am Touchscreen selbst benutzt diese Abfragen
 * **nicht** -- sie haelt Gastdaten bewusst nicht im Zwischenspeicher
 * (`routes/Terminal.tsx`).
 */

export type TerminalKind = 'registration_sign' | 'registration_fill'
export type JobState = 'pending' | 'opened' | 'done' | 'canceled' | 'expired'

export interface TerminalGeraet {
  deviceRef: string
  name: string
  state: 'paired' | 'pairing' | 'pairing_expired'
  pairingExpiresAt: string | null
  pairedAt: string | null
  lastSeenAt: string | null
  online: boolean
}

export interface Kopplungscode {
  deviceRef: string
  name: string
  pairingCode: string
  pairingExpiresAt: string
}

export interface TerminalStand {
  terminals: Array<{ deviceRef: string; name: string; online: boolean; busy: boolean }>
  /** Was die Rezeption fuer diese Reservierung anstossen kann. */
  offers: TerminalKind[]
  registration: { registrationId: number; signatureRequired: boolean; signed: boolean } | null
  job: { jobRef: string; kind: TerminalKind; state: JobState
         canceledBy: 'reception' | 'terminal' | 'timeout' | 'revoked' | null
         deviceName: string; createdAt: string } | null
}

export const istOffen = (s: JobState | undefined): boolean =>
  s === 'pending' || s === 'opened'

// ------------------------------------------------------- Einstellungen

export const useTerminals = (propertyId: number, nachfragen: boolean) =>
  useQuery<{ terminals: TerminalGeraet[] }>({
    queryKey: ['terminals', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/terminals`),
    // Solange ein Code aussteht, wird nachgesehen, ob er eingeloest ist --
    // wer am Touchscreen koppelt, soll es am Rezeptionsrechner sehen, ohne
    // neu zu laden.
    refetchInterval: nachfragen ? 3_000 : false
  })

export function useCreateTerminal(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      api.post<Kopplungscode>(`/v1/properties/${propertyId}/terminals`, { name }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['terminals', propertyId] }) }
  })
}

export function useRepairTerminal(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (deviceRef: string) => api.post<Kopplungscode>(
      `/v1/properties/${propertyId}/terminals/${deviceRef}/pairing-code`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['terminals', propertyId] }) }
  })
}

export function useRevokeTerminal(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (deviceRef: string) =>
      api.delete(`/v1/properties/${propertyId}/terminals/${deviceRef}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['terminals', propertyId] }) }
  })
}

// ------------------------------------------------- An der Reservierung

/**
 * Terminals, Angebote und der letzte Auftrag einer Reservierung, in einem
 * Aufruf. Solange ein Auftrag offen ist, alle zwei Sekunden derselbe Aufruf
 * -- die Rezeption sieht "wartet", "geoeffnet", "erledigt", ohne zu klicken.
 */
export const useReservationTerminal = (reservationRef: string) =>
  useQuery<TerminalStand>({
    queryKey: ['reservation-terminal', reservationRef],
    queryFn: () => api.get(`/v1/reservations/${reservationRef}/terminal`),
    // Immer frisch beim Einhaengen: der Meldeschein entsteht oft eine
    // Sekunde vorher in derselben Maske, und ein Angebot von davor hiesse
    // "nichts zu unterschreiben".
    staleTime: 0,
    retry: false,
    refetchInterval: q => istOffen(q.state.data?.job?.state) ? 2_000 : false
  })

export function useSendTerminalJob(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { deviceRef: string; kind: TerminalKind }) =>
      api.post<{ jobRef: string }>('/v1/terminal-jobs', { ...body, reservationRef }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['reservation-terminal', reservationRef] })
    }
  })
}

export function useCancelTerminalJob(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobRef: string) => api.post(`/v1/terminal-jobs/${jobRef}/cancel`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['reservation-terminal', reservationRef] })
    }
  })
}
