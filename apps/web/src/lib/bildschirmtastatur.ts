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
 * Ein Datum als Ziffern, wie es der Gast tippt: `TTMMJJJJ`, angezeigt als
 * `TT.MM.JJJJ`.
 *
 * Am Rechner mit Tastatur ist `<input type="date">` richtig. Am Touchscreen
 * nicht: in seine Teilfelder laesst sich nur mit echten Tastenanschlaegen
 * schreiben, die eine Bildschirmtastatur nicht erzeugen kann, und der
 * Kalender dahinter faengt beim heutigen Monat an -- bis zum Geburtsjahr
 * sind es vierzig Jahre Blaettern. Deshalb tippt der Gast am Terminal
 * Ziffern, und die Punkte setzt das Feld.
 */
export function datumAnzeige(eingabe: string): string {
  const z = eingabe.replace(/\D/g, '').slice(0, 8)
  return z.slice(0, 2)
    + (z.length > 2 ? `.${z.slice(2, 4)}` : '')
    + (z.length > 4 ? `.${z.slice(4)}` : '')
}

/** `TT.MM.JJJJ` -> ISO, sonst `''`. Ein 31. Februar ist kein Datum. */
export function datumIso(anzeige: string): string {
  const z = anzeige.replace(/\D/g, '')
  if (z.length !== 8) return ''
  const tag = Number(z.slice(0, 2))
  const monat = Number(z.slice(2, 4))
  const jahr = Number(z.slice(4))
  if (jahr < 1900) return ''
  const d = new Date(Date.UTC(jahr, monat - 1, tag))
  if (d.getUTCFullYear() !== jahr || d.getUTCMonth() !== monat - 1 || d.getUTCDate() !== tag) {
    return ''
  }
  return `${z.slice(4)}-${z.slice(2, 4)}-${z.slice(0, 2)}`
}

/** ISO -> `TT.MM.JJJJ`. Als Zeichenkette zerlegt, nie ueber `new Date` in Ortszeit. */
export function datumAusIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m === null ? '' : `${m[3]}.${m[2]}.${m[1]}`
}
