import type { LocalizedText, MessageLocale } from '@hotelpms/contracts'
import { common } from './common.js'
import { tagesgeschaeft } from './tagesgeschaeft.js'
import { housekeeping } from './housekeeping.js'
import { einrichtung } from './einrichtung.js'
import { folio } from './folio.js'
import { gruppen } from './gruppen.js'
import { plan } from './plan.js'
import { berichte } from './berichte.js'
import { einstellungen } from './einstellungen.js'
import { schnittstellen } from './schnittstellen.js'
import { benutzer } from './benutzer.js'
import { preise } from './preise.js'
import { preissteuerung } from './preissteuerung.js'
import { gaeste } from './gaeste.js'
import { rechnung } from './rechnung.js'
import { zugang } from './zugang.js'
import { support } from './support.js'
import { admin } from './admin.js'
import { terminal } from './terminal.js'
import { hausnotiz } from './hausnotiz.js'
import { planstatus } from './planstatus.js'
import { suche } from './suche.js'
import { onlineCheckin } from './onlineCheckin.js'
import { ersteSchritte } from './ersteSchritte.js'
import { altsystem } from './altsystem.js'
import { mobil } from './mobil.js'
import { meldescheine } from './meldescheine.js'
import { kassenbuch } from './kassenbuch.js'
import { zimmerSortieren } from './zimmerSortieren.js'
import { zimmerwechsel } from './zimmerwechsel.js'
import { reinigungsplan } from './reinigungsplan.js'
import { kontrolle } from './kontrolle.js'
import { kueche } from './kueche.js'
import { arbeitszeit } from './arbeitszeit.js'
import { gaestemappe } from './gaestemappe.js'
import { visitenkarte } from './visitenkarte.js'
import { kurzbefehle } from './kurzbefehle.js'
import { verkaufenAls } from './verkaufenAls.js'
import { sicherheit } from './sicherheit.js'
import { passkey } from './passkey.js'
import { tickets } from './tickets.js'

/**
 * Der ganze Katalog der Oberflaeche, alle Sprachen je Schluessel.
 *
 * **Nur fuer den Bau und die Tests.** Die Oberflaeche importiert diese
 * Datei nicht: sie holt je Sprache ein Paket, das der Bau hieraus schreibt
 * (`lib/sprachpaketBau.ts`, `lib/sprachpaket.ts`). Wer hier etwas
 * importiert, zieht wieder alle dreiunddreissig Sprachen in den Browser --
 * bis zum 24.10.2026 waren das 4,1 MB auf jeder Seite.
 *
 * Wer einen Bereich hinzufuegt: Datei daneben legen, hier importieren und
 * unten in `TextKey` und `texts` eintragen.
 */

/**
 * Alle Schluessel, aus den Bereichen zusammengesetzt.
 *
 * **Warum ausgeschrieben und nicht `keyof typeof texts`.** Mit dreiunddreissig
 * Sprachen ist der abgeleitete Typ des ganzen Katalogs -- jeder Satz als
 * eigener Zeichenkettentyp -- groesser, als `tsc` beim Schreiben der
 * Deklarationen ausgeben mag (TS7056). Die Schluessel allein sind klein;
 * die Werte braucht niemand als Literal, nur als `LocalizedText`.
 */
export type TextKey =
  | keyof typeof common
  | keyof typeof tagesgeschaeft
  | keyof typeof housekeeping
  | keyof typeof einrichtung
  | keyof typeof folio
  | keyof typeof gruppen
  | keyof typeof plan
  | keyof typeof berichte
  | keyof typeof einstellungen
  | keyof typeof schnittstellen
  | keyof typeof benutzer
  | keyof typeof preise
  | keyof typeof preissteuerung
  | keyof typeof gaeste
  | keyof typeof rechnung
  | keyof typeof zugang
  | keyof typeof support
  | keyof typeof admin
  | keyof typeof terminal
  | keyof typeof hausnotiz
  | keyof typeof planstatus
  | keyof typeof suche
  | keyof typeof onlineCheckin
  | keyof typeof ersteSchritte
  | keyof typeof altsystem
  | keyof typeof mobil
  | keyof typeof meldescheine
  | keyof typeof kassenbuch
  | keyof typeof zimmerSortieren
  | keyof typeof zimmerwechsel
  | keyof typeof reinigungsplan
  | keyof typeof kontrolle
  | keyof typeof kueche
  | keyof typeof arbeitszeit
  | keyof typeof gaestemappe
  | keyof typeof visitenkarte
  | keyof typeof kurzbefehle
  | keyof typeof verkaufenAls
  | keyof typeof passkey
  | keyof typeof sicherheit
  | keyof typeof tickets

export const texts: Record<TextKey, LocalizedText> = {
  ...common,
  ...tagesgeschaeft,
  ...housekeeping,
  ...einrichtung,
  ...folio,
  ...gruppen,
  ...plan,
  ...berichte,
  ...einstellungen,
  ...schnittstellen,
  ...benutzer,
  ...preise,
  ...preissteuerung,
  ...gaeste,
  ...rechnung,
  ...zugang,
  ...support,
  ...admin,
  ...terminal,
  ...hausnotiz,
  ...planstatus,
  ...suche,
  ...onlineCheckin,
  ...ersteSchritte,
  ...altsystem,
  ...mobil,
  ...meldescheine,
  ...kassenbuch,
  ...zimmerSortieren,
  ...zimmerwechsel,
  ...reinigungsplan,
  ...kontrolle,
  ...kueche,
  ...arbeitszeit,
  ...gaestemappe,
  ...visitenkarte,
  ...kurzbefehle,
  ...verkaufenAls,
  ...passkey,
  ...sicherheit,
  ...tickets
}

/** Alle Schluessel. Ein Test prueft damit jede Sprache durch. */
export function textKeys(): TextKey[] {
  return Object.keys(texts) as TextKey[]
}

/** Ein Text ohne React, fuer Tests und fuer den Aufruf ausserhalb einer Komponente. */
export function textFor(key: TextKey, locale: MessageLocale): string {
  return texts[key][locale]
}

