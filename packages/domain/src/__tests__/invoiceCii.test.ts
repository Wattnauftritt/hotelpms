import { describe, it, expect } from 'vitest'
import { buildInvoiceCii, ciiFindings, amount, type CiiInvoice }
  from '../invoiceCii.js'

/**
 * Geprüft wird das erzeugte XML feldweise gegen eine erwartete Fassung.
 *
 * Ein Vergleich der ganzen Datei wäre wertlos: er schlägt bei jeder
 * Einrückung fehl und sagt nie, welches Feld falsch ist. Geprüft wird
 * deshalb je Geschäftsfeld über seinen Pfad, und zusätzlich einmal die
 * vollständige erwartete Fassung eines kleinen Belegs, damit auch die
 * **Reihenfolge** der Elemente festliegt: sie ist in CII eine XSD-Sequenz
 * und kein Geschmack.
 */

const rechnung: CiiInvoice = {
  number: '2026-00042',
  issuedOn: '2026-10-04',
  kind: 'final',
  currency: 'EUR',
  seller: {
    name: 'Seehotel Wattenblick', addressLine1: 'Hafenstr. 1',
    postalCode: '25813', city: 'Husum', country: 'DE',
    taxNumber: '21/815/00123', vatId: 'DE123456789'
  },
  buyer: {
    name: 'Nordwind GmbH', addressLine1: 'Deichweg 4',
    postalCode: '24937', city: 'Flensburg', country: 'DE',
    vatId: 'DE987654321'
  },
  lines: [
    { name: 'Uebernachtung', quantity: 3, unitCode: 'DAY', netCent: 30_000, rateBp: 700 },
    { name: 'Fruehstueck', quantity: 3, netCent: 4_200, rateBp: 1900 }
  ],
  serviceFrom: '2026-10-01',
  serviceTo: '2026-10-03'
}

/**
 * Liest den Textinhalt eines Elements über seinen Pfad, ohne XML-Parser.
 * Für die Tiefe dieses Dokuments genügt der Weg über die Elementnamen; ein
 * Parser als Testabhängigkeit brächte hier nichts, was er nicht auch
 * verbergen könnte.
 */
function feld(xml: string, ...pfad: string[]): string | null {
  let rest = xml
  for (const name of pfad) {
    // Der Name muss vollstaendig passen: rsm:ExchangedDocument darf nicht
    // rsm:ExchangedDocumentContext treffen.
    const auf = rest.search(new RegExp(`<${name}(?=[\\s/>])`))
    if (auf < 0) return null
    const zu = rest.indexOf(`</${name}>`, auf)
    if (zu < 0) return null
    rest = rest.slice(rest.indexOf('>', auf) + 1, zu)
  }
  return rest.trim()
}

function alle(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'g'))]
    .map(m => m[1]!)
}

describe('CII-XML nach EN 16931', () => {
  const xml = buildInvoiceCii(rechnung)

  it('nennt Profil, Nummer, Art und Datum des Belegs', () => {
    expect(feld(xml, 'rsm:ExchangedDocumentContext',
      'ram:GuidelineSpecifiedDocumentContextParameter', 'ram:ID'))
      .toBe('urn:cen.eu:en16931:2017')                                 // BT-24
    expect(feld(xml, 'rsm:ExchangedDocument', 'ram:ID')).toBe('2026-00042')  // BT-1
    expect(feld(xml, 'rsm:ExchangedDocument', 'ram:TypeCode')).toBe('380')   // BT-3
    expect(feld(xml, 'rsm:ExchangedDocument', 'ram:IssueDateTime',
      'udt:DateTimeString')).toBe('20261004')                          // BT-2
    expect(xml).toContain('<udt:DateTimeString format="102">20261004</udt:DateTimeString>')
  })

  it('nennt Aussteller mit Anschrift, USt-IdNr und Steuernummer', () => {
    const seller = feld(xml, 'ram:SellerTradeParty')!
    expect(feld(seller, 'ram:Name')).toBe('Seehotel Wattenblick')      // BT-27
    expect(feld(seller, 'ram:PostcodeCode')).toBe('25813')             // BT-38
    expect(feld(seller, 'ram:LineOne')).toBe('Hafenstr. 1')            // BT-35
    expect(feld(seller, 'ram:CityName')).toBe('Husum')                 // BT-37
    expect(feld(seller, 'ram:CountryID')).toBe('DE')                   // BT-40
    // Zwei Registrierungen, unterschieden durch das Schema: VA ist die
    // USt-IdNr (BT-31), FC die Steuernummer (BT-32).
    expect(seller).toContain('<ram:ID schemeID="VA">DE123456789</ram:ID>')
    expect(seller).toContain('<ram:ID schemeID="FC">21/815/00123</ram:ID>')
  })

  it('nennt den Empfaenger mit Anschrift und USt-IdNr', () => {
    const buyer = feld(xml, 'ram:BuyerTradeParty')!
    expect(feld(buyer, 'ram:Name')).toBe('Nordwind GmbH')              // BT-44
    expect(feld(buyer, 'ram:PostcodeCode')).toBe('24937')              // BT-53
    expect(feld(buyer, 'ram:CityName')).toBe('Flensburg')              // BT-52
    expect(feld(buyer, 'ram:CountryID')).toBe('DE')                    // BT-55
    expect(buyer).toContain('<ram:ID schemeID="VA">DE987654321</ram:ID>')  // BT-48
    // Die Steuernummer des Hauses gehoert nicht zum Empfaenger.
    expect(buyer).not.toContain('schemeID="FC"')
  })

  it('gibt je Position Nummer, Bezeichnung, Menge, Einzelpreis und Betrag', () => {
    expect(alle(xml, 'ram:LineID')).toEqual(['1', '2'])                // BT-126
    expect(alle(xml, 'ram:Name')).toContain('Uebernachtung')           // BT-153
    expect(xml).toContain('<ram:BilledQuantity unitCode="DAY">3</ram:BilledQuantity>')
    expect(xml).toContain('<ram:BilledQuantity unitCode="C62">3</ram:BilledQuantity>')
    // BT-146 mal BT-129 ergibt BT-131: 100,0000 mal 3 sind 300,00.
    expect(alle(xml, 'ram:ChargeAmount')).toEqual(['100.0000', '14.0000'])
    expect(alle(xml, 'ram:LineTotalAmount')).toEqual(['300.00', '42.00', '342.00'])
  })

  /**
   * Der Kern der deutschen Hotelrechnung: 7 Prozent auf die Übernachtung,
   * 19 auf das Frühstück, und die Steuer je Satzgruppe aus der Nettosumme.
   */
  it('weist die Steuer je Satzgruppe aus', () => {
    const gruppen = xml.split('<ram:ApplicableTradeTax>').slice(3)     // BG-23
    expect(gruppen).toHaveLength(2)
    expect(gruppen[0]).toContain('<ram:CalculatedAmount>21.00</ram:CalculatedAmount>')
    expect(gruppen[0]).toContain('<ram:BasisAmount>300.00</ram:BasisAmount>')
    expect(gruppen[0]).toContain('<ram:CategoryCode>S</ram:CategoryCode>')
    expect(gruppen[0]).toContain('<ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>')
    expect(gruppen[1]).toContain('<ram:CalculatedAmount>7.98</ram:CalculatedAmount>')
    expect(gruppen[1]).toContain('<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>')
  })

  /**
   * § 14 Abs. 4 Nr. 6 UStG in der Sprache der Norm: BT-73 und BT-74 sind
   * der Aufenthalt, nicht das Rechnungsdatum. Die Verwechslung ist der
   * häufigste Mangel an Hotelrechnungen.
   */
  it('traegt den Leistungszeitraum als Abrechnungszeitraum', () => {
    const zeitraum = feld(xml, 'ram:BillingSpecifiedPeriod')!
    expect(feld(zeitraum, 'ram:StartDateTime', 'udt:DateTimeString')).toBe('20261001')
    expect(feld(zeitraum, 'ram:EndDateTime', 'udt:DateTimeString')).toBe('20261003')
    // BT-72: erbracht ist die Leistung mit der letzten abgerechneten Nacht.
    expect(feld(xml, 'ram:ActualDeliverySupplyChainEvent', 'ram:OccurrenceDateTime',
      'udt:DateTimeString')).toBe('20261003')
  })

  it('laesst die Summenregeln aufgehen', () => {
    const s = feld(xml, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation')!
    expect(feld(s, 'ram:LineTotalAmount')).toBe('342.00')              // BT-106
    expect(feld(s, 'ram:TaxBasisTotalAmount')).toBe('342.00')          // BT-109
    expect(feld(s, 'ram:TaxTotalAmount')).toBe('28.98')                // BT-110
    expect(feld(s, 'ram:GrandTotalAmount')).toBe('370.98')             // BT-112
    expect(feld(s, 'ram:TotalPrepaidAmount')).toBe('0.00')             // BT-113
    expect(feld(s, 'ram:DuePayableAmount')).toBe('370.98')             // BT-115
    expect(s).toContain('<ram:TaxTotalAmount currencyID="EUR">')
  })

  it('zieht eine Anzahlung vom offenen Betrag ab', () => {
    const s = feld(buildInvoiceCii({ ...rechnung, prepaidCent: 20_000 }),
      'ram:SpecifiedTradeSettlementHeaderMonetarySummation')!
    expect(feld(s, 'ram:GrandTotalAmount')).toBe('370.98')
    expect(feld(s, 'ram:TotalPrepaidAmount')).toBe('200.00')
    expect(feld(s, 'ram:DuePayableAmount')).toBe('170.98')             // BR-CO-16
  })

  it('unterscheidet Rechnung, Anzahlung und Storno', () => {
    const art = (kind: CiiInvoice['kind']): string | null =>
      feld(buildInvoiceCii({ ...rechnung, kind }), 'rsm:ExchangedDocument', 'ram:TypeCode')
    expect(art('final')).toBe('380')
    expect(art('interim')).toBe('380')
    expect(art('deposit')).toBe('386')
    expect(art('credit_note')).toBe('381')
  })

  /**
   * Eine Korrektur ist eine Gegenbuchung, und die Norm verbietet in BR-27
   * einen negativen Einzelpreis. Der negative Betrag muss deshalb über die
   * Menge kommen, sonst ist das Dokument ungültig — und zwar erst beim
   * Empfänger, nicht beim Ausstellen.
   */
  it('drueckt eine Gegenbuchung ueber eine negative Menge aus', () => {
    const xmlStorno = buildInvoiceCii({
      ...rechnung,
      lines: [{ name: 'Storno Uebernachtung', quantity: 1, netCent: -10_000, rateBp: 700 }]
    })
    expect(xmlStorno).toContain('<ram:BilledQuantity unitCode="C62">-1</ram:BilledQuantity>')
    expect(xmlStorno).toContain('<ram:ChargeAmount>100.0000</ram:ChargeAmount>')
    expect(xmlStorno).toContain('<ram:LineTotalAmount>-100.00</ram:LineTotalAmount>')
    expect(feld(xmlStorno, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
      'ram:GrandTotalAmount')).toBe('-107.00')
  })

  /**
   * § 13b UStG. Der Hinweis muss im Beleg stehen, und die Kategorie muss
   * AE sein: eine Null ohne Kategorie liest der Empfänger als vergessene
   * Steuer.
   */
  it('kennzeichnet die Steuerschuldnerschaft des Leistungsempfaengers', () => {
    const xmlAe = buildInvoiceCii({
      ...rechnung, reverseCharge: true,
      lines: [{ name: 'Uebernachtung', quantity: 1, netCent: 30_000, rateBp: 0 }]
    })
    expect(feld(xmlAe, 'ram:IncludedNote', 'ram:Content'))
      .toBe('Steuerschuldnerschaft des Leistungsempfaengers')          // BT-22
    expect(xmlAe).toContain('<ram:CategoryCode>AE</ram:CategoryCode>') // BT-118
    expect(xmlAe).toContain('<ram:ExemptionReason>Steuerschuldnerschaft '
      + 'des Leistungsempfaengers</ram:ExemptionReason>')              // BT-120
    expect(feld(xmlAe, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
      'ram:TaxTotalAmount')).toBe('0.00')
  })

  it('nennt bei steuerfreier Leistung den Grund', () => {
    const xmlFrei = buildInvoiceCii({
      ...rechnung, exemptionReason: 'Steuerfrei nach § 4 Nr. 12 UStG',
      lines: [{ name: 'Langzeitmiete', quantity: 1, netCent: 30_000, rateBp: 0 }]
    })
    expect(xmlFrei).toContain('<ram:CategoryCode>E</ram:CategoryCode>')
    expect(xmlFrei).toContain('<ram:ExemptionReason>Steuerfrei nach '
      + '§ 4 Nr. 12 UStG</ram:ExemptionReason>')
  })

  it('maskiert Sonderzeichen im Namen', () => {
    const xmlAmp = buildInvoiceCii({
      ...rechnung, buyer: { ...rechnung.buyer, name: 'Meyer & Söhne <KG>' }
    })
    expect(xmlAmp).toContain('<ram:Name>Meyer &amp; Söhne &lt;KG&gt;</ram:Name>')
  })

  /**
   * Die vollständige erwartete Fassung eines kleinen Belegs. Sie legt die
   * Reihenfolge der Elemente fest, die kein Einzelfeldtest sieht.
   */
  it('entspricht der erwarteten Fassung', () => {
    const klein = buildInvoiceCii({
      ...rechnung,
      seller: { name: 'Seehotel Wattenblick', addressLine1: 'Hafenstr. 1',
                postalCode: '25813', city: 'Husum', country: 'DE',
                vatId: 'DE123456789' },
      buyer: { name: 'Nordwind GmbH', addressLine1: 'Deichweg 4',
               postalCode: '24937', city: 'Flensburg', country: 'DE' },
      lines: [{ name: 'Uebernachtung', quantity: 1, unitCode: 'DAY',
                netCent: 10_000, rateBp: 700 }],
      serviceFrom: '2026-10-01', serviceTo: '2026-10-01'
    })
    expect(klein).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>2026-00042</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">20261004</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>1</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>Uebernachtung</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>100.0000</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="DAY">1</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>100.00</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Seehotel Wattenblick</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>25813</ram:PostcodeCode>
          <ram:LineOne>Hafenstr. 1</ram:LineOne>
          <ram:CityName>Husum</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">DE123456789</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Nordwind GmbH</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>24937</ram:PostcodeCode>
          <ram:LineOne>Deichweg 4</ram:LineOne>
          <ram:CityName>Flensburg</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">20261001</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>7.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>100.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:BillingSpecifiedPeriod>
        <ram:StartDateTime>
          <udt:DateTimeString format="102">20261001</udt:DateTimeString>
        </ram:StartDateTime>
        <ram:EndDateTime>
          <udt:DateTimeString format="102">20261001</udt:DateTimeString>
        </ram:EndDateTime>
      </ram:BillingSpecifiedPeriod>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>100.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">7.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>107.00</ram:GrandTotalAmount>
        <ram:TotalPrepaidAmount>0.00</ram:TotalPrepaidAmount>
        <ram:DuePayableAmount>107.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`)
  })
})

describe('Betragsformat', () => {
  it('rechnet Cent in Dezimalbetraege um, ohne Fliesskomma', () => {
    expect(amount(0)).toBe('0.00')
    expect(amount(5)).toBe('0.05')
    expect(amount(100)).toBe('1.00')
    expect(amount(-12_345)).toBe('-123.45')
    // Ein Betrag, an dem eine Fliesskommarechnung sichtbar scheitern wuerde.
    expect(amount(1_000_000_007)).toBe('10000000.07')
  })
})

describe('Geschaeftsregeln von EN 16931', () => {
  it('beanstandet eine vollstaendige Rechnung nicht', () => {
    expect(ciiFindings(rechnung)).toEqual([])
  })

  /**
   * Der Unterschied zu § 14 UStG, der im Betrieb zuschlägt: die
   * Steuernummer genügt der Norm nicht. Ein Haus, das nur eine hinterlegt
   * hat, stellt gültige Papierrechnungen aus und bekommt kein XML.
   */
  it('verlangt die USt-IdNr des Hauses, nicht nur die Steuernummer', () => {
    const nurSteuernummer = ciiFindings({
      ...rechnung, seller: { ...rechnung.seller, vatId: null }
    })
    expect(nurSteuernummer.map(f => f.key)).toEqual(['seller_identifier'])
    expect(nurSteuernummer[0]!.rule).toBe('BR-CO-26')
  })

  /**
   * Die Norm kennt keine Kleinbetragsrechnung. Der Bon der Laufkundschaft
   * ist nach § 33 UStDV ohne Empfänger gültig und nach BR-07 kein
   * EN-16931-Beleg.
   */
  it('verlangt den Empfaenger, den § 33 UStDV erlaesst', () => {
    const ohneEmpfaenger = ciiFindings({
      ...rechnung, buyer: { name: '', postalCode: null, city: null, country: null }
    })
    expect(ohneEmpfaenger.map(f => f.key)).toEqual(['buyer_name', 'buyer_address'])
  })

  it('verlangt den Laendercode, nicht nur Ort und Postleitzahl', () => {
    const ohneLand = ciiFindings({
      ...rechnung, buyer: { ...rechnung.buyer, country: null }
    })
    expect(ohneLand.map(f => f.key)).toEqual(['buyer_address'])
  })

  it('erfindet kein Land, wenn keines bekannt ist', () => {
    const xmlOhneLand = buildInvoiceCii({
      ...rechnung, buyer: { ...rechnung.buyer, country: null }
    })
    expect(feld(xmlOhneLand, 'ram:BuyerTradeParty')).not.toContain('CountryID')
  })
})
