/**
 * Die Reihenfolge in der Leiste und in den Menues (Sven, 09.10.2026).
 *
 * Sie steht getrennt von `SCREENS` (und in eigener Datei, damit die Shell
 * sie ohne die Bildschirme laden kann), weil dort nur angehaengt wird
 * (Dokument 20): die Liste ist die Stelle, an der parallele Arbeit sich
 * sonst in die Quere kommt, und ihr Anfang entscheidet, welcher Bildschirm
 * ohne Adresse erscheint. Ein neuer Bildschirm, der hier fehlt, steht
 * hinten -- sichtbar, nur noch nicht einsortiert.
 */
export const REIHENFOLGE: readonly string[] = [
  'tape', 'today',
  'housekeeping', 'cleaningPlan', 'breakfast', 'worktime',
  'blocks', 'guests', 'registrations', 'invoices', 'reports', 'availability', 'rates',
  'cashbook',
  // Einstellungen
  'setup', 'settings', 'maintenance', 'users', 'terminal', 'integrations', 'import'
]

/** Sortiert nach `REIHENFOLGE`; was dort fehlt, behaelt hinten seine Reihenfolge. */
export function inLeistenReihenfolge<S extends { key: string }>(screens: readonly S[]): S[] {
  const rang = (s: S): number => {
    const i = REIHENFOLGE.indexOf(s.key)
    return i === -1 ? REIHENFOLGE.length : i
  }
  return screens.map((s, i) => ({ s, i }))
    .sort((a, b) => rang(a.s) - rang(b.s) || a.i - b.i)
    .map(x => x.s)
}
