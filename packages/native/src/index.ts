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
