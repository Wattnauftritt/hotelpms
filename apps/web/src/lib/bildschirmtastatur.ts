/**
 * Die Bildschirmtastatur des Gaesteterminals, ohne React und ohne DOM.
 *
 * Am Touchscreen steht keine Tastatur, und die des Betriebssystems ist im
 * Kioskmodus entweder nicht da oder verdeckt das halbe Formular in einer
 * Sprache, die der Gast nicht gewaehlt hat. Das Adminpanel hat deshalb im
 * Meldeformular eine eigene (`guest-registration/layout.blade.php`), und
 * diese hier folgt ihr: QWERTZ mit Umlauten und `ß`, Ziffern in der obersten
 * Reihe, Umschalten fuer genau einen Buchstaben, "Weiter" springt ins
 * naechste Feld.
 *
 * Was sie dazu kann, weil es hier gebraucht wird: ein `@` und ein `+`
 * (Mailadressen und Telefonnummern, sobald ein Formular danach fragt --
 * der Tastatur des Adminpanels fehlen beide), eine Ebene mit Akzentbuchstaben -- der Gast,
 * der den Meldeschein unterschreibt, ist per Gesetz auslaendisch, und
 * "Müller" schreibt sich mit der Tastatur des Adminpanels, "Søren Ødegård"
 * oder "Şükrü Yılmaz" nicht -- und einen Ziffernblock fuer Datumsfelder.
 */

export interface Taste {
  /** Was auf der Taste steht. */
  zeichen: string
  /** `text` fuegt `zeichen` ein; alles andere ist eine Handlung. */
  art: 'text' | 'loeschen' | 'weiter' | 'umschalten' | 'ebene'
  /** Bei `ebene`: wohin. */
  ziel?: Ebene
  /** Relative Breite, 1 = eine Buchstabentaste. */
  breite?: number
}

export type Ebene = 'buchstaben' | 'akzente' | 'ziffern'

const t = (zeichen: string): Taste => ({ zeichen, art: 'text' })
const reihe = (s: string): Taste[] => [...s].map(t)

const LOESCHEN: Taste = { zeichen: '⌫', art: 'loeschen', breite: 1.5 }
const WEITER: Taste = { zeichen: '↵', art: 'weiter', breite: 1.8 }
const UMSCHALTEN: Taste = { zeichen: '⇧', art: 'umschalten', breite: 1.5 }

/**
 * Die Ebenen, klein geschrieben. Gross wird beim Zeichnen, mit
 * `grossSchreiben` -- so gibt es keine zweite Tabelle, die mit der ersten
 * auseinanderlaufen kann.
 */
export const EBENEN: Record<Ebene, Taste[][]> = {
  buchstaben: [
    [...reihe('1234567890ß'), LOESCHEN],
    reihe('qwertzuiopü'),
    [...reihe('asdfghjklöä'), WEITER],
    [UMSCHALTEN, ...reihe('yxcvbnm,.-'), UMSCHALTEN],
    [{ zeichen: 'àé', art: 'ebene', ziel: 'akzente', breite: 1.5 }, t('@'),
     { zeichen: ' ', art: 'text', breite: 6 }, t("'"), t('/'), t('+')]
  ],
  akzente: [
    [...reihe('áàâãåæçćč'), LOESCHEN],
    reihe('éèêëěęíìîïıİ'),
    [...reihe('ñńóòôõøœřśğ'), WEITER],
    [UMSCHALTEN, ...reihe('šşúùûýžżł'), UMSCHALTEN],
    [{ zeichen: 'abc', art: 'ebene', ziel: 'buchstaben', breite: 1.5 }, t('@'),
     { zeichen: ' ', art: 'text', breite: 6 }, t("'"), t('/')]
  ],
  ziffern: [
    [...reihe('123'), LOESCHEN],
    reihe('456'),
    [...reihe('789'), WEITER],
    [{ zeichen: 'abc', art: 'ebene', ziel: 'buchstaben', breite: 1.5 }, t('0'), t('.')]
  ]
}

/**
 * Ein Zeichen gross. `ß` bleibt `ß`: "SS" waeren zwei Zeichen fuer einen
 * Tastendruck, und das grosse `ẞ` steht in keinem Ausweis. Das tuerkische
 * `İ` hat eine eigene Taste neben dem punktlosen `ı` -- aus `i` wird mit
 * Umschalten `I`, und wer tuerkisch schreibt, braucht beide Paare.
 */
export function grossSchreiben(zeichen: string): string {
  return zeichen === 'ß' ? zeichen : zeichen.toUpperCase()
}

export interface Feldstand { wert: string; anfang: number; ende: number }

/**
 * Text an der Schreibmarke einfuegen, eine Auswahl ersetzen.
 *
 * `maxLength` gilt hier wie beim Tippen: der Browser prueft ihn nur fuer
 * echte Tastenanschlaege, nicht fuer einen gesetzten Wert, und die
 * Schnittstelle wiese den zu langen Wert sonst erst beim Absenden ab.
 */
export function einfuegen(f: Feldstand, text: string, maxLaenge = -1): Feldstand {
  const vorher = f.wert.slice(0, f.anfang)
  const nachher = f.wert.slice(f.ende)
  if (maxLaenge >= 0 && vorher.length + text.length + nachher.length > maxLaenge) return f
  const marke = vorher.length + text.length
  return { wert: vorher + text + nachher, anfang: marke, ende: marke }
}

/** Ein Zeichen vor der Schreibmarke loeschen, oder die Auswahl. */
export function loeschen(f: Feldstand): Feldstand {
  if (f.anfang !== f.ende) {
    return { wert: f.wert.slice(0, f.anfang) + f.wert.slice(f.ende), anfang: f.anfang, ende: f.anfang }
  }
  if (f.anfang === 0) return f
  // Ein Zeichen, nicht eine UTF-16-Einheit: sonst bliebe von einem
  // zusammengesetzten Zeichen die Haelfte stehen.
  const vorher = [...f.wert.slice(0, f.anfang)]
  vorher.pop()
  const neu = vorher.join('')
  return { wert: neu + f.wert.slice(f.anfang), anfang: neu.length, ende: neu.length }
}

/**
 * Die Ebene, mit der ein Feld beginnt. Ein Feld, das Ziffern erwartet
 * (`inputMode="numeric"`, das Datumsfeld), bekommt den Ziffernblock --
 * dieselbe Zusage, die das Attribut einer Systemtastatur macht.
 */
export function startEbene(eingabeModus: string): Ebene {
  return eingabeModus === 'numeric' || eingabeModus === 'decimal' ? 'ziffern' : 'buchstaben'
}

// ---------------------------------------------------------------- Datum

/**
 * Ein Geburtsdatum, wie es ein Mensch schreibt, als ISO -- sonst `''`.
 *
 * Am Rechner mit Tastatur ist `<input type="date">` richtig. Am Touchscreen
 * nicht: in seine Teilfelder laesst sich nur mit echten Tastenanschlaegen
 * schreiben, die eine Bildschirmtastatur nicht erzeugen kann, und der
 * Kalender dahinter faengt beim heutigen Monat an -- bis zum Geburtsjahr
 * sind es vierzig Jahre Blaettern. Deshalb tippt der Gast am Terminal.
 *
 * **Was gilt.** Tag zuerst, wie in Deutschland, mit Punkt, Strich,
 * Schraegstrich oder Leerzeichen dazwischen und ein- oder zweistelligem Tag
 * und Monat (`3.11.85`, `03-11-1985`); ohne Trenner sechs oder acht Ziffern
 * (`031185`, `03111985`); und ISO mit dem Jahr vorn (`1985-11-03`). Eine
 * Vorgabe, nur `TT.MM.JJJJ` anzunehmen, hielte am Tresen den Gast auf, der
 * schreibt, wie er es gewohnt ist -- und die Meldung danach verstuende er
 * nicht besser.
 *
 * **Zwei Ziffern Jahr** liegen in der Vergangenheit: es ist ein
 * Geburtsdatum. `85` ist 1985, `12` ist 2012, solange 2012 nicht nach
 * `heute` liegt. Ein Datum nach `heute` ist keins.
 */
export function datumLesen(text: string, heute: string): string {
  const t = text.trim()
  let tag: string, monat: string, jahr: string
  let m: RegExpExecArray | null
  if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(t)) !== null) {
    [jahr, monat, tag] = [m[1]!, m[2]!, m[3]!]
  } else if ((m = /^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{2}|\d{4})$/.exec(t)) !== null) {
    [tag, monat, jahr] = [m[1]!, m[2]!, m[3]!]
  } else if ((m = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(t)) !== null) {
    [tag, monat, jahr] = [m[1]!, m[2]!, m[3]!]
  } else {
    return ''
  }
  const heuteJahr = Number(heute.slice(0, 4))
  let j = Number(jahr)
  if (jahr.length === 2) j = 2000 + j <= heuteJahr ? 2000 + j : 1900 + j
  const mo = Number(monat)
  const ta = Number(tag)
  if (j < 1900) return ''
  const d = new Date(Date.UTC(j, mo - 1, ta))
  if (d.getUTCFullYear() !== j || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== ta) return ''
  const iso = `${String(j)}-${String(mo).padStart(2, '0')}-${String(ta).padStart(2, '0')}`
  return iso > heute ? '' : iso
}

/** ISO -> `TT.MM.JJJJ`. Als Zeichenkette zerlegt, nie ueber `new Date` in Ortszeit. */
export function datumAusIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m === null ? '' : `${m[3]}.${m[2]}.${m[1]}`
}

/** Heute als Kalenderdatum des Geraets, ohne den Umweg ueber UTC. */
export function heuteIso(jetzt: Date = new Date()): string {
  return `${String(jetzt.getFullYear())}-${String(jetzt.getMonth() + 1).padStart(2, '0')}`
    + `-${String(jetzt.getDate()).padStart(2, '0')}`
}
