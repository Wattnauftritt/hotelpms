import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReservationDetail, BookingCreated, AvailabilityDay } from '@hotelpms/contracts'
import { api, newIdempotencyKey } from '../api.js'

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

/**
 * Den Hauptgast eines Zimmers setzen -- die Namensliste.
 *
 * Ein Bucher nimmt fuenf Zimmer, und die uebrigen Namen stehen bis zum
 * Anreisetag nicht fest; geplant wird mit seinem Namen. Am Tresen bekommt
 * dann jedes Zimmer seinen eigenen, weil § 30 BMG den tatsaechlichen Gast
 * verlangt und nicht den, der bestellt hat.
 *
 * Der Meldeschein wird mit ungueltig: er ist aus genau diesem Gast
 * vorbefuellt, und ein stehengebliebener Vordruck auf den alten Namen ist
 * die Art Fehler, die am Tresen niemand bemerkt.
 */
export function useSetReservationGuest(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (guestRef: string) =>
      api.patch<{ reservationRef: string; guestRef: string }>(
        `/v1/reservations/${reservationRef}`, { guestRef }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
      void qc.invalidateQueries({ queryKey: ['registration-form', reservationRef] })
      void qc.invalidateQueries({ queryKey: ['tape'] })
    }
  })
}

export interface CreateBookingBody {
  propertyId: number
  /** Entfaellt bei der Gruppenbuchung -- dann steht die Gruppe je Zimmer. */
  categoryId?: number
  /**
   * Mehrere Zimmer in **einer** Buchung. Kommt aus der Mehrfachauswahl im
   * Belegungsplan; die Reihenfolge ist die des Plans.
   */
  rooms?: Array<{ categoryId: number; resourceId?: number }>
  arrival: string
  departure: string
  ratePlanId?: number
  /** Die Oberflaeche kennt nur die oeffentliche Referenz, nie die laufende id. */
  guestRef?: string
  source?: string
  notes?: string
  resourceId?: number
}

/**
 * Buchung anlegen, im Plan mit vorbelegtem Zimmer und Zeitraum (A2). Der
 * Idempotenzschluessel entsteht je Absicht: einmal je Klick auf "Buchen",
 * nicht neu bei jedem Versuch -- sonst erzeugte ein zweiter Klick nach
 * einem langsamen ersten eine zweite Reservierung.
 */
export function useCreateBooking(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateBookingBody) =>
      api.post<BookingCreated>('/v1/bookings', body,
        { 'idempotency-key': newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tape'] })
      void qc.invalidateQueries({ queryKey: ['availability', propertyId] })
    }
  })
}

/**
 * Verschieben (A3). Schlaegt fehl, wenn das Zielzimmer belegt oder ausser
 * Betrieb ist -- und zwar **bevor** der Balken im Plan optisch springt.
 */
export function useAssignUnit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ reservationRef, resourceId }: { reservationRef: string; resourceId: number }) =>
      api.post<{ reservationRef: string; resourceId: number }>(
        `/v1/reservations/${reservationRef}/assign-unit`, { resourceId }),
    onSuccess: (_r, { reservationRef }) => {
      void qc.invalidateQueries({ queryKey: ['tape'] })
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
    }
  })
}

export interface ChangeStayBody {
  reservationRef: string
  arrival?: string
  departure?: string
  categoryId?: number
}

/** Verkuerzen, verlaengern oder umkategorisieren (A4). Nie Storno plus Neubuchung. */
export function useChangeStay() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ reservationRef, ...body }: ChangeStayBody) =>
      api.post(`/v1/reservations/${reservationRef}/change-stay`, body),
    onSuccess: (_r, { reservationRef }) => {
      void qc.invalidateQueries({ queryKey: ['tape'] })
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
    }
  })
}

/** Storno und Wiederherstellen (A11). Zwei Aktionen, eine Mutation. */
export function useReservationStatusAction(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: 'cancel' | 'reinstate') =>
      api.post<{ reservationRef: string; status: string }>(
        `/v1/reservations/${reservationRef}/${action}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
      void qc.invalidateQueries({ queryKey: ['tape'] })
    }
  })
}

/**
 * Buchungsbestaetigung schicken (A12). Ohne hinterlegte Adresse antwortet
 * die API mit 422 statt zu verschicken -- das Seitenfenster zeigt das als
 * Fehler, nicht als stilles Nichtstun.
 */
export function useSendConfirmation(reservationRef: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ messageRef: string; status: string }>(
        `/v1/reservations/${reservationRef}/send-confirmation`)
  })
}

/**
 * Verfuegbarkeitsraster (A8): Zimmergruppe × Tag, bis 731 Tage in einem
 * Aufruf.
 */
export const useAvailability = (propertyId: number, from: string, to: string) =>
  useQuery<{ days: AvailabilityDay[] }>({
    queryKey: ['availability', propertyId, from, to],
    queryFn: () => api.get(`/v1/properties/${propertyId}/availability?from=${from}&to=${to}`)
  })

export interface RegistrationForm {
  reservationRef: string
  property: string
  arrival: string
  plannedDeparture: string
  occupantCount: number
  guest: { guestRef: string; lastName: string; firstName: string | null
           birthDate: string | null; nationality: string | null
           address: { line1: string | null; postalCode: string | null
                      city: string | null; country: string | null } } | null
  isForeign: boolean
  signatureRequired: boolean
  alreadyRegistered: boolean
  signedAt: string | null
}

/** Vorbefuellter Meldeschein (A9): alles, was das Haus schon weiss, in einem Aufruf. */
export const useRegistrationForm = (reservationRef: string | null) =>
  useQuery<RegistrationForm>({
    queryKey: ['registration-form', reservationRef],
    queryFn: () => api.get(`/v1/reservations/${reservationRef!}/registration-form`),
    enabled: reservationRef !== null
  })

export function useSubmitRegistration(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    /**
     * `occupantGuestRefs` nimmt die API seit jeher an -- daraus entsteht bei
     * einer Reisegruppe der Sammelmeldeschein, bei dem jeder Mitreisende
     * einen eigenen Datensatz bekommt, der auf den Hauptschein zeigt.
     * Geschickt hat die Oberflaeche sie nie, und damit war die halbe
     * Meldepflicht nicht bedienbar: gemeldet wurde nur, wer gebucht hatte.
     */
    mutationFn: (body: { reservationRef: string; signatureSvg?: string
                         occupantGuestRefs?: string[] }) =>
      api.post<{ registrationId: number }>('/v1/registrations', { propertyId, ...body }),
    onSuccess: (_r, { reservationRef }) => {
      void qc.invalidateQueries({ queryKey: ['registration-form', reservationRef] })
    }
  })
}

/** Check-in (A9). Erfordert ein zugewiesenes Zimmer -- die API prueft es, die Maske sagt es vorher. */
export function useCheckIn(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ reservationRef: string; status: string }>(
        `/v1/reservations/${reservationRef}/check-in`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
      void qc.invalidateQueries({ queryKey: ['tape'] })
    }
  })
}

export interface Hausbedingung {
  termsRef: string
  code: string
  version: number
  title: string
  body: string
  requiresSignature: boolean
  agreed: boolean
  agreedAt: string | null
  signed: boolean
}

/**
 * Die Hausbedingungen, die fuer **diesen** Aufenthalt gelten.
 *
 * Nicht die neuesten, sondern die am Anreisetag geltenden: der Gast hat bei
 * der Ankunft den Text vor sich, der dann haengt. Ein Aufruf fuer alle, mit
 * dem Stand der Zustimmung darin -- sonst braeuchte die Maske einen zweiten
 * je Bedingung.
 */
export const useTerms = (reservationRef: string | null) =>
  useQuery<{ reservationRef: string; terms: Hausbedingung[] }>({
    queryKey: ['terms', reservationRef],
    queryFn: () => api.get(`/v1/reservations/${reservationRef!}/terms`),
    enabled: reservationRef !== null
  })

/**
 * Zustimmung zu **einer Fassung**.
 *
 * Getrennt vom Meldeschein, und das ist der Punkt: der Meldeschein ist
 * oeffentlich-rechtlich und wird nach einem Jahr vernichtet, eine
 * Vereinbarung ueber eine Pauschale ist privatrechtlich und muss laenger
 * nachweisbar bleiben. Ein inlaendischer Gast unterschreibt seit dem
 * 1.1.2025 keinen Meldeschein mehr -- diese Bedingung sehr wohl.
 */
export function useAgreeTerms(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ termsRef, signatureSvg }:
                 { termsRef: string; signatureSvg?: string }) =>
      api.post<{ termsRef: string; signed: boolean }>(
        `/v1/reservations/${reservationRef}/terms/${termsRef}/agree`,
        { signatureSvg }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['terms', reservationRef] })
    }
  })
}

export interface TermsFassung {
  termsRef: string
  code: string
  version: number
  title: string
  body: string
  requiresSignature: boolean
  activeFrom: string
  activeTo: string | null
}

/** Alle Fassungen des Hauses, fuer die Einrichtung. */
export const usePropertyTerms = (propertyId: number) =>
  useQuery<{ terms: TermsFassung[] }>({
    queryKey: ['property-terms', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/terms`)
  })

/**
 * Neue Fassung anlegen. Nie aendern: ein geaenderter Text unter einer alten
 * Unterschrift waere als Nachweis wertlos.
 */
export function useCreateTerms(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { code: string; title: string; body: string
                         requiresSignature: boolean }) =>
      api.post<{ termsRef: string; version: number }>(
        `/v1/properties/${propertyId}/terms`, { propertyId, ...body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['property-terms', propertyId] })
    }
  })
}
