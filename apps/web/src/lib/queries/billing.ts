import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { InvoiceList, InvoiceRecipient, PaymentLinkCreated,
              PrepaymentView } from '@hotelpms/contracts'
import { api, ApiError } from '../api.js'
import { addDays } from '../dates.js'
import { useAbsicht } from '../absicht.js'

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
    staleTime: 30_000,
    refetchInterval: belegNachfragen<InvoiceList>(d => d.invoices)
  })

/**
 * Nachfragen, solange ein Beleg noch entsteht.
 *
 * Das PDF zeichnet der Worker nach dem Festschreiben; ohne Nachfrage stand
 * die neue Rechnung bis zum Neuladen ohne Beleg da (Pruefung 13.10.2026).
 * Nach dreissig Runden ist Schluss: ein Beleg, der so lange nicht kommt,
 * haengt, und dafuer gibt es die Meldung im Nachtlauf, nicht eine Seite,
 * die endlos fragt.
 */
export function belegNachfragen<T>(
  rechnungen: (d: T) => ReadonlyArray<{ documentReady: boolean }>
): (q: { state: { data: T | undefined; dataUpdateCount: number } }) => number | false {
  return q => {
    const d = q.state.data
    if (d === undefined || q.state.dataUpdateCount > 30) return false
    return rechnungen(d).some(i => !i.documentReady) ? 5_000 : false
  }
}

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
        : { type: 'urn:staygrid:unknown', title: res.statusText, status: res.status },
      res.status)
  }
  return await res.blob()
}

/** Wartet der Beleg noch auf den Worker? */
export function istBelegInArbeit(fehler: unknown): boolean {
  return fehler instanceof ApiError
    && fehler.problem.type === 'urn:staygrid:document_pending'
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

// ------------------------------------------------- Vorauszahlung (B8, B9)

/**
 * Anzahlungen und Zahlungslinks eines Folios.
 *
 * `stand` ist kein Filter, sondern der Grund zum Neuholen: die Verrechnung
 * einer Anzahlung entsteht nicht hier, sondern beim Festschreiben der
 * Schlussrechnung -- einer Mutation aus `lib/queries.ts`, die diesen
 * Schluessel nicht kennt und nicht kennen soll. Faellt der Zaehler der
 * fakturierten Positionen anders aus, ist dieselbe Frage neu zu stellen.
 * Die Zahl der moeglichen Werte ist klein und waechst nur mit den
 * Positionen des Folios.
 */
export const usePrepayments = (folioRef: string, stand: number) =>
  useQuery<PrepaymentView>({
    queryKey: ['prepayments', folioRef, stand],
    queryFn: () => api.get(`/v1/folios/${folioRef}/prepayments`)
  })

export interface DepositLine { grossCent: number; taxRateBp: number }

/**
 * Anzahlungsrechnung aus einem Zahlungseingang.
 *
 * Der Idempotenzschluessel kommt von aussen: er gehoert zur Absicht und
 * nicht zum Versuch. Wer nach einer Zeitueberschreitung noch einmal
 * drueckt, soll keine zweite Rechnungsnummer verbrauchen -- fortlaufend
 * heisst fortlaufend (§ 14 Abs. 4 Nr. 4 UStG).
 */
export function useIssueDepositInvoice(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ settlementId, taxRateBp, lines, key }: {
      settlementId: number; taxRateBp?: number; lines?: DepositLine[]; key: string
    }) =>
      api.post<{ invoiceRef: string; number: string
                 netCent: number; taxCent: number; grossCent: number }>(
        `/v1/folios/${folioRef}/deposit-invoice`,
        { settlementId,
          ...(taxRateBp === undefined ? {} : { taxRateBp }),
          ...(lines === undefined ? {} : { lines }) },
        { 'idempotency-key': key }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepayments', folioRef] })
      // Die Rechnung taucht auch in der Rechnungsliste auf.
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    }
  })
}

/** Ist kein Zahlungsdienstleister eingerichtet? Dann fehlt eine Einstellung, kein Recht. */
export function istNichtEingerichtet(fehler: unknown): boolean {
  return fehler instanceof ApiError
    && fehler.problem.type === 'urn:staygrid:not_configured'
}

/**
 * Einen Zahlungslink erzeugen -- auf Wunsch zu einer Anzahlungsanforderung
 * und in derselben Anfrage per Gastpost an den Gast.
 *
 * Senden geht **nur** hier: die Adresse des Links wird nicht gespeichert,
 * und eine spätere Route "diesen Link schicken" müsste sie sich vom
 * Aufrufer geben lassen. Dann bestimmte der Aufrufer den Inhalt der
 * Gastpost, nicht nur den Empfänger.
 */
export function useCreatePaymentLink(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ amountCent, depositRequestRef, sendEmail, key }: {
      amountCent: number; depositRequestRef?: string; sendEmail?: boolean; key: string
    }) =>
      api.post<PaymentLinkCreated>(`/v1/folios/${folioRef}/payment-links`,
        { amountCent,
          ...(depositRequestRef === undefined ? {} : { depositRequestRef }),
          ...(sendEmail === true ? { sendEmail: true } : {}) },
        { 'idempotency-key': key }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepayments', folioRef] })
    }
  })
}

/**
 * Einen offenen Link beim Zahlungsdienstleister ungültig machen. Erst dort,
 * dann bei uns -- ein Link, den nur unsere Datenbank für ungültig hält,
 * kann der Gast weiterhin bezahlen.
 */
export function useCancelPaymentLink(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (linkId: number) =>
      api.post<{ linkId: number; status: string }>(`/v1/payment-links/${linkId}/cancel`),
    // Auch nach einem Fehler neu fragen: lehnt der Anbieter ab, ist meist
    // gerade bezahlt worden, und der Stand hat sich geändert.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['prepayments', folioRef] })
    }
  })
}

/**
 * Anzahlung anfordern. Der Betrag, den die API festschreibt, ist der
 * maßgebliche -- auch bei Prozent, wo die Maske ihn vorher nur anzeigt.
 */
export function useCreateDepositRequest(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ amountCent, percentBp, dueDate, key }: {
      amountCent?: number; percentBp?: number; dueDate: string; key: string
    }) =>
      api.post<{ requestRef: string; amountCent: number }>(
        `/v1/folios/${folioRef}/deposit-requests`,
        { dueDate,
          ...(amountCent === undefined ? {} : { amountCent }),
          ...(percentBp === undefined ? {} : { percentBp }) },
        { 'idempotency-key': key }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepayments', folioRef] })
    }
  })
}

export function useCancelDepositRequest(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (requestRef: string) =>
      api.post<{ requestRef: string }>(`/v1/deposit-requests/${requestRef}/cancel`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepayments', folioRef] })
    }
  })
}

/** Eine Überweisung oder Barzahlung, die schon vermerkt ist, einer Anforderung zuordnen. */
export function useAssignDepositSettlement(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ requestRef, settlementId }: { requestRef: string; settlementId: number }) =>
      api.post<{ requestRef: string; settlementId: number }>(
        `/v1/deposit-requests/${requestRef}/settlements`, { settlementId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prepayments', folioRef] })
    }
  })
}

// ------------------------------------------- Rechnungsempfaenger (S6)

/**
 * Wer die Rechnung bekommt.
 *
 * Wirkt auf die **naechste** Rechnung. Eine festgeschriebene traegt ihren
 * Empfaenger als Momentaufnahme und aendert sich nie wieder -- deshalb
 * macht die Maske den Unterschied sichtbar, statt so zu tun, als liesse
 * sich ein gedruckter Beleg nachtraeglich umadressieren.
 */
export function useSetRecipient(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { guestRef?: string | null; companyRef?: string | null }) =>
      api.patch<{ recipient: InvoiceRecipient }>(
        `/v1/folios/${folioRef}/recipient`, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['folio', folioRef] }) }
  })
}

/** Was der Rechnungsdialog schickt; dieselbe Form fuer Vorschau und Festschreiben. */
export interface RechnungsAuftrag {
  kind?: 'final' | 'interim'
  chargeIds?: number[]
  recipient?: Partial<Record<'name' | 'addressLine1' | 'postalCode' | 'city' | 'country'
                             | 'vatId', string>>
  dueOn?: string
  paid?: { paymentMethodCode: string }
}

export interface Empfaengerdaten {
  name?: string | null; addressLine1?: string | null; postalCode?: string | null
  city?: string | null; country?: string | null; vatId?: string | null
}

export interface Rechnungsvorschau {
  lines: Array<{ chargeId: number; description: string; quantity: number
                 businessDate: string; grossCent: number; taxRateBp: number }>
  depositsApplied: Array<{ depositInvoiceNumber: string; amountGrossCent: number }>
  totals: { netCent: number; taxCent: number; grossCent: number; roundingCent: number
            payableCent: number; prepaidCent: number
            groups: Array<{ rateBp: number; netCent: number; taxCent: number
                            grossCent: number }> }
  serviceFrom: string; serviceTo: string
  recipient: Empfaengerdaten
  defaultRecipient: Empfaengerdaten
  recipientEmail: string | null
  dueOn: string | null
  openCent: number
  nextNumber: string
  prefixMissing: boolean
  findings: Array<{ key: string; reference: string; de: string; en: string }>
}

/**
 * Vorschau des Rechnungsdialogs. Eine Anfrage je Stand der Eingabe, nicht je
 * Tastendruck: der Dialog schickt sie erst, wenn ein Feld verlassen wird.
 */
export const useInvoicePreview = (folioRef: string, auftrag: RechnungsAuftrag,
                                  aktiv: boolean) =>
  useQuery<Rechnungsvorschau>({
    queryKey: ['invoicePreview', folioRef, auftrag],
    queryFn: () => api.post(`/v1/folios/${folioRef}/invoice-preview`, auftrag),
    enabled: aktiv,
    retry: false,
    placeholderData: prev => prev
  })

/**
 * Festschreiben aus dem Dialog. Der Idempotenzschluessel haengt an der
 * Absicht: ein zweiter Klick, waehrend der erste laeuft, darf keine zweite
 * Nummer verbrauchen.
 */
export function useIssueInvoiceWith(folioRef: string, propertyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ auftrag, key }: { auftrag: RechnungsAuftrag; key: string }) =>
      api.post<{ invoiceRef: string; number: string; dueOn: string | null }>(
        `/v1/folios/${folioRef}/invoice`, auftrag, { 'idempotency-key': key }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['folio', folioRef] })
      void qc.invalidateQueries({ queryKey: ['invoicePreview', folioRef] })
      void qc.invalidateQueries({ queryKey: ['invoices', propertyId] })
    }
  })
}

/** Korrektur im Dialog: Gegenbuchung, danach die richtige Position neu. */
export function useCorrectCharge(folioRef: string) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: async (k: { chargeId: number; description: string; grossCent: number
                            taxRateBp: number }) => {
      await api.post(`/v1/folios/${folioRef}/charges/${k.chargeId}/reverse`, {},
        { 'idempotency-key': absicht.schluessel('storno') })
      if (k.grossCent !== 0) {
        await api.post(`/v1/folios/${folioRef}/charges`,
          { description: k.description, grossCent: k.grossCent, taxRateBp: k.taxRateBp },
          { 'idempotency-key': absicht.schluessel('neu') })
      }
    },
    onSuccess: () => { absicht.erledigt() },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['folio', folioRef] })
      void qc.invalidateQueries({ queryKey: ['invoicePreview', folioRef] })
    }
  })
}

/** Rueckzahlung einer Anzahlung, mit Rechnungskorrektur (0162). */
export function useRefundDeposit(folioRef: string) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: (r: { invoiceRef: string; amountCent: number; paymentMethodCode: string }) =>
      api.post<{ invoiceRef: string; number: string }>(
        `/v1/invoices/${r.invoiceRef}/refund`,
        { amountCent: r.amountCent, paymentMethodCode: r.paymentMethodCode },
        { 'idempotency-key': absicht.schluessel(r.invoiceRef) }),
    onSuccess: () => {
      absicht.erledigt()
      void qc.invalidateQueries({ queryKey: ['prepayments', folioRef] })
      void qc.invalidateQueries({ queryKey: ['folio', folioRef] })
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    }
  })
}

/** Split: ein weiteres Folio zum selben Aufenthalt. */
export function useSplitFolio(folioRef: string) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: (label: string) =>
      api.post<{ folioRef: string }>(`/v1/folios/${folioRef}/split`, { label },
        { 'idempotency-key': absicht.schluessel() }),
    onSuccess: () => {
      absicht.erledigt()
      void qc.invalidateQueries({ queryKey: ['folio'] })
    }
  })
}

/** Offene Position auf ein anderes Folio desselben Aufenthalts. */
export function useTransferCharge(folioRef: string) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: (u: { chargeId: number; targetFolioRef: string }) =>
      api.post(`/v1/folios/${folioRef}/charges/${u.chargeId}/transfer`,
        { targetFolioRef: u.targetFolioRef },
        { 'idempotency-key': absicht.schluessel(`${u.chargeId}-${u.targetFolioRef}`) }),
    onSuccess: () => {
      absicht.erledigt()
      // Beide Folios und die Salden in der Uebersicht des Aufenthalts.
      void qc.invalidateQueries({ queryKey: ['folio'] })
      void qc.invalidateQueries({ queryKey: ['invoicePreview', folioRef] })
    }
  })
}

/** Uebernachtungen kuenftig auf dieses Folio (oder zurueck aufs Gastfolio). */
export function useAccommodationRouting(folioRef: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (accommodation: boolean) =>
      api.put(`/v1/folios/${folioRef}/routing`, { accommodation }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['folio'] }) }
  })
}

/** Position oder Nachlass, brutto eingegeben wie auf dem Papier. */
export function useAddGrossCharge(folioRef: string) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: (b: { description: string; grossCent: number; taxRateBp: number }) =>
      api.post<{ chargeId: number }>(`/v1/folios/${folioRef}/charges`, b,
        { 'idempotency-key': absicht.schluessel() }),
    onSuccess: () => {
      absicht.erledigt()
      void qc.invalidateQueries({ queryKey: ['folio', folioRef] })
      void qc.invalidateQueries({ queryKey: ['invoicePreview', folioRef] })
    }
  })
}

/** "Zahlung eingegangen" in der Rechnungsliste: fuer genau diese Rechnung. */
export function useRecordInvoicePayment(propertyId: number) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: (b: { folioRef: string; invoiceRef: string; amountCent: number
                      paymentMethodCode: string }) =>
      api.post(`/v1/folios/${b.folioRef}/settlements`,
        { amountCent: b.amountCent, paymentMethodCode: b.paymentMethodCode,
          invoiceRef: b.invoiceRef },
        { 'idempotency-key': absicht.schluessel() }),
    onSuccess: (_d, b) => {
      absicht.erledigt()
      void qc.invalidateQueries({ queryKey: ['invoices', propertyId] })
      void qc.invalidateQueries({ queryKey: ['folio', b.folioRef] })
    }
  })
}

/**
 * Rechnung stornieren (Pruefung 13.10.2026, Befund 2). Danach stehen die
 * Positionen wieder offen am Folio; die Liste und das Folio laden neu.
 */
export function useCancelInvoice(propertyId: number) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: (b: { invoiceRef: string; folioRef: string }) =>
      api.post<{ invoiceRef: string; number: string }>(
        `/v1/invoices/${b.invoiceRef}/cancel`, {},
        { 'idempotency-key': absicht.schluessel() }),
    onSuccess: (_d, b) => {
      absicht.erledigt()
      void qc.invalidateQueries({ queryKey: ['invoices', propertyId] })
      void qc.invalidateQueries({ queryKey: ['folio', b.folioRef] })
    }
  })
}

/** Offene Posten: unbezahlte Schluss- und Zwischenrechnungen, ohne Zeitraum. */
export interface OffenerPosten {
  invoiceRef: string; number: string; kind: string; issuedOn: string; dueOn: string
  recipient: string; folioRef: string; grossCent: number; openCent: number
  daysOverdue: number; reminderLevel: number | null; remindedOn: string | null
  reminderDueOn: string | null
}
export interface OffenePosten {
  today: string; truncated: boolean; totalOpenCent: number; totalOverdueCent: number
  items: OffenerPosten[]
}

export const useOpenItems = (propertyId: number, aktiv: boolean) =>
  useQuery<OffenePosten>({
    queryKey: ['openItems', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/open-items`),
    enabled: aktiv,
    staleTime: 15_000
  })

/** Erinnern oder mahnen: die naechste Stufe, auf Wunsch gleich per Mail. */
export function useRemind(propertyId: number) {
  const qc = useQueryClient()
  const absicht = useAbsicht()
  return useMutation({
    mutationFn: (r: { invoiceRef: string; dueOn: string; send: boolean; to?: string }) =>
      api.post<{ level: number; messageRef: string | null }>(
        `/v1/invoices/${r.invoiceRef}/reminders`,
        { dueOn: r.dueOn, send: r.send, ...(r.to ? { to: r.to } : {}) },
        { 'idempotency-key': absicht.schluessel(r.invoiceRef) }),
    onSuccess: () => {
      absicht.erledigt()
      void qc.invalidateQueries({ queryKey: ['openItems', propertyId] })
      void qc.invalidateQueries({ queryKey: ['outbox', propertyId] })
    }
  })
}
