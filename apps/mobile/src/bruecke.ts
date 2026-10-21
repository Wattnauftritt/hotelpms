import { registerPlugin, Capacitor, CapacitorHttp } from '@capacitor/core'
import { App } from '@capacitor/app'
import { LiveUpdate } from '@capawesome/capacitor-live-update'
import { PushNotifications } from '@capacitor/push-notifications'
import type { ErkannteZeile, Kurzbefehl, NativePush, StaygridNative } from '@hotelpms/native'

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
 * 2: Texterkennung im Geraet. 3: Dateien zeigen und teilen. 4: Pakete vom
 * Server.
 *
 * Seit 4 heisst die Zahl: diese Bruecke braucht eine Huelle mindestens
 * dieser Fassung. Die Bruecke kommt mit jedem Paket neu, die Huelle nur aus
 * dem Store; was die Huelle hat, sagt `StaygridHuelle` aus dem nativen Code.
 * Wer hier erhoeht, erhoeht dort mit (HuellePlugin, iOS und Android).
 */
const HUELLE = 4

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

/** Belege und Exporte in der Vorschau des Telefons statt als Download. */
interface DateiPlugin {
  oeffnen(o: { daten: string; name: string; typ: string }): Promise<void>
}
const Datei = registerPlugin<DateiPlugin>('StaygridDatei')

interface HuellePlugin {
  /** `push` fehlt bei Huellen vor den Benachrichtigungen. */
  stand(): Promise<{ huelle: number; push?: boolean }>
}
const Huelle = registerPlugin<HuellePlugin>('StaygridHuelle')

function alsBase64(bild: Blob): Promise<string> {
  return new Promise((ok, fehler) => {
    const leser = new FileReader()
    leser.onload = () => ok(String(leser.result).replace(/^data:[^,]*,/, ''))
    leser.onerror = () => fehler(leser.error ?? new Error('Bild nicht lesbar'))
    leser.readAsDataURL(bild)
  })
}

// ------------------------------------------------- Aktualisierung (Plan §4)

/** Commit dieses Stands und ob die Huelle einen Paketschluessel traegt. */
const STAND = import.meta.env.VITE_STAYGRID_STAND ?? ''
const PAKET = import.meta.env.VITE_STAYGRID_PAKET === '1'

/** Was `scripts/paket.mjs` beim Ausrollen neben das Zip legt. */
interface Paket {
  stand: string
  huelle: number
  datei: string
  signatur: string
}

function istPaket(x: unknown): x is Paket {
  const p = x as Partial<Paket> | null
  return typeof p === 'object' && p !== null
    && typeof p.stand === 'string' && /^[0-9a-f]{7,40}$/.test(p.stand)
    && typeof p.huelle === 'number'
    && typeof p.datei === 'string' && /^[0-9a-f]{7,40}\.zip$/.test(p.datei)
    && typeof p.signatur === 'string'
}

let storeNoetig = false
const storeWartende: Array<() => void> = []
function melden() {
  for (const f of storeWartende.splice(0)) f()
}

/**
 * Nachsehen hoechstens stuendlich: beim Start und wenn die App wieder nach
 * vorn kommt. Eine Rezeption hat die App den ganzen Tag offen; nur beim
 * Start zu fragen hiesse, sie sieht eine Aenderung erst am naechsten Morgen.
 */
const ABSTAND_MS = 60 * 60 * 1000
let zuletzt = 0

async function nachsehen() {
  if (Date.now() - zuletzt < ABSTAND_MS) return
  zuletzt = Date.now()
  // Nativ statt `fetch`: die Datei liegt statisch unter Caddy, ohne CORS
  // fuer die Herkunft der App. Fehlt sie, liefert Caddy die Seite der
  // Oberflaeche, und `istPaket` weist sie ab.
  const antwort = await CapacitorHttp.get({ url: `${API}/app-paket/paket.json` })
  if (antwort.status !== 200 || !istPaket(antwort.data)) return
  const paket = antwort.data
  // Auch ein aelterer Stand wird genommen: rollt der Server zurueck, folgt
  // die App ihm wie der Browser.
  if (paket.stand === STAND) return

  const { huelle } = await Huelle.stand()
  if (paket.huelle > huelle) {
    storeNoetig = true
    melden()
    return
  }
  // Ein Paket, das schon einmal nicht startete, nicht wieder anbieten --
  // sonst startete die App bei jedem Oeffnen zehn Sekunden ins Leere.
  const { bundleIds: gesperrt } = await LiveUpdate.getBlockedBundles()
  if (gesperrt.includes(paket.stand)) return

  const { bundleIds: vorhanden } = await LiveUpdate.getBundles()
  if (!vorhanden.includes(paket.stand)) {
    // Pruefsumme und Signatur prueft die Huelle, bevor sie entpackt.
    await LiveUpdate.downloadBundle({
      url: `${API}/app-paket/${paket.datei}`,
      bundleId: paket.stand,
      signature: paket.signatur
    })
  }
  // Gilt ab dem naechsten Start. Mitten in der Arbeit neu zu laden, verloere
  // ein halb ausgefuelltes Formular.
  await LiveUpdate.setNextBundle({ bundleId: paket.stand })
}

/**
 * `ready()` erst, wenn die Oberflaeche wirklich etwas zeigt. Bricht ein Paket
 * beim Laden ab, bleibt `#root` leer, die Meldung bleibt aus, und die Huelle
 * geht nach zehn Sekunden auf den mitgelieferten Stand zurueck.
 */
let bereit = false
function bereitMelden(versuche = 0) {
  if (document.getElementById('root')?.childElementCount) {
    void LiveUpdate.ready().then(() => { bereit = true; return nachsehen() }).catch(fehlerMelden)
  } else if (versuche < 40) {
    setTimeout(() => bereitMelden(versuche + 1), 200)
  }
}

function fehlerMelden(e: unknown) {
  // Kein Gastbezug darin: Adresse und Meldung des Werkzeugs.
  console.warn('Aktualisierung', e instanceof Error ? e.message : e)
}

function aktualisieren() {
  if (document.readyState === 'complete') bereitMelden()
  else window.addEventListener('load', () => bereitMelden(), { once: true })
  // Vor ready() nichts wechseln: die Frist der Huelle liefe sonst weiter,
  // waehrend schon das naechste Paket geladen wird.
  void App.addListener('resume', () => { if (bereit) void nachsehen().catch(fehlerMelden) })
}

// ------------------------------------------- Benachrichtigungen (0193)

/*
 * Nur wenn die Huelle die Erweiterung hat UND Firebase eingerichtet ist. Die
 * Bruecke kommt mit jedem Paket, die Erweiterung nur mit dem Store; eine
 * Huelle der Fassung 4 ohne sie bekommt das Paket trotzdem und zeigt dann
 * nur keinen Knopf (deshalb keine neue Fassung der Huelle).
 */
const PUSH_VORHANDEN = Capacitor.isPluginAvailable('PushNotifications')

async function pushMoeglich(): Promise<boolean> {
  if (!PUSH_VORHANDEN) return false
  try {
    return (await Huelle.stand()).push === true
  } catch {
    return false
  }
}

async function pushErlaubnis(): Promise<'erteilt' | 'abgelehnt' | 'offen'> {
  const { receive } = await PushNotifications.checkPermissions()
  return receive === 'granted' ? 'erteilt' : receive === 'denied' ? 'abgelehnt' : 'offen'
}

const push: NativePush = {
  moeglich: pushMoeglich,
  erlaubnis: pushErlaubnis,
  async anmelden() {
    if (!await pushMoeglich()) return null
    let stand = await pushErlaubnis()
    if (stand === 'offen') {
      const { receive } = await PushNotifications.requestPermissions()
      stand = receive === 'granted' ? 'erteilt' : 'abgelehnt'
    }
    if (stand !== 'erteilt') return null
    // Die Kennung kommt als Ereignis, nicht als Rueckgabe von register().
    return new Promise<string>((ok, fehler) => {
      const hoerer: Array<Promise<{ remove: () => Promise<void> }>> = []
      const fertig = () => { for (const h of hoerer) void h.then(x => x.remove()) }
      hoerer.push(PushNotifications.addListener('registration', t => { fertig(); ok(t.value) }))
      hoerer.push(PushNotifications.addListener('registrationError', e => {
        fertig(); fehler(new Error(e.error))
      }))
      PushNotifications.register().catch((e: unknown) => {
        fertig(); fehler(e instanceof Error ? e : new Error(String(e)))
      })
    })
  },
  async abmelden() {
    if (await pushMoeglich()) await PushNotifications.unregister()
  }
}

/**
 * Ein Tippen auf die Meldung oeffnet die Seite, die sie nennt. Nur ein Pfad
 * dieser App: die Meldung kommt von unserem Server, aber eine fremde Adresse
 * soll aus ihr nie werden, auch wenn sich dort einmal etwas verschiebt.
 */
function aufTippenOeffnen() {
  void PushNotifications.addListener('pushNotificationActionPerformed', a => {
    const url = (a.notification.data as { url?: unknown } | undefined)?.url
    if (typeof url === 'string' && /^\/(?!\/)/.test(url) && location.pathname !== url) {
      location.assign(url)
    }
  })
}

// ------------------------------------------- Schnellaktionen am App-Symbol

/*
 * Wie bei den Benachrichtigungen: nur mit der Erweiterung in der Huelle, und
 * deshalb keine neue Fassung -- eine aeltere Huelle zeigt nur keine.
 */
interface KurzbefehlePlugin {
  setzen(o: { liste: readonly Kurzbefehl[] }): Promise<void>
  addListener(ereignis: 'gewaehlt', f: (d: { pfad: string }) => void): Promise<{ remove: () => Promise<void> }>
}
const KURZBEFEHLE_VORHANDEN = Capacitor.isPluginAvailable('StaygridKurzbefehle')
const Kurzbefehle = registerPlugin<KurzbefehlePlugin>('StaygridKurzbefehle')

/**
 * Ein Tippen auf eine Schnellaktion. Neu geladen statt in der Seite
 * umgeschaltet: Rezeption und Personal-App sind zwei Oberflaechen, und
 * welche laeuft, entscheidet der Pfad beim Start. Beim Kaltstart kommt das
 * Ereignis, sobald hier jemand zuhoert -- die Huelle haelt es so lange.
 */
function kurzbefehleHoeren() {
  void Kurzbefehle.addListener('gewaehlt', ({ pfad }) => {
    if (typeof pfad === 'string' && /^\/(?!\/)/.test(pfad)
        && location.pathname + location.search !== pfad) {
      location.assign(pfad)
    }
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
    },
    datei: {
      oeffnen: async (datei, name) => {
        await Datei.oeffnen({ daten: await alsBase64(datei), name,
                              typ: datei.type || 'application/octet-stream' })
      }
    }
  }
  if (PUSH_VORHANDEN) {
    bruecke.push = push
    void pushMoeglich().then(ja => { if (ja) aufTippenOeffnen() })
  }
  if (KURZBEFEHLE_VORHANDEN) {
    bruecke.kurzbefehle = { setzen: async liste => { await Kurzbefehle.setzen({ liste }) } }
    kurzbefehleHoeren()
  }
  if (PAKET) {
    bruecke.aktualisierung = {
      storeNoetig: f => {
        storeWartende.push(f)
        if (storeNoetig) melden()
      }
    }
  }
  window.staygridNative = bruecke
  if (PAKET) aktualisieren()

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

