import type { MessageLocale } from '@hotelpms/contracts'
import { nativ, type Kurzbefehl } from '@hotelpms/native'
import lader from 'virtual:sprachpaket/kurzbefehle'
import type { kurzbefehle, KurzbefehlKey } from './i18n/kurzbefehle.js'
import { Sprachpakete } from './sprachpaket.js'

/**
 * Schnellaktionen am App-Symbol (Plan app/plan.md, „Schnellaktionen“; Sven,
 * 20.10.2026). Eine App fuer alle: welche Aktionen das Symbol traegt, folgt
 * den Rechten der Person, nicht einer zweiten App.
 *
 * **Rang statt Mischung.** iOS und Android zeigen hoechstens vier. Wer
 * mehrere Rollen hat, bekommt zuerst die der hoeheren -- Rezeption vor
 * Hausdame vor Reinigung vor Kueche --, und erst was dann frei ist, fuellen
 * die naechsten auf. Jede Aktion fragt ihr eigenes Recht ab: eine
 * Rezeptionskraft ohne Kassenbuch bekommt kein Kassenbuch, sondern die
 * naechste Aktion.
 *
 * **Ein Pfad, keine Adresse.** Das Ziel ist ein Pfad dieser App, wie ihn
 * die Adresszeile ohnehin kennt (`?screen=`); die Huelle oeffnet nichts
 * anderes. Ohne Haus: es gilt das zuletzt gewaehlte, wie beim Oeffnen.
 */

interface Eintrag {
  id: string
  text: KurzbefehlKey
  symbol: Kurzbefehl['symbol']
  /** Alle noetig, in irgendeinem Haus. */
  rechte: readonly string[]
  pfad: string
}

const ROLLEN: ReadonlyArray<{ rolle: string; aktionen: readonly Eintrag[] }> = [
  { rolle: 'reservation:read', aktionen: [
    { id: 'anreisen', text: 'kurzbefehl.arrivals', symbol: 'heute',
      rechte: ['reservation:read'], pfad: '/?screen=today' },
    { id: 'kalender', text: 'kurzbefehl.calendar', symbol: 'kalender',
      rechte: ['reservation:read'], pfad: '/?screen=tape' },
    { id: 'kassenbuch', text: 'kurzbefehl.cashbook', symbol: 'kasse',
      rechte: ['cashbook:read'], pfad: '/?screen=cashbook' },
    { id: 'visitenkarte', text: 'kurzbefehl.businessCard', symbol: 'kamera',
      rechte: ['guest:write'], pfad: '/?screen=guests&kurzbefehl=visitenkarte' }
  ] },
  // Die Kontrolle macht die Hausdame am Telefon in der Personal-App; ohne
  // `staff:app` steht sie im Housekeeping der Rezeption.
  { rolle: 'housekeeping:plan', aktionen: [
    { id: 'kontrolle', text: 'kurzbefehl.inspection', symbol: 'pruefen',
      rechte: ['housekeeping:inspect', 'staff:app'], pfad: '/personal?reiter=kontrolle' },
    { id: 'kontrolleRezeption', text: 'kurzbefehl.inspection', symbol: 'pruefen',
      rechte: ['housekeeping:inspect'], pfad: '/?screen=housekeeping' },
    { id: 'reinigungsplan', text: 'kurzbefehl.cleaningPlan', symbol: 'plan',
      rechte: ['housekeeping:plan'], pfad: '/?screen=cleaningPlan' }
  ] },
  { rolle: 'staff:app', aktionen: [
    { id: 'zimmer', text: 'kurzbefehl.myRooms', symbol: 'zimmer',
      rechte: ['staff:app'], pfad: '/personal' },
    { id: 'zusatzarbeit', text: 'kurzbefehl.extraWork', symbol: 'eintragen',
      rechte: ['staff:app'], pfad: '/personal?reiter=zeit' }
  ] },
  { rolle: 'kitchen:breakfast', aktionen: [
    { id: 'fruehstueck', text: 'kurzbefehl.breakfast', symbol: 'kueche',
      rechte: ['kitchen:breakfast', 'staff:app'], pfad: '/personal?reiter=kueche' },
    { id: 'fruehstueckRezeption', text: 'kurzbefehl.breakfast', symbol: 'kueche',
      rechte: ['kitchen:breakfast'], pfad: '/?screen=breakfast' }
  ] },
  { rolle: 'worktime:manage', aktionen: [
    { id: 'arbeitszeit', text: 'kurzbefehl.worktime', symbol: 'zeit',
      rechte: ['worktime:manage'], pfad: '/?screen=worktime' }
  ] }
]

const HOECHSTENS = 4

/**
 * Die Titel der Aktionen, je Sprache ein kleines Paket. Ein eigenes und
 * nicht das der Oberflaeche: auch die Personal-App setzt sie, und die holt
 * den Katalog der Rezeption nicht. Im Browser gibt es kein App-Symbol, dort
 * wird gar nichts geholt.
 */
export const titelTexte = new Sprachpakete<MessageLocale>(lader)
type Titel = keyof typeof kurzbefehle

export function kurzbefehleFuer(
  properties: ReadonlyArray<{ permissions: readonly string[] }>, locale: MessageLocale
): Kurzbefehl[] {
  // Je Haus, nicht ueber alle zusammen: wer im Hotel kassiert und im
  // Gaestehaus reinigt, hat im Gaestehaus kein Kassenbuch -- die Aktion
  // braucht nur ein Haus, in dem alle ihre Rechte zusammenkommen.
  const darf = (rechte: readonly string[]): boolean =>
    properties.some(p => rechte.every(r => p.permissions.includes(r)))
  const liste: Kurzbefehl[] = []
  const texte = new Set<string>()
  for (const { rolle, aktionen } of ROLLEN) {
    if (!darf([rolle])) continue
    for (const a of aktionen) {
      // Kontrolle und Fruehstueck haben zwei Ziele; das erste passende gilt.
      if (liste.length >= HOECHSTENS || texte.has(a.text) || !darf(a.rechte)) continue
      texte.add(a.text)
      const titel = titelTexte.paket(locale)?.[a.text satisfies Titel] ?? a.text
      liste.push({ id: a.id, titel, pfad: a.pfad, symbol: a.symbol })
    }
  }
  return liste
}

/**
 * Nach jedem Anmelden und Start setzen, nach dem Abmelden leeren. Scheitert
 * es, bleibt die alte Liste stehen; mehr als ein Umweg ueber das App-Symbol
 * haengt daran nicht, und ein Pfad fuehrt nur dahin, wo die Sitzung ohnehin
 * hindarf.
 */
export function kurzbefehleSetzen(liste: readonly Kurzbefehl[]): void {
  void nativ()?.kurzbefehle?.setzen(liste).catch(() => { /* naechster Start */ })
}

/** Die Aktionen nach den Rechten setzen, sobald ihre Titel in der Sprache da sind. */
export function kurzbefehleAktualisieren(
  properties: ReadonlyArray<{ permissions: readonly string[] }>, locale: MessageLocale
): void {
  if (nativ()?.kurzbefehle === undefined) return
  titelTexte.laden(locale)
    .then(() => kurzbefehleSetzen(kurzbefehleFuer(properties, locale)))
    .catch(() => { /* naechster Start */ })
}
