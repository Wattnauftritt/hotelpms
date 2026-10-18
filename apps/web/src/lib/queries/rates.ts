import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ChannelView, RateGrid, RateInclusion, RatePlan, SetRates,
              SetRestrictions } from '@hotelpms/contracts'
import { api } from '../api.js'
import { addDays } from '../dates.js'

/**
 * Preise und Restriktionen.
 *
 * **Ein Aufruf für das ganze Jahr.** `rate-grid` liefert bis zu 400 Tage mal
 * allen Ratenplänen in einer Anfrage; genau dafür ist der Endpunkt gebaut.
 * Wer hier je Tag oder je Plan nachlädt, macht aus einer Runde vierhundert
 * (P-Gesetz, Dokument 04).
 */

/** Die Obergrenze des Endpunkts. Mehr nimmt er nicht an. */
export const MAX_RASTER_TAGE = 400

/**
 * Die Tage eines Rasters, **einschließlich** des letzten.
 *
 * `eachDay` in `lib/dates.ts` zählt Nächte und lässt den letzten Tag weg --
 * richtig für einen Aufenthalt, falsch für ein Preisraster: der 31. Dezember
 * ist ein Tag mit einem Preis, kein Abreisetag. Der Endpunkt rechnet ebenso
 * einschließlich, und eine Abweichung um einen Tag fiele erst auf, wenn an
 * Silvester kein Preis steht.
 */
export function tageInklusive(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export const useRatePlans = (propertyId: number) =>
  useQuery<{ ratePlans: RatePlan[]; vatRules: VatRule[]
              houseBreakfast: Fruehstueckswerte }>({
    queryKey: ['ratePlans', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/rate-plans`),
    // Ratenplaene aendern sich im Betrieb selten; die Preise darin taeglich.
    staleTime: 5 * 60_000
  })

export const useRateGrid = (
  propertyId: number, from: string, to: string, categoryId: number | null
) =>
  useQuery<RateGrid>({
    queryKey: ['rateGrid', propertyId, from, to, categoryId],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/rate-grid?from=${from}&to=${to}`
      + (categoryId === null ? '' : `&categoryId=${categoryId}`)),
    staleTime: 30_000
  })

/**
 * Preise setzen.
 *
 * Danach ist das Raster ungültig, und die abgeleiteten Raten sind es auch --
 * sie hängen an dieser Basis und werden seit Migration 0066 im selben
 * Schreibvorgang mitgerechnet. Deshalb wird das ganze Raster verworfen und
 * nicht nur die geänderte Zeile; ebenso die Vorschau der Preissteuerung,
 * deren Grundpreis sich gerade geändert hat.
 */
export function useSetRates(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SetRates) =>
      api.put<{ ratePlanId: number; days: number }>('/v1/rates/bulk', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateSteerPreview', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateCalendarPush', propertyId] })
    }
  })
}

/**
 * Einen Ratenplan anlegen.
 *
 * Abgeleitet oder eigenstaendig: eine abgeleitete Rate traegt ihre Preise
 * nicht als Formel, sondern materialisiert -- sonst kostete jede
 * Verfuegbarkeitsanfrage eine rekursive Aufloesung ueber die Kette. Nach dem
 * Anlegen steht sie deshalb **leer** da, bis einmal neu gerechnet wurde.
 */
export function useCreateRatePlan(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      code: string; name: string; categoryId: number
      baseRatePlanId?: number; deriveKind?: 'amount' | 'percent'; deriveValue?: number
    }) => api.post<{ ratePlanId: number; ratePlanRef: string }>(
      `/v1/properties/${propertyId}/rate-plans`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ratePlans', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] })
    }
  })
}

/** Ein Umsatzsteuersatz des Hauses, aus dem eine Inklusivleistung waehlt. */
export interface VatRule { id: number; name: string; rateBp: number }

/**
 * Weitere Inklusivleistungen setzen; die Liste ersetzt die bisherige
 * (Migration 0165). Wirkt ab der naechsten Nacht.
 */
export function useSetInclusions(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { ratePlanId: number; inclusions: RateInclusion[] }) =>
      api.put<{ ratePlanId: number; inclusions: RateInclusion[] }>(
        `/v1/properties/${propertyId}/rate-plans/${body.ratePlanId}/inclusions`,
        { inclusions: body.inclusions }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ratePlans', propertyId] })
    }
  })
}

/**
 * Fruehstueck im Ratenpreis setzen; `null` nimmt es heraus. Wirkt ab der
 * naechsten Nacht, die der Nachtlauf bucht (Migration 0158).
 */
/** Fruehstueck je Person und Nacht, an einer Rate oder als Regel des Hauses. */
export interface Fruehstueckswerte {
  breakfastCent: number | null; childBreakfastCent: number | null
}

/** Regel des Hauses (0169): gilt fuer Raten ohne eigenen Preis und Buchungen ohne Rate. */
export function useSetHouseBreakfast(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Fruehstueckswerte) =>
      api.put<Fruehstueckswerte>(`/v1/properties/${propertyId}/breakfast-rule`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ratePlans', propertyId] })
    }
  })
}

export function useSetBreakfast(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { ratePlanId: number; breakfastCent: number | null
                         childBreakfastCent: number | null }) =>
      api.put<{ ratePlanId: number; breakfastCent: number | null
                childBreakfastCent: number | null }>(
        `/v1/properties/${propertyId}/rate-plans/${body.ratePlanId}/breakfast`,
        { breakfastCent: body.breakfastCent, childBreakfastCent: body.childBreakfastCent }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ratePlans', propertyId] })
    }
  })
}

/** Abgeleitete Raten fuer einen Zeitraum neu rechnen. */
export function useRebuildDerived(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      api.post<{ plans: number; days: number }>(
        '/v1/rates/rebuild-derived', { propertyId, ...body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] }) }
  })
}

export function useSetRestrictions(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SetRestrictions) =>
      api.put<{ ratePlanId: number; days: number }>('/v1/restrictions/bulk', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateCalendarPush', propertyId] })
    }
  })
}

// -------------------------------------- Was der Channel Manager sieht (B10)

/**
 * Dieselbe Antwort, die der Channel Manager bekommt.
 *
 * **Das Ende ist ausschliesslich, nicht einschliesslich.** ARI zaehlt
 * Naechte: `from` bis `to` sind die Naechte dazwischen, und der letzte Tag
 * gehoert nicht dazu. Das Raster daneben zeigt Tage einschliesslich.
 * Beides ungeprueft zu verbinden heisst, dass der letzte Tag des Zeitraums
 * in der Gegenueberstellung fehlt -- und genau dieser Tag ist es dann, an
 * dem beim Portal ein anderer Preis steht.
 */
export function kanalZeitraum(von: string, bis: string): { from: string; to: string } {
  return { from: von, to: addDays(bis, 1) }
}

export const useChannelView = (
  propertyId: number, von: string, bis: string, aktiv: boolean
) =>
  useQuery<ChannelView>({
    queryKey: ['channelView', propertyId, von, bis],
    queryFn: () => {
      const { from, to } = kanalZeitraum(von, bis)
      return api.get(`/v1/properties/${propertyId}/channel-view?from=${from}&to=${to}`)
    },
    enabled: aktiv,
    // Was hinausgeht, aendert sich mit jeder Preispflege. Kurz gehalten,
    // damit die Gegenueberstellung nicht einen alten Stand zeigt.
    staleTime: 10_000
  })

/** Ein Abruf des Preiskalenders beim Umsystem (Migration 0179). */
export interface KalenderAbruf {
  pullRef: string
  status: 'requested' | 'delivered' | 'failed' | 'applied' | 'superseded'
  from: string
  to: string
  version: number
  requestedAt: string
  deliveredAt: string | null
  appliedAt: string | null
  message: string | null
  delivery: Array<{ ratePlanCode: string
                    result: 'accepted' | 'unknown_code' | 'derived' | 'inactive'
                    days: number }>
  result: { prices: number; restrictions: number } | null
}

export interface KalenderVorschau {
  priceChanges: number
  restrictionChanges: number
  plans: Array<{ ratePlanCode: string; name: string; days: number
                 priceChanges: number; restrictionChanges: number }>
  changes: Array<{ ratePlanCode: string; date: string; oldPriceCent: number[] | null
                   newPriceCent: number[] | null; restrictionChanged: boolean }>
}

/**
 * Stand des letzten Abrufs. Solange das Umsystem noch holt, wird alle drei
 * Sekunden nachgefragt; danach nicht mehr -- ein Bildschirm, der offen
 * steht, soll die API nicht den ganzen Tag beschaeftigen.
 */
export const useKalenderAbruf = (propertyId: number) =>
  useQuery<{ pull: KalenderAbruf | null; preview: KalenderVorschau | null }>({
    queryKey: ['rateCalendarPull', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/rate-calendar-pulls/current`),
    refetchInterval: q => q.state.data?.pull?.status === 'requested' ? 3_000 : false
  })

export function useKalenderAnfordern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      api.post<KalenderAbruf>(`/v1/properties/${propertyId}/rate-calendar-pulls`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rateCalendarPull', propertyId] })
    }
  })
}

/** Nach der Uebernahme gilt das Raster nicht mehr, ebenso die Steuerungsvorschau. */
export function useKalenderUebernehmen(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { pullRef: string; version: number }) =>
      api.post<KalenderAbruf>(
        `/v1/properties/${propertyId}/rate-calendar-pulls/${p.pullRef}/apply`,
        { version: p.version }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['rateCalendarPull', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateGrid', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateSteerPreview', propertyId] })
      void qc.invalidateQueries({ queryKey: ['rateCalendarPush', propertyId] })
    }
  })
}

/** Ein Senden an den Channel Manager (Migration 0179). Nie automatisch. */
export interface KalenderSenden {
  pushRef: string
  mode: 'changes' | 'range' | 'all'
  status: 'requested' | 'done' | 'failed' | 'superseded'
  from: string
  to: string
  days: number | null
  message: string | null
  requestedAt: string
  finishedAt: string | null
}

export const useKalenderSendenStand = (propertyId: number) =>
  useQuery<{ push: KalenderSenden | null; lastSentAt: string | null
             pendingChanges: number | null }>({
    queryKey: ['rateCalendarPush', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/rate-calendar-pushes/current`),
    refetchInterval: q => q.state.data?.push?.status === 'requested' ? 3_000 : false
  })

export function useKalenderSenden(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { mode: KalenderSenden['mode']; from?: string; to?: string }) =>
      api.post<KalenderSenden>(`/v1/properties/${propertyId}/rate-calendar-pushes`, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['rateCalendarPush', propertyId] })
    }
  })
}
