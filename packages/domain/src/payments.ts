/**
 * Normalisierte Sicht auf eine Benachrichtigung eines Zahlungsanbieters,
 * unabhaengig davon, wie der Anbieter sein Ereignis nennt und formt. Das
 * Uebersetzen der anbieterspezifischen Form (Stripe, spaeter Adyen, Mollie)
 * in diese Form ist Sache des Adapters in apps/api; hier steht nur die
 * Fachregel, wann ein Ereignis eine Zahlung als eingelost gelten laesst.
 */
export interface PaymentWebhookEvent {
  eventId: string
  kind: 'succeeded' | 'failed' | 'ignored'
  providerReference: string
  amountCent?: number
}

/**
 * Eine Erfolgsmeldung zaehlt nur, wenn der gemeldete Betrag exakt zur
 * angeforderten Zahlung passt. Ohne diese Pruefung koennte eine manipulierte
 * oder verwechselte Benachrichtigung einen Zahlungsvermerk ueber einen
 * falschen Betrag ausloesen; die Signaturpruefung allein sichert nur die
 * Herkunft der Nachricht, nicht ihren Inhalt gegen die eigene Erwartung.
 */
export function paymentSucceeded(intentAmountCent: number, event: PaymentWebhookEvent): boolean {
  return event.kind === 'succeeded' && event.amountCent === intentAmountCent
}
