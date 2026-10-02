import { describe, it, expect } from 'vitest'
import { EMAIL_LANGUAGES } from '../email.js'
import { renderPayPage, payPageTexts, type PayPageKind } from '../payPage.js'
import { paymentLinkValidUntil, paymentLinkValid } from '../depositRequest.js'

/**
 * Die Seite hinter dem Zahlungslink und seine Frist (Migration 0059).
 */

const ARTEN: PayPageKind[] = ['open', 'paid', 'processing', 'revoked', 'expired',
  'training', 'unavailable', 'unknown', 'returned', 'abandoned']

const offen = {
  propertyName: 'Hotel <Nordsee>', arrival: '2026-10-20', departure: '2026-10-23',
  amountCent: 13_410, currency: 'EUR', dueDate: '2026-10-06', deposit: true,
  validUntil: '2026-10-13', checkoutHref: '/v1/pay/checkout?t=abc'
}

describe('Die Zahlungsseite', () => {
  it('hat in jeder Sprache jeden Satz, ohne liegengebliebenen Platzhalter', () => {
    const deutsch = payPageTexts('de')
    for (const lang of EMAIL_LANGUAGES) {
      const t = payPageTexts(lang)
      expect(Object.keys(t).sort(), lang).toEqual(Object.keys(deutsch).sort())
      for (const [k, v] of Object.entries(t)) {
        expect(v.trim().length, `${lang}.${k}`).toBeGreaterThan(0)
        if (lang !== 'de') expect(v, `${lang}.${k} ist deutsch`).not.toBe(deutsch[k])
      }
      for (const art of ARTEN) {
        expect(renderPayPage(art, offen, lang), `${lang}/${art}`).not.toMatch(/\{\w+\}/)
      }
    }
  })

  it('kommt ohne <style>, Skript und Formular aus', () => {
    // Die Inhaltsrichtlinie verbietet eingebettete Stylesheets, und
    // form-action 'self' verbietet einem Formular die Weiterleitung zum
    // Anbieter. Der Knopf ist deshalb ein Link.
    for (const art of ARTEN) {
      const html = renderPayPage(art, offen, 'de')
      expect(html).not.toMatch(/<style|<script|<form/i)
      expect(html).toContain('noindex')
    }
    expect(renderPayPage('open', offen, 'de')).toContain('href="/v1/pay/checkout?t=abc"')
  })

  it('nennt Haus, Zeitraum, Betrag, Frist und Gueltigkeit, entschaerft', () => {
    const html = renderPayPage('open', offen, 'de')
    expect(html).toContain('Hotel &lt;Nordsee&gt;')
    expect(html).toContain('134,10 EUR')
    expect(html).toContain('20.10.2026')
    expect(html).toContain('06.10.2026')
    expect(html).toContain('13.10.2026')
    expect(renderPayPage('open', offen, 'en')).toContain('2026-10-13')
  })

  it('verraet bei einem unbekannten Link nichts ueber ein Haus', () => {
    expect(renderPayPage('unknown', {}, 'de')).not.toContain('<h1')
  })
})

describe('Frist des Links', () => {
  it('gilt eine Woche ueber die Faelligkeit hinaus', () => {
    expect(paymentLinkValidUntil({ businessDate: '2026-10-01', dueDate: '2026-10-10',
                                   departure: '2026-10-23' })).toBe('2026-10-17')
  })

  it('endet spaetestens mit der Abreise', () => {
    expect(paymentLinkValidUntil({ businessDate: '2026-10-01', dueDate: '2026-10-10',
                                   departure: '2026-10-12' })).toBe('2026-10-12')
  })

  it('zaehlt bei schon verstrichener Frist ab dem Geschaeftstag', () => {
    // Ein neuer Link fuer eine ueberfaellige Anforderung soll nicht tot
    // ankommen.
    expect(paymentLinkValidUntil({ businessDate: '2026-10-15', dueDate: '2026-10-05',
                                   departure: '2026-10-30' })).toBe('2026-10-22')
    // Und nie vor dem Geschaeftstag, auch wenn die Abreise vorbei ist.
    expect(paymentLinkValidUntil({ businessDate: '2026-10-15', dueDate: '2026-10-05',
                                   departure: '2026-10-10' })).toBe('2026-10-15')
  })

  it('gilt ohne Anforderung zwei Wochen, ueber Monats- und Jahresgrenzen', () => {
    expect(paymentLinkValidUntil({ businessDate: '2026-12-25', dueDate: null,
                                   departure: null })).toBe('2027-01-08')
    // Ueber die Zeitumstellung am 29.03.2026, ohne einen Tag zu verlieren.
    expect(paymentLinkValidUntil({ businessDate: '2026-03-20', dueDate: null,
                                   departure: null })).toBe('2026-04-03')
  })

  it('nimmt am letzten Tag noch an, am Tag danach nicht', () => {
    expect(paymentLinkValid('2026-10-17', '2026-10-17')).toBe(true)
    expect(paymentLinkValid('2026-10-17', '2026-10-18')).toBe(false)
  })
})
