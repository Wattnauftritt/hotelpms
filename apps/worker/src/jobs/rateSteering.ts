import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'

export interface RateSteeringResult {
  /** NULL, wenn nichts lief: Vorschlagsmodus, kein offener Tag, schon gelaufen. */
  runId: number | null
  changed: number
  businessDate: string | null
}

/**
 * Automatische Preissteuerung eines Hauses (Dokument 32).
 *
 * **Eine Anweisung, gleich wie viele Tage und Plaene.** `rate_steer_apply`
 * rechnet die Vorschlaege des ganzen Horizonts mengenbasiert, vermerkt den
 * Lauf, schreibt Verlauf und Gedaechtnis und uebernimmt die Preise ueber
 * denselben Weg wie die Preispflege von Hand (Migration 0066). Hier steht
 * deshalb keine Schleife und keine Fachlogik -- nur der Aufruf.
 *
 * **Einmal je Geschaeftstag.** Der Lauf entscheidet selbst, ob er faellig ist:
 * nur im automatischen Modus, und nur wenn fuer den offenen Geschaeftstag
 * noch kein automatischer Lauf vermerkt ist. Der Worker darf also beliebig
 * oft ticken, und ein zweiter Worker tut nichts doppelt. Gegen den
 * Geschaeftstag und nicht gegen die Uhr: sonst faende ein Wiederholungslauf
 * kurz nach Mitternacht andere Tage als der erste.
 *
 * Warum nicht oefter: eine Belegungsschwelle, die mittags ueberschritten
 * wird, greift erst am naechsten Geschaeftstag -- dafuer aendert sich ein
 * Preis an einem Tag hoechstens einmal, und die Schrittgrenze heisst, was
 * sie sagt: je Tag. Wer sofort reagieren will, uebernimmt aus der Vorschau.
 */
export async function runRateSteering(
  pool: Pool, ctx: DbContext, propertyId: number
): Promise<RateSteeringResult> {
  return withTransaction(pool, ctx, async client => {
    const r = await client.query<{
      run_id: number | null; changed: number; business_date: string | null }>(
      `SELECT run_id, changed, business_date::text
         FROM rate_steer_apply($1, 'auto', NULL, NULL, NULL, NULL, NULL)`,
      [propertyId])
    const e = r.rows[0]!
    return { runId: e.run_id, changed: e.changed, businessDate: e.business_date }
  })
}
