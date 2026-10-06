import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api.js'

/**
 * Kassenbuch (Migration 0095). Ein Aufruf je Monat: Zeilen, laufender
 * Bestand, Belegverweise und Summen kommen zusammen, nichts wird je Zeile
 * nachgeladen.
 */

export type Kassenart =
  | 'lodging' | 'breakfast_food' | 'breakfast_drinks' | 'city_tax'
  | 'cash_in' | 'bank_deposit' | 'expense' | 'other' | 'legacy_guest'

export interface Kassenbeleg { ref: string; mime: string }

export interface Kassenzeile {
  entryNo: number
  businessDate: string
  kind: Kassenart
  amountCent: number
  taxRateBp: number
  text: string | null
  guestName: string | null
  /** Nummer der ersten Zeile einer Gastbuchung, an den weiteren Zeilen. */
  groupNo: number | null
  reversesNo: number | null
  voidedByNo: number | null
  /** `null` bei stornierten Zeilen, ihren Gegenbuchungen und vor dem Anfangsbestand. */
  balanceAfterCent: number | null
  receipts: Kassenbeleg[]
  externalNumber: string | null
  datevExported: boolean
  createdBy: string | null
  createdAt: string
}

export interface Steuergruppe { rateBp: number; grossCent: number; netCent: number; taxCent: number }

export interface Kassenmonat {
  month: string
  today: string
  openingDate: string | null
  openingBalanceCent: number
  breakfastPriceCent: number
  breakfastFoodShareBp: number
  startBalanceCent: number
  closingBalanceCent: number
  todayBalanceCent: number
  incomeCent: number
  outgoingCent: number
  taxGroups: Steuergruppe[]
  /** Vorsteuer aus Abgaengen, getrennt von der Umsatzsteuer gefuehrt. */
  inputTaxGroups: Steuergruppe[]
  entries: Kassenzeile[]
}

export interface Kassenkonten {
  lodging: string; breakfastFood: string; breakfastDrinks: string; cityTax: string
  cashIn: string; bankDeposit: string; expense: string
}

export interface Kasseneinstellung {
  enabled: boolean
  openingBalanceCent: number
  openingDate: string | null
  breakfastPriceCent: number
  breakfastFoodShareBp: number
  chartOfAccounts: 'SKR03' | 'SKR04'
  accounts: Kassenkonten
  /** Ab diesem Geschaeftstag exportiert StayGrid an DATEV; vorher das Adminpanel. */
  datevFrom: string | null
}

export interface NeuerBeleg { data: string; name?: string }

export type Neubuchung =
  | { kind: 'guest'; businessDate: string; totalCent: number; breakfasts: number
      cityTaxCent: number; guestName?: string; text?: string; receipts?: NeuerBeleg[] }
  | { kind: 'city_tax' | 'cash_in' | 'bank_deposit' | 'expense' | 'other'
      businessDate: string; amountCent: number; taxRateBp?: number
      guestName?: string; text?: string; receipts?: NeuerBeleg[] }

export const useKasseneinstellung = (propertyId: number) =>
  useQuery<Kasseneinstellung>({
    queryKey: ['kassenbuch-einstellung', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/cashbook-settings`)
  })

export const useKassenmonat = (propertyId: number, monat: string | null, aktiv: boolean) =>
  useQuery<Kassenmonat>({
    queryKey: ['kassenbuch', propertyId, monat],
    queryFn: () => api.get(`/v1/properties/${propertyId}/cashbook`
      + (monat === null ? '' : `?month=${monat}`)),
    enabled: aktiv
  })

function useNachladen(propertyId: number) {
  const qc = useQueryClient()
  return () => { void qc.invalidateQueries({ queryKey: ['kassenbuch', propertyId] }) }
}

export function useBuchen(propertyId: number) {
  const nachladen = useNachladen(propertyId)
  return useMutation({
    mutationFn: (b: Neubuchung) =>
      api.post<{ entryNo: number; entryNos: number[] }>(
        `/v1/properties/${propertyId}/cashbook/entries`, b),
    onSuccess: nachladen
  })
}

export function useStornieren(propertyId: number) {
  const nachladen = useNachladen(propertyId)
  return useMutation({
    mutationFn: (v: { entryNo: number; reason?: string }) =>
      api.post<{ reversalNos: number[] }>(
        `/v1/properties/${propertyId}/cashbook/entries/${v.entryNo}/void`,
        { reason: v.reason }),
    onSuccess: nachladen
  })
}

export function useBelegNachreichen(propertyId: number) {
  const nachladen = useNachladen(propertyId)
  return useMutation({
    mutationFn: (v: { entryNo: number; beleg: NeuerBeleg }) =>
      api.post<Kassenbeleg>(
        `/v1/properties/${propertyId}/cashbook/entries/${v.entryNo}/receipts`, v.beleg),
    onSuccess: nachladen
  })
}

export function useKasseneinstellungSpeichern(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (e: Kasseneinstellung) =>
      api.put(`/v1/properties/${propertyId}/cashbook-settings`, e),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kassenbuch-einstellung', propertyId] })
      void qc.invalidateQueries({ queryKey: ['kassenbuch', propertyId] })
    }
  })
}

/** Adresse eines Belegs; der Browser zeigt ihn in einem neuen Reiter. */
export const belegAdresse = (propertyId: number, ref: string): string =>
  `/v1/properties/${propertyId}/cashbook/receipts/${ref}`

export interface DatevAuswahl { mode: 'unsent' | 'range'; from?: string; to?: string }

/**
 * Die DATEV-Datei herunterladen. Markiert nichts: was der Export enthielt,
 * sagt `through`, und erst `useDatevMarkieren` traegt es ein -- ein
 * abgebrochener Download laesst so keine Zeile als uebergeben zurueck.
 */
async function datevHolen(propertyId: number, a: DatevAuswahl): Promise<{ through: number; entries: number }> {
  const q = new URLSearchParams({ mode: a.mode, ...(a.from ? { from: a.from } : {}),
                                  ...(a.to ? { to: a.to } : {}) })
  const res = await fetch(`/v1/properties/${propertyId}/cashbook/datev?${q.toString()}`,
    { credentials: 'same-origin' })
  if (!res.ok) {
    let problem: unknown = null
    try { problem = JSON.parse(await res.text()) } catch { /* kein RFC-9457-Rumpf */ }
    throw new ApiError(problem !== null && typeof problem === 'object' && 'title' in problem
      ? problem as ApiError['problem']
      : { type: 'urn:staygrid:unknown', title: res.statusText, status: res.status }, res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
    ?? 'kassenbuch-datev.csv'
  link.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
  return { through: Number(res.headers.get('x-staygrid-cashbook-through') ?? 0),
           entries: Number(res.headers.get('x-staygrid-cashbook-entries') ?? 0) }
}

export const useDatevExport = (propertyId: number) =>
  useMutation({ mutationFn: (a: DatevAuswahl) => datevHolen(propertyId, a) })

export function useDatevMarkieren(propertyId: number) {
  const nachladen = useNachladen(propertyId)
  return useMutation({
    mutationFn: (v: DatevAuswahl & { through: number }) =>
      api.post<{ marked: number }>(`/v1/properties/${propertyId}/cashbook/datev/mark`, v),
    onSuccess: nachladen
  })
}
