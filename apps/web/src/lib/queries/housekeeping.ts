import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { HousekeepingState } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Reinigungsstand aus dem Belegungsplan setzen.
 *
 * **Dieselbe Route wie der Housekeeping-Bildschirm** (`PUT
 * /v1/housekeeping/status`, `housekeeping:write`), kein zweiter Weg. Die
 * Route setzt alle Zimmer in **einer** Transaktion und weist alles ab,
 * sobald eines nicht zum Haus gehoert -- darauf beruht "alle oder keines"
 * bei einer Mehrfachmarkierung.
 *
 * Neben `useSetHousekeeping` in `../queries.ts`, weil dieser Aufruf zwei
 * Bildschirme betrifft und nicht einen: nach dem Setzen sind Plan und
 * Zimmerstatus beide veraltet. Ohne das Nachladen des Plans stuende dort
 * das alte Zeichen, bis jemand blaettert.
 */
export function usePlanReinigung(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { resourceIds: number[]; status: HousekeepingState }) =>
      api.put('/v1/housekeeping/status', { propertyId, ...body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tape', propertyId] })
      void qc.invalidateQueries({ queryKey: ['hk', propertyId] })
    }
  })
}
