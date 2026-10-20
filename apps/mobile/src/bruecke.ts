import { registerPlugin, Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import type { ErkannteZeile, StaygridNative } from '@hotelpms/native'

/**
 * Die Bruecke zur Oberflaeche (Plan app/plan.md, Baustein 3).
 *
 * Laeuft als erstes Modul der Seite, vor der Oberflaeche (`scripts/www.mjs`
 * setzt sie davor), und legt `window.staygridNative` an. Die Oberflaeche
 * kennt Capacitor nicht; sie fragt nur nach diesem Objekt
 * (`@hotelpms/native`). So bleibt der Bau fuer den Browser frei von allem,
 * was nur im Telefon Sinn hat.
 */

/**
 * Steigt, wenn sich die Bruecke so aendert, dass die Oberflaeche es merkt.
 * 2: Texterkennung im Geraet.
 */
const HUELLE = 2

/** Herkunft der Schnittstelle; dieselbe wie in der Policy des Baus. */
const API = import.meta.env.VITE_STAYGRID_API ?? 'https://app.staygrid.cloud'

/**
 * Das Token im Schluesselbund (iOS) bzw. verschluesselt mit einem Schluessel
 * aus dem Android Keystore. Eigene Erweiterung statt eines fremden Pakets:
 * sie ist zwanzig Zeilen je Plattform, und an dieser Stelle soll niemand
 * anderes Code ausliefern als wir.
 */
interface SitzungPlugin {
  lesen(): Promise<{ token: string | null }>
  speichern(o: { token: string }): Promise<void>
  loeschen(): Promise<void>
}
const Sitzung = registerPlugin<SitzungPlugin>('StaygridSitzung')

/**
 * Vision bzw. die gebuendelte Erkennung von ML Kit, beide im Geraet. Das
 * Bild geht als Base64 ueber die Bruecke, weil sie nur JSON traegt; es
 * verlaesst dabei die App nicht.
 */
interface TexterkennungPlugin {
  erkennen(o: { bild: string }): Promise<{ zeilen: ErkannteZeile[] }>
}
const Texterkennung = registerPlugin<TexterkennungPlugin>('StaygridTexterkennung')

function alsBase64(bild: Blob): Promise<string> {
  return new Promise((ok, fehler) => {
    const leser = new FileReader()
    leser.onload = () => ok(String(leser.result).replace(/^data:[^,]*,/, ''))
    leser.onerror = () => fehler(leser.error ?? new Error('Bild nicht lesbar'))
    leser.readAsDataURL(bild)
  })
}

const plattform = Capacitor.getPlatform()
if (plattform === 'ios' || plattform === 'android') {
  const bruecke: StaygridNative = {
    plattform,
    huelle: HUELLE,
    api: API,
    sitzung: {
      lesen: async () => (await Sitzung.lesen()).token,
      speichern: async token => { await Sitzung.speichern({ token }) },
      loeschen: async () => { await Sitzung.loeschen() }
    },
    texterkennung: {
      erkennen: async bild => Texterkennung.erkennen({ bild: await alsBase64(bild) })
    }
  }
  window.staygridNative = bruecke

  /*
   * Die Zurueck-Taste unter Android. Ohne das schliesst sie die App beim
   * ersten Druck, auch mitten in einem Formular. Gibt es eine Seite davor,
   * geht sie dorthin, wie im Browser; sonst schickt sie die App in den
   * Hintergrund statt sie zu beenden, damit die Sitzung beim naechsten
   * Oeffnen noch steht.
   */
  void App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) history.back()
    else void App.minimizeApp()
  })
}
