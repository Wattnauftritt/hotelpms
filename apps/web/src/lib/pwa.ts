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
 */
export function serviceWorkerAnmelden(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    // Scheitert die Anmeldung, laeuft die Oberflaeche wie bisher im Tab.
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ohne Worker */ })
  })
}
