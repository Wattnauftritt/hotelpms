import type { JSX } from 'react'
import type { TextKey } from './lib/i18n/index.js'
import { Tape } from './routes/Tape.tsx'
import { Today } from './routes/Today.tsx'
import { Housekeeping } from './routes/Housekeeping.tsx'
import { Blocks } from './routes/Blocks.tsx'
import { Setup } from './routes/Setup.tsx'
import { Reports } from './routes/Reports.tsx'
import { Maintenance } from './routes/Maintenance.tsx'
import { Settings } from './routes/Settings.tsx'
import { Integrations } from './routes/Integrations.tsx'
import { Rates } from './routes/Rates.tsx'

/**
 * Das Verzeichnis der Bildschirme.
 *
 * **Warum es das gibt.** Vorher stand die Liste an drei Stellen: als
 * Aufzählungstyp in der Shell, als Navigationsleiste daneben und als Kette
 * von `screen === '…' && <X />` in `main.tsx`. Einen Bildschirm hinzuzufügen
 * hieß, alle drei zu ändern — und wenn drei Bearbeiter das gleichzeitig tun,
 * ändern alle drei dieselben Zeilen. Das ist im Frontend genau das, was die
 * Migrationsnummer im Schema ist: die eine Stelle, an der sie sich
 * zuverlässig in die Quere kommen.
 *
 * Hier ist es **eine** Zeile je Bildschirm, und die Zeilen liegen
 * untereinander. Zwei Bearbeiter, die je eine anhängen, erzeugen keinen
 * Konflikt, den jemand von Hand auflösen muss.
 *
 * **Die Berechtigung steht am Bildschirm.** Wer ein Recht nicht hat, sieht
 * den Eintrag nicht — statt ihn zu sehen, zu klicken und eine 403 zu
 * bekommen. Das ist keine Sicherheitsmaßnahme (die liegt in der API und
 * nirgends sonst), sondern eine Frage der Brauchbarkeit: eine Rezeption
 * braucht keinen Knopf, den sie nicht drücken darf.
 */

export interface ScreenContext {
  propertyId: number
  /** Das Folio liegt über dem Tagesgeschäft, nicht daneben. */
  openFolio: (folioRef: string) => void
}

export interface ScreenDefinition {
  /** Steht so in der Adresse: `?screen=tape`. Nie umbenennen, es gibt Lesezeichen. */
  key: string
  nav: TextKey
  /**
   * Ohne dieses Recht erscheint der Bildschirm nicht in der Navigation.
   * `null` heißt: für jeden sichtbar, der überhaupt angemeldet ist.
   *
   * Eine Liste heißt **eines davon genügt**. Das gibt es, weil ein
   * Bildschirm mehrere Bereiche bündeln kann: die Berichte zeigen Betrieb,
   * Umsatz und Ausgaben, und wer nur eines davon darf, soll sie trotzdem
   * sehen — und darin nur seinen Bereich. Mit einem einzelnen Recht wäre
   * entweder die Rezeption oder das Revenue Management ausgesperrt.
   */
  permission: string | readonly string[] | null
  render: (ctx: ScreenContext) => JSX.Element
}

export const SCREENS: readonly ScreenDefinition[] = [
  { key: 'tape', nav: 'nav.tape', permission: 'reservation:read',
    render: c => <Tape propertyId={c.propertyId} onFolio={c.openFolio} /> },
  { key: 'today', nav: 'nav.today', permission: 'reservation:read',
    render: c => <Today propertyId={c.propertyId} onFolio={c.openFolio} /> },
  { key: 'housekeeping', nav: 'nav.housekeeping', permission: 'housekeeping:read',
    render: c => <Housekeeping propertyId={c.propertyId} /> },
  { key: 'blocks', nav: 'nav.blocks', permission: 'inventory:read',
    render: c => <Blocks propertyId={c.propertyId} /> },
  { key: 'setup', nav: 'nav.setup', permission: 'settings:property',
    render: c => <Setup propertyId={c.propertyId} /> },
  { key: 'reports', nav: 'nav.reports',
    permission: ['report:operational', 'report:revenue', 'report:export'],
    render: c => <Reports propertyId={c.propertyId} /> },
  { key: 'maintenance', nav: 'nav.maintenance',
    permission: ['housekeeping:read', 'maintenance:write'],
    render: c => <Maintenance propertyId={c.propertyId} /> },
  { key: 'settings', nav: 'nav.settings',
    permission: ['integration:manage', 'settings:property'],
    render: c => <Settings propertyId={c.propertyId} /> },
  { key: 'integrations', nav: 'nav.integrations',
    permission: ['integration:manage', 'user:manage'],
    render: c => <Integrations propertyId={c.propertyId} /> },
  { key: 'rates', nav: 'nav.rates', permission: 'rate:read',
    render: c => <Rates propertyId={c.propertyId} /> }
]

/** Die Bildschirme, die dieser Benutzer in diesem Haus benutzen darf. */
export function visibleScreens(permissions: readonly string[]): ScreenDefinition[] {
  return SCREENS.filter(s =>
    s.permission === null ||
    (typeof s.permission === 'string'
      ? permissions.includes(s.permission)
      : s.permission.some(p => permissions.includes(p))))
}

export function screenByKey(key: string | null): ScreenDefinition | undefined {
  return SCREENS.find(s => s.key === key)
}

/**
 * Welcher Bildschirm gezeigt wird.
 *
 * Der aus der Adresse, sofern er existiert und erlaubt ist; sonst der erste
 * erlaubte. Bewusst **kein** fester Startbildschirm: ein Housekeeping-Konto
 * hat auf dem Zimmerplan nichts zu suchen und bekaeme dort nur eine 403.
 *
 * Ein unbekannter oder verbotener Schluessel in der Adresse fuehrt still
 * zurueck statt in eine Fehlerseite. Ein Lesezeichen ueberlebt damit sowohl
 * eine Umbenennung als auch den Entzug eines Rechts.
 */
export function resolveScreen(
  adresse: string | null, permissions: readonly string[]
): ScreenDefinition | undefined {
  const erlaubt = visibleScreens(permissions)
  return erlaubt.find(s => s.key === adresse) ?? erlaubt[0]
}
