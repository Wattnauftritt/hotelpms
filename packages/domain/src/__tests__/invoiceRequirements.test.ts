import { describe, it, expect } from 'vitest'
import { checkInvoiceRequirements, blockingFindings, isSmallAmountInvoice,
         KLEINBETRAG_GRENZE, type InvoiceForCheck } from '../invoiceRequirements.js'

/**
 * Ein Test je Pflichtangabe, wie es der Plan für AP 7 verlangt.
 *
 * Der Punkt jedes einzelnen: eine fehlende Angabe kostet dem *Empfänger*
 * den Vorsteuerabzug, und das merkt niemand beim Ausstellen.
 */

const vollstaendig: InvoiceForCheck = {
  number: '2026-00042',
  issuedOn: '2026-10-04',
  serviceFrom: '2026-10-01',
  serviceTo: '2026-10-04',
  issuer: {
    name: 'Seehotel Wattenblick', addressLine1: 'Hafenstr. 1',
    postalCode: '25813', city: 'Husum', country: 'DE', taxNumber: '21/815/00123'
  },
  recipient: {
    name: 'Petersen, Jan', addressLine1: 'Deichweg 4',
    postalCode: '24937', city: 'Flensburg', country: 'DE'
  },
  lines: [{ description: 'Uebernachtung 01.10.2026', quantity: 1,
            netCent: 10_280, rateBp: 700 }],
  grossCent: 33_000,
  kind: 'final'
}

const ohne = (feld: Partial<InvoiceForCheck>): InvoiceForCheck => ({ ...vollstaendig, ...feld })
const schluessel = (inv: InvoiceForCheck): string[] =>
  blockingFindings(inv).map(f => f.key)

describe('Pflichtangaben nach § 14 UStG', () => {
  it('beanstandet eine vollstaendige Rechnung nicht', () => {
    expect(blockingFindings(vollstaendig)).toEqual([])
  })

  it('verlangt Name und Anschrift des Ausstellers', () => {
    expect(schluessel(ohne({ issuer: { ...vollstaendig.issuer, name: '' } })))
      .toContain('issuer_name')
    expect(schluessel(ohne({ issuer: { ...vollstaendig.issuer, city: null } })))
      .toContain('issuer_address')
    // Eine Strasse allein ohne Ort ist keine Anschrift.
    expect(schluessel(ohne({ issuer: { ...vollstaendig.issuer, postalCode: '  ' } })))
      .toContain('issuer_address')
  })

  it('verlangt Steuernummer oder USt-IdNr, aber nicht beide', () => {
    const nurUstId = ohne({ issuer: { ...vollstaendig.issuer,
      taxNumber: null, vatId: 'DE123456789' } })
    expect(schluessel(nurUstId)).not.toContain('issuer_tax_id')

    const keines = ohne({ issuer: { ...vollstaendig.issuer, taxNumber: null, vatId: null } })
    expect(schluessel(keines)).toContain('issuer_tax_id')
  })

  it('verlangt Name und Anschrift des Empfaengers', () => {
    expect(schluessel(ohne({ recipient: { ...vollstaendig.recipient, name: null } })))
      .toContain('recipient_name')
    expect(schluessel(ohne({ recipient: { ...vollstaendig.recipient, city: '' } })))
      .toContain('recipient_address')
  })

  it('verlangt Ausstellungsdatum und fortlaufende Nummer', () => {
    expect(schluessel(ohne({ issuedOn: null }))).toContain('issued_on')
    expect(schluessel(ohne({ number: '' }))).toContain('number')
  })

  it('verlangt Menge und Art je Position', () => {
    expect(schluessel(ohne({ lines: [{ description: null, quantity: 1,
      netCent: 100, rateBp: 700 }] }))).toContain('line_description')
    expect(schluessel(ohne({ lines: [{ description: 'Logis', quantity: 0,
      netCent: 100, rateBp: 700 }] }))).toContain('line_quantity')
    expect(schluessel(ohne({ lines: [] }))).toContain('line_description')
  })

  /**
   * Der Leistungszeitraum ist bei Beherbergung der Aufenthalt, nicht das
   * Rechnungsdatum. Diese Verwechslung ist der häufigste Mangel an
   * Hotelrechnungen.
   */
  it('verlangt den Leistungszeitraum und prueft seine Richtung', () => {
    expect(schluessel(ohne({ serviceFrom: null }))).toContain('service_period')
    expect(schluessel(ohne({ serviceTo: null }))).toContain('service_period')
    expect(schluessel(ohne({ serviceFrom: '2026-10-04', serviceTo: '2026-10-01' })))
      .toContain('service_period')
  })

  it('verlangt bei Steuersatz null einen Grund', () => {
    const nullsatz = ohne({
      lines: [{ description: 'Leistung', quantity: 1, netCent: 10_000, rateBp: 0 }]
    })
    expect(schluessel(nullsatz)).toContain('exemption_reason')

    // Mit Begruendung ist es in Ordnung.
    expect(schluessel({ ...nullsatz, exemptionReason: 'Steuerfreie Ausfuhrlieferung' }))
      .not.toContain('exemption_reason')

    // Beim Reverse-Charge traegt der Empfaenger die Steuer, der Nullsatz ist
    // dann richtig und braucht keinen Befreiungsgrund.
    expect(schluessel({ ...nullsatz, reverseCharge: true }))
      .not.toContain('exemption_reason')
  })

  it('fordert den Reverse-Charge-Hinweis an, ohne zu blockieren', () => {
    const alle = checkInvoiceRequirements({ ...vollstaendig, reverseCharge: true })
    const hinweis = alle.find(x => x.key === 'reverse_charge_note')
    expect(hinweis).toBeDefined()
    // Die Darstellung setzt ihn, die Pruefung kann ihn nicht erzwingen.
    expect(hinweis!.blocking).toBe(false)
    expect(hinweis!.de).toContain('Steuerschuldnerschaft')
  })

  it('nennt zu jedem Befund die Fundstelle im Gesetz', () => {
    for (const f of checkInvoiceRequirements(
      ohne({ number: null, issuedOn: null, serviceFrom: null }))) {
      expect(f.reference).toMatch(/§ 14/)
    }
  })

  it('meldet alle Maengel auf einmal, nicht nur den ersten', () => {
    const kaputt = ohne({
      number: null, issuedOn: null, serviceFrom: null,
      recipient: {}, issuer: { name: 'Hotel' }
    })
    const keys = schluessel(kaputt)
    expect(keys.length).toBeGreaterThanOrEqual(6)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gibt jeden Befund auf Deutsch und Englisch aus', () => {
    for (const f of checkInvoiceRequirements(ohne({ number: null, serviceFrom: null }))) {
      expect(f.de.length).toBeGreaterThan(10)
      expect(f.en.length).toBeGreaterThan(10)
      expect(f.de).not.toBe(f.en)
    }
  })
})

describe('Kleinbetragsrechnung nach § 33 UStDV', () => {
  const klein: InvoiceForCheck = {
    ...vollstaendig, grossCent: 24_999, number: null, recipient: {}
  }

  it('greift bis einschliesslich 250 Euro brutto', () => {
    expect(isSmallAmountInvoice(KLEINBETRAG_GRENZE, 'final')).toBe(true)
    expect(isSmallAmountInvoice(KLEINBETRAG_GRENZE + 1, 'final')).toBe(false)
  })

  it('verzichtet auf Empfaenger, Nummer und Steuernummer', () => {
    const keys = schluessel(klein)
    expect(keys).not.toContain('recipient_name')
    expect(keys).not.toContain('recipient_address')
    expect(keys).not.toContain('number')

    const ohneSteuernummer = { ...klein,
      issuer: { ...vollstaendig.issuer, taxNumber: null, vatId: null } }
    expect(schluessel(ohneSteuernummer)).not.toContain('issuer_tax_id')
  })

  it('verlangt trotzdem Aussteller, Datum, Position und Leistungszeitraum', () => {
    expect(schluessel({ ...klein, issuer: {} })).toContain('issuer_name')
    expect(schluessel({ ...klein, issuedOn: null })).toContain('issued_on')
    expect(schluessel({ ...klein, lines: [] })).toContain('line_description')
    expect(schluessel({ ...klein, serviceFrom: null })).toContain('service_period')
  })

  it('gilt fuer eine Gutschrift nicht, egal wie klein', () => {
    expect(isSmallAmountInvoice(100, 'credit_note')).toBe(false)
    const gutschrift = { ...klein, kind: 'credit_note' as const }
    expect(schluessel(gutschrift)).toContain('number')
    expect(schluessel(gutschrift)).toContain('recipient_name')
  })
})
