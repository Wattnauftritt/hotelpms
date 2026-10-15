import type { Cent, BasisPoints } from './money.js'
import { lineWithGuest, type CiiLine } from './invoiceCii.js'

/**
 * Fasst die Positionen einer Rechnung je Leistung ueber die Naechte
 * zusammen und ordnet sie (Sven, 15.10.2026: "preise pro nacht sind auch
 * sehr verwirrend und rechnungen fuer 14 tage werden endlos" und "die
 * uebernachtung muss generell vor dem fruehstueck kommen").
 *
 * **Warum erst hier und nicht in der Buchung.** Der Nachtlauf bucht jede
 * Nacht einzeln, und dabei bleibt es: Folio, DATEV-Stapel, Storno einer
 * einzelnen Nacht und die Statistik brauchen die Nacht. Zusammengefasst
 * wird nur, was auf dem Beleg steht -- auf Blatt **und** XML gleich, denn
 * beide entstehen aus dieser Liste (Dokument 13, invoiceLayout.ts).
 *
 * **Was zusammengeht.** Positionen, deren Text auf ihr eigenes
 * Geschaeftsdatum endet ("Übernachtung 08.10.2026"), mit gleichem Text
 * davor, gleichem Satz, gleicher Einheit, gleichem Gast und gleichem
 * Vorzeichen, an aufeinanderfolgenden Tagen. Eine Luecke beginnt eine neue
 * Zeile: zwei Aufenthalte auf einer Sammelrechnung sind zwei Zeitraeume,
 * und ein Zeitraum ueber die Luecke hinweg behauptete Naechte, die es nicht
 * gab. Die Preise der Naechte duerfen abweichen (78,59 neben 78,60, wenn
 * ein Gesamtpreis auf Naechte verteilt wurde); der Einzelpreis ist dann
 * der Durchschnitt, der Betrag bleibt die genaue Summe. Die Steuer aendert
 * sich dadurch nicht: sie wird je Satz aus der Nettosumme gerechnet, und
 * die ist dieselbe.
 *
 * **Der Zeitraum** reicht von der ersten bis zur letzten Nacht,
 * "Übernachtung 08.10.–10.10.2026" bei drei Naechten: so wie der
 * Leistungszeitraum im Kopf, der aus denselben Geschaeftsdaten kommt.
 * Anreise bis Abreise stuende dort sonst einen Tag weiter als oben.
 */
export interface InvoiceLineSource {
  /** Text der Buchung, ohne Gastzusatz. */
  description: string
  /** Geschaeftsdatum der Buchung, ISO. */
  businessDate: string
  quantity: number
  netCent: Cent
  rateBp: BasisPoints
  unitCode?: string
  /** Zusatz "Zimmer 101, Anna Berger" (0175), falls die Rechnung ihn traegt. */
  guest?: string | undefined
  /**
   * Rang in der Reihenfolge: 0 Uebernachtung, 1 Fruehstueck Speisen,
   * 2 Fruehstueck Getraenke, 3 Inklusivleistung, 4 alles andere.
   */
  rank: number
}

const DATUM_AM_ENDE = /^(.*\S) (\d{2})\.(\d{2})\.(\d{4})$/

function naechsterTag(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** 08.10.–10.10.2026, ueber den Jahreswechsel 31.12.2026–01.01.2027. */
function zeitraum(von: string, bis: string): string {
  const [vj, vm, vt] = von.split('-')
  const [bj, bm, bt] = bis.split('-')
  return vj === bj ? `${vt}.${vm}.–${bt}.${bm}.${bj}` : `${vt}.${vm}.${vj}–${bt}.${bm}.${bj}`
}

interface Gruppe {
  basis: string
  von: string
  bis: string
  quantity: number
  netCent: number
  /** Die Naechte kosteten nicht alle gleich viel. */
  gemischt: boolean
  quelle: InvoiceLineSource
  /** Erste Position, fuer die Reihenfolge der Gaeste. */
  index: number
}

export function groupInvoiceLines(quellen: InvoiceLineSource[]): CiiLine[] {
  // Reihenfolge der Gaeste (Zimmer) wie in der Buchung: so steht eine
  // Sammelrechnung Zimmer fuer Zimmer, jedes mit Uebernachtung zuerst.
  const gastRang = new Map<string, number>()
  for (const q of quellen) {
    if (!gastRang.has(q.guest ?? '')) gastRang.set(q.guest ?? '', gastRang.size)
  }

  const offen = new Map<string, Gruppe>()
  const gruppen: Gruppe[] = []
  const sortiert = quellen.map((q, index) => ({ q, index }))
    .sort((a, b) => a.q.businessDate.localeCompare(b.q.businessDate) || a.index - b.index)

  for (const { q, index } of sortiert) {
    const m = DATUM_AM_ENDE.exec(q.description)
    const passt = m !== null && `${m[4]}-${m[3]}-${m[2]}` === q.businessDate
    if (!passt) {
      gruppen.push({ basis: q.description, von: q.businessDate, bis: q.businessDate,
                     quantity: q.quantity, netCent: q.netCent, gemischt: false,
                     quelle: q, index })
      continue
    }
    const basis = m[1]!
    const schluessel = [basis, q.rateBp, q.unitCode ?? '', q.guest ?? '', q.rank,
                        q.netCent < 0 ? '-' : '+'].join('\u0000')
    const g = offen.get(schluessel)
    // Nur der naechste Tag setzt fort; dieselbe Nacht zweimal (zwei
    // Buchungen am selben Tag) ist keine weitere Nacht.
    if (g !== undefined && naechsterTag(g.bis) === q.businessDate) {
      g.bis = q.businessDate
      // Preis je Einheit verglichen ueber Kreuz, ohne Division.
      if (q.netCent * g.quantity !== g.netCent * q.quantity) g.gemischt = true
      g.quantity += q.quantity
      g.netCent += q.netCent
      continue
    }
    const neu: Gruppe = { basis, von: q.businessDate, bis: q.businessDate,
                          quantity: q.quantity, netCent: q.netCent, gemischt: false,
                          quelle: q, index }
    offen.set(schluessel, neu)
    gruppen.push(neu)
  }

  gruppen.sort((a, b) =>
    gastRang.get(a.quelle.guest ?? '')! - gastRang.get(b.quelle.guest ?? '')!
    || a.quelle.rank - b.quelle.rank
    || a.von.localeCompare(b.von)
    || a.index - b.index)

  return gruppen.map(g => {
    // Eine einzelne Nacht behaelt ihren Text, wie er gebucht wurde.
    const text = g.von === g.bis && g.basis !== g.quelle.description
      ? g.quelle.description
      : g.basis === g.quelle.description ? g.basis
      : `${g.basis} ${zeitraum(g.von, g.bis)}`
    return {
      name: lineWithGuest(text, g.quelle.guest),
      quantity: g.quantity,
      ...(g.quelle.unitCode === undefined ? {} : { unitCode: g.quelle.unitCode }),
      netCent: g.netCent,
      rateBp: g.quelle.rateBp,
      ...(g.gemischt ? { averagePrice: true } : {})
    }
  })
}
