import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { MaintenanceTicket, CreateMaintenanceTicket, EmailSettings,
              PaymentMethod, CreatePaymentMethod, Category, Room }
  from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Abfragen fuer Haus und Einstellungen.
 *
 * **Ein Aufruf je Bildschirm.** Die Wartungsliste bringt die laufenden
 * Sperrungen des Zimmers als Feld mit; sie je Meldung nachzuladen waere eine
 * Runde je Zeile, und ohne sie ist an der Meldung nicht zu sehen, ob das
 * Zimmer gerade Kapazitaet kostet.
 *
 * **Nach dem Schreiben wird gezielt nachgeladen.** Eine stillgelegte
 * Zimmergruppe aendert die Kapazitaet und damit den Zimmerplan; ihn stehen
 * zu lassen zeigte fuer den Rest der Sitzung eine Belegung, die es nicht
 * mehr gibt.
 */

// ------------------------------------------------------------- Wartung (C5)

export const useMaintenanceTickets = (propertyId: number, status?: string) =>
  useQuery<{ tickets: MaintenanceTicket[] }>({
    queryKey: ['maintenance', propertyId, status ?? 'alle'],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/maintenance-tickets`
      + (status === undefined ? '' : `?status=${status}`))
  })

export function useCreateMaintenanceTicket(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateMaintenanceTicket) =>
      api.post<{ ticketId: number }>('/v1/maintenance-tickets', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance', propertyId] })
      // Eine Sperrung als Out of Order nimmt dem Verkauf ein Zimmer.
      void qc.invalidateQueries({ queryKey: ['tape'] })
      void qc.invalidateQueries({ queryKey: ['rooms', propertyId] })
    }
  })
}

export function useUpdateMaintenanceTicket(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; status?: string; priority?: string }) =>
      api.patch(`/v1/maintenance-tickets/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance', propertyId] })
    }
  })
}

// ------------------------------------------------------------ Gastpost (C6)

export const useEmailSettings = (propertyId: number) =>
  useQuery<EmailSettings>({
    queryKey: ['emailSettings', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/email-settings`)
  })

export function useSaveEmailSettings(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { fromName: string; fromEmail: string
                         replyTo?: string | null; bccEmail?: string | null
                         enabled?: boolean }) =>
      api.put(`/v1/properties/${propertyId}/email-settings`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['emailSettings', propertyId] })
    }
  })
}

// -------------------------------------------------------- Zahlungsarten (C7)

/**
 * Zur Pflege auch die stillgelegten. Die Auswahl am Folio holt weiterhin nur
 * die aktiven -- eine stillgelegte Zahlungsart soll dort nicht auftauchen.
 */
export const usePaymentMethodsAll = (propertyId: number) =>
  useQuery<{ paymentMethods: PaymentMethod[]; hinweis: string
                   hinweisKey: string }>({
    queryKey: ['paymentMethods', propertyId, 'alle'],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/payment-methods?includeInactive=true`)
  })

function zahlartenNeuLaden(qc: ReturnType<typeof useQueryClient>, propertyId: number): void {
  // Beide Schluessel: die Pflegeliste und die Auswahl am Folio.
  void qc.invalidateQueries({ queryKey: ['paymentMethods', propertyId] })
}

export function useCreatePaymentMethod(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreatePaymentMethod) =>
      api.post<{ paymentMethodId: number }>(
        `/v1/properties/${propertyId}/payment-methods`, body),
    onSuccess: () => { zahlartenNeuLaden(qc, propertyId) }
  })
}

export function useUpdatePaymentMethod(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; isExternal?: boolean
                                    sortOrder?: number; active?: boolean }) =>
      api.patch<PaymentMethod>(`/v1/payment-methods/${id}`, body),
    onSuccess: () => { zahlartenNeuLaden(qc, propertyId) }
  })
}

// ------------------------------------------------------------ Stammdaten (C11)

function stammdatenNeuLaden(
  qc: ReturnType<typeof useQueryClient>, propertyId: number
): void {
  void qc.invalidateQueries({ queryKey: ['categories', propertyId] })
  void qc.invalidateQueries({ queryKey: ['rooms', propertyId] })
  void qc.invalidateQueries({ queryKey: ['setup', propertyId] })
  // Stilllegen und Umgruppieren verschieben Kapazitaet. Der Zimmerplan
  // zeigte sonst weiter die alte.
  void qc.invalidateQueries({ queryKey: ['tape'] })
}

export function useUpdateCategory(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Partial<Pick<Category,
      'code' | 'name' | 'description' | 'maxOccupancy' | 'sortOrder'
      | 'overbookingLimit' | 'active'>>) =>
      api.patch(`/v1/categories/${id}`, body),
    onSuccess: () => { stammdatenNeuLaden(qc, propertyId) }
  })
}

export function useUpdateRoom(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Partial<Pick<Room,
      'code' | 'floor' | 'attributes' | 'categoryId' | 'active'>>) =>
      api.patch(`/v1/rooms/${id}`, body),
    onSuccess: () => { stammdatenNeuLaden(qc, propertyId) }
  })
}
