import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { GuestFolderSettings, GuestFolderSettingsSet,
              GuestFolderCards } from '@hotelpms/contracts'
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
