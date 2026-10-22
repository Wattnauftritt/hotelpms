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

/**
 * Eine Zeile, wie eine Erkennung sie liefert: Text und senkrechte Lage.
 * Die Einheit ist gleich (Pixel, Anteil der Bildhoehe), solange sie fuer
 * alle Zeilen einer Seite dieselbe ist; gerechnet wird nur im Verhaeltnis.
 */
export interface ErkannteZeile {
  text: string
  /** Oberkante, nach unten wachsend. */
  oben: number
  unten: number
  links: number
}

/**
 * Erkannte Zeilen in Kartenzeilen: Hoehe relativ zur mittleren Zeile der
 * Seite, leere Zeilen weg.
 *
 * `sortieren` fuer Erkennungen, die keine Lesereihenfolge liefern (Apple
 * Vision gibt seine Beobachtungen ungeordnet zurueck): dann von oben nach
 * unten, in einer Hoehe von links nach rechts. Tesseract liefert schon die
 * Reihenfolge seiner Bloecke, und die waere bei zwei Spalten besser als jede
 * Sortierung nach Hoehe.
 */
export function zeilenAusBoxen(roh: readonly ErkannteZeile[],
                               { sortieren }: { sortieren: boolean }): KartenZeile[] {
  const zeilen = roh.filter(z => z.text.trim() !== '' && z.unten > z.oben)
  if (sortieren) {
    zeilen.sort((a, b) => {
      // "Gleiche Hoehe" heisst: die Mitten liegen weniger als eine halbe Zeile auseinander.
      const halbe = Math.min(a.unten - a.oben, b.unten - b.oben) / 2
      const dy = (a.oben + a.unten) / 2 - (b.oben + b.unten) / 2
      return Math.abs(dy) < halbe ? a.links - b.links : dy
    })
  }
  const hoehen = zeilen.map(z => z.unten - z.oben).sort((a, b) => a - b)
  const mitte = hoehen[Math.floor(hoehen.length / 2)] ?? 1
  return zeilen.map(z => ({ text: z.text.trim(), hoehe: (z.unten - z.oben) / mitte }))
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
const STRASSE = /(stra(ss|ß|b)e|str\.|str\b|weg\b|platz\b|allee\b|ring\b|damm\b|gasse\b|ufer\b|chaussee\b|deich\b|kai\b|markt\b|steig\b|pfad\b|berg\b|hof\b|park\b|street\b|st\.|road\b|rd\.|avenue\b|ave\.|lane\b|straat\b|laan\b|weg\b|gade\b|vej\b|v[aä]gen\b|gatan\b|rue\b|via\b|calle\b|ulica\b|ul\.)/i

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

/**
 * Ein Wort des Ortsnamens: "Frankfurt", "am", "Cuxhaven-Döse", "St.".
 * Kleine Woerter sind erlaubt, weil Orte sie tragen ("Frankfurt am Main",
 * "Halle (Saale)").
 */
const ORTWORT = "[\\p{L}][\\p{L}\\p{M}.'()-]*"
/**
 * Postleitzahl und Ort irgendwo in einem Abschnitt, nicht nur am Anfang:
 * die Erkennung des Telefons liefert "Hafenstrasse 12a 27472 Cuxhaven" als
 * eine Zeile ohne das Trennzeichen, das auf der Karte steht.
 *
 * Davor darf keine Ziffer, kein "+", "(" oder "/" stehen, sonst ist es der
 * hintere Teil einer Telefonnummer ("04721 / 12345 Zentrale").
 */
const PLZ_ORT = new RegExp(
  `(?:^|[^\\d+(/\\s])?\\s*(?:\\b([A-Z]{1,2})\\s?[-‐–]\\s?)?(?<![\\d+(/]\\s?)\\b(\\d{5}|\\d{4})\\s+(${ORTWORT}(?:\\s${ORTWORT}){0,3})`,
  'u')
/** Niederlande: "1012 AB Amsterdam". */
const PLZ_ORT_NL = new RegExp(`(?:\\bNL\\s?[-‐–]\\s?)?\\b(\\d{4})\\s?([A-Z]{2})\\s+(${ORTWORT}(?:\\s${ORTWORT}){0,2})`, 'u')

/** Was vor einer Anschrift als Beschriftung steht. */
const BESCHRIFTUNG = /^(anschrift|adresse|address|postanschrift|besucheradresse|hausanschrift|sitz|firmensitz|office)\s*:?\s*/i

/**
 * Woerter, an denen eine Zeile als Berufsbezeichnung zu erkennen ist. Die
 * Zeile darueber oder darunter ist dann der Name eines Menschen, nicht der
 * Firma -- und der steht auf Visitenkarten gern am groessten.
 */
const BERUF = /\b(gesch[aä]ftsf[uü]hr\w*|inhaber\w*|leiter\w*|leitung|vertrieb\w*|verkauf\w*|manager\w*|management|direktor\w*|director|prokurist\w*|assisten\w*|referent\w*|berater\w*|consultant|sales|ceo|cfo|cto|coo|founder|gr[uü]nder\w*|vorstand\w*|partner\w*|sachbearbeit\w*|projekt\w*|key account|account|marketing|einkauf\w*|buchhaltung|disposition|mitarbeiter\w*|kaufm\w*|meister\w*|ingenieur\w*|dipl\.?-?\w*|head of|team ?lead\w*)\b/i

function bereinigen(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Eine Zeile in ihre Abschnitte. Visitenkarten setzen die ganze Anschrift
 * gern in eine Zeile, getrennt durch Komma, senkrechten Strich, Punkt in der
 * Mitte oder Strich. Die Erkennung liest den senkrechten Strich oft als
 * grosses I oder kleines l -- allein zwischen zwei Leerzeichen ist er nie
 * ein Wort.
 */
function abschnitte(zeile: string): string[] {
  return zeile.split(/\s*[,|•·;]\s*|\s+[-–—Il/]\s+/).map(bereinigen).filter(s => s !== '')
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

/**
 * Der Ort ohne das, was die Zeile danach noch traegt: Land, Telefon,
 * Adresse im Netz. Der Ausdruck nimmt bis zu vier Woerter, weil "Frankfurt
 * am Main" drei hat; "Cuxhaven Tel." oder "Cuxhaven Germany" schneidet erst
 * diese Funktion zurecht.
 */
function ortBereinigen(ort: string): string {
  const woerter: string[] = []
  for (const w of ort.split(' ')) {
    if (KONTAKT.test(w) || landAusText(w) !== '' || /^(www|http)/i.test(w)) break
    woerter.push(w)
  }
  // Kleine Woerter am Ende ("Cuxhaven und") gehoeren nicht zum Ort.
  while (woerter.length > 1 && /^\p{Ll}/u.test(woerter[woerter.length - 1]!)) woerter.pop()
  return woerter.join(' ').replace(/[\s,.;:/-]+$/, '').trim()
}

/** Eine Strasse ohne Beschriftung davor und Satzzeichen dahinter. */
function strasseBereinigen(s: string): string {
  return s.replace(BESCHRIFTUNG, '').replace(/[\s,.;:·|/–-]+$/, '').trim()
}

function istStrasse(roh: string): boolean {
  const s = strasseBereinigen(roh)
  if (KONTAKT.test(s) || !/\p{L}{2}/u.test(s)) return false
  if (/^postfach\b|^p\.?\s?o\.?\s?box\b/i.test(s)) return true
  // Eine Zeile mit Postleitzahl ist keine Strasse, auch wenn sie so endet.
  if (/\b\d{5}\b/.test(s) || BERUF.test(s)) return false
  // Hausnummer am Ende reicht allein nicht: "Fax 04721 12345" endet auch so.
  return (HAUSNUMMER.test(s) && /^\p{L}/u.test(s) && !/\d{4,}$/.test(s))
    || (STRASSE.test(s) && /\d/.test(s))
}

function ustId(text: string): string {
  // Erst die beschriftete Nummer, dann die deutsche ohne Beschriftung.
  const beschriftet = /(?:USt\.?\s?-?\s?Id(?:ent)?\.?\s?-?\s?Nr\.?|UID(?:-?Nr\.?)?|VAT(?:\s?(?:ID|No\.?|Reg\.?))?|BTW(?:-?nr\.?)?|CVR|MwSt\.?-?Nr\.?)\s*[:.]?\s*([A-Z]{2}[A-Z0-9 .]{7,16})/i
    .exec(text)
  const roh = beschriftet?.[1] ?? /\b(DE\s?\d{3}\s?\d{3}\s?\d{3})\b/.exec(text)?.[1]
  if (roh === undefined) return ''
  return roh.replace(/[\s.]/g, '').toUpperCase()
}

/** Fuer den Vergleich mit der Domain: klein, Umlaute ausgeschrieben, nur Buchstaben. */
function vergleichbar(s: string): string {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '')
}

/**
 * Der Name der Firma, wie ihn Mail- und Webadresse tragen: "kuestenbau" aus
 * "a.schroeder@kuestenbau.de". Freemailer verraten nichts.
 */
function domainStaemme(text: string): string[] {
  const stamm = new Set<string>()
  for (const m of text.matchAll(/(?:@|www\.|https?:\/\/)([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.[a-z]{2,}/gi)) {
    const teile = m[1]!.toLowerCase().split('.')
    const s = vergleichbar(teile[teile.length - 1]!)
    if (s.length >= 4 && !/^(gmail|googlemail|gmx|web|outlook|hotmail|yahoo|icloud|tonline|freenet|aol|posteo|mailbox)$/.test(s)) {
      stamm.add(s)
    }
  }
  return [...stamm]
}

interface Ortstreffer { postalCode: string; city: string; country: string; vor: string }

/** Postleitzahl und Ort in einem Abschnitt, mit dem, was davor steht. */
function ortIn(abschnitt: string): Ortstreffer | null {
  const nl = PLZ_ORT_NL.exec(abschnitt)
  if (nl !== null) {
    const city = ortBereinigen(nl[3]!)
    if (city !== '') {
      return { postalCode: `${nl[1]} ${nl[2]}`, city, country: 'NL',
               vor: abschnitt.slice(0, nl.index) }
    }
  }
  const re = new RegExp(PLZ_ORT.source, 'gu')
  for (const m of abschnitt.matchAll(re)) {
    const [, praefix, plz, ortRoh] = m
    const start = m.index + m[0].indexOf(praefix !== undefined ? praefix : plz!)
    const vor = abschnitt.slice(0, start)
    // Hinter einer Telefonbeschriftung ist es eine Rufnummer.
    if (KONTAKT.test(vor) || /[\d+(/]\s*$/.test(vor)) continue
    // Registernummer, Bank und Steuer stehen mit fuenf Ziffern, aber ohne Ort.
    if (/\b(HRB|HRA|Amtsgericht|Registergericht|IBAN|BIC|BLZ|Konto|St\.?-?Nr|Steuer)/i.test(vor)) continue
    // Vierstellig nur mit Laenderkennung oder am Anfang: "Haus 1234 Ort" ist
    // sonst zu oft etwas anderes.
    if (plz!.length === 4 && praefix === undefined && vor.trim() !== '') continue
    const city = ortBereinigen(ortRoh!)
    if (city === '' || KONTAKT.test(city.split(' ')[0]!)) continue
    let country = praefix !== undefined ? (PLZ_PRAEFIX[praefix] ?? '') : ''
    if (country === '' && plz!.length === 5) country = 'DE'
    return { postalCode: plz!, city, country, vor }
  }
  return null
}

/**
 * Den Vorschlag aus den Zeilen aller fotografierten Seiten.
 *
 * Die Seiten kommen hintereinander: steht der Name vorn und die Anschrift
 * hinten, findet sich beides trotzdem.
 *
 * **Reihenfolge der Suche.** Zuerst der Ort, weil er am sichersten zu
 * erkennen ist (fuenf Ziffern und ein Wort, nicht hinter "Tel."). Die
 * Strasse steht dann davor: im selben Abschnitt ("Hafenstrasse 12a 27472
 * Cuxhaven"), im Abschnitt davor oder in einer der drei Zeilen darueber --
 * drei, weil bei zwei Spalten nach Hoehe sortiert die Zeilen der anderen
 * Spalte dazwischenliegen. Erst wenn das nichts ergibt, gilt die erste
 * Zeile, die nach Strasse aussieht.
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
      const treffer = ortIn(teile[j]!)
      if (treffer === null) continue
      ;({ postalCode, city, country } = treffer)
      verbraucht.add(i)
      const kandidaten = [treffer.vor, ...teile.slice(0, j).reverse()]
      const imSelben = kandidaten.find(istStrasse)
      if (imSelben !== undefined) {
        addressLine1 = strasseBereinigen(imSelben)
      } else {
        for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
          const s = abschnitte(klar[k]!.text).reverse().find(istStrasse)
          if (s !== undefined) {
            addressLine1 = strasseBereinigen(s)
            verbraucht.add(k)
            break
          }
        }
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
        addressLine1 = strasseBereinigen(treffer)
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

  return { name: firmenname(klar, verbraucht, ganzerText), addressLine1, postalCode, city,
           country, vatId }
}

/**
 * Der Name der Firma, in dieser Reihenfolge: eine Zeile mit Rechtsform; eine
 * Zeile, die die Domain der Mail- oder Webadresse traegt; sonst die groesste
 * Zeile, die weder Kontakt noch Anschrift noch Nummer ist -- und nicht ueber
 * einer Berufsbezeichnung steht, denn dort steht ein Mensch.
 */
function firmenname(klar: ReadonlyArray<{ text: string; hoehe: number }>,
                    verbraucht: ReadonlySet<number>, ganzerText: string): string {
  const beruf = klar.map(z => BERUF.test(z.text))
  // Nur die Berufsbezeichnung allein in der Zeile verweist auf den Menschen
  // darueber; "Max Mustermann | Geschaeftsfuehrer" traegt ihn selbst.
  const nurBeruf = klar.map((z, i) => beruf[i] === true && abschnitte(z.text).length === 1)
  const kandidaten = klar
    .map((z, i) => ({ ...z, i }))
    .filter(z => !verbraucht.has(z.i) && !beruf[z.i]
      && !KONTAKT.test(z.text) && !istStrasse(z.text) && ortIn(z.text) === null
      && !/\d{4,}/.test(z.text) && /\p{L}{2}/u.test(z.text)
      // Oeffnungszeiten sind kein Name.
      && !/\d{1,2}[:.]\d{2}|\bUhr\b|\b(Mo|Di|Mi|Do|Fr|Sa|So)\.?\s*[-–]/i.test(z.text)
      && landAusText(z.text) !== z.text.trim().toLowerCase()
      && !/^(USt|UID|VAT|BTW|Steuer|HRB|HRA|Amtsgericht|Registergericht|Sitz)/i.test(z.text))
  const mitForm = kandidaten.find(z => RECHTSFORM.test(z.text))
  if (mitForm !== undefined) {
    if (!nurRechtsform(mitForm.text)) return mitForm.text
    // "KÜSTENBAU" gross, darunter klein "GmbH & Co. KG": die Rechtsform
    // allein ist kein Name, sie gehoert an die Zeile darueber.
    const davor = kandidaten[kandidaten.indexOf(mitForm) - 1]
    return davor !== undefined ? `${davor.text} ${mitForm.text}` : mitForm.text
  }
  const staemme = domainStaemme(ganzerText)
  const ausDomain = kandidaten.find(z => {
    const v = vergleichbar(z.text)
    return v.length >= 4 && staemme.some(s => s.includes(v) || v.includes(s))
  })
  if (ausDomain !== undefined) return ausDomain.text
  // Der Mensch steht ueber seiner Berufsbezeichnung ("Anna Schroeder",
  // darunter "Projektleitung"); die Zeile darunter ist oft schon die Firma.
  const person = (i: number): boolean => nurBeruf[i + 1] === true
  const sortiert = [...kandidaten].sort((a, b) => b.hoehe - a.hoehe)
  return (sortiert.find(z => !person(z.i)) ?? sortiert[0])?.text ?? ''
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
