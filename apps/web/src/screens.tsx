import { lazy, type ComponentType, type JSX, type LazyExoticComponent } from 'react'
import type { TextKey } from './lib/i18n/index.js'
import { NachBreite } from './components/mobil/NachBreite.tsx'

/**
 * Ein Bildschirm, der erst beim ersten Oeffnen geladen wird.
 *
 * Vorher stand jeder Bildschirm hier als statischer Import, und die
 * Rezeption lud beim Anmelden gut ein Megabyte JavaScript: Adminpanel,
 * Kassenbuch, Preissteuerung, Datenuebernahme -- auch an einem Platz, an dem
 * niemand je das Recht dazu hat (Performance-Audit 11.10.2026, Befund 10).
 * Jetzt holt der erste Klick die Datei des Bildschirms; die Grenze dafuer
 * steht in `main.tsx` (`Nachladen`).
 *
 * Benannte Exporte, weil die Bildschirme so gebaut sind; `lazy` verlangt
 * einen `default`, den diese Huelle nachreicht. Der Name steht als
 * Zeichenkette da, aber `keyof` haelt ihn an den Exporten der Datei fest:
 * ein Tippfehler ist ein Typfehler, kein leerer Bildschirm.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dieselbe Schranke wie `lazy` selbst
function faul<M extends Record<K, ComponentType<any>>, K extends keyof M>(
  laden: () => Promise<M>, name: K
): LazyExoticComponent<M[K]> {
  return lazy(async () => ({ default: (await laden())[name] }))
}

const Tape = faul(() => import('./routes/Tape.tsx'), 'Tape')
const Today = faul(() => import('./routes/Today.tsx'), 'Today')
const Housekeeping = faul(() => import('./routes/Housekeeping.tsx'), 'Housekeeping')
const Reinigungsplan = faul(() => import('./routes/Reinigungsplan.tsx'), 'Reinigungsplan')
const Fruehstueck = faul(() => import('./routes/Fruehstueck.tsx'), 'Fruehstueck')
const Arbeitszeit = faul(() => import('./routes/Arbeitszeit.tsx'), 'Arbeitszeit')
const Blocks = faul(() => import('./routes/Blocks.tsx'), 'Blocks')
const Setup = faul(() => import('./routes/Setup.tsx'), 'Setup')
const Reports = faul(() => import('./routes/Reports.tsx'), 'Reports')
const Maintenance = faul(() => import('./routes/Maintenance.tsx'), 'Maintenance')
const Settings = faul(() => import('./routes/Settings.tsx'), 'Settings')
const Integrations = faul(() => import('./routes/Integrations.tsx'), 'Integrations')
const Benutzer = faul(() => import('./routes/Benutzer.tsx'), 'Benutzer')
const Rates = faul(() => import('./routes/Rates.tsx'), 'Rates')
const Guests = faul(() => import('./routes/Guests.tsx'), 'Guests')
const Availability = faul(() => import('./routes/Availability.tsx'), 'Availability')
const Invoices = faul(() => import('./routes/Invoices.tsx'), 'Invoices')
const Adminpanel = faul(() => import('./routes/Adminpanel.tsx'), 'Adminpanel')
const TerminalPult = faul(() => import('./routes/TerminalPult.tsx'), 'TerminalPult')
const Datenuebernahme = faul(() => import('./routes/Datenuebernahme.tsx'), 'Datenuebernahme')
const Meldescheine = faul(() => import('./routes/Meldescheine.tsx'), 'Meldescheine')
const Kassenbuch = faul(() => import('./routes/Kassenbuch.tsx'), 'Kassenbuch')
const MobilHeute = faul(() => import('./components/mobil/MobilHeute.tsx'), 'MobilHeute')
const MobilPlan = faul(() => import('./components/mobil/MobilPlan.tsx'), 'MobilPlan')
const MobilZimmer = faul(() => import('./components/mobil/MobilZimmer.tsx'), 'MobilZimmer')
const MobilKasse = faul(() => import('./components/mobil/MobilKasse.tsx'), 'MobilKasse')

/*
 * Was `main.tsx` ueber den Bildschirmen oeffnet, ebenso erst bei Bedarf:
 * das Folio, der Check-in und das Adminpanel ohne Haus. Sie stehen hier,
 * damit die Liste der nachgeladenen Teile an einer Stelle liegt.
 */
export const Folio = faul(() => import('./routes/Folio.tsx'), 'Folio')
export const CheckIn = faul(() => import('./routes/CheckIn.tsx'), 'CheckIn')
export const AdminpanelSeite = faul(() => import('./routes/Adminpanel.tsx'), 'AdminpanelSeite')

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
    render: c => <Meldescheine propertyId={c.propertyId} permissions={c.permissions} /> },
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
