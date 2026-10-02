/**
 * Die Anforderung einer Anzahlung: Betrag und Zustand.
 *
 * **Warum eine eigene Datei mit eigenem Einstieg.** Dieselben zwei Regeln
 * braucht die API, die den Betrag festschreibt, und die Oberflaeche, die ihn
 * vorher anzeigt. Zwei Fassungen derselben Rundung laufen auseinander, und
 * die Abweichung zeigte sich als Cent zwischen dem, was die Rezeption beim
 * Tippen sah, und dem, was beim Gast ankommt. Die Oberflaeche holt sich diese
 * Datei ueber `@hotelpms/domain/depositRequest` -- nicht ueber das Barrel, das
 * `node:crypto` mitbringt und im Browser nicht laedt (vgl. `groupPrice`).
 */

/**
 * Der Betrag einer Anzahlung in Prozent des Aufenthalts, in Cent.
 *
 * **Abgerundet, auf den ganzen Cent.** Die Forderung ueberschreitet damit
 * nie den vereinbarten Anteil: 30 Prozent von 333,33 EUR sind 99,999 EUR,
 * und gefordert werden 99,99 und nicht 100,00. Kaufmaennisch gerundet
 * waere der Unterschied ein Zehntelcent -- aber eine Forderung ueber dem
 * vereinbarten Satz ist eine, die ein Gast zu Recht beanstanden kann, eine
 * darunter nicht. Bei 100 Prozent kommt dadurch genau der Aufenthaltspreis
 * heraus, nie ein Cent mehr.
 *
 * Gerechnet wird ganzzahlig: der Satz kommt in Basispunkten (3000 = 30 %),
 * und `stayCent * percentBp` bleibt fuer jeden denkbaren Aufenthaltspreis
 * weit unter 2^53. Fliesskomma kommt nicht vor -- `0.3 * 33333` ist in
 * Fliesskomma 9999.899999999998, und wer darauf rundet, rundet etwas
 * anderes, als er glaubt.
 */
export function depositFromPercent(stayCent: number, percentBp: number): number {
  if (!Number.isInteger(stayCent) || stayCent <= 0) return 0
  if (!Number.isInteger(percentBp) || percentBp <= 0 || percentBp > 10_000) return 0
  return Math.floor((stayCent * percentBp) / 10_000)
}

/**
 * Wo eine Anforderung steht.
 *
 * - `requested`  angelegt, nichts eingegangen, kein offener Link
 * - `link_sent`  ein Zahlungslink ist offen und noch gueltig
 * - `partial`    ein Teil ist eingegangen, die Frist laeuft noch
 * - `received`   mindestens der geforderte Betrag ist eingegangen
 * - `overdue`    die Frist ist verstrichen und es fehlt noch etwas
 * - `canceled`   das Haus hat die Anforderung zurueckgezogen
 */
export const DEPOSIT_REQUEST_STATES = [
  'requested', 'link_sent', 'partial', 'received', 'overdue', 'canceled'
] as const
export type DepositRequestState = (typeof DEPOSIT_REQUEST_STATES)[number]

export interface DepositRequestFacts {
  amountCent: number
  receivedCent: number
  /** Faelligkeit als Kalendertag `YYYY-MM-DD`. */
  dueDate: string
  /** Der offene Geschaeftstag des Hauses, `YYYY-MM-DD`. */
  businessDate: string
  /** Gibt es einen offenen, noch gueltigen Zahlungslink zu dieser Anforderung? */
  openLink: boolean
  canceled: boolean
}

/**
 * Der Zustand, abgeleitet und nie gespeichert.
 *
 * Gespeichert waere er falsch, sobald der Geschaeftstag weiterrueckt: eine
 * Anforderung wird nicht durch ein Ereignis ueberfaellig, sondern dadurch,
 * dass nichts geschieht. Dafuer muesste ein Nachtlauf jede Zeile anfassen,
 * und ein Wiederholungslauf faende andere.
 *
 * **Gegen den Geschaeftstag, nicht gegen heute.** Faellig am 3. heisst: am
 * Geschaeftstag des 3. ist es noch in Ordnung, ab dem 4. nicht mehr. Der
 * Geschaeftstag schaltet mit dem Nachtlauf, nicht um Mitternacht -- eine
 * Rezeption, die um halb eins noch abrechnet, steht noch im alten Tag.
 *
 * **Ueberfaellig geht vor teilweise.** Wer die Haelfte gezahlt hat und die
 * Frist verstreichen liess, ist der Fall, um den sich jemand kuemmern muss;
 * dass ein Teil da ist, zeigt der Betrag daneben.
 *
 * Kalendertage als `YYYY-MM-DD` vergleichen sich als Zeichenkette richtig;
 * ein `new Date()` braucht es dafuer nicht, und es verschoebe den Tag je
 * nach Zeitzone.
 */
export function depositRequestState(f: DepositRequestFacts): DepositRequestState {
  if (f.canceled) return 'canceled'
  if (f.receivedCent >= f.amountCent) return 'received'
  if (f.dueDate < f.businessDate) return 'overdue'
  if (f.receivedCent > 0) return 'partial'
  if (f.openLink) return 'link_sent'
  return 'requested'
}

/** Was von einer Anforderung noch fehlt. Nie negativ: zu viel ist nicht "minus offen". */
export function depositRequestOpenCent(amountCent: number, receivedCent: number): number {
  return Math.max(amountCent - receivedCent, 0)
}

// ---------------------------------------------------------------------------
// Der dauerhafte Zahlungslink (Migration 0059)
// ---------------------------------------------------------------------------

/** Wie lange ein Link nach der Faelligkeit noch annimmt. */
export const LINK_KULANZ_TAGE = 7

/** Wie lange ein Link ueber einen festen Betrag gilt, ohne Anforderung dahinter. */
export const LINK_FREI_TAGE = 14

/**
 * Bis zu welchem Geschaeftstag ein Zahlungslink annimmt.
 *
 * **Eine Woche ueber die Faelligkeit hinaus.** Eine Ueberweisung, die am
 * Faelligkeitstag veranlasst wird, ist dort noch nicht da; eine Karte, die
 * am Abend des Fristtags abgelehnt wird, braucht einen zweiten Versuch am
 * naechsten Morgen. Ein Link, der genau mit der Frist stirbt, verwandelte
 * einen Gast, der zahlen will, in einen Anruf an der Rezeption. Die Woche
 * ist kein Zahlungsaufschub: die Anforderung steht ab dem Tag nach der
 * Faelligkeit als ueberfaellig da, und das Haus kann den Link jederzeit
 * widerrufen.
 *
 * **Nie ueber die Abreise hinaus.** Danach ist eine Anzahlung keine mehr;
 * was dann offen ist, gehoert auf die Rechnung.
 *
 * **Ist die Frist schon verstrichen**, wenn der Link entsteht -- das Haus
 * schickt einer ueberfaelligen Anforderung einen neuen hinterher --, zaehlt
 * die Woche ab dem Geschaeftstag. Sonst waere der neue Link tot, bevor der
 * Gast ihn liest.
 *
 * Ohne Anforderung (ein fester Betrag, etwa der Saldo nach der Abreise)
 * gilt der Link zwei Wochen ab dem Geschaeftstag; dort gibt es keine Frist,
 * an der er sich ausrichten koennte, und keine Abreise, die ihn begrenzt.
 *
 * Alles als Kalendertag `YYYY-MM-DD`, gegen den Geschaeftstag geprueft.
 */
export function paymentLinkValidUntil(p: {
  businessDate: string
  dueDate: string | null
  departure: string | null
}): string {
  if (p.dueDate === null) return tagPlus(p.businessDate, LINK_FREI_TAGE)
  const ab = p.dueDate > p.businessDate ? p.dueDate : p.businessDate
  const bis = tagPlus(ab, LINK_KULANZ_TAGE)
  if (p.departure !== null && p.departure < bis) {
    return p.departure > p.businessDate ? p.departure : p.businessDate
  }
  return bis
}

/** Nimmt der Link heute noch an? Am letzten Tag ja, am Tag danach nicht. */
export function paymentLinkValid(validUntil: string, businessDate: string): boolean {
  return businessDate <= validUntil
}

/**
 * Tage auf einen Kalendertag, auf UTC-Mitternacht gerechnet: dort gibt es
 * keine Zeitumstellung, die einen Tag verschluckt.
 */
function tagPlus(iso: string, tage: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + tage)
  return d.toISOString().slice(0, 10)
}
