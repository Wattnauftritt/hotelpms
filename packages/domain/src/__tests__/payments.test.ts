import { describe, it, expect } from 'vitest'
import { paymentSucceeded, type PaymentWebhookEvent } from '../payments.js'

const succeeded: PaymentWebhookEvent = {
  eventId: 'evt_1', kind: 'succeeded', providerReference: 'cs_1', amountCent: 20_000
}

describe('paymentSucceeded', () => {
  it('zaehlt eine Erfolgsmeldung mit passendem Betrag', () => {
    expect(paymentSucceeded(20_000, succeeded)).toBe(true)
  })

  it('verwirft eine Erfolgsmeldung mit abweichendem Betrag', () => {
    expect(paymentSucceeded(20_000, { ...succeeded, amountCent: 19_999 })).toBe(false)
  })

  it('verwirft ein Ereignis, das keinen Erfolg meldet', () => {
    const fehlgeschlagen: PaymentWebhookEvent = {
      eventId: 'evt_2', kind: 'failed', providerReference: 'cs_1'
    }
    expect(paymentSucceeded(20_000, fehlgeschlagen)).toBe(false)
  })

  it('verwirft ein Ereignis ohne gemeldeten Betrag', () => {
    const ohneBetrag: PaymentWebhookEvent = {
      eventId: 'evt_3', kind: 'succeeded', providerReference: 'cs_1'
    }
    expect(paymentSucceeded(20_000, ohneBetrag)).toBe(false)
  })
})
