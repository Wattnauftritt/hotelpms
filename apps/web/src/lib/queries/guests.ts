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
