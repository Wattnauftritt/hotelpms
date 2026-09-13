import type { Cent, BasisPoints } from './money.js'
import { sumInvoice, type InvoiceTotals } from './money.js'
import type { IsoDate } from './dates.js'

/**
 * CII-XML einer Rechnung nach EN 16931, Syntax UN/CEFACT Cross Industry
 * Invoice. Das ist der XML-Teil von ZUGFeRD 2.x und Factur-X; das PDF
 * transportiert ihn nur.
 *
 * **Warum das hier steht und nicht im Worker.** Welches Feld welchen
 * Geschäftsinhalt trägt, ist Fachlichkeit und keine Ausgabeform: die
 * Zuordnung von Steuergruppe zu BG-23, von Aufenthalt zu BT-73/BT-74, von
 * Gegenbuchung zu negativer Menge. Sie gehört neben die Prüfung der
 * Pflichtangaben nach § 14 UStG und wird wie diese ohne Datenbank und ohne
 * PDF getestet.
 *
 * **Warum ein eigener Serialisierer und keine Bibliothek.** Die Reihenfolge
 * der Elemente ist in CII nicht beliebig, sondern eine XSD-Sequenz: ein
 * ram:CategoryCode vor dem ram:BasisAmount ist kein Schönheitsfehler,
 * sondern ein ungültiges Dokument. Ein Baum, der genau in der Reihenfolge
 * ausgegeben wird, in der er aufgebaut wurde, macht diese Reihenfolge im
 * Code sichtbar und im Test vergleichbar.
 */

/** Beteiligter, wie ihn die Momentaufnahme der Rechnung hält. */
export interface CiiParty {
  name: string
  addressLine1?: string | null
  postalCode?: string | null
  city?: string | null
  /** ISO 3166-1 alpha-2. Ohne Angabe DE, weil das Haus in Deutschland steht. */
  country?: string | null
  /** BT-32, Steuernummer. Nur beim Aussteller. */
  taxNumber?: string | null
  /** BT-31 beim Aussteller, BT-48 beim Empfänger. */
  vatId?: string | null
}

/**
 * Umsatzsteuerkategorie nach UNTDID 5305.
 *   S  Regelsatz, der Normalfall in der Beherbergung (7 und 19 Prozent)
 *   AE Steuerschuldnerschaft des Leistungsempfängers, § 13b UStG
 *   E  steuerbefreit
 *   Z  Nullsatz
 */
export type VatCategory = 'S' | 'AE' | 'E' | 'Z'

export interface CiiLine {
  /** BT-153. Bei uns die Beschreibung der Position. */
  name: string
  /** BT-129. Negativ bei einer Gegenbuchung, siehe unten. */
  quantity: number
  /**
   * BT-130, Einheit nach UN/ECE Recommendation 20.
   * `DAY` für Übernachtungen, `C62` (Stück) für alles andere.
   */
  unitCode?: string
  /** BT-131, Nettobetrag der Position. */
  netCent: Cent
  /** BT-152. */
  rateBp: BasisPoints
}

export interface CiiInvoice {
  /** BT-1. */
  number: string
  /** BT-2. */
  issuedOn: IsoDate
  kind: 'final' | 'interim' | 'deposit' | 'credit_note'
  /** BT-5. */
  currency: string
  seller: CiiParty
  buyer: CiiParty
  lines: CiiLine[]
  /** BT-73, erste abgerechnete Nacht. */
  serviceFrom: IsoDate
  /** BT-74 und BT-72, letzte abgerechnete Nacht. */
  serviceTo: IsoDate
  /** BT-113, bereits vereinnahmt und auf diese Rechnung angerechnet. */
  prepaidCent?: Cent
  /** § 13b UStG. Setzt die Kategorie aller Positionen auf AE. */
  reverseCharge?: boolean
  /** BT-120. Pflicht, sobald eine Kategorie ohne Steuer vorkommt. */
  exemptionReason?: string | null
  /** BT-22, freie Hinweise. Der § 13b-Hinweis kommt von selbst dazu. */
  notes?: string[]
}

/** Wörtlicher Hinweis nach § 14a Abs. 5 UStG. Ohne ihn schuldet das Haus. */
export const REVERSE_CHARGE_NOTE = 'Steuerschuldnerschaft des Leistungsempfaengers'

const NS = {
  rsm: 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  ram: 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
  udt: 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
  qdt: 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100'
}

/** BT-24. Kennzeichnet das Profil; ein Prüfer wählt danach sein Regelwerk. */
export const EN16931_GUIDELINE = 'urn:cen.eu:en16931:2017'

/** BT-3 nach UNTDID 1001. */
function documentTypeCode(kind: CiiInvoice['kind']): string {
  switch (kind) {
    // Eine Stornorechnung ist eine Gutschrift im Sinne der Norm. Die
    // Abrechnung durch den Leistungsempfaenger waere 389 und entsteht in
    // diesem System nicht.
    case 'credit_note': return '381'
    // Anzahlungsrechnung. Die Steuer entsteht mit der Vereinnahmung,
    // § 13 Abs. 1 Nr. 1a UStG.
    case 'deposit': return '386'
    default: return '380'
  }
}

interface XmlNode {
  name: string
  attrs?: Record<string, string | undefined>
  text?: string
  children?: XmlNode[]
}

function el(name: string, ...children: (XmlNode | false | null | undefined)[]): XmlNode {
  return { name, children: children.filter((c): c is XmlNode => !!c) }
}

function leaf(
  name: string, text: string, attrs?: Record<string, string | undefined>
): XmlNode {
  return { name, text, ...(attrs ? { attrs } : {}) }
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;'
      : c === '"' ? '&quot;' : '&apos;')
}

function serialize(node: XmlNode, indent = 0): string {
  const pad = '  '.repeat(indent)
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(v!)}"`)
    .join('')
  if (node.text !== undefined) {
    return `${pad}<${node.name}${attrs}>${escapeXml(node.text)}</${node.name}>`
  }
  const kinder = node.children ?? []
  if (kinder.length === 0) return `${pad}<${node.name}${attrs}/>`
  return [
    `${pad}<${node.name}${attrs}>`,
    ...kinder.map(k => serialize(k, indent + 1)),
    `${pad}</${node.name}>`
  ].join('\n')
}

/** Kalenderdatum als CCYYMMDD, Format 102 in UNTDID 2379. */
function dateString(date: IsoDate): XmlNode {
  return leaf('udt:DateTimeString', date.replace(/-/g, ''), { format: '102' })
}

function dateNode(name: string, date: IsoDate): XmlNode {
  return el(name, dateString(date))
}

/**
 * Betrag als Dezimalzahl mit zwei Nachkommastellen.
 * Gerechnet wird in Cent; die Umrechnung passiert genau hier und nirgends
 * sonst, damit kein Fliesskomma in die Fachlogik zurueckwandert.
 */
export function amount(cent: Cent): string {
  const negativ = cent < 0
  const abs = Math.abs(Math.trunc(cent))
  return `${negativ ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Steuersatz in Prozent. 700 Basispunkte sind 7.00. */
function percent(rateBp: BasisPoints): string {
  return amount(rateBp)
}

/**
 * Einzelpreis BT-146 aus Nettobetrag und Menge.
 *
 * BR-27 verbietet einen negativen Einzelpreis. Eine Gegenbuchung wird
 * deshalb ueber eine negative **Menge** ausgedrueckt und nicht ueber einen
 * negativen Preis; der Positionsbetrag BT-131 bleibt negativ, und die
 * Summenregeln gehen auf.
 *
 * Vier Nachkommastellen, weil ein Preis anders als ein Betrag mehr als zwei
 * haben darf: 100,00 Euro auf drei Naechte sind 33,3333 und nicht 33,33.
 * Zwei Stellen wuerden die Position um einen Cent verfehlen.
 */
function unitPrice(netCent: Cent, quantity: number): string {
  const menge = Math.abs(quantity) || 1
  const proEinheit = Math.abs(netCent) / menge / 100
  return proEinheit.toFixed(4)
}

function partyNode(name: string, p: CiiParty, opts: { taxNumber: boolean }): XmlNode {
  // Kein erfundenes Land, wenn keines da ist: ein Gast ohne Landangabe ist
  // nicht automatisch Inlaender, und ein stillschweigendes DE waere im
  // Zweifel eine falsche Angabe in einem steuerlichen Beleg. Fehlt es,
  // meldet es ciiFindings, und dann entsteht gar kein XML.
  const anschrift = el('ram:PostalTradeAddress',
    p.postalCode ? leaf('ram:PostcodeCode', p.postalCode) : null,
    p.addressLine1 ? leaf('ram:LineOne', p.addressLine1) : null,
    p.city ? leaf('ram:CityName', p.city) : null,
    p.country ? leaf('ram:CountryID', p.country.toUpperCase()) : null)

  return el(name,
    leaf('ram:Name', p.name),
    anschrift,
    // Umsatzsteuer-Identifikationsnummer und Steuernummer sind zwei
    // Registrierungen, nicht zwei Schreibweisen derselben: VA ist die
    // USt-IdNr nach BT-31, FC die Steuernummer nach BT-32.
    p.vatId ? el('ram:SpecifiedTaxRegistration', leaf('ram:ID', p.vatId, { schemeID: 'VA' })) : null,
    opts.taxNumber && p.taxNumber
      ? el('ram:SpecifiedTaxRegistration', leaf('ram:ID', p.taxNumber, { schemeID: 'FC' }))
      : null)
}

function categoryOf(inv: CiiInvoice, rateBp: BasisPoints): VatCategory {
  if (inv.reverseCharge === true) return 'AE'
  if (rateBp > 0) return 'S'
  return inv.exemptionReason ? 'E' : 'Z'
}

function exemptionReasonFor(inv: CiiInvoice, category: VatCategory): string | null {
  if (category === 'AE') return REVERSE_CHARGE_NOTE
  if (category === 'S') return null
  return inv.exemptionReason ?? null
}

/**
 * Summen der Rechnung, wie sie im XML stehen.
 *
 * Bewusst aus den Positionen gerechnet und nicht aus der gespeicherten
 * Momentaufnahme uebernommen: das XML muss in sich aufgehen (BR-CO-10 bis
 * BR-CO-16), sonst weist der Pruefer es ab. Wer die gespeicherten Summen
 * gegenprueft, findet damit auch gleich einen Rechenfehler an anderer
 * Stelle.
 */
export function ciiTotals(inv: CiiInvoice): InvoiceTotals {
  return sumInvoice(inv.lines.map(l => ({ netCent: l.netCent, rateBp: l.rateBp })))
}

export interface CiiFinding {
  key: 'seller_name' | 'seller_address' | 'seller_identifier'
     | 'buyer_name' | 'buyer_address' | 'lines' | 'currency'
  /** Regel der Norm, damit die Meldung nachprüfbar ist. */
  rule: string
  de: string
}

function leer(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === ''
}

function anschriftUnvollstaendig(p: CiiParty): boolean {
  // BR-09 und BR-11 verlangen den Ländercode, nicht nur Ort und
  // Postleitzahl. Er fehlt in der Praxis genau dort, wo er zählt: beim
  // Gast aus dem Ausland, der von Hand angelegt wurde.
  return leer(p.postalCode) || leer(p.city) || leer(p.country)
}

/**
 * Prüft, ob die Rechnung die Geschäftsregeln von EN 16931 erfüllt.
 *
 * **Warum das nicht dieselbe Prüfung wie § 14 UStG ist.** Beide prüfen
 * eine Rechnung, aber gegen verschiedene Maßstäbe, und an zwei Stellen
 * gehen sie auseinander:
 *
 * - Die Norm kennt **keine Kleinbetragsrechnung**. § 33 UStDV erlaubt bis
 *   250 Euro brutto den Verzicht auf den Empfänger; BR-07 und BR-10 tun
 *   das nicht. Die Laufkundschaft an der Bar bekommt deshalb ein PDF ohne
 *   XML, und das ist richtig so: die Pflicht zur elektronischen Rechnung
 *   trifft den B2B-Umsatz, nicht den Bon über zwei Bier.
 * - Die Steuernummer genügt der Norm **nicht**. § 14 Abs. 4 Nr. 2 UStG
 *   lässt Steuernummer oder USt-IdNr. genügen, BR-CO-26 verlangt eine
 *   Kennung des Verkäufers (BT-29, BT-30 oder BT-31); die Steuernummer
 *   (BT-32) ist keine davon. Ein Haus, das nur eine Steuernummer
 *   hinterlegt hat, kann Papierrechnungen stellen, aber keine ZUGFeRD-
 *   Rechnung. Das ist eine Lücke in den Stammdaten und muss dort auffallen.
 *
 * Leer heißt: dieses Dokument darf das XML tragen.
 */
export function ciiFindings(inv: CiiInvoice): CiiFinding[] {
  const f: CiiFinding[] = []
  const add = (key: CiiFinding['key'], rule: string, de: string): void => {
    f.push({ key, rule, de })
  }

  if (leer(inv.seller.name)) {
    add('seller_name', 'BR-06', 'Name des Ausstellers fehlt.')
  }
  if (anschriftUnvollstaendig(inv.seller)) {
    add('seller_address', 'BR-08, BR-09',
      'Anschrift des Ausstellers ist unvollstaendig. '
      + 'Postleitzahl, Ort und Laendercode sind noetig.')
  }
  if (leer(inv.seller.vatId)) {
    add('seller_identifier', 'BR-CO-26',
      'Dem Haus fehlt die Umsatzsteuer-Identifikationsnummer. '
      + 'Die Steuernummer genuegt der Norm nicht; ohne USt-IdNr. traegt die '
      + 'Rechnung kein XML.')
  }
  if (leer(inv.buyer.name)) {
    add('buyer_name', 'BR-07',
      'Name des Empfaengers fehlt. Die Norm kennt keine '
      + 'Kleinbetragsrechnung ohne Empfaenger.')
  }
  if (anschriftUnvollstaendig(inv.buyer)) {
    add('buyer_address', 'BR-10, BR-11',
      'Anschrift des Empfaengers ist unvollstaendig. '
      + 'Postleitzahl, Ort und Laendercode sind noetig.')
  }
  if (inv.lines.length === 0) {
    add('lines', 'BR-16', 'Die Rechnung enthaelt keine Position.')
  }
  if (leer(inv.currency)) {
    add('currency', 'BR-05', 'Waehrung fehlt.')
  }
  return f
}

/**
 * Baut das CII-XML nach EN 16931.
 *
 * Abgedeckt sind die Pflichtfelder des Profils, soweit sie in einer
 * Beherbergungsrechnung vorkommen: BT-1 bis BT-5, BT-22, BT-24, BT-27 bis
 * BT-40, BT-44 bis BT-55, BT-72 bis BT-74, BT-106 bis BT-120, BT-126 bis
 * BT-131 und BT-146 bis BT-153. Nicht belegt sind die Gruppen, die dieses
 * System nicht kennt: Bestellbezug, Lieferadresse, Zahlungsanweisung,
 * Nachlaesse auf Dokumentebene.
 *
 * Aufzurufen erst, wenn `ciiFindings` leer ist. Diese Funktion gibt aus,
 * was da ist, und erfindet nichts; sie ist kein zweiter Prüfer.
 */
export function buildInvoiceCii(inv: CiiInvoice): string {
  const totals = ciiTotals(inv)
  const prepaid = inv.prepaidCent ?? 0

  const hinweise = [
    ...(inv.reverseCharge === true ? [REVERSE_CHARGE_NOTE] : []),
    ...(inv.notes ?? [])
  ]

  const positionen = inv.lines.map((l, i) => el('ram:IncludedSupplyChainTradeLineItem',
    el('ram:AssociatedDocumentLineDocument', leaf('ram:LineID', String(i + 1))),
    el('ram:SpecifiedTradeProduct', leaf('ram:Name', l.name)),
    el('ram:SpecifiedLineTradeAgreement',
      el('ram:NetPriceProductTradePrice',
        leaf('ram:ChargeAmount', unitPrice(l.netCent, l.quantity)))),
    el('ram:SpecifiedLineTradeDelivery',
      leaf('ram:BilledQuantity',
        String(l.netCent < 0 ? -Math.abs(l.quantity) : l.quantity),
        { unitCode: l.unitCode ?? 'C62' })),
    el('ram:SpecifiedLineTradeSettlement',
      el('ram:ApplicableTradeTax',
        leaf('ram:TypeCode', 'VAT'),
        leaf('ram:CategoryCode', categoryOf(inv, l.rateBp)),
        leaf('ram:RateApplicablePercent', percent(l.rateBp))),
      el('ram:SpecifiedTradeSettlementLineMonetarySummation',
        leaf('ram:LineTotalAmount', amount(l.netCent))))))

  const steuergruppen = totals.groups.map(g => {
    const kategorie = categoryOf(inv, g.rateBp)
    const grund = exemptionReasonFor(inv, kategorie)
    return el('ram:ApplicableTradeTax',
      leaf('ram:CalculatedAmount', amount(g.taxCent)),
      leaf('ram:TypeCode', 'VAT'),
      grund ? leaf('ram:ExemptionReason', grund) : null,
      leaf('ram:BasisAmount', amount(g.netCent)),
      leaf('ram:CategoryCode', kategorie),
      leaf('ram:RateApplicablePercent', percent(g.rateBp)))
  })

  const dokument: XmlNode = {
    name: 'rsm:CrossIndustryInvoice',
    attrs: {
      'xmlns:rsm': NS.rsm, 'xmlns:ram': NS.ram,
      'xmlns:qdt': NS.qdt, 'xmlns:udt': NS.udt
    },
    children: [
      el('rsm:ExchangedDocumentContext',
        el('ram:GuidelineSpecifiedDocumentContextParameter',
          leaf('ram:ID', EN16931_GUIDELINE))),
      el('rsm:ExchangedDocument',
        leaf('ram:ID', inv.number),
        leaf('ram:TypeCode', documentTypeCode(inv.kind)),
        dateNode('ram:IssueDateTime', inv.issuedOn),
        ...hinweise.map(h => el('ram:IncludedNote', leaf('ram:Content', h)))),
      el('rsm:SupplyChainTradeTransaction',
        ...positionen,
        el('ram:ApplicableHeaderTradeAgreement',
          partyNode('ram:SellerTradeParty', inv.seller, { taxNumber: true }),
          partyNode('ram:BuyerTradeParty', inv.buyer, { taxNumber: false })),
        el('ram:ApplicableHeaderTradeDelivery',
          // BT-72. Bei Beherbergung ist die Leistung mit der letzten
          // abgerechneten Nacht erbracht.
          el('ram:ActualDeliverySupplyChainEvent',
            dateNode('ram:OccurrenceDateTime', inv.serviceTo))),
        el('ram:ApplicableHeaderTradeSettlement',
          leaf('ram:InvoiceCurrencyCode', inv.currency),
          ...steuergruppen,
          // BT-73 und BT-74. Der Leistungszeitraum nach § 14 Abs. 4 Nr. 6
          // UStG ist der Aufenthalt, nicht das Rechnungsdatum.
          el('ram:BillingSpecifiedPeriod',
            dateNode('ram:StartDateTime', inv.serviceFrom),
            dateNode('ram:EndDateTime', inv.serviceTo)),
          el('ram:SpecifiedTradeSettlementHeaderMonetarySummation',
            leaf('ram:LineTotalAmount', amount(totals.netCent)),
            leaf('ram:TaxBasisTotalAmount', amount(totals.netCent)),
            leaf('ram:TaxTotalAmount', amount(totals.taxCent), { currencyID: inv.currency }),
            leaf('ram:GrandTotalAmount', amount(totals.grossCent)),
            leaf('ram:TotalPrepaidAmount', amount(prepaid)),
            leaf('ram:DuePayableAmount', amount(totals.grossCent - prepaid)))))
    ]
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(dokument)}\n`
}
