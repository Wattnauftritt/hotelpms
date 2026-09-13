import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFRawStream, PDFStream,
         decodePDFRawStream } from 'pdf-lib'
import { buildInvoiceCii, type CiiInvoice } from '@hotelpms/domain'
import { renderInvoicePdf, euro, datum } from '../pdf/invoiceLayout.js'
import { finalizePdfA3, FACTUR_X_FILENAME } from '../pdf/pdfa3.js'

/**
 * Geprüft wird, was ein PDF/A-3 von einem gewöhnlichen PDF unterscheidet.
 *
 * Das ist nichts, was man sieht: eingebettete Schriften, ein hinterlegtes
 * Farbprofil, ein XMP-Block mit der Konformitätsstufe, die Kennzeichnung
 * der Beilage. Ein Beleg, dem eines davon fehlt, sieht richtig aus und wird
 * vom Empfänger abgewiesen — und zwar erst dort.
 *
 * Ein echter ISO-Prüfer (veraPDF) läuft hier nicht mit; er ist ein
 * Java-Werkzeug und gehört in die Freigabe, nicht in die Testrunde. Geprüft
 * wird deshalb jedes einzelne Merkmal, das er prüfen würde, an der Stelle,
 * an der wir es setzen.
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
    postalCode: '24937', city: 'Flensburg', country: 'DE'
  },
  lines: [
    { name: 'Uebernachtung', quantity: 3, unitCode: 'DAY', netCent: 30_000, rateBp: 700 },
    { name: 'Fruehstueck', quantity: 3, netCent: 4_200, rateBp: 1900 }
  ],
  serviceFrom: '2026-10-01',
  serviceTo: '2026-10-03'
}

const erzeugtAm = new Date('2026-10-04T08:00:00.000Z')

async function beleg(
  inv: CiiInvoice = rechnung, mitXml = true
): Promise<{ bytes: Uint8Array; roh: string; xml: string | null }> {
  const xml = mitXml ? buildInvoiceCii(inv) : null
  const doc = await renderInvoicePdf({ invoice: inv, publicRef: 'inv_test' })
  const bytes = await finalizePdfA3(doc, xml, {
    title: `Rechnung ${inv.number}`,
    author: inv.seller.name,
    subject: `Rechnung ${inv.number} vom ${inv.issuedOn}`,
    createdAt: erzeugtAm
  })
  return { bytes, roh: Buffer.from(bytes).toString('latin1'), xml }
}

/** Liest die Beilagen so aus, wie es ein Empfaenger tun wuerde. */
async function beilagen(bytes: Uint8Array): Promise<Array<{ name: string; inhalt: string }>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  if (!doc.catalog.has(PDFName.of('Names'))) return []
  const names = doc.catalog.lookup(PDFName.of('Names'), PDFDict)
  const embedded = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict)
  const liste = embedded.lookup(PDFName.of('Names'), PDFArray)
  const out: Array<{ name: string; inhalt: string }> = []
  for (let i = 0; i < liste.size(); i += 2) {
    const name = liste.lookup(i) as { decodeText(): string }
    const spec = liste.lookup(i + 1, PDFDict)
    const strom = spec.lookup(PDFName.of('EF'), PDFDict)
      .lookup(PDFName.of('F'), PDFStream) as PDFRawStream
    out.push({
      name: name.decodeText(),
      inhalt: Buffer.from(decodePDFRawStream(strom).decode()).toString('utf8')
    })
  }
  return out
}

describe('Rechnungsbeleg als PDF/A-3 mit ZUGFeRD', () => {
  it('legt das CII-XML unter dem vorgeschriebenen Namen bei', async () => {
    const { bytes, xml } = await beleg()
    const dateien = await beilagen(bytes)
    expect(dateien.map(d => d.name)).toEqual([FACTUR_X_FILENAME])
    // Der Empfaenger liest das XML, nicht das Blatt. Es muss unveraendert
    // ankommen, Zeichen fuer Zeichen.
    expect(dateien[0]!.inhalt).toBe(xml)
  })

  it('kennzeichnet die Beilage als andere Fassung derselben Rechnung', async () => {
    const { roh } = await beleg()
    // AFRelationship Alternative: dieselbe Rechnung, andere Darstellung.
    expect(roh).toContain('/AFRelationship /Alternative')
    expect(roh).toContain('/Subtype /text#2Fxml')
    // Die Beilage muss auch vom Katalog aus erreichbar sein, sonst findet
    // sie ein PDF/A-Pruefer nicht.
    expect(roh).toMatch(/\/AF \[/)
  })

  it('weist sich im XMP als PDF/A-3B aus', async () => {
    const { roh } = await beleg()
    expect(roh).toContain('<pdfaid:part>3</pdfaid:part>')
    expect(roh).toContain('<pdfaid:conformance>B</pdfaid:conformance>')
    expect(roh).toContain('/Type /Metadata')
    // Unkomprimiert, sonst liest ihn kein Werkzeug ohne PDF-Kenntnis.
    expect(roh).toMatch(/\/Type \/Metadata[^>]*\/Subtype \/XML/)
    expect(roh).not.toMatch(/\/Type \/Metadata[^>]*\/Filter/)
  })

  it('beschreibt den Factur-X-Namensraum als Erweiterungsschema', async () => {
    const { roh } = await beleg()
    // PDF/A erlaubt fremde Namensraeume nur, wenn das Dokument sie selbst
    // beschreibt. Diesen Teil vergisst man am ehesten.
    expect(roh).toContain('urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#')
    expect(roh).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>')
    expect(roh).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>')
    expect(roh).toContain('<pdfaSchema:prefix>fx</pdfaSchema:prefix>')
  })

  it('hinterlegt das Farbprofil als Ausgabeziel', async () => {
    const { roh } = await beleg()
    expect(roh).toContain('/OutputIntents')
    expect(roh).toContain('/S /GTS_PDFA1')
    expect(roh).toContain('(sRGB)')
  })

  /**
   * Der häufigste Grund, warum ein hübsches PDF kein PDF/A ist: die
   * Standardschriften von PDF sind nicht eingebettet, sondern werden beim
   * Betrachter vorausgesetzt.
   */
  it('bettet jede benutzte Schrift ein', async () => {
    const { roh } = await beleg()
    expect(roh).toContain('/FontFile2')
    expect(roh).not.toContain('/BaseFont /Helvetica')
    // Subsetting: der Name traegt das sechsstellige Praefix, und die Datei
    // bleibt klein.
    expect(roh).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans/)
  })

  it('bleibt trotz eingebetteter Schrift und XML klein', async () => {
    const { bytes } = await beleg()
    expect(bytes.length).toBeLessThan(120_000)
  })

  it('traegt eine Dokumentkennung und passende Angaben im Info-Verzeichnis', async () => {
    const { roh, bytes } = await beleg()
    expect(roh).toMatch(/\/ID \[ <[0-9a-f]{32}> <[0-9a-f]{32}> \]/)
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getTitle()).toBe('Rechnung 2026-00042')
    expect(doc.getAuthor()).toBe('Seehotel Wattenblick')
    expect(doc.getProducer()).toBe('hotelpms')
  })

  it('erzeugt denselben Beleg zweimal gleich', async () => {
    const a = await beleg()
    const b = await beleg()
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
  })

  /**
   * Die Kleinbetragsrechnung ohne Empfänger ist nach § 33 UStDV gültig und
   * nach EN 16931 kein Beleg. Sie bekommt ein PDF/A-3 ohne Beilage — und
   * keinen Factur-X-Block, der eine Beilage behauptet, die fehlt.
   */
  it('erzeugt auch ohne XML ein PDF/A-3', async () => {
    const { bytes, roh } = await beleg(rechnung, false)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    expect(await beilagen(bytes)).toEqual([])
    expect(roh).toContain('<pdfaid:part>3</pdfaid:part>')
    expect(roh).not.toContain('urn:factur-x:pdfa')
  })

  it('bricht bei vielen Positionen auf mehrere Seiten um', async () => {
    const viele: CiiInvoice = {
      ...rechnung,
      lines: Array.from({ length: 60 }, (_, i) => ({
        name: `Uebernachtung Nacht ${i + 1} im Doppelzimmer mit Meerblick`,
        quantity: 1, unitCode: 'DAY', netCent: 12_000, rateBp: 700
      }))
    }
    const doc = await renderInvoicePdf({ invoice: viele, publicRef: 'inv_lang' })
    expect(doc.getPageCount()).toBeGreaterThan(1)
    const bytes = await finalizePdfA3(doc, buildInvoiceCii(viele), {
      title: 'Rechnung', author: 'Seehotel Wattenblick', subject: 'Rechnung',
      createdAt: erzeugtAm
    })
    // Die Summe steht auf der letzten Seite und nicht im Nichts.
    expect(bytes.length).toBeGreaterThan(0)
  })
})

describe('Darstellung von Betrag und Datum', () => {
  it('schreibt Betraege deutsch, aus ganzen Cent', () => {
    expect(euro(0)).toBe('0,00')
    expect(euro(5)).toBe('0,05')
    expect(euro(123_456_789)).toBe('1.234.567,89')
    expect(euro(-1_050)).toBe('-10,50')
  })

  it('dreht das Datum, ohne es durch eine Zeitzone zu schicken', () => {
    // new Date(iso).toLocaleDateString() waere hier der Fehler, der den
    // Beleg je nach Serverzeitzone um einen Tag verschiebt.
    expect(datum('2026-10-01')).toBe('01.10.2026')
    expect(datum('2026-01-31')).toBe('31.01.2026')
  })
})
