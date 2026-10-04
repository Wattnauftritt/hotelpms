import { useSchmal } from '../../lib/mobil.js'

/**
 * Am Telefon die Mobilfassung eines Bildschirms, sonst die gewohnte.
 *
 * Als Funktionen und nicht als fertige Elemente: gebaut wird nur die eine
 * Fassung, die gezeigt wird -- sonst holte der Desktop-Plan seine 60 Tage
 * auch auf dem Telefon, nur um sie wegzuwerfen.
 */
export function NachBreite({ schmal, breit }: {
  schmal: () => JSX.Element; breit: () => JSX.Element
}): JSX.Element {
  return useSchmal() ? schmal() : breit()
}
