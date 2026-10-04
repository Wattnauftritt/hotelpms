/**
 * Zimmer nach Nummer sortiert, wie ein Mensch zaehlt: 2 vor 10.
 *
 * `ORDER BY r.code` sortiert Text, und Text stellt "10" vor "2" und "601"
 * vor "7". In einem Haus mit dreistelligen Nummern faellt das nicht auf,
 * in einem mit gemischten (1 bis 12, dazu 601 bis 605 im Gaestehaus) steht
 * der Plan "kreuz und quer" (Sven, 04.10.2026).
 *
 * Erst die fuehrende Zahl als Zahl, dann der ganze Text: "12a" folgt auf
 * "12", "A1" (ohne fuehrende Ziffer) steht hinter allen Nummern. `numeric`
 * und nicht `int`, damit eine ueberlange Ziffernfolge nicht ueberlaeuft.
 * Keine Backticks in diesem Ausdruck: er wird in Template-Literale gesetzt.
 */
export const zimmerNachNummer = (alias: string): string =>
  `NULLIF(substring(${alias}.code from '^[0-9]+'), '')::numeric NULLS LAST, ${alias}.code`
