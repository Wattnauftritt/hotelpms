import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Guest, GuestCreated, CreateGuest, Company, CreateCompany } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Gastsuche (A6). Läuft über einen Index auf dem Nachnamen; die Oberfläche
 * fragt erst ab zwei Zeichen und lädt nicht je Zeile nach.
 */
export const useSearchGuests = (term: string) =>
  useQuery<{ guests: Guest[] }>({
    queryKey: ['guests', 'search', term],
    queryFn: () => api.get(`/v1/guests?q=${encodeURIComponent(term)}`),
    enabled: term.trim().length >= 2
  })

export const useGuest = (guestRef: string | null) =>
  useQuery<Guest>({
    queryKey: ['guest', guestRef],
    queryFn: () => api.get(`/v1/guests/${guestRef!}`),
    enabled: guestRef !== null
  })

export function useCreateGuest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateGuest) => api.post<GuestCreated>('/v1/guests', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['guests', 'search'] }) }
  })
}

export function usePatchGuest(guestRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<CreateGuest>) => api.patch<Guest>(`/v1/guests/${guestRef}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['guest', guestRef] })
      void qc.invalidateQueries({ queryKey: ['guests', 'search'] })
    }
  })
}

/**
 * Ausweisnummer, hinter einer eigenen Berechtigung und einer eigenen
 * Anfrage (`guest:read_identity`): sie soll nicht bei jeder Gastanzeige
 * mitlaufen. Maskiert, ausser `full` wird ausdruecklich verlangt.
 */
export const useIdDocument = (guestRef: string | null, full: boolean) =>
  useQuery<{ guestRef: string; idDocumentType: string | null; number: string | null }>({
    queryKey: ['guest', guestRef, 'id-document', full],
    queryFn: () => api.get(`/v1/guests/${guestRef!}/id-document${full ? '?full=true' : ''}`),
    enabled: guestRef !== null
  })

export const useSearchCompanies = (term: string) =>
  useQuery<{ companies: Array<{ companyRef: string; name: string; vatId: string | null
                                city: string | null; paymentTermsDays: number }> }>({
    queryKey: ['companies', 'search', term],
    queryFn: () => api.get(`/v1/companies?q=${encodeURIComponent(term)}`),
    enabled: term.trim().length >= 2
  })

export const useCompany = (companyRef: string | null) =>
  useQuery<Company>({
    queryKey: ['company', companyRef],
    queryFn: () => api.get(`/v1/companies/${companyRef!}`),
    enabled: companyRef !== null
  })

export function useCreateCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateCompany) =>
      api.post<{ companyRef: string; name: string }>('/v1/companies', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['companies', 'search'] }) }
  })
}

export function usePatchCompany(companyRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<CreateCompany> & { active?: boolean }) =>
      api.patch<Company>(`/v1/companies/${companyRef}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['company', companyRef] })
      void qc.invalidateQueries({ queryKey: ['companies', 'search'] })
    }
  })
}

// --------------------------------------------------- Betroffenenrechte (DSGVO)

/** Was die Auskunft nach Art. 15 DSGVO ueber einen Gast zusammentraegt. */
export interface GuestDataExport {
  profile: Guest
  createdAt: string
  stays: Array<{ reservationRef: string; property: string; arrival: string
                 departure: string; status: string }>
  invoices: Array<{ number: string; issuedOn: string; grossCent: number }>
  notes: Array<{ note: string; createdAt: string; property: string }>
  registrations: Array<{ arrival: string; plannedDeparture: string
                         destroyAfter: string }>
  hinweis: string
  hinweisKey?: string
}

/**
 * Auskunft nach Art. 15 DSGVO.
 *
 * `enabled` steht auf false und wird erst durch einen Klick wahr: die
 * Auskunft zieht Aufenthalte, Rechnungen, Notizen und Meldescheine zusammen.
 * Sie bei jedem Oeffnen eines Profils mitzuladen waere eine Handvoll
 * Abfragen fuer etwas, das ein paarmal im Jahr gebraucht wird.
 */
export const useGuestDataExport = (guestRef: string, aktiv: boolean) =>
  useQuery<GuestDataExport>({
    queryKey: ['guest', guestRef, 'data-export'],
    queryFn: () => api.get(`/v1/guests/${guestRef}/data-export`),
    enabled: aktiv,
    // Eine Auskunft ist eine Momentaufnahme, die ausgedruckt und
    // herausgegeben wird. Sie unter der Hand nachzuladen hiesse, dass das
    // Papier und der Bildschirm auseinanderlaufen.
    staleTime: Infinity,
    refetchOnWindowFocus: false
  })

export function useAnonymizeGuest(guestRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ guestRef: string; status: string; alreadyDone: boolean }>(
      `/v1/guests/${guestRef}/anonymize`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['guest', guestRef] })
      // Die Suche zeigt anonymisierte Profile nicht mehr an.
      void qc.invalidateQueries({ queryKey: ['guests', 'search'] })
    }
  })
}
