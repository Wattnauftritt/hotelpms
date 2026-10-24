/**
 * Die Bruecke zwischen der Oberflaeche und der eigenen App (Plan
 * app/plan.md, Baustein 1).
 *
 * **Die App setzt ein Objekt, die Oberflaeche fragt danach.** Laeuft StayGrid
 * in der App, legt die Huelle `window.staygridNative` an, bevor die Seite
 * startet; im Browser fehlt es. Die Oberflaeche haengt damit an keinem
 * Paket von Capacitor, und im Browser laedt sie davon nichts: wer hier
 * nachsieht, bekommt `undefined` und nimmt den Weg von heute.
 *
 * **Warum ein eigenes Paket.** Dieselbe Form brauchen zwei Seiten: die
 * Oberflaeche (`apps/web`), die sie benutzt, und die Huelle (`apps/mobile`),
 * die sie erfuellt. Zwischen zwei Apps darf nichts quer laufen; ueber ein
 * Paket laufen beide in dieselbe Richtung.
 *
 * Nur Typen und zwei kleine Abfragen, keine Logik: was die Erkennung findet
 * oder wie angemeldet wird, entscheidet weiter die Oberflaeche, damit
 * Browser und App dasselbe tun.
 */

/** Eine erkannte Zeile mit ihrer Lage, `oben` nach unten wachsend. */
export interface ErkannteZeile {
  text: string
  oben: number
  unten: number
  links: number
}

export interface NativeTexterkennung {
  /**
   * Das Foto im Geraet lesen -- Vision bzw. die gebuendelte Erkennung von
   * ML Kit, nie ein Dienst im Netz: der Scan sagt dem Benutzer, dass das
   * Foto das Telefon nicht verlaesst. Lage in einer beliebigen, fuer alle
   * Zeilen gleichen Einheit; die Reihenfolge ist egal.
   */
  erkennen(bild: Blob): Promise<{ zeilen: ErkannteZeile[] }>
}

/**
 * Das Token der Sitzung (Migration 0191), abgelegt im Schluesselbund bzw.
 * im Android Keystore. Nie in `localStorage`: dort laege es lesbar fuer
 * jeden, der das Telefon sichert oder untersucht.
 */
export interface NativeSitzung {
  lesen(): Promise<string | null>
  speichern(token: string): Promise<void>
  loeschen(): Promise<void>
}

/**
 * Eine Datei zeigen und weitergeben: Beleg, Export, Meldedatei. Die WebView
 * einer App laedt nichts herunter, und ein PDF im `iframe` zeigt Android gar
 * nicht an. Die Huelle legt die Datei voruebergehend ab und oeffnet sie in
 * der Vorschau des Telefons, von dort teilen, drucken, sichern.
 */
export interface NativeDatei {
  oeffnen(datei: Blob, name: string): Promise<void>
}

/**
 * Die Aktualisierung ohne Store (Plan §4). Pakete laedt und wechselt die
 * Huelle selbst; die Oberflaeche erfaehrt nur, wenn ein neueres Paket da ist,
 * das diese Huelle nicht tragen kann, und bittet dann um den Store.
 */
export interface NativeAktualisierung {
  /** Ruft `beiBedarf` auf, sobald das feststeht -- auch nachtraeglich. */
  storeNoetig(beiBedarf: () => void): void
}

/**
 * Benachrichtigungen der Personal-App in der eigenen App (Migration 0193).
 * Statt Web-Push eine Kennung von Firebase Cloud Messaging; die Oberflaeche
 * meldet sie dem Server wie im Browser das Abo. Ein Tippen auf die Meldung
 * oeffnet die Seite, die sie nennt -- das erledigt die Huelle.
 */
export interface NativePush {
  /** Ob diese Huelle Benachrichtigungen kann (Android mit Firebase, spaeter iOS). */
  moeglich(): Promise<boolean>
  erlaubnis(): Promise<'erteilt' | 'abgelehnt' | 'offen'>
  /**
   * Fragt, wenn noch offen, nach der Erlaubnis und gibt die Kennung dieses
   * Telefons; `null`, wenn die Erlaubnis verweigert ist.
   */
  anmelden(): Promise<string | null>
  /** Nimmt die Kennung bei Firebase zurueck. */
  abmelden(): Promise<void>
}

/**
 * Schnellaktionen am App-Symbol (Plan, „Schnellaktionen“). Die Oberflaeche
 * setzt sie nach den Rechten der Person, eine leere Liste nimmt alle weg.
 * Ein Tippen darauf oeffnet `pfad` -- das erledigt die Huelle; ein Pfad
 * dieser App, nie eine Adresse.
 */
export interface Kurzbefehl {
  id: string
  titel: string
  pfad: string
  /** Ein Name aus einer festen Liste; die Huelle waehlt das Bild dazu. */
  symbol: 'kalender' | 'heute' | 'kasse' | 'kamera' | 'pruefen' | 'plan' | 'zimmer'
    | 'eintragen' | 'kueche' | 'zeit'
}

export interface NativeKurzbefehle {
  setzen(liste: readonly Kurzbefehl[]): Promise<void>
}

/**
 * Passkeys von app.staygrid.cloud in der App. Die WebView laeuft unter
 * `https://localhost` bzw. `capacitor://localhost`, und dort bietet das
 * Telefon keinen Passkey dieser Domain an; die Huelle fragt deshalb selbst
 * (Credential Manager, AuthenticationServices). Hinein gehen die Optionen,
 * wie die Schnittstelle sie liefert, heraus die Antwort in derselben Form
 * wie im Browser -- WebAuthn als JSON, Bytes als base64url. Pruefen tut
 * weiter nur die Schnittstelle.
 *
 * Bricht der Benutzer ab oder hat das Telefon keinen passenden Passkey,
 * scheitert der Aufruf mit einer `DOMException` namens `NotAllowedError`,
 * wie im Browser.
 */
export interface NativePasskey {
  /** `navigator.credentials.get()` */
  vorlegen(optionen: unknown): Promise<unknown>
  /** `navigator.credentials.create()` */
  anlegen(optionen: unknown): Promise<unknown>
}

export interface StaygridNative {
  plattform: 'ios' | 'android'
  /**
   * Fassung der Huelle. Ein Paket der Oberflaeche, das eine neuere braucht,
   * wird nicht angewendet (Abschnitt 4 des Plans).
   */
  huelle: number
  /** Herkunft der Schnittstelle, etwa `https://app.staygrid.cloud`. */
  api: string
  sitzung: NativeSitzung
  /** Fehlt, solange die Huelle keine Erkennung mitbringt. */
  texterkennung?: NativeTexterkennung
  /** Fehlt bei einer Huelle vor Fassung 3. */
  datei?: NativeDatei
  /** Fehlt vor Fassung 4 und ohne Schluessel fuer Pakete. */
  aktualisierung?: NativeAktualisierung
  /** Fehlt, wenn die Huelle die Erweiterung fuer Benachrichtigungen nicht hat. */
  push?: NativePush
  /** Fehlt, wenn die Huelle keine Schnellaktionen kennt. */
  kurzbefehle?: NativeKurzbefehle
  /** Fehlt bei einer Huelle ohne die Erweiterung fuer Passkeys. */
  passkey?: NativePasskey
}

declare global {
  interface Window {
    /** Gesetzt von der StayGrid-App, im Browser nie. */
    staygridNative?: StaygridNative
  }
}

export function nativ(): StaygridNative | undefined {
  return typeof window === 'undefined' ? undefined : window.staygridNative
}

export function istApp(): boolean {
  return nativ() !== undefined
}
