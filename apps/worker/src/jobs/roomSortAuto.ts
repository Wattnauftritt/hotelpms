import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { roomSortRunDue, type RoomSortDueResult } from '@hotelpms/domain'

/**
 * Zimmer sortieren im Modus `auto` (Gaestehaus), gebuendelt im Worker.
 *
 * **Warum hier und nicht im Push.** Bis zum Performance-Audit vom
 * 11.10.2026 (Befund 6) sortierte jeder Kanal-Push am Ende ein ganzes Jahr,
 * unter Zeilensperre und als Rechenarbeit auf dem einen Faden der API. Der
 * Push sortiert jetzt nur noch die Umgebung seiner Buchung -- damit das
 * Zimmer in seiner Antwort steht -- und merkt das Haus vor
 * (`room_sort_due`, Migration 0141). Das Jahr sortiert dieser Lauf, wenn
 * eine Minute lang kein Push mehr kam, und spaetestens zehn Minuten nach dem
 * ersten Vermerk. Der Abgleich des Adminpanels schickt alle fuenf Minuten
 * mehrere Pushes hintereinander; einer danach genuegt.
 *
 * Es gelten dieselben Regeln wie am Knopf und im Push, weil es derselbe
 * Code ist (`@hotelpms/domain`, `roomSortRun.ts`): ein Zug ist keine
 * Aenderung der Rezeption (`app.room_sort`), wer heute anreist, wird bis
 * zum Check-in mitsortiert, und jeder Lauf steht als `auto` in
 * `room_sort_run` und laesst sich zuruecknehmen.
 *
 * Ein Fehler haelt die uebrige Arbeit des Hauses nicht auf: die Zimmer
 * bleiben dann, wie sie sind, der Vermerk mit der Transaktion stehen, und
 * der naechste Tick versucht es neu.
 */
export async function sortDueRooms(
  pool: Pool, ctx: DbContext, propertyId: number,
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }
): Promise<RoomSortDueResult | null> {
  try {
    const r = await withTransaction(pool, ctx, client => roomSortRunDue(client, propertyId))
    // Zahlen, kein Gast und kein Zimmer.
    if (r.sorted) log.info({ property: propertyId, moved: r.moved }, 'Zimmer automatisch sortiert')
    return r
  } catch (e) {
    log.error({ property: propertyId, err: e }, 'Automatisches Sortieren fehlgeschlagen')
    return null
  }
}
