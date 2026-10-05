/**
 * Meldescheine als XML fuer AVS (Migration 0091, Konzept Abschnitt 2.5).
 *
 * Grundlage ist die AVS-Dokumentation "Meldeschein Importschnittstelle"
 * (Stand 24.05.2022). Eine XSD gibt es nicht; die Feldnamen stammen aus dem
 * Dokument, Reihenfolge und Hausnummernregel aus dem Export, den das
 * Adminpanel seit Monaten in Cuxhaven einliest.
 *
 * Reine Funktionen ohne Datenbank: was in die Datei kommt, entscheidet die
 * Route; wie es darin steht, steht hier und ist ohne Datenbank pruefbar.
 */

export interface AvsEinstellung {
  hotelId: string
  origin: string
  userName: string
}

export interface AvsPerson {
  lastName: string
  firstName: string | null
  birthDate: string | null
  /** ISO 3166-1 alpha-2. */
  nationality: string | null
  /** Kategorie der Gemeinde, schon aufgeloest (Befreiung oder Vorgabe). */
  category: number
  /** Nur bei Einwilligung in die digitale Gaestekarte. */
  email: string | null
  idDocumentNumber: string | null
}

export interface AvsMeldeschein {
  arrival: string
  departure: string
  main: AvsPerson & {
    addressLine1: string | null
    postalCode: string | null
    city: string | null
    /** Land der Anschrift, ISO 3166-1 alpha-2. */
    country: string | null
    /** Uebernachtungsentgelt des ganzen Aufenthalts in Cent, oder null. */
    lodgingCent: number | null
  }
  companions: AvsPerson[]
}

/**
 * Strasse und Hausnummer aus einer Zeile.
 *
 * Das Formular fragt beides in einem Feld ab, AVS will zwei, und in
 * Cuxhaven ist die Hausnummer Pflicht. Getrennt wird an der letzten
 * Gruppe, die mit einer Ziffer beginnt -- "Deichweg 4a", "Am Hafen 12-14",
 * "Strandstr. 3 b". Faellt die Trennung aus ("Hof Sonnenschein"), bleibt die
 * Hausnummer leer; AVS legt den Schein dann als "importiert" an, und die
 * Rezeption ergaenzt sie dort. Raten waere schlechter als leer.
 */
export function trenneHausnummer(zeile: string | null): { strasse: string; hausnummer: string } {
  const z = (zeile ?? '').trim().replace(/\s+/g, ' ')
  const m = /^(.*?[^\d\s,])[\s,]+(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d+\s?[a-zA-Z]?)?)$/.exec(z)
  if (m === null) return { strasse: z, hausnummer: '' }
  return { strasse: m[1]!.trim(), hausnummer: m[2]!.replace(/\s+/g, '') }
}

/** Das Land ausgeschrieben, wie AVS es erwartet ("Deutschland"). */
export function landName(code: string | null): string {
  if (code === null || code.trim() === '') return ''
  try {
    return new Intl.DisplayNames(['de'], { type: 'region' }).of(code.toUpperCase()) ?? ''
  } catch {
    return ''
  }
}

/**
 * Die Staatsangehoerigkeit ausgeschrieben, wie AVS sie erwartet ("deutsch").
 *
 * `Intl` kennt Laendernamen, aber keine Adjektive. Die Liste deckt ab, was in
 * einem Haus an der Kueste vorkommt; fuer alles andere steht der Landesname
 * da. Leer zu lassen waere falsch: AVS setzt dann seine Vorgabe ein, und die
 * ist "deutsch".
 */
const STAATSANG: Record<string, string> = {
  DE: 'deutsch', AT: 'österreichisch', CH: 'schweizerisch', LI: 'liechtensteinisch',
  NL: 'niederländisch', BE: 'belgisch', LU: 'luxemburgisch', FR: 'französisch',
  DK: 'dänisch', SE: 'schwedisch', NO: 'norwegisch', FI: 'finnisch', IS: 'isländisch',
  GB: 'britisch', IE: 'irisch', PL: 'polnisch', CZ: 'tschechisch', SK: 'slowakisch',
  HU: 'ungarisch', SI: 'slowenisch', HR: 'kroatisch', IT: 'italienisch', ES: 'spanisch',
  PT: 'portugiesisch', GR: 'griechisch', RO: 'rumänisch', BG: 'bulgarisch',
  EE: 'estnisch', LV: 'lettisch', LT: 'litauisch', MT: 'maltesisch', CY: 'zyprisch',
  UA: 'ukrainisch', RU: 'russisch', BY: 'belarussisch', MD: 'moldauisch',
  RS: 'serbisch', BA: 'bosnisch-herzegowinisch', ME: 'montenegrinisch',
  MK: 'nordmazedonisch', AL: 'albanisch', XK: 'kosovarisch', TR: 'türkisch',
  US: 'amerikanisch', CA: 'kanadisch', AU: 'australisch', NZ: 'neuseeländisch',
  CN: 'chinesisch', JP: 'japanisch', KR: 'südkoreanisch', IN: 'indisch',
  BR: 'brasilianisch', IL: 'israelisch', SY: 'syrisch', AF: 'afghanisch', IR: 'iranisch',
  IQ: 'irakisch', VN: 'vietnamesisch', TH: 'thailändisch', PH: 'philippinisch',
  ZA: 'südafrikanisch', EG: 'ägyptisch', MA: 'marokkanisch', TN: 'tunesisch'
}

export function staatsangehoerigkeit(code: string | null): string {
  if (code === null || code.trim() === '') return ''
  const c = code.toUpperCase()
  return STAATSANG[c] ?? landName(c)
}

/** Alter am Anreisetag in vollen Jahren; Kalenderdaten, keine Zeitpunkte. */
export function alterAm(geburt: string, tag: string): number {
  const [gj, gm, gt] = geburt.split('-').map(Number) as [number, number, number]
  const [j, m, t] = tag.split('-').map(Number) as [number, number, number]
  return j - gj - (m < gm || (m === gm && t < gt) ? 1 : 0)
}

/**
 * Dateiname nach AVS-Regel: `Benutzer_JJJJ-MM-TT_hh-mm`, in Ortszeit des
 * Hauses -- die Rezeption findet die Datei an der Uhrzeit, die sie kennt.
 */
export function avsDateiname(userName: string, jetzt: Date,
                             zeitzone = 'Europe/Berlin'): string {
  const teile = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zeitzone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(jetzt).map(p => [p.type, p.value]))
  return `${userName}_${teile.year}-${teile.month}-${teile.day}_${teile.hour}-${teile.minute}.xml`
}

/**
 * Name der heruntergeladenen Datei: Anreisetag und Gast, etwa
 * `2026-10-05_Jaster_Martin.xml` (Sven, 05.10.2026). Die Rezeption sucht die
 * Datei im Download-Ordner nach dem Gast, der vor ihr steht; AVS liest nur
 * den Inhalt. Nur Buchstaben, Ziffern und Bindestrich: Umlaute werden
 * umschrieben, alles andere faellt weg, damit kein Betriebssystem an einem
 * Namen wie "O'Neill / Smith" scheitert.
 */
export function avsDownloadName(arrival: string, lastName: string,
                                firstName: string | null): string {
  const teil = (v: string): string => v
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const name = [teil(lastName), teil(firstName ?? '')].filter(x => x !== '').join('_')
  return `${arrival}_${name || 'Gast'}.xml`
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Steuerzeichen sind in XML 1.0 nicht erlaubt; ein eingefuegter Tabulator
    // aus einem Formular wuerde die ganze Datei unlesbar machen.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/**
 * Ein Feld, nur wenn es einen Wert hat. AVS erlaubt beides -- leeres Tag
 * oder kein Tag --; ohne Tag wird kein leerer Wert zu einer Vorgabe.
 */
function feld(name: string, wert: string | number | null | undefined, einzug: string): string {
  if (wert === null || wert === undefined || wert === '') return ''
  return `${einzug}<${name}>${esc(String(wert))}</${name}>\n`
}

function euro(cent: number): string {
  const v = Math.max(0, Math.round(cent))
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`
}

/**
 * Die Felder einer Person in der Reihenfolge, die das Adminpanel seit
 * Monaten in Cuxhaven einliest (Auskunft vom 05.10.2026): Name, Aufenthalt,
 * Kategorie, Geburtsdatum. Die AVS-Dokumentation nennt keine Reihenfolge;
 * die erprobte ist die sichere.
 */
function personKern(p: AvsPerson, arrival: string, departure: string, e: string): string {
  return feld('anreise', arrival, e)
    + feld('abreise', departure, e)
    + feld('kategorie', p.category, e)
    + feld('gebdatum', p.birthDate, e)
}

/**
 * Was das Adminpanel nicht schreibt, die Dokumentation aber vorsieht. Steht
 * hinten, damit der erprobte Teil unveraendert bleibt.
 *
 * Die Staatsangehoerigkeit geht mit, obwohl das Adminpanel sie weglaesst:
 * ohne sie setzt AVS "deutsch" ein, und jeder auslaendische Gast stuende
 * falsch in der Statistik der Gemeinde.
 */
function personZusatz(p: AvsPerson, e: string): string {
  return feld('staatsang', staatsangehoerigkeit(p.nationality), e)
    + feld('persausweisnr', p.idDocumentNumber, e)
    + (p.email ? feld('email', p.email, e) + feld('digit_gastkart', 'true', e) : '')
}

/** Die ganze Datei: ein `<meldeschein>` je Hauptschein, Begleitpersonen darin. */
export function avsXml(s: AvsEinstellung, scheine: AvsMeldeschein[]): string {
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<meldescheine>\n'
  for (const m of scheine) {
    const { strasse, hausnummer } = trenneHausnummer(m.main.addressLine1)
    const e = '    '
    x += '  <meldeschein>\n'
    x += feld('Herkunfts-ID', s.origin, e)
    x += feld('Benutzer', s.userName, e)
    x += feld('hotelid', s.hotelId, e)
    x += feld('name', m.main.lastName, e)
    x += feld('vorname', m.main.firstName, e)
    x += feld('strasse', strasse, e)
    // Pflicht in Cuxhaven, deshalb auch leer: AVS legt den Schein dann als
    // "importiert" an, und die Rezeption traegt die Nummer dort nach.
    x += `${e}<hausnummer>${esc(hausnummer)}</hausnummer>\n`
    x += feld('plz', m.main.postalCode, e)
    x += feld('ort', m.main.city, e)
    x += personKern(m.main, m.arrival, m.departure, e)
    x += feld('ue-e-gelt', m.main.lodgingCent === null ? null : euro(m.main.lodgingCent), e)
    x += feld('land', landName(m.main.country), e)
    x += personZusatz(m.main, e)
    for (const b of m.companions) {
      const eb = '      '
      x += `${e}<begleitperson>\n`
        + feld('name', b.lastName, eb) + feld('vorname', b.firstName, eb)
        + feld('gebdatum', b.birthDate, eb) + feld('kategorie', b.category, eb)
        + feld('anreise', m.arrival, eb) + feld('abreise', m.departure, eb)
        + personZusatz(b, eb)
        + `${e}</begleitperson>\n`
    }
    x += '  </meldeschein>\n'
  }
  return x + '</meldescheine>\n'
}
