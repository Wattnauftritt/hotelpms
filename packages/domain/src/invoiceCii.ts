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
  /**
   * BT-30, Handelsregisternummer. Genuegt BR-CO-26 wie die USt-IdNr.; ein
   * Haus in der Rechtsform einer GmbH hat sie immer, eine USt-IdNr. nicht
   * unbedingt.
   */
  registrationId?: string | null
  /** BT-34 beim Aussteller, BT-49 beim Empfänger: elektronische Adresse, hier eine Mailadresse. */
  electronicAddress?: string | null
  /**
   * BG-6, Kontakt beim Aussteller: BT-41 Ansprechpartner, BT-42 Telefon,
   * BT-43 Mail. Beim Erwerber BT-56, nur der Name (0171).
   */
  contactName?: string | null
  phone?: string | null
  email?: string | null
}

/** BG-16 und BG-17: Zahlungsanweisung per Ueberweisung. */
export interface CiiPayee {
  /** BT-84. */
  iban: string
  /** BT-86. */
  bic?: string | null
  /** BT-85, Kontoinhaber. */
  accountName?: string | null
  /** Nur fuers Blatt; das XML kennt die Bank ueber die BIC. */
  bankName?: string | null
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
  /**
   * BT-9, Faelligkeit. Ohne sie gilt "zahlbar sofort" (BT-20); eine von
   * beiden verlangt BR-CO-25, sobald etwas offen ist (Migration 0159).
   */
  dueOn?: IsoDate | null
  /**
   * BT-114, Rundungsbetrag auf Belegebene.
   *
   * Die Norm rechnet die Steuer je Satzgruppe aus der Nettosumme (BR-CO-14).
   * Damit sind nicht alle Bruttobetraege darstellbar: zu 7 Prozent liegt zu
   * jedem sechzehnten Cent-Betrag kein ganzzahliges Netto, zu 19 Prozent zu
   * jedem sechsten. Ein Kassenbeleg ueber glatte 250,00 zu 7 Prozent ergibt
   * 233,64 + 16,35 = 249,99; der naechste darstellbare Betrag ist 250,01.
   *
   * Fuer genau diesen Fall kennt EN 16931 den Rundungsbetrag: er beruehrt
   * weder die Satzgruppen noch die Gesamtsumme (BT-112), sondern nur den
   * Zahlbetrag (BT-115) ueber BR-CO-16. So bleibt die Steuer normgerecht
   * gerechnet und der geforderte Betrag trifft trotzdem, was die Positionen
   * zusammen ergeben.
   */
  roundingCent?: Cent
  /**
   * Korrektur der Steuer je Satz um hoechstens einen Cent, Schluessel ist der
   * Satz in Basispunkten (`taxAdjustToGross`). Damit trifft die Gruppe ein
   * Brutto, zu dem es kein Netto gibt; BR-S-09 laesst die Einheit zu.
   */
  taxAdjustCent?: Record<string, Cent>
  /** § 13b UStG. Setzt die Kategorie aller Positionen auf AE. */
  reverseCharge?: boolean
  /** BT-120. Pflicht, sobald eine Kategorie ohne Steuer vorkommt. */
  exemptionReason?: string | null
  /** BT-22, freie Hinweise. Der § 13b-Hinweis kommt von selbst dazu. */
  notes?: string[]
  /**
   * BT-25 und BT-26: die Rechnung, die eine Stornorechnung aufhebt. Ohne
   * Bezug ist eine Stornorechnung nach § 14c UStG keine Berichtigung,
   * sondern ein zweiter Beleg.
   */
  precedingInvoice?: { number: string; issuedOn: IsoDate } | null
  /**
   * BT-10, Leitweg-ID eines oeffentlichen Auftraggebers. Mit ihr wird das
   * XML eine XRechnung (BT-24), weil die Eingangsplattformen von Bund und
   * Laendern ZUGFeRD nur in diesem Profil annehmen; dazu gehoeren die
   * strengeren Regeln BR-DE-*, die `ciiFindings` dann mit prueft.
   */
  buyerReference?: string | null
  /** BG-16, Bankverbindung des Hauses. Ohne sie keine Zahlungsanweisung im XML. */
  payee?: CiiPayee | null
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

/** BT-24 der XRechnung 3.0, als CIUS von EN 16931. */
export const XRECHNUNG_GUIDELINE =
  'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0'

/** BT-23, den die XRechnung 3.0 verlangt. */
export const XRECHNUNG_PROCESS = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'

/** Gilt die strengere XRechnung? Genau dann, wenn eine Leitweg-ID dasteht. */
export function isXRechnung(inv: Pick<CiiInvoice, 'buyerReference'>): boolean {
  return !leer(inv.buyerReference)
}

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
  // Reihenfolge nach der XSD-Sequenz von TradeParty: Name,
  // SpecifiedLegalOrganization, DefinedTradeContact, PostalTradeAddress,
  // URIUniversalCommunication, SpecifiedTaxRegistration.
  // Beim Erwerber nur der Name (BT-56, "z. Hd."); Telefon und Mail einer
  // Person dort fuehren wir nicht.
  const kontakt = opts.taxNumber && (p.contactName || p.phone || p.email)
    ? el('ram:DefinedTradeContact',
        p.contactName ? leaf('ram:PersonName', p.contactName) : null,
        p.phone ? el('ram:TelephoneUniversalCommunication',
          leaf('ram:CompleteNumber', p.phone)) : null,
        p.email ? el('ram:EmailURIUniversalCommunication', leaf('ram:URIID', p.email)) : null)
    : !opts.taxNumber && p.contactName
      ? el('ram:DefinedTradeContact', leaf('ram:PersonName', p.contactName))
      : null
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
    p.registrationId ? el('ram:SpecifiedLegalOrganization',
      leaf('ram:ID', p.registrationId)) : null,
    kontakt,
    anschrift,
    // EM: die Adresse ist eine Mailadresse (EAS-Codeliste).
    p.electronicAddress ? el('ram:URIUniversalCommunication',
      leaf('ram:URIID', p.electronicAddress, { schemeID: 'EM' })) : null,
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
  return sumInvoice(inv.lines.map(l => ({ netCent: l.netCent, rateBp: l.rateBp })),
                    inv.taxAdjustCent)
}

export interface CiiFinding {
  key: 'seller_name' | 'seller_address' | 'seller_identifier'
     | 'buyer_name' | 'buyer_address' | 'lines' | 'currency'
     | 'xrechnung_contact' | 'xrechnung_payment' | 'xrechnung_seller_address'
     | 'xrechnung_buyer_address' | 'xrechnung_tax_id'
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
  if (leer(inv.seller.vatId) && leer(inv.seller.registrationId)) {
    add('seller_identifier', 'BR-CO-26',
      'Dem Haus fehlen USt-IdNr. und Handelsregisternummer. '
      + 'Die Steuernummer genuegt der Norm nicht; ohne eines von beiden traegt die '
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

  /*
   * XRechnung: mit Leitweg-ID gelten die Regeln der CIUS zusaetzlich. Ein
   * Beleg, der an einer davon scheitert, wird von der Eingangsplattform
   * zurueckgewiesen -- erst dort und Tage spaeter, wenn niemand mehr an
   * die Rechnung denkt. Hier faellt es beim Ausstellen auf.
   */
  if (isXRechnung(inv)) {
    if (leer(inv.seller.contactName) || leer(inv.seller.phone) || leer(inv.seller.email)) {
      add('xrechnung_contact', 'BR-DE-2, BR-DE-5, BR-DE-6, BR-DE-7',
        'Fuer eine XRechnung braucht das Haus Ansprechpartner, Telefon und Mailadresse '
        + 'fuer Rechnungen.')
    }
    if (inv.payee === null || inv.payee === undefined || leer(inv.payee.iban)) {
      add('xrechnung_payment', 'BR-DE-1',
        'Fuer eine XRechnung braucht das Haus eine Bankverbindung (IBAN).')
    }
    if (leer(inv.seller.electronicAddress)) {
      add('xrechnung_seller_address', 'BT-34',
        'Fuer eine XRechnung braucht das Haus eine Mailadresse fuer Rechnungen.')
    }
    if (leer(inv.buyer.electronicAddress)) {
      add('xrechnung_buyer_address', 'BT-49',
        'Fuer eine XRechnung braucht die Firma eine Rechnungsmailadresse.')
    }
    if (leer(inv.seller.vatId) && leer(inv.seller.taxNumber)) {
      add('xrechnung_tax_id', 'BR-DE-16',
        'Fuer eine XRechnung braucht das Haus USt-IdNr. oder Steuernummer.')
    }
  }
  return f
}

/**
 * Zahlungsbedingung (BT-20) als Satz, oder `null`, wenn nichts offen ist.
 *
 * BR-CO-25 verlangt Faelligkeit oder Bedingung, sobald der Zahlbetrag
 * positiv ist. Ohne beides wies der Validator jede Rechnung mit offenem
 * Betrag ab (Pruefung 13.10.2026, Befund 4). Eine bezahlte Rechnung
 * bekommt keine Bedingung: "zahlbar bis" ueber null Euro liest ein Gast als
 * Mahnung.
 */
export function paymentTermsText(inv: CiiInvoice): string | null {
  const offen = ciiTotals(inv).grossCent - (inv.prepaidCent ?? 0) + (inv.roundingCent ?? 0)
  if (offen <= 0 || inv.kind === 'credit_note') return null
  if (!inv.dueOn) return 'Zahlbar sofort ohne Abzug.'
  const [j, m, t] = inv.dueOn.split('-')
  return `Zahlbar ohne Abzug bis ${t}.${m}.${j}.`
}

/**
 * Eine Stornorechnung mit positiven Betraegen.
 *
 * Im System traegt sie die Gegenbuchungen, also negative Betraege: so
 * stimmen Folio, DATEV-Stapel und Blatt ohne Sonderfall. Typ 381 aber ist
 * eine Gutschrift, und die Norm liest die Richtung aus dem Typ -- negative
 * Betraege darin drehten sie ein zweites Mal. Gedreht wird deshalb genau
 * hier und nirgends sonst.
 */
function alsGutschrift(inv: CiiInvoice): CiiInvoice {
  if (inv.kind !== 'credit_note') return inv
  return {
    ...inv,
    // Die Menge bleibt: ihr Vorzeichen folgt im XML dem Betrag (BR-27).
    lines: inv.lines.map(l => ({ ...l, netCent: -l.netCent })),
    prepaidCent: -(inv.prepaidCent ?? 0),
    roundingCent: -(inv.roundingCent ?? 0),
    ...(inv.taxAdjustCent === undefined ? {} : { taxAdjustCent: Object.fromEntries(
      Object.entries(inv.taxAdjustCent).map(([k, v]) => [k, -v])) })
  }
}

/**
 * Baut das CII-XML nach EN 16931.
 *
 * Abgedeckt sind die Pflichtfelder des Profils, soweit sie in einer
 * Beherbergungsrechnung vorkommen: BT-1 bis BT-5, BT-22, BT-24, BT-27 bis
 * BT-40, BT-44 bis BT-55, BT-72 bis BT-74, BT-106 bis BT-120, BT-126 bis
 * BT-131 und BT-146 bis BT-153. Nicht belegt sind die Gruppen, die dieses
 * System nicht kennt: Bestellbezug, Lieferadresse, Nachlaesse auf
 * Dokumentebene. Kontakt, Bankverbindung und Leitweg-ID stehen da, wo das
 * Haus sie hinterlegt hat.
 *
 * Aufzurufen erst, wenn `ciiFindings` leer ist. Diese Funktion gibt aus,
 * was da ist, und erfindet nichts; sie ist kein zweiter Prüfer.
 */
export function buildInvoiceCii(beleg: CiiInvoice): string {
  const inv = alsGutschrift(beleg)
  const totals = ciiTotals(inv)
  const prepaid = inv.prepaidCent ?? 0
  const rundung = inv.roundingCent ?? 0
  /*
   * Eine Gutschrift traegt nach dem Drehen einen positiven Zahlbetrag, und
   * BR-CO-25 verlangt dann eine Bedingung. Ohne sie wies der Validator jede
   * Stornorechnung ab; aufgefallen ist es erst, als die Beispielbelege in
   * CI gegen das Schematron liefen. Die Bedingung sagt, was mit dem Betrag
   * geschieht -- gezahlt wird an den Kunden, nicht vom Kunden.
   */
  const bedingung = inv.kind === 'credit_note'
    ? (totals.grossCent - prepaid + rundung > 0
        ? (inv.precedingInvoice
            ? `Wird mit Rechnung ${inv.precedingInvoice.number} verrechnet oder erstattet.`
            : 'Wird verrechnet oder erstattet.')
        : null)
    : paymentTermsText(inv)
  const xrechnung = isXRechnung(inv)
  // Die Bankverbindung nur, wo etwas zu ueberweisen ist: auf einer
  // Gutschrift oder einer bezahlten Rechnung laese ein Kunde sie als
  // Zahlungsaufforderung. Die XRechnung verlangt sie immer (BR-DE-1).
  const zahlung = inv.payee && inv.payee.iban
    && (xrechnung || (bedingung !== null && inv.kind !== 'credit_note')) ? inv.payee : null

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
        xrechnung ? el('ram:BusinessProcessSpecifiedDocumentContextParameter',
          leaf('ram:ID', XRECHNUNG_PROCESS)) : null,
        el('ram:GuidelineSpecifiedDocumentContextParameter',
          leaf('ram:ID', xrechnung ? XRECHNUNG_GUIDELINE : EN16931_GUIDELINE))),
      el('rsm:ExchangedDocument',
        leaf('ram:ID', inv.number),
        leaf('ram:TypeCode', documentTypeCode(inv.kind)),
        dateNode('ram:IssueDateTime', inv.issuedOn),
        ...hinweise.map(h => el('ram:IncludedNote', leaf('ram:Content', h)))),
      el('rsm:SupplyChainTradeTransaction',
        ...positionen,
        el('ram:ApplicableHeaderTradeAgreement',
          // BT-10 steht in der XSD-Sequenz vor den Beteiligten.
          inv.buyerReference ? leaf('ram:BuyerReference', inv.buyerReference) : null,
          partyNode('ram:SellerTradeParty', inv.seller, { taxNumber: true }),
          partyNode('ram:BuyerTradeParty', inv.buyer, { taxNumber: false })),
        el('ram:ApplicableHeaderTradeDelivery',
          // BT-72. Bei Beherbergung ist die Leistung mit der letzten
          // abgerechneten Nacht erbracht.
          el('ram:ActualDeliverySupplyChainEvent',
            dateNode('ram:OccurrenceDateTime', inv.serviceTo))),
        el('ram:ApplicableHeaderTradeSettlement',
          // BT-83: mit der Rechnungsnummer als Verwendungszweck findet die
          // Buchhaltung die Ueberweisung ohne Nachfrage.
          zahlung ? leaf('ram:PaymentReference', inv.number) : null,
          leaf('ram:InvoiceCurrencyCode', inv.currency),
          // BG-16, in der XSD-Sequenz vor den Steuergruppen. 58 ist die
          // SEPA-Ueberweisung (UNTDID 4461).
          zahlung ? el('ram:SpecifiedTradeSettlementPaymentMeans',
            leaf('ram:TypeCode', '58'),
            el('ram:PayeePartyCreditorFinancialAccount',
              leaf('ram:IBANID', zahlung.iban),
              zahlung.accountName ? leaf('ram:AccountName', zahlung.accountName) : null),
            zahlung.bic ? el('ram:PayeeSpecifiedCreditorFinancialInstitution',
              leaf('ram:BICID', zahlung.bic)) : null) : null,
          ...steuergruppen,
          // BT-73 und BT-74. Der Leistungszeitraum nach § 14 Abs. 4 Nr. 6
          // UStG ist der Aufenthalt, nicht das Rechnungsdatum.
          el('ram:BillingSpecifiedPeriod',
            dateNode('ram:StartDateTime', inv.serviceFrom),
            dateNode('ram:EndDateTime', inv.serviceTo)),
          // BT-20 und BT-9. In der XSD-Sequenz nach dem Zeitraum und vor
          // den Summen.
          bedingung === null ? null : el('ram:SpecifiedTradePaymentTerms',
            leaf('ram:Description', bedingung),
            inv.dueOn ? dateNode('ram:DueDateDateTime', inv.dueOn) : null),
          el('ram:SpecifiedTradeSettlementHeaderMonetarySummation',
            leaf('ram:LineTotalAmount', amount(totals.netCent)),
            leaf('ram:TaxBasisTotalAmount', amount(totals.netCent)),
            leaf('ram:TaxTotalAmount', amount(totals.taxCent), { currencyID: inv.currency }),
            // BT-114 vor BT-112: die XSD-Sequenz setzt den Rundungsbetrag vor
            // die Gesamtsumme. Er wird nur ausgegeben, wenn es ihn gibt --
            // ein RoundingAmount ueber 0,00 auf jedem Beleg ist Rauschen, das
            // ein Pruefer erst einmal fuer einen Fehler haelt.
            rundung !== 0 ? leaf('ram:RoundingAmount', amount(rundung)) : null,
            leaf('ram:GrandTotalAmount', amount(totals.grossCent)),
            leaf('ram:TotalPrepaidAmount', amount(prepaid)),
            // BR-CO-16: Zahlbetrag = Gesamtsumme - Anzahlung + Rundung.
            leaf('ram:DuePayableAmount', amount(totals.grossCent - prepaid + rundung))),
          // BT-25 und BT-26, in der XSD-Sequenz nach den Summen.
          inv.precedingInvoice ? el('ram:InvoiceReferencedDocument',
            leaf('ram:IssuerAssignedID', inv.precedingInvoice.number),
            el('ram:FormattedIssueDateTime',
              leaf('qdt:DateTimeString', inv.precedingInvoice.issuedOn.replace(/-/g, ''),
                { format: '102' }))) : null))
    ]
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(dokument)}\n`
}
