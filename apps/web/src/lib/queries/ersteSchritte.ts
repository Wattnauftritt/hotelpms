import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'
import type { FirstSetupBody, FirstSetupReport } from '../ersteSchritte.js'

/**
 * Erste Einrichtung. Ohne `commit` eine Vorschau, die nichts schreibt; die
 * Zwischenspeicher bleiben dann unberührt.
 *
 * Nach dem Anlegen wird **alles** neu geladen, nicht eine Liste von
 * Schlüsseln: Gruppen, Zimmer, Raten, Preisraster, Verfügbarkeit, Plan und
 * Einrichtungsstand haben sich alle geändert, und eine vergessene Zeile hier
 * zeigte nach dem Assistenten einen leeren Plan, der eben noch gefüllt wurde.
 * Es passiert einmal im Leben eines Hauses.
 */
export function useFirstSetup(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: FirstSetupBody) =>
      api.post<FirstSetupReport>(`/v1/properties/${propertyId}/first-setup`, body),
    onSuccess: (_r, body) => {
      if (body.commit) void qc.invalidateQueries()
    }
  })
}
