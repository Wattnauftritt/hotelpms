import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Meldeschein als Datei fuer AVS (Migration 0091): Stand an der
 * Reservierung, Melden, erneut herunterladen, Einstellung des Hauses.
 */
export interface AvsStand {
  configured: boolean
  /** Ein Uebungshaus meldet nicht nach draussen. */
  training: boolean
  registered: boolean
  signaturePending: boolean
  reportedAt: string | null
  exportedHere: boolean
  digitalGuestCard: boolean
  hasEmail: boolean
}

export interface AvsDatei { fileName: string; xml: string; reportedAt: string; persons: number }

export interface AvsEinstellung {
  configured: boolean
  hotelId?: string
  origin?: string
  userName?: string
  minAge?: number
  defaultCategory?: number
  breakfastCent?: number
}

/**
 * `schluessel` haengt am Stand des Meldescheins im Dialog: wird er dort
 * angelegt oder unterschrieben, fragt der Stand neu, statt alt zu bleiben.
 */
export const useAvsStand = (reservationRef: string, schluessel: unknown) =>
  useQuery<AvsStand>({
    queryKey: ['avs', reservationRef, schluessel],
    queryFn: () => api.get(`/v1/reservations/${reservationRef}/avs-export`)
  })

/**
 * Die Datei dem Betrachter geben. Ueber einen Blob, weil die Antwort JSON
 * ist: so steht ein Fehler (Uebungshaus, schon gemeldet) als Meldung am
 * Knopf und nicht in einem leeren Fenster.
 */
export function dateiGeben(d: AvsDatei): void {
  const url = URL.createObjectURL(new Blob([d.xml], { type: 'application/xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = d.fileName
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

export function useAvsMelden(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { digitalGuestCard?: boolean }) =>
      api.post<AvsDatei>(`/v1/reservations/${reservationRef}/avs-export`, body),
    onSuccess: d => {
      dateiGeben(d)
      void qc.invalidateQueries({ queryKey: ['avs', reservationRef] })
      void qc.invalidateQueries({ queryKey: ['meldescheine'] })
    }
  })
}

export function useAvsErneut(reservationRef: string) {
  return useMutation({
    mutationFn: () => api.get<AvsDatei>(`/v1/reservations/${reservationRef}/avs-export/file`),
    onSuccess: dateiGeben
  })
}

export const useAvsEinstellung = (propertyId: number) =>
  useQuery<AvsEinstellung>({
    queryKey: ['avs-settings', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/avs-settings`)
  })

export function useAvsEinstellungSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { hotelId: string; origin: string; userName: string
                         minAge: number; defaultCategory: number
                         breakfastCent: number }) =>
      api.put<AvsEinstellung>(`/v1/properties/${propertyId}/avs-settings`, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['avs-settings', propertyId] }) }
  })
}
