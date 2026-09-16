import type { LocalizedText } from '@hotelpms/contracts'

/** Gastkonto und Rechnung. */
export const folio = {
  'folio.title': {
    de: 'Folio',
    en: 'Folio' },
  'folio.closed': {
    de: 'Geschlossen',
    en: 'Closed' },
  'folio.charges': {
    de: 'Positionen',
    en: 'Charges' },
  'folio.settlements': {
    de: 'Zahlungsvermerke',
    en: 'Payment notes' },
  'folio.newCharge': {
    de: 'Position buchen',
    en: 'Post a charge' },
  'folio.newSettlement': {
    de: 'Zahlung vermerken',
    en: 'Note a payment' },
  'folio.description': {
    de: 'Bezeichnung',
    en: 'Description' },
  'folio.netAmount': {
    de: 'Netto in Euro',
    en: 'Net amount in euro' },
  'folio.taxRate': {
    de: 'Steuersatz',
    en: 'Tax rate' },
  'folio.post': {
    de: 'Buchen',
    en: 'Post' },
  'folio.amount': {
    de: 'Betrag in Euro',
    en: 'Amount in euro' },
  'folio.method': {
    de: 'Zahlungsart',
    en: 'Payment method' },
  'folio.reference': {
    de: 'Beleg beim Abrechnungsort',
    en: 'Reference at the place of settlement' },
  'folio.note': {
    de: 'Vermerken',
    en: 'Note' },
  'folio.fullBalance': {
    de: 'Offener Saldo',
    en: 'Open balance' },
  'folio.reversal': {
    de: 'Gegenbuchung',
    en: 'Reversal' },
  'folio.invoiced': {
    de: 'Auf einer Rechnung, damit unveränderlich',
    en: 'On an invoice, therefore immutable' },
  'folio.issueInvoice': {
    de: 'Rechnung festschreiben',
    en: 'Issue invoice' },
  'folio.issueHint': {
    de: 'Prüft die Pflichtangaben nach § 14 UStG.',
    en: 'Checks the mandatory details under § 14 UStG.' },
  'folio.invoiceNumber': {
    de: 'Rechnungsnummer',
    en: 'Invoice number' },
} as const satisfies Record<string, LocalizedText>
