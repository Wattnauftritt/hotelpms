import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { InvoiceList } from '@hotelpms/contracts'
import { api, ApiError } from '../api.js'
import { addDays } from '../dates.js'

/**
 * Rechnungen: Liste, Beleg, Versand.
 *
 * **Der Beleg wird nicht neu gezeichnet.** Geholt wird, was der Worker
 * erzeugt hat -- ein Beleg, der bei jedem Abruf neu entstuende, waere bei
 * jedem Abruf ein anderer, und der Gast haelt eine Fassung in der Hand, die
 * das Haus nicht mehr kennt.
 */

/** Ein Jahr je Anfrage, wie der Endpunkt. */
export const MAX_RECHNUNGSTAGE = 400

/**
 * Der Zeitraum einer Liste: `laenge` Tage, die auf `bis` enden --
 * **einschliesslich** beider Enden. 30 Tage bis zum 30. Oktober beginnen am
 * 1., nicht am 30. September; ein Tag daneben heisst, dass die aelteste
 * Rechnung fehlt oder eine zu viel erscheint.
 */
export function zeitraum(bis: string, laenge: number): { von: string; bis: string } {
  return { von: addDays(bis, -(laenge - 1)), bis }
}

export interface Postausgang {
  emails: Array<{
    messageRef: string; kind: string; subject: string; status: string
    attempts: number; createdAt: string; sentAt: string | null
    lastError: string | null; invoiceRef: string | null; toMasked: string | null
  }>
}

export const useInvoices = (
  propertyId: number, from: string, to: string, kind: string | null
) =>
  useQuery<InvoiceList>({
    queryKey: ['invoices', propertyId, from, to, kind],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/invoices?from=${from}&to=${to}`
      + (kind === null ? '' : `&kind=${kind}`)),
    staleTime: 30_000
  })

/**
 * Der Beleg als Blob.
 *
 * Nicht ueber `api.get`: der liest Text und wuerde die Bytes des PDF
 * zerstoeren. Der Endpunkt liefert `content-disposition: attachment`; als
 * Blob mit eigener Adresse laesst sich derselbe Abruf **ansehen** und
 * herunterladen, ohne ihn zweimal zu holen.
 *
 * `document_pending` (409) ist kein Fehler, sondern ein Zustand: die
 * Rechnung ist festgeschrieben, der Worker zeichnet noch. Die Maske sagt
 * das, statt eine rote Meldung zu zeigen.
 */
export async function holeBeleg(invoiceRef: string): Promise<Blob> {
  const res = await fetch(`/v1/invoices/${invoiceRef}/pdf`, {
    credentials: 'same-origin'
  })
  if (!res.ok) {
    const text = await res.text()
    let problem: unknown = null
    try { problem = JSON.parse(text) } catch { problem = null }
    throw new ApiError(
      problem !== null && typeof problem === 'object' && 'title' in problem
        ? problem as never
        : { type: 'urn:hotelpms:unknown', title: res.statusText, status: res.status },
      res.status)
  }
  return await res.blob()
}

/** Wartet der Beleg noch auf den Worker? */
export function istBelegInArbeit(fehler: unknown): boolean {
  return fehler instanceof ApiError
    && fehler.problem.type === 'urn:hotelpms:document_pending'
}

export function useBeleg(invoiceRef: string | null) {
  return useQuery<Blob>({
    queryKey: ['beleg', invoiceRef],
    queryFn: () => holeBeleg(invoiceRef!),
    enabled: invoiceRef !== null,
    // Ein fertiger Beleg aendert sich nie wieder; ein fehlender wird beim
    // naechsten Blick erneut versucht, nicht in einer Schleife.
    staleTime: Infinity,
    retry: false
  })
}

export function useSendInvoice(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ invoiceRef, to, resend }:
                 { invoiceRef: string; to?: string; resend?: boolean }) =>
      api.post<{ messageRef: string; status: string }>(
        `/v1/invoices/${invoiceRef}/send`,
        { ...(to === undefined || to === '' ? {} : { to }),
          ...(resend === true ? { resend: true } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices', propertyId] })
      void qc.invalidateQueries({ queryKey: ['outbox', propertyId] })
    }
  })
}

export const useOutbox = (propertyId: number, aktiv: boolean) =>
  useQuery<Postausgang>({
    queryKey: ['outbox', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/outbound-emails?limit=50`),
    enabled: aktiv,
    staleTime: 15_000
  })

export function useCancelMail(propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (messageRef: string) =>
      api.post(`/v1/outbound-emails/${messageRef}/cancel`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['outbox', propertyId] })
      void qc.invalidateQueries({ queryKey: ['invoices', propertyId] })
    }
  })
}
