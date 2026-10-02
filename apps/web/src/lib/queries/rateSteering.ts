import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SteeringOverview, SteerPreview, SteerApply, SteerRule, SteerPlanSettings,
              SteerMode, SteerRunChange, SteerRuleRow } from '@hotelpms/contracts'
import { api } from '../api.js'

/**
 * Preissteuerung (Dokument 32).
 *
 * **Zwei Aufrufe fuer den ganzen Bildschirm**, beide Aggregate: die
 * Einstellung samt Plaenen, Regeln und letzten Laeufen, und die Vorschau
 * eines Zeitraums ueber alle gesteuerten Plaene. Der Verlauf eines Laufs
 * kommt erst, wenn jemand ihn aufklappt -- einer, nicht je Zeile.
 */

export const useSteering = (propertyId: number) =>
  useQuery<SteeringOverview>({
    queryKey: ['rateSteering', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/rate-steering`),
    staleTime: 30_000
  })

export const useSteerPreview = (propertyId: number, from: string, to: string) =>
  useQuery<SteerPreview>({
    queryKey: ['rateSteerPreview', propertyId, from, to],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/rate-steering/preview?from=${from}&to=${to}`),
    // Die Vorschau haengt an der Belegung, und die bewegt sich mit jeder
    // Buchung. Kurz gehalten, damit "Uebernehmen" selten an einem
    // veralteten Fingerabdruck scheitert.
    staleTime: 10_000
  })

export const useSteerRun = (propertyId: number, runId: number | null) =>
  useQuery<{ runId: number; changes: SteerRunChange[]; rules: SteerRuleRow[] }>({
    queryKey: ['rateSteerRun', propertyId, runId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/rate-steering/runs/${runId}`),
    enabled: runId !== null,
    // Ein Lauf aendert sich nicht mehr (rate_steer_change ist unveraenderlich).
    staleTime: Infinity
  })

/**
 * Nach jeder Aenderung an Regeln, Leitplanken oder Modus ist die Vorschau
 * ungueltig; nach einer Uebernahme ausserdem das Preisraster und das, was
 * der Channel Manager sieht.
 */
function useVerwerfen(propertyId: number, auchPreise = false): () => void {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['rateSteering', propertyId] })
    void qc.invalidateQueries({ queryKey: ['rateSteerPreview', propertyId] })
    if (auchPreise) {
      void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] })
      void qc.invalidateQueries({ queryKey: ['channelView', propertyId] })
    }
  }
}

export function useSetSteerMode(propertyId: number) {
  const verwerfen = useVerwerfen(propertyId)
  return useMutation({
    mutationFn: (body: { mode: SteerMode; horizonDays: number }) =>
      api.put<{ mode: SteerMode; horizonDays: number }>(
        `/v1/properties/${propertyId}/rate-steering`, body),
    onSuccess: verwerfen
  })
}

export function useSetSteerPlan(propertyId: number) {
  const verwerfen = useVerwerfen(propertyId)
  return useMutation({
    mutationFn: ({ ratePlanId, ...body }: SteerPlanSettings & { ratePlanId: number }) =>
      api.put(`/v1/properties/${propertyId}/rate-steering/plans/${ratePlanId}`, body),
    onSuccess: verwerfen
  })
}

export function useSaveSteerRule(propertyId: number) {
  const verwerfen = useVerwerfen(propertyId)
  return useMutation({
    mutationFn: ({ id, rule }: { id: number | null; rule: SteerRule }) =>
      id === null
        ? api.post<{ ruleId: number }>(`/v1/properties/${propertyId}/rate-steering/rules`, rule)
        : api.put<{ ruleId: number }>(
            `/v1/properties/${propertyId}/rate-steering/rules/${id}`, rule),
    onSuccess: verwerfen
  })
}

export function useDeleteSteerRule(propertyId: number) {
  const verwerfen = useVerwerfen(propertyId)
  return useMutation({
    mutationFn: (id: number) =>
      api.delete(`/v1/properties/${propertyId}/rate-steering/rules/${id}`),
    onSuccess: verwerfen
  })
}

export function useApplySteering(propertyId: number) {
  const verwerfen = useVerwerfen(propertyId, true)
  return useMutation({
    mutationFn: (body: SteerApply) =>
      api.post<{ runId: number | null; changed: number }>(
        `/v1/properties/${propertyId}/rate-steering/apply`, body),
    // Auch nach einem Fehlschlag: eine veraltete Vorschau (409) soll sofort
    // durch die frische ersetzt werden, nicht erst nach zehn Sekunden.
    onSettled: verwerfen
  })
}
