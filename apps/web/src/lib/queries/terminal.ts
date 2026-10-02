import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Gaesteterminal (Dokument 31): Einstellungen und der Auftrag an der
 * Reservierung. Die Seite am Touchscreen selbst benutzt diese Abfragen
 * **nicht** -- sie haelt Gastdaten bewusst nicht im Zwischenspeicher
 * (`routes/Terminal.tsx`).
 */

export type TerminalKind =
  'registration_fill' | 'registration_sign' | 'terms_sign' | 'content' | 'url'

/** Ein Angebot: eine Art, und wo noetig, was genau (Bedingung, Seite, Adresse). */
export interface Angebot {
  kind: TerminalKind
  ref?: string
  label?: string
}

export interface Auftragsstand {
  jobRef: string
  kind: TerminalKind
  state: JobState
  canceledBy: 'reception' | 'terminal' | 'timeout' | 'revoked' | null
  deviceName: string
  /** Titel der Bedingung, der Seite oder der Adresse; sonst leer. */
  label: string | null
  createdAt: string
}
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
  offers: Angebot[]
  registration: { registrationId: number; signatureRequired: boolean; signed: boolean } | null
  job: Auftragsstand | null
}

export interface Pult {
  terminals: Array<{ deviceRef: string; name: string; online: boolean
                     job: Auftragsstand | null }>
  offers: Angebot[]
}

export interface Seite {
  contentRef: string
  title: string
  body: string
  imageRef: string | null
  idlePosition: number | null
  idleSeconds: number | null
}

export interface Adresse { urlRef: string; label: string; url: string }

/** Der Rumpf eines Auftrags: die Art und die Kennung dessen, was gezeigt wird. */
export interface AuftragsWunsch {
  deviceRef: string
  kind: TerminalKind
  reservationRef?: string
  propertyId?: number
  termsRef?: string
  contentRef?: string
  urlRef?: string
}

/** Der Teil eines Angebots, der in den Auftrag gehoert. */
export function wunschAus(a: Angebot): Pick<AuftragsWunsch, 'termsRef' | 'contentRef' | 'urlRef'> {
  if (a.ref === undefined) return {}
  if (a.kind === 'terms_sign') return { termsRef: a.ref }
  if (a.kind === 'content') return { contentRef: a.ref }
  if (a.kind === 'url') return { urlRef: a.ref }
  return {}
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

/**
 * Einen Auftrag schicken. `nachher` ist der Schluessel der Abfrage, die den
 * Stand zeigt -- die Reservierung oder das Bedienfeld.
 */
export function useSendTerminalJob(nachher: readonly unknown[]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AuftragsWunsch) =>
      api.post<{ jobRef: string }>('/v1/terminal-jobs', body),
    onSettled: () => { void qc.invalidateQueries({ queryKey: nachher }) }
  })
}

export function useCancelTerminalJob(nachher: readonly unknown[]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobRef: string) => api.post(`/v1/terminal-jobs/${jobRef}/cancel`),
    onSettled: () => { void qc.invalidateQueries({ queryKey: nachher }) }
  })
}

// ------------------------------------------------- Bedienfeld

/**
 * Alle Terminals des Hauses mit ihrem Auftrag, dazu was sich ohne
 * Reservierung zeigen laesst. Solange irgendwo ein Auftrag offen ist, alle
 * zwei Sekunden, sonst alle zehn -- ein Terminal, das gerade erst
 * eingeschaltet wurde, soll nicht minutenlang als "nicht erreichbar" stehen.
 */
export const useTerminalPult = (propertyId: number) =>
  useQuery<Pult>({
    queryKey: ['terminal-desk', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/terminal-desk`),
    staleTime: 0,
    refetchInterval: q =>
      q.state.data?.terminals.some(t => istOffen(t.job?.state)) === true ? 2_000 : 10_000
  })

// ------------------------------------------------- Inhalte (Einstellungen)

export const useTerminalInhalte = (propertyId: number) =>
  useQuery<{ contents: Seite[]; urls: Adresse[] }>({
    queryKey: ['terminal-content', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/terminal-content`)
  })

function useInhaltAenderung<T>(propertyId: number, fn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['terminal-content', propertyId] })
      void qc.invalidateQueries({ queryKey: ['terminal-desk', propertyId] })
    }
  })
}

export const useCreateSeite = (propertyId: number) =>
  useInhaltAenderung(propertyId, (b: { title: string; body: string }) =>
    api.post<{ contentRef: string }>(`/v1/properties/${propertyId}/terminal-content`, b))

export const useAendereSeite = (propertyId: number) =>
  useInhaltAenderung(propertyId, (b: { contentRef: string; title: string; body: string }) =>
    api.patch(`/v1/properties/${propertyId}/terminal-content/${b.contentRef}`,
      { title: b.title, body: b.body }))

export const useArchiviereSeite = (propertyId: number) =>
  useInhaltAenderung(propertyId, (contentRef: string) =>
    api.delete(`/v1/properties/${propertyId}/terminal-content/${contentRef}`))

export const useSeitenbild = (propertyId: number) =>
  useInhaltAenderung(propertyId, (b: { contentRef: string; data: string | null }) =>
    b.data === null
      ? api.delete(`/v1/properties/${propertyId}/terminal-content/${b.contentRef}/image`)
      : api.put(`/v1/properties/${propertyId}/terminal-content/${b.contentRef}/image`,
          { data: b.data }))

export const useDiashow = (propertyId: number) =>
  useInhaltAenderung(propertyId, (slides: Array<{ contentRef: string; seconds: number }>) =>
    api.put(`/v1/properties/${propertyId}/terminal-slideshow`, { slides }))

export const useCreateAdresse = (propertyId: number) =>
  useInhaltAenderung(propertyId, (b: { label: string; url: string }) =>
    api.post(`/v1/properties/${propertyId}/terminal-urls`, b))

export const useEntferneAdresse = (propertyId: number) =>
  useInhaltAenderung(propertyId, (urlRef: string) =>
    api.delete(`/v1/properties/${propertyId}/terminal-urls/${urlRef}`))
