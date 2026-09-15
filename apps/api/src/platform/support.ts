import type { Permission } from './permissions.js'

/**
 * Was eine Support-Sitzung darf.
 *
 * **Der Grundsatz.** Plattformpersonal hat ohne freigegebene Sitzung einen
 * leeren Mandantenkontext; die Zeilenrichtlinie liefert dann nichts. Mit
 * Sitzung bekommt es **nicht** die Rechte des Kunden, sondern die hier
 * aufgezaehlten -- Datenminimierung nach Art. 5 Abs. 1 lit. c DSGVO heisst
 * nicht "so wenig wie moeglich", sondern "nicht mehr als noetig fuer den
 * Zweck", und der Zweck steht als Anlass an der Sitzung.
 *
 * Die Liste ist **positiv**: was hier nicht steht, geht nicht. Eine
 * Sperrliste waere die falsche Bauart -- ein spaeter hinzugefuegtes Recht
 * waere darin automatisch erlaubt, und das faellt niemandem auf.
 */

/**
 * Lesen. Die Stufe, die fuer eine Fehlersuche genuegt und deshalb die
 * Vorgabe ist.
 */
const LESEN: readonly Permission[] = [
  'reservation:read',
  // Name und Kontakt gehoeren dazu: ohne sie ist eine Reservierung eine
  // Zeile ohne Bezug, und "die Buchung von Frau Meier stimmt nicht" laesst
  // sich nicht nachvollziehen.
  'guest:read',
  'folio:read',
  'rate:read',
  'inventory:read',
  'housekeeping:read',
  'report:operational'
]

/**
 * Schreiben. Nur, wenn der Kunde ausdruecklich diese Stufe freigibt -- etwa
 * weil er um eine Korrektur gebeten hat, die er selbst nicht hinbekommt.
 */
const SCHREIBEN: readonly Permission[] = [
  ...LESEN,
  'reservation:write',
  'reservation:checkin',
  'folio:post',
  'folio:void_any',
  'rate:write',
  'inventory:write',
  'housekeeping:write',
  'maintenance:write',
  'settings:property'
]

/**
 * Was **keine** Stufe je enthaelt, und warum jedes Einzelne fehlt.
 *
 * Diese Liste ist Dokumentation, keine Pruefung -- geprueft wird ueber die
 * positiven Listen oben. Sie steht hier, damit beim naechsten "kann Support
 * bitte auch ..." die Begruendung danebensteht und nicht neu erfunden wird:
 *
 *   guest:read_identity  Ausweisdaten. § 30 BMG erlaubt die Nummer fuer den
 *                        Meldeschein, nicht fuer die Fehlersuche. Wer eine
 *                        Reservierung repariert, braucht keine Passnummer.
 *   guest:export         Stoesst DSGVO-Auskunft und Loeschung an. Eine
 *                        Betroffenenrechtshandlung gehoert dem
 *                        Verantwortlichen, nicht dem Auftragsverarbeiter.
 *   invoice:issue        Eine Rechnung festzuschreiben ist eine
 *   invoice:credit       steuerliche Erklaerung des Hauses. Sie traegt
 *                        dessen Steuernummer, nicht unsere.
 *   report:export        DATEV, GoBD, Statistik -- Daten aus dem Haus
 *                        heraus. Genau das, was eine Auftragsverarbeitung
 *                        nicht ohne Weisung tut.
 *   user:manage          Wuerde erlauben, sich einen Benutzer anzulegen --
 *   integration:manage   oder einen API-Client. Beides ueberlebt die
 *                        Sitzung, und damit waere die Befristung, also der
 *                        ganze Mechanismus, umgangen.
 *   settings:account     Accountweite Einstellungen und Vertrag. Das ist
 *   account:contract     die Geschaeftsbeziehung selbst.
 *
 * Die beiden vorletzten sind der eigentliche Punkt: eine Support-Sitzung
 * darf keinen Zugang schaffen, der sie ueberdauert.
 */
export type SupportLevel = 'read' | 'write'

export const SUPPORT_LEVELS: readonly SupportLevel[] = ['read', 'write']

export function isSupportLevel(v: unknown): v is SupportLevel {
  return typeof v === 'string' && (SUPPORT_LEVELS as readonly string[]).includes(v)
}

/** Die Rechte einer Stufe. Eine neue Menge je Aufruf, damit niemand sie teilt. */
export function supportPermissions(level: SupportLevel): Set<Permission> {
  return new Set(level === 'write' ? SCHREIBEN : LESEN)
}

/**
 * Obergrenze der Laufzeit.
 *
 * Eine Sitzung ohne Frist ist keine Sitzung, sondern ein Zugang. Acht
 * Stunden sind ein Arbeitstag: laenger braucht keine Fehlersuche, und wer
 * laenger braucht, fragt neu -- dann sieht der Kunde es auch wieder.
 */
export const SUPPORT_MAX_STUNDEN = 8
export const SUPPORT_VORGABE_STUNDEN = 2
