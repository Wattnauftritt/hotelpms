import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { KwhotelImportRequest, KwhotelImportReport } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Uebernahme aus Altsystemen. Kein Zwischenspeicher fuer den Bericht: er
 * nennt Gastnamen und gilt nur fuer genau die Datei, die gerade gewaehlt ist.
 */
export function useKwhotelImport(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Omit<KwhotelImportRequest, 'propertyId'>) =>
      api.post<KwhotelImportReport>('/v1/imports/legacy/kwhotel', { ...body, propertyId }),
    onSuccess: (bericht) => {
      if (bericht.dryRun) return
      // Hunderte Buchungen sind neu: Plan, Raster und Listen stimmen nicht mehr.
      void qc.invalidateQueries({ queryKey: ['tape'] })
      void qc.invalidateQueries({ queryKey: ['availability', propertyId] })
      void qc.invalidateQueries({ queryKey: ['arrivals'] })
      // Und vielleicht neue Zimmer und Zimmergruppen aus dem Rueckfragedialog.
      void qc.invalidateQueries({ queryKey: ['rooms', propertyId] })
      void qc.invalidateQueries({ queryKey: ['categories', propertyId] })
    }
  })
}
