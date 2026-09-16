import type { LocalizedText } from '@hotelpms/contracts'

/** Gastkonto und Rechnung. */
export const folio = {
  'folio.title': {
    de: 'Folio',
    en: 'Folio',
    tr: 'Folio' },
  'folio.closed': {
    de: 'Geschlossen',
    en: 'Closed',
    tr: 'Kapalı' },
  'folio.charges': {
    de: 'Positionen',
    en: 'Charges',
    tr: 'Kalemler' },
  'folio.settlements': {
    de: 'Zahlungsvermerke',
    en: 'Payment notes',
    tr: 'Ödeme kayıtları' },
  'folio.newCharge': {
    de: 'Position buchen',
    en: 'Post a charge',
    tr: 'Kalem kaydet' },
  'folio.newSettlement': {
    de: 'Zahlung vermerken',
    en: 'Note a payment',
    tr: 'Ödeme kaydet' },
  'folio.description': {
    de: 'Bezeichnung',
    en: 'Description',
    tr: 'Tanım' },
  'folio.netAmount': {
    de: 'Netto in Euro',
    en: 'Net amount in euro',
    tr: 'Euro cinsinden net' },
  'folio.taxRate': {
    de: 'Steuersatz',
    en: 'Tax rate',
    tr: 'Vergi oranı' },
  'folio.post': {
    de: 'Buchen',
    en: 'Post',
    tr: 'Kaydet' },
  'folio.amount': {
    de: 'Betrag in Euro',
    en: 'Amount in euro',
    tr: 'Euro cinsinden tutar' },
  'folio.method': {
    de: 'Zahlungsart',
    en: 'Payment method',
    tr: 'Ödeme türü' },
  'folio.reference': {
    de: 'Beleg beim Abrechnungsort',
    en: 'Reference at the place of settlement',
    tr: 'Tahsilat yerindeki belge' },
  'folio.note': {
    de: 'Vermerken',
    en: 'Note',
    tr: 'Kaydet' },
  'folio.fullBalance': {
    de: 'Offener Saldo',
    en: 'Open balance',
    tr: 'Açık bakiye' },
  'folio.reversal': {
    de: 'Gegenbuchung',
    en: 'Reversal',
    tr: 'Ters kayıt' },
  'folio.invoiced': {
    de: 'Auf einer Rechnung, damit unveränderlich',
    en: 'On an invoice, therefore immutable',
    tr: 'Bir faturada yer alıyor, bu nedenle değiştirilemez' },
  'folio.issueInvoice': {
    de: 'Rechnung festschreiben',
    en: 'Issue invoice',
    tr: 'Faturayı kesinleştir' },
  'folio.issueHint': {
    de: 'Prüft die Pflichtangaben nach § 14 UStG.',
    en: 'Checks the mandatory details under § 14 UStG.',
    tr: '§ 14 UStG uyarınca zorunlu bilgileri denetler.' },
  'folio.invoiceNumber': {
    de: 'Rechnungsnummer',
    en: 'Invoice number',
    tr: 'Fatura numarası' },
} as const satisfies Record<string, LocalizedText>
