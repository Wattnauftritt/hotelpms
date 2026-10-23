/**
 * Offene Storno-Paare eines Folios (Sven, 23.10.2026).
 *
 * Wer einen Preis korrigiert, hebt die alte Position mit einer Gegenbuchung
 * auf und bucht sie neu. Beide Haelften bleiben am Folio sichtbar (GoBD),
 * gehoeren aber auf keine Rechnung: sie heben sich auf, und die Rezeption
 * musste sie im Rechnungsdialog von Hand suchen und abwaehlen. Die
 * Schnittstelle laesst sie ohnehin weg (`OHNE_STORNOPAAR` in billing.ts);
 * hier nur, damit die Oberflaeche dasselbe zeigt.
 *
 * Nur, solange beide offen sind. Steht eine Haelfte schon auf einer
 * Rechnung, gehoert die andere auf die naechste.
 */
export function offeneStornoPaare(
  charges: ReadonlyArray<{ id: number; reverses_id: number | null; invoice_id: number | null }>
): ReadonlySet<number> {
  const offen = new Map(charges.filter(c => c.invoice_id === null).map(c => [c.id, c]))
  const paar = new Set<number>()
  for (const c of offen.values()) {
    if (c.reverses_id !== null && offen.has(c.reverses_id)) {
      paar.add(c.id)
      paar.add(c.reverses_id)
    }
  }
  return paar
}
