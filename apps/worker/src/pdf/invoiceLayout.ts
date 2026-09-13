import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { ciiTotals, type CiiInvoice, type CiiLine } from '@hotelpms/domain'
import { loadAssets } from './pdfa3.js'

/**
 * Das sichtbare Blatt der Rechnung.
 *
 * **Warum es dieselben Daten zeichnet wie das XML.** Ein hybrider Beleg
 * traegt beides, und beides muss dasselbe sagen. Weicht das Blatt vom XML
 * ab, ist nicht nur eine Angabe falsch, sondern der Beleg widerspruechlich:
 * die Buchhaltung des Empfaengers liest das XML, der Mensch liest das
 * Blatt, und die Differenz faellt Monate spaeter bei der Pruefung auf.
 * Deshalb bekommt diese Funktion genau die Struktur, aus der auch das XML
 * entsteht, und rechnet nichts eigenes.
 */

const A4 = { width: 595.28, height: 841.89 }
const RAND = 56          // 2 cm
const RECHTS = A4.width - RAND
const UNTEN = 70         // Platz fuer die Fusszeile

const SCHWARZ = rgb(0, 0, 0)
const GRAU = rgb(0.42, 0.42, 0.42)
const LINIE = rgb(0.78, 0.78, 0.78)

/** Spalten, von links nach rechts; die Zahlen sind rechtsbuendig. */
const SPALTE = {
  pos: RAND,
  text: RAND + 26,
  textBreite: 232,
  menge: RAND + 300,
  einzel: RAND + 372,
  satz: RAND + 416,
  betrag: RECHTS
}

export interface InvoiceLayoutInput {
  invoice: CiiInvoice
  /** Kennung der Rechnung fuer die Fusszeile, damit ein Beleg zuordenbar
   *  bleibt, wenn nur ein Ausdruck vorliegt. */
  publicRef: string
  /** Warum kein XML eingebettet ist. Steht als Hinweis auf dem Blatt: wer
   *  eine elektronische Rechnung erwartet und ein blosses PDF bekommt, soll
   *  den Grund lesen koennen und nicht nachfragen muessen. */
  missingXmlNote?: string | null
}

const TITEL: Record<CiiInvoice['kind'], string> = {
  final: 'Rechnung',
  interim: 'Zwischenrechnung',
  deposit: 'Anzahlungsrechnung',
  credit_note: 'Stornorechnung'
}

/** 123456 wird zu 1.234,56. Ganzzahlig gerechnet, nie ueber Fliesskomma. */
export function euro(cent: number): string {
  const negativ = cent < 0
  const abs = Math.abs(Math.trunc(cent))
  const ganz = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${negativ ? '-' : ''}${ganz},${String(abs % 100).padStart(2, '0')}`
}

/** 2026-10-01 wird zu 01.10.2026, ohne den Umweg ueber eine Zeitzone. */
export function datum(iso: string): string {
  const [j, m, t] = iso.split('-')
  return `${t}.${m}.${j}`
}

function prozent(rateBp: number): string {
  return `${euro(rateBp)} %`
}

function menge(l: CiiLine): string {
  const n = l.netCent < 0 ? -Math.abs(l.quantity) : l.quantity
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',')
}

interface Schriften { regular: PDFFont; bold: PDFFont }

interface Zeichner {
  doc: PDFDocument
  seite: PDFPage
  schrift: Schriften
  y: number
}

function text(
  z: Zeichner, s: string, x: number, y: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; align?: 'left' | 'right' } = {}
): void {
  const size = opts.size ?? 9
  const font = opts.bold ? z.schrift.bold : z.schrift.regular
  const breite = opts.align === 'right' ? font.widthOfTextAtSize(s, size) : 0
  z.seite.drawText(s, {
    x: x - breite, y, size, font, color: opts.color ?? SCHWARZ
  })
}

/** Bricht einen Text auf eine Spaltenbreite um. Kein Abschneiden: die
 *  Leistungsbeschreibung ist eine Pflichtangabe nach § 14 Abs. 4 Nr. 5. */
function umbrechen(s: string, font: PDFFont, size: number, breite: number): string[] {
  const woerter = s.split(/\s+/)
  const zeilen: string[] = []
  let aktuell = ''
  for (const w of woerter) {
    const versuch = aktuell === '' ? w : `${aktuell} ${w}`
    if (font.widthOfTextAtSize(versuch, size) > breite && aktuell !== '') {
      zeilen.push(aktuell)
      aktuell = w
    } else {
      aktuell = versuch
    }
  }
  if (aktuell !== '') zeilen.push(aktuell)
  return zeilen.length > 0 ? zeilen : ['']
}

function neueSeite(z: Zeichner): void {
  z.seite = z.doc.addPage([A4.width, A4.height])
  z.y = A4.height - RAND
}

function linie(z: Zeichner, y: number): void {
  z.seite.drawLine({
    start: { x: RAND, y }, end: { x: RECHTS, y }, thickness: 0.5, color: LINIE
  })
}

function kopf(z: Zeichner, inv: CiiInvoice): void {
  const s = inv.seller
  text(z, s.name, RAND, z.y - 4, { size: 14, bold: true })
  const anschrift = [s.addressLine1, [s.postalCode, s.city].filter(Boolean).join(' ')]
    .filter(Boolean).join(' · ')
  text(z, anschrift, RAND, z.y - 18, { size: 8, color: GRAU })
  z.y -= 56

  // Empfaengerblock links, Eckdaten rechts. Das ist die Aufteilung, die ein
  // Fensterumschlag erzwingt, und der Grund, warum sie nicht frei ist.
  const b = inv.buyer
  const zeilen = [
    b.name,
    b.addressLine1 ?? '',
    [b.postalCode, b.city].filter(Boolean).join(' '),
    b.country && b.country.toUpperCase() !== 'DE' ? b.country.toUpperCase() : ''
  ].filter(x => x !== '')
  let y = z.y
  for (const zeile of zeilen) {
    text(z, zeile, RAND, y, { size: 10 })
    y -= 13
  }

  const eck: Array<[string, string]> = [
    ['Rechnungsnummer', inv.number],
    ['Rechnungsdatum', datum(inv.issuedOn)],
    // § 14 Abs. 4 Nr. 6 UStG: bei Beherbergung der Aufenthalt, nicht das
    // Rechnungsdatum.
    ['Leistungszeitraum', inv.serviceFrom === inv.serviceTo
      ? datum(inv.serviceFrom)
      : `${datum(inv.serviceFrom)} bis ${datum(inv.serviceTo)}`]
  ]
  if (inv.seller.vatId) eck.push(['USt-IdNr.', inv.seller.vatId])
  if (inv.seller.taxNumber) eck.push(['Steuernummer', inv.seller.taxNumber])

  // Beschriftung weit genug links: „Leistungszeitraum" und ein Zeitraum
  // aus zwei vollen Daten sind zusammen breiter, als eine halbe Seite
  // aussieht, und laufen sonst ineinander.
  let ey = z.y
  for (const [k, v] of eck) {
    text(z, k, SPALTE.betrag - 190, ey, { size: 8, color: GRAU })
    text(z, v, SPALTE.betrag, ey, { size: 8, align: 'right' })
    ey -= 12
  }

  z.y = Math.min(y, ey) - 26
  text(z, TITEL[inv.kind], RAND, z.y, { size: 15, bold: true })
  z.y -= 24
}

function tabellenkopf(z: Zeichner): void {
  const y = z.y
  text(z, 'Pos', SPALTE.pos, y, { size: 8, bold: true })
  text(z, 'Leistung', SPALTE.text, y, { size: 8, bold: true })
  text(z, 'Menge', SPALTE.menge, y, { size: 8, bold: true, align: 'right' })
  text(z, 'Einzelpreis', SPALTE.einzel, y, { size: 8, bold: true, align: 'right' })
  text(z, 'USt', SPALTE.satz, y, { size: 8, bold: true, align: 'right' })
  text(z, 'Betrag netto', SPALTE.betrag, y, { size: 8, bold: true, align: 'right' })
  linie(z, y - 6)
  z.y = y - 18
}

function positionen(z: Zeichner, inv: CiiInvoice): void {
  tabellenkopf(z)
  for (const [i, l] of inv.lines.entries()) {
    const zeilen = umbrechen(l.name, z.schrift.regular, 9, SPALTE.textBreite)
    const hoehe = zeilen.length * 11 + 3
    if (z.y - hoehe < UNTEN) {
      neueSeite(z)
      tabellenkopf(z)
    }
    const y = z.y
    text(z, String(i + 1), SPALTE.pos, y)
    for (const [k, zeile] of zeilen.entries()) {
      text(z, zeile, SPALTE.text, y - k * 11)
    }
    text(z, menge(l), SPALTE.menge, y, { align: 'right' })
    // Einzelpreis netto. Bei Uebernachtungen der Preis je Nacht; deshalb
    // steht die Menge in Naechten und nicht in Stueck.
    text(z, euro(Math.round(Math.abs(l.netCent) / (Math.abs(l.quantity) || 1))),
      SPALTE.einzel, y, { align: 'right' })
    text(z, prozent(l.rateBp), SPALTE.satz, y, { align: 'right' })
    text(z, euro(l.netCent), SPALTE.betrag, y, { align: 'right' })
    z.y -= hoehe
  }
  linie(z, z.y + 6)
  z.y -= 8
}

/**
 * Steueraufstellung und Endsummen.
 *
 * Die Steuer steht als Tabelle je Satz und nicht als Fliesstext („19 % auf
 * 33,60"): eine Beschriftung, die den Betrag enthaelt, waechst mit ihm und
 * laeuft irgendwann in die Zahlenspalte. Bei einer Gruppenrechnung ueber
 * 40 000 Euro ist „irgendwann" der Regelfall.
 */
function summen(z: Zeichner, inv: CiiInvoice): void {
  const totals = ciiTotals(inv)
  const prepaid = inv.prepaidCent ?? 0
  const benoetigt = 90 + totals.groups.length * 12 + (prepaid !== 0 ? 24 : 0)
  if (z.y - benoetigt < UNTEN) neueSeite(z)

  const SATZ = RAND + 240
  const NETTO = RAND + 340
  const UST = RAND + 420

  text(z, 'Steuersatz', SATZ, z.y, { size: 8, color: GRAU, align: 'right' })
  text(z, 'Netto', NETTO, z.y, { size: 8, color: GRAU, align: 'right' })
  text(z, 'Umsatzsteuer', UST, z.y, { size: 8, color: GRAU, align: 'right' })
  text(z, 'Brutto', SPALTE.betrag, z.y, { size: 8, color: GRAU, align: 'right' })
  z.y -= 13

  // Je Satzgruppe aus der Nettosumme gerechnet: 20 Fruehstuecke zu 8,40
  // ergeben sonst einen anderen Betrag als 168,00 mal 19 Prozent, und die
  // Differenz findet der Pruefer.
  for (const g of totals.groups) {
    text(z, prozent(g.rateBp), SATZ, z.y, { align: 'right' })
    text(z, euro(g.netCent), NETTO, z.y, { align: 'right' })
    text(z, euro(g.taxCent), UST, z.y, { align: 'right' })
    text(z, euro(g.grossCent), SPALTE.betrag, z.y, { align: 'right' })
    z.y -= 12
  }

  linie(z, z.y + 4)
  z.y -= 10

  const zeile = (
    k: string, v: string, opts: { bold?: boolean; size?: number } = {}
  ): void => {
    text(z, k, SATZ - 130, z.y, { size: opts.size ?? 9, bold: opts.bold })
    text(z, v, SPALTE.betrag, z.y, { size: opts.size ?? 9, bold: opts.bold, align: 'right' })
    z.y -= opts.bold ? 16 : 13
  }

  zeile(inv.kind === 'credit_note' ? 'Gutschriftsbetrag' : 'Rechnungsbetrag',
    `${euro(totals.grossCent)} EUR`, { bold: true, size: 11 })

  if (prepaid !== 0) {
    zeile('davon bereits gezahlt', `${euro(-prepaid)} EUR`)
    zeile('Offener Betrag', `${euro(totals.grossCent - prepaid)} EUR`, { bold: true })
  }
  z.y -= 10
}

function hinweise(z: Zeichner, input: InvoiceLayoutInput): void {
  const inv = input.invoice
  const zeilen: string[] = []
  if (inv.reverseCharge === true) {
    // Wortlaut nach § 14a Abs. 5 UStG. Fehlt er, schuldet das Haus die
    // Steuer trotz Umkehr.
    zeilen.push('Steuerschuldnerschaft des Leistungsempfaengers')
  }
  if (inv.exemptionReason) zeilen.push(inv.exemptionReason)
  zeilen.push(...(inv.notes ?? []))
  if (input.missingXmlNote) zeilen.push(input.missingXmlNote)

  for (const h of zeilen) {
    for (const zeile of umbrechen(h, z.schrift.regular, 8, RECHTS - RAND)) {
      if (z.y < UNTEN) neueSeite(z)
      text(z, zeile, RAND, z.y, { size: 8 })
      z.y -= 11
    }
    z.y -= 3
  }
}

function fusszeilen(doc: PDFDocument, schrift: Schriften, input: InvoiceLayoutInput): void {
  const seiten = doc.getPages()
  const s = input.invoice.seller
  const anschrift = [s.name, s.addressLine1, [s.postalCode, s.city].filter(Boolean).join(' ')]
    .filter(Boolean).join(' · ')
  const steuer = [
    s.vatId ? `USt-IdNr. ${s.vatId}` : null,
    s.taxNumber ? `Steuernummer ${s.taxNumber}` : null
  ].filter(Boolean).join(' · ')

  for (const [i, seite] of seiten.entries()) {
    seite.drawLine({
      start: { x: RAND, y: 54 }, end: { x: RECHTS, y: 54 },
      thickness: 0.5, color: LINIE
    })
    seite.drawText(anschrift, { x: RAND, y: 42, size: 7, font: schrift.regular, color: GRAU })
    seite.drawText(steuer, { x: RAND, y: 33, size: 7, font: schrift.regular, color: GRAU })
    const seitenzahl = `Beleg ${input.publicRef} · Seite ${i + 1} von ${seiten.length}`
    seite.drawText(seitenzahl, {
      x: RECHTS - schrift.regular.widthOfTextAtSize(seitenzahl, 7),
      y: 33, size: 7, font: schrift.regular, color: GRAU
    })
  }
}

/**
 * Zeichnet das Blatt und gibt das noch gewoehnliche PDF zurueck.
 * Aus ihm macht `finalizePdfA3` den Beleg.
 */
export async function renderInvoicePdf(input: InvoiceLayoutInput): Promise<PDFDocument> {
  const { regular, bold } = await loadAssets()
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  // Nur die tatsaechlich benutzten Zeichen einbetten. Ohne Subsetting
  // traegt jede Rechnung 800 Kilobyte Schrift mit sich.
  const schrift: Schriften = {
    regular: await doc.embedFont(regular, { subset: true }),
    bold: await doc.embedFont(bold, { subset: true })
  }

  const z: Zeichner = {
    doc, schrift, seite: doc.addPage([A4.width, A4.height]), y: A4.height - RAND
  }
  kopf(z, input.invoice)
  positionen(z, input.invoice)
  summen(z, input.invoice)
  hinweise(z, input)
  fusszeilen(doc, schrift, input)
  return doc
}
