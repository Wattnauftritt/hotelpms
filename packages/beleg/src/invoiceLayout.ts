import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { ciiTotals, formatCent, imageWithinLimits, paymentTermsText, type CiiInvoice,
         type CiiLine } from '@hotelpms/domain'
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
const MM = 72 / 25.4

/*
 * Briefbogen nach DIN 5008, Form B (Sven, 15.10.2026: die Rechnung aus
 * Lexoffice "sieht anders aus vom optischen aufbau"). Rand links 25 mm,
 * rechts 20 mm, das Anschriftfeld 45 mm von oben. Bisher stand die
 * Anschrift 40 mm von oben und 20 mm von links: im Fensterumschlag lag die
 * erste Zeile hinter dem Papier und der Rand am Fensterrand. Wer eine
 * Rechnung ausdruckt und verschickt, faltet sie an den Marken und steckt
 * sie in einen DL-Umschlag; das muss ohne Nachschieben aufgehen.
 */
const RAND = 25 * MM
const RECHTS = A4.width - 20 * MM
const OBEN = A4.height

const SCHWARZ = rgb(0, 0, 0)
const DUNKEL = rgb(0.25, 0.25, 0.25)
const GRAU = rgb(0.42, 0.42, 0.42)
const LINIE = rgb(0.8, 0.8, 0.8)
const LINIE_KRAEFTIG = rgb(0.2, 0.2, 0.2)

/** Spalten, von links nach rechts; die Zahlen sind rechtsbuendig. */
const SPALTE = {
  pos: RAND,
  text: RAND + 26,
  textBreite: 236,
  menge: RAND + 298,
  einzel: RAND + 360,
  satz: RAND + 404,
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
  /** Ueberschrift statt der zur Art: eine Korrektur, die nur einen Teil
   *  aufhebt, ist keine Stornorechnung (0162). */
  title?: string
  /** Logo des Hauses (0170), oben links. PNG oder JPEG. */
  logo?: { mime: string; bytes: Uint8Array } | null
  /** Meldet, dass das Logo weggelassen wurde, damit der Aufrufer es ohne
   *  Gastdaten protokolliert: der Beleg entsteht trotzdem, aber das Haus
   *  wundert sich sonst ueber Rechnungen ohne Logo. */
  onLogoSkipped?: (reason: 'dimensions' | 'unreadable') => void
  /** Webseite des Hauses fuer den Fuss (0177). Kein Teil des XML. */
  website?: string | null
  /**
   * Vorschau vor dem Festschreiben: quer ueber jeder Seite "ENTWURF", im
   * Fuss keine Belegkennung. Ein ausgedruckter Entwurf darf nicht als
   * Rechnung durchgehen; er hat keine Nummer und ist nicht gebucht.
   */
  draft?: boolean
}

/** Hoechstens so gross, dass es ueber dem Anschriftfeld endet (45 mm). */
const LOGO = { breite: 170, hoehe: 30 * MM }

const TITEL: Record<CiiInvoice['kind'], string> = {
  final: 'Rechnung',
  interim: 'Zwischenrechnung',
  deposit: 'Anzahlungsrechnung',
  credit_note: 'Stornorechnung'
}

/**
 * Der Satz ueber der Tabelle. Eine Stornorechnung bekommt keinen: was sie
 * aufhebt, sagt ihr Hinweis mit Nummer und Datum des Originals.
 */
const EINLEITUNG: Record<CiiInvoice['kind'], string | null> = {
  final: 'Unsere Leistungen stellen wir Ihnen wie folgt in Rechnung.',
  interim: 'Unsere bisherigen Leistungen stellen wir Ihnen wie folgt in Rechnung.',
  deposit: 'Für Ihren Aufenthalt stellen wir Ihnen die folgende Anzahlung in Rechnung.',
  credit_note: null
}

const DANK: Record<CiiInvoice['kind'], string | null> = {
  final: 'Vielen Dank für Ihren Aufenthalt.',
  interim: 'Vielen Dank für Ihren Aufenthalt.',
  deposit: 'Vielen Dank für Ihre Buchung.',
  credit_note: null
}

/**
 * 123456 wird zu 1.234,56. Steht seit dem Mailversand in der Domaene, damit
 * Rechnungsblatt und Anschreiben denselben Betrag gleich schreiben.
 */
export const euro = formatCent

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

function iban(i: string): string {
  return i.replace(/(.{4})(?=.)/g, '$1 ')
}

interface Schriften { regular: PDFFont; bold: PDFFont }

interface Zeichner {
  doc: PDFDocument
  seite: PDFPage
  schrift: Schriften
  y: number
  /** Unterkante des Inhalts; darunter steht der Fuss, dessen Hoehe von
   *  den Angaben des Hauses abhaengt. */
  unten: number
  /** Kopfzeile der Folgeseiten, damit ein loses Blatt zuordenbar bleibt. */
  fortsetzung: string
}

function text(
  z: Zeichner, s: string, x: number, y: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>
          align?: 'left' | 'right' } = {}
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
  text(z, z.fortsetzung, RAND, OBEN - 15 * MM, { size: 8, color: GRAU })
  z.y = OBEN - 15 * MM - 28
}

function linie(
  z: Zeichner, y: number, opts: { x1?: number; dick?: boolean } = {}
): void {
  z.seite.drawLine({
    start: { x: opts.x1 ?? RAND, y }, end: { x: RECHTS, y },
    thickness: opts.dick ? 0.8 : 0.4, color: opts.dick ? LINIE_KRAEFTIG : LINIE
  })
}

function anschriftZeile(s: CiiInvoice['seller']): string {
  return [s.addressLine1, [s.postalCode, s.city].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ')
}

/**
 * Falz- und Lochmarken. Ohne sie faltet jeder nach Augenmass, und die
 * Anschrift rutscht aus dem Fenster.
 */
function marken(seite: PDFPage): void {
  for (const [y, breite] of [[105, 10], [148.5, 14], [210, 10]] as const) {
    seite.drawLine({
      start: { x: 4 * MM, y: OBEN - y * MM }, end: { x: 4 * MM + breite, y: OBEN - y * MM },
      thickness: 0.4, color: GRAU
    })
  }
}

function kopf(z: Zeichner, input: InvoiceLayoutInput, titel: string,
              logo: PDFImage | null): void {
  const inv = input.invoice
  const s = inv.seller

  // Oben links das Haus: das Logo, sonst der Name. Mit Logo steht der Name
  // nicht noch einmal daneben; er steht in der Absenderzeile und im Fuss.
  if (logo !== null) {
    const m = logo.scaleToFit(LOGO.breite, LOGO.hoehe)
    z.seite.drawImage(logo, { x: RAND, y: OBEN - 12 * MM - m.height,
                              width: m.width, height: m.height })
  } else {
    text(z, s.name, RAND, OBEN - 20 * MM, { size: 14, bold: true })
    text(z, anschriftZeile(s), RAND, OBEN - 20 * MM - 14, { size: 8, color: GRAU })
  }

  // Oben rechts, was die Rechnung ist, und ihre Eckdaten. Dort sucht sie
  // die Buchhaltung des Empfaengers, und dort stehen sie bei Lexoffice.
  text(z, titel, RECHTS, OBEN - 20 * MM, { size: 18, bold: true, align: 'right' })
  const eck: Array<[string, string]> = [
    ['Rechnungsnr.', inv.number],
    ['Datum', datum(inv.issuedOn)],
    // § 14 Abs. 4 Nr. 6 UStG: bei Beherbergung der Aufenthalt, nicht das
    // Rechnungsdatum.
    ['Leistungszeitraum', inv.serviceFrom === inv.serviceTo
      ? datum(inv.serviceFrom)
      : `${datum(inv.serviceFrom)} – ${datum(inv.serviceTo)}`]
  ]
  // BT-10: die Eingangsstelle einer Behoerde ordnet die Rechnung allein
  // danach zu; auf dem Blatt, damit die Papierfassung dieselbe Angabe traegt.
  if (inv.buyerReference) eck.push(['Leitweg-ID', inv.buyerReference])
  if (inv.precedingInvoice) eck.push(['zu Rechnung', inv.precedingInvoice.number])
  let ey = OBEN - 20 * MM - 22
  for (const [k, v] of eck) {
    text(z, k, RECHTS - 170, ey, { size: 8.5, color: GRAU })
    text(z, v, RECHTS, ey, { size: 8.5, align: 'right' })
    ey -= 12.5
  }

  // Anschriftfeld, Form B: 45 mm von oben, 85 mm breit. Die Absenderzeile
  // steht klein am unteren Rand der Vermerkzone, damit ein unzustellbarer
  // Brief zurueckfindet; die Anschrift beginnt darunter.
  const feld = 85 * MM
  const absender = [s.name, anschriftZeile(s)].filter(Boolean).join(', ')
  let groesse = 7
  while (groesse > 5 && z.schrift.regular.widthOfTextAtSize(absender, groesse) > feld) {
    groesse -= 0.25
  }
  const ay = OBEN - 59 * MM
  text(z, absender, RAND, ay, { size: groesse, color: DUNKEL })
  z.seite.drawLine({
    start: { x: RAND, y: ay - 1.8 },
    end: { x: RAND + Math.min(feld, z.schrift.regular.widthOfTextAtSize(absender, groesse)),
           y: ay - 1.8 },
    thickness: 0.3, color: DUNKEL
  })

  const b = inv.buyer
  const zeilen = [
    b.name,
    // "z. Hd." unter der Firma, wie auf einem Briefumschlag (0171).
    b.contactName ?? '',
    b.addressLine1 ?? '',
    [b.postalCode, b.city].filter(Boolean).join(' '),
    b.country && b.country.toUpperCase() !== 'DE' ? b.country.toUpperCase() : ''
  ].filter(x => x !== '')
  let y = OBEN - 66 * MM
  for (const zeile of zeilen) {
    for (const teil of umbrechen(zeile, z.schrift.regular, 10, feld)) {
      text(z, teil, RAND, y, { size: 10 })
      y -= 12.5
    }
  }

  z.y = Math.min(OBEN - 103 * MM, y - 24, ey - 24)
  const einleitung = EINLEITUNG[inv.kind]
  if (einleitung !== null && input.title === undefined) {
    text(z, einleitung, RAND, z.y, { size: 9.5 })
    z.y -= 26
  }
}

function tabellenkopf(z: Zeichner): void {
  const y = z.y
  const k = { size: 8.5, bold: true } as const
  text(z, 'Pos.', SPALTE.pos, y, k)
  text(z, 'Bezeichnung', SPALTE.text, y, k)
  text(z, 'Menge', SPALTE.menge, y, { ...k, align: 'right' })
  text(z, 'Einzel netto', SPALTE.einzel, y, { ...k, align: 'right' })
  text(z, 'USt.', SPALTE.satz, y, { ...k, align: 'right' })
  text(z, 'Gesamt netto', SPALTE.betrag, y, { ...k, align: 'right' })
  linie(z, y - 6, { dick: true })
  z.y = y - 20
}

function positionen(z: Zeichner, inv: CiiInvoice): void {
  tabellenkopf(z)
  for (const [i, l] of inv.lines.entries()) {
    const zeilen = umbrechen(l.name, z.schrift.regular, 9, SPALTE.textBreite)
    const hoehe = zeilen.length * 11 + 9
    if (z.y - hoehe < z.unten) {
      neueSeite(z)
      tabellenkopf(z)
    }
    const y = z.y
    if (i > 0) linie(z, y + 11)
    text(z, String(i + 1), SPALTE.pos, y, { color: GRAU })
    for (const [k, zeile] of zeilen.entries()) {
      text(z, zeile, SPALTE.text, y - k * 11)
    }
    text(z, menge(l), SPALTE.menge, y, { align: 'right' })
    // Einzelpreis netto. Bei Uebernachtungen der Preis je Nacht; deshalb
    // steht die Menge in Naechten und nicht in Stueck.
    // Zusammengefasste Naechte zu verschiedenen Preisen: der Durchschnitt,
    // als solcher gekennzeichnet (groupInvoiceLines).
    const einzel = euro(Math.round(Math.abs(l.netCent) / (Math.abs(l.quantity) || 1)))
    text(z, l.averagePrice ? `Ø ${einzel}` : einzel, SPALTE.einzel, y, { align: 'right' })
    text(z, prozent(l.rateBp), SPALTE.satz, y, { align: 'right' })
    text(z, euro(l.netCent), SPALTE.betrag, y, { align: 'right' })
    z.y -= hoehe
  }
  linie(z, z.y + 11, { dick: true })
  z.y -= 8
}

/**
 * Steueraufstellung und Endsummen.
 *
 * Die Steuer steht als Tabelle je Satz und nicht als Fliesstext („19 % auf
 * 33,60"): eine Beschriftung, die den Betrag enthaelt, waechst mit ihm und
 * laeuft irgendwann in die Zahlenspalte. Bei einer Gruppenrechnung ueber
 * 40 000 Euro ist „irgendwann" der Regelfall. Der Block steht rechtsbuendig
 * unter der Tabelle, wo das Auge nach der letzten Zeile die Summe sucht.
 */
function summen(z: Zeichner, inv: CiiInvoice): void {
  const totals = ciiTotals(inv)
  // Eine Stornorechnung ist mit ihrem Original verrechnet; "davon bereits
  // gezahlt" und "offen" waeren auf ihr eine Aussage ueber Geld, das nicht
  // fliesst. Der Bezug steht in den Hinweisen.
  const prepaid = inv.kind === 'credit_note' ? 0 : inv.prepaidCent ?? 0
  const rundung = inv.roundingCent ?? 0
  const benoetigt = 90 + totals.groups.length * 12
    + (prepaid !== 0 ? 24 : 0) + (rundung !== 0 ? 26 : 0)
  if (z.y - benoetigt < z.unten) neueSeite(z)

  const LINKS = RECHTS - 270
  const NETTO = LINKS + 120
  const UST = LINKS + 195

  text(z, 'USt.-Satz', LINKS, z.y, { size: 8, color: GRAU })
  text(z, 'Netto', NETTO, z.y, { size: 8, color: GRAU, align: 'right' })
  text(z, 'USt.', UST, z.y, { size: 8, color: GRAU, align: 'right' })
  text(z, 'Brutto', SPALTE.betrag, z.y, { size: 8, color: GRAU, align: 'right' })
  z.y -= 13

  // Je Satzgruppe aus der Nettosumme gerechnet: 20 Fruehstuecke zu 8,40
  // ergeben sonst einen anderen Betrag als 168,00 mal 19 Prozent, und die
  // Differenz findet der Pruefer.
  for (const g of totals.groups) {
    text(z, prozent(g.rateBp), LINKS, z.y)
    text(z, euro(g.netCent), NETTO, z.y, { align: 'right' })
    text(z, euro(g.taxCent), UST, z.y, { align: 'right' })
    text(z, euro(g.grossCent), SPALTE.betrag, z.y, { align: 'right' })
    z.y -= 12
  }
  if (totals.groups.length > 1) {
    linie(z, z.y + 8, { x1: LINKS })
    text(z, euro(totals.groups.reduce((a, g) => a + g.netCent, 0)), NETTO, z.y - 2,
      { align: 'right', color: DUNKEL })
    text(z, euro(totals.groups.reduce((a, g) => a + g.taxCent, 0)), UST, z.y - 2,
      { align: 'right', color: DUNKEL })
    z.y -= 14
  }

  z.y -= 8
  linie(z, z.y + 12, { x1: LINKS, dick: true })

  const zeile = (
    k: string, v: string, opts: { bold?: boolean; size?: number } = {}
  ): void => {
    text(z, k, LINKS, z.y, { size: opts.size ?? 9, bold: opts.bold })
    text(z, v, SPALTE.betrag, z.y, { size: opts.size ?? 9, bold: opts.bold, align: 'right' })
    z.y -= opts.bold ? 17 : 13
  }

  zeile(inv.kind === 'credit_note' ? 'Gutschriftsbetrag' : 'Rechnungsbetrag',
    `${euro(totals.grossCent)} EUR`, { bold: true, size: 11 })

  // BT-114. Der Rundungsbetrag steht als eigene Zeile und nicht still in der
  // Endsumme: der Gast zahlt einen anderen Betrag als die Steueraufstellung
  // ergibt, und wer das nicht auf dem Blatt sieht, haelt es fuer einen Fehler
  // des Hauses.
  if (rundung !== 0) {
    zeile('Rundung', `${euro(rundung)} EUR`)
  }
  if (prepaid !== 0) {
    zeile('davon bereits gezahlt', `${euro(-prepaid)} EUR`)
  }
  if (prepaid !== 0 || rundung !== 0) {
    zeile(prepaid !== 0 ? 'Offener Betrag' : 'Zahlbetrag',
      `${euro(totals.grossCent - prepaid + rundung)} EUR`, { bold: true })
  }
  z.y -= 14
}

function hinweise(z: Zeichner, input: InvoiceLayoutInput): void {
  const inv = input.invoice
  const zeilen: Array<{ text: string; klein?: boolean }> = []
  if (inv.reverseCharge === true) {
    // Wortlaut nach § 14a Abs. 5 UStG. Fehlt er, schuldet das Haus die
    // Steuer trotz Umkehr.
    zeilen.push({ text: 'Steuerschuldnerschaft des Leistungsempfängers' })
  }
  if (inv.exemptionReason) zeilen.push({ text: inv.exemptionReason })
  // Dieselbe Bedingung wie im XML (BT-20), damit Blatt und Datei nicht
  // Verschiedenes sagen. Der Satz zur Ueberweisung steht daneben, nicht
  // darin: er ist Bitte, keine Bedingung, und gehoert nicht ins XML.
  const bedingung = paymentTermsText(inv)
  if (bedingung !== null) {
    zeilen.push({ text: inv.payee?.iban
      ? `${bedingung} Bitte überweisen Sie den Betrag unter Angabe der Rechnungsnummer `
        // Der Entwurf hat noch keine; die Nummer vergibt das Festschreiben.
        + `${input.draft ? '' : `${inv.number} `}auf das unten genannte Konto.`
      : bedingung })
  }
  for (const n of inv.notes ?? []) zeilen.push({ text: n })
  const dank = DANK[inv.kind]
  if (dank !== null && input.title === undefined) zeilen.push({ text: dank })
  if (input.missingXmlNote) zeilen.push({ text: input.missingXmlNote, klein: true })

  for (const h of zeilen) {
    const size = h.klein ? 7.5 : 9
    for (const zeile of umbrechen(h.text, z.schrift.regular, size, RECHTS - RAND)) {
      if (z.y < z.unten) neueSeite(z)
      text(z, zeile, RAND, z.y, { size, color: h.klein ? GRAU : SCHWARZ })
      z.y -= size + 3.5
    }
    z.y -= 5
  }
}

/** Groesse und Abstand im Fuss. */
const FUSS = { size: 7, zeile: 8.6, seitenzahl: 8 * MM }

/**
 * Der Fuss in drei Spalten, wie auf dem Geschaeftsbrief: wer, wie
 * erreichbar; unter welchen Nummern beim Finanzamt; wohin ueberweisen.
 * Bisher standen dieselben Angaben in drei Zeilen hintereinander, getrennt
 * durch Punkte, und die IBAN war in der dritten kaum zu finden. Die
 * Steuernummern stehen nur noch hier und nicht zusaetzlich im Kopf: § 14
 * Abs. 4 Nr. 2 UStG verlangt sie auf der Rechnung, nicht an einer
 * bestimmten Stelle.
 */
function fussSpalten(input: InvoiceLayoutInput): Array<{ x: number; breite: number
                                                          zeilen: string[] }> {
  const s = input.invoice.seller
  const bank = input.invoice.payee
  const ort = [s.postalCode, s.city].filter(Boolean).join(' ')
  const land = s.country && s.country.toUpperCase() !== 'DE' ? s.country.toUpperCase() : null
  const eins = [s.name, s.addressLine1, ort, land,
                s.phone ? `Tel.: ${s.phone}` : null, s.email, input.website ?? null]
  const zwei = [
    s.vatId ? `USt-IdNr.: ${s.vatId}` : null,
    s.taxNumber ? `Steuernummer: ${s.taxNumber}` : null,
    s.registrationId ?? null
  ]
  // Bisher stand auf keiner Rechnung eine Bankverbindung; eine Firma mit
  // Zahlungsziel musste sie erfragen (Pruefung vom 13.10.2026). Der
  // Kontoinhaber nur, wenn er nicht ohnehin der Name des Hauses ist.
  const drei = bank?.iban ? [
    bank.accountName && bank.accountName !== s.name ? bank.accountName : null,
    bank.bankName ?? null,
    `IBAN: ${iban(bank.iban)}`,
    bank.bic ? `BIC: ${bank.bic}` : null
  ] : []
  const nur = (l: Array<string | null | undefined>): string[] =>
    l.filter((x): x is string => typeof x === 'string' && x !== '')
  const breite = RECHTS - RAND
  return [
    { x: RAND, breite: breite * 0.38 - 8, zeilen: nur(eins) },
    { x: RAND + breite * 0.38, breite: breite * 0.3 - 8, zeilen: nur(zwei) },
    { x: RAND + breite * 0.68, breite: breite * 0.32, zeilen: nur(drei) }
  ]
}

/** Hoehe des Fusses ab Blattunterkante, damit der Inhalt davor endet. */
function fussHoehe(schrift: Schriften, input: InvoiceLayoutInput): number {
  const n = Math.max(1, ...fussSpalten(input).map(sp => sp.zeilen
    .flatMap(t => umbrechen(t, schrift.regular, FUSS.size, sp.breite)).length))
  return FUSS.seitenzahl + 10 + n * FUSS.zeile + 8
}

function fusszeilen(doc: PDFDocument, schrift: Schriften, input: InvoiceLayoutInput): void {
  const seiten = doc.getPages()
  const spalten = fussSpalten(input)
  const oben = fussHoehe(schrift, input) - 8

  for (const [i, seite] of seiten.entries()) {
    seite.drawLine({
      start: { x: RAND, y: oben }, end: { x: RECHTS, y: oben },
      thickness: 0.4, color: LINIE
    })
    for (const sp of spalten) {
      let y = oben - 10
      for (const t of sp.zeilen) {
        for (const teil of umbrechen(t, schrift.regular, FUSS.size, sp.breite)) {
          seite.drawText(teil, { x: sp.x, y, size: FUSS.size, font: schrift.regular,
                                 color: DUNKEL })
          y -= FUSS.zeile
        }
      }
    }
    if (input.draft) {
      const wort = 'ENTWURF'
      const groesse = 110
      const breite = schrift.bold.widthOfTextAtSize(wort, groesse)
      // Um 40 Grad gedreht durch die Seitenmitte.
      const w = 40 * Math.PI / 180
      seite.drawText(wort, {
        x: A4.width / 2 - Math.cos(w) * breite / 2 + Math.sin(w) * groesse * 0.35,
        y: A4.height / 2 - Math.sin(w) * breite / 2 - Math.cos(w) * groesse * 0.35,
        size: groesse, font: schrift.bold, color: rgb(0.85, 0.85, 0.85),
        rotate: degrees(40), opacity: 0.3
      })
    }
    const seitenzahl = input.draft
      ? `Seite ${i + 1} von ${seiten.length} · Entwurf, keine Rechnung`
      : `Seite ${i + 1} von ${seiten.length} · Beleg ${input.publicRef}`
    seite.drawText(seitenzahl, {
      x: (A4.width - schrift.regular.widthOfTextAtSize(seitenzahl, 7)) / 2,
      y: FUSS.seitenzahl, size: 7, font: schrift.regular, color: GRAU
    })
  }
}

/**
 * Ein Logo, das sich nicht einbetten laesst, kostet die Rechnung nicht den
 * Beleg: sie erscheint dann ohne. Die Schnittstelle prueft die Art an den
 * Bytes, ein beschaedigtes Bild faellt erst hier auf.
 */
async function logoEinbetten(
  doc: PDFDocument, logo: InvoiceLayoutInput['logo'],
  onSkipped: InvoiceLayoutInput['onLogoSkipped']
): Promise<PDFImage | null> {
  if (logo === undefined || logo === null) return null
  // Vor dem Dekodieren die Masse aus dem Kopf (Audit 19.10., M6): `embedPng`
  // dekodiert synchron, und ein Logo mit 12 000 x 12 000 Bildpunkten haelt
  // Worker oder API sekundenlang an und kostet ueber ein Gigabyte. Die
  // Schnittstelle weist solche Bilder seither ab; ein vorher hochgeladenes
  // bleibt aber in der Tabelle und wird hier weggelassen, nicht gezeichnet.
  if (!imageWithinLimits(logo.bytes)) {
    onSkipped?.('dimensions')
    return null
  }
  try {
    return logo.mime === 'image/png' ? await doc.embedPng(logo.bytes)
      : await doc.embedJpg(logo.bytes)
  } catch {
    onSkipped?.('unreadable')
    return null
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

  const titel = input.title ?? TITEL[input.invoice.kind]
  const z: Zeichner = {
    doc, schrift, seite: doc.addPage([A4.width, A4.height]), y: OBEN,
    unten: fussHoehe(schrift, input) + 6,
    fortsetzung: `${titel} ${input.invoice.number} · Fortsetzung`
  }
  marken(z.seite)
  kopf(z, input, titel, await logoEinbetten(doc, input.logo, input.onLogoSkipped))
  positionen(z, input.invoice)
  summen(z, input.invoice)
  hinweise(z, input)
  fusszeilen(doc, schrift, input)
  return doc
}
