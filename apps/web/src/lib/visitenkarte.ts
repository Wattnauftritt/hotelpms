/**
 * Aus dem Text einer Visitenkarte eine Firmenanschrift vorschlagen.
 *
 * **Ein Vorschlag, kein Ergebnis.** Die Texterkennung liest ein Foto aus der
 * Hand, und eine Visitenkarte hat keine feste Ordnung: Name oben oder unten,
 * Anschrift in einer Zeile oder in dreien, Vorder- und Rueckseite verteilt.
 * Was hier herauskommt, sieht die Rezeption deshalb erst als Vorschlag und
 * bestaetigt oder korrigiert ihn; gespeichert wird nur, was sie danach
 * ausdruecklich speichert. Ein Feld, das hier nicht sicher zu finden ist,
 * bleibt leer -- ein leeres Feld faellt auf, ein falsch gefuelltes nicht.
 *
 * **Reine Funktion, ohne Texterkennung.** Die Erkennung (`texterkennung.ts`)
 * liefert Zeilen mit ihrer Hoehe; was davon Firma, Strasse und Ort ist,
 * entscheidet allein diese Datei, damit es sich ohne Kamera pruefen laesst.
 */

/** Eine erkannte Zeile und ihre Hoehe relativ zur mittleren Zeile ihrer Seite. */
export interface KartenZeile {
  text: string
  /** 1 = so hoch wie die mittlere Zeile der Seite; der Firmenname ist oft groesser. */
  hoehe: number
}

export interface AnschriftVorschlag {
  name: string
  addressLine1: string
  postalCode: string
  city: string
  /** ISO 3166-1 alpha-2, leer wenn die Karte es nicht verraet. */
  country: string
  vatId: string
}

/**
 * Rechtsformen, an denen eine Zeile als Firmenname zu erkennen ist. Wortgrenzen
 * statt Teilzeichenketten: "AG" steckt sonst in jedem "TAG" und "AB" in "ABC".
 */
const RECHTSFORM = new RegExp(
  '(?:^|[\\s,&(])(?:GmbH|gGmbH|mbH|AG|KG|KGaA|OHG|GbR|UG|PartG|e\\.\\s?K\\.|e\\.\\s?Kfm\\.|e\\.\\s?V\\.|SE'
  + '|Ltd\\.?|Limited|Inc\\.?|LLC|Corp\\.?|PLC|B\\.\\s?V\\.|N\\.\\s?V\\.|S\\.\\s?A\\.?|SAS|SARL|S\\.\\s?r\\.\\s?l\\.'
  + '|S\\.\\s?p\\.\\s?A\\.|ApS|A/S|AS|AB|Oy|Sp\\.\\s?z\\s?o\\.\\s?o\\.|s\\.\\s?r\\.\\s?o\\.|Kft\\.?)(?=$|[\\s,.)])',
  'i')

/** Strassenwoerter, auch als Wortende ("Hafenstrasse", "Am Deich"). */
const STRASSE = /(stra(ss|ß)e|str\.|weg\b|platz\b|allee\b|ring\b|damm\b|gasse\b|ufer\b|chaussee\b|deich\b|kai\b|markt\b|steig\b|pfad\b|berg\b|hof\b|park\b|street\b|st\.|road\b|rd\.|avenue\b|ave\.|lane\b|straat\b|laan\b|weg\b|gade\b|vej\b|v[aä]gen\b|gatan\b|rue\b|via\b|calle\b|ulica\b|ul\.)/i

/** Hausnummer am Ende: "12", "12a", "12-14", "12 / 3". */
const HAUSNUMMER = /\d+\s?[a-zA-Z]?(\s?[-/]\s?\d+\s?[a-zA-Z]?)?$/

const KONTAKT = /(@|www\.|https?:|\.(de|com|eu|net|org|at|ch|nl|dk)\b|\b(tel|telefon|telephone|fon|phone|fax|telefax|mobil|mobile|handy|cell|e-?mail)\b)/i

/** Woerter, an denen das Land zu erkennen ist, wenn die Postleitzahl es nicht sagt. */
const LAENDER: ReadonlyArray<[RegExp, string]> = [
  [/\b(deutschland|germany|allemagne)\b/i, 'DE'],
  [/\b(österreich|oesterreich|austria|autriche)\b/i, 'AT'],
  [/\b(schweiz|switzerland|suisse|svizzera)\b/i, 'CH'],
  [/\b(nederland|netherlands|niederlande|holland)\b/i, 'NL'],
  [/\b(danmark|denmark|dänemark|daenemark)\b/i, 'DK'],
  [/\b(belgien|belgium|belgique|belgië|belgie)\b/i, 'BE'],
  [/\b(luxemburg|luxembourg)\b/i, 'LU'],
  [/\b(frankreich|france)\b/i, 'FR'],
  [/\b(polen|poland|polska)\b/i, 'PL'],
  [/\b(sverige|sweden|schweden)\b/i, 'SE'],
  [/\b(norge|norway|norwegen)\b/i, 'NO'],
  [/\b(united kingdom|great britain|england|großbritannien|grossbritannien)\b/i, 'GB']
]

/** Laenderkennung vor der Postleitzahl: "D-27472", "A-1010", "CH-8001". */
const PLZ_PRAEFIX: Readonly<Record<string, string>> = {
  D: 'DE', DE: 'DE', A: 'AT', AT: 'AT', CH: 'CH', DK: 'DK', NL: 'NL',
  B: 'BE', BE: 'BE', L: 'LU', LU: 'LU', F: 'FR', FR: 'FR', PL: 'PL', S: 'SE', SE: 'SE', N: 'NO', NO: 'NO'
}

const ORT = "\\p{L}[\\p{L}\\p{M} .'()/-]*\\p{L}\\.?\\)?"
/** "27472 Cuxhaven", "D-27472 Cuxhaven", "A-1010 Wien". */
const PLZ_ORT = new RegExp(`^(?:([A-Z]{1,2})\\s?[-‐–]\\s?)?(\\d{4,5})\\s+(${ORT})$`, 'u')
/** Niederlande: "1012 AB Amsterdam". */
const PLZ_ORT_NL = new RegExp(`^(?:NL\\s?[-‐–]\\s?)?(\\d{4})\\s?([A-Z]{2})\\s+(${ORT})$`, 'u')

function bereinigen(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Eine Zeile in ihre Abschnitte. Visitenkarten setzen die ganze Anschrift
 * gern in eine Zeile, getrennt durch Komma, Punkt in der Mitte oder Strich.
 */
function abschnitte(zeile: string): string[] {
  return zeile.split(/\s*[,|•·]\s*|\s+[-–]\s+/).map(bereinigen).filter(s => s !== '')
}

/** Steht in der Zeile nichts als Rechtsform und Bindewort ("GmbH & Co. KG")? */
function nurRechtsform(zeile: string): boolean {
  const global = new RegExp(RECHTSFORM.source, 'gi')
  const rest = zeile.replace(global, ' ').replace(/&|\+|\bund\b|\bCo\b\.?/gi, ' ')
  return !/\p{L}{2}/u.test(rest)
}

function landAusText(text: string): string {
  for (const [muster, land] of LAENDER) if (muster.test(text)) return land
  return ''
}

/** Ein Landesname hinter dem Ort gehoert nicht zum Ort. */
function ortOhneLand(ort: string): string {
  let o = ort
  for (const [muster] of LAENDER) o = o.replace(muster, '')
  return o.replace(/[\s,/-]+$/, '').trim()
}

function istStrasse(s: string): boolean {
  if (KONTAKT.test(s) || !/\p{L}{2}/u.test(s)) return false
  if (/^postfach\b|^p\.?\s?o\.?\s?box\b/i.test(s)) return true
  // Hausnummer am Ende reicht allein nicht: "Fax 04721 12345" endet auch so.
  return (HAUSNUMMER.test(s) && /^\p{L}/u.test(s)) || (STRASSE.test(s) && /\d/.test(s))
}

function ustId(text: string): string {
  // Erst die beschriftete Nummer, dann die deutsche ohne Beschriftung.
  const beschriftet = /(?:USt\.?\s?-?\s?Id(?:ent)?\.?\s?-?\s?Nr\.?|UID(?:-?Nr\.?)?|VAT(?:\s?(?:ID|No\.?|Reg\.?))?|BTW(?:-?nr\.?)?|CVR|MwSt\.?-?Nr\.?)\s*[:.]?\s*([A-Z]{2}[A-Z0-9 .]{7,16})/i
    .exec(text)
  const roh = beschriftet?.[1] ?? /\b(DE\s?\d{3}\s?\d{3}\s?\d{3})\b/.exec(text)?.[1]
  if (roh === undefined) return ''
  return roh.replace(/[\s.]/g, '').toUpperCase()
}

/**
 * Den Vorschlag aus den Zeilen aller fotografierten Seiten.
 *
 * Die Seiten kommen hintereinander: steht der Name vorn und die Anschrift
 * hinten, findet sich beides trotzdem.
 */
export function anschriftAusKarte(zeilen: readonly KartenZeile[]): AnschriftVorschlag {
  const klar = zeilen
    .map(z => ({ text: bereinigen(z.text), hoehe: z.hoehe }))
    .filter(z => z.text.length >= 2)
  const ganzerText = klar.map(z => z.text).join('\n')

  let postalCode = ''
  let city = ''
  let country = ''
  let addressLine1 = ''
  const verbraucht = new Set<number>()

  suche: for (let i = 0; i < klar.length; i++) {
    const teile = abschnitte(klar[i]!.text)
    for (let j = 0; j < teile.length; j++) {
      const t = teile[j]!
      if (KONTAKT.test(t)) continue
      const nl = PLZ_ORT_NL.exec(t)
      const de = nl === null ? PLZ_ORT.exec(t) : null
      if (nl === null && de === null) continue
      if (nl !== null) {
        postalCode = `${nl[1]} ${nl[2]}`
        city = ortOhneLand(nl[3]!)
        country = 'NL'
      } else {
        postalCode = de![2]!
        city = ortOhneLand(de![3]!)
        const praefix = de![1]
        country = praefix !== undefined ? (PLZ_PRAEFIX[praefix] ?? '') : ''
        if (country === '' && postalCode.length === 5) country = 'DE'
      }
      verbraucht.add(i)
      // Die Strasse steht davor: im selben Abschnittszug oder eine Zeile hoeher.
      const davor = teile.slice(0, j).reverse().find(istStrasse)
      if (davor !== undefined) {
        addressLine1 = davor
      } else if (i > 0 && istStrasse(klar[i - 1]!.text)) {
        addressLine1 = klar[i - 1]!.text
        verbraucht.add(i - 1)
      }
      break suche
    }
  }
  if (addressLine1 === '') {
    // Ohne Ortszeile oder mit Strasse an anderer Stelle: die erste Zeile,
    // die nach Strasse aussieht.
    for (let i = 0; i < klar.length; i++) {
      const treffer = abschnitte(klar[i]!.text).find(istStrasse)
      if (treffer !== undefined) {
        addressLine1 = treffer
        verbraucht.add(i)
        break
      }
    }
  }

  const textLand = landAusText(ganzerText)
  if (textLand !== '') country = textLand
  const vatId = ustId(ganzerText)
  if (country === '' && /^[A-Z]{2}/.test(vatId)) {
    const kennung = vatId.slice(0, 2)
    // Griechenland fuehrt "EL" statt "GR" in der USt-IdNr.
    country = kennung === 'EL' ? 'GR' : kennung
  }

  // Der Name: zuerst eine Zeile mit Rechtsform, sonst die groesste Zeile,
  // die weder Kontakt noch Anschrift noch Nummer ist.
  const kandidaten = klar.filter((z, i) => !verbraucht.has(i)
    && !KONTAKT.test(z.text) && !istStrasse(z.text)
    && !/\d{4,}/.test(z.text) && /\p{L}{2}/u.test(z.text)
    && !/^(USt|UID|VAT|BTW|Steuer|HRB|HRA|Amtsgericht|Gesch[aä]ftsf[uü]hr)/i.test(z.text))
  const mitForm = kandidaten.find(z => RECHTSFORM.test(z.text))
  const groesste = [...kandidaten].sort((a, b) => b.hoehe - a.hoehe)[0]
  let name = (mitForm ?? groesste)?.text ?? ''
  if (mitForm !== undefined && nurRechtsform(mitForm.text)) {
    // "KÜSTENBAU" gross, darunter klein "GmbH & Co. KG": die Rechtsform
    // allein ist kein Name, sie gehoert an die Zeile darueber.
    const davor = kandidaten[kandidaten.indexOf(mitForm) - 1]
    if (davor !== undefined) name = `${davor.text} ${mitForm.text}`
  }

  return { name, addressLine1, postalCode, city, country, vatId }
}

/**
 * Den Vorschlag einer weiteren Seite einarbeiten, ohne zu ueberschreiben,
 * was schon dasteht: was die Rezeption nach der Vorderseite korrigiert hat,
 * soll die Rueckseite nicht wieder zuruecksetzen.
 */
export function vorschlagErgaenzen(bisher: AnschriftVorschlag,
                                   neu: AnschriftVorschlag): AnschriftVorschlag {
  const fuellen = (a: string, b: string): string => (a.trim() !== '' ? a : b)
  return {
    name: fuellen(bisher.name, neu.name),
    addressLine1: fuellen(bisher.addressLine1, neu.addressLine1),
    postalCode: fuellen(bisher.postalCode, neu.postalCode),
    city: fuellen(bisher.city, neu.city),
    country: fuellen(bisher.country, neu.country),
    vatId: fuellen(bisher.vatId, neu.vatId)
  }
}
