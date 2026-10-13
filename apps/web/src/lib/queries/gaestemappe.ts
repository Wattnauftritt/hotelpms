import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { GuestFolderSettings, GuestFolderSettingsSet,
              GuestFolderCards, FolderPageTextSet, GuestRequestCatalog,
              GuestRequestDeclineReason, GuestRequestItemInput,
              GuestRequestRow } from '@hotelpms/contracts'
import { api } from '../api.js'

/** Digitale Gaestemappe: Einstellung, Seiten und Zimmerkarten (Migration 0143). */

const schluessel = (propertyId: number) => ['guest-folder', propertyId] as const

export const useGaestemappe = (propertyId: number) =>
  useQuery<GuestFolderSettings>({
    queryKey: schluessel(propertyId),
    queryFn: () => api.get(`/v1/properties/${propertyId}/guest-folder`)
  })

export function useGaestemappeSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: GuestFolderSettingsSet) =>
      api.put<GuestFolderSettings>(`/v1/properties/${propertyId}/guest-folder`, body),
    onSuccess: d => {
      qc.setQueryData(schluessel(propertyId), d)
      void qc.invalidateQueries({ queryKey: ['guest-folder-cards', propertyId] })
    }
  })
}

export function useGaestemappeSeiten(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (contentRefs: string[]) =>
      api.put<GuestFolderSettings>(`/v1/properties/${propertyId}/guest-folder/pages`,
        { contentRefs }),
    onSuccess: d => { qc.setQueryData(schluessel(propertyId), d) }
  })
}

export const useZimmerkarten = (propertyId: number, enabled: boolean) =>
  useQuery<GuestFolderCards>({
    queryKey: ['guest-folder-cards', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/guest-folder/cards`),
    enabled
  })

export function useZimmerkarteErneuern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (resourceId: number) =>
      api.post<{ link: string }>(
        `/v1/properties/${propertyId}/guest-folder/rooms/${resourceId}/renew`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['guest-folder-cards', propertyId] })
    }
  })
}

/**
 * Eine Uebersetzung von Hand setzen oder zurueck an DeepL geben (0144).
 * `text: null` heisst zurueck: die Seite ist im naechsten Lauf wieder faellig.
 */
export function useGaestemappeUebersetzung(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ contentRef, lang, text }: {
      contentRef: string; lang: string; text: FolderPageTextSet | null }) => {
      const url = `/v1/properties/${propertyId}/guest-folder/pages/${contentRef}/translations/${lang}`
      return text === null
        ? api.delete<GuestFolderSettings>(url)
        : api.put<GuestFolderSettings>(url, text)
    },
    onSuccess: d => { qc.setQueryData(schluessel(propertyId), d) }
  })
}

/** Alle Freischaltungen einer Reservierung aufheben, an der Rezeption (0147). */
export function useMappeFreischaltungenAufheben(reservationRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ revoked: number }>(`/v1/reservations/${reservationRef}/guest-folder/revoke`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
    }
  })
}

// ------------------------------------------------------------ Wuensche (0149)

const katalogSchluessel = (propertyId: number) => ['guest-request-items', propertyId] as const

export const useWunschkatalog = (propertyId: number) =>
  useQuery<GuestRequestCatalog>({
    queryKey: katalogSchluessel(propertyId),
    queryFn: () => api.get(`/v1/properties/${propertyId}/guest-folder/request-items`)
  })

export function useWunschEintragSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ itemRef, eintrag }: { itemRef: string | null; eintrag: GuestRequestItemInput }) =>
      itemRef === null
        ? api.post<GuestRequestCatalog>(
            `/v1/properties/${propertyId}/guest-folder/request-items`, eintrag)
        : api.put<GuestRequestCatalog>(
            `/v1/properties/${propertyId}/guest-folder/request-items/${itemRef}`, eintrag),
    onSuccess: d => { qc.setQueryData(katalogSchluessel(propertyId), d) }
  })
}

/**
 * Einen Gaestewunsch erledigen oder ablehnen. Danach stimmen "Heute" und
 * das Seitenfenster nicht mehr; beide laden neu, und das Folio auch, weil
 * ein Extra mit Preis darauf gebucht wurde.
 */
export function useWunschBearbeiten() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ requestRef, reason }: { requestRef: string
                                           reason: GuestRequestDeclineReason | null }) =>
      reason === null
        ? api.post<GuestRequestRow>(`/v1/guest-requests/${requestRef}/done`, {})
        : api.post<GuestRequestRow>(`/v1/guest-requests/${requestRef}/decline`, { reason }),
    onSuccess: d => {
      void qc.invalidateQueries({ queryKey: ['daily'] })
      void qc.invalidateQueries({ queryKey: ['reservation', d.reservationRef] })
      void qc.invalidateQueries({ queryKey: ['folio'] })
      // Eine angenommene Verlaengerung (0156) rueckt die Abreise: Plan und
      // Verfuegbarkeit stimmen danach nicht mehr.
      if (d.isExtension) {
        void qc.invalidateQueries({ queryKey: ['tape'] })
        void qc.invalidateQueries({ queryKey: ['availability'] })
      }
    }
  })
}
