import { useEffect, useState } from 'react'

/**
 * Installieren als App (Dokument 33).
 *
 * Chrome und Edge bieten das Installieren selbst an, als kleines Symbol in
 * der Adressleiste. Das sieht an der Rezeption niemand. Deshalb halten wir
 * das Angebot des Browsers fest (`beforeinstallprompt`) und zeigen einen
 * eigenen Knopf in der Kopfleiste, solange es gilt.
 *
 * **Festgehalten wird beim Laden des Moduls, nicht in einem Effekt.** Der
 * Browser schickt das Ereignis einmal, oft bevor React die Shell
 * eingehaengt hat -- die steht erst nach der Antwort auf `/v1/auth/me`.
 * Ein Zuhoerer im Effekt kaeme zu spaet, und der Knopf erschiene nie.
 *
 * Safari und Firefox kennen das Ereignis nicht. Dort gibt es keinen Knopf,
 * und das Installieren geht ueber das Menue des Browsers ("Zum Dock
 * hinzufuegen" in Safari).
 */
interface InstallAngebot extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let angebot: InstallAngebot | null = null
const zuhoerer = new Set<() => void>()
const melden = (): void => { zuhoerer.forEach(f => f()) }

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => {
    // Das eigene Band des Browsers bleibt zu; der Knopf in der Kopfleiste
    // ersetzt es.
    e.preventDefault()
    angebot = e as InstallAngebot
    melden()
  })
  window.addEventListener('appinstalled', () => {
    angebot = null
    melden()
  })
}

/** Gibt es gerade ein Angebot, und wenn ja, der Weg, es anzunehmen. */
export function useInstallation(): (() => void) | null {
  const [, neu] = useState(0)
  useEffect(() => {
    const f = (): void => neu(n => n + 1)
    zuhoerer.add(f)
    return () => { zuhoerer.delete(f) }
  }, [])
  if (angebot === null) return null
  const a = angebot
  return () => {
    void a.prompt()
    // Ein Angebot gilt einmal. Lehnt die Rezeption ab, bleibt der Knopf
    // weg, bis der Browser beim naechsten Laden ein neues schickt.
    void a.userChoice.finally(() => {
      angebot = null
      melden()
    })
  }
}

/**
 * Den Service Worker anmelden -- nur im gebauten Stand.
 *
 * Unter `pnpm dev:web` gibt es keine `sw.js`, und ein Worker aus einem
 * frueheren Bau, der auf `localhost:5173` liegen geblieben ist, lieferte
 * eine alte Huelle aus, waehrend man den eigenen Stand pruefen will.
 *
 * **Neue Fassung ohne Neuinstallieren.** Wer die App oeffnet, bekommt die
 * neue Fassung ohnehin: die Seite geht zuerst ans Netz, und der neue Worker
 * uebernimmt sofort (`skipWaiting`, `clients.claim`). Ein Handy oeffnet die
 * App aber selten neu, es holt sie aus dem Hintergrund zurueck -- dann
 * laeuft der alte Stand tagelang weiter. Deshalb fragt die Seite bei jeder
 * Rueckkehr in den Vordergrund und stuendlich nach einer neuen Fassung.
 *
 * Mit `neuLaden` (Personal-App) laedt die Seite sich nach einem Wechsel
 * selbst neu, aber nur, waehrend sie verdeckt ist und kein Feld Text haelt:
 * mitten in einer Problemmeldung neu zu laden, verwuerfe den Text. Die Rezeption laedt
 * nicht selbst neu; ein halb ausgefuelltes Formular in einem Tab im
 * Hintergrund ist dort der Normalfall, und sie bekommt die neue Fassung
 * beim naechsten Aufruf.
 */
export function serviceWorkerAnmelden({ neuLaden = false }: { neuLaden?: boolean } = {}): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    // Ein Worker, der beim Laden schon steuerte, macht einen Wechsel zur
    // neuen Fassung; der allererste Worker ist keine.
    const hatteWorker = navigator.serviceWorker.controller !== null
    navigator.serviceWorker.register('/sw.js').then(reg => {
      const pruefen = (): void => { reg.update().catch(() => { /* ohne Netz: spaeter */ }) }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') pruefen()
      })
      setInterval(pruefen, 60 * 60 * 1000)
    }).catch(() => { /* Scheitert die Anmeldung, laeuft die Oberflaeche wie bisher im Tab. */ })
    if (!neuLaden || !hatteWorker) return
    let faellig = false
    // Auch verdeckt nicht, solange in einem Feld Text steht: wer zum
    // Uebersetzen kurz die App wechselt, kommt zu seinem Text zurueck.
    const tippt = (): boolean => {
      const f = document.activeElement
      return (f instanceof HTMLTextAreaElement || f instanceof HTMLInputElement) && f.value !== ''
    }
    const vielleichtLaden = (): void => {
      if (faellig && document.visibilityState === 'hidden' && !tippt()) window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      faellig = true
      vielleichtLaden()
    })
    document.addEventListener('visibilitychange', vielleichtLaden)
  })
}
