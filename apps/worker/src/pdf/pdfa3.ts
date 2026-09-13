import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { AFRelationship, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString }
  from 'pdf-lib'

/**
 * Macht aus einem gewoehnlichen PDF ein PDF/A-3 mit eingebettetem CII-XML,
 * also einen ZUGFeRD-Beleg.
 *
 * **Warum das ein zweiter Schritt ist.** Kein Zeichenwerkzeug erzeugt von
 * sich aus PDF/A. Der Unterschied liegt nicht im Bild, sondern in dem, was
 * das Dokument ueber sich selbst aussagt: eingebettete Schriften, ein
 * hinterlegtes Farbprofil, ein XMP-Block mit der Konformitaetsstufe und
 * eine Kennzeichnung der beigelegten Datei. Fehlt eines davon, sieht der
 * Beleg gleich aus und ist trotzdem keiner.
 *
 * Die Reihenfolge der Eingriffe ist der MIT-lizenzierten Umsetzung in
 * node-zugferd (https://github.com/jslno/node-zugferd) nachgebildet;
 * uebernommen ist der Ablauf, nicht der Code.
 */

/**
 * Dateiname der Beilage. In ZUGFeRD 2.1 und Factur-X festgelegt und **nicht**
 * frei waehlbar: der Empfaenger sucht genau diesen Namen. Aeltere Fassungen
 * hiessen ZUGFeRD-invoice.xml, wer den Namen behaelt, wird nicht gefunden.
 */
export const FACTUR_X_FILENAME = 'factur-x.xml'

/** Profilkennung im XMP. Muss zur Profilkennung im XML passen (BT-24). */
export const FACTUR_X_CONFORMANCE = 'EN 16931'

const ASSETS = new URL('../../assets/', import.meta.url)

/**
 * Schriften und Farbprofil einmal je Prozess lesen. Der Worker erzeugt
 * Belege im Stapel; die Datei bei jeder Rechnung erneut von der Platte zu
 * holen waere die teuerste Zeile im ganzen Ablauf.
 */
let beigaben: Promise<{ regular: Uint8Array; bold: Uint8Array; icc: Uint8Array }> | null = null

export function loadAssets(): Promise<{ regular: Uint8Array; bold: Uint8Array; icc: Uint8Array }> {
  beigaben ??= (async () => {
    const [regular, bold, icc] = await Promise.all([
      readFile(new URL('LiberationSans-Regular.ttf', ASSETS)),
      readFile(new URL('LiberationSans-Bold.ttf', ASSETS)),
      readFile(new URL('sRGB2014.icc', ASSETS))
    ])
    return {
      regular: new Uint8Array(regular),
      bold: new Uint8Array(bold),
      icc: new Uint8Array(icc)
    }
  })()
  return beigaben
}

export interface PdfAMetadata {
  title: string
  author: string
  subject: string
  /** Zeitpunkt der Erzeugung. Ausdruecklich uebergeben, damit ein Test
   *  denselben Beleg zweimal byteweise gleich erzeugen kann. */
  createdAt: Date
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;'
      : c === '"' ? '&quot;' : '&apos;')
}

/** XMP verlangt ISO 8601 ohne Millisekunden. */
function xmpDate(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}

const PRODUCER = 'hotelpms'

/**
 * XMP-Block.
 *
 * Drei Dinge muessen hier stehen, und alle drei werden geprueft: die Stufe
 * (pdfaid), die Beschreibung des Factur-X-Namensraums als Erweiterungs-
 * schema, und die Angaben zur Beilage selbst. Das Erweiterungsschema ist
 * der Teil, den man am ehesten weglaesst: PDF/A erlaubt fremde
 * Namensraeume nur, wenn das Dokument sie selbst beschreibt.
 */
function xmpPacket(meta: PdfAMetadata, hatXml: boolean): string {
  const erstellt = xmpDate(meta.createdAt)
  const facturX = hatXml
    ? `
   <rdf:Description rdf:about=""
     xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
     xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
     xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
    <pdfaExtension:schemas>
     <rdf:Bag>
      <rdf:li rdf:parseType="Resource">
       <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
       <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
       <pdfaSchema:prefix>fx</pdfaSchema:prefix>
       <pdfaSchema:property>
        <rdf:Seq>
         <rdf:li rdf:parseType="Resource">
          <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
          <pdfaProperty:valueType>Text</pdfaProperty:valueType>
          <pdfaProperty:category>external</pdfaProperty:category>
          <pdfaProperty:description>Name of the embedded XML document</pdfaProperty:description>
         </rdf:li>
         <rdf:li rdf:parseType="Resource">
          <pdfaProperty:name>DocumentType</pdfaProperty:name>
          <pdfaProperty:valueType>Text</pdfaProperty:valueType>
          <pdfaProperty:category>external</pdfaProperty:category>
          <pdfaProperty:description>INVOICE</pdfaProperty:description>
         </rdf:li>
         <rdf:li rdf:parseType="Resource">
          <pdfaProperty:name>Version</pdfaProperty:name>
          <pdfaProperty:valueType>Text</pdfaProperty:valueType>
          <pdfaProperty:category>external</pdfaProperty:category>
          <pdfaProperty:description>Version of the standard</pdfaProperty:description>
         </rdf:li>
         <rdf:li rdf:parseType="Resource">
          <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
          <pdfaProperty:valueType>Text</pdfaProperty:valueType>
          <pdfaProperty:category>external</pdfaProperty:category>
          <pdfaProperty:description>Conformance level of the embedded XML</pdfaProperty:description>
         </rdf:li>
        </rdf:Seq>
       </pdfaSchema:property>
      </rdf:li>
     </rdf:Bag>
    </pdfaExtension:schemas>
   </rdf:Description>
   <rdf:Description rdf:about=""
     xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
    <fx:DocumentType>INVOICE</fx:DocumentType>
    <fx:DocumentFileName>${FACTUR_X_FILENAME}</fx:DocumentFileName>
    <fx:Version>1.0</fx:Version>
    <fx:ConformanceLevel>${FACTUR_X_CONFORMANCE}</fx:ConformanceLevel>
   </rdf:Description>`
    : ''

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(meta.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(meta.subject)}</rdf:li></rdf:Alt></dc:description>
   <dc:creator><rdf:Seq><rdf:li>${escapeXml(meta.author)}</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>${PRODUCER}</xmp:CreatorTool>
   <xmp:CreateDate>${erstellt}</xmp:CreateDate>
   <xmp:ModifyDate>${erstellt}</xmp:ModifyDate>
   <xmp:MetadataDate>${erstellt}</xmp:MetadataDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${PRODUCER}</pdf:Producer>
   <pdf:PDFVersion>1.7</pdf:PDFVersion>
  </rdf:Description>${facturX}
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

/**
 * Haengt das CII-XML an, setzt die Kennzeichen von PDF/A-3 und gibt die
 * fertigen Bytes zurueck.
 *
 * `xml === null` ist ein zulaessiger Fall: der Beleg wird dann als PDF/A-3
 * ohne Beilage erzeugt. Eine Kleinbetragsrechnung ohne Empfaenger ist nach
 * § 33 UStDV gueltig und nach EN 16931 kein Beleg; sie bekommt ein PDF und
 * kein XML.
 */
export async function finalizePdfA3(
  pdfDoc: PDFDocument, xml: string | null, meta: PdfAMetadata
): Promise<Uint8Array> {
  if (xml !== null) {
    await pdfDoc.attach(new TextEncoder().encode(xml), FACTUR_X_FILENAME, {
      // text/xml, nicht application/xml: so steht es in der Spezifikation,
      // und der Empfaenger sucht danach.
      mimeType: 'text/xml',
      description: 'Factur-X/ZUGFeRD Rechnung',
      creationDate: meta.createdAt,
      modificationDate: meta.createdAt,
      // Alternative heisst: dieselbe Rechnung in anderer Darstellung. Data
      // waere eine Beilage, Source ein Vorprodukt; beides ist es nicht.
      afRelationship: AFRelationship.Alternative
    })
  }

  // Die Angaben im Info-Verzeichnis muessen zum XMP passen, sonst
  // widerspricht sich das Dokument.
  pdfDoc.setTitle(meta.title)
  pdfDoc.setAuthor(meta.author)
  pdfDoc.setSubject(meta.subject)
  pdfDoc.setProducer(PRODUCER)
  pdfDoc.setCreator(PRODUCER)
  pdfDoc.setCreationDate(meta.createdAt)
  pdfDoc.setModificationDate(meta.createdAt)

  // Schriften und Beilage schreibt pdf-lib erst beim Speichern in das
  // Dokument. Wer sie vorher anfassen will, muss dieses Schreiben
  // vorziehen; sonst benennt der naechste Schritt nichts um, weil es die
  // Schriftverzeichnisse noch gar nicht gibt.
  await pdfDoc.flush()
  tagSubsetFonts(pdfDoc)
  addOutputIntent(pdfDoc, (await loadAssets()).icc)
  addMetadata(pdfDoc, xmpPacket(meta, xml !== null))
  markAsTagged(pdfDoc)
  addDocumentId(pdfDoc, meta)

  // Ohne Objektstroeme. Sie sind in PDF/A-3 erlaubt, machen den Beleg aber
  // fuer jedes einfache Werkzeug unlesbar, das ihn im Streitfall oeffnen
  // soll.
  return pdfDoc.save({ useObjectStreams: false })
}

/**
 * Benennt die eingebetteten Teilschriften nach der Regel der Norm um.
 *
 * Eine Schrift, von der nur die benutzten Zeichen im Dokument liegen, muss
 * einen Namen der Form `ABCDEF+Familie` tragen. Das ist keine Formsache:
 * am Praefix erkennt ein Betrachter, dass er die Schrift **nicht** fuer
 * anderen Text verwenden darf, weil ihr die uebrigen Zeichen fehlen. Ohne
 * das Praefix beanstandet ein PDF/A-Pruefer die Datei.
 *
 * pdf-lib haengt beim Subsetting stattdessen eine laufende Nummer an
 * (`LiberationSans-1733`). Umbenannt werden muessen alle drei Stellen, die
 * denselben Namen tragen: das Type-0-Verzeichnis, der Nachfahre und der
 * Schriftdeskriptor -- sonst zeigen sie auf verschiedene Schriften.
 */
function tagSubsetFonts(pdfDoc: PDFDocument): void {
  const neueNamen = new Map<string, string>()

  const umbenannt = (alt: string): string => {
    const vorhanden = neueNamen.get(alt)
    if (vorhanden !== undefined) return vorhanden
    // Aus dem Namen abgeleitet und nicht gewuerfelt: derselbe Beleg soll
    // sich zweimal byteweise gleich erzeugen lassen.
    const hash = createHash('sha256').update(alt).digest()
    const praefix = Array.from(hash.subarray(0, 6))
      .map(b => String.fromCharCode(65 + (b % 26))).join('')
    const familie = alt.replace(/-\d+$/, '')
    const neu = `${praefix}+${familie}`
    neueNamen.set(alt, neu)
    return neu
  }

  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue
    for (const schluessel of ['BaseFont', 'FontName'] as const) {
      const wert = obj.get(PDFName.of(schluessel))
      if (!(wert instanceof PDFName)) continue
      const alt = wert.decodeText()
      if (alt.includes('+')) continue
      obj.set(PDFName.of(schluessel), PDFName.of(umbenannt(alt)))
    }
  }
}

function addOutputIntent(pdfDoc: PDFDocument, icc: Uint8Array): void {
  // N gibt die Zahl der Farbkanaele an. Ohne diesen Eintrag weist jeder
  // Pruefer das Profil zurueck.
  const profil = pdfDoc.context.stream(icc, { N: 3, Length: icc.length })
  const profilRef = pdfDoc.context.register(profil)
  const intent = pdfDoc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: profilRef
  })
  pdfDoc.catalog.set(PDFName.of('OutputIntents'),
    pdfDoc.context.obj([pdfDoc.context.register(intent)]))
}

function addMetadata(pdfDoc: PDFDocument, xmp: string): void {
  // Als UTF-8-Bytes, nicht als Zeichenkette: das vorangestellte BOM ist ein
  // Zeichen und drei Byte. Wer die Laenge in Zeichen zaehlt, schreibt einen
  // zu kurzen Strom, und der XMP-Block ist fuer den Pruefer unlesbar.
  const bytes = new TextEncoder().encode(xmp)
  // Ungefiltert: PDF/A verlangt den XMP-Block unkomprimiert, damit ihn ein
  // Werkzeug ohne PDF-Kenntnis lesen kann.
  const strom = pdfDoc.context.stream(bytes, { Type: 'Metadata', Subtype: 'XML' })
  pdfDoc.catalog.set(PDFName.of('Metadata'), pdfDoc.context.register(strom))
}

function markAsTagged(pdfDoc: PDFDocument): void {
  pdfDoc.catalog.set(PDFName.of('MarkInfo'), pdfDoc.context.obj({ Marked: true }))
  const strukturbaum = pdfDoc.context.obj({ Type: PDFName.of('StructTreeRoot') })
  pdfDoc.catalog.set(PDFName.of('StructTreeRoot'),
    pdfDoc.context.register(strukturbaum))
}

/**
 * Dauerhafte Dokumentkennung. PDF/A verlangt sie, und sie muss aus dem
 * Inhalt kommen und nicht aus dem Zufall: derselbe Beleg soll dieselbe
 * Kennung tragen, sonst sieht ein Abgleich zwei Dokumente, wo eines ist.
 */
function addDocumentId(pdfDoc: PDFDocument, meta: PdfAMetadata): void {
  const kennung = createHash('sha256')
    .update(`${meta.title}\n${meta.author}\n${meta.createdAt.toISOString()}`)
    .digest('hex')
  const id = PDFHexString.of(kennung.slice(0, 32))
  pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([id, id])
}
