import { useEffect, useState } from 'react'

/**
 * Lesbare Offline-Kopie der Betriebslisten (E5, Dokument 13).
 *
 * Warum das kein Luxus ist: fällt im Haus das Netz aus, braucht die
 * Rezeption trotzdem die Anreiseliste, die Hausliste und den Zimmerstatus.
 * Diese drei Listen sind **lesend** und ändern sich im Lauf eines Tages
 * wenig. Sie lokal zu halten kostet nichts und rettet den Betrieb.
 *
 * Ausdrücklich **nicht** offline: alles Schreibende. Eine Buchung, die im
 * Browser wartet und später hochgeht, würde Kontingent binden, das
 * inzwischen jemand anders verkauft hat. Ein Kalender, der Doppelbelegungen
 * erzeugt, ist schlimmer als eine Fehlermeldung.
 */
const PRAEFIX = 'hotelpms.offline.'

export function cacheRead<T>(key: string): { data: T; at: string } | null {
  try {
    const raw = localStorage.getItem(PRAEFIX + key)
    if (raw === null) return null
    return JSON.parse(raw) as { data: T; at: string }
  } catch {
    // Privates Fenster, gesperrter Speicher, defekter Eintrag: kein Grund,
    // die Oberflaeche scheitern zu lassen.
    return null
  }
}

export function cacheWrite<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PRAEFIX + key,
      JSON.stringify({ data, at: new Date().toISOString() }))
  } catch { /* Speicher voll oder gesperrt */ }
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const auf = () => setOnline(true)
    const ab = () => setOnline(false)
    window.addEventListener('online', auf)
    window.addEventListener('offline', ab)
    return () => {
      window.removeEventListener('online', auf)
      window.removeEventListener('offline', ab)
    }
  }, [])
  return online
}
