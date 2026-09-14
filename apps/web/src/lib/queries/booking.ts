import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReservationDetail } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Eine Reservierung, vollständig, in einem Aufruf: Gast, Zimmer, Nächte mit
 * Preisen, Mitreisende, Folio und Notiz. Das ist die Antwort auf einen
 * angeklickten Balken im Belegungsplan (Aufgabe A1).
 */
export const useReservation = (reservationRef: string | null) =>
  useQuery<ReservationDetail>({
    queryKey: ['reservation', reservationRef],
    queryFn: () => api.get(`/v1/reservations/${reservationRef!}`),
    enabled: reservationRef !== null
  })

/**
 * Notiz an der Reservierung. Eine eigene, kleine Mutation und kein Feld in
 * einem größeren Formular: sie berührt weder Bestand noch Preis noch
 * Zustand (A5).
 */
export function usePatchReservationNotes(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (notes: string | null) =>
      api.patch<{ reservationRef: string; notes: string | null }>(
        `/v1/reservations/${reservationRef}`, { notes }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
      // Die Notiz steht am Balken; ohne das sieht man sie erst nach einem
      // vollstaendigen Neuladen des Plans.
      void qc.invalidateQueries({ queryKey: ['tape'] })
    }
  })
}
