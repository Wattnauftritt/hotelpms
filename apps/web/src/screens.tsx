import type { JSX } from 'react'
import type { TextKey } from './lib/i18n/index.js'
import { Tape } from './routes/Tape.tsx'
import { Today } from './routes/Today.tsx'
import { Housekeeping } from './routes/Housekeeping.tsx'
import { Reinigungsplan } from './routes/Reinigungsplan.tsx'
import { Fruehstueck } from './routes/Fruehstueck.tsx'
import { Arbeitszeit } from './routes/Arbeitszeit.tsx'
import { Blocks } from './routes/Blocks.tsx'
import { Setup } from './routes/Setup.tsx'
import { Reports } from './routes/Reports.tsx'
import { Maintenance } from './routes/Maintenance.tsx'
import { Settings } from './routes/Settings.tsx'
import { Integrations } from './routes/Integrations.tsx'
import { Benutzer } from './routes/Benutzer.tsx'
import { Rates } from './routes/Rates.tsx'
import { Guests } from './routes/Guests.tsx'
import { Availability } from './routes/Availability.tsx'
import { Invoices } from './routes/Invoices.tsx'
import { Adminpanel } from './routes/Adminpanel.tsx'
import { TerminalPult } from './routes/TerminalPult.tsx'
import { Datenuebernahme } from './routes/Datenuebernahme.tsx'
import { Meldescheine } from './routes/Meldescheine.tsx'
import { Kassenbuch } from './routes/Kassenbuch.tsx'
import { NachBreite } from './components/mobil/NachBreite.tsx'
import { MobilHeute } from './components/mobil/MobilHeute.tsx'
import { MobilPlan } from './components/mobil/MobilPlan.tsx'
import { MobilZimmer } from './components/mobil/MobilZimmer.tsx'
import { MobilKasse } from './components/mobil/MobilKasse.tsx'

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
  /**
   * Die Rechte dieses Benutzers in diesem Haus.
   *
   * Sie stehen in der Antwort von `/v1/auth/me`, die der Rahmen ohnehin
   * beim Start holt. Ein Bildschirm kam bisher nicht an sie heran und las
   * deshalb denselben Zwischenspeicher noch einmal — was ging, aber eine
   * Umgehung war: der Rahmen wusste es und reichte es nicht weiter.
   *
   * Sie stehen hier und nicht nur am Eintrag, weil beides verschiedene
   * Fragen sind. `permission` entscheidet, **ob** ein Bildschirm erscheint;
   * das hier entscheidet, **was darin** erscheint. Die Rechnungsliste zeigt
   * jedem mit `folio:read` die Rechnungen und den Versandknopf nur dem mit
   * `email:send`.
   *
   * Sicherheit ist das nicht — die liegt in der API und nirgends sonst.
   * Es ist Brauchbarkeit: kein Knopf, der mit 403 antwortet.
   */
  permissions: readonly string[]
  /**
   * Der angemeldete Benutzer. Das Adminpanel braucht ihn, um den eigenen
   * Zugang in der Personalliste zu erkennen — ein Knopf, der nur mit 409
   * antwortet, ist eine Falle und keine Sicherung.
   */
  userId: number | null
  /**
   * Die Rechte auf der Plattform. Sie hängen an keinem Haus und stehen
   * deshalb neben `permissions`, nicht darin.
   */
  platformPermissions: readonly string[]
  /** Das Folio liegt über dem Tagesgeschäft, nicht daneben. */
  openFolio: (folioRef: string) => void
  /** Der Check-in liegt ebenso über dem jeweiligen Bildschirm, meist dem Plan (A9). */
  openCheckIn: (reservationRef: string) => void
}

/** Die Menues der Leiste; was sie anzeigen und wo, steht in der Shell. */
export type Gruppe = 'settings' | 'housekeeping'

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
  /**
   * Nur fuer Plattformpersonal, unabhaengig von jedem Recht an einem Haus.
   *
   * Die Plattformrechte haengen nicht an einer Property -- `permissions`
   * oben sind die Rechte **in diesem Haus**, und dort steht
   * `platform:accounts` nie. Ohne dieses Merkmal waere das Adminpanel
   * entweder fuer jeden sichtbar oder fuer niemanden.
   */
  platformStaff?: boolean
  /**
   * Steht nicht vorn in der Leiste, sondern im Menue „Einstellungen".
   *
   * Einrichtung, Wartung, Einstellungen, Datenuebernahme und die
   * Gaesteterminals braucht man selten, und vorn nahmen sie fuenf Plaetze
   * neben dem Tagesgeschaeft weg (Sven, 04.10.2026). Das Menue aendert
   * weder Schluessel noch Rechte: die Liste hier bleibt flach, damit
   * Lesezeichen und `resolveScreen` gleich bleiben; nur die Leiste fasst
   * zusammen.
   *
   * „housekeeping" fasst Zimmerstand, Reinigungsplan, Fruehstueck und
   * Arbeitszeit unter einem Platz vorn in der Leiste zusammen (Sven,
   * 09.10.2026). Anders als die Einstellungen steht dieses Menue an seiner
   * Stelle in der Reihenfolge, nicht am rechten Rand.
   */
  group?: Gruppe
  render: (ctx: ScreenContext) => JSX.Element
}

export const SCREENS: readonly ScreenDefinition[] = [
  // Die ersten drei haben am Telefon eine eigene Fassung (`lib/mobil.ts`).
  { key: 'tape', nav: 'nav.tape', permission: 'reservation:read',
    render: c => <NachBreite schmal={() => <MobilPlan propertyId={c.propertyId} />}
                             breit={() => <Tape propertyId={c.propertyId} onFolio={c.openFolio}
                                                onCheckIn={c.openCheckIn} />} /> },
  { key: 'today', nav: 'nav.today', permission: 'reservation:read',
    render: c => <NachBreite schmal={() => <MobilHeute propertyId={c.propertyId}
                                                       onFolio={c.openFolio}
                                                       onCheckIn={c.openCheckIn} />}
                             breit={() => <Today propertyId={c.propertyId}
                                                 onFolio={c.openFolio}
                                                 onCheckIn={c.openCheckIn} />} /> },
  { key: 'housekeeping', nav: 'nav.housekeeping', permission: 'housekeeping:read',
    group: 'housekeeping',
    render: c => <NachBreite schmal={() => <MobilZimmer propertyId={c.propertyId} />}
                             breit={() => <Housekeeping propertyId={c.propertyId}
                                                        permissions={c.permissions} />} /> },
  { key: 'blocks', nav: 'nav.blocks', permission: 'inventory:read',
    render: c => <Blocks propertyId={c.propertyId} /> },
  { key: 'setup', group: 'settings', nav: 'nav.setup', permission: 'settings:property',
    render: c => <Setup propertyId={c.propertyId} /> },
  { key: 'reports', nav: 'nav.reports',
    permission: ['report:operational', 'report:revenue', 'report:export'],
    render: c => <Reports propertyId={c.propertyId} /> },
  { key: 'maintenance', group: 'settings', nav: 'nav.maintenance',
    permission: ['housekeeping:read', 'maintenance:write'],
    render: c => <Maintenance propertyId={c.propertyId} /> },
  { key: 'settings', group: 'settings', nav: 'nav.settingsGeneral',
    permission: ['integration:manage', 'settings:property'],
    render: c => <Settings propertyId={c.propertyId} /> },
  { key: 'integrations', group: 'settings', nav: 'nav.integrations', permission: 'integration:manage',
    render: c => <Integrations propertyId={c.propertyId} /> },
  // Personal einladen, Rollen vergeben, sperren. Stand frueher als Reiter
  // unter „Schnittstellen" und wurde dort nicht gefunden.
  { key: 'users', group: 'settings', nav: 'nav.users', permission: 'user:manage',
    render: c => <Benutzer propertyId={c.propertyId} /> },
  { key: 'rates', nav: 'nav.rates', permission: 'rate:read',
    render: c => <Rates propertyId={c.propertyId} permissions={c.permissions} /> },
  { key: 'guests', nav: 'nav.guests', permission: 'guest:read',
    render: c => <Guests propertyId={c.propertyId} /> },
  { key: 'availability', nav: 'nav.availability', permission: 'reservation:read',
    render: c => <Availability propertyId={c.propertyId} /> },
  { key: 'invoices', nav: 'nav.invoices', permission: 'folio:read',
    render: c => <Invoices propertyId={c.propertyId} onFolio={c.openFolio}
                           permissions={c.permissions} /> },
  // Alle Meldescheine eines Zeitraums (Sven, 04.10.2026). Dasselbe Recht wie
  // die Liste der Schnittstelle, die er liest.
  { key: 'registrations', nav: 'nav.registrations', permission: 'report:operational',
    render: c => <Meldescheine propertyId={c.propertyId} /> },
  // Kassenbuch (Dokument 09, 0095). Ob es eingeschaltet ist, zeigt der
  // Bildschirm selbst; wer es einschalten darf, braucht ihn auch ausgeschaltet.
  // Am Telefon eine eigene Fassung: dort wird vor allem ein Bon fotografiert.
  { key: 'cashbook', nav: 'nav.cashbook', permission: 'cashbook:read',
    render: c => <NachBreite schmal={() => <MobilKasse propertyId={c.propertyId}
                                                       permissions={c.permissions} />}
                             breit={() => <Kassenbuch propertyId={c.propertyId}
                                                      permissions={c.permissions} />} /> },
  // Gaesteterminals: Seiten und Adressen ohne Reservierung zeigen (Dokument 31).
  { key: 'terminal', group: 'settings', nav: 'nav.terminal', permission: 'reservation:checkin',
    render: c => <TerminalPult propertyId={c.propertyId} /> },
  /*
   * Das Adminpanel steht am Ende und nicht am Anfang: es ist der einzige
   * Bildschirm, der nicht zum Haus gehoert, und es soll nie der
   * Startbildschirm sein, nur weil jemand zufaellig beides darf.
   */
  { key: 'admin', nav: 'nav.admin', permission: null, platformStaff: true,
    render: c => <Adminpanel userId={c.userId}
                             platformPermissions={c.platformPermissions} /> },
  // Uebernahme aus Altsystemen, zuerst KWHotel. Einrichtung, kein Tagesgeschaeft.
  { key: 'import', group: 'settings', nav: 'nav.import', permission: 'settings:property',
    render: () => <Datenuebernahme /> },
  // Zimmer den Reinigungskraeften zuteilen (0106). Angehaengt, nicht hinter
  // Housekeeping eingefuegt: an den Schluesseln davor haengen Lesezeichen,
  // und die Hausdame beginnt weiter mit dem Zimmerstand.
  { key: 'cleaningPlan', group: 'housekeeping', nav: 'nav.cleaningPlan', permission: 'housekeeping:plan',
    render: c => <Reinigungsplan propertyId={c.propertyId} /> },
  // „inspection" (Kontrolle) steht seit 09.10.2026 im Housekeeping; die
  // alte Adresse fuehrt dorthin (`UMGEZOGEN`).
  { key: 'breakfast', group: 'housekeeping', nav: 'nav.breakfast', permission: 'kitchen:breakfast',
    render: c => <Fruehstueck propertyId={c.propertyId} /> },
  { key: 'worktime', group: 'housekeeping', nav: 'nav.worktime', permission: 'worktime:manage',
    render: c => <Arbeitszeit propertyId={c.propertyId} /> }
]

/**
 * Bildschirme, die in einem anderen aufgegangen sind.
 *
 * Ein Lesezeichen auf die alte Adresse soll dort ankommen, wo die Arbeit
 * jetzt steht, und nicht still auf dem Zimmerplan.
 */
const UMGEZOGEN: Readonly<Record<string, string>> = {
  inspection: 'housekeeping'
}

/** Die Bildschirme, die dieser Benutzer in diesem Haus benutzen darf. */
export function visibleScreens(
  permissions: readonly string[], platformStaff = false
): ScreenDefinition[] {
  return SCREENS.filter(s => {
    // Ein Plattformbildschirm folgt nicht den Rechten am Haus, sondern nur
    // dem Kennzeichen. Umgekehrt taucht er bei niemandem sonst auf.
    if (s.platformStaff === true) return platformStaff
    return s.permission === null ||
      (typeof s.permission === 'string'
        ? permissions.includes(s.permission)
        : s.permission.some(p => permissions.includes(p)))
  })
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
 * `start` ist ein Wunsch fuer den Fall ohne Adresse: am Telefon beginnt
 * man mit "Heute" und nicht mit dem Zimmerplan, den der Desktop zuerst
 * zeigt. Ist er nicht erlaubt, gilt wieder der erste erlaubte.
 *
 * Ein unbekannter oder verbotener Schluessel in der Adresse fuehrt still
 * zurueck statt in eine Fehlerseite. Ein Lesezeichen ueberlebt damit sowohl
 * eine Umbenennung als auch den Entzug eines Rechts.
 */
export function resolveScreen(
  adresse: string | null, permissions: readonly string[], platformStaff = false,
  start: string | null = null
): ScreenDefinition | undefined {
  const erlaubt = visibleScreens(permissions, platformStaff)
  const ziel = adresse === null ? null : UMGEZOGEN[adresse] ?? adresse
  return erlaubt.find(s => s.key === ziel)
    ?? erlaubt.find(s => s.key === start) ?? erlaubt[0]
}
